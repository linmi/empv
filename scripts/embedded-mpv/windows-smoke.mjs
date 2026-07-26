#!/usr/bin/env node
/* oxlint-disable no-console -- smoke CLI 脚本：console 是其面向终端的输出通道 */
//
// Runtime smoke for the Windows 'wid-window' backend. It loads the freshly
// compiled addon directly from native/build/Release, where Windows also resolves
// the bundled mpv DLL, validates the real TypeScript contract, generates (or
// accepts) a five-second ffmpeg fixture, and drives playback through EOF, replay,
// and playlist behavior.
//
// PRESENTER COVERAGE:
// Pure Node has no Electron BrowserWindow, but the WID session facet creates a
// real Win32 HWND. A second idle session's HWND is therefore used as a real
// parent window while the playback session's HWND is adopted as its child. This
// exercises the actual Win32 prepare/SetParent/bounds/visibility/detach path.
// It does not validate Electron webContents compositing or renderer alignment;
// those remain desktop integration concerns.
//
// Run from a Windows shell with Node 22+ and ffmpeg on PATH:
//
//   node --experimental-strip-types `
//     scripts/embedded-mpv/windows-smoke.mjs [fixture.mp4]
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { normalizeEmbeddedAddon } from '../../src/embedded.ts'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const NATIVE_BUILD_DIR = path.resolve(scriptDir, '../../native/build/Release')
const ADDON_PATH = path.join(NATIVE_BUILD_DIR, 'embedded_mpv.node')

const PLAYBACK_BUDGET_MS = 20_000
const EOF_BUDGET_MS = 20_000
const RESTART_BUDGET_MS = 10_000
const PLAYLIST_BUDGET_MS = 20_000
const PLAYLIST_STABILITY_MS = 3_000
const POLL_INTERVAL_MS = 250
const MIN_POSITION_SECONDS = 1
const RESTARTED_POSITION_SECONDS = 0.5

function log(message) {
  process.stdout.write(`[windows-smoke] ${message}\n`)
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

function verifyNativeBuild() {
  if (!existsSync(ADDON_PATH) || !statSync(ADDON_PATH).isFile()) {
    fail(`The Windows addon does not exist: ${ADDON_PATH}. Run pnpm build:native first.`)
  }
  const runtimeDlls = readdirSync(NATIVE_BUILD_DIR).filter((name) =>
    /^(?:libmpv-2|mpv-2|libmpv|mpv)\.dll$/i.test(name)
  )
  if (runtimeDlls.length === 0) {
    fail(
      `No supported libmpv runtime DLL was found beside ${ADDON_PATH}. ` +
        'The Windows addon must be tested with its staged runtime DLL in the same directory.'
    )
  }
  log(`runtime DLL: ${runtimeDlls.join(', ')}`)
}

function verifyFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  if (probe.error?.code === 'ENOENT') {
    fail('ffmpeg is required to generate the Windows smoke fixture, but it was not found on PATH.')
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

  verifyFfmpeg()
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'empv-windows-smoke-'))
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

function assertWindowHandle(handle, description) {
  assert.equal(typeof handle, 'number', `${description} must be a number, got ${String(handle)}`)
  assert.ok(
    Number.isSafeInteger(handle) && handle > 0,
    `${description} must be a positive safe-integer HWND, got ${String(handle)}`
  )
}

function nativeWindowHandleBuffer(handle) {
  assertWindowHandle(handle, 'Native window handle')
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    fail(`The Windows smoke supports 64-bit Node only, got process.arch=${process.arch}.`)
  }
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(handle))
  return buffer
}

function assertRenderSize(size, description) {
  assert.ok(size && typeof size === 'object', `${description} must return a render-size object`)
  assert.ok(
    Number.isInteger(size.widthPixels) && size.widthPixels > 0,
    `${description}.widthPixels must be a positive integer, got ${String(size.widthPixels)}`
  )
  assert.ok(
    Number.isInteger(size.heightPixels) && size.heightPixels > 0,
    `${description}.heightPixels must be a positive integer, got ${String(size.heightPixels)}`
  )
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

async function main() {
  if (process.platform !== 'win32') {
    fail(`windows-smoke.mjs requires Windows, got ${process.platform}.`)
  }

  verifyNativeBuild()
  const preparedFixture = prepareFixture()
  const fixture = preparedFixture.fixture
  log(`fixture: ${fixture}`)
  log(`addon:   ${ADDON_PATH}`)

  let normalized
  try {
    normalized = normalizeEmbeddedAddon(require(ADDON_PATH))
  } catch (error) {
    preparedFixture.cleanup()
    fail(
      `Failed to load or normalize the embedded mpv addon from ${ADDON_PATH}: ` +
        `${errorText(error)}`
    )
  }

  const { addon, presentationKind } = normalized
  let sessionId = null
  let parentSessionId = null
  const presenterId = `windows-smoke-presenter-${process.pid}-${Date.now()}`
  let presenterCreated = false
  let frameEvents = 0
  let bodyError = null

  try {
    assert.equal(
      presentationKind,
      'wid-window',
      `getPresentationKind() must be 'wid-window' on Windows, got ${String(presentationKind)}`
    )
    assert.equal(addon.isSupported(), true, 'isSupported() must be true on Windows')
    log("addon normalized; getPresentationKind() === 'wid-window' OK")

    let snapshotEvents = 0
    sessionId = await addon.createSession(
      { volume: 1.0 },
      () => {
        snapshotEvents += 1
      },
      () => {
        frameEvents += 1
      }
    )
    assert.equal(typeof sessionId, 'string')
    assert.ok(sessionId.length > 0, 'createSession returned an empty playback session id')
    const childWindowHandle = addon.getVideoWindowHandle(sessionId)
    assertWindowHandle(childWindowHandle, 'Playback session HWND')
    log(`playback session created -> ${sessionId}, HWND=${childWindowHandle}`)

    // A second idle session supplies a genuine Win32 parent HWND so the WID
    // presenter can be exercised without Electron or another native dependency.
    parentSessionId = await addon.createSession(
      { volume: 0 },
      () => {},
      () => {}
    )
    assert.equal(typeof parentSessionId, 'string')
    assert.ok(parentSessionId.length > 0, 'createSession returned an empty parent session id')
    const parentWindowHandle = addon.getVideoWindowHandle(parentSessionId)
    assertWindowHandle(parentWindowHandle, 'Parent session HWND')
    assert.notEqual(parentWindowHandle, childWindowHandle, 'Parent and child HWNDs must differ')

    const parentHandleBuffer = nativeWindowHandleBuffer(parentWindowHandle)
    const createSize = addon.createPresenter(presenterId, parentHandleBuffer, {
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      cornerRadius: 0,
      zOrder: 'overlay'
    })
    presenterCreated = true
    assertRenderSize(createSize, 'createPresenter')
    addon.adoptVideoWindow(presenterId, childWindowHandle)
    const resized = addon.setPresenterBounds(presenterId, {
      x: 4,
      y: 6,
      width: 300,
      height: 160,
      cornerRadius: 0
    })
    assertRenderSize(resized, 'setPresenterBounds')
    const refreshed = addon.refreshPresenterScale(presenterId)
    assertRenderSize(refreshed, 'refreshPresenterScale')
    addon.setPresenterSuspended(presenterId, true)
    addon.setPresenterSuspended(presenterId, false)
    addon.setWindowBackdrop(parentHandleBuffer, '#112233')
    log(
      `Win32 presenter adopted HWND ${childWindowHandle} under ${parentWindowHandle}; ` +
        'bounds, scale, suspend/resume, and WID backdrop no-op OK'
    )

    addon.loadPlayback(sessionId, {
      streamUrl: fixture,
      title: 'windows-smoke fixture'
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

    addon.appendPlaylistEntry(sessionId, fixture, 'entry-2')
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

    addon.appendPlaylistEntry(sessionId, fixture, 'entry-3')
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

    assert.equal(frameEvents, 0, 'onFrame must never fire for the wid-window backend')
  } catch (error) {
    bodyError = error
  }

  const cleanupErrors = []
  if (presenterCreated) {
    try {
      addon.destroyPresenter(presenterId)
      presenterCreated = false
      log('destroyPresenter OK')
    } catch (error) {
      cleanupErrors.push(`destroyPresenter failed: ${errorText(error)}`)
    }
  }
  for (const [description, id] of [
    ['parent session', parentSessionId],
    ['playback session', sessionId]
  ]) {
    if (!id) {
      continue
    }
    try {
      await addon.disposeSession(id)
      assert.equal(addon.getSessionSnapshot(id), null, `${description} remained registered`)
      log(`disposeSession(${description}) resolved OK`)
    } catch (error) {
      cleanupErrors.push(`disposeSession(${description}) failed: ${errorText(error)}`)
    }
  }
  preparedFixture.cleanup()

  if (bodyError) {
    if (cleanupErrors.length > 0) {
      log(`cleanup also failed: ${cleanupErrors.join('; ')}`)
    }
    throw bodyError
  }
  if (cleanupErrors.length > 0) {
    fail(cleanupErrors.join('; '))
  }

  log('SMOKE PASS')
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(
      `[windows-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`
    )
    process.exit(1)
  })
