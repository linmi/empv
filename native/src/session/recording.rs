use std::collections::{HashMap, HashSet};

use super::snapshot::SessionSnapshot;

#[derive(Default)]
pub struct PendingRequests {
    pub recording_start: Option<RecordingStart>,
    pub recording_stop: Option<RecordingStop>,
    pub ignored: HashSet<u64>,
    pub labels: HashMap<u64, String>,
}

pub struct RecordingStart {
    pub request_id: u64,
    pub target_path: String,
    pub started_at: String,
}

pub struct RecordingStop {
    pub request_id: u64,
    pub started_at: Option<String>,
}

impl PendingRequests {
    pub fn reconcile_recording(
        &mut self,
        snapshot: &mut SessionSnapshot,
        request_id: u64,
        error: i32,
        error_message: String,
    ) -> bool {
        if self
            .recording_start
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            let Some(pending) = self.recording_start.take() else {
                return false;
            };
            if error < 0 {
                snapshot.recording_active = false;
                snapshot.recording_target_path = Some(pending.target_path);
                snapshot.recording_started_at = None;
                snapshot.recording_error = Some(error_message);
            } else {
                snapshot.recording_active = true;
                snapshot.recording_target_path = Some(pending.target_path);
                snapshot.recording_started_at = Some(pending.started_at);
                snapshot.recording_error = None;
            }
            return true;
        }
        if self
            .recording_stop
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            let Some(pending) = self.recording_stop.take() else {
                return false;
            };
            if error < 0 {
                snapshot.recording_active = true;
                snapshot.recording_started_at = pending.started_at;
                snapshot.recording_error = Some(error_message);
            } else {
                snapshot.recording_active = false;
                snapshot.recording_started_at = None;
                snapshot.recording_error = None;
            }
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_failure_preserves_target_and_raw_error() {
        let mut pending = PendingRequests {
            recording_start: Some(RecordingStart {
                request_id: 7,
                target_path: "/tmp/out.mkv".to_owned(),
                started_at: "now".to_owned(),
            }),
            ..PendingRequests::default()
        };
        let mut snapshot = SessionSnapshot::default();
        assert!(pending.reconcile_recording(&mut snapshot, 7, -1, "invalid parameter".to_owned(),));
        assert_eq!(
            snapshot.recording_target_path.as_deref(),
            Some("/tmp/out.mkv")
        );
        assert_eq!(
            snapshot.recording_error.as_deref(),
            Some("invalid parameter")
        );
    }

    #[test]
    fn stop_reply_preserves_target_on_both_outcomes() {
        for (error_code, active) in [(-1, true), (0, false)] {
            let mut pending = PendingRequests {
                recording_stop: Some(RecordingStop {
                    request_id: 9,
                    started_at: Some("now".to_owned()),
                }),
                ..PendingRequests::default()
            };
            let mut snapshot = SessionSnapshot {
                recording_active: true,
                recording_target_path: Some("/tmp/out.mkv".to_owned()),
                recording_started_at: Some("now".to_owned()),
                ..SessionSnapshot::default()
            };
            assert!(pending.reconcile_recording(
                &mut snapshot,
                9,
                error_code,
                "failure".to_owned(),
            ));
            assert_eq!(snapshot.recording_active, active);
            assert_eq!(
                snapshot.recording_target_path.as_deref(),
                Some("/tmp/out.mkv")
            );
        }
    }
}
