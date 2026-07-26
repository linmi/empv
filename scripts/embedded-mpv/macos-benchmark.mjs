#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 基准脚本：console 是其面向终端的输出通道 */
//
// Measures what the macOS runtime actually does with a video, rather than what
// its architecture suggests it should.
//
//   node --experimental-strip-types scripts/embedded-mpv/macos-benchmark.mjs
//   node --experimental-strip-types scripts/embedded-mpv/macos-benchmark.mjs --json
//
// WHAT IS AND IS NOT MEASURED
//
// Measured: decode, render into the IOSurface pool, the frame-notifier cadence
// the pool drives, the CPU that costs, and how quickly a seek is acknowledged.
//
// Not measured: presentation. This runs without a presenter, the way the smoke
// does, so no CALayer receives a surface and no window composites one. That is
// deliberate -- a presenter needs a real window and a logged-in session -- but it
// means the numbers below are a floor, not an end-to-end cost. The transparent
// BrowserWindow an 'underlay' zOrder requires has its own compositing price and
// is not in here, and neither is time-to-first-frame-after-seek, which is a
// property of presentation rather than of decoding.
//
// Fixtures are synthetic (ffmpeg testsrc2, hardware-encoded). Synthetic content
// compresses far better than real footage, so absolute decode cost is optimistic
// and should not be quoted as "empv plays 4K at X%". What the numbers are good
// for is comparison: between runs, between codecs, and against the assertions
// below, all of which are properties rather than magnitudes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeEmbeddedAddon } from '../../src/embedded.ts'

const require = createRequire(import.meta.url)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const ADDON_PATH = path.resolve(scriptDir, '../../native/build/Release/empv.node')

// Long enough for the decoder to reach steady state and for dropped frames to
// accumulate if they are going to; short enough to run in CI.
const MEASURE_MS = 10_000
// Discarded before measuring: the first file load does demuxer probing, hwdec
// negotiation and pool allocation, none of which is steady-state playback.
const WARMUP_MS = 2_500
const READY_BUDGET_MS = 20_000
const POLL_INTERVAL_MS = 100
// A 100ms poll would quantise every seek under a tenth of a second to 100ms, so
// the seek loop polls far tighter than the readiness waits do.
const SEEK_POLL_INTERVAL_MS = 2
const SEEK_COUNT = 8
const SEEK_BUDGET_MS = 5_000
// Far apart, and far from where a 12.5s measurement leaves the clock, so
// "arrived" cannot be satisfied by the position the clock was passing anyway.
const SEEK_TARGET_EARLY_SECONDS = 1.5
const SEEK_TARGET_LATE_SECONDS = 17.5
const SEEK_TOLERANCE_SECONDS = 0.35

const CASES = [
  {
    id: '1080p60-h264',
    width: 1920,
    height: 1080,
    fps: 60,
    encoder: 'h264_videotoolbox',
    // High enough that decode is doing real work on synthetic content, which
    // otherwise compresses to almost nothing and measures the demuxer.
    bitrate: '20M'
  },
  {
    id: '2160p30-hevc',
    width: 3840,
    height: 2160,
    fps: 30,
    encoder: 'hevc_videotoolbox',
    bitrate: '60M'
  }
]

function log(message) {
  console.log(`[macos-benchmark] ${message}`)
}

function fail(message) {
  console.error(`[macos-benchmark] ${message}`)
  process.exit(1)
}

function runFfmpeg(args, description) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-y', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  if (result.error) {
    fail(`${description}: failed to execute ffmpeg: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${description}: ffmpeg exited ${String(result.status)}.\n${result.stderr?.trim() ?? ''}`)
  }
}

function prepareFixture(directory, testCase) {
  const fixture = path.join(directory, `${testCase.id}.mp4`)
  runFfmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=duration=20:size=${testCase.width}x${testCase.height}:rate=${testCase.fps}`,
      '-c:v',
      testCase.encoder,
      '-b:v',
      testCase.bitrate,
      '-pix_fmt',
      'yuv420p',
      fixture
    ],
    `preparing ${testCase.id}`
  )
  if (!existsSync(fixture) || statSync(fixture).size === 0) {
    fail(`preparing ${testCase.id}: ffmpeg reported success but wrote nothing.`)
  }
  return fixture
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(description, budgetMs, predicate, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  fail(`timed out after ${budgetMs}ms waiting for ${description}`)
  return null
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}

async function measureCase(addon, testCase, fixture) {
  const frameTimes = []
  let snapshotEvents = 0

  const sessionId = await addon.createSession(
    { volume: 0 },
    () => {
      snapshotEvents += 1
    },
    () => {
      frameTimes.push(Date.now())
    }
  )

  try {
    // The pool is sized to the video, not to a thumbnail: rendering 4K into a
    // 320x180 pool would measure a scaler nobody uses in production.
    addon.setRenderSize(sessionId, testCase.width, testCase.height)
    addon.loadPlayback(sessionId, { streamUrl: fixture, title: testCase.id })
    addon.setPaused(sessionId, false)

    await waitFor(`${testCase.id} to start playing`, READY_BUDGET_MS, () => {
      const snapshot = addon.getSessionSnapshot(sessionId)
      return snapshot && snapshot.status === 'playing' && snapshot.positionSeconds > 0
        ? snapshot
        : null
    })

    await sleep(WARMUP_MS)

    const before = addon.getSessionSnapshot(sessionId)
    const cpuBefore = process.cpuUsage()
    const wallBefore = Date.now()
    const framesBefore = frameTimes.length
    const snapshotsBefore = snapshotEvents

    await sleep(MEASURE_MS)

    const cpu = process.cpuUsage(cpuBefore)
    const wallMs = Date.now() - wallBefore
    const after = addon.getSessionSnapshot(sessionId)
    const framesRendered = frameTimes.length - framesBefore

    const intervals = []
    for (let index = framesBefore + 1; index < frameTimes.length; index += 1) {
      intervals.push(frameTimes[index] - frameTimes[index - 1])
    }
    intervals.sort((a, b) => a - b)

    // How long until a seek is ACKNOWLEDGED -- not how long until the new frame
    // is on screen. Those are different numbers and only one of them is
    // measurable here.
    //
    // seek() is absolute+exact, and mpv updates time-pos as soon as it accepts
    // the command, so the position a caller reads back is the requested one
    // before any decoding to it has happened. That is genuinely useful (a
    // scrubber can be driven straight from the snapshot with no perceived lag)
    // and it is emphatically not seek latency. Measuring time-to-visible-frame
    // needs a presenter, which this benchmark deliberately runs without, so it
    // is absent rather than approximated by this.
    //
    // Two things here are load-bearing, and the first version of this had
    // neither, which is why it reported a flat zero for every seek. The targets
    // are far from wherever playback currently is, because a tolerance wide
    // enough to catch "arrived" is also wide enough to match the position the
    // clock was already passing through. And the position has to have MOVED --
    // arriving is not the same as never having left, and only one of them is a
    // seek.
    const positionAcks = []
    for (let index = 0; index < SEEK_COUNT; index += 1) {
      const target = index % 2 === 0 ? SEEK_TARGET_LATE_SECONDS : SEEK_TARGET_EARLY_SECONDS
      const departed = addon.getSessionSnapshot(sessionId)?.positionSeconds ?? 0
      assert.ok(
        Math.abs(departed - target) > 2,
        `seek ${index}: target ${target}s is too close to the current ${departed}s to measure`
      )

      const started = process.hrtime.bigint()
      addon.seek(sessionId, target)
      await waitFor(
        `seek ${index} to reach ${target}s`,
        SEEK_BUDGET_MS,
        () => {
          const snapshot = addon.getSessionSnapshot(sessionId)
          if (!snapshot) return null
          const arrived = Math.abs(snapshot.positionSeconds - target) < SEEK_TOLERANCE_SECONDS
          const moved = Math.abs(snapshot.positionSeconds - departed) > 1
          return arrived && moved ? snapshot : null
        },
        SEEK_POLL_INTERVAL_MS
      )
      positionAcks.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
    positionAcks.sort((a, b) => a - b)

    const droppedBefore = before?.droppedFrameCount ?? 0
    const droppedAfter = after?.droppedFrameCount ?? 0

    return {
      id: testCase.id,
      source: {
        width: after?.videoWidth ?? null,
        height: after?.videoHeight ?? null,
        containerFps: after?.containerFps ?? null
      },
      hwdec: after?.hwdecCurrent ?? null,
      measuredMs: wallMs,
      framesRendered,
      renderedFps: Number(((framesRendered / wallMs) * 1000).toFixed(2)),
      frameIntervalMs: {
        median: percentile(intervals, 0.5),
        p95: percentile(intervals, 0.95),
        max: intervals.at(-1) ?? null
      },
      droppedFrames: droppedAfter - droppedBefore,
      // user+system of this process over the window. Decoding and rendering run
      // on threads inside it, so this is the whole cost, not a sample of it.
      cpuPercent: Number((((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(1)),
      snapshotsPerSecond: Number((((snapshotEvents - snapshotsBefore) / wallMs) * 1000).toFixed(2)),
      // Named for what it is. See the comment at the measurement.
      positionAckMs: {
        median: percentile(positionAcks, 0.5),
        p95: percentile(positionAcks, 0.95),
        max: positionAcks.at(-1) ?? null
      }
    }
  } finally {
    await addon.disposeSession(sessionId)
  }
}

// Properties, not magnitudes. A benchmark that asserted "CPU below 40%" would
// fail on a busy runner and pass on a fast one while a real regression hid inside
// the margin; these are things that must hold on any machine that can play the
// file at all, and each one is a failure mode that is otherwise silent.
function assertHealthy(result, testCase) {
  // Hardware decode falling back to software is invisible: the picture is
  // identical and only the CPU number moves. This is the assertion that catches
  // a runtime built without --enable-videotoolbox.
  assert.ok(
    result.hwdec && result.hwdec !== 'no',
    `${result.id}: expected hardware decoding, got hwdecCurrent=${String(result.hwdec)}`
  )

  // Dropped frames during steady-state playback of a file the machine can
  // decode are the definition of not keeping up.
  assert.equal(result.droppedFrames, 0, `${result.id}: dropped ${result.droppedFrames} frames`)

  // The pool must actually be driven. A session that renders nothing still
  // reports "playing" and still advances its clock, so frame count is the only
  // thing that distinguishes playing from pretending.
  assert.ok(
    result.framesRendered > 0,
    `${result.id}: no frames reached the notifier during ${result.measuredMs}ms`
  )

  // Within 10% of the container rate. Not an absolute throughput claim -- it is
  // the file's own rate, read from the file -- so it holds regardless of how fast
  // the machine is, and fails if rendering silently halves.
  const expectedFps = result.source.containerFps ?? testCase.fps
  assert.ok(
    result.renderedFps > expectedFps * 0.9,
    `${result.id}: rendered ${result.renderedFps}fps against a ${expectedFps}fps source`
  )

  // The coalescing contract: position churn is collapsed to at most one
  // notification per 250ms, so a steady session cannot exceed 4/s by much.
  // Immediate pushes for real changes are why this is not exactly 4.
  assert.ok(
    result.snapshotsPerSecond < 8,
    `${result.id}: ${result.snapshotsPerSecond} snapshots/s exceeds the coalescing budget`
  )
}

async function main() {
  if (process.platform !== 'darwin') {
    fail(`This benchmark measures the macOS runtime; got ${process.platform}.`)
  }
  if (!existsSync(ADDON_PATH)) {
    fail(`No addon at ${ADDON_PATH}. Run "pnpm run build:native" first.`)
  }

  // require, not import(): a .node is a CommonJS binding, and this is the same
  // path the smoke takes.
  const loaded = normalizeEmbeddedAddon(require(ADDON_PATH))
  if (loaded.presentationKind !== 'layer') {
    fail(`Expected the layer backend on macOS, got ${loaded.presentationKind}.`)
  }
  const addon = loaded.addon

  const frameLinkService = `com.empv.macos-benchmark.${process.pid}`
  addon.startPresenterLink(frameLinkService)
  addon.configureFrameLink(frameLinkService)

  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'empv-macos-benchmark-'))
  const results = []
  try {
    for (const testCase of CASES) {
      log(`preparing ${testCase.id} fixture (${testCase.encoder} @ ${testCase.bitrate})`)
      const fixture = prepareFixture(fixtureDir, testCase)

      log(`measuring ${testCase.id}: ${WARMUP_MS}ms warm-up then ${MEASURE_MS}ms`)
      const result = await measureCase(addon, testCase, fixture)
      assertHealthy(result, testCase)
      results.push(result)

      log(
        `${result.id}: ${result.renderedFps}fps rendered, ${result.cpuPercent}% cpu, ` +
          `hwdec=${result.hwdec}, dropped=${result.droppedFrames}, ` +
          `frame interval p95=${result.frameIntervalMs.p95}ms, ` +
          `seek ack p95=${result.positionAckMs.p95.toFixed(3)}ms`
      )
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ platform: process.platform, results }, null, 2))
  }
  log('PASS: every case decoded in hardware, dropped nothing, and kept up with its source.')
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
