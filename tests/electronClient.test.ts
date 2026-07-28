import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  createEmpvRuntimeClientWithFork,
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeChildProcess,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeProcessFork,
  type EmpvRuntimeProcessForkOptions
} from '../src/electron/clientCore.ts'
import type { EmpvRuntimeRequest } from '../src/electron/protocol.ts'

const EXISTING_ENTRY = fileURLToPath(new URL('../src/electron/runtimeProcess.ts', import.meta.url))

class FakeRuntimeProcess extends EventEmitter implements EmpvRuntimeChildProcess {
  pid: number | undefined
  stdout = null
  stderr = null
  readonly posted: EmpvRuntimeRequest[] = []
  killCalls = 0
  killResult = true
  killError: Error | null = null
  sendError: Error | null = null
  sendThrow: Error | null = null

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  postMessage(message: EmpvRuntimeRequest, onError: (error: Error) => void): void {
    if (this.sendThrow) throw this.sendThrow
    this.posted.push(message)
    if (this.sendError) onError(this.sendError)
  }

  kill(): boolean {
    this.killCalls += 1
    if (this.killError) throw this.killError
    return this.killResult
  }

  onMessage(listener: (message: unknown) => void): void {
    this.on('message', listener)
  }

  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.once('exit', listener)
  }

  onceFailure(listener: Parameters<EmpvRuntimeChildProcess['onceFailure']>[0]): void {
    this.once('error', listener)
  }

  onceSpawn(listener: () => void): void {
    this.once('spawn', listener)
  }

  spawn(): void {
    this.emit('spawn')
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
    this.pid = undefined
  }

  fatal(location = 'runtime.cc:42', report = 'diagnostic report'): void {
    this.emit('error', {
      type: 'fatal-error',
      fatalType: 'FatalError',
      location,
      report
    })
  }

  processFailure(location = 'node:child_process.fork', report = 'spawn failed'): void {
    this.emit('error', {
      type: 'process-error',
      location,
      report
    })
  }

  message(message: unknown): void {
    this.emit('message', message)
  }
}

function makeHarness(overrides: Partial<EmpvRuntimeClientOptions> = {}) {
  const children: FakeRuntimeProcess[] = []
  const forkCalls: {
    modulePath: string
    args: string[]
    options: EmpvRuntimeProcessForkOptions
  }[] = []
  const fork: EmpvRuntimeProcessFork = (modulePath, args, options) => {
    forkCalls.push({ modulePath, args, options })
    const child = new FakeRuntimeProcess(4_000 + children.length)
    children.push(child)
    return child
  }
  const diagnostics: EmpvRuntimeClientDiagnostic[] = []
  const client = createEmpvRuntimeClientWithFork(
    {
      resolveEntryPath: () => EXISTING_ENTRY,
      frameLinkServiceName: 'empv.frame-link.test',
      serviceName: 'empv test runtime',
      requestTimeoutMs: 60_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...overrides
    },
    fork
  )
  return { children, client, diagnostics, forkCalls }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('createEmpvRuntimeClient', () => {
  test('rejects a missing or invalid request deadline before spawning', () => {
    for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(
        () => makeHarness({ requestTimeoutMs }),
        /requestTimeoutMs must be a positive safe integer/
      )
    }
  })

  test('shares one spawn across concurrent invokes and correlates out-of-order responses', async () => {
    const { children, client, forkCalls } = makeHarness()
    const first = client.invoke('isSupported')
    const second = client.invoke('setVolume', 'session-1', 0.5)

    assert.equal(forkCalls.length, 1)
    children[0].spawn()
    await flush()
    assert.deepEqual(
      children[0].posted.map(({ id, method }) => ({ id, method })),
      [
        { id: 1, method: 'isSupported' },
        { id: 2, method: 'setVolume' }
      ]
    )

    children[0].message({ id: 2, type: 'done', result: undefined })
    children[0].message({ id: 1, type: 'done', result: true })
    assert.equal(await first, true)
    assert.equal(await second, undefined)
  })

  test('preserves a fatal error as the terminal cause through the final exit code', async () => {
    const exits: EmpvRuntimeProcessFailure[] = []
    const { children, client } = makeHarness()
    client.onExit((error) => exits.push(error))
    const pending = client.invoke('isSupported')
    children[0].spawn()
    await flush()

    children[0].fatal('native.cc:9', 'native diagnostic')
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.equal(error.terminalReason.type, 'fatal-error')
      assert.equal(error.exitCode, null)
      return true
    })
    await assert.rejects(client.invoke('isSupported'), /FatalError at native\.cc:9/)
    assert.equal(children[0].killCalls, 1)

    children[0].exit(87)
    assert.equal(exits.length, 1)
    assert.equal(exits[0].terminalReason.type, 'fatal-error')
    assert.equal(exits[0].exitCode, 87)
    assert.equal(exits[0].exitSignal, null)
    assert.match(exits[0].message, /native diagnostic/)
    assert.match(exits[0].message, /Final exit: code 87/)
  })

  test('terminates the generation for synchronous and asynchronous IPC send failures', async () => {
    for (const failureMode of ['throw', 'callback'] as const) {
      const { children, client } = makeHarness()
      const pending = client.invoke('setVolume', 'session-a', 0.5)
      const sendError = new Error(`${failureMode} send failed`)
      if (failureMode === 'throw') children[0].sendThrow = sendError
      else children[0].sendError = sendError
      children[0].spawn()

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof EmpvRuntimeProcessFailure)
        assert.deepEqual(error.terminalReason, {
          type: 'request-send-failure',
          requestId: 1,
          method: 'setVolume',
          sessionId: 'session-a',
          message: `${failureMode} send failed`
        })
        return true
      })
      assert.equal(children[0].killCalls, 1)
      await assert.rejects(client.invoke('isSupported'), /IPC state is no longer trustworthy/)
      children[0].exit(1)
    }
  })

  test('attributes a Node child process error without calling it an Electron FatalError', async () => {
    const { children, client } = makeHarness()
    const pending = client.invoke('isSupported')

    children[0].processFailure('node:child_process.fork', 'spawn EACCES')

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.deepEqual(error.terminalReason, {
        type: 'process-error',
        location: 'node:child_process.fork',
        report: 'spawn EACCES'
      })
      assert.doesNotMatch(error.message, /FatalError/)
      return true
    })
    assert.equal(children[0].killCalls, 1)
    children[0].exit(1)
  })

  test('preserves an unrecoverable request as the generation cause and rejects all pending work', async () => {
    const exits: Array<{
      error: EmpvRuntimeProcessFailure
      sessions: ReturnType<ReturnType<typeof makeHarness>['client']['getSessionStates']>
    }> = []
    const { children, client } = makeHarness()
    client.onExit((error, sessions) => exits.push({ error, sessions }))
    const disposal = client.invoke('disposeSession', 'session-a')
    const concurrent = client.invoke('setVolume', 'session-b', 0.5)
    children[0].spawn()
    await flush()
    children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 1,
      sessions: [
        { sessionId: 'session-a', state: 'disposing' },
        { sessionId: 'session-b', state: 'active' }
      ]
    })
    children[0].message({
      id: 1,
      type: 'error',
      name: 'EmpvRuntimeGenerationFailure',
      message: 'native teardown failed after registry removal',
      recoverability: 'generation'
    })

    const [disposalResult, concurrentResult] = await Promise.allSettled([disposal, concurrent])
    assert.equal(disposalResult.status, 'rejected')
    assert.equal(concurrentResult.status, 'rejected')
    assert.ok(disposalResult.reason instanceof EmpvRuntimeProcessFailure)
    assert.equal(concurrentResult.reason, disposalResult.reason)
    assert.deepEqual(disposalResult.reason.terminalReason, {
      type: 'runtime-failure',
      requestId: 1,
      method: 'disposeSession',
      sessionId: 'session-a',
      errorName: 'EmpvRuntimeGenerationFailure',
      message: 'native teardown failed after registry removal'
    })
    assert.equal(children[0].killCalls, 1)
    await assert.rejects(
      client.invoke('isSupported'),
      /native teardown failed after registry removal/
    )

    children[0].exit(1)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.error.terminalReason.type, 'runtime-failure')
    assert.deepEqual(exits[0]?.sessions, [
      { sessionId: 'session-a', state: 'disposing' },
      { sessionId: 'session-b', state: 'active' }
    ])
  })

  test('rejects spawn deterministically when exit or fatal error happens before spawn', async () => {
    const exited = makeHarness()
    const exitBeforeSpawn = exited.client.invoke('isSupported')
    exited.children[0].exit(23)
    await assert.rejects(exitBeforeSpawn, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.equal(error.terminalReason.type, 'unexpected-exit')
      assert.equal(error.exitCode, 23)
      return true
    })

    const failed = makeHarness()
    const fatalBeforeSpawn = failed.client.invoke('isSupported')
    failed.children[0].fatal('bootstrap.cc:1', 'bootstrap failed')
    await assert.rejects(fatalBeforeSpawn, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.equal(error.terminalReason.type, 'fatal-error')
      return true
    })
    failed.children[0].exit(1)

    const signaled = makeHarness()
    const signalBeforeSpawn = signaled.client.invoke('isSupported')
    signaled.children[0].exit(null, 'SIGKILL')
    await assert.rejects(signalBeforeSpawn, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.equal(error.terminalReason.type, 'unexpected-exit')
      assert.equal(error.exitCode, null)
      assert.equal(error.exitSignal, 'SIGKILL')
      assert.match(error.message, /signal SIGKILL/)
      return true
    })
  })

  test('terminate is idempotent, rejects pending once, and diagnoses kill false', async () => {
    const exits: EmpvRuntimeProcessFailure[] = []
    const { children, client, diagnostics } = makeHarness()
    client.onExit((error) => exits.push(error))
    const pending = client.invoke('isSupported')
    let rejectionCount = 0
    void pending.catch(() => {
      rejectionCount += 1
    })
    children[0].spawn()
    await flush()
    children[0].killResult = false

    assert.doesNotThrow(() => client.terminate('watchdog expired'))
    assert.doesNotThrow(() => client.terminate('second reason must not replace the first'))
    assert.equal(children[0].killCalls, 1)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.deepEqual(error.terminalReason, {
        type: 'terminate',
        reason: 'watchdog expired'
      })
      return true
    })
    await assert.rejects(client.invoke('isSupported'), /watchdog expired/)
    children[0].exit(143)
    await flush()

    assert.equal(rejectionCount, 1)
    assert.equal(diagnostics.filter(({ type }) => type === 'kill-failed').length, 1)
    assert.equal(exits[0].terminalReason.type, 'terminate')
    assert.equal(exits[0].exitCode, 143)
  })

  test('contains child-process kill throws and reports them as diagnostics', async () => {
    const { children, client, diagnostics } = makeHarness()
    const pending = client.invoke('isSupported')
    children[0].spawn()
    await flush()
    children[0].killError = new Error('kill binding failed')

    assert.doesNotThrow(() => client.terminate('explicit shutdown'))
    await assert.rejects(pending, /explicit shutdown/)
    assert.equal(children[0].killCalls, 1)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].type, 'kill-failed')
    assert.match(diagnostics[0].error.message, /kill binding failed/)
    children[0].exit(1)
  })

  test('terminates the generation when a request hangs despite live heartbeats', async () => {
    const exits: EmpvRuntimeProcessFailure[] = []
    const { children, client } = makeHarness({ requestTimeoutMs: 40 })
    client.onExit((error) => exits.push(error))
    const timedOut = client.invoke('disposeSession', 'session-a')
    const concurrent = client.invoke('setVolume', 'session-b', 0.5)
    children[0].spawn()
    await flush()

    children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 1,
      sessions: [
        { sessionId: 'session-a', state: 'disposing' },
        { sessionId: 'session-b', state: 'active' }
      ]
    })
    await sleep(20)
    children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 2,
      sessions: [
        { sessionId: 'session-a', state: 'disposing' },
        { sessionId: 'session-b', state: 'active' }
      ]
    })

    const [timedOutResult, concurrentResult] = await Promise.allSettled([timedOut, concurrent])
    assert.equal(timedOutResult.status, 'rejected')
    assert.equal(concurrentResult.status, 'rejected')
    assert.ok(timedOutResult.reason instanceof EmpvRuntimeProcessFailure)
    assert.equal(concurrentResult.reason, timedOutResult.reason)
    assert.deepEqual(timedOutResult.reason.terminalReason, {
      type: 'request-timeout',
      requestId: 1,
      method: 'disposeSession',
      sessionId: 'session-a',
      timeoutMs: 40
    })
    assert.equal(children[0].killCalls, 1)

    // A late reply cannot revive the request or make this generation invokable.
    children[0].message({ id: 1, type: 'done', result: undefined })
    await assert.rejects(client.invoke('isSupported'), /did not answer disposeSession request #1/)
    children[0].exit(143)
    assert.equal(exits[0].terminalReason.type, 'request-timeout')
    assert.equal(exits[0].exitCode, 143)
  })

  test('applies the same deadline while the runtime process is still spawning', async () => {
    const { children, client } = makeHarness({ requestTimeoutMs: 20 })
    const pending = client.invoke('createSession', { options: { volume: 1 } })

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof EmpvRuntimeProcessFailure)
      assert.deepEqual(error.terminalReason, {
        type: 'request-timeout',
        requestId: 1,
        method: 'createSession',
        sessionId: null,
        timeoutMs: 20
      })
      return true
    })
    assert.equal(children[0].killCalls, 1)
    assert.deepEqual(children[0].posted, [])

    // A spawn event after timeout cannot send the abandoned request.
    children[0].spawn()
    await flush()
    assert.deepEqual(children[0].posted, [])
    children[0].exit(143)
  })

  test('ignores stale generation messages and exits after a respawn', async () => {
    const exits: EmpvRuntimeProcessFailure[] = []
    const { children, client } = makeHarness()
    client.onExit((error) => exits.push(error))
    const first = client.invoke('isSupported')
    children[0].spawn()
    await flush()
    children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 1,
      sessions: [{ sessionId: 'old-session', state: 'active' }]
    })
    children[0].exit(9)
    await assert.rejects(first)

    const second = client.invoke('isSupported')
    children[1].spawn()
    await flush()
    const secondRequestId = children[1].posted[0].id
    children[1].message({
      type: 'runtime.heartbeat',
      pid: 4_001,
      sentAt: 2,
      sessions: [{ sessionId: 'new-session', state: 'active' }]
    })

    children[0].message({ id: secondRequestId, type: 'done', result: false })
    children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 3,
      sessions: [{ sessionId: 'stale-session', state: 'active' }]
    })
    children[0].exit(10)
    assert.deepEqual(client.getSessionStates(), [{ sessionId: 'new-session', state: 'active' }])
    assert.equal(exits.length, 1)

    children[1].message({ id: secondRequestId, type: 'done', result: true })
    assert.equal(await second, true)
  })

  test('contains callback and listener throws while notifying every listener and cleaning up', async () => {
    const callbacks: string[] = []
    const diagnostics: EmpvRuntimeClientDiagnostic[] = []
    const harness = makeHarness({
      onSpawn: () => {
        throw new Error('spawn callback failed')
      },
      onHeartbeat: () => {
        throw new Error('heartbeat callback failed')
      },
      onStopped: () => {
        throw new Error('stopped callback failed')
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })
    harness.client.onSnapshot(() => {
      throw new Error('snapshot listener failed')
    })
    harness.client.onSnapshot(() => callbacks.push('snapshot'))
    harness.client.onExit(() => {
      throw new Error('exit listener failed')
    })
    harness.client.onExit(() => callbacks.push('exit'))

    const pending = harness.client.invoke('isSupported')
    harness.children[0].spawn()
    await flush()
    harness.children[0].message({
      type: 'runtime.heartbeat',
      pid: 4_000,
      sentAt: 1,
      sessions: []
    })
    harness.children[0].message({
      type: 'session.snapshot',
      sessionId: 'session-1',
      snapshot: null
    })
    harness.children[0].exit(5)
    await assert.rejects(pending)

    assert.deepEqual(callbacks, ['snapshot', 'exit'])
    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        diagnostic.type === 'callback-threw' ? diagnostic.callback : diagnostic.type
      ),
      ['onSpawn', 'onHeartbeat', 'snapshot-listener', 'onStopped', 'exit-listener']
    )
  })
})
