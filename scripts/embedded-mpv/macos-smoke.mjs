#!/usr/bin/env node
/* oxlint-disable no-console -- smoke CLI 脚本：console 是其面向终端的输出通道 */
//
// Runtime baseline for the macOS 'layer' backend. It loads the native
// addon directly, validates the real TypeScript contract, drives a generated
// five-second fixture through playback/EOF/replay/playlist behavior, and makes
// rendered-frame delivery plus RGBA readback hard requirements.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { normalizeEmbeddedAddon } from '../../src/embedded.ts'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const ADDON_PATH = path.resolve(scriptDir, '../../native/build/Release/empv.node')

const PLAYBACK_BUDGET_MS = 20_000
const EOF_BUDGET_MS = 20_000
const RESTART_BUDGET_MS = 10_000
const FRAME_BUDGET_MS = 20_000
const PLAYLIST_BUDGET_MS = 20_000
const PLAYLIST_STABILITY_MS = 3_000
const LOCATE_STABILITY_MS = 2_000
const POLL_INTERVAL_MS = 250
const MIN_POSITION_SECONDS = 1
const RESTARTED_POSITION_SECONDS = 0.5
const RENDER_WIDTH_PIXELS = 320
const RENDER_HEIGHT_PIXELS = 180

function log(message) {
  process.stdout.write(`[macos-smoke] ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function snapshotSummary(snapshot) {
  if (!snapshot) {
    return '(none)'
  }
  return JSON.stringify({
    status: snapshot.status,
    positionSeconds: snapshot.positionSeconds,
    durationSeconds: snapshot.durationSeconds,
    playlistPosition: snapshot.playlistPosition,
    playlistCount: snapshot.playlistCount,
    error: snapshot.error
  })
}

function verifyFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  if (probe.error?.code === 'ENOENT') {
    fail('ffmpeg is required to generate the macOS smoke fixture, but it was not found on PATH.')
  }
  if (probe.error) {
    fail(`Failed to execute ffmpeg: ${errorText(probe.error)}.`)
  }
  if (probe.status !== 0) {
    fail(
      `ffmpeg -version failed with status ${String(probe.status)}: ` +
        `${probe.stderr.trim() || '(no stderr)'}.`
    )
  }
}

function prepareFixture() {
  verifyFfmpeg()

  const suppliedPath = process.argv[2]
  if (suppliedPath) {
    const fixture = path.resolve(suppliedPath)
    if (!existsSync(fixture) || !statSync(fixture).isFile()) {
      fail(`The supplied fixture does not exist or is not a file: ${fixture}.`)
    }
    if (statSync(fixture).size === 0) {
      fail(`The supplied fixture is empty: ${fixture}.`)
    }
    return { fixture, cleanup: () => {} }
  }

  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'empv-macos-smoke-'))
  const fixture = path.join(fixtureDir, 'fixture.mp4')
  const generated = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=320x180:rate=30',
      '-pix_fmt',
      'yuv420p',
      fixture
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  if (generated.error) {
    rmSync(fixtureDir, { recursive: true, force: true })
    fail(`Failed to generate the ffmpeg fixture: ${errorText(generated.error)}.`)
  }
  if (generated.status !== 0 || !existsSync(fixture) || statSync(fixture).size === 0) {
    const stderr = generated.stderr.trim() || '(no stderr)'
    rmSync(fixtureDir, { recursive: true, force: true })
    fail(`ffmpeg fixture generation failed with status ${String(generated.status)}: ${stderr}.`)
  }

  return {
    fixture,
    cleanup: () => rmSync(fixtureDir, { recursive: true, force: true })
  }
}

// playlistSync reconciles by media path, so a queue needs distinct paths for
// distinct entries. Copy the fixture rather than repeating its path: a desired
// queue that repeats the playing entry's path does not currently materialize the
// duplicate, and this smoke is here to exercise queue growth, not that edge.
function preparePlaylistCopies(fixture, count) {
  const copyDir = mkdtempSync(path.join(tmpdir(), 'empv-macos-smoke-queue-'))
  const copies = []

  for (let index = 0; index < count; index += 1) {
    const copyPath = path.join(copyDir, `entry-${index + 2}.mp4`)
    copyFileSync(fixture, copyPath)
    copies.push(copyPath)
  }

  return {
    copies,
    cleanup: () => rmSync(copyDir, { recursive: true, force: true })
  }
}

async function waitForSnapshot(addon, sessionId, description, budgetMs, predicate) {
  const deadline = Date.now() + budgetMs
  let lastSnapshot = null
  while (Date.now() < deadline) {
    const snapshot = addon.getSessionSnapshot(sessionId)
    assert.ok(snapshot, `getSessionSnapshot returned null while waiting for ${description}`)
    lastSnapshot = snapshot
    if (snapshot.status === 'error') {
      fail(
        `Session entered 'error' while waiting for ${description}: ` +
          `${snapshot.error || '(no error message)'}.`
      )
    }
    if (predicate(snapshot)) {
      return snapshot
    }
    await sleep(POLL_INTERVAL_MS)
  }

  fail(
    `${description} did not complete within ${budgetMs}ms. ` +
      `Last snapshot: ${snapshotSummary(lastSnapshot)}.`
  )
}

async function waitForFrame(frameState) {
  const deadline = Date.now() + FRAME_BUDGET_MS
  while (Date.now() < deadline) {
    if (frameState.count >= 1) {
      return
    }
    await sleep(POLL_INTERVAL_MS)
  }
  fail(`onFrame did not fire within ${FRAME_BUDGET_MS}ms after rendering was enabled.`)
}

async function main() {
  if (process.platform !== 'darwin') {
    fail(`macos-smoke.mjs requires macOS, got ${process.platform}.`)
  }

  const preparedFixture = prepareFixture()
  const fixture = preparedFixture.fixture
  const preparedQueue = preparePlaylistCopies(fixture, 2)
  const playlistCopies = preparedQueue.copies
  log(`fixture: ${fixture}`)
  log(`queue:   ${playlistCopies.join(', ')}`)
  log(`addon:   ${ADDON_PATH}`)

  let normalized
  try {
    normalized = normalizeEmbeddedAddon(require(ADDON_PATH))
  } catch (error) {
    preparedQueue.cleanup()
    preparedFixture.cleanup()
    fail(
      `Failed to load or normalize the embedded mpv addon from ${ADDON_PATH}: ` +
        `${errorText(error)}`
    )
  }

  const { addon, presentationKind } = normalized
  assert.equal(
    presentationKind,
    'layer',
    `getPresentationKind() must be 'layer' on macOS, got ${String(presentationKind)}`
  )
  assert.equal(addon.isSupported(), true, 'isSupported() must be true on macOS')
  log("addon normalized; getPresentationKind() === 'layer' OK")

  const frameLinkService = `com.empv.macos-smoke.${process.pid}.${Date.now()}`
  addon.startPresenterLink(frameLinkService)
  addon.configureFrameLink(frameLinkService)
  log(`frame link configured: ${frameLinkService}`)

  let sessionId = null
  let disposed = false
  const frameState = {
    count: 0,
    surfaceIndex: null,
    poolGeneration: null,
    contentGeneration: null
  }

  try {
    let snapshotEvents = 0
    sessionId = await addon.createSession(
      { volume: 1.0 },
      () => {
        snapshotEvents += 1
      },
      (surfaceIndex, poolGeneration, contentGeneration) => {
        frameState.count += 1
        frameState.surfaceIndex = surfaceIndex
        frameState.poolGeneration = poolGeneration
        frameState.contentGeneration = contentGeneration
      }
    )
    assert.equal(typeof sessionId, 'string')
    assert.ok(sessionId.length > 0, 'createSession returned an empty session id')
    log(`createSession OK -> ${sessionId}`)

    addon.setRenderSize(sessionId, RENDER_WIDTH_PIXELS, RENDER_HEIGHT_PIXELS)
    log(
      `render size configured at ${RENDER_WIDTH_PIXELS}x${RENDER_HEIGHT_PIXELS}; ` +
        'initial presentation remains active'
    )

    addon.loadPlayback(sessionId, {
      streamUrl: fixture,
      title: 'macos-smoke fixture'
    })
    addon.setPaused(sessionId, false)

    const playingSnapshot = await waitForSnapshot(
      addon,
      sessionId,
      'playing playback with an advancing clock',
      PLAYBACK_BUDGET_MS,
      (snapshot) =>
        snapshot.status === 'playing' && snapshot.positionSeconds >= MIN_POSITION_SECONDS
    )
    log(`playback advanced to ${playingSnapshot.positionSeconds}s OK`)
    log(`(${snapshotEvents} snapshot notifications observed)`)

    await waitForFrame(frameState)
    assert.ok(
      Number.isInteger(frameState.surfaceIndex) && frameState.surfaceIndex >= 0,
      `onFrame surfaceIndex must be a non-negative integer, got ${String(frameState.surfaceIndex)}`
    )
    assert.ok(
      Number.isFinite(frameState.poolGeneration) && frameState.poolGeneration > 0,
      `onFrame poolGeneration must be positive, got ${String(frameState.poolGeneration)}`
    )
    assert.ok(
      Number.isFinite(frameState.contentGeneration) && frameState.contentGeneration > 0,
      `onFrame contentGeneration must be positive, got ${String(frameState.contentGeneration)}`
    )
    log(`onFrame fired ${frameState.count} time(s) OK`)

    const capturedFrame = addon.captureFrame(sessionId)
    assert.notEqual(
      capturedFrame,
      null,
      'captureFrame() must return a frame after onFrame has fired'
    )
    assert.ok(
      Number.isInteger(capturedFrame.widthPixels) && capturedFrame.widthPixels > 0,
      `captureFrame widthPixels must be a positive integer, got ${capturedFrame.widthPixels}`
    )
    assert.ok(
      Number.isInteger(capturedFrame.heightPixels) && capturedFrame.heightPixels > 0,
      `captureFrame heightPixels must be a positive integer, got ${capturedFrame.heightPixels}`
    )
    assert.ok(Buffer.isBuffer(capturedFrame.data), 'captureFrame data must be a Buffer')
    const expectedBytes = capturedFrame.widthPixels * capturedFrame.heightPixels * 4
    assert.equal(
      capturedFrame.data.length,
      expectedBytes,
      `captureFrame data length (${capturedFrame.data.length}) must equal ` +
        `width*height*4 (${expectedBytes})`
    )
    log(
      `captureFrame OK -> ${capturedFrame.widthPixels}x${capturedFrame.heightPixels}, ` +
        `${capturedFrame.data.length} bytes RGBA`
    )

    const contractSnapshot = addon.getSessionSnapshot(sessionId)
    assert.ok(contractSnapshot, 'getSessionSnapshot returned null after playback started')
    assert.ok('hwdecCurrent' in contractSnapshot, "snapshot is missing the 'hwdecCurrent' field")
    assert.equal(typeof contractSnapshot.hwdecCurrent, 'string')

    const endedSnapshot = await waitForSnapshot(
      addon,
      sessionId,
      "terminal status 'ended'",
      EOF_BUDGET_MS,
      (snapshot) => snapshot.status === 'ended'
    )
    assert.ok(
      endedSnapshot.durationSeconds === null ||
        endedSnapshot.positionSeconds >= endedSnapshot.durationSeconds - 1,
      `Ended snapshot must remain at the media tail: ${snapshotSummary(endedSnapshot)}`
    )
    log(`EOF surfaced as 'ended' at ${endedSnapshot.positionSeconds}s OK`)

    addon.replay(sessionId)
    const restartedSnapshot = await waitForSnapshot(
      addon,
      sessionId,
      'replay from the beginning',
      RESTART_BUDGET_MS,
      (snapshot) =>
        snapshot.status === 'playing' &&
        snapshot.positionSeconds >= RESTARTED_POSITION_SECONDS &&
        snapshot.positionSeconds < endedSnapshot.positionSeconds - 1
    )
    log(`replay restarted and advanced to ${restartedSnapshot.positionSeconds}s OK`)

    // The tail only: entry 0 is the session's own loaded source and native
    // prepends the path it actually handed mpv.
    addon.playlistSync(sessionId, [{ mediaPath: playlistCopies[0], title: 'entry-2' }])
    await waitForSnapshot(
      addon,
      sessionId,
      'playlistCount === 2',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistCount === 2
    )
    addon.seek(sessionId, 4.5)
    await waitForSnapshot(
      addon,
      sessionId,
      'default auto-advance to entry 2',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistPosition === 1 && snapshot.status === 'playing'
    )
    log("default auto-advance reached entry 2 with status 'playing' OK")

    addon.playlistSync(sessionId, [
      { mediaPath: playlistCopies[0], title: 'entry-2' },
      { mediaPath: playlistCopies[1], title: 'entry-3' }
    ])
    await waitForSnapshot(
      addon,
      sessionId,
      'playlistCount === 3',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistCount === 3
    )
    addon.setPlaylistAutoAdvance(sessionId, false)
    addon.seek(sessionId, 4.5)
    await waitForSnapshot(
      addon,
      sessionId,
      'disabled auto-advance ending on entry 2',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistPosition === 1 && snapshot.status === 'ended'
    )

    const stabilityDeadline = Date.now() + PLAYLIST_STABILITY_MS
    while (Date.now() < stabilityDeadline) {
      const stableSnapshot = addon.getSessionSnapshot(sessionId)
      assert.ok(stableSnapshot, 'getSessionSnapshot returned null during playlist stability window')
      assert.equal(
        stableSnapshot.playlistPosition,
        1,
        `Disabled auto-advance moved off entry 2: ${snapshotSummary(stableSnapshot)}`
      )
      assert.equal(
        stableSnapshot.status,
        'ended',
        `Disabled auto-advance left terminal status: ${snapshotSummary(stableSnapshot)}`
      )
      await sleep(POLL_INTERVAL_MS)
    }
    log('disabled auto-advance remained ended on entry 2 for 3 seconds OK')

    // The previously-missing entry state: an entry has ENDED under keep-open with
    // auto-advance still OFF, and the user jumps directly — so the jump command
    // itself is what must resume playback. This is exactly the window where
    // clearing pause before loading the target raced the keep-open re-pause and
    // stranded the new entry paused (Defect B), and where a stale cross-file
    // eof=true could re-latch Ended (Defect C). Keep auto-advance OFF here; the
    // later explicit-jump segment re-enables it and would otherwise mask this.
    addon.playlistPlayIndex(sessionId, 0)
    const resumedSnapshot = await waitForSnapshot(
      addon,
      sessionId,
      'auto-advance OFF jump from an ended entry resumes playing near the start',
      PLAYLIST_BUDGET_MS,
      (snapshot) =>
        snapshot.playlistPosition === 0 &&
        snapshot.status === 'playing' &&
        snapshot.positionSeconds < MIN_POSITION_SECONDS
    )
    const resumedPosition = resumedSnapshot.positionSeconds
    await waitForSnapshot(
      addon,
      sessionId,
      'jumped entry clock advances after an auto-advance OFF jump',
      PLAYLIST_BUDGET_MS,
      (snapshot) =>
        snapshot.playlistPosition === 0 &&
        snapshot.status === 'playing' &&
        snapshot.positionSeconds > resumedPosition + 0.3
    )
    log("auto-advance OFF jump from ended resumed 'playing' and advanced the clock OK")

    addon.setPlaylistAutoAdvance(sessionId, true)
    addon.playlistPlayIndex(sessionId, 2)
    await waitForSnapshot(
      addon,
      sessionId,
      'explicit jump to entry 3',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistPosition === 2 && snapshot.status === 'playing'
    )
    log("playlistPlayIndex(2) reached entry 3 with status 'playing' OK")

    // playlistLocateIndex switches the active entry WITHOUT touching pause — the
    // "collection opens on its poster, then positions to the opening entry"
    // primitive that playlistPlayIndex (which always resumes) cannot express.
    // Deliberately pause first, then locate to another entry: playlistPosition
    // must move to the target while the session stays non-playing (pause is
    // preserved) and the clock never advances. Keeping the session paused across
    // the entry switch is the locate semantic invariant — the exact opposite of
    // a play jump.
    addon.setPaused(sessionId, true)
    await waitForSnapshot(
      addon,
      sessionId,
      'paused on entry 3 before locate',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistPosition === 2 && snapshot.status === 'paused'
    )
    addon.playlistLocateIndex(sessionId, 0)
    const locatedSnapshot = await waitForSnapshot(
      addon,
      sessionId,
      'locate to entry 1 keeps the session paused',
      PLAYLIST_BUDGET_MS,
      (snapshot) => snapshot.playlistPosition === 0 && snapshot.status === 'paused'
    )
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
        `Locate moved off the target entry: ${snapshotSummary(stableSnapshot)}`
      )
      assert.notEqual(
        stableSnapshot.status,
        'playing',
        `Locate resumed playback instead of preserving pause: ${snapshotSummary(stableSnapshot)}`
      )
      assert.ok(
        stableSnapshot.positionSeconds <= locatedPosition + 0.3,
        `Locate advanced the clock while paused: ${snapshotSummary(stableSnapshot)}`
      )
      await sleep(POLL_INTERVAL_MS)
    }
    log(
      'playlistLocateIndex(0) switched the entry while preserving pause ' +
        '(never played, clock frozen) OK'
    )
  } finally {
    if (sessionId && !disposed) {
      disposed = true
      await addon.disposeSession(sessionId)
      log('disposeSession resolved OK')
    }
    addon.stopPresenterLink()
    preparedQueue.cleanup()
    preparedFixture.cleanup()
  }

  log('SMOKE PASS')
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(
      `[macos-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`
    )
    process.exit(1)
  })
