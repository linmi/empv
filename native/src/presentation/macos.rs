use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
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
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RenderSize {
    pub width_pixels: i32,
    pub height_pixels: i32,
}

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
