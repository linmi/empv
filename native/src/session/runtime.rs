use std::any::Any;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Instant;

use napi::threadsafe_function::ThreadsafeFunctionCallMode;

use crate::mpv::event::{Event, c_string, read_event};
use crate::mpv::ffi;
use crate::mpv::handle::{OwnedMpvHandle, error_string};

use super::registry::{Session, SessionState};
use super::snapshot::OBSERVED_PROPERTIES;

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn initialize_handle(
    handle: &OwnedMpvHandle,
    volume_percent: f64,
    wid: &str,
) -> Result<(), String> {
    for (name, value) in [
        ("terminal", "no"),
        ("config", "no"),
        ("osc", "no"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("ytdl", "no"),
        ("gapless-audio", "yes"),
        ("prefetch-playlist", "yes"),
        ("vo", "gpu"),
        ("hwdec", "auto-safe"),
    ] {
        handle.set_option_for_action(name, value, &format!("configure libmpv option {name}"))?;
    }
    handle.set_option("volume", &volume_percent.to_string())?;
    handle.set_option("wid", wid)?;
    handle.initialize()?;
    for (id, name, format) in OBSERVED_PROPERTIES {
        handle.observe(id, name, format)?;
    }
    handle.request_logs("warn")?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn initialize_macos_handle(handle: &OwnedMpvHandle, volume_percent: f64) -> Result<(), String> {
    // The pinned macOS runtime is built with Lua, JavaScript, and C plugins
    // disabled, so it does not register the `osc` or `ytdl` options. The former
    // Objective-C++ backend attempted both writes but ignored their
    // MPV_ERROR_OPTION_NOT_FOUND results. Their disabled product semantics are
    // structural in this runtime; issuing either write here would make every
    // session fail now that all negative mpv results are surfaced.
    for (name, value) in [
        ("terminal", "no"),
        ("config", "no"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("gapless-audio", "yes"),
        ("prefetch-playlist", "yes"),
        ("vo", "libmpv"),
        ("hwdec", "auto-safe"),
    ] {
        handle.set_option_for_action(name, value, &format!("configure libmpv option {name}"))?;
    }
    handle.set_option_for_action("ao", "avfoundation", "configure AVFoundation audio output")?;
    handle.set_option("volume", &volume_percent.to_string())?;
    handle.initialize()?;
    for (id, name, format) in OBSERVED_PROPERTIES {
        handle.observe(id, name, format)?;
    }
    handle.request_logs("warn")?;
    Ok(())
}

pub fn spawn_event_loop(session: Arc<Session>) -> Result<(), String> {
    let mut event_thread = session
        .event_thread
        .lock()
        .map_err(|_| "Embedded MPV event-thread lock was poisoned.".to_owned())?;
    session.running.store(true, Ordering::Release);
    let thread_session = session.clone();
    let thread = thread::Builder::new()
        .name(format!("{}-events", session.id))
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_event_loop(&thread_session);
            }));
            if let Err(payload) = result {
                mark_thread_panic(&thread_session, panic_message(payload));
            }
        })
        .map_err(|error| format!("Failed to start libmpv event thread: {error}"))?;
    *event_thread = Some(thread);
    Ok(())
}

fn run_event_loop(session: &Arc<Session>) {
    while session.running.load(Ordering::Acquire) {
        match read_event(session.handle.wait_event(0.1)) {
            Event::None | Event::Other => {}
            Event::StartFile => {
                if let Ok(mut state) = session.state.lock() {
                    state.content_generation = state.content_generation.saturating_add(1);
                    let generation = state.content_generation;
                    let SessionState {
                        snapshot, playback, ..
                    } = &mut *state;
                    snapshot.reset_for_start_file(playback, generation);
                }
                notify(session, true);
            }
            Event::FileLoaded => {
                if let Ok(mut state) = session.state.lock() {
                    let SessionState {
                        snapshot, playback, ..
                    } = &mut *state;
                    playback.complete_loading(&mut snapshot.status);
                    snapshot.error = None;
                }
                notify(session, true);
            }
            Event::PlaybackRestart => {
                if let Ok(mut state) = session.state.lock() {
                    state.snapshot.playback_ready_generation = state.content_generation;
                    #[cfg(target_os = "macos")]
                    let generation = state.content_generation;
                    #[cfg(target_os = "macos")]
                    drop(state);
                    #[cfg(target_os = "macos")]
                    with_mac_render(session, |render| render.playback_restarted(generation));
                }
                notify(session, true);
            }
            Event::EndFile(end) => {
                if let Ok(mut state) = session.state.lock() {
                    let SessionState {
                        snapshot, playback, ..
                    } = &mut *state;
                    match end.map(|value| value.reason) {
                        Some(ffi::END_FILE_REASON_EOF) => playback.reach_end(&mut snapshot.status),
                        Some(ffi::END_FILE_REASON_ERROR) => {
                            playback.fail(&mut snapshot.status);
                            let code = end.map(|value| value.error).unwrap_or(-1);
                            snapshot.error = Some(if code < 0 {
                                error_string(code)
                            } else {
                                "Playback failed.".to_owned()
                            });
                        }
                        _ => playback.become_idle(&mut snapshot.status),
                    }
                }
                notify(session, true);
            }
            Event::Property(property) => {
                let Some(property) = property else {
                    continue;
                };
                let name = c_string(property.name);
                let mut change = Default::default();
                let mut disable_visualization = false;
                if let Ok(mut state) = session.state.lock() {
                    let SessionState {
                        snapshot, playback, ..
                    } = &mut *state;
                    change = unsafe {
                        snapshot.reduce_property(playback, &name, property.format, property.data)
                    };
                    if name == "track-list"
                        && snapshot.video_track_count.unwrap_or(0) > 0
                        && snapshot.audio_visualization != "none"
                    {
                        snapshot.audio_visualization = "none".to_owned();
                        disable_visualization = true;
                        change.changed = true;
                        change.important = true;
                    }
                }
                if disable_visualization && let Err(error) = disable_audio_visualization(session) {
                    set_error(session, error);
                }
                if change.changed {
                    #[cfg(target_os = "macos")]
                    if name == "video-rotate" {
                        with_mac_render(session, |render| render.force_render());
                    }
                    notify(session, change.important);
                }
            }
            Event::Log(log) => {
                let Some(log) = log else {
                    continue;
                };
                let level = c_string(log.level);
                let text = c_string(log.text);
                if matches!(level.as_str(), "warn" | "error" | "fatal") {
                    eprintln!(
                        "[embedded-mpv][{}][{}] {}: {}",
                        session.id,
                        level,
                        c_string(log.prefix),
                        text.trim_end()
                    );
                }
                if matches!(level.as_str(), "error" | "fatal") {
                    if let Ok(mut state) = session.state.lock() {
                        state.snapshot.error = Some(text);
                        if level == "fatal" {
                            let SessionState {
                                snapshot, playback, ..
                            } = &mut *state;
                            playback.fail(&mut snapshot.status);
                        }
                    }
                    notify(session, true);
                }
            }
            Event::Reply { request_id, error } => {
                let mut changed = false;
                if let Ok(mut state) = session.state.lock() {
                    let message = error_string(error);
                    let label = state
                        .pending
                        .labels
                        .remove(&request_id)
                        .unwrap_or_else(|| "<unlabeled request>".to_owned());
                    let SessionState {
                        snapshot, pending, ..
                    } = &mut *state;
                    let ignored = pending.ignored.remove(&request_id);
                    if !ignored {
                        changed = pending.reconcile_recording(
                            snapshot,
                            request_id,
                            error,
                            message.clone(),
                        );
                    }
                    if !ignored && !changed && error < 0 {
                        eprintln!(
                            "[embedded-mpv][{}][command-error] {}: {}",
                            session.id, label, message
                        );
                    }
                }
                if changed {
                    notify(session, true);
                }
            }
            Event::Shutdown => {
                session.running.store(false, Ordering::Release);
                if let Ok(mut state) = session.state.lock() {
                    let SessionState {
                        snapshot, playback, ..
                    } = &mut *state;
                    playback.close(&mut snapshot.status);
                }
                notify(session, true);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn with_mac_render(session: &Session, action: impl FnOnce(&super::macos::MacRenderRuntime)) {
    if let Ok(render) = session.render.lock()
        && let Some(render) = render.as_ref()
    {
        action(render);
    }
}

pub fn stop_event_loop(session: &Arc<Session>) -> Result<(), String> {
    session.running.store(false, Ordering::Release);
    session.handle.wakeup();
    let (thread, lock_poisoned) = match session.event_thread.lock() {
        Ok(mut slot) => (slot.take(), false),
        Err(poisoned) => (poisoned.into_inner().take(), true),
    };
    let mut errors = lock_poisoned
        .then(|| "Embedded MPV event-thread lock was poisoned.".to_owned())
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(thread) = thread
        && let Err(payload) = thread.join()
    {
        errors.push(format!(
            "libmpv event thread panicked: {}",
            panic_message(payload)
        ));
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(())
}

pub fn set_error(session: &Session, error: String) {
    recover_state_error(&session.state, error);
    notify(session, true);
}

fn recover_state_error(state_mutex: &std::sync::Mutex<SessionState>, error: String) {
    let mut state = match state_mutex.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    let SessionState {
        snapshot, playback, ..
    } = &mut *state;
    playback.fail(&mut snapshot.status);
    snapshot.error = Some(error);
    drop(state);
    state_mutex.clear_poison();
}

fn mark_thread_panic(session: &Session, message: String) {
    session.running.store(false, Ordering::Release);
    set_error(session, format!("libmpv event thread panicked: {message}"));
}

fn notify(session: &Session, important: bool) {
    let now = now_ms();
    if !important {
        let previous = session.last_snapshot_push_ms.load(Ordering::Relaxed);
        if now.saturating_sub(previous) < 250 {
            return;
        }
    }
    session.last_snapshot_push_ms.store(now, Ordering::Relaxed);
    let _ = session.snapshot_sink.call_with_return_value(
        (),
        ThreadsafeFunctionCallMode::NonBlocking,
        |_result, _env| Ok(()),
    );
}

fn now_ms() -> i64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn disable_audio_visualization(session: &Session) -> Result<(), String> {
    let request_id = super::registry::register_async_label(
        session,
        "set lavfi-complex= (clear audio visualization)",
    )?;
    let result = session.handle.set_string_async(
        request_id,
        "lavfi-complex",
        "",
        "disable audio visualization",
    );
    if result.is_err() {
        super::registry::forget_async_label(session, request_id);
    }
    result
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::state::{PlaybackStateReducer, SessionStatus};
    use crate::session::recording::PendingRequests;
    use crate::session::snapshot::SessionSnapshot;
    use std::sync::Mutex;

    #[test]
    fn panic_error_recovery_clears_poison_and_remains_observable() {
        let state = Mutex::new(SessionState {
            snapshot: SessionSnapshot::default(),
            playback: PlaybackStateReducer::default(),
            pending: PendingRequests::default(),
            content_generation: 0,
            playlist_paths: Vec::new(),
        });
        let _ = std::panic::catch_unwind(|| {
            let _guard = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            panic!("poison state");
        });
        assert!(state.is_poisoned());
        recover_state_error(&state, "event loop panic".to_owned());
        let recovered = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(recovered.snapshot.status, SessionStatus::Error);
        assert_eq!(
            recovered.snapshot.error.as_deref(),
            Some("event loop panic")
        );
        assert!(!state.is_poisoned());
    }
}
