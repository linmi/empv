#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub mod wid;
