import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { LibMpvWindowAttachOptions } from '../src/embedded.ts'
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
  // does it. Asking the playback process something trivial first makes that load
  // happen there, so the main-process load lands on a warm kernel cache.
  test('warms the playback process before loading the addon in this one', async () => {
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

  test('stops a newly-started layer link when frame subscription fails', async () => {
    const { loaded, calls } = makeLayerAddon()
    const fakeClient = makeFakeRuntimeClient({
      onFrame: () => {
        throw new Error('frame subscription failed')
      }
    })

    await assert.rejects(
      createEmpvPlaybackHost({
        client: fakeClient.client,
        frameLinkServiceName: createEmpvFrameLinkServiceName(),
        loadAddon: async () => loaded
      }),
      /frame subscription failed/
    )
    assert.equal(calls.filter((call) => call.method === 'startPresenterLink').length, 1)
    assert.equal(calls.filter((call) => call.method === 'stopPresenterLink').length, 1)
  })

  test('presents a bound session frame with the arguments the presenter expects', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    // Branching before reaching createPresenter is not ceremony: the two backends
    // take different attach options, so on the union only what both accept is
    // callable. 'underlay' is one of the things only the layer backend has.
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
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

  test('stops presenting before a presenter is destroyed', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()

    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })

    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
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
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })
    host.destroyPresenter('presenter-1')
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

    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
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
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })

    assert.deepEqual(failures, ['session-1'])
  })

  test('rejects duplicate presenters and non-existent bindings before reaching native code', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()
    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }

    assert.throws(
      () => host.bindSessionToPresenter('session-1', 'missing-presenter'),
      /presenter missing-presenter does not exist/
    )
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    assert.throws(
      () => host.createPresenter('presenter-1', WINDOW_HANDLE, options),
      /duplicate empv presenter presenter-1/
    )
    assert.equal(
      calls.filter((call) => call.method === 'createPresenter').length,
      1,
      'A duplicate id must not replace or close the native presenter already owned by the host.'
    )
  })

  test('enforces one-to-one session and presenter bindings', async () => {
    const { loaded } = makeLayerAddon()
    const host = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient().client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    host.createPresenter('presenter-2', WINDOW_HANDLE, options)
    host.bindSessionToPresenter('session-1', 'presenter-1')

    assert.throws(
      () => host.bindSessionToPresenter('session-1', 'presenter-2'),
      /session session-1.*already bound to presenter presenter-1/
    )
    assert.throws(
      () => host.bindSessionToPresenter('session-2', 'presenter-1'),
      /presenter presenter-1.*already bound to session session-1/
    )
  })

  test('removes frame routing before native presenter destruction starts', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon({
      destroyPresenter: () => {
        fakeClient.emitFrame({
          sessionId: 'session-1',
          surfaceIndex: 0,
          poolGeneration: 1,
          contentGeneration: 1
        })
      }
    })
    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay'
    })
    host.bindSessionToPresenter('session-1', 'presenter-1')
    host.destroyPresenter('presenter-1')

    assert.deepEqual(
      calls.filter((call) => call.method === 'presentSurface'),
      [],
      'A frame arriving during native destroy must already be disconnected.'
    )
  })

  test('retains failed presenter destruction as cleanup-only ownership and allows an explicit retry', async () => {
    const fakeClient = makeFakeRuntimeClient()
    let destructionAttempts = 0
    const { loaded, calls } = makeLayerAddon({
      destroyPresenter: () => {
        destructionAttempts += 1
        if (destructionAttempts === 1) {
          throw new Error('native detach failed')
        }
      }
    })
    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    host.bindSessionToPresenter('session-1', 'presenter-1')

    assert.throws(() => host.destroyPresenter('presenter-1'), /native detach failed/)
    assert.throws(
      () => host.setPresenterBounds('presenter-1', options),
      /retained only for cleanup.*retry destroyPresenter/
    )
    assert.throws(
      () => host.createPresenter('presenter-1', WINDOW_HANDLE, options),
      /duplicate empv presenter presenter-1/
    )
    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })
    assert.deepEqual(
      calls.filter((call) => call.method === 'presentSurface'),
      [],
      'A failed native destroy must not restore frame routing to uncertain native state.'
    )

    host.destroyPresenter('presenter-1')
    assert.equal(
      calls.filter((call) => call.method === 'destroyPresenter').length,
      2,
      'The retained cleanup ownership must reach native destruction again.'
    )
    assert.throws(
      () => host.destroyPresenter('presenter-1'),
      /presenter presenter-1 does not exist/
    )
  })

  test('disposes every presenter, the frame listener and the layer link exactly once', async () => {
    const fakeClient = makeFakeRuntimeClient()
    const { loaded, calls } = makeLayerAddon()
    const host = await createEmpvPlaybackHost({
      client: fakeClient.client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    host.createPresenter('presenter-2', WINDOW_HANDLE, options)
    host.bindSessionToPresenter('session-1', 'presenter-1')

    host.dispose()
    fakeClient.emitFrame({
      sessionId: 'session-1',
      surfaceIndex: 0,
      poolGeneration: 1,
      contentGeneration: 1
    })

    assert.deepEqual(
      calls.filter((call) => call.method === 'destroyPresenter'),
      [
        { method: 'destroyPresenter', args: ['presenter-1'] },
        { method: 'destroyPresenter', args: ['presenter-2'] }
      ]
    )
    assert.equal(calls.filter((call) => call.method === 'stopPresenterLink').length, 1)
    assert.deepEqual(
      calls.filter((call) => call.method === 'presentSurface'),
      []
    )
    host.dispose()
    assert.equal(calls.filter((call) => call.method === 'destroyPresenter').length, 2)
    assert.equal(calls.filter((call) => call.method === 'stopPresenterLink').length, 1)
    assert.throws(
      () => host.setPresenterBounds('presenter-1', options),
      /playback host is disposed/
    )
  })

  test('retries only unfinished host cleanup after disposal fails', async () => {
    let firstPresenterAttempt = true
    const { loaded, calls } = makeLayerAddon({
      destroyPresenter: (presenterId) => {
        if (presenterId === 'presenter-1' && firstPresenterAttempt) {
          firstPresenterAttempt = false
          throw new Error('presenter-1 detach failed')
        }
      }
    })
    const host = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient().client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    host.createPresenter('presenter-2', WINDOW_HANDLE, options)

    assert.throws(
      () => host.dispose(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 1)
        assert.match(String(error.errors[0]), /presenter-1 detach failed/)
        return true
      }
    )
    assert.throws(
      () => host.setPresenterBounds('presenter-2', options),
      /lifecycle is cleanup-required/
    )
    assert.deepEqual(
      calls.filter((call) => call.method === 'destroyPresenter'),
      [
        { method: 'destroyPresenter', args: ['presenter-1'] },
        { method: 'destroyPresenter', args: ['presenter-2'] }
      ]
    )
    assert.equal(calls.filter((call) => call.method === 'stopPresenterLink').length, 1)

    host.dispose()
    host.dispose()
    assert.deepEqual(
      calls.filter((call) => call.method === 'destroyPresenter'),
      [
        { method: 'destroyPresenter', args: ['presenter-1'] },
        { method: 'destroyPresenter', args: ['presenter-2'] },
        { method: 'destroyPresenter', args: ['presenter-1'] }
      ]
    )
    assert.equal(
      calls.filter((call) => call.method === 'stopPresenterLink').length,
      1,
      'A completed cleanup step must not run again during a presenter retry.'
    )
  })

  test('continues host disposal after presenter cleanup failures and reports them together', async () => {
    const { loaded, calls } = makeLayerAddon({
      destroyPresenter: (presenterId) => {
        throw new Error(`cannot close ${presenterId}`)
      }
    })
    const host = await createEmpvPlaybackHost({
      client: makeFakeRuntimeClient().client,
      frameLinkServiceName: createEmpvFrameLinkServiceName(),
      loadAddon: async () => loaded
    })
    if (host.presentationKind !== 'layer') {
      throw new Error(`expected the layer host, got ${host.presentationKind}`)
    }
    const options = {
      height: 180,
      width: 320,
      x: 0,
      y: 0,
      zOrder: 'underlay' as const
    }
    host.createPresenter('presenter-1', WINDOW_HANDLE, options)
    host.createPresenter('presenter-2', WINDOW_HANDLE, options)

    assert.throws(
      () => host.dispose(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 2)
        assert.match(String(error.errors[0]), /cannot close presenter-1/)
        assert.match(String(error.errors[1]), /cannot close presenter-2/)
        return true
      }
    )
    assert.equal(calls.filter((call) => call.method === 'destroyPresenter').length, 2)
    assert.equal(calls.filter((call) => call.method === 'stopPresenterLink').length, 1)
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

// A compile-time assertion, not a runtime one, and stated as a type rather than
// as a suppressed error: if 'underlay' ever becomes assignable to this backend's
// zOrder again, Expect<false> stops satisfying its own constraint and the type
// check fails. Writing it with a suppression directive would have asserted the
// same thing while spending a type-safety bypass to do it.
type Expect<T extends true> = T

type WindowBackendRefusesUnderlay = Expect<
  'underlay' extends LibMpvWindowAttachOptions['zOrder'] ? false : true
>

// Referenced so the type is not dead code. The addon refuses 'underlay' at run
// time as well; the two catch it at different moments -- this one before the
// code ships, that one for a JavaScript caller who never ran tsc at all.
test('the window backend cannot be asked for an underlay presenter', () => {
  const proof: WindowBackendRefusesUnderlay = true
  assert.equal(proof, true)
})
