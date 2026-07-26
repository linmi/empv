use std::collections::HashMap;

use napi::bindgen_prelude::{Buffer, Either, Null};
use napi_derive::napi;

#[cfg(target_os = "macos")]
use crate::presentation::macos;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::presentation::wid;
use crate::session::snapshot;

#[napi(object)]
pub struct JsSessionOptions {
    pub volume: Option<f64>,
}

#[napi(object)]
pub struct JsPlayback {
    pub stream_url: String,
    pub title: Option<String>,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub external_audio_path: Option<String>,
    pub subtitle_path: Option<String>,
    pub start_time: Option<f64>,
    pub disable_default_subtitles: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct JsBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: Option<f64>,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl From<JsBounds> for wid::Bounds {
    fn from(value: JsBounds) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

#[napi(object)]
pub struct JsAttachOptions {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: Option<f64>,
    pub z_order: String,
}

impl JsAttachOptions {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub fn bounds(&self) -> wid::Bounds {
        wid::Bounds {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn macos_bounds(&self) -> macos::Bounds {
        macos::Bounds {
            x: self.x,
            y: self.y,
            width: self.width.max(1.0),
            height: self.height.max(1.0),
            corner_radius: self.corner_radius.unwrap_or(0.0).max(0.0),
        }
    }
}

#[napi(object)]
pub struct JsRenderSize {
    pub width_pixels: i32,
    pub height_pixels: i32,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl From<wid::RenderSize> for JsRenderSize {
    fn from(value: wid::RenderSize) -> Self {
        Self {
            width_pixels: value.width_pixels,
            height_pixels: value.height_pixels,
        }
    }
}

#[cfg(target_os = "macos")]
impl From<macos::RenderSize> for JsRenderSize {
    fn from(value: macos::RenderSize) -> Self {
        Self {
            width_pixels: value.width_pixels,
            height_pixels: value.height_pixels,
        }
    }
}

#[napi(object)]
pub struct JsCapturedFrame {
    pub data: Buffer,
    pub width_pixels: u32,
    pub height_pixels: u32,
}

#[napi(object)]
pub struct JsTrack {
    pub id: i64,
    pub title: Option<String>,
    pub language: Option<String>,
    pub selected: bool,
    pub default_track: Option<bool>,
    pub forced: Option<bool>,
}

impl From<snapshot::Track> for JsTrack {
    fn from(value: snapshot::Track) -> Self {
        Self {
            id: value.id,
            title: value.title,
            language: value.language,
            selected: value.selected,
            default_track: Some(value.default_track),
            forced: Some(value.forced),
        }
    }
}

#[napi(object)]
pub struct JsRecordingState {
    pub active: bool,
    pub target_path: Option<String>,
    pub started_at: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct JsChapter {
    pub title: String,
    pub start_seconds: f64,
}

#[napi(object)]
pub struct JsAbLoop {
    pub a_seconds: Either<f64, Null>,
    pub b_seconds: Either<f64, Null>,
}

#[napi(object)]
pub struct JsVideoAdjustments {
    pub brightness: i32,
    pub contrast: i32,
    pub saturation: i32,
    pub gamma: i32,
}

#[napi(object)]
pub struct JsSessionSnapshot {
    pub status: String,
    pub position_seconds: f64,
    pub duration_seconds: Either<f64, Null>,
    pub volume: f64,
    pub stream_url: String,
    pub error: Option<String>,
    pub audio_tracks: Option<Vec<JsTrack>>,
    pub selected_audio_track_id: Either<i64, Null>,
    pub subtitle_tracks: Option<Vec<JsTrack>>,
    pub selected_subtitle_track_id: Either<i64, Null>,
    pub playback_speed: Option<f64>,
    pub aspect_override: Option<String>,
    pub recording: Option<JsRecordingState>,
    pub chapters: Option<Vec<JsChapter>>,
    pub ab_loop: Option<JsAbLoop>,
    pub video_adjustments: Option<JsVideoAdjustments>,
    pub hwdec_current: Option<String>,
    pub video_codec: Option<String>,
    pub container_fps: Either<f64, Null>,
    pub dropped_frame_count: Option<i64>,
    pub cache_duration_seconds: Either<f64, Null>,
    pub video_width: Either<i64, Null>,
    pub video_height: Either<i64, Null>,
    pub video_track_count: Either<i64, Null>,
    pub playlist_position: Either<i64, Null>,
    pub playlist_count: Option<i64>,
    pub playback_ready_generation: f64,
    pub audio_delay_seconds: Option<f64>,
    pub subtitle_delay_seconds: Option<f64>,
    pub video_rotation_degrees: Option<i32>,
    pub audio_pitch_correction: Option<bool>,
    pub loudness_normalization: Option<bool>,
    pub audio_visualization: Option<String>,
    pub loop_file: Option<bool>,
    pub selected_secondary_subtitle_track_id: Either<i64, Null>,
    pub video_zoom: Option<f64>,
    pub video_pan_x: Option<f64>,
    pub video_pan_y: Option<f64>,
    pub rendered_frame_count: Option<f64>,
    pub render_average_ms: Option<Either<f64, Null>>,
}

impl From<snapshot::SessionSnapshot> for JsSessionSnapshot {
    fn from(value: snapshot::SessionSnapshot) -> Self {
        Self {
            status: value.status.as_str().to_owned(),
            position_seconds: value.position_seconds,
            duration_seconds: explicit_null(value.duration_seconds),
            volume: value.volume_percent / 100.0,
            stream_url: value.stream_url,
            error: value.error,
            audio_tracks: Some(value.audio_tracks.into_iter().map(Into::into).collect()),
            selected_audio_track_id: explicit_null(value.selected_audio_track_id),
            subtitle_tracks: Some(value.subtitle_tracks.into_iter().map(Into::into).collect()),
            selected_subtitle_track_id: explicit_null(value.selected_subtitle_track_id),
            playback_speed: Some(value.playback_speed),
            aspect_override: Some(value.aspect_override),
            recording: (value.recording_active
                || value.recording_target_path.is_some()
                || value.recording_error.is_some())
            .then_some(JsRecordingState {
                active: value.recording_active,
                target_path: value.recording_target_path,
                started_at: value.recording_started_at,
                error: value.recording_error,
            }),
            chapters: Some(
                value
                    .chapters
                    .into_iter()
                    .map(|chapter| JsChapter {
                        title: chapter.title,
                        start_seconds: chapter.start_seconds,
                    })
                    .collect(),
            ),
            ab_loop: Some(JsAbLoop {
                a_seconds: explicit_null(value.ab_loop_a_seconds),
                b_seconds: explicit_null(value.ab_loop_b_seconds),
            }),
            video_adjustments: Some(JsVideoAdjustments {
                brightness: value.video_brightness,
                contrast: value.video_contrast,
                saturation: value.video_saturation,
                gamma: value.video_gamma,
            }),
            hwdec_current: Some(value.hwdec_current),
            video_codec: Some(value.video_codec),
            container_fps: explicit_null(value.container_fps),
            dropped_frame_count: Some(value.dropped_frame_count),
            cache_duration_seconds: explicit_null(value.cache_duration_seconds),
            video_width: explicit_null(value.video_width.filter(|_| value.video_height.is_some())),
            video_height: explicit_null(value.video_height.filter(|_| value.video_width.is_some())),
            video_track_count: explicit_null(value.video_track_count),
            playlist_position: explicit_null(value.playlist_position),
            playlist_count: Some(value.playlist_count),
            playback_ready_generation: value.playback_ready_generation as f64,
            audio_delay_seconds: Some(value.audio_delay_seconds),
            subtitle_delay_seconds: Some(value.subtitle_delay_seconds),
            video_rotation_degrees: Some(value.video_rotation_degrees),
            audio_pitch_correction: Some(value.audio_pitch_correction),
            loudness_normalization: Some(value.loudness_normalization),
            audio_visualization: Some(value.audio_visualization),
            loop_file: Some(value.loop_file),
            selected_secondary_subtitle_track_id: explicit_null(
                value.selected_secondary_subtitle_track_id,
            ),
            video_zoom: Some(value.video_zoom),
            video_pan_x: Some(value.video_pan_x),
            video_pan_y: Some(value.video_pan_y),
            rendered_frame_count: None,
            render_average_ms: None,
        }
    }
}

fn explicit_null<T>(value: Option<T>) -> Either<T, Null> {
    match value {
        Some(value) => Either::A(value),
        None => Either::B(Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::snapshot::SessionSnapshot;

    #[test]
    fn default_snapshot_distinguishes_explicit_null_from_omitted_fields() {
        let dto = JsSessionSnapshot::from(SessionSnapshot::default());
        assert!(matches!(dto.duration_seconds, Either::B(Null)));
        assert!(matches!(dto.selected_audio_track_id, Either::B(Null)));
        assert!(matches!(dto.video_width, Either::B(Null)));
        assert!(matches!(
            dto.ab_loop.as_ref().map(|loop_state| &loop_state.a_seconds),
            Some(Either::B(Null))
        ));
        assert!(dto.recording.is_none());
        assert!(dto.error.is_none());
    }

    #[test]
    fn video_dimensions_and_recording_appear_atomically() {
        let partial = SessionSnapshot {
            video_width: Some(1920),
            recording_started_at: Some("started".to_owned()),
            ..SessionSnapshot::default()
        };
        let dto = JsSessionSnapshot::from(partial);
        assert!(matches!(dto.video_width, Either::B(Null)));
        assert!(matches!(dto.video_height, Either::B(Null)));
        assert!(dto.recording.is_none());

        let complete = SessionSnapshot {
            video_width: Some(1920),
            video_height: Some(1080),
            recording_active: true,
            ..SessionSnapshot::default()
        };
        let dto = JsSessionSnapshot::from(complete);
        assert!(matches!(dto.video_width, Either::A(1920)));
        assert!(matches!(dto.video_height, Either::A(1080)));
        assert!(dto.recording.is_some());
    }
}
