use std::ffi::{CStr, CString, c_char, c_double, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const ERROR_CAPACITY: usize = 2048;
const FRAME_LINK_NAME_LIMIT: usize = 128;

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
