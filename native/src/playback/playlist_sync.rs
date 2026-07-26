// Reconciles mpv's live playlist to a desired queue without interrupting the
// entry that is currently playing.
//
// The renderer owns the queue (a collection's playable members) and that queue
// is derived from asynchronous data: members resolve after the session is
// created, a member's file finishes downloading, the collection is edited. The
// native playlist must therefore be a function of the desired queue at all
// times, not a snapshot taken once at session creation. Any divergence is
// invisible in the UI but fatal in use: a jump to an index the native playlist
// does not have is rejected, and the row simply does nothing.
//
// Strategy: drop every entry except the one playing, append the desired queue
// around it, then move the playing entry into its desired slot. Non-current
// entries are inert playlist records in mpv -- nothing is demuxed or decoded
// until they become current -- so rebuilding them is cheap, and it keeps the
// transformation obviously correct for insertions, removals and reordering
// alike instead of resting on a minimal-diff argument. The whole thing is a
// no-op when the playlist already matches, so a steady queue costs nothing.

#[derive(Debug, PartialEq, Eq)]
pub enum PlaylistOp {
    // Remove the entry at this index. Emitted in descending index order so each
    // removal cannot shift the index of a later one.
    Remove(i64),
    // Append a media path to the end of the playlist.
    Append(String),
    // mpv's `playlist-move from to` inserts the entry BEFORE `to`, so moving an
    // entry to a higher index lands it at `to - 1`. `to` here is already the
    // value to hand mpv, not the resulting index.
    Move { from: i64, to: i64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum PlaylistSyncError {
    // The entry that is playing is not in the desired queue. Dropping it would
    // stop playback under the user, and silently keeping it would leave the
    // native queue permanently diverged from the one the UI shows indices for.
    // Neither is a decision this layer may take.
    CurrentEntryNotInDesired { path: String },
}

/// Ops that transform `current` into `desired` while the entry at
/// `current_index` keeps playing.
///
/// `current_index` is mpv's `playlist-pos`, or None when nothing is loaded (an
/// empty playlist, or a session whose first file has not resolved yet).
pub fn reconcile_playlist(
    current: &[String],
    current_index: Option<i64>,
    desired: &[String],
) -> Result<Vec<PlaylistOp>, PlaylistSyncError> {
    if current == desired {
        return Ok(Vec::new());
    }

    let kept = current_index
        .filter(|index| *index >= 0)
        .and_then(|index| current.get(index as usize))
        .map(|path| (index_of(current, path, current_index), path.clone()));

    let Some((kept_index, kept_path)) = kept else {
        // Nothing is playing: the playlist can be rebuilt outright.
        let mut ops: Vec<PlaylistOp> = (0..current.len() as i64)
            .rev()
            .map(PlaylistOp::Remove)
            .collect();
        ops.extend(desired.iter().cloned().map(PlaylistOp::Append));

        return Ok(ops);
    };

    let Some(kept_target) = desired.iter().position(|path| *path == kept_path) else {
        return Err(PlaylistSyncError::CurrentEntryNotInDesired { path: kept_path });
    };

    // Strip everything but the playing entry, highest index first so no removal
    // invalidates a pending one.
    let mut ops: Vec<PlaylistOp> = (0..current.len() as i64)
        .rev()
        .filter(|index| *index != kept_index)
        .map(PlaylistOp::Remove)
        .collect();

    // The playing entry is now the only one left, at index 0. Append the rest of
    // the desired queue in order around it.
    for path in desired.iter().filter(|path| **path != kept_path) {
        ops.push(PlaylistOp::Append(path.clone()));
    }

    // Finally slide the playing entry from index 0 into its desired slot. Moving
    // to a higher index lands one short, hence the +1.
    if kept_target > 0 {
        ops.push(PlaylistOp::Move {
            from: 0,
            to: kept_target as i64 + 1,
        });
    }

    Ok(ops)
}

// The playing entry is identified by index, but a queue can legitimately hold
// the same path twice; resolve by index so the right occurrence is kept.
fn index_of(current: &[String], path: &str, current_index: Option<i64>) -> i64 {
    match current_index {
        Some(index)
            if index >= 0 && current.get(index as usize).map(String::as_str) == Some(path) =>
        {
            index
        }
        _ => current
            .iter()
            .position(|entry| entry == path)
            .map(|index| index as i64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    // Applies the ops the way mpv would, so every case below asserts the real
    // resulting queue rather than an op sequence that merely looks right.
    fn apply(current: &[String], ops: &[PlaylistOp]) -> Vec<String> {
        let mut queue = current.to_vec();

        for op in ops {
            match op {
                PlaylistOp::Remove(index) => {
                    queue.remove(*index as usize);
                }
                PlaylistOp::Append(path) => queue.push(path.clone()),
                PlaylistOp::Move { from, to } => {
                    let entry = queue.remove(*from as usize);
                    let target = if *to > *from { *to - 1 } else { *to };
                    queue.insert(target as usize, entry);
                }
            }
        }

        queue
    }

    #[test]
    fn matching_playlist_needs_no_work() {
        let current = paths(&["a", "b", "c"]);

        assert_eq!(
            reconcile_playlist(&current, Some(1), &current),
            Ok(Vec::new())
        );
    }

    // The reported defect: the tail resolved after the session was created, so
    // the native playlist held only the first entry while the sidebar offered
    // three rows.
    #[test]
    fn late_tail_is_appended_around_the_playing_entry() {
        let current = paths(&["a"]);
        let desired = paths(&["a", "b", "c"]);

        let ops = reconcile_playlist(&current, Some(0), &desired).expect("reconcile");

        assert_eq!(apply(&current, &ops), desired);
        assert!(!ops.iter().any(|op| matches!(op, PlaylistOp::Remove(_))));
    }

    #[test]
    fn entries_before_the_playing_one_are_restored_without_reloading_it() {
        let current = paths(&["b"]);
        let desired = paths(&["a", "b", "c"]);

        let ops = reconcile_playlist(&current, Some(0), &desired).expect("reconcile");

        assert_eq!(apply(&current, &ops), desired);
        // "b" is playing: it must be moved into place, never removed and re-added.
        assert_eq!(
            ops.iter()
                .filter(|op| matches!(op, PlaylistOp::Remove(_)))
                .count(),
            0
        );
        assert!(ops.contains(&PlaylistOp::Move { from: 0, to: 2 }));
    }

    #[test]
    fn removed_members_leave_the_queue() {
        let current = paths(&["a", "b", "c"]);
        let desired = paths(&["a", "c"]);

        let ops = reconcile_playlist(&current, Some(0), &desired).expect("reconcile");

        assert_eq!(apply(&current, &ops), desired);
    }

    #[test]
    fn reordering_keeps_the_playing_entry_live() {
        let current = paths(&["a", "b", "c"]);
        let desired = paths(&["c", "b", "a"]);

        let ops = reconcile_playlist(&current, Some(1), &desired).expect("reconcile");

        assert_eq!(apply(&current, &ops), desired);
    }

    #[test]
    fn playing_entry_can_move_to_the_front() {
        let current = paths(&["a", "b", "c"]);
        let desired = paths(&["c", "a", "b"]);

        let ops = reconcile_playlist(&current, Some(2), &desired).expect("reconcile");

        assert_eq!(apply(&current, &ops), desired);
    }

    #[test]
    fn empty_playlist_is_built_from_nothing() {
        let ops = reconcile_playlist(&[], None, &paths(&["a", "b"])).expect("reconcile");

        assert_eq!(apply(&[], &ops), paths(&["a", "b"]));
    }

    #[test]
    fn queue_can_be_emptied_when_nothing_is_playing() {
        let current = paths(&["a", "b"]);

        let ops = reconcile_playlist(&current, None, &[]).expect("reconcile");

        assert_eq!(apply(&current, &ops), Vec::<String>::new());
    }

    // Dropping the entry under the user, or silently keeping a queue the UI does
    // not know about, are both wrong. The caller has to decide.
    #[test]
    fn dropping_the_playing_entry_is_refused() {
        let current = paths(&["a", "b"]);

        assert_eq!(
            reconcile_playlist(&current, Some(0), &paths(&["b", "c"])),
            Err(PlaylistSyncError::CurrentEntryNotInDesired {
                path: "a".to_owned()
            })
        );
    }

    #[test]
    fn duplicate_paths_keep_the_occurrence_that_is_playing() {
        let current = paths(&["a", "b", "a"]);
        let desired = paths(&["a", "b", "a"]);

        assert_eq!(
            reconcile_playlist(&current, Some(2), &desired),
            Ok(Vec::new())
        );
    }
}
