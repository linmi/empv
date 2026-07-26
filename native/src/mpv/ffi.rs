use std::ffi::{c_char, c_double, c_int, c_void};

#[repr(C)]
pub struct MpvHandle {
    _private: [u8; 0],
}

// mpv returns this when an option name is not registered in the build being
// talked to. It is the one negative result that can mean "this runtime was
// compiled without that feature" rather than "something went wrong".
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub const ERROR_OPTION_NOT_FOUND: c_int = -5;

pub const FORMAT_NONE: c_int = 0;
pub const FORMAT_STRING: c_int = 1;
pub const FORMAT_FLAG: c_int = 3;
pub const FORMAT_INT64: c_int = 4;
pub const FORMAT_DOUBLE: c_int = 5;
pub const FORMAT_NODE: c_int = 6;
pub const FORMAT_NODE_ARRAY: c_int = 7;
pub const FORMAT_NODE_MAP: c_int = 8;
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub const FORMAT_BYTE_ARRAY: c_int = 9;

pub const EVENT_NONE: c_int = 0;
pub const EVENT_SHUTDOWN: c_int = 1;
pub const EVENT_LOG_MESSAGE: c_int = 2;
pub const EVENT_SET_PROPERTY_REPLY: c_int = 4;
pub const EVENT_COMMAND_REPLY: c_int = 5;
pub const EVENT_START_FILE: c_int = 6;
pub const EVENT_END_FILE: c_int = 7;
pub const EVENT_FILE_LOADED: c_int = 8;
pub const EVENT_PLAYBACK_RESTART: c_int = 21;
pub const EVENT_PROPERTY_CHANGE: c_int = 22;

pub const END_FILE_REASON_EOF: c_int = 0;
pub const END_FILE_REASON_ERROR: c_int = 4;

#[repr(C)]
#[derive(Clone, Copy)]
pub union MpvNodeUnion {
    pub string: *mut c_char,
    pub flag: c_int,
    pub int64: i64,
    pub double_: c_double,
    pub list: *mut MpvNodeList,
    pub ba: *mut MpvByteArray,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MpvNode {
    pub u: MpvNodeUnion,
    pub format: c_int,
}

impl Default for MpvNode {
    fn default() -> Self {
        Self {
            u: MpvNodeUnion { int64: 0 },
            format: FORMAT_NONE,
        }
    }
}

#[repr(C)]
pub struct MpvNodeList {
    pub num: c_int,
    pub values: *mut MpvNode,
    pub keys: *mut *mut c_char,
}

#[repr(C)]
pub struct MpvByteArray {
    pub data: *mut c_void,
    pub size: usize,
}

#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventLogMessage {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

unsafe extern "C" {
    pub fn mpv_client_api_version() -> std::ffi::c_ulong;
    pub fn mpv_create() -> *mut MpvHandle;
    pub fn mpv_initialize(ctx: *mut MpvHandle) -> c_int;
    pub fn mpv_terminate_destroy(ctx: *mut MpvHandle);
    pub fn mpv_error_string(error: c_int) -> *const c_char;
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub fn mpv_free_node_contents(node: *mut MpvNode);
    pub fn mpv_set_option_string(
        ctx: *mut MpvHandle,
        name: *const c_char,
        value: *const c_char,
    ) -> c_int;
    pub fn mpv_command_string(ctx: *mut MpvHandle, command: *const c_char) -> c_int;
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub fn mpv_command_node(ctx: *mut MpvHandle, args: *mut MpvNode, result: *mut MpvNode)
    -> c_int;
    pub fn mpv_command_node_async(
        ctx: *mut MpvHandle,
        reply_userdata: u64,
        args: *mut MpvNode,
    ) -> c_int;
    pub fn mpv_set_property(
        ctx: *mut MpvHandle,
        name: *const c_char,
        format: c_int,
        data: *mut c_void,
    ) -> c_int;
    pub fn mpv_set_property_async(
        ctx: *mut MpvHandle,
        reply_userdata: u64,
        name: *const c_char,
        format: c_int,
        data: *mut c_void,
    ) -> c_int;
    pub fn mpv_observe_property(
        ctx: *mut MpvHandle,
        reply_userdata: u64,
        name: *const c_char,
        format: c_int,
    ) -> c_int;
    pub fn mpv_request_log_messages(ctx: *mut MpvHandle, min_level: *const c_char) -> c_int;
    pub fn mpv_wait_event(ctx: *mut MpvHandle, timeout: c_double) -> *mut MpvEvent;
    pub fn mpv_wakeup(ctx: *mut MpvHandle);
}
