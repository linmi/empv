use std::ffi::{c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::ffi::MpvHandle;
use super::handle::{MpvResult, error_string};

const RENDER_PARAM_INVALID: c_int = 0;
const RENDER_PARAM_API_TYPE: c_int = 1;
const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const RENDER_PARAM_OPENGL_FBO: c_int = 3;
const RENDER_PARAM_FLIP_Y: c_int = 4;
const RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;
const RENDER_PARAM_SKIP_RENDERING: c_int = 13;

pub const RENDER_UPDATE_FRAME: u64 = 1;
static OPENGL_API_TYPE: &[u8] = b"opengl\0";

#[repr(C)]
pub struct MpvRenderContext {
    _private: [u8; 0],
}

#[repr(C)]
struct MpvRenderParam {
    kind: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct MpvOpenGlInitParams {
    get_proc_address: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
    get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
struct MpvOpenGlFbo {
    fbo: c_int,
    width: c_int,
    height: c_int,
    internal_format: c_int,
}

unsafe extern "C" {
    fn mpv_render_context_create(
        result: *mut *mut MpvRenderContext,
        handle: *mut MpvHandle,
        params: *mut MpvRenderParam,
    ) -> c_int;
    fn mpv_render_context_set_update_callback(
        context: *mut MpvRenderContext,
        callback: Option<unsafe extern "C" fn(*mut c_void)>,
        callback_context: *mut c_void,
    );
    fn mpv_render_context_update(context: *mut MpvRenderContext) -> u64;
    fn mpv_render_context_render(
        context: *mut MpvRenderContext,
        params: *mut MpvRenderParam,
    ) -> c_int;
    fn mpv_render_context_free(context: *mut MpvRenderContext);
}

type UpdateCallback = dyn Fn() + Send + Sync + 'static;

struct UpdateCallbackContext {
    callback: Arc<UpdateCallback>,
}

/// Owns one libmpv render context.
///
/// Callers must serialize all methods and keep the same OpenGL context current
/// for `create_open_gl`, `update`, `render_*`, and `close`.
pub struct OwnedRenderContext {
    raw: NonNull<MpvRenderContext>,
    closed: AtomicBool,
    callback_context: Mutex<Option<Box<UpdateCallbackContext>>>,
}

unsafe impl Send for OwnedRenderContext {}

impl OwnedRenderContext {
    pub fn create_open_gl(
        handle: *mut MpvHandle,
        get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    ) -> MpvResult<Self> {
        let mut open_gl = MpvOpenGlInitParams {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut params = [
            MpvRenderParam {
                kind: RENDER_PARAM_API_TYPE,
                data: OPENGL_API_TYPE.as_ptr().cast::<c_char>().cast_mut().cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&mut open_gl as *mut MpvOpenGlInitParams).cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let mut raw = std::ptr::null_mut();
        let result = unsafe { mpv_render_context_create(&mut raw, handle, params.as_mut_ptr()) };
        if result < 0 {
            return Err(format!(
                "Failed to create libmpv render context: {}",
                error_string(result)
            ));
        }
        let raw =
            NonNull::new(raw).ok_or_else(|| "libmpv created a null render context.".to_owned())?;
        Ok(Self {
            raw,
            closed: AtomicBool::new(false),
            callback_context: Mutex::new(None),
        })
    }

    pub fn set_update_callback(&self, callback: Arc<UpdateCallback>) -> MpvResult<()> {
        let mut slot = self
            .callback_context
            .lock()
            .map_err(|_| "libmpv render callback lock was poisoned.".to_owned())?;
        unsafe {
            mpv_render_context_set_update_callback(self.raw.as_ptr(), None, std::ptr::null_mut());
        }
        let mut context = Box::new(UpdateCallbackContext { callback });
        let context_pointer = (&mut *context as *mut UpdateCallbackContext).cast();
        unsafe {
            mpv_render_context_set_update_callback(
                self.raw.as_ptr(),
                Some(update_callback_trampoline),
                context_pointer,
            );
        }
        *slot = Some(context);
        Ok(())
    }

    pub fn update(&self) -> u64 {
        unsafe { mpv_render_context_update(self.raw.as_ptr()) }
    }

    pub fn render_skip(&self) -> MpvResult<()> {
        let mut skip = 1_i32;
        let mut params = [
            MpvRenderParam {
                kind: RENDER_PARAM_SKIP_RENDERING,
                data: (&mut skip as *mut i32).cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        self.check_render(unsafe {
            mpv_render_context_render(self.raw.as_ptr(), params.as_mut_ptr())
        })
    }

    pub fn render_fbo(&self, fbo: i32, width: i32, height: i32) -> MpvResult<()> {
        let mut framebuffer = MpvOpenGlFbo {
            fbo,
            width,
            height,
            internal_format: 0,
        };
        let mut flip_y = 0_i32;
        let mut block_for_target_time = 0_i32;
        let mut params = [
            MpvRenderParam {
                kind: RENDER_PARAM_OPENGL_FBO,
                data: (&mut framebuffer as *mut MpvOpenGlFbo).cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_FLIP_Y,
                data: (&mut flip_y as *mut i32).cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
                data: (&mut block_for_target_time as *mut i32).cast(),
            },
            MpvRenderParam {
                kind: RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        self.check_render(unsafe {
            mpv_render_context_render(self.raw.as_ptr(), params.as_mut_ptr())
        })
    }

    pub fn close(&self) -> MpvResult<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let mut slot = match self.callback_context.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        unsafe {
            mpv_render_context_set_update_callback(self.raw.as_ptr(), None, std::ptr::null_mut());
            mpv_render_context_free(self.raw.as_ptr());
        }
        slot.take();
        self.callback_context.clear_poison();
        Ok(())
    }

    fn check_render(&self, code: c_int) -> MpvResult<()> {
        if code < 0 {
            Err(error_string(code))
        } else {
            Ok(())
        }
    }
}

impl Drop for OwnedRenderContext {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

unsafe extern "C" fn update_callback_trampoline(context: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let Some(context) = (unsafe { context.cast::<UpdateCallbackContext>().as_ref() }) else {
            return;
        };
        (context.callback)();
    }));
}
