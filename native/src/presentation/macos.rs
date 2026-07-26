use std::ffi::{CStr, CString, c_char, c_double, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const ERROR_CAPACITY: usize = 2048;
const FRAME_LINK_NAME_LIMIT: usize = 128;
const FRAME_LINK_LOOKUP_ATTEMPTS: usize = 20;
const FRAME_LINK_LOOKUP_DELAY: Duration = Duration::from_millis(50);
const FRAME_LINK_UNKNOWN_SERVICE: c_int = -2;
const FRAME_LINK_INVALID_DESTINATION: c_int = -3;
const FRAME_LINK_SEND_FAILED: c_int = -4;
const FRAME_LINK_FATAL_SETUP_FAILED: c_int = -5;

#[repr(C)]
pub struct NativeSessionSurface {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeFrameSender {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeFrameReceiver {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeFramePool {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativePresenter {
    _private: [u8; 0],
}

#[repr(C)]
pub struct NativeOcclusionObserver {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RenderSize {
    pub width_pixels: i32,
    pub height_pixels: i32,
}

type NativeFramePoolCallback =
    unsafe extern "C" fn(*mut c_void, *const c_char, u64, *mut NativeFramePool);
type NativeContextReleaseCallback = unsafe extern "C" fn(*mut c_void);
type NativeOcclusionCallback = unsafe extern "C" fn(*mut c_void, c_int, bool);

unsafe extern "C" {
    fn empv_mac_session_surface_create(
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> *mut NativeSessionSurface;
    fn empv_mac_session_surface_destroy(surface: *mut NativeSessionSurface);
    fn empv_mac_session_surface_make_current(
        surface: *mut NativeSessionSurface,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_session_surface_clear_current();
    pub fn empv_mac_session_surface_get_proc_address(
        context: *mut c_void,
        name: *const c_char,
    ) -> *mut c_void;
    fn empv_mac_session_surface_ensure_pool(
        surface: *mut NativeSessionSurface,
        width_pixels: i32,
        height_pixels: i32,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_session_surface_framebuffer(
        surface: *const NativeSessionSurface,
        surface_index: i32,
        framebuffer: *mut u32,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_session_surface_finish_frame(
        surface: *mut NativeSessionSurface,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_session_surface_capture_rgba(
        surface: *mut NativeSessionSurface,
        surface_index: i32,
        pixels: *mut u8,
        pixels_length: usize,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_session_surface_size(surface: *const NativeSessionSurface, size: *mut RenderSize);

    fn empv_mac_frame_sender_create(
        service_name: *const c_char,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> *mut NativeFrameSender;
    fn empv_mac_frame_sender_destroy(sender: *mut NativeFrameSender);
    fn empv_mac_frame_sender_connect(
        sender: *mut NativeFrameSender,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_frame_sender_send_pool(
        sender: *mut NativeFrameSender,
        session_id: *const c_char,
        generation: u64,
        surface: *const NativeSessionSurface,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;

    fn empv_mac_frame_receiver_create(
        service_name: *const c_char,
        callback_context: *mut c_void,
        callback: Option<NativeFramePoolCallback>,
        release_context: Option<NativeContextReleaseCallback>,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> *mut NativeFrameReceiver;
    fn empv_mac_frame_receiver_destroy(receiver: *mut NativeFrameReceiver);
    fn empv_mac_frame_pool_destroy(pool: *mut NativeFramePool);

    fn empv_mac_presenter_create(
        native_view: usize,
        overlay: bool,
        bounds: *const Bounds,
        size: *mut RenderSize,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> *mut NativePresenter;
    fn empv_mac_presenter_destroy(presenter: *mut NativePresenter);
    fn empv_mac_presenter_invalidate(presenter: *mut NativePresenter);
    fn empv_mac_presenter_set_bounds(
        presenter: *mut NativePresenter,
        bounds: *const Bounds,
        size: *mut RenderSize,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_presenter_present(
        presenter: *mut NativePresenter,
        pool: *const NativeFramePool,
        surface_index: i32,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;

    fn empv_mac_window_set_backdrop(
        native_view: usize,
        enabled: bool,
        red: c_double,
        green: c_double,
        blue: c_double,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn empv_mac_occlusion_observer_create(
        native_view: usize,
        callback_context: *mut c_void,
        callback: Option<NativeOcclusionCallback>,
        release_context: Option<NativeContextReleaseCallback>,
        error_message: *mut c_char,
        error_capacity: usize,
    ) -> *mut NativeOcclusionObserver;
    fn empv_mac_occlusion_observer_destroy(observer: *mut NativeOcclusionObserver);
}

pub struct SessionSurface {
    raw: NonNull<NativeSessionSurface>,
}

impl SessionSurface {
    pub fn create() -> Result<Self, String> {
        let (raw, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_session_surface_create(buffer, capacity)
        });
        NonNull::new(raw)
            .map(|raw| Self { raw })
            .ok_or_else(|| fallback_error(error, "Failed to create the macOS video surface."))
    }

    pub fn make_current(&self) -> Result<(), String> {
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_session_surface_make_current(self.raw.as_ptr(), buffer, capacity)
        })
    }

    pub fn clear_current() {
        unsafe { empv_mac_session_surface_clear_current() };
    }

    /// Returns whether the pool was recreated.
    pub fn ensure_pool(&self, width_pixels: i32, height_pixels: i32) -> Result<bool, String> {
        let (result, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_session_surface_ensure_pool(
                self.raw.as_ptr(),
                width_pixels,
                height_pixels,
                buffer,
                capacity,
            )
        });
        if result < 0 {
            Err(fallback_error(
                error,
                "Failed to create IOSurface pool for MPV video rendering.",
            ))
        } else {
            Ok(result > 0)
        }
    }

    pub fn framebuffer(&self, surface_index: i32) -> Result<u32, String> {
        let mut framebuffer = 0_u32;
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_session_surface_framebuffer(
                self.raw.as_ptr(),
                surface_index,
                &mut framebuffer,
                buffer,
                capacity,
            )
        })?;
        Ok(framebuffer)
    }

    pub fn finish_frame(&self) -> Result<(), String> {
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_session_surface_finish_frame(self.raw.as_ptr(), buffer, capacity)
        })
    }

    pub fn capture_rgba(&self, surface_index: i32) -> Result<Vec<u8>, String> {
        let size = self.size();
        let Some(pixel_count) = (size.width_pixels as usize)
            .checked_mul(size.height_pixels as usize)
            .and_then(|value| value.checked_mul(4))
        else {
            return Err("Rendered frame dimensions overflow the capture buffer.".to_owned());
        };
        let mut pixels = vec![0_u8; pixel_count];
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_session_surface_capture_rgba(
                self.raw.as_ptr(),
                surface_index,
                pixels.as_mut_ptr(),
                pixels.len(),
                buffer,
                capacity,
            )
        })?;
        Ok(pixels)
    }

    pub fn size(&self) -> RenderSize {
        let mut size = RenderSize::default();
        unsafe { empv_mac_session_surface_size(self.raw.as_ptr(), &mut size) };
        size
    }

    pub fn as_native(&self) -> *const NativeSessionSurface {
        self.raw.as_ptr()
    }
}

impl Drop for SessionSurface {
    fn drop(&mut self) {
        unsafe { empv_mac_session_surface_destroy(self.raw.as_ptr()) };
    }
}

struct FrameSender {
    raw: NonNull<NativeFrameSender>,
    connected: bool,
}

unsafe impl Send for FrameSender {}

impl FrameSender {
    fn create(service_name: &str) -> Result<Self, String> {
        let service_name = cstring(service_name)?;
        let (raw, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_frame_sender_create(service_name.as_ptr(), buffer, capacity)
        });
        NonNull::new(raw)
            .map(|raw| Self {
                raw,
                connected: false,
            })
            .ok_or_else(|| fallback_error(error, "Failed to create the mpv frame sender."))
    }

    fn send_pool(
        &mut self,
        session_id: &str,
        generation: u64,
        surface: &SessionSurface,
    ) -> Result<(), FrameLinkError> {
        self.connect().map_err(FrameLinkError::Fatal)?;
        let session_id = cstring(session_id).map_err(FrameLinkError::Fatal)?;
        let (result, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_frame_sender_send_pool(
                self.raw.as_ptr(),
                session_id.as_ptr(),
                generation,
                surface.as_native(),
                buffer,
                capacity,
            )
        });
        if result == FRAME_LINK_INVALID_DESTINATION {
            self.connected = false;
        }
        match result {
            result if result >= 0 => Ok(()),
            FRAME_LINK_INVALID_DESTINATION | FRAME_LINK_SEND_FAILED => {
                Err(FrameLinkError::Transient(fallback_error(
                    error,
                    "Failed to send the mpv frame pool.",
                )))
            }
            FRAME_LINK_FATAL_SETUP_FAILED => Err(FrameLinkError::Fatal(fallback_error(
                error,
                "Failed to prepare the mpv frame pool transfer.",
            ))),
            _ => Err(FrameLinkError::Fatal(fallback_error(
                error,
                "Unexpected mpv frame link failure.",
            ))),
        }
    }

    fn connect(&mut self) -> Result<(), String> {
        if self.connected {
            return Ok(());
        }
        let mut last_error = String::new();
        for attempt in 0..FRAME_LINK_LOOKUP_ATTEMPTS {
            let (result, error) = with_error_buffer(|buffer, capacity| unsafe {
                empv_mac_frame_sender_connect(self.raw.as_ptr(), buffer, capacity)
            });
            if result == 0 {
                self.connected = true;
                return Ok(());
            }
            last_error = error;
            if result != FRAME_LINK_UNKNOWN_SERVICE {
                break;
            }
            if attempt + 1 < FRAME_LINK_LOOKUP_ATTEMPTS {
                std::thread::sleep(FRAME_LINK_LOOKUP_DELAY);
            }
        }
        Err(fallback_error(
            last_error,
            "Failed to establish the mpv frame link.",
        ))
    }
}

impl Drop for FrameSender {
    fn drop(&mut self) {
        unsafe { empv_mac_frame_sender_destroy(self.raw.as_ptr()) };
    }
}

#[derive(Default)]
struct FrameSenderState {
    service_name: Option<String>,
    sender: Option<FrameSender>,
}

static FRAME_SENDER: OnceLock<Mutex<FrameSenderState>> = OnceLock::new();

fn frame_sender() -> &'static Mutex<FrameSenderState> {
    FRAME_SENDER.get_or_init(|| Mutex::new(FrameSenderState::default()))
}

pub fn configure_frame_link(service_name: String) -> Result<(), String> {
    if service_name.is_empty() {
        return Err("Frame link service name must be non-empty.".to_owned());
    }
    if service_name.len() >= FRAME_LINK_NAME_LIMIT {
        return Err("Frame link service name must be under 128 bytes.".to_owned());
    }
    let mut state = frame_sender()
        .lock()
        .map_err(|_| "macOS frame sender lock was poisoned.".to_owned())?;
    if state.service_name.as_deref() != Some(&service_name) {
        state.sender = None;
        state.service_name = Some(service_name);
    }
    Ok(())
}

pub fn send_frame_pool(
    session_id: &str,
    generation: u64,
    surface: &SessionSurface,
) -> Result<(), FrameLinkError> {
    let mut state = frame_sender()
        .lock()
        .map_err(|_| FrameLinkError::Fatal("macOS frame sender lock was poisoned.".to_owned()))?;
    let service_name = state.service_name.clone().ok_or_else(|| {
        FrameLinkError::Fatal(
            "frame link service name not configured (configureFrameLink)".to_owned(),
        )
    })?;
    if state.sender.is_none() {
        state.sender = Some(FrameSender::create(&service_name).map_err(FrameLinkError::Fatal)?);
    }
    state
        .sender
        .as_mut()
        .ok_or_else(|| FrameLinkError::Fatal("macOS frame sender was not created.".to_owned()))?
        .send_pool(session_id, generation, surface)
}

#[derive(Debug)]
pub enum FrameLinkError {
    Transient(String),
    Fatal(String),
}

pub struct FramePool {
    raw: NonNull<NativeFramePool>,
}

unsafe impl Send for FramePool {}
unsafe impl Sync for FramePool {}

impl Drop for FramePool {
    fn drop(&mut self) {
        unsafe { empv_mac_frame_pool_destroy(self.raw.as_ptr()) };
    }
}

type FramePoolHandler = dyn Fn(String, u64, Arc<FramePool>) + Send + Sync + 'static;

struct FrameReceiverCallbackContext {
    active: AtomicBool,
    callback: Arc<FramePoolHandler>,
}

pub struct FrameReceiver {
    raw: NonNull<NativeFrameReceiver>,
    callback_context: *const FrameReceiverCallbackContext,
}

unsafe impl Send for FrameReceiver {}

impl FrameReceiver {
    pub fn create(service_name: &str, callback: Arc<FramePoolHandler>) -> Result<Self, String> {
        if service_name.is_empty() || service_name.len() >= FRAME_LINK_NAME_LIMIT {
            return Err(
                "Frame link service name must be non-empty and under 128 bytes.".to_owned(),
            );
        }
        let service_name = cstring(service_name)?;
        let callback_context = Arc::new(FrameReceiverCallbackContext {
            active: AtomicBool::new(true),
            callback,
        });
        let context = Arc::into_raw(callback_context);
        let (raw, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_frame_receiver_create(
                service_name.as_ptr(),
                context.cast_mut().cast(),
                Some(frame_pool_callback_trampoline),
                Some(frame_receiver_context_release_trampoline),
                buffer,
                capacity,
            )
        });
        let Some(raw) = NonNull::new(raw) else {
            unsafe { drop(Arc::from_raw(context)) };
            return Err(fallback_error(
                error,
                "Failed to register the mpv frame link service.",
            ));
        };
        Ok(Self {
            raw,
            callback_context: context,
        })
    }
}

impl Drop for FrameReceiver {
    fn drop(&mut self) {
        if let Some(context) = unsafe { self.callback_context.as_ref() } {
            context.active.store(false, Ordering::Release);
        }
        unsafe { empv_mac_frame_receiver_destroy(self.raw.as_ptr()) };
    }
}

unsafe extern "C" fn frame_pool_callback_trampoline(
    context: *mut c_void,
    session_id: *const c_char,
    generation: u64,
    pool: *mut NativeFramePool,
) {
    let pool = NonNull::new(pool).map(|raw| Arc::new(FramePool { raw }));
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let context_pointer = context.cast::<FrameReceiverCallbackContext>();
        unsafe { Arc::increment_strong_count(context_pointer) };
        let context = unsafe { Arc::from_raw(context_pointer) };
        let Some(pool) = pool.as_ref() else {
            return;
        };
        if !context.active.load(Ordering::Acquire) || session_id.is_null() {
            return;
        }
        let session_id = unsafe { CStr::from_ptr(session_id) }
            .to_string_lossy()
            .into_owned();
        (context.callback)(session_id, generation, pool.clone());
    }));
}

unsafe extern "C" fn frame_receiver_context_release_trampoline(context: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !context.is_null() {
            unsafe {
                drop(Arc::from_raw(
                    context.cast::<FrameReceiverCallbackContext>(),
                ))
            };
        }
    }));
}

pub struct VideoPresenter {
    raw: Mutex<Option<NonNull<NativePresenter>>>,
    invalidated: AtomicBool,
}

unsafe impl Send for VideoPresenter {}
unsafe impl Sync for VideoPresenter {}

impl VideoPresenter {
    pub fn create(
        native_view: usize,
        overlay: bool,
        bounds: Bounds,
    ) -> Result<(Self, RenderSize), String> {
        let mut size = RenderSize::default();
        let (raw, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_presenter_create(native_view, overlay, &bounds, &mut size, buffer, capacity)
        });
        let raw = NonNull::new(raw)
            .ok_or_else(|| fallback_error(error, "Failed to create the macOS video presenter."))?;
        Ok((
            Self {
                raw: Mutex::new(Some(raw)),
                invalidated: AtomicBool::new(false),
            },
            size,
        ))
    }

    pub fn set_bounds(&self, bounds: Bounds) -> Result<RenderSize, String> {
        let mut size = RenderSize::default();
        let pointer = self.pointer_lock()?;
        let raw = pointer
            .as_ref()
            .ok_or_else(|| "macOS video presenter has already been released.".to_owned())?
            .as_ptr();
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_presenter_set_bounds(raw, &bounds, &mut size, buffer, capacity)
        })?;
        Ok(size)
    }

    pub fn present(&self, pool: &FramePool, surface_index: i32) -> Result<(), String> {
        let pointer = self.pointer_lock()?;
        let raw = pointer
            .as_ref()
            .ok_or_else(|| "macOS video presenter has already been released.".to_owned())?
            .as_ptr();
        check_with_error(|buffer, capacity| unsafe {
            empv_mac_presenter_present(raw, pool.raw.as_ptr(), surface_index, buffer, capacity)
        })
    }

    pub fn close(&self) -> Result<(), String> {
        let pointer = self
            .raw
            .lock()
            .map_err(|_| "macOS video presenter lock was poisoned.".to_owned())?;
        if !self.invalidated.swap(true, Ordering::AcqRel)
            && let Some(pointer) = pointer.as_ref()
        {
            unsafe { empv_mac_presenter_invalidate(pointer.as_ptr()) };
        }
        Ok(())
    }

    fn pointer_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<NonNull<NativePresenter>>>, String> {
        let guard = self
            .raw
            .lock()
            .map_err(|_| "macOS video presenter lock was poisoned.".to_owned())?;
        if guard.is_none() || self.invalidated.load(Ordering::Acquire) {
            return Err("macOS video presenter has already been released.".to_owned());
        }
        Ok(guard)
    }
}

impl Drop for VideoPresenter {
    fn drop(&mut self) {
        let _ = self.close();
        let raw = match self.raw.get_mut() {
            Ok(raw) => raw.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(raw) = raw {
            unsafe { empv_mac_presenter_destroy(raw.as_ptr()) };
        }
    }
}

pub fn set_window_backdrop(
    native_view: usize,
    color: Option<(f64, f64, f64)>,
) -> Result<(), String> {
    let (enabled, red, green, blue) = color
        .map(|(red, green, blue)| (true, red, green, blue))
        .unwrap_or((false, 0.0, 0.0, 0.0));
    check_with_error(|buffer, capacity| unsafe {
        empv_mac_window_set_backdrop(native_view, enabled, red, green, blue, buffer, capacity)
    })
}

#[derive(Clone, Copy, Debug)]
pub enum OcclusionEvent {
    VisibilityChanged(bool),
    WindowClosed,
}

type OcclusionHandler = dyn Fn(OcclusionEvent) + Send + Sync + 'static;

struct OcclusionCallbackContext {
    active: AtomicBool,
    callback: Arc<OcclusionHandler>,
}

pub struct OcclusionObserver {
    raw: NonNull<NativeOcclusionObserver>,
    callback_context: *const OcclusionCallbackContext,
}

impl OcclusionObserver {
    pub fn create(native_view: usize, callback: Arc<OcclusionHandler>) -> Result<Self, String> {
        let callback_context = Arc::new(OcclusionCallbackContext {
            active: AtomicBool::new(true),
            callback,
        });
        let context = Arc::into_raw(callback_context);
        let (raw, error) = with_error_buffer(|buffer, capacity| unsafe {
            empv_mac_occlusion_observer_create(
                native_view,
                context.cast_mut().cast(),
                Some(occlusion_callback_trampoline),
                Some(occlusion_context_release_trampoline),
                buffer,
                capacity,
            )
        });
        let Some(raw) = NonNull::new(raw) else {
            unsafe { drop(Arc::from_raw(context)) };
            return Err(fallback_error(error, "Failed to observe window occlusion."));
        };
        Ok(Self {
            raw,
            callback_context: context,
        })
    }
}

impl Drop for OcclusionObserver {
    fn drop(&mut self) {
        if let Some(context) = unsafe { self.callback_context.as_ref() } {
            context.active.store(false, Ordering::Release);
        }
        unsafe { empv_mac_occlusion_observer_destroy(self.raw.as_ptr()) };
    }
}

unsafe extern "C" fn occlusion_callback_trampoline(
    context: *mut c_void,
    event: c_int,
    visible: bool,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let context_pointer = context.cast::<OcclusionCallbackContext>();
        unsafe { Arc::increment_strong_count(context_pointer) };
        let context = unsafe { Arc::from_raw(context_pointer) };
        if !context.active.load(Ordering::Acquire) {
            return;
        }
        let event = match event {
            1 => OcclusionEvent::VisibilityChanged(visible),
            2 => OcclusionEvent::WindowClosed,
            _ => return,
        };
        (context.callback)(event);
    }));
}

unsafe extern "C" fn occlusion_context_release_trampoline(context: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !context.is_null() {
            unsafe { drop(Arc::from_raw(context.cast::<OcclusionCallbackContext>())) };
        }
    }));
}

fn check_with_error(call: impl FnOnce(*mut c_char, usize) -> c_int) -> Result<(), String> {
    let (result, error) = with_error_buffer(call);
    if result < 0 {
        Err(fallback_error(
            error,
            "macOS native platform operation failed.",
        ))
    } else {
        Ok(())
    }
}

fn with_error_buffer<T>(call: impl FnOnce(*mut c_char, usize) -> T) -> (T, String) {
    let mut buffer = [0 as c_char; ERROR_CAPACITY];
    let result = call(buffer.as_mut_ptr(), buffer.len());
    let error = unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    (result, error)
}

fn fallback_error(error: String, fallback: &str) -> String {
    if error.is_empty() {
        fallback.to_owned()
    } else {
        error
    }
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Native string contains an embedded NUL byte.".to_owned())
}
