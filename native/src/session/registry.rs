use std::collections::HashMap;
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

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
static PRESENTERS: OnceLock<Mutex<HashMap<String, Arc<Presenter>>>> = OnceLock::new();
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn presenters() -> &'static Mutex<HashMap<String, Arc<Presenter>>> {
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

pub fn insert_presenter(
    id: String,
    presenter: Arc<Presenter>,
) -> Result<Option<Arc<Presenter>>, String> {
    Ok(presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?
        .insert(id, presenter))
}

pub fn find_presenter(id: &str) -> Result<Option<Arc<Presenter>>, String> {
    Ok(presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?
        .get(id)
        .cloned())
}

pub fn remove_presenter(id: &str) -> Result<Option<Arc<Presenter>>, String> {
    Ok(presenters()
        .lock()
        .map_err(|_| "Embedded MPV presenter registry lock was poisoned.".to_owned())?
        .remove(id))
}
