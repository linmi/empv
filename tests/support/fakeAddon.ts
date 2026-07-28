import type {
  LibMpvCapturedFrame,
  LibMpvLayerAddon,
  LibMpvPlayback,
  LibMpvRenderSize,
  LibMpvSessionOptions,
  LibMpvSessionSnapshot,
  LibMpvWindowAddon,
  LoadedEmbeddedLibMpvAddon
} from '../../src/embedded.ts'
import type { LibMpvRuntime } from '../../src/runtime.ts'

// A test double that really satisfies the published contract rather than being
// asserted into it. If the contract grows a function, this stops compiling --
// which is the point: a double that silently falls behind the contract tests
// nothing.

export type AddonCall = { method: string; args: unknown[] }

export type FakeAddonOverrides = {
  createSession?: (
    options: LibMpvSessionOptions,
    onSnapshotChanged: () => void,
    onFrame: (surfaceIndex: number, poolGeneration: number, contentGeneration: number) => void
  ) => Promise<string>
  disposeSession?: (sessionId: string) => Promise<void>
  seek?: (sessionId: string, seconds: number) => void
  getSessionSnapshot?: (sessionId: string) => LibMpvSessionSnapshot | null
  getVideoWindowHandle?: (sessionId: string) => number | null
  presentSurface?: () => void
  destroyPresenter?: (presenterId: string) => void
}

const IDLE_SNAPSHOT: LibMpvSessionSnapshot = {
  durationSeconds: null,
  playbackReadyGeneration: 0,
  positionSeconds: 0,
  status: 'idle',
  streamUrl: '',
  volume: 1
}

const RENDER_SIZE: LibMpvRenderSize = { heightPixels: 0, widthPixels: 0 }

const FAKE_RUNTIME: LibMpvRuntime = {
  addonPath: '/fake/empv.node',
  arch: 'arm64',
  available: true,
  includeDirectory: null,
  libraryPath: '/fake/lib/libmpv.dylib',
  manifest: null,
  manifestPath: null,
  missing: [],
  platform: 'darwin',
  platformKey: 'darwin-arm64',
  runtimeDirectory: '/fake'
}

type FakeAddon<Kind extends 'layer' | 'window'> = {
  calls: AddonCall[]
  loaded: Extract<LoadedEmbeddedLibMpvAddon, { presentationKind: Kind }>
}

function makeCore(calls: AddonCall[], overrides: FakeAddonOverrides) {
  const note =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args })
    }

  return {
    isSupported: (): boolean => {
      calls.push({ method: 'isSupported', args: [] })
      return true
    },
    createSession: async (
      options: LibMpvSessionOptions,
      onSnapshotChanged: () => void,
      onFrame: (surfaceIndex: number, poolGeneration: number, contentGeneration: number) => void
    ): Promise<string> => {
      calls.push({ method: 'createSession', args: [options] })
      if (overrides.createSession)
        return overrides.createSession(options, onSnapshotChanged, onFrame)
      return 'session-1'
    },
    disposeSession: async (sessionId: string): Promise<void> => {
      calls.push({ method: 'disposeSession', args: [sessionId] })
      await overrides.disposeSession?.(sessionId)
    },
    loadPlayback: (sessionId: string, playback: LibMpvPlayback): void => {
      calls.push({ method: 'loadPlayback', args: [sessionId, playback] })
    },
    getSessionSnapshot: (sessionId: string): LibMpvSessionSnapshot | null => {
      calls.push({ method: 'getSessionSnapshot', args: [sessionId] })
      return overrides.getSessionSnapshot ? overrides.getSessionSnapshot(sessionId) : IDLE_SNAPSHOT
    },
    captureFrame: (sessionId: string): LibMpvCapturedFrame | null => {
      calls.push({ method: 'captureFrame', args: [sessionId] })
      return null
    },
    setRenderSize: note('setRenderSize'),
    setPresentationSuspended: note('setPresentationSuspended'),
    reloadSubtitle: note('reloadSubtitle'),
    seek: (sessionId: string, seconds: number): void => {
      calls.push({ method: 'seek', args: [sessionId, seconds] })
      overrides.seek?.(sessionId, seconds)
    },
    replay: note('replay'),
    playlistSync: note('playlistSync'),
    playlistPlayIndex: note('playlistPlayIndex'),
    playlistLocateIndex: note('playlistLocateIndex'),
    setPlaylistAutoAdvance: note('setPlaylistAutoAdvance'),
    setAbLoop: note('setAbLoop'),
    setAspect: note('setAspect'),
    setAudioDelay: note('setAudioDelay'),
    setAudioPitchCorrection: note('setAudioPitchCorrection'),
    setAudioTrack: note('setAudioTrack'),
    setAudioVisualization: note('setAudioVisualization'),
    setLoopFile: note('setLoopFile'),
    setLoudnessNormalization: note('setLoudnessNormalization'),
    setPaused: note('setPaused'),
    setSecondarySubtitleTrack: note('setSecondarySubtitleTrack'),
    setSpeed: note('setSpeed'),
    setSubtitleDelay: note('setSubtitleDelay'),
    setSubtitleTrack: note('setSubtitleTrack'),
    setVideoAdjustments: note('setVideoAdjustments'),
    setVideoPan: note('setVideoPan'),
    setVideoRotation: note('setVideoRotation'),
    setVideoZoom: note('setVideoZoom'),
    setVolume: note('setVolume'),
    startRecording: note('startRecording'),
    stopRecording: note('stopRecording'),
    createPresenter: (): LibMpvRenderSize => {
      calls.push({ method: 'createPresenter', args: [] })
      return RENDER_SIZE
    },
    setPresenterBounds: (): LibMpvRenderSize => {
      calls.push({ method: 'setPresenterBounds', args: [] })
      return RENDER_SIZE
    },
    refreshPresenterScale: (): LibMpvRenderSize => {
      calls.push({ method: 'refreshPresenterScale', args: [] })
      return RENDER_SIZE
    },
    setPresenterSuspended: note('setPresenterSuspended'),
    destroyPresenter: (presenterId: string): void => {
      calls.push({ method: 'destroyPresenter', args: [presenterId] })
      overrides.destroyPresenter?.(presenterId)
    },
    setWindowBackdrop: note('setWindowBackdrop')
  }
}

export function makeLayerAddon(overrides: FakeAddonOverrides = {}): FakeAddon<'layer'> {
  const calls: AddonCall[] = []
  const note =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args })
    }

  const addon: LibMpvLayerAddon = {
    ...makeCore(calls, overrides),
    getPresentationKind: () => 'layer',
    configureFrameLink: note('configureFrameLink'),
    startPresenterLink: note('startPresenterLink'),
    stopPresenterLink: note('stopPresenterLink'),
    presentSurface: (...args: unknown[]): void => {
      calls.push({ method: 'presentSurface', args })
      overrides.presentSurface?.()
    },
    observeWindowOcclusion: note('observeWindowOcclusion'),
    unobserveWindowOcclusion: note('unobserveWindowOcclusion')
  }

  return { calls, loaded: { presentationKind: 'layer', addon, runtime: FAKE_RUNTIME } }
}

export function makeWindowAddon(overrides: FakeAddonOverrides = {}): FakeAddon<'window'> {
  const calls: AddonCall[] = []
  const note =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args })
    }

  const addon: LibMpvWindowAddon = {
    ...makeCore(calls, overrides),
    getPresentationKind: () => 'window',
    getVideoWindowHandle: (sessionId: string): number | null => {
      calls.push({ method: 'getVideoWindowHandle', args: [sessionId] })
      return overrides.getVideoWindowHandle ? overrides.getVideoWindowHandle(sessionId) : 4242
    },
    adoptVideoWindow: note('adoptVideoWindow')
  }

  return { calls, loaded: { presentationKind: 'window', addon, runtime: FAKE_RUNTIME } }
}
