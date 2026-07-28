import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, test } from 'node:test'

import { EMPV_FRAME_LINK_ENV_KEY } from '../src/electron/protocol.ts'
import { startEmpvRuntimeProcess } from '../src/electron/runtimeProcess.ts'
import type { EmpvRuntimeParentPort } from '../src/electron/runtimeProcess.ts'
import { makeLayerAddon, makeWindowAddon } from './support/fakeAddon.ts'

// Nothing here may let the idle timer fire: it calls process.exit and would take
// the test runner with it.
const NEVER_IDLE_MS = 60 * 60_000

type PostedMessage = Record<string, unknown>

type FakePort = EmpvRuntimeParentPort & {
  disconnect(): void
  deliver(message: unknown): void
  posted: PostedMessage[]
  postedOfType(type: string): PostedMessage[]
}

const restores: Array<() => void> = []
const runningHandles: Array<{ stop(): void }> = []

function makeFakeParentPort(): FakePort {
  const posted: PostedMessage[] = []
  const listeners: Array<(event: { data: unknown }) => void> = []
  const disconnectListeners: Array<() => void> = []

  return {
    on(_event: 'message', handler: (event: { data: unknown }) => void) {
      listeners.push(handler)
    },
    postMessage(message: unknown) {
      posted.push(message as PostedMessage)
    },
    onDisconnect(listener) {
      disconnectListeners.push(listener)
      return () => {
        const index = disconnectListeners.indexOf(listener)
        if (index >= 0) disconnectListeners.splice(index, 1)
      }
    },
    disconnect() {
      for (const listener of disconnectListeners) listener()
    },
    deliver(message: unknown) {
      assert.ok(listeners.length > 0, 'The runtime never subscribed to its parent port.')
      for (const listener of listeners) listener({ data: message })
    },
    posted,
    postedOfType: (type: string) => posted.filter((message) => message.type === type)
  }
}

// Resolved from outside so a test can hold the addon load open and observe what
// the runtime does while it is still loading.
function makeGate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function setFrameLinkServiceName(name: string | undefined): void {
  const previous = process.env[EMPV_FRAME_LINK_ENV_KEY]
  if (name === undefined) delete process.env[EMPV_FRAME_LINK_ENV_KEY]
  else process.env[EMPV_FRAME_LINK_ENV_KEY] = name
  restores.push(() => {
    if (previous === undefined) delete process.env[EMPV_FRAME_LINK_ENV_KEY]
    else process.env[EMPV_FRAME_LINK_ENV_KEY] = previous
  })
}

afterEach(() => {
  while (runningHandles.length > 0) runningHandles.pop()?.stop()
  while (restores.length > 0) restores.pop()?.()
})

describe('startEmpvRuntimeProcess', () => {
  test('refuses to run without a parent process IPC channel', () => {
    // No port supplied and this test runner has no parent IPC channel. The
    // runtime must say so instead of silently never answering.
    assert.throws(() => startEmpvRuntimeProcess(), /parentPort or a connected Node IPC channel/)
  })

  test('exits when its parent IPC channel disconnects', () => {
    const port = makeFakeParentPort()
    const exitCodes: number[] = []
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: () => new Promise(() => {}),
        exitProcess: (code) => {
          exitCodes.push(code)
        }
      })
    )

    port.disconnect()
    assert.deepEqual(exitCodes, [0])
  })

  // The addon load is a blocking dlopen. If heartbeats started before it, a slow
  // first load (macOS re-validating the code signature of the addon and its dylib
  // chain) would look like a hung process to a watchdog and get the runtime
  // killed while it was doing exactly what it should.
  test('publishes no heartbeat until the addon load has settled', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const loadGate = makeGate()
    const { loaded } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => {
          await loadGate.wait
          return loaded
        }
      })
    )

    await sleep(20)
    assert.deepEqual(
      port.postedOfType('runtime.heartbeat'),
      [],
      'A heartbeat before the load settles is exactly what makes a slow load look like a hang.'
    )

    loadGate.open()
    await sleep(20)
    assert.ok(
      port.postedOfType('runtime.heartbeat').length > 0,
      'Once the load has settled the process must report itself alive.'
    )
  })

  // A process that failed to load the addon is still alive and still answers
  // requests (with errors). Staying silent would get it killed and respawned
  // forever instead of surfacing the real failure.
  test('still heartbeats when the addon fails to load', async () => {
    const port = makeFakeParentPort()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => {
          throw new Error('no runtime staged')
        }
      })
    )

    await sleep(20)
    assert.ok(port.postedOfType('runtime.heartbeat').length > 0)
  })

  test('answers a request with the addon result, keyed to the request id', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 7, method: 'isSupported', args: [] })
    await sleep(20)

    assert.deepEqual(
      port.posted.filter((message) => message.id === 7),
      [{ id: 7, type: 'done', result: true }]
    )
  })

  test('reports an addon failure as an error reply rather than dying', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded } = makeLayerAddon({
      seek: () => {
        const error = new Error('seek is out of range')
        error.name = 'RangeError'
        throw error
      }
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 8,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({ id: 9, method: 'seek', args: ['session-1', 12] })
    await sleep(20)

    assert.deepEqual(
      port.posted.filter((message) => message.id === 9),
      [
        {
          id: 9,
          type: 'error',
          message: 'seek is out of range',
          name: 'RangeError',
          recoverability: 'request'
        }
      ]
    )
  })

  // Most of the contract is forwarded generically rather than case by case, so
  // the thing worth guarding is that a method reaches the addon under its own
  // name with its own arguments, untouched.
  test('forwards a contract method to the addon with its own arguments', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded, calls } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 20,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({
      id: 21,
      method: 'setVideoAdjustments',
      args: ['session-1', 0.1, 0.2, 0.3, 0.4]
    })
    await sleep(20)

    assert.deepEqual(
      calls.filter((call) => call.method === 'setVideoAdjustments'),
      [
        {
          method: 'setVideoAdjustments',
          args: ['session-1', 0.1, 0.2, 0.3, 0.4]
        }
      ]
    )
    const [reply] = port.posted.filter((message) => message.id === 21)
    assert.equal(reply?.type, 'done')
  })

  test('rejects a method that is not in the contract', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 11, method: 'selfDestruct', args: [] })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 11)
    assert.equal(reply?.type, 'error')
    assert.match(String(reply?.message), /Unsupported empv playback runtime method/)
  })

  test('a layer backend without a frame-link service name fails loudly', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName(undefined)
    const { loaded } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 13, method: 'isSupported', args: [] })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 13)
    assert.equal(reply?.type, 'error')
    assert.match(String(reply?.message), new RegExp(EMPV_FRAME_LINK_ENV_KEY))
  })

  test('keeps the window handle private to the runtime create result', async () => {
    const layerPort = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const layer = makeLayerAddon()
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: layerPort,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => layer.loaded
      })
    )
    layerPort.deliver({
      id: 1,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    const [layerReply] = layerPort.posted.filter((message) => message.id === 1)
    assert.ok(layerReply, 'The mach backend never answered sessions.create.')
    assert.equal('videoWindowHandle' in (layerReply.result as object), false)
    assert.deepEqual(
      layerPort
        .postedOfType('runtime.heartbeat')
        .map((message) => message.sessions)
        .filter((sessions) => Array.isArray(sessions) && sessions.length > 0),
      [
        [{ sessionId: 'session-1', state: 'creating', windowPresenter: null }],
        [{ sessionId: 'session-1', state: 'active', windowPresenter: null }]
      ]
    )

    const windowPort = makeFakeParentPort()
    const windowBackend = makeWindowAddon()
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: windowPort,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => windowBackend.loaded
      })
    )
    windowPort.deliver({
      id: 2,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    const [windowReply] = windowPort.posted.filter((message) => message.id === 2)
    assert.ok(windowReply, 'The wid backend never answered sessions.create.')
    assert.equal('videoWindowHandle' in (windowReply.result as object), false)
    assert.equal(
      windowBackend.calls.filter((call) => call.method === 'getVideoWindowHandle').length,
      1,
      'Window creation must still prove an adoptable child exists inside the runtime.'
    )
  })

  test('creates and adopts a window presenter as one runtime transaction', async () => {
    const port = makeFakeParentPort()
    const { loaded, calls } = makeWindowAddon({
      createPresenter: () => ({ widthPixels: 640, heightPixels: 360 }),
      setPresenterBounds: () => ({ widthPixels: 800, heightPixels: 450 })
    })
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 20,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({
      id: 21,
      method: 'createWindowPresenter',
      args: [
        {
          presenterId: 'presenter-1',
          sessionId: 'session-1',
          parentWindowHandle: new Uint8Array([1, 2, 3, 4]),
          options: { x: 10, y: 20, width: 320, height: 180, zOrder: 'overlay' }
        }
      ]
    })
    await sleep(20)

    assert.deepEqual(
      calls
        .filter((call) =>
          ['createPresenter', 'getVideoWindowHandle', 'adoptVideoWindow', 'setRenderSize'].includes(
            call.method
          )
        )
        .map((call) => call.method),
      [
        'getVideoWindowHandle',
        'createPresenter',
        'getVideoWindowHandle',
        'adoptVideoWindow',
        'setRenderSize'
      ]
    )
    assert.deepEqual(
      port.posted.filter((message) => message.id === 21),
      [{ id: 21, type: 'done', result: { heightPixels: 360, widthPixels: 640 } }]
    )
    assert.deepEqual(
      calls.filter((call) => call.method === 'setRenderSize'),
      [{ method: 'setRenderSize', args: ['session-1', 640, 360] }]
    )

    port.deliver({
      id: 27,
      method: 'setWindowPresenterBounds',
      args: ['presenter-1', { x: 0, y: 0, width: 800, height: 450 }]
    })
    await sleep(20)
    port.deliver({
      id: 28,
      method: 'setWindowPresenterSuspended',
      args: ['presenter-1', true]
    })
    await sleep(20)

    assert.deepEqual(
      calls.filter((call) => call.method === 'setRenderSize'),
      [
        { method: 'setRenderSize', args: ['session-1', 640, 360] },
        { method: 'setRenderSize', args: ['session-1', 800, 450] }
      ]
    )
    assert.deepEqual(
      calls.filter((call) =>
        ['setPresenterSuspended', 'setPresentationSuspended'].includes(call.method)
      ),
      [
        { method: 'setPresenterSuspended', args: ['presenter-1', true] },
        { method: 'setPresentationSuspended', args: ['session-1', true] }
      ]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      {
        sessionId: 'session-1',
        state: 'active',
        windowPresenter: { presenterId: 'presenter-1', state: 'active' }
      }
    ])
  })

  test('detaches an owned window presenter before disposing its session', async () => {
    const port = makeFakeParentPort()
    const { loaded, calls } = makeWindowAddon()
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 33, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    port.deliver({
      id: 34,
      method: 'createWindowPresenter',
      args: [
        {
          presenterId: 'presenter-1',
          sessionId: 'session-1',
          parentWindowHandle: new Uint8Array([1]),
          options: { x: 0, y: 0, width: 320, height: 180, zOrder: 'overlay' }
        }
      ]
    })
    await sleep(20)
    port.deliver({ id: 35, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)

    assert.deepEqual(
      calls
        .filter((call) => ['destroyPresenter', 'disposeSession'].includes(call.method))
        .map((call) => call.method),
      ['destroyPresenter', 'disposeSession']
    )
    assert.deepEqual(
      port.posted.filter((message) => message.id === 35),
      [{ id: 35, type: 'done', result: undefined }]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
  })

  test('rolls back native presenter creation when child adoption fails', async () => {
    const port = makeFakeParentPort()
    const { loaded, calls } = makeWindowAddon({
      adoptVideoWindow: () => {
        throw new Error('SetParent refused the child')
      }
    })
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 22, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    port.deliver({
      id: 23,
      method: 'createWindowPresenter',
      args: [
        {
          presenterId: 'presenter-1',
          sessionId: 'session-1',
          parentWindowHandle: new Uint8Array([1]),
          options: { x: 0, y: 0, width: 1, height: 1, zOrder: 'overlay' }
        }
      ]
    })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 23)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'request')
    assert.match(String(reply?.message), /SetParent refused the child/)
    assert.deepEqual(
      calls.filter((call) => call.method === 'destroyPresenter'),
      [{ method: 'destroyPresenter', args: ['presenter-1'] }]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      { sessionId: 'session-1', state: 'active', windowPresenter: null }
    ])
  })

  test('rolls back an adopted window presenter when initial render sizing fails', async () => {
    const port = makeFakeParentPort()
    const { loaded, calls } = makeWindowAddon({
      createPresenter: () => ({ widthPixels: 640, heightPixels: 360 }),
      setRenderSize: () => {
        throw new Error('render target rejected initial size')
      }
    })
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({ id: 29, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    port.deliver({
      id: 30,
      method: 'createWindowPresenter',
      args: [
        {
          presenterId: 'presenter-1',
          sessionId: 'session-1',
          parentWindowHandle: new Uint8Array([1]),
          options: { x: 0, y: 0, width: 640, height: 360, zOrder: 'overlay' }
        }
      ]
    })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 30)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'request')
    assert.match(String(reply?.message), /render target rejected initial size/)
    assert.deepEqual(
      calls.filter((call) => call.method === 'destroyPresenter'),
      [{ method: 'destroyPresenter', args: ['presenter-1'] }]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      { sessionId: 'session-1', state: 'active', windowPresenter: null }
    ])
  })

  test('makes failed window presenter destruction generation-fatal', async () => {
    const port = makeFakeParentPort()
    const exitCodes: number[] = []
    const { loaded } = makeWindowAddon({
      destroyPresenter: () => {
        throw new Error('native detach failed')
      }
    })
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded,
        exitProcess: (code) => exitCodes.push(code)
      })
    )
    port.deliver({ id: 24, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    port.deliver({
      id: 25,
      method: 'createWindowPresenter',
      args: [
        {
          presenterId: 'presenter-1',
          sessionId: 'session-1',
          parentWindowHandle: new Uint8Array([1]),
          options: { x: 0, y: 0, width: 1, height: 1, zOrder: 'overlay' }
        }
      ]
    })
    await sleep(20)
    port.deliver({ id: 26, method: 'destroyWindowPresenter', args: ['presenter-1'] })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 26)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'generation')
    assert.match(String(reply?.message), /native detach failed/)
    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      {
        sessionId: 'session-1',
        state: 'active',
        windowPresenter: { presenterId: 'presenter-1', state: 'cleanup-required' }
      }
    ])
  })

  test('makes a duplicate native session id generation-fatal without ambiguous cleanup', async () => {
    const port = makeFakeParentPort()
    const exitCodes: number[] = []
    setFrameLinkServiceName('test.frame.link')
    const { loaded, calls } = makeLayerAddon()
    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded,
        exitProcess: (code) => exitCodes.push(code)
      })
    )

    port.deliver({ id: 31, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    port.deliver({ id: 32, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 32)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'generation')
    assert.match(String(reply?.message), /duplicate session id session-1/)
    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(
      calls.filter((call) => call.method === 'disposeSession'),
      [],
      'The duplicate id cannot identify which native session would be destroyed.'
    )
  })

  test('rolls back a window session that has no adoptable native handle', async () => {
    const port = makeFakeParentPort()
    const { loaded, calls } = makeWindowAddon({
      getVideoWindowHandle: () => null
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 30,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 30)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'request')
    assert.match(String(reply?.message), /did not expose the video window handle/)
    assert.deepEqual(
      calls.filter((call) => call.method === 'disposeSession'),
      [{ method: 'disposeSession', args: ['session-1'] }]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
  })

  test('rolls back native creation when the public create result cannot be assembled', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded, calls } = makeLayerAddon({
      getSessionSnapshot: () => {
        throw new Error('snapshot lock poisoned')
      }
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 31,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)

    assert.deepEqual(
      calls.filter((call) => call.method === 'disposeSession'),
      [{ method: 'disposeSession', args: ['session-1'] }]
    )
    const [reply] = port.posted.filter((message) => message.id === 31)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'request')
    assert.match(String(reply?.message), /native session was rolled back: snapshot lock poisoned/)
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
  })

  test('makes a failed create rollback generation-fatal with both causes', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const exitCodes: number[] = []
    const { loaded } = makeLayerAddon({
      getSessionSnapshot: () => {
        throw new Error('snapshot read failed')
      },
      disposeSession: async () => {
        throw new Error('rollback teardown failed')
      }
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded,
        exitProcess: (code) => exitCodes.push(code)
      })
    )
    port.deliver({
      id: 32,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 32)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.name, 'EmpvRuntimeGenerationFailure')
    assert.equal(reply?.recoverability, 'generation')
    assert.match(String(reply?.message), /snapshot read failed/)
    assert.match(String(reply?.message), /rollback teardown failed/)
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
    assert.deepEqual(exitCodes, [1])
  })

  test('keeps disposal visible, rejects concurrent session commands, then removes the session', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const disposeGate = makeGate()
    const { loaded, calls } = makeLayerAddon({
      disposeSession: async () => disposeGate.wait
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 40,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({ id: 41, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)

    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      { sessionId: 'session-1', state: 'disposing', windowPresenter: null }
    ])
    port.deliver({ id: 42, method: 'setVolume', args: ['session-1', 0.5] })
    await sleep(20)
    const [concurrentReply] = port.posted.filter((message) => message.id === 42)
    assert.equal(concurrentReply?.type, 'error')
    assert.equal(concurrentReply?.recoverability, 'request')
    assert.match(String(concurrentReply?.message), /session session-1 is disposing, not active/)
    assert.equal(
      calls.filter((call) => call.method === 'setVolume').length,
      0,
      'A disposing native session must never receive another command.'
    )
    port.deliver({ id: 43, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)
    const [duplicateDisposeReply] = port.posted.filter((message) => message.id === 43)
    assert.equal(duplicateDisposeReply?.type, 'error')
    assert.equal(duplicateDisposeReply?.recoverability, 'request')
    assert.match(
      String(duplicateDisposeReply?.message),
      /session session-1 is disposing, not active/
    )
    assert.equal(
      calls.filter((call) => call.method === 'disposeSession').length,
      1,
      'Concurrent disposal must not run native teardown twice.'
    )

    disposeGate.open()
    await sleep(20)
    assert.deepEqual(
      port.posted.filter((message) => message.id === 41),
      [{ id: 41, type: 'done', result: undefined }]
    )
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
  })

  test('drops late native callbacks once disposal begins', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const disposeGate = makeGate()
    let publishSnapshot = (): void => {}
    let publishFrame = (): void => {}
    const { loaded } = makeLayerAddon({
      createSession: async (_options, onSnapshotChanged, onFrame) => {
        publishSnapshot = onSnapshotChanged
        publishFrame = () => onFrame(1, 2, 3)
        return 'session-1'
      },
      disposeSession: async () => disposeGate.wait
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 80,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({ id: 81, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)
    publishSnapshot()
    publishFrame()

    assert.deepEqual(port.postedOfType('session.snapshot'), [])
    assert.deepEqual(port.postedOfType('session.frame'), [])
    disposeGate.open()
    await sleep(20)
  })

  test('isolates a disposing session from another active session', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const disposeGate = makeGate()
    let nextSession = 1
    const { loaded, calls } = makeLayerAddon({
      createSession: async () => `session-${nextSession++}`,
      disposeSession: async () => disposeGate.wait
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 70,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({
      id: 71,
      method: 'createSession',
      args: [{ options: { volume: 0.5 } }]
    })
    await sleep(20)
    port.deliver({ id: 72, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)
    port.deliver({ id: 73, method: 'setVolume', args: ['session-2', 0.25] })
    await sleep(20)

    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      { sessionId: 'session-1', state: 'disposing', windowPresenter: null },
      { sessionId: 'session-2', state: 'active', windowPresenter: null }
    ])
    assert.deepEqual(
      calls.filter((call) => call.method === 'setVolume'),
      [{ method: 'setVolume', args: ['session-2', 0.25] }]
    )
    assert.deepEqual(
      port.posted.filter((message) => message.id === 73),
      [{ id: 73, type: 'done', result: undefined }]
    )

    disposeGate.open()
    await sleep(20)
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [
      { sessionId: 'session-2', state: 'active', windowPresenter: null }
    ])
  })

  test('treats native disposal failure as a generation ownership failure', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const exitCodes: number[] = []
    const { loaded } = makeLayerAddon({
      disposeSession: async () => {
        throw new Error('event loop would not stop')
      }
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded,
        exitProcess: (code) => exitCodes.push(code)
      })
    )
    port.deliver({
      id: 50,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)
    port.deliver({ id: 51, method: 'disposeSession', args: ['session-1'] })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 51)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'generation')
    assert.match(String(reply?.message), /session session-1/)
    assert.match(String(reply?.message), /event loop would not stop/)
    assert.deepEqual(port.postedOfType('runtime.heartbeat').at(-1)?.sessions, [])
    assert.deepEqual(exitCodes, [1])
  })

  test('rejects disposal of a session that this generation does not own', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    const { loaded, calls } = makeLayerAddon()

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 60,
      method: 'disposeSession',
      args: ['missing-session']
    })
    await sleep(20)

    const [reply] = port.posted.filter((message) => message.id === 60)
    assert.equal(reply?.type, 'error')
    assert.equal(reply?.recoverability, 'request')
    assert.match(String(reply?.message), /session missing-session does not exist/)
    assert.equal(calls.filter((call) => call.method === 'disposeSession').length, 0)
  })

  test('routes snapshot and frame notifications to the parent port', async () => {
    const port = makeFakeParentPort()
    setFrameLinkServiceName('test.frame.link')
    let publishSnapshot = (): void => {}
    let publishFrame = (_a: number, _b: number, _c: number): void => {}
    const { loaded } = makeLayerAddon({
      createSession: async (
        _options: unknown,
        onSnapshotChanged: () => void,
        onFrame: (a: number, b: number, c: number) => void
      ) => {
        publishSnapshot = onSnapshotChanged
        publishFrame = onFrame
        return 'session-1'
      }
    })

    runningHandles.push(
      startEmpvRuntimeProcess({
        parentPort: port,
        idleTimeoutMs: NEVER_IDLE_MS,
        loadAddon: async () => loaded
      })
    )
    port.deliver({
      id: 1,
      method: 'createSession',
      args: [{ options: { volume: 1 } }]
    })
    await sleep(20)

    publishSnapshot()
    publishFrame(2, 5, 9)

    const snapshotEvents = port.postedOfType('session.snapshot')
    assert.equal(snapshotEvents.length, 1)
    assert.equal(snapshotEvents[0]?.sessionId, 'session-1')
    // The notification carries no payload of its own: it must re-read the
    // addon's current snapshot rather than echo something the runtime made up.
    assert.equal(
      snapshotEvents[0]?.snapshot,
      loaded.addon.getSessionSnapshot('session-1'),
      'The forwarded snapshot must be the one the addon reports.'
    )
    assert.deepEqual(port.postedOfType('session.frame'), [
      {
        type: 'session.frame',
        sessionId: 'session-1',
        surfaceIndex: 2,
        poolGeneration: 5,
        contentGeneration: 9
      }
    ])
  })
})
