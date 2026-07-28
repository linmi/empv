use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Buffer, Either, FnArgs, Function, Null, Task};
use napi::{Env, Error, Result};
use napi_derive::napi;

use crate::mpv::handle::OwnedMpvHandle;
use crate::playback::state::PlaybackStateReducer;
use crate::presentation::macos;
use crate::session::macos::MacRenderRuntime;
use crate::session::recording::PendingRequests;
use crate::session::registry::{
    self, FrameReady, Session, SessionState, SnapshotSink, find_session, get_session,
};
use crate::session::{runtime, snapshot::SessionSnapshot};

use super::dto::{JsCapturedFrame, JsSessionOptions, JsSessionSnapshot};

fn napi_error(reason: impl Into<String>) -> Error {
    Error::from_reason(reason.into())
}

pub fn is_supported() -> bool {
    true
}

pub fn get_presentation_kind() -> &'static str {
    "layer"
}

pub struct CreateSessionTask {
    snapshot_sink: Option<SnapshotSink>,
    frame_sink: Option<registry::FrameSink>,
    volume_percent: f64,
    session: Option<Arc<Session>>,
    completed: bool,
}

impl Task for CreateSessionTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let handle = Arc::new(OwnedMpvHandle::create().map_err(napi_error)?);
        if let Err(error) = runtime::initialize_macos_handle(&handle, self.volume_percent) {
            handle.terminate();
            return Err(napi_error(error));
        }
        let snapshot_sink = self
            .snapshot_sink
            .take()
            .ok_or_else(|| napi_error("Snapshot callback is missing."))?;
        let frame_sink = self
            .frame_sink
            .take()
            .ok_or_else(|| napi_error("Frame callback is missing."))?;
        let id = registry::next_session_id();
        let snapshot = SessionSnapshot {
            volume_percent: self.volume_percent,
            ..SessionSnapshot::default()
        };
        let session = Arc::new(Session {
            id: id.clone(),
            handle: handle.clone(),
            render: Mutex::new(None),
            running: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(SessionState {
                snapshot,
                playback: PlaybackStateReducer::default(),
                pending: PendingRequests::default(),
                content_generation: 0,
                playlist_paths: Vec::new(),
            }),
            event_thread: Mutex::new(None),
            snapshot_sink,
            last_snapshot_push_ms: std::sync::atomic::AtomicI64::new(0),
        });
        self.session = Some(session.clone());

        let render =
            MacRenderRuntime::start(Arc::downgrade(&session), handle, id.clone(), frame_sink)
                .map_err(napi_error)?;
        *session
            .render
            .lock()
            .map_err(|_| napi_error("Embedded MPV render lock was poisoned."))? = Some(render);

        if let Err(error) = runtime::spawn_event_loop(session.clone()) {
            teardown_session(&session).map_err(napi_error)?;
            return Err(napi_error(error));
        }
        if let Err(error) = registry::insert_session(session.clone()) {
            teardown_session(&session).map_err(napi_error)?;
            return Err(napi_error(error));
        }
        Ok(id)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        self.completed = true;
        Ok(output)
    }

    fn finally(self, _env: Env) -> Result<()> {
        if self.completed {
            return Ok(());
        }
        if let Some(session) = self.session {
            let _ = registry::remove_session(&session.id);
            teardown_session(&session).map_err(napi_error)?;
        }
        Ok(())
    }
}

pub fn create_session(
    options: JsSessionOptions,
    on_snapshot_changed: Function<'_, (), ()>,
    on_frame: Function<'_, FnArgs<(u32, f64, f64)>, ()>,
) -> Result<AsyncTask<CreateSessionTask>> {
    let snapshot_sink = on_snapshot_changed
        .build_threadsafe_function::<()>()
        .max_queue_size::<8>()
        .callee_handled::<false>()
        .build_callback(|_| Ok(()))?;
    let frame_sink = on_frame
        .build_threadsafe_function::<FrameReady>()
        .max_queue_size::<8>()
        .callee_handled::<false>()
        .build_callback(|context| {
            Ok(FnArgs::from((
                context.value.surface_index,
                context.value.pool_generation as f64,
                context.value.content_generation as f64,
            )))
        })?;
    let volume = options.volume.unwrap_or(1.0);
    let volume_percent = if volume.is_finite() {
        (volume * 100.0).clamp(0.0, 100.0)
    } else {
        100.0
    };
    Ok(AsyncTask::new(CreateSessionTask {
        snapshot_sink: Some(snapshot_sink),
        frame_sink: Some(frame_sink),
        volume_percent,
        session: None,
        completed: false,
    }))
}

pub struct DisposeSessionTask {
    session: Option<Arc<Session>>,
}

impl Task for DisposeSessionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        if let Some(session) = self.session.as_ref() {
            teardown_session(session).map_err(napi_error)?;
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

pub fn dispose_session(session_id: String) -> Result<AsyncTask<DisposeSessionTask>> {
    let session = registry::remove_session(&session_id).map_err(napi_error)?;
    Ok(AsyncTask::new(DisposeSessionTask { session }))
}

fn teardown_session(session: &Arc<Session>) -> std::result::Result<(), String> {
    let mut errors = Vec::new();
    let recording_active = match session.state.lock() {
        Ok(state) => state.snapshot.recording_active,
        Err(poisoned) => {
            errors.push("Embedded MPV session lock was poisoned.".to_owned());
            poisoned.into_inner().snapshot.recording_active
        }
    };
    if recording_active
        && let Err(error) =
            session
                .handle
                .set_string("stream-record", "", "stop recording during dispose")
    {
        errors.push(error);
    }
    let render = match session.render.lock() {
        Ok(mut render) => render.take(),
        Err(poisoned) => {
            errors.push("Embedded MPV render lock was poisoned.".to_owned());
            poisoned.into_inner().take()
        }
    };
    if let Some(render) = render
        && let Err(error) = render.shutdown()
    {
        errors.push(error);
    }
    session.render.clear_poison();
    if let Err(error) = runtime::stop_event_loop(session) {
        errors.push(error);
    }
    session.handle.terminate();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn get_session_snapshot(session_id: String) -> Result<Option<JsSessionSnapshot>> {
    let Some(session) = find_session(&session_id).map_err(napi_error)? else {
        return Ok(None);
    };
    let snapshot = session
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV session lock was poisoned."))?
        .snapshot
        .clone();
    let mut dto: JsSessionSnapshot = snapshot.into();
    let render = session
        .render
        .lock()
        .map_err(|_| napi_error("Embedded MPV render lock was poisoned."))?;
    if let Some(render) = render.as_ref() {
        dto.rendered_frame_count = Some(render.rendered_frame_count() as f64);
        dto.render_average_ms = Some(match render.average_render_ms() {
            Some(value) => Either::A(value),
            None => Either::B(Null),
        });
    } else {
        dto.rendered_frame_count = Some(0.0);
        dto.render_average_ms = Some(Either::B(Null));
    }
    Ok(Some(dto))
}

pub fn capture_frame(session_id: String) -> Result<Option<JsCapturedFrame>> {
    let session = get_session(&session_id).map_err(napi_error)?;
    let render = session
        .render
        .lock()
        .map_err(|_| napi_error("Embedded MPV render lock was poisoned."))?;
    let render = render
        .as_ref()
        .ok_or_else(|| napi_error("Embedded MPV render runtime is not available."))?;
    render
        .capture()
        .map(|frame| {
            frame.map(|frame| JsCapturedFrame {
                data: Buffer::from(frame.data),
                width_pixels: frame.width_pixels,
                height_pixels: frame.height_pixels,
            })
        })
        .map_err(napi_error)
}

pub fn set_render_size(session_id: String, width_pixels: f64, height_pixels: f64) -> Result<()> {
    let Some(session) = find_session(&session_id).map_err(napi_error)? else {
        return Ok(());
    };
    let render = session
        .render
        .lock()
        .map_err(|_| napi_error("Embedded MPV render lock was poisoned."))?;
    if let Some(render) = render.as_ref() {
        render.set_render_size(width_pixels as i32, height_pixels as i32);
    }
    Ok(())
}

pub fn set_presentation_suspended(session_id: String, suspended: bool) -> Result<()> {
    let Some(session) = find_session(&session_id).map_err(napi_error)? else {
        return Ok(());
    };
    let render = session
        .render
        .lock()
        .map_err(|_| napi_error("Embedded MPV render lock was poisoned."))?;
    if let Some(render) = render.as_ref() {
        render.set_presentation_suspended(suspended);
    }
    Ok(())
}

#[napi(js_name = "configureFrameLink")]
pub fn configure_frame_link(service_name: String) -> Result<()> {
    macos::configure_frame_link(service_name).map_err(napi_error)
}
