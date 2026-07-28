import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { app, BrowserWindow } from 'electron'

import {
  createEmpvFrameLinkServiceName,
  createEmpvPlaybackHost,
  createEmpvRuntimeClient
} from '../dist/electron/index.js'

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])
const OPERATION_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 10_000
const runtimeEntry = fileURLToPath(
  new URL('./fixtures/electron-playback-runtime.mjs', import.meta.url)
)
const outputDirectory = path.resolve(
  process.env.EMPV_ELECTRON_RUNTIME_SMOKE_OUTPUT_DIR ??
    mkdtempSync(path.join(os.tmpdir(), 'empv-electron-runtime-smoke-'))
)
const firstFixturePath = path.join(outputDirectory, 'first.mp4')
const secondFixturePath = path.join(outputDirectory, 'second.mp4')

let browserWindow = null
let client = null
let host = null
let hostDisposed = false
const diagnostics = []
const livePresenters = new Set()

function log(message) {
  process.stdout.write(`[electron-runtime-playback-smoke] ${message}\n`)
}

function errorText(error, seen = new Set()) {
  if (!(error instanceof Error)) return String(error)
  if (seen.has(error)) return '[circular error cause]'
  seen.add(error)

  const detail = error.stack ?? error.message
  const nested = []
  if (error instanceof AggregateError) {
    error.errors.forEach((child, index) => {
      nested.push(`Aggregate error ${String(index + 1)}:\n${errorText(child, seen)}`)
    })
  }
  if (error.cause !== undefined) {
    nested.push(`Cause:\n${errorText(error.cause, seen)}`)
  }
  return nested.length === 0 ? detail : `${detail}\n${nested.join('\n')}`
}

function assertFile(filePath, description) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    throw new Error(`${description} is missing or empty: ${filePath}`)
  }
}

function generateFixture(filePath, filter) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `${filter}=duration=12:size=320x180:rate=30`,
      '-pix_fmt',
      'yuv420p',
      filePath
    ],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
  )

  if (result.error) {
    throw new Error(`Failed to execute ffmpeg: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg fixture generation failed with status ${String(result.status)}: ${result.stderr.trim() || '(no stderr)'}`
    )
  }
  assertFile(filePath, 'Generated playback fixture')
}

function prepareFixtures() {
  mkdirSync(outputDirectory, { recursive: true })
  generateFixture(firstFixturePath, 'testsrc')
  generateFixture(secondFixturePath, 'testsrc2')
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 720,
    height: 320,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#111827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<!doctype html><html><body style="margin:0;background:#111827"></body></html>'
      )
  )
  window.show()
  return window
}

function waitForNextExit() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`The empv utility did not exit within ${OPERATION_TIMEOUT_MS}ms.`))
    }, OPERATION_TIMEOUT_MS)
    const unsubscribe = client.onExit((error, sessions) => {
      clearTimeout(timeout)
      unsubscribe()
      resolve({ error, sessions })
    })
  })
}

async function waitForSessionStates(expectedSessionIds) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  let lastStates = []

  while (Date.now() < deadline) {
    lastStates = client.getSessionStates()
    const activeIds = lastStates
      .filter((session) => session.state === 'active')
      .map((session) => session.sessionId)
      .sort()
    if (
      activeIds.length === expectedSessionIds.length &&
      activeIds.every((sessionId, index) => sessionId === [...expectedSessionIds].sort()[index])
    ) {
      return lastStates
    }
    await sleep(100)
  }

  throw new Error(
    `The utility heartbeat did not report the expected active sessions ${JSON.stringify(
      expectedSessionIds
    )}. Last states: ${JSON.stringify(lastStates)}`
  )
}

async function waitForPlaying(record, options = {}) {
  const minimumGeneration = options.minimumGeneration ?? 1
  const expectedStreamUrl = options.expectedStreamUrl ?? null
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  let lastSnapshot = null

  while (Date.now() < deadline) {
    lastSnapshot = await client.invokeInGeneration(
      record.runtimeGeneration,
      'getSessionSnapshot',
      record.runtimeSessionId
    )
    if (lastSnapshot?.status === 'error') {
      throw new Error(
        `Session ${record.runtimeSessionId} entered an error state: ${lastSnapshot.error ?? '(no detail)'}`
      )
    }
    if (
      lastSnapshot?.status === 'playing' &&
      lastSnapshot.positionSeconds >= 0.25 &&
      lastSnapshot.playbackReadyGeneration >= minimumGeneration &&
      (expectedStreamUrl === null || lastSnapshot.streamUrl === expectedStreamUrl)
    ) {
      return lastSnapshot
    }
    await sleep(100)
  }

  throw new Error(
    `Session ${record.runtimeSessionId} did not reach playing state. Last snapshot: ${JSON.stringify(
      lastSnapshot
    )}`
  )
}

async function loadSource(record, fixturePath, title) {
  log(`${record.presenterId}: loading source`)
  await client.invokeInGeneration(
    record.runtimeGeneration,
    'loadPlayback',
    record.runtimeSessionId,
    {
      streamUrl: fixturePath,
      title
    }
  )
  log(`${record.presenterId}: source loaded; configuring playback`)
  await client.invokeInGeneration(
    record.runtimeGeneration,
    'setLoopFile',
    record.runtimeSessionId,
    true
  )
  await client.invokeInGeneration(
    record.runtimeGeneration,
    'setPaused',
    record.runtimeSessionId,
    false
  )
  log(`${record.presenterId}: playback configured`)
}

async function createPlaybackSession(presenterId, bounds, fixturePath) {
  log(`${presenterId}: creating runtime session`)
  const {
    generation: runtimeGeneration,
    result: { sessionId: runtimeSessionId }
  } = await client.invokeWithGeneration('createSession', { options: { volume: 0 } })
  log(`${presenterId}: runtime session ${runtimeSessionId} created`)
  const record = { presenterId, runtimeGeneration, runtimeSessionId, presenterCreated: false }

  try {
    log(`${presenterId}: creating presenter`)
    const renderSize =
      host.presentationKind === 'layer'
        ? host.createPresenter(presenterId, browserWindow.getNativeWindowHandle(), {
            ...bounds,
            zOrder: 'overlay'
          })
        : await host.createPresenter(
            presenterId,
            runtimeGeneration,
            runtimeSessionId,
            browserWindow.getNativeWindowHandle(),
            {
              ...bounds,
              zOrder: 'overlay'
            }
          )
    log(`${presenterId}: presenter created`)
    record.presenterCreated = true
    livePresenters.add(presenterId)

    if (host.presentationKind === 'layer') {
      log(`${presenterId}: binding runtime session to layer presenter`)
      host.bindSessionToPresenter(runtimeSessionId, presenterId)
      log(`${presenterId}: runtime session bound to layer presenter`)
    }

    if (
      host.presentationKind === 'layer' &&
      renderSize.widthPixels > 0 &&
      renderSize.heightPixels > 0
    ) {
      log(`${presenterId}: setting render size`)
      await client.invokeInGeneration(
        runtimeGeneration,
        'setRenderSize',
        runtimeSessionId,
        renderSize.widthPixels,
        renderSize.heightPixels
      )
      log(`${presenterId}: render size set`)
    }
    await loadSource(record, fixturePath, presenterId)
    return record
  } catch (error) {
    const failures = [error]
    if (record.presenterCreated) {
      try {
        await host.destroyPresenter(presenterId)
        livePresenters.delete(presenterId)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    try {
      await client.invokeInGeneration(runtimeGeneration, 'disposeSession', runtimeSessionId)
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    throw new AggregateError(
      failures,
      `Failed to create integrated empv smoke session ${presenterId}.`
    )
  }
}

async function assertCapturedFrame(record) {
  const frame = await client.invokeInGeneration(
    record.runtimeGeneration,
    'captureFrame',
    record.runtimeSessionId
  )
  assert.ok(frame, `Session ${record.runtimeSessionId} returned no captured frame.`)
  assert.ok(frame.widthPixels > 0 && frame.heightPixels > 0)
  assert.equal(frame.data.length, frame.widthPixels * frame.heightPixels * 4)
}

async function releasePresenter(record, runtimeLost = false) {
  if (!record.presenterCreated) {
    return
  }
  if (host.presentationKind === 'layer' || !runtimeLost) {
    await host.destroyPresenter(record.presenterId)
  }
  record.presenterCreated = false
  livePresenters.delete(record.presenterId)
}

async function disposePlaybackSession(record) {
  const failures = []
  try {
    await releasePresenter(record)
  } catch (error) {
    failures.push(error)
  }
  try {
    await client.invokeInGeneration(
      record.runtimeGeneration,
      'disposeSession',
      record.runtimeSessionId
    )
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to dispose integrated empv smoke session ${record.presenterId}.`
    )
  }
}

async function run() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(
      `The integrated Electron playback smoke requires macOS, Linux, or Windows; got ${process.platform}.`
    )
  }

  log(`output: ${outputDirectory}`)
  log('generating playback fixtures')
  prepareFixtures()
  log('creating BrowserWindow')
  browserWindow = await createWindow()

  log('starting crash-isolated playback host')
  if (process.env.EMPV_SMOKE_ADDON_PATH) {
    // The existing cross-platform native smokes use this diagnostic override.
    // Normalize it to the public runtime resolver key. Window backends load it
    // only in the isolated runtime; layer also loads its presenter facet in main.
    process.env.EMPV_ADDON_PATH = path.resolve(process.env.EMPV_SMOKE_ADDON_PATH)
  }
  const frameLinkServiceName = createEmpvFrameLinkServiceName()
  const resolveLinuxNodeExecutablePath = () => {
    const executablePath = process.env.EMPV_SMOKE_NODE_EXECUTABLE
    if (!executablePath) {
      throw new Error('Linux smoke requires EMPV_SMOKE_NODE_EXECUTABLE.')
    }
    return executablePath
  }
  client = createEmpvRuntimeClient({
    resolveEntryPath: () => runtimeEntry,
    frameLinkServiceName,
    serviceName: 'empv Integrated Playback Smoke',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    resolveLinuxNodeExecutablePath:
      process.platform === 'linux' ? resolveLinuxNodeExecutablePath : undefined,
    stdioPrefix: '[empv-integrated-smoke-runtime]',
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
  host = await createEmpvPlaybackHost({
    client,
    frameLinkServiceName
  })
  log(`runtime backend probed as ${host.presentationKind}; playback host ready`)

  const first = await createPlaybackSession(
    'empv-smoke-presenter-1',
    { x: 20, y: 30, width: 320, height: 180 },
    firstFixturePath
  )
  const second = await createPlaybackSession(
    'empv-smoke-presenter-2',
    { x: 380, y: 30, width: 320, height: 180 },
    secondFixturePath
  )
  assert.notEqual(first.runtimeSessionId, second.runtimeSessionId)

  const [firstSnapshot, secondSnapshot] = await Promise.all([
    waitForPlaying(first, {
      expectedStreamUrl: firstFixturePath
    }),
    waitForPlaying(second, {
      expectedStreamUrl: secondFixturePath
    })
  ])
  await Promise.all([assertCapturedFrame(first), assertCapturedFrame(second)])
  await waitForSessionStates([first.runtimeSessionId, second.runtimeSessionId])
  log(
    `two sessions active: ${first.runtimeSessionId}@${firstSnapshot.positionSeconds.toFixed(
      2
    )}s, ${second.runtimeSessionId}@${secondSnapshot.positionSeconds.toFixed(2)}s`
  )

  await disposePlaybackSession(first)
  const secondBefore = await waitForPlaying(second, {
    minimumGeneration: secondSnapshot.playbackReadyGeneration,
    expectedStreamUrl: secondFixturePath
  })
  await sleep(350)
  const secondAfter = await client.invokeInGeneration(
    second.runtimeGeneration,
    'getSessionSnapshot',
    second.runtimeSessionId
  )
  assert.ok(secondAfter)
  assert.ok(
    secondAfter.positionSeconds > secondBefore.positionSeconds,
    'Disposing one session stopped progress in the other active session.'
  )
  await waitForSessionStates([second.runtimeSessionId])

  const runtimePid = client.getProcessId()
  assert.ok(runtimePid, 'The active playback process did not expose its pid.')
  const runtimeExit = waitForNextExit()
  process.kill(runtimePid, 'SIGKILL')
  const lostGeneration = await runtimeExit
  assert.equal(lostGeneration.error.terminalReason.type, 'unexpected-exit')
  assert.deepEqual(lostGeneration.sessions, [
    {
      sessionId: second.runtimeSessionId,
      state: 'active',
      windowPresenter:
        host.presentationKind === 'window'
          ? { presenterId: second.presenterId, state: 'active' }
          : null
    }
  ])
  assert.equal(client.getProcessId(), null)
  assert.equal(browserWindow.isDestroyed(), false)
  await releasePresenter(second, true)
  log(
    `playback pid ${String(runtimePid)} was killed; Electron and BrowserWindow survived generation ${String(
      lostGeneration.error.generation
    )}`
  )

  const restarted = await createPlaybackSession(
    'empv-smoke-presenter-3',
    { x: 200, y: 60, width: 320, height: 180 },
    firstFixturePath
  )
  assert.equal(
    restarted.runtimeSessionId,
    first.runtimeSessionId,
    'A fresh playback generation should demonstrate raw native session-id reuse.'
  )
  assert.notEqual(restarted.presenterId, first.presenterId)
  const restartedSnapshot = await waitForPlaying(restarted, {
    expectedStreamUrl: firstFixturePath
  })
  await assertCapturedFrame(restarted)

  await loadSource(restarted, secondFixturePath, 'consecutive source replacement')
  const replacedSnapshot = await waitForPlaying(restarted, {
    expectedStreamUrl: secondFixturePath,
    minimumGeneration: restartedSnapshot.playbackReadyGeneration + 1
  })
  await assertCapturedFrame(restarted)
  assert.ok(replacedSnapshot.playbackReadyGeneration > restartedSnapshot.playbackReadyGeneration)
  log(
    `generation ${String(lostGeneration.error.generation + 1)} reused raw id ${
      restarted.runtimeSessionId
    } with presenter ${restarted.presenterId}; source generation advanced ` +
      `${String(restartedSnapshot.playbackReadyGeneration)} -> ${String(
        replacedSnapshot.playbackReadyGeneration
      )}`
  )

  await disposePlaybackSession(restarted)
  assert.equal(livePresenters.size, 0)
  await waitForSessionStates([])
  await host.dispose()
  hostDisposed = true

  const finalExit = waitForNextExit()
  client.terminate('Integrated playback smoke completed.')
  const stoppedGeneration = await finalExit
  assert.equal(stoppedGeneration.error.terminalReason.type, 'terminate')
  assert.deepEqual(stoppedGeneration.sessions, [])
  assert.deepEqual(diagnostics, [])
  log('SMOKE PASS')
}

async function cleanup() {
  const failures = []

  if (host && !hostDisposed) {
    try {
      await host.dispose()
      hostDisposed = true
      livePresenters.clear()
    } catch (error) {
      failures.push(error)
    }
  }
  if (client && client.getProcessId() !== null) {
    try {
      client.terminate('Integrated playback smoke cleanup.')
    } catch (error) {
      failures.push(error)
    }
  }
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.destroy()
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Integrated empv smoke cleanup failed.')
  }
}

const hardTimeout = setTimeout(() => {
  process.stderr.write(
    `[electron-runtime-playback-smoke] FAIL: exceeded hard timeout of ${String(
      OPERATION_TIMEOUT_MS * 5
    )}ms.\n`
  )
  app.exit(1)
}, OPERATION_TIMEOUT_MS * 5)

app.whenReady().then(async () => {
  let bodyError = null
  let cleanupError = null

  try {
    await run()
  } catch (error) {
    bodyError = error
  }
  try {
    await cleanup()
  } catch (error) {
    cleanupError = error
  }

  clearTimeout(hardTimeout)
  if (bodyError || cleanupError) {
    if (bodyError) {
      process.stderr.write(`[electron-runtime-playback-smoke] FAIL: ${errorText(bodyError)}\n`)
    }
    if (cleanupError) {
      process.stderr.write(
        `[electron-runtime-playback-smoke] CLEANUP FAIL: ${errorText(cleanupError)}\n`
      )
    }
    app.exit(1)
  } else {
    app.exit(0)
  }
})
