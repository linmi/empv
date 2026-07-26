#!/usr/bin/env node
/* oxlint-disable no-console -- smoke CLI 脚本：console 是其面向终端的输出通道 */
//
// linux-smoke.mjs — runtime smoke test for the freshly compiled Linux
// 'window' embedded-mpv addon. Run under a real X display (xvfb-run) by the
// "libmpv native compile gate" workflow's linux-smoke job:
//
//   xvfb-run -a node --experimental-strip-types \
//     scripts/embedded-mpv/linux-smoke.mjs <fixture.mp4>
//
// It loads build/Release/empv.node DIRECTLY (not through the staged
// runtime resolver in src/runtime.ts), validates it with the real TypeScript
// contract normalizer, and drives a real mpv playback of a tiny generated
// fixture through initial playback, EOF, restart, and playlist behavior.
//
// WHY THE DIRECT createRequire LOAD (not loadEmbeddedLibMpvAddon):
//   src/runtime.ts::resolveRuntime() only accepts the addon staged under
//   packages/empv/vendor/embedded-mpv/<platform>-<arch> alongside a vendored
//   LGPL libmpv runtime. CI has NO vendored runtime — it compiles the addon
//   against the DISTRO's libmpv-dev and links the system libmpv.so.2. So the
//   resolver would reject this addon. We bypass it and require the Cargo/napi
//   output path straight, exactly like loadEmbeddedLibMpvAddonFromPath does
//   internally, then run the same normalize checks the resolver would.
//
// SCOPE — SESSION half only:
//   This exercises the session-side facet (mpv init + its own unparented X11
//   video window + playback). It does NOT exercise the presenter-side facet
//   (createPresenter / adoptVideoWindow reparenting the video window into an app
//   window): that needs a real parent X window id, and Node has no X11 binding
//   to create one without pulling a heavy native dependency. Presenter
//   reparenting therefore remains RUNTIME-UNVERIFIED (compile-verified only).
//   See the linux-smoke job comment in the workflow.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { normalizeEmbeddedAddon } from '../../src/embedded.ts'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

// scripts/embedded-mpv/ -> ../../native/build/Release/empv.node
const ADDON_PATH = path.resolve(scriptDir, '../../native/build/Release/empv.node')

// Total wall-clock budget for reaching 'playing' AND position >= 1s. The job
// itself is capped at ~15 min; this is the inner, meaningful playback budget.
const PLAYBACK_BUDGET_MS = 20_000
const EOF_BUDGET_MS = 20_000
const RESTART_BUDGET_MS = 10_000
const PLAYLIST_BUDGET_MS = 20_000
const PLAYLIST_STABILITY_MS = 3_000
const LOCATE_STABILITY_MS = 2_000
const POLL_INTERVAL_MS = 250
const MIN_POSITION_SECONDS = 1
const RESTARTED_POSITION_SECONDS = 0.5

function log(message) {
  process.stdout.write(`[linux-smoke] ${message}\n`)
}

function fail(message) {
  // Loud, single-line failure the CI log grep can key on. Thrown so the
  // top-level catch prints the stack and exits non-zero.
  throw new Error(message)
}

async function main() {
  const fixturePath = process.argv[2]
  if (!fixturePath) {
    fail(
      'Usage: node --experimental-strip-types linux-smoke.mjs <fixture.mp4> ' +
        '(fixture path is required).'
    )
  }
  const fixture = path.resolve(fixturePath)
  log(`fixture: ${fixture}`)
  const queueDir = mkdtempSync(path.join(tmpdir(), 'empv-linux-smoke-queue-'))
  const playlistCopies = [1, 2].map((index) => {
    const copyPath = path.join(queueDir, `entry-${index + 1}.mp4`)
    copyFileSync(fixture, copyPath)
    return copyPath
  })
  log(`queue:   ${playlistCopies.join(', ')}`)
  log(`addon:   ${ADDON_PATH}`)

  if (!process.env.DISPLAY) {
    fail(
      'DISPLAY is not set. This smoke test must run under xvfb-run (or a real X ' +
        'server); the session backend refuses to create its X11 video window ' +
        'without a display.'
    )
  }
  log(`DISPLAY=${process.env.DISPLAY}`)

  // 0. Load the addon directly. A load failure (missing .node, unresolved
  //    libmpv.so.2, N-API mismatch) throws here and fails the job loudly.
  let normalized
  try {
    normalized = normalizeEmbeddedAddon(require(ADDON_PATH))
  } catch (error) {
    fail(
      `Failed to load or normalize the embedded mpv addon from ${ADDON_PATH}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }
  const { addon, presentationKind } = normalized
  log('addon loaded and normalized against the embedded contract')

  // 1. Presentation kind + support probe (fixed by the Linux backend).
  assert.equal(
    presentationKind,
    'window',
    `getPresentationKind() must be 'window' on Linux, got ${String(presentationKind)}`
  )
  log("getPresentationKind() === 'window' OK")

  const supported = addon.isSupported()
  assert.equal(supported, true, `isSupported() must be true under X, got ${String(supported)}`)
  log('isSupported() === true OK')

  // 2. Create a session. The backend creates its OWN unparented, override-
  //    redirect, unmapped X11 video window and binds mpv to it via `wid`; no
  //    parent window is needed for the session half. onSnapshotChanged/onFrame
  //    are accepted for contract parity — we poll getSessionSnapshot instead, and
  //    onFrame never fires on 'window'.
  let snapshotEvents = 0
  const sessionId = await addon.createSession(
    { volume: 1.0 },
    () => {
      snapshotEvents += 1
    },
    () => {}
  )
  assert.equal(typeof sessionId, 'string', 'createSession must resolve to a session id string')
  assert.ok(sessionId.length > 0, 'createSession must resolve to a non-empty session id')
  log(`createSession OK -> ${sessionId}`)

  let disposed = false
  const dispose = async () => {
    if (disposed) {
      return
    }
    disposed = true
    await addon.disposeSession(sessionId)
    log('disposeSession resolved OK')
  }

  try {
    // 3. The session's own X11 video window id must be a real, non-null number.
    //    This is what the presenter would reparent into the app window.
    const windowHandle = addon.getVideoWindowHandle(sessionId)
    assert.equal(
      typeof windowHandle,
      'number',
      `getVideoWindowHandle() must return a number, got ${String(windowHandle)}`
    )
    assert.ok(
      Number.isFinite(windowHandle) && windowHandle > 0,
      `getVideoWindowHandle() must return a real X11 window id (> 0), got ${windowHandle}`
    )
    log(`getVideoWindowHandle() === ${windowHandle} OK`)

    // 4. Load the fixture and force play.
    addon.loadPlayback(sessionId, { streamUrl: fixture, title: 'linux-smoke fixture' })
    log('loadPlayback issued')
    addon.setPaused(sessionId, false)
    log('setPaused(false) issued')

    // 5. Poll until status 'playing' AND position advances past 1s, within the
    //    budget. A snapshot 'error' status short-circuits with mpv's reason (the
    //    most likely first-run failure: gpu VO cannot init under Xvfb software
    //    GL). We distinguish "never reached playing" from "position never
    //    advanced" so the CI log says which invariant broke.
    const deadline = Date.now() + PLAYBACK_BUDGET_MS
    let sawPlaying = false
    let maxPosition = 0
    let lastSnapshot = null
    while (Date.now() < deadline) {
      const snapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(snapshot, 'getSessionSnapshot returned null for a live session')
      lastSnapshot = snapshot

      if (snapshot.status === 'error') {
        fail(
          `Session entered 'error' status: ${snapshot.error || '(no error message)'}. ` +
            'On CI this most often means mpv could not initialize the gpu video ' +
            'output under Xvfb — verify LIBGL_ALWAYS_SOFTWARE=1 and that ' +
            'libgl1-mesa-dri (software GL) is installed.'
        )
      }
      if (snapshot.status === 'playing') {
        sawPlaying = true
      }
      if (typeof snapshot.positionSeconds === 'number') {
        maxPosition = Math.max(maxPosition, snapshot.positionSeconds)
      }
      if (sawPlaying && maxPosition >= MIN_POSITION_SECONDS) {
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }

    if (!sawPlaying) {
      fail(
        `Playback never reached 'playing' within ${PLAYBACK_BUDGET_MS}ms. ` +
          `Last status: ${lastSnapshot ? lastSnapshot.status : '(none)'}, ` +
          `position: ${maxPosition}s.`
      )
    }
    if (maxPosition < MIN_POSITION_SECONDS) {
      fail(
        `Reached 'playing' but positionSeconds never advanced to ` +
          `${MIN_POSITION_SECONDS}s within ${PLAYBACK_BUDGET_MS}ms (max seen: ` +
          `${maxPosition}s). mpv is loaded but the playback clock is not moving.`
      )
    }
    log(`playback reached 'playing' and position advanced to ${maxPosition}s OK`)
    log(`(${snapshotEvents} snapshot-changed notifications observed)`)

    // 6. hwdec field must exist. Its value may be software ('no'/'') in CI — we
    //    do NOT assert hardware decode, only that the field is present in the
    //    contract shape.
    const snapshot = addon.getSessionSnapshot(sessionId)
    assert.ok(snapshot, 'getSessionSnapshot returned null after playback started')
    assert.ok('hwdecCurrent' in snapshot, "snapshot is missing the 'hwdecCurrent' field")
    assert.equal(
      typeof snapshot.hwdecCurrent,
      'string',
      `hwdecCurrent must be a string, got ${typeof snapshot.hwdecCurrent}`
    )
    log(`hwdecCurrent field present: '${snapshot.hwdecCurrent}' OK (value not asserted)`)

    // 7. keep-open=yes reaches the final entry's EOF by setting eof-reached +
    //    pause; it does not reliably emit END_FILE. The session contract must
    //    nevertheless expose a distinct terminal state instead of reporting an
    //    indistinguishable user pause.
    const eofDeadline = Date.now() + EOF_BUDGET_MS
    let endedSnapshot = null
    while (Date.now() < eofDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while waiting for EOF')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while waiting for EOF: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.status === 'ended') {
        endedSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!endedSnapshot) {
      const lastEofSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `Playback never reached 'ended' within ${EOF_BUDGET_MS}ms. ` +
          `Last status: ${lastEofSnapshot ? lastEofSnapshot.status : '(none)'}, ` +
          `position: ${lastEofSnapshot ? lastEofSnapshot.positionSeconds : '(none)'}.`
      )
    }
    assert.equal(endedSnapshot.status, 'ended')
    assert.ok(
      endedSnapshot.durationSeconds === null ||
        endedSnapshot.positionSeconds >= endedSnapshot.durationSeconds - 1,
      `Ended snapshot must remain at the media tail; position=${endedSnapshot.positionSeconds}, ` +
        `duration=${String(endedSnapshot.durationSeconds)}.`
    )
    log(`EOF surfaced as 'ended' at ${endedSnapshot.positionSeconds}s OK`)

    // 8. Replay is one native command chain: seek to zero, then unpause in
    //    order. EOF must clear and the clock must advance from the beginning.
    addon.replay(sessionId)
    const restartDeadline = Date.now() + RESTART_BUDGET_MS
    let restartedSnapshot = null
    while (Date.now() < restartDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while waiting for restart')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while restarting after EOF: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (
        nextSnapshot.status === 'playing' &&
        nextSnapshot.positionSeconds >= RESTARTED_POSITION_SECONDS &&
        nextSnapshot.positionSeconds < endedSnapshot.positionSeconds - 1
      ) {
        restartedSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!restartedSnapshot) {
      const lastRestartSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `Playback did not restart from the beginning within ${RESTART_BUDGET_MS}ms. ` +
          `Last status: ${lastRestartSnapshot ? lastRestartSnapshot.status : '(none)'}, ` +
          `position: ${lastRestartSnapshot ? lastRestartSnapshot.positionSeconds : '(none)'}.`
      )
    }
    log(`seek(0) + play restarted and advanced to ${restartedSnapshot.positionSeconds}s OK`)

    // 9. Grow the queue to a second entry. The initialization policy is
    //    keep-open=yes, so seeking the current entry to its tail must advance
    //    into entry 2 and resume playback.
    //
    //    playlistSync takes the tail AFTER the session's own loaded source --
    //    native prepends the path it actually handed mpv -- and reconciles by
    //    media path, so the tail needs its own distinct file rather than a
    //    repeat of the fixture's path.
    addon.playlistSync(sessionId, [{ mediaPath: playlistCopies[0], title: 'entry-2' }])
    const appendSecondDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let twoEntrySnapshot = null
    while (Date.now() < appendSecondDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null after appending entry 2')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' after appending entry 2: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistCount === 2) {
        twoEntrySnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!twoEntrySnapshot) {
      const lastPlaylistSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `playlistCount did not reach 2 within ${PLAYLIST_BUDGET_MS}ms after syncing entry 2. ` +
          `Last count: ${lastPlaylistSnapshot ? lastPlaylistSnapshot.playlistCount : '(none)'}.`
      )
    }
    log('playlistSync(entry-2) surfaced playlistCount === 2 OK')

    addon.seek(sessionId, 4.5)
    const autoAdvanceDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let autoAdvancedSnapshot = null
    while (Date.now() < autoAdvanceDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while waiting for auto-advance')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while auto-advancing to entry 2: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistPosition === 1 && nextSnapshot.status === 'playing') {
        autoAdvancedSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!autoAdvancedSnapshot) {
      const lastPlaylistSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `Default playlist auto-advance did not reach entry 2 playing within ` +
          `${PLAYLIST_BUDGET_MS}ms. Last index: ` +
          `${lastPlaylistSnapshot ? lastPlaylistSnapshot.playlistPosition : '(none)'}, ` +
          `status: ${lastPlaylistSnapshot ? lastPlaylistSnapshot.status : '(none)'}.`
      )
    }
    log("default auto-advance reached playlistPosition === 1 with status 'playing' OK")

    // 10. keep-open=always must stop on entry 2 rather than advancing to the
    //     newly appended entry 3. Hold a three-second stability window after
    //     reaching ended so a delayed automatic transition cannot pass.
    addon.playlistSync(sessionId, [
      { mediaPath: playlistCopies[0], title: 'entry-2' },
      { mediaPath: playlistCopies[1], title: 'entry-3' }
    ])
    const appendThirdDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let threeEntrySnapshot = null
    while (Date.now() < appendThirdDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null after appending entry 3')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' after appending entry 3: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistCount === 3) {
        threeEntrySnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!threeEntrySnapshot) {
      const lastPlaylistSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `playlistCount did not reach 3 within ${PLAYLIST_BUDGET_MS}ms after syncing entry 3. ` +
          `Last count: ${lastPlaylistSnapshot ? lastPlaylistSnapshot.playlistCount : '(none)'}.`
      )
    }

    addon.setPlaylistAutoAdvance(sessionId, false)
    addon.seek(sessionId, 4.5)
    const noAdvanceDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let stoppedAtSecondSnapshot = null
    while (Date.now() < noAdvanceDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while waiting for playlist stop')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while auto-advance was disabled: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistPosition === 1 && nextSnapshot.status === 'ended') {
        stoppedAtSecondSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!stoppedAtSecondSnapshot) {
      const lastPlaylistSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `Disabled playlist auto-advance did not end on entry 2 within ` +
          `${PLAYLIST_BUDGET_MS}ms. Last index: ` +
          `${lastPlaylistSnapshot ? lastPlaylistSnapshot.playlistPosition : '(none)'}, ` +
          `status: ${lastPlaylistSnapshot ? lastPlaylistSnapshot.status : '(none)'}.`
      )
    }

    const stabilityDeadline = Date.now() + PLAYLIST_STABILITY_MS
    while (Date.now() < stabilityDeadline) {
      const stableSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(stableSnapshot, 'getSessionSnapshot returned null during playlist stability window')
      assert.equal(
        stableSnapshot.playlistPosition,
        1,
        `Disabled auto-advance moved off entry 2 during the ${PLAYLIST_STABILITY_MS}ms ` +
          `stability window (index=${String(stableSnapshot.playlistPosition)}).`
      )
      await sleep(POLL_INTERVAL_MS)
    }
    log('setPlaylistAutoAdvance(false) ended on playlistPosition === 1 and remained stable OK')

    // 11. Re-enable auto-advance and explicitly jump to entry 3. Explicit jumps
    //     always play regardless of the prior keep-open policy.
    addon.setPlaylistAutoAdvance(sessionId, true)
    addon.playlistPlayIndex(sessionId, 2)
    const explicitJumpDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let jumpedSnapshot = null
    while (Date.now() < explicitJumpDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null after explicit playlist jump')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' after explicit playlist jump: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistPosition === 2 && nextSnapshot.status === 'playing') {
        jumpedSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!jumpedSnapshot) {
      const lastPlaylistSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `Explicit playlist jump did not reach entry 3 playing within ` +
          `${PLAYLIST_BUDGET_MS}ms. Last index: ` +
          `${lastPlaylistSnapshot ? lastPlaylistSnapshot.playlistPosition : '(none)'}, ` +
          `status: ${lastPlaylistSnapshot ? lastPlaylistSnapshot.status : '(none)'}.`
      )
    }
    log("playlistPlayIndex(2) reached playlistPosition === 2 with status 'playing' OK")

    // 12. captureFrame via mpv's screenshot-raw path. Under vo=gpu + software GL in
    //    Xvfb, mpv may legitimately be unable to read back a frame; per the task
    //    that is a log-and-SKIP, not a failure. When it DOES return a frame we
    //    assert plausible dimensions and a matching RGBA buffer size.
    const frame = addon.captureFrame(sessionId)
    if (frame === null) {
      log(
        'captureFrame() returned null — SKIP frame assertion. Reason: mpv could ' +
          'not produce a screenshot-raw frame in this headless software-GL ' +
          'environment. This does not fail the smoke test.'
      )
    } else {
      assert.ok(
        Number.isInteger(frame.widthPixels) && frame.widthPixels > 0,
        `captureFrame widthPixels must be a positive integer, got ${frame.widthPixels}`
      )
      assert.ok(
        Number.isInteger(frame.heightPixels) && frame.heightPixels > 0,
        `captureFrame heightPixels must be a positive integer, got ${frame.heightPixels}`
      )
      assert.ok(Buffer.isBuffer(frame.data), 'captureFrame data must be a Buffer')
      const expectedBytes = frame.widthPixels * frame.heightPixels * 4
      assert.equal(
        frame.data.length,
        expectedBytes,
        `captureFrame data length (${frame.data.length}) must equal ` +
          `width*height*4 (${expectedBytes})`
      )
      log(
        `captureFrame() OK -> ${frame.widthPixels}x${frame.heightPixels}, ` +
          `${frame.data.length} bytes RGBA`
      )
    }

    // 14. playlistLocateIndex switches the active entry WITHOUT touching pause —
    //     the "collection opens on its poster, then positions to the opening
    //     entry" primitive that playlistPlayIndex (which always resumes) cannot
    //     express. Pause first, then locate to another entry: playlistPosition
    //     must move to the target while the session stays non-playing (pause is
    //     preserved) and the clock never advances. Keeping the session paused
    //     across the entry switch is the locate semantic invariant.
    addon.setPaused(sessionId, true)
    const pauseDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let pausedForLocateSnapshot = null
    while (Date.now() < pauseDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while pausing before locate')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while pausing before locate: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistPosition === 2 && nextSnapshot.status === 'paused') {
        pausedForLocateSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!pausedForLocateSnapshot) {
      const lastSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `setPaused(true) did not reach a paused entry 3 within ${PLAYLIST_BUDGET_MS}ms. ` +
          `Last index: ${lastSnapshot ? lastSnapshot.playlistPosition : '(none)'}, ` +
          `status: ${lastSnapshot ? lastSnapshot.status : '(none)'}.`
      )
    }

    addon.playlistLocateIndex(sessionId, 0)
    const locateDeadline = Date.now() + PLAYLIST_BUDGET_MS
    let locatedSnapshot = null
    while (Date.now() < locateDeadline) {
      const nextSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(nextSnapshot, 'getSessionSnapshot returned null while waiting for locate')
      if (nextSnapshot.status === 'error') {
        fail(
          `Session entered 'error' while locating the playlist entry: ` +
            `${nextSnapshot.error || '(no error message)'}.`
        )
      }
      if (nextSnapshot.playlistPosition === 0 && nextSnapshot.status === 'paused') {
        locatedSnapshot = nextSnapshot
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!locatedSnapshot) {
      const lastSnapshot = addon.getSessionSnapshot(sessionId)
      fail(
        `playlistLocateIndex(0) did not reach a paused entry 1 within ${PLAYLIST_BUDGET_MS}ms. ` +
          `Last index: ${lastSnapshot ? lastSnapshot.playlistPosition : '(none)'}, ` +
          `status: ${lastSnapshot ? lastSnapshot.status : '(none)'}.`
      )
    }

    const locatedPosition = locatedSnapshot.positionSeconds
    const locateStabilityDeadline = Date.now() + LOCATE_STABILITY_MS
    while (Date.now() < locateStabilityDeadline) {
      const stableSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(
        stableSnapshot,
        'getSessionSnapshot returned null during the locate stability window'
      )
      assert.equal(
        stableSnapshot.playlistPosition,
        0,
        `Locate moved off the target entry (index=${String(stableSnapshot.playlistPosition)}).`
      )
      assert.notEqual(
        stableSnapshot.status,
        'playing',
        `Locate resumed playback instead of preserving pause (status=${stableSnapshot.status}).`
      )
      assert.ok(
        stableSnapshot.positionSeconds <= locatedPosition + 0.3,
        `Locate advanced the clock while paused (position=${stableSnapshot.positionSeconds}, ` +
          `located=${locatedPosition}).`
      )
      await sleep(POLL_INTERVAL_MS)
    }
    log(
      'playlistLocateIndex(0) switched the entry while preserving pause ' +
        '(never played, clock frozen) OK'
    )
  } finally {
    // 13. disposeSession must resolve even on the failure path so the process can
    //    tear mpv down before exit.
    await dispose()
    rmSync(queueDir, { recursive: true, force: true })
  }

  log('SMOKE PASS')
}

main()
  .then(() => {
    // mpv threads are torn down by disposeSession; force a clean, deterministic
    // exit so a lingering handle can never hang the job.
    process.exit(0)
  })
  .catch((error) => {
    console.error(
      `[linux-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`
    )
    process.exit(1)
  })
