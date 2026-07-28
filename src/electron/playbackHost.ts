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
// Playing one video correctly takes four things to agree: the addon has to be
// loaded in THIS process (for the presenter), a mach service name has to be
// registered here and handed to the playback process at spawn, every session has
// to be paired with a presenter, and every frame event has to be turned into a
// presentSurface call with its four arguments in the right order. Nothing checks
// any of that at compile time, and getting it wrong produces a black rectangle
// with no error anywhere. So it lives here instead: the host mints the service
// name, registers it, loads the addon, and presents frames for whatever sessions
// are currently bound.
//
// This module deliberately does not import ./client.ts -- that would pull
// `electron` in and make the host unloadable (and untestable) outside a real
// main process. The client is handed in already built.
//
// The host is created lazily, when a presenter is first needed: building it
// loads the addon in this process, and a consumer that only wants to ask the
// utility whether playback is supported should not pay for that.

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
  // Reported when the first-load warm-up failed. That step is a performance
  // measure, not a correctness one (see below), so it is swallowed and surfaced
  // rather than thrown.
  onWarmUpFailed?: (error: unknown) => void
  // The impure boundary, injectable for tests. Production gets
  // loadEmbeddedLibMpvAddon.
  loadAddon?: () => Promise<LoadedEmbeddedLibMpvAddon>
}

type EmpvPlaybackHostCore = {
  readonly client: EmpvRuntimeClient
  readonly frameLinkServiceName: string
  // Pairs a session with the presenter its frames belong on. Until a session is
  // bound its frames are dropped: there is nowhere to put them, and presenting
  // onto a stale presenter is worse than showing nothing.
  bindSessionToPresenter(sessionId: string, presenterId: string): void
  // --- Presenter API, main process only ---
  // createPresenter lives on each facet, not here: the backends take different
  // attach options and an intersection cannot narrow what the core declares.
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
export type EmpvLayerHost = EmpvPlaybackHostCore & {
  readonly presentationKind: 'layer'
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvVideoLayerAttachOptions
  ): LibMpvRenderSize
  observeWindowOcclusion(windowHandle: Buffer, onChange: (visible: boolean) => void): void
  unobserveWindowOcclusion(windowHandle: Buffer): void
}

export type EmpvWindowHost = EmpvPlaybackHostCore & {
  readonly presentationKind: 'window'
  // Overlay only: this backend reparents an OS child window, which composites
  // above the web contents. The addon refuses 'underlay'; this refuses it at
  // compile time.
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvWindowAttachOptions
  ): LibMpvRenderSize
  adoptVideoWindow(presenterId: string, childWindowHandle: number): void
}

export type EmpvPlaybackHost = EmpvLayerHost | EmpvWindowHost

// One name per main process, fixed for its lifetime: the presenter registers it
// here and every utility spawn -- including every respawn after a crash -- looks
// up the same one.
export function createEmpvFrameLinkServiceName(): string {
  return `empv.frame-link.${process.pid}.${randomBytes(6).toString('hex')}`
}

// Loading the addon ends in a synchronous dlopen. On macOS the kernel validates
// the code signature of the addon and its vendored dylib chain on the first load
// after the binary changes, and caches the result per inode ACROSS processes.
// Doing that first load on the main thread stalls it for seconds on a freshly
// built binary -- long enough to beachball the UI and trip utility watchdogs. So
// the playback process is asked a trivial question first: it loads the addon
// there, and the load here lands on a warm cache.
//
// This is a performance step, NOT a fallback. Its failure is reported and
// swallowed; the real load below still happens and still throws.
async function warmSignatureCache(
  client: EmpvRuntimeClient,
  onWarmUpFailed?: (error: unknown) => void
): Promise<void> {
  try {
    await client.invoke('isSupported')
  } catch (error) {
    onWarmUpFailed?.(error)
  }
}

export async function createEmpvPlaybackHost(
  options: EmpvPlaybackHostOptions
): Promise<EmpvPlaybackHost> {
  const { client, frameLinkServiceName } = options
  const loadAddon = options.loadAddon ?? loadEmbeddedLibMpvAddon

  await warmSignatureCache(client, options.onWarmUpFailed)

  const loaded = await loadAddon()
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
  let presenterLinkStopped = loaded.presentationKind !== 'layer'

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

  if (loaded.presentationKind === 'layer') {
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
  }

  const core: EmpvPlaybackHostCore = {
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
      if (loaded.presentationKind === 'layer' && !presenterLinkStopped) {
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

  if (loaded.presentationKind === 'layer') {
    const machAddon = loaded.addon
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

  const widAddon = loaded.addon
  return {
    ...core,
    presentationKind: 'window',
    createPresenter: (presenterId, windowHandle, attachOptions) =>
      createTrackedPresenter(presenterId, () =>
        widAddon.createPresenter(presenterId, windowHandle, attachOptions)
      ),
    adoptVideoWindow: (presenterId, childWindowHandle) => {
      assertOpen('adopt a video window')
      requirePresenter(presenterId, 'adopt a video window')
      widAddon.adoptVideoWindow(presenterId, childWindowHandle)
    }
  }
}
