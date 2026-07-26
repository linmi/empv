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
  deliver(message: unknown): void
  posted: PostedMessage[]
  postedOfType(type: string): PostedMessage[]
}

const restores: Array<() => void> = []
const runningHandles: Array<{ stop(): void }> = []

function makeFakeParentPort(): FakePort {
  const posted: PostedMessage[] = []
  const listeners: Array<(event: { data: unknown }) => void> = []

  return {
    on(_event: 'message', handler: (event: { data: unknown }) => void) {
      listeners.push(handler)
    },
    postMessage(message: unknown) {
      posted.push(message as PostedMessage)
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
  test('refuses to run outside an Electron utility process', () => {
    // No port supplied and none on `process`: this is a plain Node process, not
    // an Electron utility process, and the runtime must say so instead of
    // silently never answering.
    assert.throws(() => startEmpvRuntimeProcess(), /Electron utility process/)
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
    port.deliver({ id: 9, method: 'seek', args: ['session-1', 12] })
    await sleep(20)

    assert.deepEqual(
      port.posted.filter((message) => message.id === 9),
      [{ id: 9, type: 'error', message: 'seek is out of range', name: 'RangeError' }]
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
      id: 21,
      method: 'setVideoAdjustments',
      args: ['session-1', 0.1, 0.2, 0.3, 0.4]
    })
    await sleep(20)

    assert.deepEqual(
      calls.filter((call) => call.method === 'setVideoAdjustments'),
      [{ method: 'setVideoAdjustments', args: ['session-1', 0.1, 0.2, 0.3, 0.4] }]
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

  // 'window' renders into an OS window the utility owns, so its handle has to
  // reach the main process for reparenting. 'layer' has no such window
  // and must not invent one.
  test('reports a video window handle only for the backend that has one', async () => {
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
    layerPort.deliver({ id: 1, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    const [layerReply] = layerPort.posted.filter((message) => message.id === 1)
    assert.ok(layerReply, 'The mach backend never answered sessions.create.')
    assert.equal(
      (layerReply.result as { videoWindowHandle: number | null }).videoWindowHandle,
      null
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
    windowPort.deliver({ id: 2, method: 'createSession', args: [{ options: { volume: 1 } }] })
    await sleep(20)
    const [windowReply] = windowPort.posted.filter((message) => message.id === 2)
    assert.ok(windowReply, 'The wid backend never answered sessions.create.')
    assert.equal(
      (windowReply.result as { videoWindowHandle: number | null }).videoWindowHandle,
      4242
    )
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
    port.deliver({ id: 1, method: 'createSession', args: [{ options: { volume: 1 } }] })
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
