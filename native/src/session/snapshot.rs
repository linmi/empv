use std::ffi::{CStr, c_void};

use crate::mpv::{ffi, node};
use crate::playback::state::{PlaybackStateReducer, SessionStatus};

#[derive(Clone, Debug)]
pub struct Track {
    pub id: i64,
    pub title: Option<String>,
    pub language: Option<String>,
    pub selected: bool,
    pub default_track: bool,
    pub forced: bool,
}

#[derive(Clone, Debug)]
pub struct Chapter {
    pub title: String,
    pub start_seconds: f64,
}

#[derive(Clone, Debug)]
pub struct SessionSnapshot {
    pub status: SessionStatus,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub volume_percent: f64,
    pub stream_url: String,
    pub error: Option<String>,
    pub audio_tracks: Vec<Track>,
    pub selected_audio_track_id: Option<i64>,
    pub subtitle_tracks: Vec<Track>,
    pub selected_subtitle_track_id: Option<i64>,
    pub playback_speed: f64,
    pub aspect_override: String,
    pub recording_active: bool,
    pub recording_target_path: Option<String>,
    pub recording_started_at: Option<String>,
    pub recording_error: Option<String>,
    pub chapters: Vec<Chapter>,
    pub ab_loop_a_seconds: Option<f64>,
    pub ab_loop_b_seconds: Option<f64>,
    pub video_brightness: i32,
    pub video_contrast: i32,
    pub video_saturation: i32,
    pub video_gamma: i32,
    pub hwdec_current: String,
    pub video_codec: String,
    pub container_fps: Option<f64>,
    pub dropped_frame_count: i64,
    pub cache_duration_seconds: Option<f64>,
    pub video_width: Option<i64>,
    pub video_height: Option<i64>,
    pub video_track_count: Option<i64>,
    pub playlist_position: Option<i64>,
    pub playlist_count: i64,
    pub playback_ready_generation: u64,
    pub audio_delay_seconds: f64,
    pub subtitle_delay_seconds: f64,
    pub video_rotation_degrees: i32,
    pub audio_pitch_correction: bool,
    pub loudness_normalization: bool,
    pub audio_visualization: String,
    pub loop_file: bool,
    pub selected_secondary_subtitle_track_id: Option<i64>,
    pub video_zoom: f64,
    pub video_pan_x: f64,
    pub video_pan_y: f64,
}

impl Default for SessionSnapshot {
    fn default() -> Self {
        Self {
            status: SessionStatus::Idle,
            position_seconds: 0.0,
            duration_seconds: None,
            volume_percent: 100.0,
            stream_url: String::new(),
            error: None,
            audio_tracks: Vec::new(),
            selected_audio_track_id: None,
            subtitle_tracks: Vec::new(),
            selected_subtitle_track_id: None,
            playback_speed: 1.0,
            aspect_override: "no".to_owned(),
            recording_active: false,
            recording_target_path: None,
            recording_started_at: None,
            recording_error: None,
            chapters: Vec::new(),
            ab_loop_a_seconds: None,
            ab_loop_b_seconds: None,
            video_brightness: 0,
            video_contrast: 0,
            video_saturation: 0,
            video_gamma: 0,
            hwdec_current: String::new(),
            video_codec: String::new(),
            container_fps: None,
            dropped_frame_count: 0,
            cache_duration_seconds: None,
            video_width: None,
            video_height: None,
            video_track_count: None,
            playlist_position: None,
            playlist_count: 0,
            playback_ready_generation: 0,
            audio_delay_seconds: 0.0,
            subtitle_delay_seconds: 0.0,
            video_rotation_degrees: 0,
            audio_pitch_correction: true,
            loudness_normalization: false,
            audio_visualization: "none".to_owned(),
            loop_file: false,
            selected_secondary_subtitle_track_id: None,
            video_zoom: 0.0,
            video_pan_x: 0.0,
            video_pan_y: 0.0,
        }
    }
}

impl SessionSnapshot {
    pub fn reset_for_start_file(
        &mut self,
        reducer: &mut PlaybackStateReducer,
        _content_generation: u64,
    ) {
        reducer.begin_loading(&mut self.status);
        self.error = None;
        self.audio_tracks.clear();
        self.subtitle_tracks.clear();
        self.selected_audio_track_id = None;
        self.selected_subtitle_track_id = None;
        self.video_track_count = None;
    }

    /// Applies one of the 32 properties observed by the native contract.
    ///
    /// # Safety
    /// `data` must have the representation described by `format` and remain
    /// valid for this call, as guaranteed by libmpv until the next wait call.
    pub unsafe fn reduce_property(
        &mut self,
        reducer: &mut PlaybackStateReducer,
        name: &str,
        format: i32,
        data: *mut c_void,
    ) -> PropertyChange {
        if data.is_null() {
            return PropertyChange::default();
        }
        let important = !matches!(
            name,
            "time-pos" | "frame-drop-count" | "demuxer-cache-duration"
        );
        let changed = match (name, format) {
            ("time-pos", ffi::FORMAT_DOUBLE) => {
                self.position_seconds = unsafe { *data.cast::<f64>() };
                reducer.observe_position(
                    &mut self.status,
                    self.position_seconds,
                    self.duration_seconds,
                );
                true
            }
            ("duration", ffi::FORMAT_DOUBLE) => {
                self.duration_seconds = Some(unsafe { *data.cast::<f64>() });
                true
            }
            ("pause", ffi::FORMAT_FLAG) => {
                reducer.set_paused(&mut self.status, (unsafe { *data.cast::<i32>() }) != 0);
                true
            }
            ("volume", ffi::FORMAT_DOUBLE) => {
                self.volume_percent = unsafe { *data.cast::<f64>() };
                true
            }
            ("path", ffi::FORMAT_STRING) => {
                self.stream_url = unsafe { indirect_string(data) };
                true
            }
            ("track-list", ffi::FORMAT_NODE) => {
                let value = unsafe { &*data.cast::<ffi::MpvNode>() };
                self.audio_tracks = node::tracks(value, "audio");
                self.subtitle_tracks = node::tracks(value, "sub");
                self.selected_audio_track_id = self
                    .audio_tracks
                    .iter()
                    .find(|track| track.selected)
                    .map(|track| track.id);
                self.selected_subtitle_track_id = self
                    .subtitle_tracks
                    .iter()
                    .find(|track| track.selected)
                    .map(|track| track.id);
                self.video_track_count = Some(node::count_tracks(value, "video"));
                true
            }
            ("aid", ffi::FORMAT_STRING) => {
                let parsed = unsafe { indirect_string(data) }
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id >= 0);
                if parsed.is_some() {
                    self.selected_audio_track_id = parsed;
                    update_selected(&mut self.audio_tracks, self.selected_audio_track_id);
                }
                true
            }
            ("sid", ffi::FORMAT_STRING) => {
                self.selected_subtitle_track_id = unsafe { indirect_string(data) }
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id >= 0);
                update_selected(&mut self.subtitle_tracks, self.selected_subtitle_track_id);
                true
            }
            ("speed", ffi::FORMAT_DOUBLE) => {
                self.playback_speed = unsafe { *data.cast::<f64>() };
                true
            }
            ("video-aspect-override", ffi::FORMAT_STRING) => {
                let aspect = unsafe { indirect_string(data) };
                self.aspect_override = if aspect.is_empty() {
                    "no".to_owned()
                } else {
                    aspect
                };
                true
            }
            ("ab-loop-a", ffi::FORMAT_NODE) => {
                self.ab_loop_a_seconds = node::node_f64(unsafe { &*data.cast::<ffi::MpvNode>() });
                true
            }
            ("ab-loop-b", ffi::FORMAT_NODE) => {
                self.ab_loop_b_seconds = node::node_f64(unsafe { &*data.cast::<ffi::MpvNode>() });
                true
            }
            ("chapter-list", ffi::FORMAT_NODE) => {
                self.chapters = node::chapters(unsafe { &*data.cast::<ffi::MpvNode>() });
                true
            }
            ("hwdec-current", ffi::FORMAT_STRING) => {
                self.hwdec_current = unsafe { indirect_string(data) };
                true
            }
            ("video-codec", ffi::FORMAT_STRING) => {
                self.video_codec = unsafe { indirect_string(data) };
                true
            }
            ("container-fps", ffi::FORMAT_DOUBLE) => {
                self.container_fps = Some(unsafe { *data.cast::<f64>() });
                true
            }
            ("frame-drop-count", ffi::FORMAT_INT64) => {
                self.dropped_frame_count = unsafe { *data.cast::<i64>() };
                true
            }
            ("demuxer-cache-duration", ffi::FORMAT_DOUBLE) => {
                self.cache_duration_seconds = Some(unsafe { *data.cast::<f64>() });
                true
            }
            ("dwidth", ffi::FORMAT_INT64) => {
                self.video_width = positive(unsafe { *data.cast::<i64>() });
                true
            }
            ("dheight", ffi::FORMAT_INT64) => {
                self.video_height = positive(unsafe { *data.cast::<i64>() });
                true
            }
            ("playlist-pos", ffi::FORMAT_INT64) => {
                self.playlist_position = non_negative(unsafe { *data.cast::<i64>() });
                true
            }
            ("playlist-count", ffi::FORMAT_INT64) => {
                self.playlist_count = unsafe { *data.cast::<i64>() };
                true
            }
            ("audio-delay", ffi::FORMAT_DOUBLE) => {
                self.audio_delay_seconds = unsafe { *data.cast::<f64>() };
                true
            }
            ("sub-delay", ffi::FORMAT_DOUBLE) => {
                self.subtitle_delay_seconds = unsafe { *data.cast::<f64>() };
                true
            }
            ("video-rotate", ffi::FORMAT_INT64) => {
                self.video_rotation_degrees = (unsafe { *data.cast::<i64>() }) as i32;
                true
            }
            ("audio-pitch-correction", ffi::FORMAT_FLAG) => {
                self.audio_pitch_correction = (unsafe { *data.cast::<i32>() }) != 0;
                true
            }
            ("loop-file", ffi::FORMAT_STRING) => {
                self.loop_file = matches!(
                    unsafe { indirect_string(data) }
                        .to_ascii_lowercase()
                        .as_str(),
                    "inf" | "force"
                );
                true
            }
            ("secondary-sid", ffi::FORMAT_STRING) => {
                self.selected_secondary_subtitle_track_id = unsafe { indirect_string(data) }
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id >= 0);
                true
            }
            ("video-zoom", ffi::FORMAT_DOUBLE) => {
                self.video_zoom = unsafe { *data.cast::<f64>() };
                true
            }
            ("video-pan-x", ffi::FORMAT_DOUBLE) => {
                self.video_pan_x = unsafe { *data.cast::<f64>() };
                true
            }
            ("video-pan-y", ffi::FORMAT_DOUBLE) => {
                self.video_pan_y = unsafe { *data.cast::<f64>() };
                true
            }
            ("eof-reached", ffi::FORMAT_FLAG) => {
                reducer.set_eof_reached(
                    &mut self.status,
                    (unsafe { *data.cast::<i32>() }) != 0,
                    self.position_seconds,
                    self.duration_seconds,
                );
                true
            }
            _ => false,
        };
        PropertyChange {
            changed,
            important: changed && important,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PropertyChange {
    pub changed: bool,
    pub important: bool,
}

fn update_selected(tracks: &mut [Track], selected_id: Option<i64>) {
    for track in tracks {
        track.selected = Some(track.id) == selected_id;
    }
}

fn positive(value: i64) -> Option<i64> {
    (value > 0).then_some(value)
}

fn non_negative(value: i64) -> Option<i64> {
    (value >= 0).then_some(value)
}

unsafe fn indirect_string(data: *mut c_void) -> String {
    let pointer = unsafe { *data.cast::<*const std::ffi::c_char>() };
    if pointer.is_null() {
        String::new()
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
    fn default_snapshot_matches_public_contract() {
        let snapshot = SessionSnapshot::default();
        assert_eq!(snapshot.status, SessionStatus::Idle);
        assert_eq!(snapshot.volume_percent, 100.0);
        assert_eq!(snapshot.playback_speed, 1.0);
        assert_eq!(snapshot.aspect_override, "no");
        assert_eq!(snapshot.audio_visualization, "none");
        assert!(snapshot.duration_seconds.is_none());
        assert!(snapshot.playlist_position.is_none());
        assert!(snapshot.video_track_count.is_none());
    }

    #[test]
    fn all_32_properties_are_declared_once() {
        assert_eq!(OBSERVED_PROPERTIES.len(), 32);
        for (expected, property) in (1_u64..=32).zip(OBSERVED_PROPERTIES) {
            assert_eq!(expected, property.0);
        }
    }
}

pub const OBSERVED_PROPERTIES: [(u64, &str, i32); 32] = [
    (1, "time-pos", ffi::FORMAT_DOUBLE),
    (2, "duration", ffi::FORMAT_DOUBLE),
    (3, "pause", ffi::FORMAT_FLAG),
    (4, "volume", ffi::FORMAT_DOUBLE),
    (5, "path", ffi::FORMAT_STRING),
    (6, "track-list", ffi::FORMAT_NODE),
    (7, "aid", ffi::FORMAT_STRING),
    (8, "sid", ffi::FORMAT_STRING),
    (9, "speed", ffi::FORMAT_DOUBLE),
    (10, "video-aspect-override", ffi::FORMAT_STRING),
    (11, "ab-loop-a", ffi::FORMAT_NODE),
    (12, "ab-loop-b", ffi::FORMAT_NODE),
    (13, "chapter-list", ffi::FORMAT_NODE),
    (14, "hwdec-current", ffi::FORMAT_STRING),
    (15, "video-codec", ffi::FORMAT_STRING),
    (16, "container-fps", ffi::FORMAT_DOUBLE),
    (17, "frame-drop-count", ffi::FORMAT_INT64),
    (18, "demuxer-cache-duration", ffi::FORMAT_DOUBLE),
    (19, "dwidth", ffi::FORMAT_INT64),
    (20, "dheight", ffi::FORMAT_INT64),
    (21, "playlist-pos", ffi::FORMAT_INT64),
    (22, "playlist-count", ffi::FORMAT_INT64),
    (23, "audio-delay", ffi::FORMAT_DOUBLE),
    (24, "sub-delay", ffi::FORMAT_DOUBLE),
    (25, "video-rotate", ffi::FORMAT_INT64),
    (26, "audio-pitch-correction", ffi::FORMAT_FLAG),
    (27, "loop-file", ffi::FORMAT_STRING),
    (28, "secondary-sid", ffi::FORMAT_STRING),
    (29, "video-zoom", ffi::FORMAT_DOUBLE),
    (30, "video-pan-x", ffi::FORMAT_DOUBLE),
    (31, "video-pan-y", ffi::FORMAT_DOUBLE),
    (32, "eof-reached", ffi::FORMAT_FLAG),
];
