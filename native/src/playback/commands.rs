use crate::mpv::handle::{MpvResult, OwnedMpvHandle};

pub fn replay(handle: &OwnedMpvHandle) -> MpvResult<()> {
    handle.command(
        "no-osd seek 0 absolute+exact; no-osd set pause no",
        "replay playback",
    )
}

pub fn play_playlist_index(handle: &OwnedMpvHandle, index: i64) -> MpvResult<()> {
    handle.command(&playlist_jump_command(index), "jump to the playlist entry")
}

pub fn locate_playlist_index(handle: &OwnedMpvHandle, index: i64) -> MpvResult<()> {
    handle.command(&playlist_locate_command(index), "locate the playlist entry")
}

// The target index must load BEFORE pause is cleared. mpv's `pause` is a global
// property, not per-file: when the previous entry sits paused at EOF under
// keep-open=always, clearing pause first makes mpv briefly resume at EOF, and
// the keep-open playloop asynchronously races to re-pause — a race that can land
// pause=true on the freshly loaded entry. Loading the index first drops the eof
// state, so the unpause no longer competes with keep-open.
fn playlist_jump_command(index: i64) -> String {
    format!("no-osd playlist-play-index {index}; no-osd set pause no")
}

// The pause-preserving counterpart of `playlist_jump_command`. mpv's
// `playlist-play-index` does not itself touch the global `pause` property, so a
// bare jump with no trailing `set pause no` leaves a paused session paused on the
// target entry's poster — that untouched pause IS the locate semantic. The jump
// variant deliberately appends `set pause no` to force play; locate must never
// carry that clause.
fn playlist_locate_command(index: i64) -> String {
    format!("no-osd playlist-play-index {index}")
}

pub fn playlist_index_in_range(index: i64, count: i64) -> bool {
    index >= 0 && index < count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playlist_range_rejects_both_edges() {
        assert!(!playlist_index_in_range(-1, 2));
        assert!(playlist_index_in_range(0, 2));
        assert!(playlist_index_in_range(1, 2));
        assert!(!playlist_index_in_range(2, 2));
    }

    #[test]
    fn playlist_jump_loads_index_before_clearing_pause() {
        // The load-then-unpause order is a correctness invariant against the
        // keep-open re-pause race (see playlist_jump_command), not a cosmetic
        // choice — the two clauses must never be swapped.
        assert_eq!(
            playlist_jump_command(3),
            "no-osd playlist-play-index 3; no-osd set pause no"
        );
    }

    #[test]
    fn playlist_locate_preserves_pause_state() {
        // Preserving the pause state is the semantic invariant of locate — the
        // mirror image of playlist_jump_command's forced unpause. The locate
        // command switches the entry and NOTHING else, so it must never carry a
        // `set pause` clause; adding one would turn locate into a play.
        let command = playlist_locate_command(3);
        assert_eq!(command, "no-osd playlist-play-index 3");
        assert!(
            !command.contains("set pause"),
            "locate must not touch pause: {command}"
        );
    }
}
