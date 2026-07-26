use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use napi::threadsafe_function::ThreadsafeFunctionCallMode;

use crate::mpv::render::{OwnedRenderContext, RENDER_UPDATE_FRAME};
use crate::presentation::macos::{self, Bounds, FrameLinkError, FramePool, SessionSurface};

use super::registry::{FrameReady, FrameSink, Session};

const SURFACE_COUNT: i32 = 3;
const MAX_CONSECUTIVE_RENDER_FAILURES: u32 = 3;
const RENDER_RETRY_DELAY: Duration = Duration::from_millis(100);

pub struct MacRenderRuntime {
    sender: Sender<RenderCommand>,
    running: Arc<AtomicBool>,
    rendered_frame_count: Arc<AtomicU64>,
    total_render_nanoseconds: Arc<AtomicU64>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

enum RenderCommand {
    Wake,
    Resize(i32, i32),
    SetPresentationActive(bool),
    SetRenderGeneration(u64),
    Force,
    Capture(SyncSender<Result<Option<CapturedFrame>, String>>),
    Stop(SyncSender<()>),
}

#[derive(Debug)]
pub struct CapturedFrame {
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub data: Vec<u8>,
}

struct RenderWorker {
    session_id: String,
    receiver: Receiver<RenderCommand>,
    running: Arc<AtomicBool>,
    render_pending: Arc<AtomicBool>,
    rendered_frame_count: Arc<AtomicU64>,
    skipped_frame_count: Arc<AtomicU64>,
    total_render_nanoseconds: Arc<AtomicU64>,
    frame_sink: FrameSink,
    report_error: Arc<dyn Fn(String) + Send + Sync>,
    surface: SessionSurface,
    render_context: OwnedRenderContext,
    width_pixels: i32,
    height_pixels: i32,
    presentation_active: bool,
    force_render: bool,
    retry_at: Option<Instant>,
    consecutive_failure_count: u32,
    next_surface_index: i32,
    last_surface_index: Option<i32>,
    frame_pool_generation: u64,
    pool_mach_sent: bool,
    render_generation: u64,
}

impl MacRenderRuntime {
    pub fn start(
        session: Weak<Session>,
        handle: Arc<crate::mpv::handle::OwnedMpvHandle>,
        session_id: String,
        frame_sink: FrameSink,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (initialized_sender, initialized_receiver) = mpsc::sync_channel(1);
        let running = Arc::new(AtomicBool::new(true));
        let render_pending = Arc::new(AtomicBool::new(false));
        let rendered_frame_count = Arc::new(AtomicU64::new(0));
        let skipped_frame_count = Arc::new(AtomicU64::new(0));
        let total_render_nanoseconds = Arc::new(AtomicU64::new(0));
        let report_error: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |error| {
            if let Some(session) = session.upgrade() {
                super::runtime::set_error(&session, error);
            }
        });

        let worker_sender = sender.clone();
        let worker_running = running.clone();
        let worker_pending = render_pending.clone();
        let worker_frames = rendered_frame_count.clone();
        let worker_skipped = skipped_frame_count.clone();
        let worker_nanoseconds = total_render_nanoseconds.clone();
        let worker_report_error = report_error.clone();
        let thread = thread::Builder::new()
            .name(format!("{session_id}-render"))
            .spawn(move || {
                let initialized_on_panic = initialized_sender.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let worker = RenderWorker::create(
                        session_id,
                        handle,
                        receiver,
                        worker_sender,
                        worker_running.clone(),
                        worker_pending,
                        worker_frames,
                        worker_skipped,
                        worker_nanoseconds,
                        frame_sink,
                        worker_report_error.clone(),
                    );
                    match worker {
                        Ok(mut worker) => {
                            let _ = initialized_sender.send(Ok(()));
                            worker.run();
                        }
                        Err(error) => {
                            worker_running.store(false, Ordering::Release);
                            let _ = initialized_sender.send(Err(error));
                        }
                    }
                }));
                if let Err(payload) = result {
                    worker_running.store(false, Ordering::Release);
                    let message =
                        format!("libmpv render thread panicked: {}", panic_message(payload));
                    let _ = initialized_on_panic.send(Err(message.clone()));
                    worker_report_error(message);
                }
            })
            .map_err(|error| format!("Failed to start libmpv render thread: {error}"))?;

        match initialized_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                sender,
                running,
                rendered_frame_count,
                total_render_nanoseconds,
                thread: Mutex::new(Some(thread)),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err("libmpv render thread exited during initialization.".to_owned())
            }
        }
    }

    pub fn set_render_size(&self, width_pixels: i32, height_pixels: i32) {
        let sized = width_pixels > 0 && height_pixels > 0;
        let size = if sized {
            (width_pixels, height_pixels)
        } else {
            (0, 0)
        };
        let _ = self.sender.send(RenderCommand::Resize(size.0, size.1));
    }

    pub fn set_presentation_suspended(&self, suspended: bool) {
        let _ = self
            .sender
            .send(RenderCommand::SetPresentationActive(!suspended));
    }

    pub fn playback_restarted(&self, generation: u64) {
        let _ = self
            .sender
            .send(RenderCommand::SetRenderGeneration(generation));
    }

    pub fn force_render(&self) {
        let _ = self.sender.send(RenderCommand::Force);
    }

    pub fn capture(&self) -> Result<Option<CapturedFrame>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(RenderCommand::Capture(sender))
            .map_err(|_| "libmpv render thread is not running.".to_owned())?;
        receiver
            .recv()
            .map_err(|_| "libmpv render thread stopped during capture.".to_owned())?
    }

    pub fn rendered_frame_count(&self) -> u64 {
        self.rendered_frame_count.load(Ordering::Relaxed)
    }

    pub fn average_render_ms(&self) -> Option<f64> {
        let count = self.rendered_frame_count();
        (count > 0).then(|| {
            self.total_render_nanoseconds.load(Ordering::Relaxed) as f64 / count as f64 / 1.0e6
        })
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.running.store(false, Ordering::Release);
        let (sender, receiver) = mpsc::sync_channel(1);
        if self.sender.send(RenderCommand::Stop(sender)).is_ok() {
            let _ = receiver.recv();
        }
        let thread = match self.thread.lock() {
            Ok(mut thread) => thread.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(thread) = thread
            && let Err(payload) = thread.join()
        {
            return Err(format!(
                "libmpv render thread panicked: {}",
                panic_message(payload)
            ));
        }
        self.thread.clear_poison();
        Ok(())
    }
}

impl Drop for MacRenderRuntime {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

impl RenderWorker {
    #[allow(clippy::too_many_arguments)]
    fn create(
        session_id: String,
        handle: Arc<crate::mpv::handle::OwnedMpvHandle>,
        receiver: Receiver<RenderCommand>,
        sender: Sender<RenderCommand>,
        running: Arc<AtomicBool>,
        render_pending: Arc<AtomicBool>,
        rendered_frame_count: Arc<AtomicU64>,
        skipped_frame_count: Arc<AtomicU64>,
        total_render_nanoseconds: Arc<AtomicU64>,
        frame_sink: FrameSink,
        report_error: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let surface = SessionSurface::create()?;
        surface.make_current()?;
        let render_context = OwnedRenderContext::create_open_gl(
            handle.raw(),
            macos::empv_mac_session_surface_get_proc_address,
        )?;
        let callback_running = running.clone();
        let callback_pending = render_pending.clone();
        render_context.set_update_callback(Arc::new(move || {
            if callback_running.load(Ordering::Acquire)
                && !callback_pending.swap(true, Ordering::AcqRel)
            {
                let _ = sender.send(RenderCommand::Wake);
            }
        }))?;
        Ok(Self {
            session_id,
            receiver,
            running,
            render_pending,
            rendered_frame_count,
            skipped_frame_count,
            total_render_nanoseconds,
            frame_sink,
            report_error,
            surface,
            render_context,
            width_pixels: 0,
            height_pixels: 0,
            presentation_active: true,
            force_render: false,
            retry_at: None,
            consecutive_failure_count: 0,
            next_surface_index: 0,
            last_surface_index: None,
            frame_pool_generation: 0,
            pool_mach_sent: false,
            render_generation: 0,
        })
    }

    fn run(&mut self) {
        loop {
            let command = match self.retry_at {
                Some(deadline) => match self
                    .receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => {
                        self.retry_at = None;
                        self.render_once();
                        None
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match self.receiver.recv() {
                    Ok(command) => Some(command),
                    Err(_) => break,
                },
            };
            let Some(command) = command else {
                continue;
            };
            match command {
                RenderCommand::Wake => {
                    while self.render_pending.swap(false, Ordering::AcqRel) {
                        self.render_once();
                    }
                }
                RenderCommand::Resize(width, height) => {
                    let changed = self.width_pixels != width || self.height_pixels != height;
                    self.width_pixels = width;
                    self.height_pixels = height;
                    if changed && width > 0 && height > 0 {
                        self.force_render = true;
                        self.render_once();
                    }
                }
                RenderCommand::SetPresentationActive(active) => {
                    self.presentation_active = active;
                    if active {
                        self.force_render = true;
                        self.render_once();
                    }
                }
                RenderCommand::SetRenderGeneration(generation) => {
                    self.render_generation = generation;
                    self.force_render = true;
                    self.render_once();
                }
                RenderCommand::Force => {
                    self.force_render = true;
                    self.render_once();
                }
                RenderCommand::Capture(sender) => {
                    let _ = sender.send(self.capture());
                }
                RenderCommand::Stop(sender) => {
                    self.running.store(false, Ordering::Release);
                    let _ = self.render_context.close();
                    SessionSurface::clear_current();
                    let _ = sender.send(());
                    return;
                }
            }
        }
        self.running.store(false, Ordering::Release);
        let _ = self.render_context.close();
        SessionSurface::clear_current();
    }

    fn render_once(&mut self) {
        let update_flags = self.render_context.update();
        let has_new_frame = update_flags & RENDER_UPDATE_FRAME != 0;
        let force_render = std::mem::take(&mut self.force_render);
        if !has_new_frame && !force_render {
            return;
        }
        if self.width_pixels <= 0 || self.height_pixels <= 0 {
            if has_new_frame {
                match self.render_context.render_skip() {
                    Ok(()) => {
                        self.skipped_frame_count.fetch_add(1, Ordering::Relaxed);
                        self.consecutive_failure_count = 0;
                    }
                    Err(error) => {
                        self.handle_render_failure("mpv_render_context_render", Some(error))
                    }
                }
            }
            return;
        }

        let started_at = Instant::now();
        match self
            .surface
            .ensure_pool(self.width_pixels, self.height_pixels)
        {
            Ok(recreated) => {
                if recreated {
                    self.frame_pool_generation = self.frame_pool_generation.saturating_add(1);
                    self.pool_mach_sent = false;
                    self.next_surface_index = 0;
                    self.last_surface_index = None;
                }
            }
            Err(error) => {
                self.handle_render_failure("IOSurface pool creation", Some(error));
                return;
            }
        }

        let surface_index = self.next_surface_index;
        let framebuffer = match self.surface.framebuffer(surface_index) {
            Ok(framebuffer) => framebuffer,
            Err(error) => {
                self.handle_render_failure("IOSurface pool creation", Some(error));
                return;
            }
        };
        if let Err(error) = self.render_context.render_fbo(
            framebuffer as i32,
            self.width_pixels,
            self.height_pixels,
        ) {
            self.handle_render_failure("mpv_render_context_render", Some(error));
            return;
        }
        if let Err(error) = self.surface.finish_frame() {
            self.handle_render_failure("IOSurface pool creation", Some(error));
            return;
        }

        self.consecutive_failure_count = 0;
        self.retry_at = None;
        self.next_surface_index = (surface_index + 1) % SURFACE_COUNT;
        self.last_surface_index = Some(surface_index);

        if self.presentation_active {
            if !self.pool_mach_sent {
                match macos::send_frame_pool(
                    &self.session_id,
                    self.frame_pool_generation,
                    &self.surface,
                ) {
                    Ok(()) => self.pool_mach_sent = true,
                    Err(FrameLinkError::Transient(error)) => {
                        eprintln!(
                            "[embedded-mpv][{}] frame link pool send failed: {}",
                            self.session_id, error
                        );
                    }
                    Err(FrameLinkError::Fatal(error)) => (self.report_error)(format!(
                        "Failed to establish the mpv frame link: {error}"
                    )),
                }
            }
            let frame = FrameReady {
                surface_index: surface_index as u32,
                pool_generation: self.frame_pool_generation,
                content_generation: self.render_generation,
            };
            let _ = self.frame_sink.call_with_return_value(
                frame,
                ThreadsafeFunctionCallMode::NonBlocking,
                |_result, _env| Ok(()),
            );
        } else {
            self.skipped_frame_count.fetch_add(1, Ordering::Relaxed);
        }

        self.rendered_frame_count.fetch_add(1, Ordering::Relaxed);
        self.total_render_nanoseconds.fetch_add(
            started_at.elapsed().as_nanos().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }

    fn capture(&self) -> Result<Option<CapturedFrame>, String> {
        let Some(surface_index) = self.last_surface_index else {
            return Ok(None);
        };
        let size = self.surface.size();
        if size.width_pixels <= 0 || size.height_pixels <= 0 {
            return Ok(None);
        }
        let data = self.surface.capture_rgba(surface_index)?;
        Ok(Some(CapturedFrame {
            width_pixels: size.width_pixels as u32,
            height_pixels: size.height_pixels as u32,
            data,
        }))
    }

    fn handle_render_failure(&mut self, what: &str, detail: Option<String>) {
        self.consecutive_failure_count = self.consecutive_failure_count.saturating_add(1);
        let count = self.consecutive_failure_count;
        if count < MAX_CONSECUTIVE_RENDER_FAILURES {
            eprintln!(
                "[embedded-mpv][{}][render-retry] {} failed (attempt {}/{}){}",
                self.session_id,
                what,
                count,
                MAX_CONSECUTIVE_RENDER_FAILURES,
                detail
                    .as_deref()
                    .map(|detail| format!(": {detail}"))
                    .unwrap_or_default()
            );
            self.force_render = true;
            self.retry_at = Some(Instant::now() + RENDER_RETRY_DELAY);
            return;
        }
        let error = if what == "mpv_render_context_render" {
            format!(
                "Failed to render frame after {} attempts: {}",
                MAX_CONSECUTIVE_RENDER_FAILURES,
                detail.unwrap_or_else(|| "unknown libmpv render error".to_owned())
            )
        } else {
            format!(
                "Failed to create IOSurface pool for MPV video rendering (after {} attempts).",
                MAX_CONSECUTIVE_RENDER_FAILURES
            )
        };
        (self.report_error)(error);
    }
}

#[derive(Clone)]
pub struct PendingFrame {
    pub pool_generation: u64,
    pub surface_index: i32,
    pub content_generation: u64,
}

pub struct MacPresenterState {
    pub last_bounds: Bounds,
    pub suspended: bool,
    pub pool_generation: u64,
    pub pool: Option<Arc<FramePool>>,
    pub pending: Option<PendingFrame>,
    pub highest_presented_content_generation: u64,
}

impl MacPresenterState {
    pub fn new(bounds: Bounds) -> Self {
        Self {
            last_bounds: bounds,
            suspended: false,
            pool_generation: 0,
            pool: None,
            pending: None,
            highest_presented_content_generation: 0,
        }
    }

    pub fn install_pool(
        &mut self,
        generation: u64,
        pool: Arc<FramePool>,
    ) -> Option<(Arc<FramePool>, i32)> {
        if generation < self.pool_generation {
            return None;
        }
        let surface_index = self.install_pool_decision(generation);
        self.pool = Some(pool.clone());
        surface_index.map(|surface_index| (pool, surface_index))
    }

    fn install_pool_decision(&mut self, generation: u64) -> Option<i32> {
        if generation < self.pool_generation {
            return None;
        }
        self.pool_generation = generation;
        let pending = self.pending.take()?;
        if pending.pool_generation != generation
            || !(0..SURFACE_COUNT).contains(&pending.surface_index)
            || pending.content_generation < self.highest_presented_content_generation
            || self.suspended
        {
            if pending.pool_generation > generation {
                self.pending = Some(pending);
            }
            return None;
        }
        self.highest_presented_content_generation = pending.content_generation;
        Some(pending.surface_index)
    }

    pub fn select_frame(
        &mut self,
        pool_generation: u64,
        surface_index: i32,
        content_generation: u64,
    ) -> Option<(Arc<FramePool>, i32)> {
        if self.suspended {
            return None;
        }
        if pool_generation == self.pool_generation {
            let pool = self.pool.clone()?;
            if !self.accept_current_frame(surface_index, content_generation) {
                return None;
            }
            return Some((pool, surface_index));
        }
        if pool_generation > self.pool_generation {
            let replace = self.pending.as_ref().is_none_or(|pending| {
                pool_generation > pending.pool_generation
                    || (pool_generation == pending.pool_generation
                        && content_generation >= pending.content_generation)
            });
            if replace {
                self.pending = Some(PendingFrame {
                    pool_generation,
                    surface_index,
                    content_generation,
                });
            }
        }
        None
    }

    fn accept_current_frame(&mut self, surface_index: i32, content_generation: u64) -> bool {
        if !(0..SURFACE_COUNT).contains(&surface_index)
            || content_generation < self.highest_presented_content_generation
        {
            return false;
        }
        self.pending = None;
        self.highest_presented_content_generation = content_generation;
        true
    }
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

    fn state() -> MacPresenterState {
        MacPresenterState::new(Bounds {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
            corner_radius: 0.0,
        })
    }

    #[test]
    fn future_frame_is_flushed_when_its_pool_arrives() {
        let mut state = state();
        state.pending = Some(PendingFrame {
            pool_generation: 4,
            surface_index: 2,
            content_generation: 7,
        });

        assert_eq!(state.install_pool_decision(4), Some(2));
        assert!(state.pending.is_none());
        assert_eq!(state.highest_presented_content_generation, 7);
    }

    #[test]
    fn lower_content_generation_is_rejected() {
        let mut state = state();
        state.highest_presented_content_generation = 9;

        assert!(!state.accept_current_frame(1, 8));
        assert_eq!(state.highest_presented_content_generation, 9);
    }

    #[test]
    fn older_pool_install_does_not_clear_newer_pending_frame() {
        let mut state = state();
        state.pool_generation = 3;
        state.pending = Some(PendingFrame {
            pool_generation: 5,
            surface_index: 1,
            content_generation: 11,
        });

        assert_eq!(state.install_pool_decision(4), None);
        assert_eq!(
            state
                .pending
                .as_ref()
                .map(|pending| pending.pool_generation),
            Some(5)
        );
    }

    #[test]
    fn suspended_pool_install_drops_same_generation_pending_frame() {
        let mut state = state();
        state.suspended = true;
        state.pending = Some(PendingFrame {
            pool_generation: 2,
            surface_index: 0,
            content_generation: 3,
        });

        assert_eq!(state.install_pool_decision(2), None);
        assert!(state.pending.is_none());
    }
}
