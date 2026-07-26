use std::sync::Arc;

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;

use crate::presentation::wid::{RenderSize, VideoPresenter};
use crate::session::registry::{self, Presenter};

use super::dto::{JsAttachOptions, JsBounds, JsRenderSize, ZOrder, parse_z_order};

fn error(reason: String) -> Error {
    Error::from_reason(reason)
}

fn window_handle(buffer: &Buffer) -> Result<usize> {
    if buffer.len() < std::mem::size_of::<usize>() {
        return Err(error(
            "Native window handle buffer is too small.".to_owned(),
        ));
    }
    let mut bytes = [0_u8; std::mem::size_of::<usize>()];
    bytes.copy_from_slice(&buffer[..std::mem::size_of::<usize>()]);
    let handle = usize::from_ne_bytes(bytes);
    if handle == 0 {
        Err(error(
            "Unable to resolve the Electron native window handle.".to_owned(),
        ))
    } else {
        Ok(handle)
    }
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
    let host = VideoPresenter::create().map_err(error)?;
    let size = match host.configure(parent, options.bounds()) {
        Ok(size) => size,
        Err(reason) => {
            let _ = host.close();
            return Err(error(reason));
        }
    };
    let presenter = Arc::new(Presenter { host });
    if let Some(previous) =
        registry::insert_presenter(presenter_id.clone(), presenter).map_err(error)?
        && let Err(reason) = previous.host.close()
    {
        if !previous.host.is_released() {
            let _ = registry::insert_presenter(presenter_id, previous).map_err(error)?;
        }
        return Err(error(reason));
    }
    Ok(size.into())
}

#[napi(js_name = "adoptVideoWindow")]
pub fn adopt_video_window(presenter_id: String, child_window_handle: i64) -> Result<()> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(error)? else {
        return Ok(());
    };
    presenter
        .host
        .adopt_child(child_window_handle as usize)
        .map_err(error)
}

pub fn set_presenter_bounds(presenter_id: String, bounds: JsBounds) -> Result<JsRenderSize> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(error)? else {
        return Ok(RenderSize::default().into());
    };
    presenter
        .host
        .set_bounds(bounds.into())
        .map(Into::into)
        .map_err(error)
}

pub fn refresh_presenter_scale(presenter_id: String) -> Result<JsRenderSize> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(error)? else {
        return Ok(RenderSize::default().into());
    };
    presenter
        .host
        .refresh_scale()
        .map(Into::into)
        .map_err(error)
}

pub fn set_presenter_suspended(presenter_id: String, suspended: bool) -> Result<()> {
    let Some(presenter) = registry::find_presenter(&presenter_id).map_err(error)? else {
        return Ok(());
    };
    presenter.host.set_suspended(suspended).map_err(error)
}

pub fn destroy_presenter(presenter_id: String) -> Result<()> {
    let Some(presenter) = registry::remove_presenter(&presenter_id).map_err(error)? else {
        return Ok(());
    };
    if let Err(reason) = presenter.host.close() {
        if !presenter.host.is_released() {
            let _ = registry::insert_presenter(presenter_id, presenter).map_err(error)?;
        }
        return Err(error(reason));
    }
    Ok(())
}

pub fn set_window_backdrop(_window_handle: Buffer, _color: Option<String>) -> Result<()> {
    Ok(())
}
