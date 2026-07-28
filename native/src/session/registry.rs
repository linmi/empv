use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;

use napi::Status;
#[cfg(target_os = "macos")]
use napi::bindgen_prelude::FnArgs;
use napi::threadsafe_function::ThreadsafeFunction;

#[cfg(target_os = "macos")]
use super::macos::{MacPresenterState, MacRenderRuntime};
use crate::mpv::handle::OwnedMpvHandle;
use crate::playback::state::PlaybackStateReducer;
#[cfg(target_os = "macos")]
use crate::presentation::macos::VideoPresenter;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::presentation::wid::{VideoHost, VideoPresenter};

use super::recording::PendingRequests;
use super::snapshot::SessionSnapshot;

pub type SnapshotSink = ThreadsafeFunction<(), (), (), Status, false, false, 8>;
#[cfg(target_os = "macos")]
pub type FrameSink =
    ThreadsafeFunction<FrameReady, (), FnArgs<(u32, f64, f64)>, Status, false, false, 8>;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug)]
pub struct FrameReady {
    pub surface_index: u32,
    pub pool_generation: u64,
    pub content_generation: u64,
}

pub struct SessionState {
    pub snapshot: SessionSnapshot,
    pub playback: PlaybackStateReducer,
    pub pending: PendingRequests,
    pub content_generation: u64,
    // The queue as this layer has built it, in playlist order. Every playlist
    // mutation goes through here (the replacing loadfile of load_playback, then
    // playlist_sync), so this is exact and, unlike mpv's observed `playlist`
    // property, carries no observation lag -- two syncs in quick succession must
    // not both compute their diff against the same stale queue.
    pub playlist_paths: Vec<String>,
}

pub struct Session {
    pub id: String,
    pub handle: Arc<OwnedMpvHandle>,
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub host: VideoHost,
    #[cfg(target_os = "macos")]
    pub render: Mutex<Option<MacRenderRuntime>>,
    pub running: AtomicBool,
    pub state: Mutex<SessionState>,
    pub event_thread: Mutex<Option<JoinHandle<()>>>,
    pub snapshot_sink: SnapshotSink,
    pub last_snapshot_push_ms: AtomicI64,
}

pub struct Presenter {
    pub host: VideoPresenter,
    #[cfg(target_os = "macos")]
    pub state: Mutex<MacPresenterState>,
}

enum PresenterEntry<T> {
    Creating,
    Active(T),
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
static PRESENTERS: OnceLock<Mutex<HashMap<String, PresenterEntry<Arc<Presenter>>>>> =
    OnceLock::new();
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn presenters() -> &'static Mutex<HashMap<String, PresenterEntry<Arc<Presenter>>>> {
    PRESENTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn next_session_id() -> String {
    format!(
        "embedded-mpv-{}",
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn next_request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn register_async_label(session: &Session, label: impl Into<String>) -> Result<u64, String> {
    let request_id = next_request_id();
    session
        .state
        .lock()
        .map_err(|_| "Embedded MPV session lock was poisoned.".to_owned())?
        .pending
        .labels
        .insert(request_id, label.into());
    Ok(request_id)
}

pub fn forget_async_label(session: &Session, request_id: u64) {
    if let Ok(mut state) = session.state.lock() {
        state.pending.labels.remove(&request_id);
    }
}

pub fn insert_session(session: Arc<Session>) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "Embedded MPV session registry lock was poisoned.".to_owned())?
        .insert(session.id.clone(), session);
    Ok(())
}

pub fn find_session(id: &str) -> Result<Option<Arc<Session>>, String> {
    Ok(sessions()
        .lock()
        .map_err(|_| "Embedded MPV session registry lock was poisoned.".to_owned())?
        .get(id)
        .cloned())
}

pub fn get_session(id: &str) -> Result<Arc<Session>, String> {
    find_session(id)?.ok_or_else(|| "Embedded MPV session not found.".to_owned())
}

pub fn remove_session(id: &str) -> Result<Option<Arc<Session>>, String> {
    Ok(sessions()
        .lock()
        .map_err(|_| "Embedded MPV session registry lock was poisoned.".to_owned())?
        .remove(id))
}

fn reserve_presenter_entry<T>(
    entries: &mut HashMap<String, PresenterEntry<T>>,
    id: String,
) -> Result<(), String> {
    match entries.entry(id.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(PresenterEntry::Creating);
            Ok(())
        }
        Entry::Occupied(_) => Err(format!("Embedded MPV presenter {id} already exists.")),
    }
}

fn commit_presenter_entry<T>(
    entries: &mut HashMap<String, PresenterEntry<T>>,
    id: &str,
    presenter: T,
) -> Result<(), String> {
    match entries.entry(id.to_owned()) {
        Entry::Occupied(mut entry) if matches!(entry.get(), PresenterEntry::Creating) => {
            entry.insert(PresenterEntry::Active(presenter));
            Ok(())
        }
        Entry::Occupied(_) => Err(format!(
            "Embedded MPV presenter {id} cannot finish creation because its registry entry is already active."
        )),
        Entry::Vacant(_) => Err(format!(
            "Embedded MPV presenter {id} cannot finish creation because its registry reservation is missing."
        )),
    }
}

fn cancel_presenter_reservation<T>(entries: &mut HashMap<String, PresenterEntry<T>>, id: &str) {
    if let Entry::Occupied(entry) = entries.entry(id.to_owned())
        && matches!(entry.get(), PresenterEntry::Creating)
    {
        entry.remove();
    }
}

fn take_presenter_entry<T>(
    entries: &mut HashMap<String, PresenterEntry<T>>,
    id: &str,
) -> Result<Option<T>, String> {
    match entries.entry(id.to_owned()) {
        Entry::Vacant(_) => Ok(None),
        Entry::Occupied(entry) if matches!(entry.get(), PresenterEntry::Creating) => Err(format!(
            "Embedded MPV presenter {id} cannot be destroyed while creation is in progress."
        )),
        Entry::Occupied(entry) => match entry.remove() {
            PresenterEntry::Active(presenter) => Ok(Some(presenter)),
            PresenterEntry::Creating => unreachable!("creating presenter handled above"),
        },
    }
}

pub struct PresenterReservation {
    id: String,
    committed: bool,
}

impl PresenterReservation {
    pub fn commit(mut self, presenter: Arc<Presenter>) -> Result<(), String> {
        let mut presenters = presenters()
            .lock()
            .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?;
        commit_presenter_entry(&mut presenters, &self.id, presenter)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for PresenterReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut presenters) = presenters().lock() {
            cancel_presenter_reservation(&mut presenters, &self.id);
        }
    }
}

pub fn reserve_presenter(id: String) -> Result<PresenterReservation, String> {
    if id.trim().is_empty() {
        return Err("Embedded MPV presenter id must not be empty.".to_owned());
    }
    let mut presenters = presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?;
    reserve_presenter_entry(&mut presenters, id.clone())?;
    Ok(PresenterReservation {
        id,
        committed: false,
    })
}

#[cfg(target_os = "macos")]
pub fn find_presenter(id: &str) -> Result<Option<Arc<Presenter>>, String> {
    let presenters = presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?;
    Ok(match presenters.get(id) {
        Some(PresenterEntry::Active(presenter)) => Some(presenter.clone()),
        Some(PresenterEntry::Creating) | None => None,
    })
}

pub fn get_presenter(id: &str) -> Result<Arc<Presenter>, String> {
    let presenters = presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?;
    match presenters.get(id) {
        Some(PresenterEntry::Active(presenter)) => Ok(presenter.clone()),
        Some(PresenterEntry::Creating) => Err(format!(
            "Embedded MPV presenter {id} is still being created."
        )),
        None => Err(format!("Embedded MPV presenter {id} does not exist.")),
    }
}

pub fn remove_presenter(id: &str) -> Result<Option<Arc<Presenter>>, String> {
    let mut presenters = presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?;
    take_presenter_entry(&mut presenters, id)
}

#[cfg(test)]
mod tests {
    use super::{
        PresenterEntry, cancel_presenter_reservation, commit_presenter_entry,
        reserve_presenter_entry, take_presenter_entry,
    };
    use std::collections::HashMap;

    #[test]
    fn presenter_reservation_never_replaces_an_existing_id() {
        let mut entries = HashMap::new();
        reserve_presenter_entry(&mut entries, "presenter-1".to_owned()).expect("reserve presenter");
        commit_presenter_entry(&mut entries, "presenter-1", "original").expect("commit presenter");

        let error = reserve_presenter_entry(&mut entries, "presenter-1".to_owned())
            .expect_err("duplicate presenter must fail");
        assert!(error.contains("presenter-1 already exists"));
        assert!(matches!(
            entries.get("presenter-1"),
            Some(PresenterEntry::Active("original"))
        ));
    }

    #[test]
    fn canceled_creation_releases_only_its_reservation() {
        let mut entries = HashMap::new();
        reserve_presenter_entry(&mut entries, "creating".to_owned()).expect("reserve presenter");
        cancel_presenter_reservation(&mut entries, "creating");
        assert!(!entries.contains_key("creating"));

        entries.insert("active".to_owned(), PresenterEntry::Active("presenter"));
        cancel_presenter_reservation(&mut entries, "active");
        assert!(matches!(
            entries.get("active"),
            Some(PresenterEntry::Active("presenter"))
        ));
    }

    #[test]
    fn destroy_is_terminal_and_refuses_an_incomplete_creation() {
        let mut entries = HashMap::new();
        reserve_presenter_entry(&mut entries, "creating".to_owned()).expect("reserve presenter");
        assert!(
            take_presenter_entry(&mut entries, "creating")
                .expect_err("creating presenter must not be removed")
                .contains("creation is in progress")
        );

        cancel_presenter_reservation(&mut entries, "creating");
        entries.insert("active".to_owned(), PresenterEntry::Active("presenter"));
        assert_eq!(
            take_presenter_entry(&mut entries, "active").expect("take active presenter"),
            Some("presenter")
        );
        assert_eq!(
            take_presenter_entry::<&str>(&mut entries, "active")
                .expect("repeat destroy is idempotent"),
            None
        );
    }
}
