import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  createEmpvFrameLinkServiceName,
  createEmpvPlaybackHost
} from '../src/electron/playbackHost.ts'
import { makeLayerAddon, makeWindowAddon } from './support/fakeAddon.ts'
import { makeFakeRuntimeClient } from './support/fakeClient.ts'

const WINDOW_HANDLE = Buffer.from([1, 2, 3, 4])

describe('createEmpvPlaybackHost', () => {
  test('hands the client the same frame-link name it registers with the addon', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()
    const frameLinkServiceName = createEmpvFrameLinkServiceName()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName,
      loadAddon: async () => loaded
    })

    const registration = calls.find((call) => call.method === 'startPresenterLink')
    assert.ok(registration, 'The mach frame-link receiver was never registered.')
    // Both ends must agree on one name. A player whose utility publishes to a
    // name the main process never registered renders into nothing, silently.
    assert.equal(host.frameLinkServiceName, frameLinkServiceName)
    assert.deepEqual(registration.args, [frameLinkServiceName])
  })

  test('does not register a mach link for a backend that has no link', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeWindowAddon()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    assert.equal(host.presentationKind, 'window')
    assert.equal(
      calls.some((call) => call.method === 'startPresenterLink'),
      false
    )
  })

  // The addon's first load validates code signatures and blocks whatever thread
  // does it. Asking the utility process something trivial first makes that load
  // happen there, so the main-process load lands on a warm kernel cache.
  test('warms the utility process before loading the addon in this one', async () => {
    const { loaded } = makeLayerAddon()
    const order: string[] = []
    const warming = makeFakeRuntimeClient({
      invoke: (method) => {
        order.push(`utility:${method}`)
        return true
      }
    })

    await createEmpvPlaybackHost({
      client: warming.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => {
        order.push('main:loadAddon')
        return loaded
      }
    })

    assert.deepEqual(order, ['utility:isSupported', 'main:loadAddon'])
  })

  test('reports a failed warm-up but still loads the addon', async () => {
    const failures: unknown[] = []
    const { loaded } = makeLayerAddon()
    let loadedInMain = false

    const host = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient({
        invoke: () => {
          throw new Error('utility is not up')
        }
      }).client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => {
        loadedInMain = true
        return loaded
      },
      onWarmUpFailed: (error) => failures.push(error)
    })

    // The warm-up is a performance step. Its failure must not become the
    // player's failure, but it must not vanish either.
    assert.equal(loadedInMain, true)
    assert.equal(failures.length, 1)
    assert.equal(host.presentationKind, 'layer')
  })

  test('presents a bound session frame with the arguments the presenter expects', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    host.createPresenter('presenter-1', WINDOW_HANDLE, {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay'
    })
    host.bindSessionToPresenter('session-1', 'presenter-1')

    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 2,
      poolGeneration: 5,
      contentGeneration: 9
    })

    // presentSurface takes (presenterId, poolGeneration, surfaceIndex,
    // contentGeneration) while the event reads surfaceIndex first. Swapping the
    // middle two is silent and shows the wrong slot.
    assert.deepEqual(
      calls.filter((call) => call.method === 'presentSurface'),
      [{ method: 'presentSurface', args: ['presenter-1', 5, 2, 9] }]
    )
  })

  test('drops frames for a session that is not bound to a presenter', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()

    await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    fakeClient.emitFrame({
      sessionId: 'never-bound',
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })

    assert.deepEqual(
      calls.filter((call) => call.method === 'presentSurface'),
      []
    )
  })

  test('stops presenting once a session is unbound', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    host.bindSessionToPresenter('session-1', 'presenter-1')
    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })
    host.unbindSession('session-1')
    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 1,
      poolGeneration: 1,
      contentGeneration: 2
    })

    // A presenter is destroyed when its session goes away; presenting onto it
    // afterwards is a use-after-free waiting to happen.
    assert.equal(calls.filter((call) => call.method === 'presentSurface').length, 1)
  })

  test('reports a failed present instead of throwing into the frame callback', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const failures: string[] = []
    const { loaded } = makeLayerAddon({
      presentSurface: () => {
        throw new Error('presenter is gone')
      }
    })

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded,
      onPresentFailed: (_error, sessionId) => failures.push(sessionId)
    })

    host.bindSessionToPresenter('session-1', 'presenter-1')
    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })

    assert.deepEqual(failures, ['session-1'])
  })

  test('exposes only the presenter facet its backend actually has', async () => {
    const layerHost = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient().client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => makeLayerAddon().loaded
    })
    const windowHost = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient().client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => makeWindowAddon().loaded
    })

    assert.equal(layerHost.presentationKind, 'layer')
    assert.equal(windowHost.presentationKind, 'window')
    if (layerHost.presentationKind === 'layer') {
      assert.equal(typeof layerHost.observeWindowOcclusion, 'function')
    }
    if (windowHost.presentationKind === 'window') {
      assert.equal(typeof windowHost.adoptVideoWindow, 'function')
    }
    assert.equal('adoptVideoWindow' in layerHost, false)
    assert.equal('observeWindowOcclusion' in windowHost, false)
  })
})
