use std::ffi::{CStr, c_char, c_double, c_int, c_void};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, ThreadId};

pub type WidResult<T> = Result<T, String>;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RenderSize {
    pub width_pixels: i32,
    pub height_pixels: i32,
}

unsafe extern "C" {
    fn empv_wid_last_error() -> *const c_char;
    fn empv_wid_host_create() -> *mut c_void;
    fn empv_wid_host_free(host: *mut c_void) -> c_int;
    fn empv_wid_host_is_available() -> c_int;
    fn empv_wid_host_open(host: *mut c_void) -> c_int;
    fn empv_wid_host_wid(host: *const c_void, buffer: *mut c_char, length: usize) -> c_int;
    fn empv_wid_host_native_handle(host: *const c_void) -> usize;
    fn empv_wid_host_hide(host: *mut c_void) -> c_int;
    fn empv_wid_host_destroy(host: *mut c_void) -> c_int;

    fn empv_wid_presenter_create() -> *mut c_void;
    fn empv_wid_presenter_free(presenter: *mut c_void) -> c_int;
    fn empv_wid_presenter_query_scale(
        presenter: *mut c_void,
        parent: usize,
        out_scale: *mut c_double,
    ) -> c_int;
    fn empv_wid_presenter_prepare_child(presenter: *mut c_void, child: usize) -> c_int;
    fn empv_wid_presenter_attach(presenter: *mut c_void, parent: usize, child: usize) -> c_int;
    fn empv_wid_presenter_set_bounds(
        presenter: *mut c_void,
        child: usize,
        x_pixels: i32,
        y_pixels: i32,
        width_pixels: i32,
        height_pixels: i32,
        frame_changed: c_int,
    ) -> c_int;
    fn empv_wid_presenter_set_visible(
        presenter: *mut c_void,
        child: usize,
        visible: c_int,
    ) -> c_int;
    fn empv_wid_presenter_detach(presenter: *mut c_void, child: usize) -> c_int;
}

pub struct VideoHost {
    // Stored as an integer so playback event threads never gain the ability to
    // dereference the platform owner. Lifecycle methods enforce the JS-thread
    // affinity required by Win32.
    raw: AtomicUsize,
    creator_thread: ThreadId,
}

impl VideoHost {
    pub fn is_available() -> bool {
        unsafe { empv_wid_host_is_available() != 0 }
    }

    pub fn create() -> WidResult<Self> {
        let raw = unsafe { empv_wid_host_create() };
        if raw.is_null() {
            return Err(last_error());
        }
        let host = Self {
            raw: AtomicUsize::new(raw as usize),
            creator_thread: thread::current().id(),
        };
        if let Err(error) = check(unsafe { empv_wid_host_open(raw) }) {
            let _ = unsafe { empv_wid_host_free(raw) };
            return Err(error);
        }
        Ok(host)
    }

    pub fn wid(&self) -> WidResult<String> {
        let mut buffer = [0 as c_char; 64];
        check(unsafe { empv_wid_host_wid(self.pointer()?, buffer.as_mut_ptr(), buffer.len()) })?;
        Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }

    pub fn native_handle(&self) -> WidResult<Option<usize>> {
        let pointer = self.pointer()?;
        let handle = unsafe { empv_wid_host_native_handle(pointer) };
        if handle == 0 {
            let error = last_error();
            if error.is_empty() {
                Ok(None)
            } else {
                Err(error)
            }
        } else {
            Ok(Some(handle))
        }
    }

    pub fn hide(&self) -> WidResult<()> {
        self.ensure_creator_thread()?;
        check(unsafe { empv_wid_host_hide(self.pointer()?) })
    }

    pub fn close(&self) -> WidResult<()> {
        self.ensure_creator_thread()?;
        let pointer = self.pointer()?;
        let destroy_error = check(unsafe { empv_wid_host_destroy(pointer) }).err();
        let free_error = check(unsafe { empv_wid_host_free(pointer) }).err();
        if free_error.is_none() {
            self.raw.store(0, Ordering::Release);
        }
        match (destroy_error, free_error) {
            (None, None) => Ok(()),
            (Some(reason), None) | (None, Some(reason)) => Err(reason),
            (Some(destroy), Some(free)) => Err(format!("{destroy}; {free}")),
        }
    }

    fn pointer(&self) -> WidResult<*mut c_void> {
        let pointer = self.raw.load(Ordering::Acquire);
        if pointer == 0 {
            Err("Native video window has already been released.".to_owned())
        } else {
            Ok(pointer as *mut c_void)
        }
    }

    fn ensure_creator_thread(&self) -> WidResult<()> {
        if self.creator_thread == thread::current().id() {
            Ok(())
        } else {
            Err("Native video window must be destroyed on its creating JS thread.".to_owned())
        }
    }
}

impl Drop for VideoHost {
    fn drop(&mut self) {
        if self.creator_thread == thread::current().id() && self.raw.load(Ordering::Acquire) != 0 {
            let _ = self.close();
        }
    }
}

pub struct VideoPresenter {
    raw: AtomicUsize,
    creator_thread: ThreadId,
    state: Mutex<PresenterState>,
}

struct PresenterState {
    parent: Option<usize>,
    child: Option<usize>,
    bounds: Bounds,
    scale: f64,
    suspended: bool,
    attached: bool,
}

impl VideoPresenter {
    pub fn create() -> WidResult<Self> {
        let raw = unsafe { empv_wid_presenter_create() };
        if raw.is_null() {
            Err(last_error())
        } else {
            Ok(Self {
                raw: AtomicUsize::new(raw as usize),
                creator_thread: thread::current().id(),
                state: Mutex::new(PresenterState {
                    parent: None,
                    child: None,
                    bounds: Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 1.0,
                        height: 1.0,
                    },
                    scale: 1.0,
                    suspended: false,
                    attached: false,
                }),
            })
        }
    }

    pub fn configure(&self, parent: usize, bounds: Bounds) -> WidResult<RenderSize> {
        self.ensure_creator_thread()?;
        validate_handle(parent, "parent")?;
        validate_bounds(bounds)?;
        let pointer = self.pointer()?;
        let scale = platform_query_scale(pointer, parent)?;
        let output = render_size(bounds, scale)?;
        let mut state = self.lock_state()?;

        if let Some(existing_parent) = state.parent
            && existing_parent != parent
        {
            return Err(format!(
                "Native video presenter is already configured for parent {existing_parent}; \
                 refusing to replace it with {parent}."
            ));
        }
        let old_bounds = state.bounds;
        let old_scale = state.scale;
        state.parent = Some(parent);
        state.bounds = bounds;
        state.scale = scale;

        if state.attached {
            if let Err(error) = platform_set_bounds(pointer, &state, false) {
                state.bounds = old_bounds;
                state.scale = old_scale;
                return Err(with_rollback(
                    error,
                    platform_set_bounds(pointer, &state, false),
                    "restoring the prior presenter bounds",
                ));
            }
        } else {
            reconcile(pointer, &mut state)?;
        }

        Ok(output)
    }

    pub fn adopt_child(&self, child: usize) -> WidResult<()> {
        self.ensure_creator_thread()?;
        validate_handle(child, "child")?;
        let pointer = self.pointer()?;
        let mut state = self.lock_state()?;
        if let Some(existing_child) = state.child
            && existing_child != child
        {
            return Err(format!(
                "Native video presenter already owns child {existing_child}; \
                 refusing to replace it with {child}."
            ));
        }
        state.child = Some(child);
        reconcile(pointer, &mut state)
    }

    pub fn set_bounds(&self, bounds: Bounds) -> WidResult<RenderSize> {
        self.ensure_creator_thread()?;
        validate_bounds(bounds)?;
        let pointer = self.pointer()?;
        let mut state = self.lock_state()?;
        if state.parent.is_none() {
            return Err("Native video presenter has not been configured.".to_owned());
        }
        let output = render_size(bounds, state.scale)?;
        let old_bounds = state.bounds;
        state.bounds = bounds;

        if state.attached {
            if let Err(error) = platform_set_bounds(pointer, &state, false) {
                state.bounds = old_bounds;
                return Err(with_rollback(
                    error,
                    platform_set_bounds(pointer, &state, false),
                    "restoring the prior presenter bounds",
                ));
            }
        } else {
            reconcile(pointer, &mut state)?;
        }

        Ok(output)
    }

    pub fn refresh_scale(&self) -> WidResult<RenderSize> {
        self.ensure_creator_thread()?;
        let pointer = self.pointer()?;
        let mut state = self.lock_state()?;
        let parent = state
            .parent
            .ok_or_else(|| "Native video presenter has not been configured.".to_owned())?;
        let scale = platform_query_scale(pointer, parent)?;
        let output = render_size(state.bounds, scale)?;
        let old_scale = state.scale;
        state.scale = scale;
        if state.attached {
            if let Err(error) = platform_set_bounds(pointer, &state, false) {
                state.scale = old_scale;
                return Err(with_rollback(
                    error,
                    platform_set_bounds(pointer, &state, false),
                    "restoring the prior presenter scale",
                ));
            }
        } else {
            reconcile(pointer, &mut state)?;
        }
        Ok(output)
    }

    pub fn set_suspended(&self, suspended: bool) -> WidResult<()> {
        self.ensure_creator_thread()?;
        let pointer = self.pointer()?;
        let mut state = self.lock_state()?;
        let old_suspended = state.suspended;
        if old_suspended == suspended {
            return Ok(());
        }
        if state.attached {
            let child = state
                .child
                .ok_or_else(|| "Attached presenter is missing its child handle.".to_owned())?;
            if let Err(error) = platform_set_visible(pointer, child, !suspended) {
                return Err(with_rollback(
                    error,
                    platform_set_visible(pointer, child, !old_suspended),
                    "restoring the prior presenter visibility",
                ));
            }
        }
        state.suspended = suspended;
        Ok(())
    }

    pub fn close(&self) -> WidResult<()> {
        self.ensure_creator_thread()?;
        let pointer = self.pointer()?;
        {
            let mut state = self.lock_state()?;
            release(pointer, &mut state)?;
        }
        check_operation(
            unsafe { empv_wid_presenter_free(pointer) },
            "Failed to free the native video presenter",
        )?;
        self.raw.store(0, Ordering::Release);
        Ok(())
    }

    fn pointer(&self) -> WidResult<*mut c_void> {
        let pointer = self.raw.load(Ordering::Acquire);
        if pointer == 0 {
            Err("Native video presenter has already been released.".to_owned())
        } else {
            Ok(pointer as *mut c_void)
        }
    }

    fn lock_state(&self) -> WidResult<std::sync::MutexGuard<'_, PresenterState>> {
        self.state
            .lock()
            .map_err(|_| "Native video presenter state mutex is poisoned.".to_owned())
    }

    fn ensure_creator_thread(&self) -> WidResult<()> {
        if self.creator_thread == thread::current().id() {
            Ok(())
        } else {
            Err("Native video presenter must be destroyed on its creating JS thread.".to_owned())
        }
    }
}

fn reconcile(pointer: *mut c_void, state: &mut PresenterState) -> WidResult<()> {
    if state.attached {
        return Ok(());
    }
    let (Some(parent), Some(child)) = (state.parent, state.child) else {
        return Ok(());
    };

    check_operation(
        unsafe { empv_wid_presenter_prepare_child(pointer, child) },
        "Failed to prepare the embedded MPV child window",
    )?;

    check_operation(
        unsafe { empv_wid_presenter_attach(pointer, parent, child) },
        "Failed to attach the embedded MPV child window",
    )?;

    if let Err(error) = platform_set_bounds(pointer, state, true) {
        return Err(rollback_attachment(
            state,
            pointer,
            child,
            error,
            "detaching the child after initial bounds failed",
        ));
    }

    if let Err(error) = platform_set_visible(pointer, child, !state.suspended) {
        return Err(rollback_attachment(
            state,
            pointer,
            child,
            error,
            "detaching the child after initial visibility failed",
        ));
    }

    state.attached = true;
    Ok(())
}

fn release(pointer: *mut c_void, state: &mut PresenterState) -> WidResult<()> {
    let Some(child) = state.child else {
        state.parent = None;
        state.attached = false;
        return Ok(());
    };

    let visibility_error = if state.attached {
        platform_set_visible(pointer, child, false).err()
    } else {
        None
    };
    let detach_error = if state.attached {
        platform_detach(pointer, child).err()
    } else {
        None
    };

    if detach_error.is_none() {
        state.attached = false;
        state.child = None;
        state.parent = None;
    }

    match (visibility_error, detach_error) {
        (None, None) => Ok(()),
        (Some(error), None) | (None, Some(error)) => Err(error),
        (Some(visibility), Some(detach)) => Err(format!("{visibility}; {detach}")),
    }
}

fn platform_query_scale(pointer: *mut c_void, parent: usize) -> WidResult<f64> {
    let mut scale = 0.0;
    check_operation(
        unsafe { empv_wid_presenter_query_scale(pointer, parent, &mut scale) },
        "Failed to query the embedded MPV presenter scale",
    )?;
    if !scale.is_finite() || scale <= 0.0 {
        Err(format!(
            "Native video presenter returned an invalid scale: {scale}."
        ))
    } else {
        Ok(scale)
    }
}

fn render_size(bounds: Bounds, scale: f64) -> WidResult<RenderSize> {
    let pixels = pixel_bounds(bounds, scale)?;
    Ok(RenderSize {
        width_pixels: pixels.width,
        height_pixels: pixels.height,
    })
}

fn platform_set_bounds(
    pointer: *mut c_void,
    state: &PresenterState,
    frame_changed: bool,
) -> WidResult<()> {
    if state.parent.is_none() {
        return Err("Native video presenter has no parent handle.".to_owned());
    }
    let child = state
        .child
        .ok_or_else(|| "Native video presenter has no child handle.".to_owned())?;
    let pixels = pixel_bounds(state.bounds, state.scale)?;
    check_operation(
        unsafe {
            empv_wid_presenter_set_bounds(
                pointer,
                child,
                pixels.x,
                pixels.y,
                pixels.width,
                pixels.height,
                i32::from(frame_changed),
            )
        },
        "Failed to position the embedded MPV child window",
    )
}

#[derive(Debug, PartialEq, Eq)]
struct PixelBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn pixel_bounds(bounds: Bounds, scale: f64) -> WidResult<PixelBounds> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(format!(
            "Native video presenter scale must be finite and positive, got {scale}."
        ));
    }
    let left = checked_floor(bounds.x * scale, "left")?;
    let top = checked_floor(bounds.y * scale, "top")?;
    let right = checked_ceil((bounds.x + bounds.width) * scale, "right")?;
    let bottom = checked_ceil((bounds.y + bounds.height) * scale, "bottom")?;

    Ok(PixelBounds {
        x: left,
        y: top,
        width: right.saturating_sub(left).max(1),
        height: bottom.saturating_sub(top).max(1),
    })
}

fn checked_floor(value: f64, field: &str) -> WidResult<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        Err(format!(
            "Native video presenter {field} pixel value is outside the i32 range: {value}."
        ))
    } else {
        Ok(value.floor() as i32)
    }
}

fn checked_ceil(value: f64, field: &str) -> WidResult<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        Err(format!(
            "Native video presenter {field} pixel value is outside the i32 range: {value}."
        ))
    } else {
        Ok(value.ceil() as i32)
    }
}

fn platform_set_visible(pointer: *mut c_void, child: usize, visible: bool) -> WidResult<()> {
    check_operation(
        unsafe { empv_wid_presenter_set_visible(pointer, child, i32::from(visible)) },
        if visible {
            "Failed to show the embedded MPV child window"
        } else {
            "Failed to hide the embedded MPV child window"
        },
    )
}

fn platform_detach(pointer: *mut c_void, child: usize) -> WidResult<()> {
    check_operation(
        unsafe { empv_wid_presenter_detach(pointer, child) },
        "Failed to detach the embedded MPV child window",
    )
}

fn with_rollback(error: String, rollback: WidResult<()>, action: &str) -> String {
    match rollback {
        Ok(()) => format!("{error}; rollback succeeded while {action}."),
        Err(rollback_error) => {
            format!("{error}; rollback failed while {action}: {rollback_error}")
        }
    }
}

fn rollback_attachment(
    state: &mut PresenterState,
    pointer: *mut c_void,
    child: usize,
    error: String,
    action: &str,
) -> String {
    match platform_detach(pointer, child) {
        Ok(()) => {
            state.attached = false;
            format!("{error}; rollback succeeded while {action}.")
        }
        Err(rollback_error) => {
            state.attached = true;
            format!("{error}; rollback failed while {action}: {rollback_error}")
        }
    }
}

impl Drop for VideoPresenter {
    fn drop(&mut self) {
        if self.creator_thread == thread::current().id() && self.raw.load(Ordering::Acquire) != 0 {
            let _ = self.close();
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn validate_handle(handle: usize, role: &str) -> WidResult<()> {
    if handle == 0 {
        Err(format!("Native video presenter {role} handle is required."))
    } else {
        Ok(())
    }
}

fn validate_bounds(bounds: Bounds) -> WidResult<()> {
    if bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
    {
        Ok(())
    } else {
        Err(format!(
            "Native video presenter bounds must contain only finite numbers: {bounds:?}."
        ))
    }
}

fn check(code: i32) -> WidResult<()> {
    if code < 0 { Err(last_error()) } else { Ok(()) }
}

fn check_operation(code: i32, context: &str) -> WidResult<()> {
    if code < 0 {
        let detail = last_error();
        if detail.is_empty() {
            Err(context.to_owned())
        } else {
            Err(format!("{context}: {detail}"))
        }
    } else {
        Ok(())
    }
}

fn last_error() -> String {
    let pointer = unsafe { empv_wid_last_error() };
    if pointer.is_null() {
        "Native video window operation failed.".to_owned()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_scale_drives_render_size_and_platform_bounds() {
        let bounds = Bounds {
            x: 10.25,
            y: -4.5,
            width: 320.0,
            height: 180.0,
        };
        let scale = 1.5;
        let size = render_size(bounds, scale).expect("render size");
        let pixels = pixel_bounds(bounds, scale).expect("pixel bounds");

        assert_eq!(
            size,
            RenderSize {
                width_pixels: 481,
                height_pixels: 271,
            }
        );
        assert_eq!(pixels.x, 15);
        assert_eq!(pixels.y, -7);
        assert_eq!(pixels.width, size.width_pixels);
        assert_eq!(pixels.height, size.height_pixels);
    }

    #[test]
    fn render_size_clamps_non_positive_dimensions_to_one_pixel() {
        let size = render_size(
            Bounds {
                x: 0.0,
                y: 0.0,
                width: -100.0,
                height: 0.0,
            },
            2.0,
        )
        .expect("render size");

        assert_eq!(size.width_pixels, 1);
        assert_eq!(size.height_pixels, 1);
    }

    #[test]
    fn fractional_css_edges_expand_outward_without_exposing_a_backing_pixel() {
        let pixels = pixel_bounds(
            Bounds {
                x: 12.25,
                y: 8.75,
                width: 100.5,
                height: 60.25,
            },
            2.0,
        )
        .expect("pixel bounds");

        assert_eq!(
            pixels,
            PixelBounds {
                x: 24,
                y: 17,
                width: 202,
                height: 121,
            }
        );
    }

    #[test]
    fn pixel_conversion_rejects_invalid_scale_and_overflow() {
        let bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        assert!(pixel_bounds(bounds, 0.0).is_err());
        assert!(
            pixel_bounds(
                Bounds {
                    x: f64::from(i32::MAX) + 1.0,
                    ..bounds
                },
                1.0,
            )
            .is_err()
        );
    }
}
