#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod mpv;
mod napi;
mod playback;
mod presentation;
mod session;

pub use napi::dto::*;
#[cfg(target_os = "macos")]
pub use napi::macos::{
    configure_frame_link, observe_window_occlusion, present_surface, start_presenter_link,
    stop_presenter_link, unobserve_window_occlusion,
};
pub use napi::playback::*;
pub use napi::presenter::*;
pub use napi::session::*;
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub use napi::wid_presenter::adopt_video_window;
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub use napi::wid_session::get_video_window_handle;
