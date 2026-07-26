use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::{AsyncTask, Buffer, Either, FnArgs, Function, Null, Task};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

use crate::mpv::handle::OwnedMpvHandle;
use crate::playback::state::PlaybackStateReducer;
use crate::presentation::macos::{
    self, Bounds, FramePool, FrameReceiver, OcclusionEvent, OcclusionObserver, VideoPresenter,
};
use crate::session::macos::{MacPresenterState, MacRenderRuntime};
use crate::session::recording::PendingRequests;
use crate::session::registry::{
    self, FrameReady, Presenter, Session, SessionState, SnapshotSink, find_session, get_session,
};
use crate::session::{runtime, snapshot::SessionSnapshot};

use super::dto::{
    JsAttachOptions, JsBounds, JsCapturedFrame, JsRenderSize, JsSessionOptions, JsSessionSnapshot,
    ZOrder, parse_z_order,
};

type OcclusionSink =
    napi::threadsafe_function::ThreadsafeFunction<bool, (), bool, Status, false, false, 8>;

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

fn window_handle(buffer: &Buffer) -> Result<usize> {
    if buffer.len() < std::mem::size_of::<usize>() {
        return Err(napi_error("Native window handle buffer is too small."));
    }
    let mut bytes = [0_u8; std::mem::size_of::<usize>()];
    bytes.copy_from_slice(&buffer[..std::mem::size_of::<usize>()]);
    let handle = usize::from_ne_bytes(bytes);
    if handle == 0 {
        Err(napi_error(
            "Unable to resolve the Electron native window handle.",
        ))
    } else {
        Ok(handle)
    }
}

pub fn create_presenter(
    presenter_id: String,
    window_handle_buffer: Buffer,
    options: JsAttachOptions,
) -> Result<JsRenderSize> {
    let window = window_handle(&window_handle_buffer)?;
    let bounds = options.macos_bounds();
    let overlay = parse_z_order(&options.z_order).map_err(napi_error)? == ZOrder::Overlay;
    let (host, size) = VideoPresenter::create(window, overlay, bounds).map_err(napi_error)?;
    let presenter = Arc::new(Presenter {
        host,
        state: Mutex::new(MacPresenterState::new(bounds)),
    });
    if let Some(previous) =
        registry::insert_presenter(presenter_id, presenter).map_err(napi_error)?
    {
        previous.host.close().map_err(napi_error)?;
    }
    Ok(size.into())
}

pub fn set_presenter_bounds(presenter_id: String, bounds: JsBounds) -> Result<JsRenderSize> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(napi_error)? else {
        return Ok(JsRenderSize {
            width_pixels: 0,
            height_pixels: 0,
        });
    };
    let bounds = Bounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
        corner_radius: bounds.corner_radius.unwrap_or(0.0).max(0.0),
    };
    let size = presenter.host.set_bounds(bounds).map_err(napi_error)?;
    presenter
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV presenter lock was poisoned."))?
        .last_bounds = bounds;
    Ok(size.into())
}

pub fn refresh_presenter_scale(presenter_id: String) -> Result<JsRenderSize> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(napi_error)? else {
        return Ok(JsRenderSize {
            width_pixels: 0,
            height_pixels: 0,
        });
    };
    let bounds = presenter
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV presenter lock was poisoned."))?
        .last_bounds;
    presenter
        .host
        .set_bounds(bounds)
        .map(Into::into)
        .map_err(napi_error)
}

pub fn set_presenter_suspended(presenter_id: String, suspended: bool) -> Result<()> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(napi_error)? else {
        return Ok(());
    };
    presenter
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV presenter lock was poisoned."))?
        .suspended = suspended;
    Ok(())
}

#[napi(js_name = "presentSurface")]
pub fn present_surface(
    presenter_id: String,
    pool_generation: f64,
    surface_index: i32,
    content_generation: f64,
) -> Result<()> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(napi_error)? else {
        return Ok(());
    };
    let selected = presenter
        .state
        .lock()
        .map_err(|_| napi_error("Embedded MPV presenter lock was poisoned."))?
        .select_frame(
            pool_generation.max(0.0) as u64,
            surface_index,
            content_generation.max(0.0) as u64,
        );
    if let Some((pool, index)) = selected {
        presenter.host.present(&pool, index).map_err(napi_error)?;
    }
    Ok(())
}

pub fn destroy_presenter(presenter_id: String) -> Result<()> {
    let Some(presenter) = registry::remove_presenter(&presenter_id).map_err(napi_error)? else {
        return Ok(());
    };
    presenter.host.close().map_err(napi_error)
}

#[derive(Default)]
struct FrameReceiverState {
    service_name: Option<String>,
    receiver: Option<FrameReceiver>,
}

static FRAME_RECEIVER: OnceLock<Mutex<FrameReceiverState>> = OnceLock::new();

fn frame_receiver() -> &'static Mutex<FrameReceiverState> {
    FRAME_RECEIVER.get_or_init(|| Mutex::new(FrameReceiverState::default()))
}

#[napi(js_name = "startPresenterLink")]
pub fn start_presenter_link(service_name: String) -> Result<()> {
    let previous = {
        let mut state = frame_receiver()
            .lock()
            .map_err(|_| napi_error("macOS frame receiver lock was poisoned."))?;
        if state.receiver.is_some() && state.service_name.as_deref() == Some(&service_name) {
            return Ok(());
        }
        state.service_name = None;
        state.receiver.take()
    };
    drop(previous);

    let callback = Arc::new(
        |session_id: String, generation: u64, pool: Arc<FramePool>| {
            let presenter = match registry::find_presenter(&session_id) {
                Ok(Some(presenter)) => presenter,
                Ok(None) => return,
                Err(error) => {
                    eprintln!("[embedded-mpv][frame-link] {error}");
                    return;
                }
            };
            let selected = match presenter.state.lock() {
                Ok(mut state) => state.install_pool(generation, pool),
                Err(_) => {
                    eprintln!("[embedded-mpv][frame-link] presenter lock was poisoned");
                    return;
                }
            };
            if let Some((pool, index)) = selected
                && let Err(error) = presenter.host.present(&pool, index)
            {
                eprintln!("[embedded-mpv][frame-link] pending present failed: {error}");
            }
        },
    );
    let receiver = FrameReceiver::create(&service_name, callback).map_err(napi_error)?;
    let mut state = frame_receiver()
        .lock()
        .map_err(|_| napi_error("macOS frame receiver lock was poisoned."))?;
    state.service_name = Some(service_name);
    state.receiver = Some(receiver);
    Ok(())
}

#[napi(js_name = "stopPresenterLink")]
pub fn stop_presenter_link() -> Result<()> {
    let receiver = {
        let mut state = frame_receiver()
            .lock()
            .map_err(|_| napi_error("macOS frame receiver lock was poisoned."))?;
        state.service_name = None;
        state.receiver.take()
    };
    drop(receiver);
    Ok(())
}

pub fn set_window_backdrop(window_handle_buffer: Buffer, color: Option<String>) -> Result<()> {
    let window = window_handle(&window_handle_buffer)?;
    let color = color.as_deref().map(parse_hex_color).transpose()?;
    macos::set_window_backdrop(window, color).map_err(napi_error)
}

fn parse_hex_color(value: &str) -> Result<(f64, f64, f64)> {
    if value.len() != 7 || !value.starts_with('#') {
        return Err(napi_error(
            "Expected backdrop color as a #RRGGBB string or null.",
        ));
    }
    let channel = |start: usize| {
        u8::from_str_radix(&value[start..start + 2], 16)
            .map(|value| f64::from(value) / 255.0)
            .map_err(|_| napi_error("Expected backdrop color as a #RRGGBB string or null."))
    };
    Ok((channel(1)?, channel(3)?, channel(5)?))
}

struct OcclusionEntry {
    _observer: OcclusionObserver,
    _sink: Arc<OcclusionSink>,
}

unsafe impl Send for OcclusionEntry {}

static OCCLUSION_OBSERVERS: OnceLock<Mutex<HashMap<usize, OcclusionEntry>>> = OnceLock::new();

fn occlusion_observers() -> &'static Mutex<HashMap<usize, OcclusionEntry>> {
    OCCLUSION_OBSERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi(js_name = "observeWindowOcclusion")]
pub fn observe_window_occlusion(
    window_handle_buffer: Buffer,
    on_change: Function<'_, bool, ()>,
) -> Result<()> {
    let window = window_handle(&window_handle_buffer)?;
    remove_occlusion_entry(window);
    let sink = on_change
        .build_threadsafe_function::<bool>()
        .max_queue_size::<8>()
        .callee_handled::<false>()
        .build_callback(|context| Ok(context.value))?;
    let sink = Arc::new(sink);
    let callback_sink = sink.clone();
    let observer = OcclusionObserver::create(
        window,
        Arc::new(move |event| match event {
            OcclusionEvent::VisibilityChanged(visible) => {
                let _ = callback_sink.call_with_return_value(
                    visible,
                    ThreadsafeFunctionCallMode::NonBlocking,
                    |_result, _env| Ok(()),
                );
            }
            OcclusionEvent::WindowClosed => remove_occlusion_entry(window),
        }),
    )
    .map_err(napi_error)?;
    let previous = occlusion_observers()
        .lock()
        .map_err(|_| napi_error("macOS occlusion registry lock was poisoned."))?
        .insert(
            window,
            OcclusionEntry {
                _observer: observer,
                _sink: sink,
            },
        );
    drop(previous);
    Ok(())
}

#[napi(js_name = "unobserveWindowOcclusion")]
pub fn unobserve_window_occlusion(window_handle_buffer: Buffer) -> Result<()> {
    if window_handle_buffer.len() < std::mem::size_of::<usize>() {
        return Err(napi_error("Native window handle buffer is too small."));
    }
    let mut bytes = [0_u8; std::mem::size_of::<usize>()];
    bytes.copy_from_slice(&window_handle_buffer[..std::mem::size_of::<usize>()]);
    let window = usize::from_ne_bytes(bytes);
    if window == 0 {
        return Ok(());
    }
    remove_occlusion_entry(window);
    Ok(())
}

fn remove_occlusion_entry(window: usize) {
    let entry = occlusion_observers()
        .lock()
        .ok()
        .and_then(|mut observers| observers.remove(&window));
    drop(entry);
}
