use std::ffi::{CStr, CString, c_char};

use super::ffi;
use super::handle::{MpvResult, OwnedMpvHandle, cstring};
use crate::session::snapshot::{Chapter, Track};

pub fn node_string(node: &ffi::MpvNode) -> String {
    match node.format {
        ffi::FORMAT_STRING => c_string(unsafe { node.u.string }),
        ffi::FORMAT_INT64 => unsafe { node.u.int64 }.to_string(),
        ffi::FORMAT_DOUBLE => unsafe { node.u.double_ }.to_string(),
        _ => String::new(),
    }
}

pub fn node_flag(node: &ffi::MpvNode) -> bool {
    match node.format {
        ffi::FORMAT_FLAG => (unsafe { node.u.flag }) != 0,
        ffi::FORMAT_STRING => {
            matches!(
                node_string(node).to_ascii_lowercase().as_str(),
                "yes" | "true" | "1"
            )
        }
        _ => false,
    }
}

pub fn node_i64(node: &ffi::MpvNode) -> Option<i64> {
    match node.format {
        ffi::FORMAT_INT64 => Some(unsafe { node.u.int64 }),
        ffi::FORMAT_DOUBLE => Some((unsafe { node.u.double_ }) as i64),
        ffi::FORMAT_STRING => node_string(node).parse().ok(),
        _ => None,
    }
}

pub fn node_f64(node: &ffi::MpvNode) -> Option<f64> {
    match node.format {
        ffi::FORMAT_DOUBLE => Some(unsafe { node.u.double_ }),
        ffi::FORMAT_INT64 => Some((unsafe { node.u.int64 }) as f64),
        ffi::FORMAT_STRING => node_string(node).parse().ok(),
        _ => None,
    }
}

pub fn map_value<'a>(node: &'a ffi::MpvNode, key: &str) -> Option<&'a ffi::MpvNode> {
    if node.format != ffi::FORMAT_NODE_MAP {
        return None;
    }
    let list = unsafe { node.u.list.as_ref() }?;
    if list.keys.is_null() || list.values.is_null() || list.num <= 0 {
        return None;
    }
    for index in 0..list.num as usize {
        let key_pointer = unsafe { *list.keys.add(index) };
        if !key_pointer.is_null()
            && unsafe { CStr::from_ptr(key_pointer) }.to_bytes() == key.as_bytes()
        {
            return Some(unsafe { &*list.values.add(index) });
        }
    }
    None
}

pub fn array_values(node: &ffi::MpvNode) -> Vec<&ffi::MpvNode> {
    if node.format != ffi::FORMAT_NODE_ARRAY {
        return Vec::new();
    }
    let Some(list) = (unsafe { node.u.list.as_ref() }) else {
        return Vec::new();
    };
    if list.values.is_null() || list.num <= 0 {
        return Vec::new();
    }
    (0..list.num as usize)
        .map(|index| unsafe { &*list.values.add(index) })
        .collect()
}

pub fn tracks(node: &ffi::MpvNode, kind: &str) -> Vec<Track> {
    array_values(node)
        .into_iter()
        .filter_map(|item| {
            if node_string(map_value(item, "type")?) != kind {
                return None;
            }
            let id = node_i64(map_value(item, "id")?)?;
            if id < 0 {
                return None;
            }
            Some(Track {
                id,
                title: map_value(item, "title")
                    .map(node_string)
                    .filter(|v| !v.is_empty()),
                language: map_value(item, "lang")
                    .map(node_string)
                    .filter(|v| !v.is_empty()),
                selected: map_value(item, "selected").is_some_and(node_flag),
                default_track: map_value(item, "default").is_some_and(node_flag),
                forced: map_value(item, "forced").is_some_and(node_flag),
            })
        })
        .collect()
}

pub fn count_tracks(node: &ffi::MpvNode, kind: &str) -> i64 {
    array_values(node)
        .into_iter()
        .filter(|item| map_value(item, "type").is_some_and(|value| node_string(value) == kind))
        .count() as i64
}

pub fn chapters(node: &ffi::MpvNode) -> Vec<Chapter> {
    array_values(node)
        .into_iter()
        .map(|item| Chapter {
            title: map_value(item, "title")
                .map(node_string)
                .unwrap_or_default(),
            start_seconds: map_value(item, "time").and_then(node_f64).unwrap_or(0.0),
        })
        .collect()
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub struct NodeResult {
    node: ffi::MpvNode,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl NodeResult {
    pub fn new() -> Self {
        Self {
            node: ffi::MpvNode::default(),
        }
    }

    pub fn as_mut(&mut self) -> &mut ffi::MpvNode {
        &mut self.node
    }

    pub fn node(&self) -> &ffi::MpvNode {
        &self.node
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl Drop for NodeResult {
    fn drop(&mut self) {
        unsafe { ffi::mpv_free_node_contents(&mut self.node) };
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn screenshot_raw(handle: &OwnedMpvHandle) -> MpvResult<Option<(u32, u32, Vec<u8>)>> {
    let mut builder = StringArrayCommand::new(&["screenshot-raw"])?;
    let mut result = NodeResult::new();
    handle.command_node(builder.node_mut(), result.as_mut(), "capture video frame")?;
    if result.node().format != ffi::FORMAT_NODE_MAP {
        return Ok(None);
    }
    let width = map_value(result.node(), "w")
        .and_then(node_i64)
        .unwrap_or(0);
    let height = map_value(result.node(), "h")
        .and_then(node_i64)
        .unwrap_or(0);
    let stride = map_value(result.node(), "stride")
        .and_then(node_i64)
        .unwrap_or(0);
    let format = map_value(result.node(), "format")
        .map(node_string)
        .unwrap_or_default();
    let Some(data_node) = map_value(result.node(), "data") else {
        return Ok(None);
    };
    if data_node.format != ffi::FORMAT_BYTE_ARRAY
        || width <= 0
        || height <= 0
        || stride < width * 4
        || format != "bgr0"
    {
        return Ok(None);
    }
    let Some(bytes) = (unsafe { data_node.u.ba.as_ref() }) else {
        return Ok(None);
    };
    let required_size = (stride as usize).saturating_mul(height as usize);
    if bytes.data.is_null() || bytes.size < required_size {
        return Ok(None);
    }
    let source = unsafe { std::slice::from_raw_parts(bytes.data.cast::<u8>(), bytes.size) };
    let mut rgba = vec![
        0_u8;
        (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4)
    ];
    for y in 0..height as usize {
        let source_row = &source[y * stride as usize..];
        let target_row = &mut rgba[y * width as usize * 4..];
        for x in 0..width as usize {
            let source_pixel = &source_row[x * 4..];
            let target_pixel = &mut target_row[x * 4..];
            target_pixel[0] = source_pixel[2];
            target_pixel[1] = source_pixel[1];
            target_pixel[2] = source_pixel[0];
            target_pixel[3] = 255;
        }
    }
    Ok(Some((width as u32, height as u32, rgba)))
}

pub fn loadfile_async(
    handle: &OwnedMpvHandle,
    request_id: u64,
    path: &str,
    mode: &str,
    options: &[(String, String)],
    action: &str,
) -> MpvResult<()> {
    let strings: Vec<CString> = [
        vec![cstring("loadfile")?, cstring(path)?, cstring(mode)?],
        options
            .iter()
            .flat_map(|(key, value)| [cstring(key), cstring(value)])
            .collect::<Result<Vec<_>, _>>()?,
    ]
    .concat();
    let option_count = options.len();
    let mut option_values = Vec::with_capacity(option_count);
    let mut option_keys = Vec::with_capacity(option_count);
    for index in 0..option_count {
        option_keys.push(strings[3 + index * 2].as_ptr().cast_mut());
        option_values.push(ffi::MpvNode {
            u: ffi::MpvNodeUnion {
                string: strings[4 + index * 2].as_ptr().cast_mut(),
            },
            format: ffi::FORMAT_STRING,
        });
    }
    let mut option_list = ffi::MpvNodeList {
        num: option_count as i32,
        values: option_values.as_mut_ptr(),
        keys: option_keys.as_mut_ptr(),
    };
    // mpv 0.38 (client API 2.3) inserted an `index` argument between the flags
    // and the per-file options ("loadfile url flags index options"); older
    // client APIs expect the options map in that position and reject the extra
    // INT64. Linux links the system libmpv, so both signatures must work.
    // Delete this branch once every platform runs a vendored libmpv >= 0.38.
    let loadfile_has_index_argument =
        (unsafe { ffi::mpv_client_api_version() } as u64) >= ((2 << 16) | 3);
    let mut values = vec![
        string_node(strings[0].as_ptr()),
        string_node(strings[1].as_ptr()),
        string_node(strings[2].as_ptr()),
    ];
    if loadfile_has_index_argument {
        values.push(ffi::MpvNode {
            u: ffi::MpvNodeUnion { int64: -1 },
            format: ffi::FORMAT_INT64,
        });
    }
    values.push(ffi::MpvNode {
        u: ffi::MpvNodeUnion {
            list: &mut option_list,
        },
        format: ffi::FORMAT_NODE_MAP,
    });
    let mut list = ffi::MpvNodeList {
        num: values.len() as i32,
        values: values.as_mut_ptr(),
        keys: std::ptr::null_mut(),
    };
    let mut command = ffi::MpvNode {
        u: ffi::MpvNodeUnion { list: &mut list },
        format: ffi::FORMAT_NODE_ARRAY,
    };
    handle.command_node_async(request_id, &mut command, action)
}

pub fn command_strings_async(
    handle: &OwnedMpvHandle,
    request_id: u64,
    values: &[&str],
    action: &str,
) -> MpvResult<()> {
    let mut builder = StringArrayCommand::new(values)?;
    handle.command_node_async(request_id, builder.node_mut(), action)
}

struct StringArrayCommand {
    _strings: Vec<CString>,
    values: Vec<ffi::MpvNode>,
    list: ffi::MpvNodeList,
    node: ffi::MpvNode,
}

impl StringArrayCommand {
    fn new(values: &[&str]) -> MpvResult<Self> {
        let strings = values
            .iter()
            .map(|value| cstring(value))
            .collect::<Result<Vec<_>, _>>()?;
        let mut nodes = strings
            .iter()
            .map(|value| string_node(value.as_ptr()))
            .collect::<Vec<_>>();
        let mut list = ffi::MpvNodeList {
            num: nodes.len() as i32,
            values: nodes.as_mut_ptr(),
            keys: std::ptr::null_mut(),
        };
        let node = ffi::MpvNode {
            u: ffi::MpvNodeUnion { list: &mut list },
            format: ffi::FORMAT_NODE_ARRAY,
        };
        let mut result = Self {
            _strings: strings,
            values: nodes,
            list,
            node,
        };
        result.refresh();
        Ok(result)
    }

    fn refresh(&mut self) {
        self.list.values = self.values.as_mut_ptr();
        self.node.u = ffi::MpvNodeUnion {
            list: &mut self.list,
        };
    }

    fn node_mut(&mut self) -> &mut ffi::MpvNode {
        self.refresh();
        &mut self.node
    }
}

fn string_node(value: *const c_char) -> ffi::MpvNode {
    ffi::MpvNode {
        u: ffi::MpvNodeUnion {
            string: value.cast_mut(),
        },
        format: ffi::FORMAT_STRING,
    }
}

fn c_string(pointer: *const c_char) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}
