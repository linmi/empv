import { randomBytes } from 'node:crypto'

import {
  loadEmbeddedLibMpvAddon,
  type LibMpvRenderSize,
  type LibMpvVideoLayerAttachOptions,
  type LibMpvVideoLayerBounds,
  type LoadedEmbeddedLibMpvAddon
} from '../embedded.ts'

import type { EmpvRuntimeClient } from './client.ts'

// The main-process half of a crash-isolated player, and the piece a consumer is
// most likely to get wrong when handed the parts separately.
//
// Playing one video correctly takes four things to agree: the addon has to be
// loaded in THIS process (for the presenter), a mach service name has to be
// registered here and handed to the utility process at spawn, every session has
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
  // The client driving the utility process. It must have been created with the
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
  unbindSession(sessionId: string): void
  // --- Presenter API, main process only ---
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvVideoLayerAttachOptions
  ): LibMpvRenderSize
  setPresenterBounds(presenterId: string, bounds: LibMpvVideoLayerBounds): LibMpvRenderSize
  refreshPresenterScale(presenterId: string): LibMpvRenderSize
  setPresenterSuspended(presenterId: string, suspended: boolean): void
  destroyPresenter(presenterId: string): void
  setWindowBackdrop(windowHandle: Buffer, color: string | null): void
}

// The two facets stay disjoint here exactly as they are on the addon: a caller
// branches on presentationKind to reach the half that exists.
export type EmpvIoSurfaceMachHost = EmpvPlaybackHostCore & {
  readonly presentationKind: 'iosurface-mach'
  observeWindowOcclusion(windowHandle: Buffer, onChange: (visible: boolean) => void): void
  unobserveWindowOcclusion(windowHandle: Buffer): void
}

export type EmpvWidWindowHost = EmpvPlaybackHostCore & {
  readonly presentationKind: 'wid-window'
  adoptVideoWindow(presenterId: string, childWindowHandle: number): void
}

export type EmpvPlaybackHost = EmpvIoSurfaceMachHost | EmpvWidWindowHost

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
// the utility process is asked a trivial question first: it loads the addon
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

  // The mach frame-link receiver only exists on 'iosurface-mach'. 'wid-window'
  // reparents an OS video window instead -- no link, no presentSurface. A failed
  // registration throws here rather than leaving frames with nowhere to land.
  if (loaded.presentationKind === 'iosurface-mach') {
    loaded.addon.startPresenterLink(frameLinkServiceName)
  }

  const presenterBySession = new Map<string, string>()

  if (loaded.presentationKind === 'iosurface-mach') {
    const machAddon = loaded.addon
    client.onFrame((event) => {
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
  }

  const core: EmpvPlaybackHostCore = {
    client,
    frameLinkServiceName,
    bindSessionToPresenter(sessionId, presenterId) {
      presenterBySession.set(sessionId, presenterId)
    },
    unbindSession(sessionId) {
      presenterBySession.delete(sessionId)
    },
    createPresenter: (presenterId, windowHandle, attachOptions) =>
      addon.createPresenter(presenterId, windowHandle, attachOptions),
    setPresenterBounds: (presenterId, bounds) => addon.setPresenterBounds(presenterId, bounds),
    refreshPresenterScale: (presenterId) => addon.refreshPresenterScale(presenterId),
    setPresenterSuspended: (presenterId, suspended) =>
      addon.setPresenterSuspended(presenterId, suspended),
    destroyPresenter: (presenterId) => addon.destroyPresenter(presenterId),
    setWindowBackdrop: (windowHandle, color) => addon.setWindowBackdrop(windowHandle, color)
  }

  if (loaded.presentationKind === 'iosurface-mach') {
    const machAddon = loaded.addon
    return {
      ...core,
      presentationKind: 'iosurface-mach',
      observeWindowOcclusion: (windowHandle, onChange) =>
        machAddon.observeWindowOcclusion(windowHandle, onChange),
      unobserveWindowOcclusion: (windowHandle) => machAddon.unobserveWindowOcclusion(windowHandle)
    }
  }

  const widAddon = loaded.addon
  return {
    ...core,
    presentationKind: 'wid-window',
    adoptVideoWindow: (presenterId, childWindowHandle) =>
      widAddon.adoptVideoWindow(presenterId, childWindowHandle)
  }
}
