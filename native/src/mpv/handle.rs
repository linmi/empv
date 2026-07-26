use std::ffi::{CStr, CString, c_char, c_int};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

use super::ffi;

pub type MpvResult<T> = Result<T, String>;

pub struct OwnedMpvHandle {
    raw: NonNull<ffi::MpvHandle>,
    terminated: AtomicBool,
}

unsafe impl Send for OwnedMpvHandle {}
unsafe impl Sync for OwnedMpvHandle {}

impl OwnedMpvHandle {
    pub fn create() -> MpvResult<Self> {
        NonNull::new(unsafe { ffi::mpv_create() })
            .map(|raw| Self {
                raw,
                terminated: AtomicBool::new(false),
            })
            .ok_or_else(|| "Failed to create libmpv handle.".to_owned())
    }

    pub fn raw(&self) -> *mut ffi::MpvHandle {
        self.raw.as_ptr()
    }

    pub fn initialize(&self) -> MpvResult<()> {
        self.check("initialize libmpv", unsafe {
            ffi::mpv_initialize(self.raw())
        })
    }

    pub fn set_option(&self, name: &str, value: &str) -> MpvResult<()> {
        self.set_option_for_action(name, value, "set libmpv option")
    }

    pub fn set_option_for_action(&self, name: &str, value: &str, action: &str) -> MpvResult<()> {
        let name = cstring(name)?;
        let value = cstring(value)?;
        self.check(action, unsafe {
            ffi::mpv_set_option_string(self.raw(), name.as_ptr(), value.as_ptr())
        })
    }

    pub fn command(&self, command: &str, action: &str) -> MpvResult<()> {
        let command = cstring(command)?;
        self.check(action, unsafe {
            ffi::mpv_command_string(self.raw(), command.as_ptr())
        })
    }

    pub fn set_string(&self, name: &str, value: &str, action: &str) -> MpvResult<()> {
        let name = cstring(name)?;
        let value = cstring(value)?;
        let mut pointer = value.as_ptr().cast_mut();
        self.check(action, unsafe {
            ffi::mpv_set_property(
                self.raw(),
                name.as_ptr(),
                ffi::FORMAT_STRING,
                (&mut pointer as *mut *mut c_char).cast(),
            )
        })
    }

    pub fn set_string_async(
        &self,
        request_id: u64,
        name: &str,
        value: &str,
        action: &str,
    ) -> MpvResult<()> {
        let name = cstring(name)?;
        let value = cstring(value)?;
        let mut pointer = value.as_ptr().cast_mut();
        self.check(action, unsafe {
            ffi::mpv_set_property_async(
                self.raw(),
                request_id,
                name.as_ptr(),
                ffi::FORMAT_STRING,
                (&mut pointer as *mut *mut c_char).cast(),
            )
        })
    }

    pub fn set_double_async(
        &self,
        request_id: u64,
        name: &str,
        mut value: f64,
        action: &str,
    ) -> MpvResult<()> {
        let name = cstring(name)?;
        self.check(action, unsafe {
            ffi::mpv_set_property_async(
                self.raw(),
                request_id,
                name.as_ptr(),
                ffi::FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        })
    }

    pub fn set_flag_async(
        &self,
        request_id: u64,
        name: &str,
        value: bool,
        action: &str,
    ) -> MpvResult<()> {
        let name = cstring(name)?;
        let mut value: c_int = i32::from(value);
        self.check(action, unsafe {
            ffi::mpv_set_property_async(
                self.raw(),
                request_id,
                name.as_ptr(),
                ffi::FORMAT_FLAG,
                (&mut value as *mut c_int).cast(),
            )
        })
    }

    pub fn set_i64_async(
        &self,
        request_id: u64,
        name: &str,
        mut value: i64,
        action: &str,
    ) -> MpvResult<()> {
        let name = cstring(name)?;
        self.check(action, unsafe {
            ffi::mpv_set_property_async(
                self.raw(),
                request_id,
                name.as_ptr(),
                ffi::FORMAT_INT64,
                (&mut value as *mut i64).cast(),
            )
        })
    }

    pub fn observe(&self, id: u64, name: &str, format: c_int) -> MpvResult<()> {
        let name = cstring(name)?;
        self.check("observe libmpv property", unsafe {
            ffi::mpv_observe_property(self.raw(), id, name.as_ptr(), format)
        })
    }

    pub fn request_logs(&self, level: &str) -> MpvResult<()> {
        let level = cstring(level)?;
        self.check("request libmpv logs", unsafe {
            ffi::mpv_request_log_messages(self.raw(), level.as_ptr())
        })
    }

    pub fn wakeup(&self) {
        // Create-failure cleanup can reach wakeup() again after terminate() has
        // already freed the handle (compute and finally both tear down), so a
        // terminated handle must make this a no-op instead of touching freed
        // memory.
        if self.terminated.load(Ordering::Acquire) {
            return;
        }
        unsafe { ffi::mpv_wakeup(self.raw()) };
    }

    pub fn terminate(&self) {
        if !self.terminated.swap(true, Ordering::AcqRel) {
            unsafe { ffi::mpv_terminate_destroy(self.raw()) };
        }
    }

    pub fn wait_event(&self, timeout: f64) -> *mut ffi::MpvEvent {
        unsafe { ffi::mpv_wait_event(self.raw(), timeout) }
    }

    pub fn check(&self, action: &str, code: c_int) -> MpvResult<()> {
        if code < 0 {
            Err(format!("Failed to {action}: {}", error_string(code)))
        } else {
            Ok(())
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub fn command_node(
        &self,
        command: &mut ffi::MpvNode,
        result: &mut ffi::MpvNode,
        action: &str,
    ) -> MpvResult<()> {
        self.check(action, unsafe {
            ffi::mpv_command_node(self.raw(), command, result)
        })
    }

    pub fn command_node_async(
        &self,
        request_id: u64,
        command: &mut ffi::MpvNode,
        action: &str,
    ) -> MpvResult<()> {
        self.check(action, unsafe {
            ffi::mpv_command_node_async(self.raw(), request_id, command)
        })
    }
}

impl Drop for OwnedMpvHandle {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub fn error_string(code: c_int) -> String {
    let pointer = unsafe { ffi::mpv_error_string(code) };
    if pointer.is_null() {
        return format!("libmpv error {code}");
    }
    unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned()
}

pub fn cstring(value: &str) -> MpvResult<CString> {
    CString::new(value).map_err(|_| "Native string contains an embedded NUL byte.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wakeup_after_terminate_does_not_touch_the_freed_handle() {
        let handle = OwnedMpvHandle::create().unwrap();
        handle.terminate();
        handle.wakeup();
        handle.terminate();
    }
}
