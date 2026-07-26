use std::ffi::CStr;

use super::ffi;

pub enum Event<'a> {
    None,
    Shutdown,
    StartFile,
    EndFile(Option<&'a ffi::MpvEventEndFile>),
    FileLoaded,
    PlaybackRestart,
    Property(Option<&'a ffi::MpvEventProperty>),
    Log(Option<&'a ffi::MpvEventLogMessage>),
    Reply { request_id: u64, error: i32 },
    Other,
}

pub fn read_event<'a>(event: *const ffi::MpvEvent) -> Event<'a> {
    let Some(event) = (unsafe { event.as_ref() }) else {
        return Event::None;
    };
    match event.event_id {
        ffi::EVENT_NONE => Event::None,
        ffi::EVENT_SHUTDOWN => Event::Shutdown,
        ffi::EVENT_START_FILE => Event::StartFile,
        ffi::EVENT_END_FILE => {
            Event::EndFile(unsafe { event.data.cast::<ffi::MpvEventEndFile>().as_ref() })
        }
        ffi::EVENT_FILE_LOADED => Event::FileLoaded,
        ffi::EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
        ffi::EVENT_PROPERTY_CHANGE => {
            Event::Property(unsafe { event.data.cast::<ffi::MpvEventProperty>().as_ref() })
        }
        ffi::EVENT_LOG_MESSAGE => {
            Event::Log(unsafe { event.data.cast::<ffi::MpvEventLogMessage>().as_ref() })
        }
        ffi::EVENT_COMMAND_REPLY | ffi::EVENT_SET_PROPERTY_REPLY => Event::Reply {
            request_id: event.reply_userdata,
            error: event.error,
        },
        _ => Event::Other,
    }
}

pub fn c_string(pointer: *const std::ffi::c_char) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}
