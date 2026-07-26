use napi::Result;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use super::dto::{JsAttachOptions, JsBounds, JsRenderSize};
#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use super::wid_presenter as platform;

#[napi(js_name = "createPresenter")]
pub fn create_presenter(
    presenter_id: String,
    window_handle: Buffer,
    options: JsAttachOptions,
) -> Result<JsRenderSize> {
    platform::create_presenter(presenter_id, window_handle, options)
}

#[napi(js_name = "setPresenterBounds")]
pub fn set_presenter_bounds(presenter_id: String, bounds: JsBounds) -> Result<JsRenderSize> {
    platform::set_presenter_bounds(presenter_id, bounds)
}

#[napi(js_name = "refreshPresenterScale")]
pub fn refresh_presenter_scale(presenter_id: String) -> Result<JsRenderSize> {
    platform::refresh_presenter_scale(presenter_id)
}

#[napi(js_name = "setPresenterSuspended")]
pub fn set_presenter_suspended(presenter_id: String, suspended: bool) -> Result<()> {
    platform::set_presenter_suspended(presenter_id, suspended)
}

#[napi(js_name = "destroyPresenter")]
pub fn destroy_presenter(presenter_id: String) -> Result<()> {
    platform::destroy_presenter(presenter_id)
}

#[napi(js_name = "setWindowBackdrop")]
pub fn set_window_backdrop(window_handle: Buffer, color: Option<String>) -> Result<()> {
    platform::set_window_backdrop(window_handle, color)
}
