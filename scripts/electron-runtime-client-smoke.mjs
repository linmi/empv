import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import { createEmpvRuntimeClient, EmpvRuntimeProcessFailure } from '../dist/electron/index.js'

const runtimeEntry = fileURLToPath(
  new URL('../tests/fixtures/runtimeClientProcess.mjs', import.meta.url)
)
const EXIT_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 1_000

function log(message) {
  process.stdout.write(`[electron-runtime-client-smoke] ${message}\n`)
}

function resolveLinuxNodeExecutablePath() {
  const executablePath = process.env.EMPV_SMOKE_NODE_EXECUTABLE
  if (!executablePath) {
    throw new Error('Linux smoke requires EMPV_SMOKE_NODE_EXECUTABLE.')
  }
  return executablePath
}

function waitForNextExit(client) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`The runtime process did not exit within ${EXIT_TIMEOUT_MS}ms.`))
    }, EXIT_TIMEOUT_MS)
    const unsubscribe = client.onExit((error, sessions) => {
      clearTimeout(timeout)
      unsubscribe()
      resolve({ error, sessions })
    })
  })
}

async function run() {
  await app.whenReady()

  const diagnostics = []
  const client = createEmpvRuntimeClient({
    resolveEntryPath: () => runtimeEntry,
    frameLinkServiceName: `empv.runtime-client-smoke.${process.pid}`,
    serviceName: 'empv Runtime Client Smoke',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    resolveLinuxNodeExecutablePath:
      process.platform === 'linux' ? resolveLinuxNodeExecutablePath : undefined,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  const firstExit = waitForNextExit(client)
  await assert.rejects(client.invoke('disposeSession', 'smoke-session'), (error) => {
    assert.ok(error instanceof EmpvRuntimeProcessFailure)
    assert.deepEqual(error.terminalReason, {
      type: 'request-timeout',
      requestId: 1,
      method: 'disposeSession',
      sessionId: 'smoke-session',
      timeoutMs: REQUEST_TIMEOUT_MS
    })
    return true
  })

  const timedOutGeneration = await firstExit
  assert.equal(timedOutGeneration.error.terminalReason.type, 'request-timeout')
  assert.deepEqual(timedOutGeneration.sessions, [
    { sessionId: 'smoke-session', state: 'disposing' }
  ])
  assert.deepEqual(diagnostics, [])
  log('heartbeat-alive request timeout terminated generation 1 without terminating Electron')

  const secondExit = waitForNextExit(client)
  assert.equal(await client.invoke('isSupported'), true)
  assert.equal(client.getProcessId() === null, false)
  log('generation 2 respawned and answered a request')

  client.terminate('Runtime client smoke completed.')
  const stoppedGeneration = await secondExit
  assert.equal(stoppedGeneration.error.terminalReason.type, 'terminate')
  assert.deepEqual(diagnostics, [])
  log('SMOKE PASS')
}

run()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `[electron-runtime-client-smoke] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    app.exit(1)
  })
