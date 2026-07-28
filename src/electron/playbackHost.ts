import { randomBytes } from 'node:crypto'

import {
  loadEmbeddedLibMpvAddon,
  type LibMpvRenderSize,
  type LibMpvVideoLayerAttachOptions,
  type LibMpvVideoLayerBounds,
  type LibMpvWindowAttachOptions,
  type LoadedEmbeddedLibMpvAddon
} from '../embedded.ts'

import type { EmpvRuntimeClient } from './client.ts'

// The main-process half of a crash-isolated player, and the piece a consumer is
// most likely to get wrong when handed the parts separately.
//
// The host probes the isolated runtime and exposes one discriminated presenter
// facet. On macOS it loads the layer addon in main, registers the mach frame
// link and routes bound frame events. On Windows/Linux it never loads native
// code in main: every presenter operation is a generation-pinned runtime RPC.
//
// This module deliberately does not import ./client.ts -- that would pull
// `electron` in and make the host unloadable (and untestable) outside a real
// main process. The client is handed in already built.
//
// The host is created lazily. Building a window host only probes the runtime;
// building a layer host additionally loads the main-process presenter facet.

export type EmpvPlaybackHostOptions = {
  // The client driving the playback process. It must have been created with the
  // same frameLinkServiceName passed below -- generate it once with
  // createEmpvFrameLinkServiceName() and hand that one value to both.
  client: EmpvRuntimeClient
  frameLinkServiceName: string
  // Reported when a frame could not be presented. Presenting is best-effort --
  // the presenter keeps its last frame and the next frame retries -- but a
  // consumer that wants to see the failures gets them here rather than through a
  // logger this package would have to choose.
  onPresentFailed?: (error: unknown, sessionId: string) => void
  // Layer-only impure boundary, injectable for tests. Window presentation never
  // calls it: loading empv.node/libmpv in Electron main would defeat crash
  // isolation even if every session stayed in the runtime process.
  loadAddon?: () => Promise<LoadedEmbeddedLibMpvAddon>
}

type EmpvLayerHostCore = {
  readonly client: EmpvRuntimeClient
  readonly frameLinkServiceName: string
  // Pairs a session with the presenter its frames belong on. Until a session is
  // bound its frames are dropped: there is nowhere to put them, and presenting
  // onto a stale presenter is worse than showing nothing.
  bindSessionToPresenter(sessionId: string, presenterId: string): void
  setPresenterBounds(presenterId: string, bounds: LibMpvVideoLayerBounds): LibMpvRenderSize
  refreshPresenterScale(presenterId: string): LibMpvRenderSize
  setPresenterSuspended(presenterId: string, suspended: boolean): void
  // Removes the frame binding before native destruction, so a late frame can
  // never target a presenter whose teardown has begun. A failed native destroy
  // retains cleanup-only ownership so the caller or final host disposal can retry.
  destroyPresenter(presenterId: string): void
  setWindowBackdrop(windowHandle: Buffer, color: string | null): void
  // Final host teardown. Destroys every owned presenter, removes the frame
  // listener and (on layer) stops the mach receiver. Cleanup is exhaustive:
  // every step runs and all failures are reported together. Failed steps remain
  // retryable through another dispose call; a completed disposal is idempotent.
  dispose(): void
}

// The two facets stay disjoint here exactly as they are on the addon: a caller
// branches on presentationKind to reach the half that exists.
export type EmpvLayerHost = EmpvLayerHostCore & {
  readonly presentationKind: 'layer'
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvVideoLayerAttachOptions
  ): LibMpvRenderSize
  observeWindowOcclusion(windowHandle: Buffer, onChange: (visible: boolean) => void): void
  unobserveWindowOcclusion(windowHandle: Buffer): void
}

export type EmpvWindowHost = {
  readonly client: EmpvRuntimeClient
  readonly frameLinkServiceName: string
  readonly presentationKind: 'window'
  // Window presentation is a generation-bound runtime transaction. The
  // generation and session id must come from one invokeWithGeneration result so
  // a raw id can never be rebound to whichever runtime happens to be current.
  createPresenter(
    presenterId: string,
    generation: number,
    sessionId: string,
    windowHandle: Buffer,
    options: LibMpvWindowAttachOptions
  ): Promise<LibMpvRenderSize>
  setPresenterBounds(presenterId: string, bounds: LibMpvVideoLayerBounds): Promise<LibMpvRenderSize>
  refreshPresenterScale(presenterId: string): Promise<LibMpvRenderSize>
  setPresenterSuspended(presenterId: string, suspended: boolean): Promise<void>
  destroyPresenter(presenterId: string): Promise<void>
  dispose(): Promise<void>
}

export type EmpvPlaybackHost = EmpvLayerHost | EmpvWindowHost

// One name per main process, fixed for its lifetime: the presenter registers it
// here and every utility spawn -- including every respawn after a crash -- looks
// up the same one.
export function createEmpvFrameLinkServiceName(): string {
  return `empv.frame-link.${process.pid}.${randomBytes(6).toString('hex')}`
}

type WindowPresenterRecord = {
  presenterId: string
  sessionId: string
  generation: number
  state: 'creating' | 'active' | 'disposing' | 'cleanup-required'
  creation: Promise<LibMpvRenderSize>
  tail: Promise<void>
  destruction: Promise<void> | null
}

function createWindowPlaybackHost(
  client: EmpvRuntimeClient,
  frameLinkServiceName: string
): EmpvWindowHost {
  const presenters = new Map<string, WindowPresenterRecord>()
  let lifecycle: 'open' | 'disposing' | 'cleanup-required' | 'disposed' = 'open'
  let disposePromise: Promise<void> | null = null

  function assertOpen(operation: string): void {
    if (lifecycle === 'disposed') {
      throw new Error(`Cannot ${operation}: the empv playback host is disposed.`)
    }
    if (lifecycle !== 'open') {
      throw new Error(
        `Cannot ${operation}: the empv playback host lifecycle is ${lifecycle}; only dispose may continue cleanup.`
      )
    }
  }

  function requirePresenter(presenterId: string, operation: string): WindowPresenterRecord {
    const record = presenters.get(presenterId)
    if (!record) {
      throw new Error(`Cannot ${operation}: empv window presenter ${presenterId} does not exist.`)
    }
    if ((record.state !== 'creating' && record.state !== 'active') || record.destruction) {
      throw new Error(
        `Cannot ${operation}: empv window presenter ${presenterId} is ${record.state}${record.destruction ? ' with destruction already scheduled' : ''}.`
      )
    }
    return record
  }

  function enqueue<Value>(
    record: WindowPresenterRecord,
    operation: () => Promise<Value>
  ): Promise<Value> {
    const result = record.tail.then(async () => {
      if (presenters.get(record.presenterId) !== record) {
        throw new Error(
          `Cannot continue empv window presenter ${record.presenterId}: its runtime generation ownership has ended.`
        )
      }
      return operation()
    })
    record.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function destroyRecord(record: WindowPresenterRecord): Promise<void> {
    if (record.destruction) return record.destruction

    const destruction = enqueue(record, async () => {
      record.state = 'disposing'
      try {
        await client.invokeInGeneration(
          record.generation,
          'destroyWindowPresenter',
          record.presenterId
        )
      } catch (error) {
        if (presenters.get(record.presenterId) === record) {
          record.state = 'cleanup-required'
          record.destruction = null
        }
        throw error
      }
      if (presenters.get(record.presenterId) === record) {
        presenters.delete(record.presenterId)
      }
    })
    record.destruction = destruction
    return destruction
  }

  // A process-generation exit is itself the cleanup boundary for window
  // presenters: their HWND/X11 resources belonged to that process and are gone.
  // Clearing local ownership is deliberately side-effect free; invoking here
  // would spawn a new generation and could target a reused raw native id.
  const removeExitListener = client.onExit(() => {
    presenters.clear()
  })

  return {
    client,
    frameLinkServiceName,
    presentationKind: 'window',
    createPresenter(presenterId, generation, sessionId, windowHandle, attachOptions) {
      assertOpen('create a presenter')
      if (presenters.has(presenterId)) {
        throw new Error(`Cannot create duplicate empv window presenter ${presenterId}.`)
      }
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(
          `Cannot create empv window presenter ${presenterId}: runtime generation must be a positive safe integer, received ${String(generation)}.`
        )
      }

      const record: WindowPresenterRecord = {
        presenterId,
        sessionId,
        generation,
        state: 'creating',
        creation: Promise.resolve({ widthPixels: 0, heightPixels: 0 }),
        tail: Promise.resolve(),
        destruction: null
      }
      presenters.set(presenterId, record)

      record.creation = client
        .invokeInGeneration(generation, 'createWindowPresenter', {
          presenterId,
          sessionId,
          parentWindowHandle: windowHandle,
          options: attachOptions
        })
        .then(
          (renderSize) => {
            if (presenters.get(presenterId) !== record) {
              throw new Error(
                `Empv window presenter ${presenterId} was created after runtime generation ${generation} ownership ended.`
              )
            }
            record.state = 'active'
            return renderSize
          },
          (error: unknown) => {
            if (presenters.get(presenterId) === record) presenters.delete(presenterId)
            throw error
          }
        )
      record.tail = record.creation.then(
        () => undefined,
        () => undefined
      )
      return record.creation
    },
    setPresenterBounds(presenterId, bounds) {
      assertOpen('set presenter bounds')
      const record = requirePresenter(presenterId, 'set presenter bounds')
      return enqueue(record, () =>
        client.invokeInGeneration(
          record.generation,
          'setWindowPresenterBounds',
          presenterId,
          bounds
        )
      )
    },
    refreshPresenterScale(presenterId) {
      assertOpen('refresh presenter scale')
      const record = requirePresenter(presenterId, 'refresh presenter scale')
      return enqueue(record, () =>
        client.invokeInGeneration(record.generation, 'refreshWindowPresenterScale', presenterId)
      )
    },
    setPresenterSuspended(presenterId, suspended) {
      assertOpen('set presenter suspension')
      const record = requirePresenter(presenterId, 'set presenter suspension')
      return enqueue(record, () =>
        client.invokeInGeneration(
          record.generation,
          'setWindowPresenterSuspended',
          presenterId,
          suspended
        )
      )
    },
    destroyPresenter(presenterId) {
      assertOpen('destroy a presenter')
      const record = presenters.get(presenterId)
      if (!record) {
        throw new Error(
          `Cannot destroy a presenter: empv window presenter ${presenterId} does not exist.`
        )
      }
      return destroyRecord(record)
    },
    dispose() {
      if (lifecycle === 'disposed') return Promise.resolve()
      if (lifecycle === 'disposing' && disposePromise) return disposePromise
      lifecycle = 'disposing'

      disposePromise = (async () => {
        const failures: unknown[] = []
        const pendingCreations = [...presenters.values()].map((record) => record.creation)
        await Promise.allSettled(pendingCreations)

        const owned = [...presenters.values()]
        const results = await Promise.allSettled(owned.map((record) => destroyRecord(record)))
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason)
        }

        if (failures.length > 0) {
          lifecycle = 'cleanup-required'
          throw new AggregateError(failures, 'Failed to dispose the empv window playback host.')
        }
        removeExitListener()
        lifecycle = 'disposed'
      })()
      return disposePromise.finally(() => {
        if (lifecycle === 'cleanup-required') disposePromise = null
      })
    }
  }
}

export async function createEmpvPlaybackHost(
  options: EmpvPlaybackHostOptions
): Promise<EmpvPlaybackHost> {
  const { client, frameLinkServiceName } = options
  const probe = await client.invoke('probe')
  if (!probe.supported) {
    throw new Error(
      `The empv runtime reports that ${probe.presentationKind} presentation is unsupported in this environment.`
    )
  }
  if (probe.presentationKind === 'window') {
    return createWindowPlaybackHost(client, frameLinkServiceName)
  }

  const loadAddon = options.loadAddon ?? loadEmbeddedLibMpvAddon
  const loaded = await loadAddon()
  if (loaded.presentationKind !== probe.presentationKind) {
    throw new Error(
      `The empv runtime reports ${probe.presentationKind} presentation, but the Electron main addon reports ${loaded.presentationKind}; refusing to join mismatched native backends.`
    )
  }
  if (loaded.presentationKind !== 'layer') {
    throw new Error(
      `The empv window backend must remain isolated in the runtime process; refusing to load it in Electron main.`
    )
  }
  const { addon } = loaded

  // The mach frame-link receiver only exists on 'layer'. 'window'
  // reparents an OS video window instead -- no link, no presentSurface. A failed
  // registration throws here rather than leaving frames with nowhere to land.
  const presenterIds = new Set<string>()
  const failedPresenterIds = new Set<string>()
  const presenterBySession = new Map<string, string>()
  const sessionByPresenter = new Map<string, string>()
  let lifecycle: 'open' | 'disposing' | 'cleanup-required' | 'disposed' = 'open'
  let removeFrameListener = (): void => {}
  let frameListenerRemoved = false
  let presenterLinkStopped = false

  function assertOpen(operation: string): void {
    if (lifecycle === 'disposed') {
      throw new Error(`Cannot ${operation}: the empv playback host is disposed.`)
    }
    if (lifecycle !== 'open') {
      throw new Error(
        `Cannot ${operation}: the empv playback host lifecycle is ${lifecycle}; only dispose may continue cleanup.`
      )
    }
  }

  function createTrackedPresenter(
    presenterId: string,
    create: () => LibMpvRenderSize
  ): LibMpvRenderSize {
    assertOpen('create a presenter')
    if (presenterIds.has(presenterId)) {
      throw new Error(`Cannot create duplicate empv presenter ${presenterId}.`)
    }

    const renderSize = create()
    presenterIds.add(presenterId)
    return renderSize
  }

  function requirePresenter(presenterId: string, operation: string): void {
    if (!presenterIds.has(presenterId)) {
      throw new Error(`Cannot ${operation}: empv presenter ${presenterId} does not exist.`)
    }
    if (failedPresenterIds.has(presenterId)) {
      throw new Error(
        `Cannot ${operation}: empv presenter ${presenterId} is retained only for cleanup because its previous destruction failed; retry destroyPresenter.`
      )
    }
  }

  const machAddon = loaded.addon
  machAddon.startPresenterLink(frameLinkServiceName)
  try {
    removeFrameListener = client.onFrame((event) => {
      const presenterId = presenterBySession.get(event.sessionId)
      if (presenterId === undefined) return

      try {
        machAddon.presentSurface(
          presenterId,
          event.poolGeneration,
          event.surfaceIndex,
          event.contentGeneration
        )
      } catch (error) {
        options.onPresentFailed?.(error, event.sessionId)
      }
    })
  } catch (error) {
    try {
      machAddon.stopPresenterLink()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Failed to subscribe the empv frame listener and stop the presenter link during rollback.'
      )
    }
    throw error
  }

  const core: EmpvLayerHostCore = {
    client,
    frameLinkServiceName,
    bindSessionToPresenter(sessionId, presenterId) {
      assertOpen('bind a session to a presenter')
      requirePresenter(presenterId, 'bind a session')
      const boundPresenter = presenterBySession.get(sessionId)
      if (boundPresenter !== undefined) {
        throw new Error(
          `Cannot bind empv session ${sessionId} to presenter ${presenterId}: it is already bound to presenter ${boundPresenter}.`
        )
      }
      const boundSession = sessionByPresenter.get(presenterId)
      if (boundSession !== undefined) {
        throw new Error(
          `Cannot bind empv presenter ${presenterId} to session ${sessionId}: it is already bound to session ${boundSession}.`
        )
      }
      presenterBySession.set(sessionId, presenterId)
      sessionByPresenter.set(presenterId, sessionId)
    },
    setPresenterBounds(presenterId, bounds) {
      assertOpen('set presenter bounds')
      requirePresenter(presenterId, 'set presenter bounds')
      return addon.setPresenterBounds(presenterId, bounds)
    },
    refreshPresenterScale(presenterId) {
      assertOpen('refresh presenter scale')
      requirePresenter(presenterId, 'refresh presenter scale')
      return addon.refreshPresenterScale(presenterId)
    },
    setPresenterSuspended(presenterId, suspended) {
      assertOpen('set presenter suspension')
      requirePresenter(presenterId, 'set presenter suspension')
      addon.setPresenterSuspended(presenterId, suspended)
    },
    destroyPresenter(presenterId) {
      assertOpen('destroy a presenter')
      if (!presenterIds.has(presenterId)) {
        throw new Error(`Cannot destroy a presenter: empv presenter ${presenterId} does not exist.`)
      }
      const sessionId = sessionByPresenter.get(presenterId)
      if (sessionId !== undefined) {
        sessionByPresenter.delete(presenterId)
        presenterBySession.delete(sessionId)
      }
      try {
        addon.destroyPresenter(presenterId)
      } catch (error) {
        failedPresenterIds.add(presenterId)
        throw error
      }
      failedPresenterIds.delete(presenterId)
      presenterIds.delete(presenterId)
    },
    setWindowBackdrop(windowHandle, color) {
      assertOpen('set a window backdrop')
      addon.setWindowBackdrop(windowHandle, color)
    },
    dispose() {
      if (lifecycle === 'disposed') {
        return
      }
      if (lifecycle === 'disposing') {
        throw new Error('Cannot dispose the empv playback host reentrantly.')
      }
      lifecycle = 'disposing'

      const failures: unknown[] = []
      presenterBySession.clear()
      sessionByPresenter.clear()
      const ownedPresenterIds = [...presenterIds]

      for (const presenterId of ownedPresenterIds) {
        try {
          addon.destroyPresenter(presenterId)
          failedPresenterIds.delete(presenterId)
          presenterIds.delete(presenterId)
        } catch (error) {
          failedPresenterIds.add(presenterId)
          failures.push(error)
        }
      }
      if (!frameListenerRemoved) {
        try {
          removeFrameListener()
          frameListenerRemoved = true
        } catch (error) {
          failures.push(error)
        }
      }
      if (!presenterLinkStopped) {
        try {
          loaded.addon.stopPresenterLink()
          presenterLinkStopped = true
        } catch (error) {
          failures.push(error)
        }
      }

      if (failures.length > 0) {
        lifecycle = 'cleanup-required'
        throw new AggregateError(failures, 'Failed to dispose the empv playback host completely.')
      }
      lifecycle = 'disposed'
    }
  }

  return {
    ...core,
    presentationKind: 'layer',
    createPresenter: (presenterId, windowHandle, attachOptions) =>
      createTrackedPresenter(presenterId, () =>
        machAddon.createPresenter(presenterId, windowHandle, attachOptions)
      ),
    observeWindowOcclusion: (windowHandle, onChange) => {
      assertOpen('observe window occlusion')
      machAddon.observeWindowOcclusion(windowHandle, onChange)
    },
    unobserveWindowOcclusion: (windowHandle) => {
      assertOpen('stop observing window occlusion')
      machAddon.unobserveWindowOcclusion(windowHandle)
    }
  }
}
