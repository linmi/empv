/// How close to the duration a reported position must be to count as "at the
/// media tail" for eof gating and self-healing. Wide enough to absorb the gap
/// between the last decoded frame and the reported duration, narrow enough that
/// a mid-file position (the stale-eof failure mode) never reads as at-tail.
const EOF_TAIL_TOLERANCE_SECONDS: f64 = 2.0;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SessionStatus {
    #[default]
    Idle,
    Loading,
    Playing,
    Paused,
    Ended,
    Error,
    Closed,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading => "loading",
            Self::Playing => "playing",
            Self::Paused => "paused",
            Self::Ended => "ended",
            Self::Error => "error",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Default)]
pub struct PlaybackStateReducer {
    paused: bool,
    eof_reached: bool,
    loaded_path: bool,
}

impl PlaybackStateReducer {
    pub fn begin_loading(&mut self, status: &mut SessionStatus) {
        self.eof_reached = false;
        self.loaded_path = false;
        *status = SessionStatus::Loading;
    }

    pub fn complete_loading(&mut self, status: &mut SessionStatus) {
        self.loaded_path = true;
        *status = self.derived_active_status();
    }

    pub fn fail(&mut self, status: &mut SessionStatus) {
        self.eof_reached = false;
        *status = SessionStatus::Error;
    }

    pub fn reach_end(&mut self, status: &mut SessionStatus) {
        self.eof_reached = true;
        *status = SessionStatus::Ended;
    }

    pub fn become_idle(&mut self, status: &mut SessionStatus) {
        self.eof_reached = false;
        *status = SessionStatus::Idle;
    }

    /// Applies an `eof-reached` property observation, gated by the media clock.
    ///
    /// `eof-reached` is a property notification, and mpv delivers property
    /// notifications with no ordering guarantee relative to file boundaries:
    /// a `true` emitted for the previous entry can be coalesced/delayed and
    /// arrive *after* `begin_loading` cleared eof for the next entry, which
    /// would otherwise latch the fresh file into Ended forever. Because "eof
    /// means we are physically at the tail" is a real invariant, we only accept
    /// a `true` when the reported position is within [`EOF_TAIL_TOLERANCE_SECONDS`]
    /// of the duration (or the duration is not yet known); an off-tail `true` is
    /// a stale cross-file signal and is dropped. A `false` always clears.
    ///
    /// The true end-of-file signal travels the END_FILE(EOF) event via
    /// [`reach_end`](Self::reach_end), which is not gated here.
    pub fn set_eof_reached(
        &mut self,
        status: &mut SessionStatus,
        value: bool,
        position_seconds: f64,
        duration_seconds: Option<f64>,
    ) {
        if value && !position_at_tail(position_seconds, duration_seconds) {
            return;
        }
        self.eof_reached = value;
        self.reconcile(status);
    }

    /// Reconciles a `time-pos` observation, self-healing any stale eof latch.
    ///
    /// If eof is currently latched but the fresh position proves we are no
    /// longer at the tail (same [`EOF_TAIL_TOLERANCE_SECONDS`] window), the latch
    /// is cleared and the status reconciled. This makes an erroneous cross-file
    /// Ended lock impossible to persist: the very next clock tick unsticks it.
    pub fn observe_position(
        &mut self,
        status: &mut SessionStatus,
        position_seconds: f64,
        duration_seconds: Option<f64>,
    ) {
        if self.eof_reached && !position_at_tail(position_seconds, duration_seconds) {
            self.eof_reached = false;
            self.reconcile(status);
        }
    }

    pub fn set_paused(&mut self, status: &mut SessionStatus, value: bool) {
        self.paused = value;
        self.reconcile(status);
    }

    pub fn close(&mut self, status: &mut SessionStatus) {
        self.eof_reached = false;
        self.loaded_path = false;
        *status = SessionStatus::Closed;
    }

    fn reconcile(&self, status: &mut SessionStatus) {
        if !self.loaded_path || *status == SessionStatus::Loading || *status == SessionStatus::Error
        {
            return;
        }
        *status = self.derived_active_status();
    }

    fn derived_active_status(&self) -> SessionStatus {
        if self.eof_reached {
            SessionStatus::Ended
        } else if self.paused {
            SessionStatus::Paused
        } else {
            SessionStatus::Playing
        }
    }
}

/// Whether `position_seconds` sits within the tail window of `duration_seconds`.
/// An unknown duration is treated as possibly-at-tail (conservative: it neither
/// rejects an eof=true nor triggers self-healing).
fn position_at_tail(position_seconds: f64, duration_seconds: Option<f64>) -> bool {
    match duration_seconds {
        Some(duration) => duration - position_seconds <= EOF_TAIL_TOLERANCE_SECONDS,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_ignores_pause_until_path_is_loaded() {
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.set_paused(&mut status, true);
        assert_eq!(status, SessionStatus::Loading);
        reducer.complete_loading(&mut status);
        assert_eq!(status, SessionStatus::Paused);
    }

    #[test]
    fn eof_wins_over_keep_open_pause() {
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.set_paused(&mut status, true);
        reducer.set_eof_reached(&mut status, true, 5.0, Some(5.0));
        assert_eq!(status, SessionStatus::Ended);
        reducer.set_paused(&mut status, false);
        assert_eq!(status, SessionStatus::Ended);
        reducer.set_eof_reached(&mut status, false, 5.0, Some(5.0));
        assert_eq!(status, SessionStatus::Playing);
    }

    #[test]
    fn stale_off_tail_eof_true_is_ignored() {
        // A coalesced eof=true from the previous entry lands while the fresh
        // entry plays near its start. Position/duration are not self-consistent
        // with end-of-file, so the signal is stale and must not latch Ended.
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.set_eof_reached(&mut status, true, 0.8, Some(660.0));
        assert_eq!(status, SessionStatus::Playing);
    }

    #[test]
    fn latched_eof_is_self_healed_by_advancing_position() {
        // An eof latch (here from a real END_FILE, or equally an eof=true that
        // was accepted while position still sat at a prior tail) must not
        // survive a clock tick that proves we are early in a fresh file.
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.reach_end(&mut status);
        assert_eq!(status, SessionStatus::Ended);
        reducer.observe_position(&mut status, 0.8, Some(660.0));
        assert_eq!(status, SessionStatus::Playing);
    }

    #[test]
    fn genuine_tail_eof_enters_and_stays_ended() {
        // A real end-of-file at the tail enters Ended and is never self-healed
        // away by positions that remain at the tail.
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.set_eof_reached(&mut status, true, 4.9, Some(5.0));
        assert_eq!(status, SessionStatus::Ended);
        reducer.observe_position(&mut status, 5.0, Some(5.0));
        assert_eq!(status, SessionStatus::Ended);
    }

    #[test]
    fn error_is_sticky_until_a_new_lifecycle_transition() {
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.fail(&mut status);
        reducer.set_paused(&mut status, false);
        assert_eq!(status, SessionStatus::Error);
        reducer.begin_loading(&mut status);
        assert_eq!(status, SessionStatus::Loading);
    }

    #[test]
    fn close_and_idle_clear_terminal_facts() {
        let mut reducer = PlaybackStateReducer::default();
        let mut status = SessionStatus::Idle;
        reducer.begin_loading(&mut status);
        reducer.complete_loading(&mut status);
        reducer.reach_end(&mut status);
        reducer.become_idle(&mut status);
        assert_eq!(status, SessionStatus::Idle);
        reducer.close(&mut status);
        assert_eq!(status, SessionStatus::Closed);
    }
}
