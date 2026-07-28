#![cfg(target_os = "macos")]
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::{Buffer, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;

mod platform;
mod registry;
mod state;

use platform::{
    Bounds, FramePool, FrameReceiver, OcclusionEvent, OcclusionObserver, VideoPresenter,
};
use registry::Presenter;
use state::PresenterState;

type OcclusionSink = ThreadsafeFunction<bool, (), bool, Status, false, false, 8>;

fn napi_error(reason: impl Into<String>) -> Error {
    Error::from_reason(reason.into())
}

#[napi(js_name = "getPresenterKind")]
pub fn get_presenter_kind() -> &'static str {
    "layer"
}

#[napi(object)]
pub struct JsBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: Option<f64>,
}

#[napi(object)]
pub struct JsAttachOptions {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: Option<f64>,
    pub z_order: String,
}

#[napi(object)]
pub struct JsRenderSize {
    pub width_pixels: i32,
    pub height_pixels: i32,
}

fn bounds(x: f64, y: f64, width: f64, height: f64, corner_radius: Option<f64>) -> Result<Bounds> {
    if ![x, y, width, height, corner_radius.unwrap_or(0.0)]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err(napi_error(
            "Presenter bounds must contain only finite numbers.",
        ));
    }
    if width <= 0.0 || height <= 0.0 {
        return Err(napi_error(
            "Presenter bounds width and height must both be greater than zero.",
        ));
    }
    Ok(Bounds {
        x,
        y,
        width,
        height,
        corner_radius: corner_radius.unwrap_or(0.0).max(0.0),
    })
}

fn render_size(size: platform::RenderSize) -> JsRenderSize {
    JsRenderSize {
        width_pixels: size.width_pixels,
        height_pixels: size.height_pixels,
    }
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

#[napi(js_name = "createPresenter")]
pub fn create_presenter(
    presenter_id: String,
    window_handle_buffer: Buffer,
    options: JsAttachOptions,
) -> Result<JsRenderSize> {
    let window = window_handle(&window_handle_buffer)?;
    let bounds = bounds(
        options.x,
        options.y,
        options.width,
        options.height,
        options.corner_radius,
    )?;
    let overlay = match options.z_order.as_str() {
        "overlay" => true,
        "underlay" => false,
        other => {
            return Err(napi_error(format!(
                "Unknown presenter zOrder {other:?}; expected \"overlay\" or \"underlay\"."
            )));
        }
    };
    let reservation = registry::reserve(presenter_id).map_err(napi_error)?;
    let (host, size) = VideoPresenter::create(window, overlay, bounds).map_err(napi_error)?;
    reservation
        .commit(Arc::new(Presenter {
            host,
            state: Mutex::new(PresenterState::new(bounds)),
        }))
        .map_err(napi_error)?;
    Ok(render_size(size))
}

#[napi(js_name = "setPresenterBounds")]
pub fn set_presenter_bounds(presenter_id: String, bounds_input: JsBounds) -> Result<JsRenderSize> {
    let presenter = registry::get(&presenter_id).map_err(napi_error)?;
    let bounds = bounds(
        bounds_input.x,
        bounds_input.y,
        bounds_input.width,
        bounds_input.height,
        bounds_input.corner_radius,
    )?;
    let size = presenter.host.set_bounds(bounds).map_err(napi_error)?;
    presenter
        .state
        .lock()
        .map_err(|_| napi_error("empv presenter state lock was poisoned."))?
        .last_bounds = bounds;
    Ok(render_size(size))
}

#[napi(js_name = "refreshPresenterScale")]
pub fn refresh_presenter_scale(presenter_id: String) -> Result<JsRenderSize> {
    let presenter = registry::get(&presenter_id).map_err(napi_error)?;
    let bounds = presenter
        .state
        .lock()
        .map_err(|_| napi_error("empv presenter state lock was poisoned."))?
        .last_bounds;
    presenter
        .host
        .set_bounds(bounds)
        .map(render_size)
        .map_err(napi_error)
}

#[napi(js_name = "setPresenterSuspended")]
pub fn set_presenter_suspended(presenter_id: String, suspended: bool) -> Result<()> {
    let presenter = registry::get(&presenter_id).map_err(napi_error)?;
    presenter
        .state
        .lock()
        .map_err(|_| napi_error("empv presenter state lock was poisoned."))?
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
    if !pool_generation.is_finite()
        || pool_generation < 0.0
        || !content_generation.is_finite()
        || content_generation < 0.0
    {
        return Err(napi_error(
            "Frame pool and content generations must be finite non-negative numbers.",
        ));
    }
    let Some(presenter) = registry::find(&presenter_id).map_err(napi_error)? else {
        return Ok(());
    };
    let selected = presenter
        .state
        .lock()
        .map_err(|_| napi_error("empv presenter state lock was poisoned."))?
        .select_frame(
            pool_generation as u64,
            surface_index,
            content_generation as u64,
        );
    if let Some((pool, index)) = selected {
        presenter.host.present(&pool, index).map_err(napi_error)?;
    }
    Ok(())
}

#[napi(js_name = "destroyPresenter")]
pub fn destroy_presenter(presenter_id: String) -> Result<()> {
    let Some(destruction) = registry::begin_destruction(&presenter_id).map_err(napi_error)? else {
        return Ok(());
    };
    match destruction.presenter().host.close() {
        Ok(()) => destruction.commit().map_err(napi_error),
        Err(reason) => match destruction.record_failure() {
            Ok(()) => Err(napi_error(reason)),
            Err(registry_reason) => Err(napi_error(format!(
                "{reason} Failed to retain retryable presenter cleanup ownership: {registry_reason}"
            ))),
        },
    }
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

    let receiver = FrameReceiver::create(
        &service_name,
        Arc::new(
            |presenter_id: String, generation: u64, pool: Arc<FramePool>| {
                let presenter = match registry::find(&presenter_id) {
                    Ok(Some(presenter)) => presenter,
                    Ok(None) => return,
                    Err(error) => {
                        eprintln!("[empv-presenter][frame-link] {error}");
                        return;
                    }
                };
                let selected = match presenter.state.lock() {
                    Ok(mut state) => state.install_pool(generation, pool),
                    Err(_) => {
                        eprintln!("[empv-presenter][frame-link] presenter lock was poisoned");
                        return;
                    }
                };
                if let Some((pool, index)) = selected
                    && let Err(error) = presenter.host.present(&pool, index)
                {
                    eprintln!("[empv-presenter][frame-link] pending present failed: {error}");
                }
            },
        ),
    )
    .map_err(napi_error)?;
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

#[napi(js_name = "setWindowBackdrop")]
pub fn set_window_backdrop(window_handle_buffer: Buffer, color: Option<String>) -> Result<()> {
    let window = window_handle(&window_handle_buffer)?;
    let color = color.as_deref().map(parse_hex_color).transpose()?;
    platform::set_window_backdrop(window, color).map_err(napi_error)
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
    if window != 0 {
        remove_occlusion_entry(window);
    }
    Ok(())
}

fn remove_occlusion_entry(window: usize) {
    let entry = occlusion_observers()
        .lock()
        .ok()
        .and_then(|mut observers| observers.remove(&window));
    drop(entry);
}
