use napi::Result;
use napi::bindgen_prelude::{AsyncTask, FnArgs, Function};
use napi_derive::napi;

use super::dto::{JsCapturedFrame, JsSessionOptions, JsSessionSnapshot};
#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use super::wid_session as platform;

#[cfg(target_os = "macos")]
type PlatformCreateSessionTask = super::macos::CreateSessionTask;
#[cfg(any(target_os = "windows", target_os = "linux"))]
type PlatformCreateSessionTask = super::wid_session::CreateSessionTask;
#[cfg(target_os = "macos")]
type PlatformDisposeSessionTask = super::macos::DisposeSessionTask;
#[cfg(any(target_os = "windows", target_os = "linux"))]
type PlatformDisposeSessionTask = super::wid_session::DisposeSessionTask;

#[napi(js_name = "isSupported")]
pub fn is_supported() -> bool {
    platform::is_supported()
}

#[napi(js_name = "getPresentationKind")]
pub fn get_presentation_kind() -> &'static str {
    platform::get_presentation_kind()
}

#[napi(js_name = "createSession")]
pub fn create_session(
    options: JsSessionOptions,
    on_snapshot_changed: Function<'_, (), ()>,
    on_frame: Function<'_, FnArgs<(u32, f64, f64)>, ()>,
) -> Result<AsyncTask<PlatformCreateSessionTask>> {
    platform::create_session(options, on_snapshot_changed, on_frame)
}

#[napi(js_name = "disposeSession")]
pub fn dispose_session(session_id: String) -> Result<AsyncTask<PlatformDisposeSessionTask>> {
    platform::dispose_session(session_id)
}

#[napi(js_name = "getSessionSnapshot")]
pub fn get_session_snapshot(session_id: String) -> Result<Option<JsSessionSnapshot>> {
    platform::get_session_snapshot(session_id)
}

#[napi(js_name = "captureFrame")]
pub fn capture_frame(session_id: String) -> Result<Option<JsCapturedFrame>> {
    platform::capture_frame(session_id)
}

#[napi(js_name = "setRenderSize")]
pub fn set_render_size(session_id: String, width_pixels: f64, height_pixels: f64) -> Result<()> {
    platform::set_render_size(session_id, width_pixels, height_pixels)
}

#[napi(js_name = "setPresentationSuspended")]
pub fn set_presentation_suspended(session_id: String, suspended: bool) -> Result<()> {
    platform::set_presentation_suspended(session_id, suspended)
}
