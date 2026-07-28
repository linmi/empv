use std::sync::Arc;

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;

use crate::presentation::wid::VideoPresenter;
use crate::session::registry::{self, Presenter};

use super::dto::{JsAttachOptions, JsBounds, JsRenderSize, ZOrder, parse_z_order};

// Electron serializes gfx::AcceleratedWidget on Linux, which is the 32-bit X11
// resource id. Xlib's Window typedef is pointer-width, but widening happens only
// after decoding that resource id. Windows serializes the native pointer value.
#[cfg(target_os = "linux")]
type ElectronWindowHandle = u32;
#[cfg(target_os = "windows")]
type ElectronWindowHandle = usize;

fn error(reason: String) -> Error {
    Error::from_reason(reason)
}

fn decode_window_handle(bytes: &[u8]) -> std::result::Result<usize, String> {
    const HANDLE_BYTES: usize = std::mem::size_of::<ElectronWindowHandle>();
    if bytes.len() != HANDLE_BYTES {
        return Err(format!(
            "Electron native window handle buffer has invalid size for {}: expected \
             {HANDLE_BYTES} bytes, received {} bytes.",
            std::env::consts::OS,
            bytes.len()
        ));
    }

    let mut native_bytes = [0_u8; HANDLE_BYTES];
    native_bytes.copy_from_slice(bytes);
    let handle = ElectronWindowHandle::from_ne_bytes(native_bytes) as usize;
    if handle == 0 {
        Err("Unable to resolve the Electron native window handle.".to_owned())
    } else {
        Ok(handle)
    }
}

fn window_handle(buffer: &Buffer) -> Result<usize> {
    decode_window_handle(buffer.as_ref()).map_err(error)
}

pub fn create_presenter(
    presenter_id: String,
    window_handle_buffer: Buffer,
    options: JsAttachOptions,
) -> Result<JsRenderSize> {
    let parent = window_handle(&window_handle_buffer)?;
    // This backend composites an OS child window into the app window, and a child
    // window is always above the web contents its parent draws. There is no
    // underlay here to ask for. The field used to be read and thrown away in the
    // native shim, so a caller that asked for underlay got overlay and no signal
    // that its request had not survived the crossing.
    if parse_z_order(&options.z_order).map_err(error)? == ZOrder::Underlay {
        return Err(error(
            "The 'window' presentation backend composites an OS child window, which is always \
             above the web contents: zOrder 'underlay' cannot be honoured here. Use 'overlay', \
             or branch on getPresentationKind() -- only 'layer' can composite beneath."
                .to_owned(),
        ));
    }
    let reservation = registry::reserve_presenter(presenter_id.clone()).map_err(error)?;
    let host = VideoPresenter::create().map_err(error)?;
    let size = match host.configure(parent, options.bounds()) {
        Ok(size) => size,
        Err(reason) => {
            return match host.close() {
                Ok(()) => Err(error(reason)),
                Err(cleanup_reason) => Err(error(format!(
                    "Failed to configure the native video presenter: {reason} Presenter rollback also failed: {cleanup_reason}"
                ))),
            };
        }
    };
    let presenter = Arc::new(Presenter { host });
    reservation.commit(presenter).map_err(error)?;
    Ok(size.into())
}

#[napi(js_name = "adoptVideoWindow")]
pub fn adopt_video_window(presenter_id: String, child_window_handle: i64) -> Result<()> {
    let presenter = registry::get_presenter(&presenter_id).map_err(error)?;
    presenter
        .host
        .adopt_child(child_window_handle as usize)
        .map_err(error)
}

pub fn set_presenter_bounds(presenter_id: String, bounds: JsBounds) -> Result<JsRenderSize> {
    let presenter = registry::get_presenter(&presenter_id).map_err(error)?;
    presenter
        .host
        .set_bounds(bounds.into())
        .map(Into::into)
        .map_err(error)
}

pub fn refresh_presenter_scale(presenter_id: String) -> Result<JsRenderSize> {
    let presenter = registry::get_presenter(&presenter_id).map_err(error)?;
    presenter
        .host
        .refresh_scale()
        .map(Into::into)
        .map_err(error)
}

pub fn set_presenter_suspended(presenter_id: String, suspended: bool) -> Result<()> {
    let presenter = registry::get_presenter(&presenter_id).map_err(error)?;
    presenter.host.set_suspended(suspended).map_err(error)
}

pub fn destroy_presenter(presenter_id: String) -> Result<()> {
    let Some(destruction) = registry::begin_presenter_destruction(&presenter_id).map_err(error)?
    else {
        return Ok(());
    };
    match destruction.presenter().host.close() {
        Ok(()) => destruction.commit().map_err(error),
        Err(reason) => match destruction.record_failure() {
            Ok(()) => Err(error(reason)),
            Err(registry_reason) => Err(error(format!(
                "{reason} Failed to retain retryable presenter cleanup ownership: {registry_reason}"
            ))),
        },
    }
}

pub fn set_window_backdrop(_window_handle: Buffer, _color: Option<String>) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_exact_electron_native_handle_abi() {
        let handle: ElectronWindowHandle = 0x1234;

        assert_eq!(
            decode_window_handle(&handle.to_ne_bytes()).expect("native window handle"),
            0x1234
        );
    }

    #[test]
    fn rejects_zero_and_non_exact_handle_buffers() {
        let zero = ElectronWindowHandle::default().to_ne_bytes();
        assert_eq!(
            decode_window_handle(&zero).expect_err("zero handle"),
            "Unable to resolve the Electron native window handle."
        );

        let oversized = vec![0_u8; std::mem::size_of::<ElectronWindowHandle>() + 1];
        let error = decode_window_handle(&oversized).expect_err("oversized handle buffer");
        assert!(error.contains("has invalid size"));
        assert!(error.contains(&format!(
            "expected {} bytes, received {} bytes",
            std::mem::size_of::<ElectronWindowHandle>(),
            oversized.len()
        )));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_rejects_a_pointer_width_buffer_instead_of_truncating_it() {
        let pointer_width_bytes = 0x1234_usize.to_ne_bytes();
        assert_eq!(pointer_width_bytes.len(), 8);

        assert_eq!(
            decode_window_handle(&pointer_width_bytes).expect_err("pointer-width handle"),
            "Electron native window handle buffer has invalid size for linux: expected 4 bytes, \
             received 8 bytes."
        );
    }
}
