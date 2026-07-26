use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Buffer, FnArgs, Function, Task};
use napi::{Env, Error, Result};
use napi_derive::napi;

use crate::mpv::handle::OwnedMpvHandle;
use crate::mpv::node;
use crate::playback::state::PlaybackStateReducer;
use crate::presentation::wid::VideoHost;
use crate::session::recording::PendingRequests;
use crate::session::registry::{
    self, Session, SessionState, SnapshotSink, find_session, get_session,
};
use crate::session::{runtime, snapshot::SessionSnapshot};

use super::dto::{JsCapturedFrame, JsSessionOptions, JsSessionSnapshot};

fn napi_error(reason: String) -> Error {
    Error::from_reason(reason)
}

pub fn is_supported() -> bool {
    VideoHost::is_available()
}

pub fn get_presentation_kind() -> &'static str {
    "window"
}

pub struct CreateSessionTask {
    host: Option<VideoHost>,
    snapshot_sink: Option<SnapshotSink>,
    volume_percent: f64,
    session: Option<Arc<Session>>,
    completed: bool,
}

impl Task for CreateSessionTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let host = self
            .host
            .as_ref()
            .ok_or_else(|| napi_error("Native video window owner is missing.".to_owned()))?;
        let wid = host.wid().map_err(napi_error)?;
        let handle = Arc::new(OwnedMpvHandle::create().map_err(napi_error)?);
        if let Err(error) = runtime::initialize_handle(&handle, self.volume_percent, &wid) {
            handle.terminate();
            return Err(napi_error(error));
        }
        let host = self
            .host
            .take()
            .ok_or_else(|| napi_error("Native video window owner is missing.".to_owned()))?;
        let snapshot_sink = self
            .snapshot_sink
            .take()
            .ok_or_else(|| napi_error("Snapshot callback is missing.".to_owned()))?;
        let id = registry::next_session_id();
        let snapshot = SessionSnapshot {
            volume_percent: self.volume_percent,
            ..SessionSnapshot::default()
        };
        let session = Arc::new(Session {
            id: id.clone(),
            handle,
            host,
            running: AtomicBool::new(false),
            state: Mutex::new(SessionState {
                snapshot,
                playback: PlaybackStateReducer::default(),
                pending: PendingRequests::default(),
                content_generation: 0,
                playlist_paths: Vec::new(),
            }),
            event_thread: Mutex::new(None),
            snapshot_sink,
            last_snapshot_push_ms: AtomicI64::new(0),
        });
        self.session = Some(session.clone());
        if let Err(error) = runtime::spawn_event_loop(session.clone()) {
            session.handle.terminate();
            return Err(napi_error(error));
        }
        if let Err(error) = registry::insert_session(session.clone()) {
            let _ = runtime::stop_event_loop(&session);
            session.handle.terminate();
            return Err(napi_error(error));
        }
        Ok(id)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.completed = true;
        Ok(output)
    }

    fn finally(self, _env: Env) -> Result<()> {
        if self.completed {
            return Ok(());
        }
        if let Some(session) = self.session {
            let mut errors = Vec::new();
            if let Err(reason) = registry::remove_session(&session.id) {
                errors.push(reason);
            }
            if let Err(reason) = runtime::stop_event_loop(&session) {
                errors.push(reason);
            }
            session.handle.terminate();
            if let Err(reason) = session.host.close() {
                errors.push(reason);
            }
            if !errors.is_empty() {
                return Err(napi_error(errors.join("; ")));
            }
        } else if let Some(host) = self.host {
            host.close().map_err(napi_error)?;
        }
        Ok(())
    }
}

pub fn create_session(
    options: JsSessionOptions,
    on_snapshot_changed: Function<'_, (), ()>,
    _on_frame: Function<'_, FnArgs<(u32, f64, f64)>, ()>,
) -> Result<AsyncTask<CreateSessionTask>> {
    let snapshot_sink = on_snapshot_changed
        .build_threadsafe_function::<()>()
        .max_queue_size::<8>()
        .callee_handled::<false>()
        .build_callback(|_| Ok(()))?;
    let host = VideoHost::create().map_err(napi_error)?;
    let volume = options.volume.unwrap_or(1.0);
    let volume_percent = if volume.is_finite() {
        (volume * 100.0).clamp(0.0, 100.0)
    } else {
        100.0
    };
    Ok(AsyncTask::new(CreateSessionTask {
        host: Some(host),
        snapshot_sink: Some(snapshot_sink),
        volume_percent,
        session: None,
        completed: false,
    }))
}

pub struct DisposeSessionTask {
    session: Option<Arc<Session>>,
    pending_error: Option<String>,
}

impl Task for DisposeSessionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let Some(session) = self.session.as_ref() else {
            return Ok(());
        };
        let mut errors = self.pending_error.take().into_iter().collect::<Vec<_>>();
        let recording_active = match session.state.lock() {
            Ok(state) => state.snapshot.recording_active,
            Err(poisoned) => {
                errors.push("Embedded MPV session lock was poisoned.".to_owned());
                poisoned.into_inner().snapshot.recording_active
            }
        };
        if recording_active {
            // Teardown must continue even if mpv rejects the best-effort
            // recording flush; leaving the event thread and native window live
            // would be worse than losing only the final recording reply.
            if let Err(reason) =
                session
                    .handle
                    .set_string("stream-record", "", "stop recording during dispose")
            {
                errors.push(reason);
            }
        }
        if let Err(reason) = runtime::stop_event_loop(session) {
            errors.push(reason);
        }
        session.handle.terminate();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(napi_error(errors.join("; ")))
        }
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }

    fn finally(self, _env: Env) -> Result<()> {
        if let Some(session) = self.session
            && let Err(reason) = session.host.close()
        {
            return Err(napi_error(reason));
        }
        Ok(())
    }
}

pub fn dispose_session(session_id: String) -> Result<AsyncTask<DisposeSessionTask>> {
    let session = registry::remove_session(&session_id).map_err(napi_error)?;
    let mut pending_error = None;
    if let Some(session) = &session
        && let Err(reason) = session.host.hide()
    {
        pending_error = Some(reason);
    }
    Ok(AsyncTask::new(DisposeSessionTask {
        session,
        pending_error,
    }))
}

pub fn get_session_snapshot(session_id: String) -> Result<Option<JsSessionSnapshot>> {
    let Some(session) = find_session(&session_id).map_err(napi_error)? else {
        return Ok(None);
    };
    let snapshot = session
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV session lock was poisoned.".to_owned()))?
        .snapshot
        .clone();
    Ok(Some(snapshot.into()))
}

pub fn capture_frame(session_id: String) -> Result<Option<JsCapturedFrame>> {
    let session = get_session(&session_id).map_err(napi_error)?;
    node::screenshot_raw(&session.handle)
        .map(|frame| {
            frame.map(|(width_pixels, height_pixels, data)| JsCapturedFrame {
                data: Buffer::from(data),
                width_pixels,
                height_pixels,
            })
        })
        .map_err(napi_error)
}

#[napi(js_name = "getVideoWindowHandle")]
pub fn get_video_window_handle(session_id: String) -> Result<Option<i64>> {
    let Some(session) = find_session(&session_id).map_err(napi_error)? else {
        return Ok(None);
    };
    session
        .host
        .native_handle()
        .map(|value| value.map(|handle| handle as i64))
        .map_err(napi_error)
}

pub fn set_render_size(_session_id: String, _width_pixels: f64, _height_pixels: f64) -> Result<()> {
    Ok(())
}

pub fn set_presentation_suspended(_session_id: String, _suspended: bool) -> Result<()> {
    Ok(())
}
