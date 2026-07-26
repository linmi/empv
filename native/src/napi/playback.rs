use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use napi::{Env, Error, Result};
use napi_derive::napi;

use crate::mpv::node::{command_strings_async, loadfile_async};
use crate::playback::commands;
use crate::playback::playlist_sync::{PlaylistOp, PlaylistSyncError, reconcile_playlist};
use crate::session::recording::{RecordingStart, RecordingStop};
use crate::session::registry::{self, Session, SessionState};

use super::dto::JsPlayback;

fn error(reason: String) -> Error {
    Error::from_reason(reason)
}

fn session(id: &str) -> Result<Arc<Session>> {
    registry::get_session(id).map_err(error)
}

fn lock_state<T>(session: &Session, update: impl FnOnce(&mut SessionState) -> T) -> Result<T> {
    session
        .state
        .lock()
        .map(|mut state| update(&mut state))
        .map_err(|_| error("Embedded MPV session lock was poisoned.".to_owned()))
}

fn labeled_id(session: &Session, label: impl Into<String>) -> Result<u64> {
    registry::register_async_label(session, label).map_err(error)
}

fn issue_labeled(
    session: &Session,
    label: impl Into<String>,
    issue: impl FnOnce(u64) -> std::result::Result<(), String>,
) -> Result<()> {
    let request_id = labeled_id(session, label)?;
    let result = issue(request_id);
    if result.is_err() {
        registry::forget_async_label(session, request_id);
    }
    result.map_err(error)
}

#[napi(js_name = "loadPlayback")]
pub fn load_playback(session_id: String, playback: JsPlayback) -> Result<()> {
    if playback.stream_url.is_empty() {
        return Err(error(
            "Embedded MPV playback requires a stream URL.".to_owned(),
        ));
    }
    let session = session(&session_id)?;
    let recording_active = lock_state(&session, |state| state.snapshot.recording_active)?;
    if recording_active {
        let id = labeled_id(&session, "set stream-record= (stop before load)")?;
        let started_at = lock_state(&session, |state| {
            state.snapshot.recording_started_at.clone()
        })?;
        lock_state(&session, |state| {
            state.pending.recording_stop = Some(RecordingStop {
                request_id: id,
                started_at,
            });
        })?;
        if let Err(reason) = session.handle.set_string_async(
            id,
            "stream-record",
            "",
            "stop recording before loading playback",
        ) {
            registry::forget_async_label(&session, id);
            let detail = mpv_error_detail(&reason, "stop recording before loading playback");
            lock_state(&session, |state| {
                state.pending.recording_stop = None;
                state.playback.fail(&mut state.snapshot.status);
                state.snapshot.error = Some(detail);
            })?;
            return Err(error(reason));
        }
    }

    let stream_url = playback.stream_url;
    lock_state(&session, |state| {
        state.snapshot.stream_url = stream_url.clone();
        state.snapshot.error = None;
        state.playback.begin_loading(&mut state.snapshot.status);
        state.snapshot.recording_active = false;
        state.snapshot.recording_target_path = None;
        state.snapshot.recording_started_at = None;
        state.snapshot.recording_error = None;
    })?;
    let mut options = Vec::new();
    push_option(&mut options, "force-media-title", playback.title);
    push_option(&mut options, "user-agent", playback.user_agent);
    push_option(&mut options, "referrer", playback.referer);
    if let Some(start) = playback
        .start_time
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        options.push(("start".to_owned(), start.to_string()));
    }
    push_option(&mut options, "audio-file", playback.external_audio_path);
    let disable_subtitles = playback.disable_default_subtitles.unwrap_or(true);
    if disable_subtitles {
        options.push(("sub-auto".to_owned(), "no".to_owned()));
    }
    if let Some(path) = playback.subtitle_path.filter(|value| !value.is_empty()) {
        options.push(("sub-file".to_owned(), path));
    } else if disable_subtitles {
        options.push(("sid".to_owned(), "no".to_owned()));
    }
    if let Some(headers) = playback.headers {
        let joined = headers
            .into_iter()
            .filter(|(key, value)| !key.is_empty() && !value.is_empty())
            .map(|(key, value)| format!("{key}: {value}"))
            .collect::<Vec<_>>()
            .join(",");
        if !joined.is_empty() {
            options.push(("http-header-fields".to_owned(), joined));
        }
    }
    if let Err(failure) = issue_labeled(
        &session,
        format!("loadfile replace {stream_url}"),
        |request_id| {
            loadfile_async(
                &session.handle,
                request_id,
                &stream_url,
                "replace",
                &options,
                "load playback",
            )
        },
    ) {
        let reason = failure.reason;
        let detail = mpv_error_detail(&reason, "load playback");
        lock_state(&session, |state| {
            state.playback.fail(&mut state.snapshot.status);
            state.snapshot.error = Some(detail);
        })?;
        return Err(error(reason));
    }
    // A replacing loadfile resets the playlist to this single entry, so it is
    // also the queue playlist_sync reconciles from.
    lock_state(&session, |state| {
        state.playlist_paths = vec![stream_url];
    })?;
    Ok(())
}

fn push_option(options: &mut Vec<(String, String)>, name: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        options.push((name.to_owned(), value));
    }
}

#[napi(js_name = "setPaused")]
pub fn set_paused(session_id: String, paused: bool) -> Result<()> {
    let session = session(&session_id)?;
    issue_labeled(
        &session,
        format!("set pause={}", if paused { "yes" } else { "no" }),
        |request_id| {
            session
                .handle
                .set_flag_async(request_id, "pause", paused, "update playback state")
        },
    )?;
    lock_state(&session, |state| {
        state
            .playback
            .set_paused(&mut state.snapshot.status, paused);
    })
}

#[napi(js_name = "setPlaylistAutoAdvance")]
pub fn set_playlist_auto_advance(session_id: String, auto_advance: bool) -> Result<()> {
    session(&session_id)?
        .handle
        .set_string(
            "keep-open",
            if auto_advance { "yes" } else { "always" },
            "update playlist auto-advance",
        )
        .map_err(error)
}

#[napi]
pub fn seek(session_id: String, seconds: f64) -> Result<()> {
    let session = session(&session_id)?;
    issue_labeled(&session, format!("seek {seconds}"), |request_id| {
        command_strings_async(
            &session.handle,
            request_id,
            &["seek", &seconds.to_string(), "absolute+exact"],
            "seek playback",
        )
    })?;
    lock_state(&session, |state| {
        state.snapshot.position_seconds = seconds.max(0.0);
    })
}

#[napi]
pub fn replay(session_id: String) -> Result<()> {
    let session = session(&session_id)?;
    commands::replay(&session.handle).map_err(error)?;
    lock_state(&session, |state| {
        state.playback.set_paused(&mut state.snapshot.status, false);
        state.snapshot.position_seconds = 0.0;
    })
}

#[napi(js_name = "setVolume")]
pub fn set_volume(session_id: String, volume: f64) -> Result<()> {
    let session = session(&session_id)?;
    let percent = if volume.is_finite() {
        (volume * 100.0).clamp(0.0, 100.0)
    } else {
        100.0
    };
    issue_labeled(&session, format!("set volume={percent}"), |request_id| {
        session
            .handle
            .set_double_async(request_id, "volume", percent, "update volume")
    })?;
    lock_state(&session, |state| state.snapshot.volume_percent = percent)
}

#[napi(js_name = "setAudioTrack")]
pub fn set_audio_track(session_id: String, track_id: i64) -> Result<()> {
    let session = session(&session_id)?;
    issue_labeled(&session, format!("set aid={track_id}"), |request_id| {
        session
            .handle
            .set_i64_async(request_id, "aid", track_id, "update audio track")
    })?;
    lock_state(&session, |state| {
        state.snapshot.selected_audio_track_id = (track_id >= 0).then_some(track_id);
        for track in &mut state.snapshot.audio_tracks {
            track.selected = track.id == track_id;
        }
    })
}

#[napi(js_name = "setSubtitleTrack")]
pub fn set_subtitle_track(session_id: String, track_id: i64) -> Result<()> {
    set_track(
        &session_id,
        "sid",
        track_id,
        "update subtitle track",
        |state| {
            state.snapshot.selected_subtitle_track_id = (track_id >= 0).then_some(track_id);
            for track in &mut state.snapshot.subtitle_tracks {
                track.selected = track.id == track_id;
            }
        },
    )
}

fn set_track(
    session_id: &str,
    property: &str,
    track_id: i64,
    action: &str,
    update: impl FnOnce(&mut SessionState),
) -> Result<()> {
    let session = session(session_id)?;
    if track_id < 0 {
        issue_labeled(&session, format!("set {property}=no"), |request_id| {
            session
                .handle
                .set_string_async(request_id, property, "no", action)
        })?;
    } else {
        issue_labeled(
            &session,
            format!("set {property}={track_id}"),
            |request_id| {
                session
                    .handle
                    .set_i64_async(request_id, property, track_id, action)
            },
        )?;
    }
    lock_state(&session, update)
}

#[napi(js_name = "setSpeed")]
pub fn set_speed(session_id: String, speed: f64) -> Result<()> {
    let session = session(&session_id)?;
    let speed = speed.clamp(0.25, 5.0);
    issue_labeled(&session, format!("set speed={speed}"), |request_id| {
        session
            .handle
            .set_double_async(request_id, "speed", speed, "update playback speed")
    })?;
    lock_state(&session, |state| state.snapshot.playback_speed = speed)
}

#[napi(js_name = "setAspect")]
pub fn set_aspect(session_id: String, aspect: String) -> Result<()> {
    let session = session(&session_id)?;
    let aspect = if aspect.is_empty() {
        "no".to_owned()
    } else {
        aspect
    };
    issue_labeled(
        &session,
        format!("set video-aspect-override={aspect}"),
        |request_id| {
            session.handle.set_string_async(
                request_id,
                "video-aspect-override",
                &aspect,
                "update aspect override",
            )
        },
    )?;
    lock_state(&session, |state| state.snapshot.aspect_override = aspect)
}

#[napi(js_name = "setAbLoop")]
pub fn set_ab_loop(
    session_id: String,
    a_seconds: Option<f64>,
    b_seconds: Option<f64>,
) -> Result<()> {
    let session = session(&session_id)?;
    set_optional_double(&session, "ab-loop-a", a_seconds)?;
    set_optional_double(&session, "ab-loop-b", b_seconds)?;
    lock_state(&session, |state| {
        state.snapshot.ab_loop_a_seconds = a_seconds;
        state.snapshot.ab_loop_b_seconds = b_seconds;
    })
}

fn set_optional_double(session: &Session, property: &str, value: Option<f64>) -> Result<()> {
    let label = format!(
        "set {property}={}",
        value.map_or_else(|| "no".to_owned(), |seconds| seconds.to_string())
    );
    issue_labeled(session, label.clone(), |request_id| match value {
        Some(value) => session
            .handle
            .set_double_async(request_id, property, value, &label),
        None => session
            .handle
            .set_string_async(request_id, property, "no", &label),
    })
}

#[napi(js_name = "setVideoAdjustments")]
pub fn set_video_adjustments(
    session_id: String,
    brightness: i32,
    contrast: i32,
    saturation: i32,
    gamma: i32,
) -> Result<()> {
    let session = session(&session_id)?;
    let values = [
        ("brightness", brightness.clamp(-100, 100)),
        ("contrast", contrast.clamp(-100, 100)),
        ("saturation", saturation.clamp(-100, 100)),
        ("gamma", gamma.clamp(-100, 100)),
    ];
    for (name, value) in values {
        let label = format!("set {name}={value}");
        issue_labeled(&session, label.clone(), |request_id| {
            session
                .handle
                .set_i64_async(request_id, name, i64::from(value), &label)
        })?;
    }
    lock_state(&session, |state| {
        state.snapshot.video_brightness = values[0].1;
        state.snapshot.video_contrast = values[1].1;
        state.snapshot.video_saturation = values[2].1;
        state.snapshot.video_gamma = values[3].1;
    })
}

#[napi(js_name = "reloadSubtitle")]
pub fn reload_subtitle(session_id: String, subtitle_path: Option<String>) -> Result<()> {
    let session = session(&session_id)?;
    let remove_id = labeled_id(&session, "sub-remove")?;
    lock_state(&session, |state| {
        state.pending.ignored.insert(remove_id);
    })?;
    if let Err(reason) = command_strings_async(
        &session.handle,
        remove_id,
        &["sub-remove"],
        "remove subtitle",
    ) {
        lock_state(&session, |state| {
            state.pending.ignored.remove(&remove_id);
        })?;
        registry::forget_async_label(&session, remove_id);
        return Err(error(reason));
    }
    if let Some(path) = subtitle_path.filter(|path| !path.is_empty()) {
        issue_labeled(&session, format!("sub-add {path}"), |request_id| {
            command_strings_async(
                &session.handle,
                request_id,
                &["sub-add", &path, "select"],
                "add subtitle",
            )
        })?;
    }
    Ok(())
}

#[napi(object)]
pub struct JsPlaylistEntry {
    pub media_path: String,
    pub title: Option<String>,
}

/// Reconciles the live playlist tail to `entries`, in order, without
/// interrupting the entry that is playing.
///
/// `entries` is the queue AFTER the session's own loaded source, which stays
/// entry 0. The caller passes only the tail on purpose: the path it holds for
/// entry 0 is not guaranteed to reach mpv byte-for-byte, and a mismatch would
/// read here as a request to replace the entry that is playing.
///
/// The caller owns the queue and it changes over a session's life (members
/// resolve after creation, a download completes, the collection is edited), so
/// the native playlist has to track it continuously. Appending once at creation
/// left the queue permanently short whenever the tail arrived later, and every
/// jump into a missing index was then rejected with nothing to show for it.
#[napi(js_name = "playlistSync")]
pub fn playlist_sync(session_id: String, entries: Vec<JsPlaylistEntry>) -> Result<()> {
    if entries.iter().any(|entry| entry.media_path.is_empty()) {
        return Err(error(
            "Every playlist entry requires a media path.".to_owned(),
        ));
    }
    let session = session(&session_id)?;
    let (current, position) = lock_state(&session, |state| {
        (
            state.playlist_paths.clone(),
            state.snapshot.playlist_position,
        )
    })?;
    // Entry 0 is whatever load_playback actually handed mpv; the tail is the
    // caller's. A session whose source has not loaded yet has no entry 0 to keep.
    let desired: Vec<String> = current
        .first()
        .cloned()
        .into_iter()
        .chain(entries.iter().map(|entry| entry.media_path.clone()))
        .collect();

    let ops = reconcile_playlist(&current, position, &desired).map_err(|failure| match failure {
        PlaylistSyncError::CurrentEntryNotInDesired { path } => error(format!(
            "Playlist sync would drop the entry that is playing ({path}). The desired queue must keep it."
        )),
    })?;

    // Every op is issued on mpv's async command queue, including the appends, so
    // they execute in the order computed. A synchronous playlist-remove would be
    // free to run ahead of an already-queued loadfile and rebuild the queue in
    // the wrong order.
    for op in &ops {
        match op {
            PlaylistOp::Remove(index) => {
                let index = index.to_string();
                issue_labeled(&session, format!("playlist-remove {index}"), |request_id| {
                    command_strings_async(
                        &session.handle,
                        request_id,
                        &["playlist-remove", &index],
                        "remove playlist entry",
                    )
                })?;
            }
            PlaylistOp::Append(media_path) => {
                let mut options = Vec::new();
                let title = entries
                    .iter()
                    .find(|entry| entry.media_path == *media_path)
                    .and_then(|entry| entry.title.clone());
                push_option(&mut options, "force-media-title", title);
                issue_labeled(
                    &session,
                    format!("loadfile append {media_path}"),
                    |request_id| {
                        loadfile_async(
                            &session.handle,
                            request_id,
                            media_path,
                            "append",
                            &options,
                            "append playlist entry",
                        )
                    },
                )?;
            }
            PlaylistOp::Move { from, to } => {
                let from = from.to_string();
                let to = to.to_string();
                issue_labeled(
                    &session,
                    format!("playlist-move {from} {to}"),
                    |request_id| {
                        command_strings_async(
                            &session.handle,
                            request_id,
                            &["playlist-move", &from, &to],
                            "move playlist entry",
                        )
                    },
                )?;
            }
        }
    }

    lock_state(&session, |state| {
        state.playlist_paths = desired;
    })
}

#[napi(js_name = "playlistPlayIndex")]
pub fn playlist_play_index(env: Env, session_id: String, index: i64) -> Result<()> {
    let session = session(&session_id)?;
    let count = lock_state(&session, |state| state.snapshot.playlist_count)?;
    if !commands::playlist_index_in_range(index, count) {
        env.throw_range_error(
            &format!("Playlist index {index} is outside the live playlist of {count} entries."),
            None,
        )?;
        return Ok(());
    }
    commands::play_playlist_index(&session.handle, index).map_err(error)?;
    lock_state(&session, |state| {
        state.playback.set_paused(&mut state.snapshot.status, false);
    })
}

#[napi(js_name = "playlistLocateIndex")]
pub fn playlist_locate_index(env: Env, session_id: String, index: i64) -> Result<()> {
    let session = session(&session_id)?;
    let count = lock_state(&session, |state| state.snapshot.playlist_count)?;
    if !commands::playlist_index_in_range(index, count) {
        env.throw_range_error(
            &format!("Playlist index {index} is outside the live playlist of {count} entries."),
            None,
        )?;
        return Ok(());
    }
    // Locate switches the active entry WITHOUT touching pause: unlike
    // playlist_play_index, it neither clears pause on the handle nor rewrites the
    // snapshot status. The observed playlist-pos change flows in from mpv, while
    // pause/ended is left exactly as the caller had it — a session stopped on a
    // poster stays stopped on the target entry's poster.
    commands::locate_playlist_index(&session.handle, index).map_err(error)
}

macro_rules! double_control {
    ($rust_name:ident, $js_name:literal, $property:literal, $field:ident, $action:literal) => {
        #[napi(js_name = $js_name)]
        pub fn $rust_name(session_id: String, seconds: f64) -> Result<()> {
            if !seconds.is_finite() {
                return Err(error(
                    concat!($action, " must be a finite number.").to_owned(),
                ));
            }
            let session = session(&session_id)?;
            issue_labeled(
                &session,
                format!("set {}={seconds}", $property),
                |request_id| {
                    session.handle.set_double_async(
                        request_id,
                        $property,
                        seconds,
                        concat!("set ", $action),
                    )
                },
            )?;
            lock_state(&session, |state| state.snapshot.$field = seconds)
        }
    };
}

double_control!(
    set_audio_delay,
    "setAudioDelay",
    "audio-delay",
    audio_delay_seconds,
    "Audio delay"
);
double_control!(
    set_subtitle_delay,
    "setSubtitleDelay",
    "sub-delay",
    subtitle_delay_seconds,
    "Subtitle delay"
);
double_control!(
    set_video_zoom,
    "setVideoZoom",
    "video-zoom",
    video_zoom,
    "Video zoom"
);

#[napi(js_name = "setVideoRotation")]
pub fn set_video_rotation(session_id: String, degrees: i32) -> Result<()> {
    let normalized = degrees.rem_euclid(360);
    if !matches!(normalized, 0 | 90 | 180 | 270) {
        return Err(error(
            "Video rotation must be 0, 90, 180, or 270 degrees.".to_owned(),
        ));
    }
    let session = session(&session_id)?;
    issue_labeled(
        &session,
        format!("set video-rotate={normalized}"),
        |request_id| {
            session.handle.set_i64_async(
                request_id,
                "video-rotate",
                i64::from(normalized),
                "set video rotation",
            )
        },
    )?;
    lock_state(&session, |state| {
        state.snapshot.video_rotation_degrees = normalized;
    })
}

#[napi(js_name = "setVideoPan")]
pub fn set_video_pan(session_id: String, pan_x: f64, pan_y: f64) -> Result<()> {
    if !pan_x.is_finite() || !pan_y.is_finite() {
        return Err(error("Video pan must use finite numbers.".to_owned()));
    }
    let session = session(&session_id)?;
    issue_labeled(&session, format!("set video-pan-x={pan_x}"), |request_id| {
        session
            .handle
            .set_double_async(request_id, "video-pan-x", pan_x, "set video pan-x")
    })?;
    issue_labeled(&session, format!("set video-pan-y={pan_y}"), |request_id| {
        session
            .handle
            .set_double_async(request_id, "video-pan-y", pan_y, "set video pan-y")
    })?;
    lock_state(&session, |state| {
        state.snapshot.video_pan_x = pan_x;
        state.snapshot.video_pan_y = pan_y;
    })
}

#[napi(js_name = "setLoopFile")]
pub fn set_loop_file(session_id: String, enabled: bool) -> Result<()> {
    let session = session(&session_id)?;
    issue_labeled(
        &session,
        format!("set loop-file={}", if enabled { "inf" } else { "no" }),
        |request_id| {
            session.handle.set_string_async(
                request_id,
                "loop-file",
                if enabled { "inf" } else { "no" },
                "set loop-file",
            )
        },
    )?;
    lock_state(&session, |state| state.snapshot.loop_file = enabled)
}

#[napi(js_name = "setSecondarySubtitleTrack")]
pub fn set_secondary_subtitle_track(session_id: String, track_id: i64) -> Result<()> {
    set_track(
        &session_id,
        "secondary-sid",
        track_id,
        "update secondary subtitle track",
        |state| {
            state.snapshot.selected_secondary_subtitle_track_id =
                (track_id >= 0).then_some(track_id);
        },
    )
}

#[napi(js_name = "setAudioPitchCorrection")]
pub fn set_audio_pitch_correction(session_id: String, enabled: bool) -> Result<()> {
    let session = session(&session_id)?;
    issue_labeled(
        &session,
        format!(
            "set audio-pitch-correction={}",
            if enabled { "yes" } else { "no" }
        ),
        |request_id| {
            session.handle.set_flag_async(
                request_id,
                "audio-pitch-correction",
                enabled,
                "set audio pitch correction",
            )
        },
    )?;
    lock_state(&session, |state| {
        state.snapshot.audio_pitch_correction = enabled;
    })
}

#[napi(js_name = "setLoudnessNormalization")]
pub fn set_loudness_normalization(session_id: String, enabled: bool) -> Result<()> {
    let session = session(&session_id)?;
    if lock_state(&session, |state| state.snapshot.loudness_normalization)? == enabled {
        return Ok(());
    }
    let args = if enabled {
        vec!["af", "add", "@empv-loudnorm:loudnorm=I=-16:TP=-1.5:LRA=11"]
    } else {
        vec!["af", "remove", "@empv-loudnorm"]
    };
    let label = if enabled {
        "af add @empv-loudnorm"
    } else {
        "af remove @empv-loudnorm"
    };
    issue_labeled(&session, label, |request_id| {
        command_strings_async(&session.handle, request_id, &args, label)
    })?;
    lock_state(&session, |state| {
        state.snapshot.loudness_normalization = enabled;
    })
}

#[napi(js_name = "setAudioVisualization")]
pub fn set_audio_visualization(session_id: String, mode: String) -> Result<()> {
    let graph = match mode.as_str() {
        "none" => "",
        "spectrum" => "[aid1]asplit[ao][a1];[a1]showspectrum[vo]",
        "waveform" => "[aid1]asplit[ao][a1];[a1]showwaves[vo]",
        _ => {
            return Err(error(
                "Audio visualization mode must be 'none', 'spectrum', or 'waveform'.".to_owned(),
            ));
        }
    };
    let session = session(&session_id)?;
    issue_labeled(
        &session,
        format!("set lavfi-complex={mode}"),
        |request_id| {
            session.handle.set_string_async(
                request_id,
                "lavfi-complex",
                graph,
                "set audio visualization",
            )
        },
    )?;
    lock_state(&session, |state| {
        state.snapshot.audio_visualization = mode;
    })
}

#[napi(js_name = "startRecording")]
pub fn start_recording(session_id: String, target_path: String) -> Result<()> {
    if target_path.is_empty() {
        return Err(error("Recording target path is required.".to_owned()));
    }
    let session = session(&session_id)?;
    let id = labeled_id(&session, format!("set stream-record={target_path}"))?;
    let started_at = now_iso_string();
    lock_state(&session, |state| {
        state.pending.recording_start = Some(RecordingStart {
            request_id: id,
            target_path: target_path.clone(),
            started_at: started_at.clone(),
        });
        state.snapshot.recording_active = true;
        state.snapshot.recording_target_path = Some(target_path.clone());
        state.snapshot.recording_started_at = Some(started_at.clone());
        state.snapshot.recording_error = None;
    })?;
    if let Err(reason) =
        session
            .handle
            .set_string_async(id, "stream-record", &target_path, "start stream recording")
    {
        registry::forget_async_label(&session, id);
        let detail = mpv_error_detail(&reason, "start stream recording");
        lock_state(&session, |state| {
            state.pending.recording_start = None;
            state.snapshot.recording_active = false;
            state.snapshot.recording_started_at = None;
            state.snapshot.recording_error = Some(detail);
        })?;
        return Err(error(reason));
    }
    Ok(())
}

#[napi(js_name = "stopRecording")]
pub fn stop_recording(session_id: String) -> Result<()> {
    let session = session(&session_id)?;
    let id = labeled_id(&session, "set stream-record= (stop)")?;
    let started_at = lock_state(&session, |state| {
        state.snapshot.recording_started_at.clone()
    })?;
    lock_state(&session, |state| {
        state.pending.recording_stop = Some(RecordingStop {
            request_id: id,
            started_at: started_at.clone(),
        });
        state.snapshot.recording_active = false;
        state.snapshot.recording_started_at = None;
        state.snapshot.recording_error = None;
    })?;
    if let Err(reason) =
        session
            .handle
            .set_string_async(id, "stream-record", "", "stop stream recording")
    {
        registry::forget_async_label(&session, id);
        let detail = mpv_error_detail(&reason, "stop stream recording");
        lock_state(&session, |state| {
            state.pending.recording_stop = None;
            state.snapshot.recording_active = true;
            state.snapshot.recording_started_at = started_at;
            state.snapshot.recording_error = Some(detail);
        })?;
        return Err(error(reason));
    }
    Ok(())
}

fn now_iso_string() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn mpv_error_detail(reason: &str, action: &str) -> String {
    reason
        .strip_prefix(&format!("Failed to {action}: "))
        .unwrap_or(reason)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_conversion_has_unix_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
    }

    #[test]
    fn snapshot_errors_keep_the_raw_mpv_detail() {
        assert_eq!(
            mpv_error_detail("Failed to load playback: loading failed", "load playback"),
            "loading failed"
        );
        assert_eq!(
            mpv_error_detail(
                "Native string contains an embedded NUL byte.",
                "load playback"
            ),
            "Native string contains an embedded NUL byte."
        );
    }
}
