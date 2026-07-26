import { createRequire } from 'node:module'

import {
  assertLibMpvRuntime,
  type LibMpvRuntime,
  type LibMpvRuntimeResolveOptions
} from './runtime.ts'

export type LibMpvSessionStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
  | 'closed'

export type LibMpvTrack = {
  defaultTrack?: boolean
  forced?: boolean
  id: number
  language?: string
  selected: boolean
  title?: string
}

export type LibMpvRecordingState = {
  active: boolean
  error?: string
  startedAt?: string
  targetPath?: string
}

export type LibMpvPlayback = {
  disableDefaultSubtitles?: boolean
  externalAudioPath?: string
  headers?: Record<string, string>
  referer?: string
  startTime?: number
  streamUrl: string
  subtitlePath?: string
  title?: string
  userAgent?: string
}

export type LibMpvChapter = {
  startSeconds: number
  title: string
}

export type LibMpvAbLoop = {
  aSeconds: number | null
  bSeconds: number | null
}

export type LibMpvVideoAdjustments = {
  brightness: number
  contrast: number
  gamma: number
  saturation: number
}

export type LibMpvSessionSnapshot = {
  abLoop?: LibMpvAbLoop
  aspectOverride?: string
  // mpv audio-delay, in seconds.
  audioDelaySeconds?: number
  // mpv audio-pitch-correction: keep pitch when the playback speed changes.
  audioPitchCorrection?: boolean
  audioTracks?: LibMpvTrack[]
  // Session-internal lavfi-complex audio visualization mode. lavfi-complex is a
  // persistent mpv option that survives gapless playlist transitions, so this
  // mirrors the live property rather than resetting per file; the native session
  // tears it down the moment a loaded file is found to carry a video track.
  audioVisualization?: 'none' | 'spectrum' | 'waveform'
  cacheDurationSeconds?: number | null
  chapters?: LibMpvChapter[]
  containerFps?: number | null
  droppedFrameCount?: number
  durationSeconds: number | null
  error?: string
  hwdecCurrent?: string
  // mpv loop-file: whether the current file repeats indefinitely.
  loopFile?: boolean
  // Session-internal loudnorm af switch (loudness normalization enabled).
  loudnessNormalization?: boolean
  playbackSpeed?: number
  // Monotonic entry-ready generation. START_FILE mints a new content
  // generation; this value advances to it only at PLAYBACK_RESTART, when mpv's
  // decoder/VO pipeline is ready for commands such as a saved-position seek.
  // A seek within the same entry does not advance it.
  playbackReadyGeneration: number
  // mpv playlist-count.
  playlistCount?: number
  // mpv playlist-pos (0-based); null while idle (no entry selected).
  playlistPosition?: number | null
  positionSeconds: number
  recording?: LibMpvRecordingState
  renderAverageMs?: number | null
  renderedFrameCount?: number
  selectedAudioTrackId?: number | null
  // mpv secondary-sid; null when no secondary subtitle is selected.
  selectedSecondarySubtitleTrackId?: number | null
  selectedSubtitleTrackId?: number | null
  status: LibMpvSessionStatus
  streamUrl: string
  // mpv sub-delay, in seconds.
  subtitleDelaySeconds?: number
  subtitleTracks?: LibMpvTrack[]
  videoAdjustments?: LibMpvVideoAdjustments
  videoCodec?: string
  videoHeight?: number | null
  // mpv video-rotate (0 | 90 | 180 | 270).
  videoRotationDegrees?: number
  // Video track count from the demuxer track-list of the current file; null
  // until the track list is known (reset on every file change). 0 together with
  // a playing/paused status identifies an audio-only file before the first
  // video frame configures the VO.
  videoTrackCount?: number | null
  videoWidth?: number | null
  // mpv video-zoom (log2 scale; 0 = 1x).
  videoZoom?: number
  // mpv video-pan-x / video-pan-y (fraction of video size; 0 = centered).
  videoPanX?: number
  videoPanY?: number
  volume: number
}

export type LibMpvSessionOptions = {
  volume?: number
}

// CSS-pixel bounds relative to the window content view's top-left corner.
export type LibMpvVideoLayerBounds = {
  cornerRadius?: number
  height: number
  width: number
  x: number
  y: number
}

// 'underlay' composites the video below the (transparent) web contents so DOM
// overlays draw on top; 'overlay' composites above the web contents for
// surfaces that float over opaque app UI.
export type LibMpvVideoLayerZOrder = 'underlay' | 'overlay'

export type LibMpvVideoLayerAttachOptions = LibMpvVideoLayerBounds & {
  zOrder: LibMpvVideoLayerZOrder
}

// The 'window' backend composites an OS child window into the app window, and a
// child window is always above the web contents its parent draws. There is no
// underlay to ask for, so its attach options cannot express one.
//
// This is a separate type rather than a runtime check alone because the addon
// used to accept 'underlay' here, carry it through Rust, and discard it in the
// native shim -- the caller got overlay and no indication its request had not
// survived. The addon now refuses it; this makes the refusal visible to tsc.
export type LibMpvWindowAttachOptions = LibMpvVideoLayerBounds & {
  zOrder: 'overlay'
}

export type LibMpvCapturedFrame = {
  data: Buffer
  heightPixels: number
  widthPixels: number
}

// Render pixel size the utility session must size its IOSurface pool to. The
// main-process presenter owns the hosting window's backingScaleFactor, so it
// derives pixel sizes from CSS bounds and relays them to the session.
export type LibMpvRenderSize = {
  heightPixels: number
  widthPixels: number
}

// Fired on the JS thread each time a session renders a frame into its IOSurface
// pool. surfaceIndex is the rendered pool slot; poolGeneration is the generation
// of the pool it belongs to; contentGeneration is the entry/timeline generation
// stamped on this frame, used for latest-wins present. Entry identity is minted
// on every mpv START_FILE (user jumps and gapless auto-advance alike), but the
// stamp only advances to it at each PLAYBACK_RESTART boundary — the first point
// where the VO's current frame is known to belong to the new entry — so trailing
// gapless frames keep the previous entry's stamp. The pool's surfaces themselves
// are transferred to the main-process presenter out-of-band over the mach frame
// link on each pool (re)creation; the presenter presents this slot only when the
// pool generation matches the surfaces it received AND the content generation is
// not from a superseded navigation (it presents in monotonic order: >= passes,
// strictly lower is dropped).
export type LibMpvFrameNotifier = (
  surfaceIndex: number,
  poolGeneration: number,
  contentGeneration: number
) => void

// How a backend gets decoded video from the utility process to the on-screen
// window. macOS ships IOSurfaces to a CALayer over a mach frame link
// ('layer'); Windows/Linux embed an OS video window that the main
// process reparents into the app window ('window'). Callers MUST branch on
// this to reach the right presentation facet — the two facets are disjoint.
export type LibMpvPresentationKind = 'layer' | 'window'

// The API family every backend exports regardless of presentation model: mpv
// session control (utility process) plus presenter bounds/scale/visibility (main
// process). The two presentation-specific facets extend this. This type is
// internal to the main/utility processes and is not part of the renderer-facing
// IPC contract.
export type LibMpvEmbeddedCoreAddon = {
  isSupported(): boolean
  // Capability discriminant. Read once at load; the facet a caller may use is
  // fixed by the returned kind.
  getPresentationKind(): LibMpvPresentationKind

  // --- Session-side API (playback utility process) ---
  // Session setup/teardown run mpv initialization and terminate on a worker
  // thread; blocking the AppKit main thread there beachballs the whole app.
  // onSnapshotChanged fires on the JS thread after the session snapshot changed;
  // it carries no payload, so consumers read getSessionSnapshot. The native side
  // pushes important changes (status, duration, track list / selected tracks,
  // chapters, ab-loop, video adjustments, aspect, speed, volume, recording
  // state, errors, hwdec / codec / video size) immediately, while position /
  // demuxer-cache / dropped-frame-only changes are coalesced to at most one
  // notification per 250ms. onFrame carries rendered frames to the presenter on
  // 'layer'; on 'window' mpv renders straight into its window and
  // onFrame never fires.
  createSession(
    options: LibMpvSessionOptions,
    onSnapshotChanged: () => void,
    onFrame: LibMpvFrameNotifier
  ): Promise<string>
  disposeSession(sessionId: string): Promise<void>
  loadPlayback(sessionId: string, playback: LibMpvPlayback): void
  getSessionSnapshot(sessionId: string): LibMpvSessionSnapshot | null
  captureFrame(sessionId: string): LibMpvCapturedFrame | null
  // Sets the render pixel size (IOSurface pool size) the session renders into.
  // Called on create and whenever the presenter's bounds/scale change. On
  // 'window' mpv sizes itself to its window (the presenter owns that), so
  // this is a no-op there.
  setRenderSize(sessionId: string, widthPixels: number, heightPixels: number): void
  // Suspends rendering only (audio/decode continue) while the hosting window is
  // hidden, minimized, or fully occluded; resuming forces one render so the
  // presenter repaints the current frame immediately. On 'window' the
  // presenter hides the window instead, so this is a no-op there.
  setPresentationSuspended(sessionId: string, suspended: boolean): void
  reloadSubtitle(sessionId: string, subtitlePath: string | null): void
  seek(sessionId: string, seconds: number): void
  // Restarts terminal playback through one native mpv command chain.
  replay(sessionId: string): void
  // --- Playlist (gapless collection playback) ---
  // Reconciles mpv's playlist to `entries`, in order, without interrupting the
  // entry that is playing.
  //
  // `entries` is the queue AFTER the session's own loaded source: entry 0 stays
  // whatever loadPlayback handed mpv, and the native side prepends it. Pass the
  // tail only. The path the caller holds for entry 0 is not guaranteed to reach
  // mpv byte-for-byte, and a mismatch would read as a request to replace the
  // entry that is playing.
  //
  // The tail is passed in full every time, not as an incremental append: the
  // caller's queue changes over a session's life, so the native playlist has to
  // stay a function of it or a jump lands on an index that does not exist.
  //
  // A non-null title rides in the loadfile options as force-media-title.
  playlistSync(sessionId: string, entries: { mediaPath: string; title: string | null }[]): void
  // mpv playlist-play-index: jump straight to a queue entry (0-based). The native
  // session lifts pause before jumping — a playlist jump always plays, because
  // mpv 0.41's vo_libmpv path never decodes a frame for a jump issued while
  // paused.
  playlistPlayIndex(sessionId: string, index: number): void
  // mpv playlist-play-index WITHOUT touching pause: switch the active queue entry
  // (0-based) while preserving the current pause/ended state. The play variant
  // above appends `set pause no` and always resumes; locate issues no pause
  // command, so a session stopped on a poster stays stopped on the target entry's
  // poster. This is the opening-locate primitive for a collection opened not
  // playing — position to the target entry, keep it paused on the poster.
  playlistLocateIndex(sessionId: string, index: number): void
  // --- Extended playback controls ---
  setAbLoop(sessionId: string, aSeconds: number | null, bSeconds: number | null): void
  setAspect(sessionId: string, aspect: string): void
  // mpv audio-delay, in seconds.
  setAudioDelay(sessionId: string, seconds: number): void
  // mpv audio-pitch-correction: keep pitch when the playback speed changes.
  setAudioPitchCorrection(sessionId: string, enabled: boolean): void
  setAudioTrack(sessionId: string, trackId: number): void
  // Session-internal lavfi-complex audio visualization: 'none' | 'spectrum' |
  // 'waveform'. lavfi-complex is a persistent mpv option that carries across
  // gapless playlist entries; the native session tears it down automatically
  // when a loaded file is found to carry its own video track.
  setAudioVisualization(sessionId: string, mode: string): void
  // mpv loop-file inf|no.
  setLoopFile(sessionId: string, enabled: boolean): void
  // Toggles a loudnorm af filter (loudness normalization). The af chain persists
  // across playlist entries.
  setLoudnessNormalization(sessionId: string, enabled: boolean): void
  setPaused(sessionId: string, paused: boolean): void
  // keep-open=yes (advance through the playlist, pause only at the very end) when
  // autoAdvance is true; keep-open=always (pause at the end of every entry, never
  // self-advance) when false. Explicit playlist-play-index jumps are unaffected.
  setPlaylistAutoAdvance(sessionId: string, autoAdvance: boolean): void
  // mpv secondary-sid; trackId < 0 clears the secondary subtitle ('no').
  setSecondarySubtitleTrack(sessionId: string, trackId: number): void
  setSpeed(sessionId: string, speed: number): void
  // mpv sub-delay, in seconds.
  setSubtitleDelay(sessionId: string, seconds: number): void
  setSubtitleTrack(sessionId: string, trackId: number): void
  setVideoAdjustments(
    sessionId: string,
    brightness: number,
    contrast: number,
    saturation: number,
    gamma: number
  ): void
  // mpv video-pan-x / video-pan-y. Reject non-finite input loudly.
  setVideoPan(sessionId: string, panX: number, panY: number): void
  // mpv video-rotate. degrees must be 0 | 90 | 180 | 270.
  setVideoRotation(sessionId: string, degrees: number): void
  // mpv video-zoom (log2). Reject non-finite input loudly.
  setVideoZoom(sessionId: string, zoom: number): void
  setVolume(sessionId: string, volume: number): void
  startRecording(sessionId: string, targetPath: string): void
  stopRecording(sessionId: string): void

  // --- Presenter-side API (main process) ---
  // Creates the presenter for the window resolved from the Electron native window
  // handle, keyed by an opaque presenterId, and returns the render pixel size the
  // session must size to. On 'layer' this attaches a CALayer; on
  // 'window' it stores the parent window + bounds and reparents the session's
  // video window once adoptVideoWindow supplies the child handle.
  // createPresenter is NOT here: the two backends take different attach options,
  // and an intersection type cannot narrow a member the core already declares --
  // it would add an overload and leave the permissive one callable. Each facet
  // declares its own.
  setPresenterBounds(presenterId: string, bounds: LibMpvVideoLayerBounds): LibMpvRenderSize
  // Re-derives render pixel size from the hosting window's current DPI. Called
  // when a window moves to a display with a different DPI, where the renderer's
  // CSS-bounds observer never fires.
  refreshPresenterScale(presenterId: string): LibMpvRenderSize
  setPresenterSuspended(presenterId: string, suspended: boolean): void
  destroyPresenter(presenterId: string): void
  // Installs (color) or removes (null) an opaque theme-colored layer at the
  // bottom of the window so punched-transparent page regions keep the app
  // background while underlay video is active. No-op on 'window' (the video
  // window is opaque and composites above the web contents; no punch-through).
  setWindowBackdrop(windowHandle: Buffer, color: string | null): void
}

// macOS: mpv renders into an offscreen IOSurface pool shipped to a main-process
// CALayer presenter over a mach frame link.
export type LibMpvLayerAddon = LibMpvEmbeddedCoreAddon & {
  getPresentationKind(): 'layer'
  // Composites either side of the web contents: a CALayer can sit beneath
  // punched-transparent page regions.
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvVideoLayerAttachOptions
  ): LibMpvRenderSize
  // Sets the mach bootstrap service name the utility uses to reach the
  // main-process frame-link receiver (the name the main process registered via
  // startPresenterLink). Must be called before any session is created; the send
  // right is looked up lazily on the first pool transfer.
  configureFrameLink(serviceName: string): void
  // Registers the per-instance mach bootstrap service (serviceName generated by
  // the main JS) and starts receiving the utility's pool surface mach ports.
  // Idempotent for the same name; throws if registration fails. Paired with
  // configureFrameLink on the utility side (same serviceName).
  startPresenterLink(serviceName: string): void
  // Tears down the frame-link receive channel. Idempotent.
  stopPresenterLink(): void
  // Presents the frame at surfaceIndex from the pool of poolGeneration by
  // swapping layer.contents, only when that generation's surfaces have been
  // received over the frame link (else the frame is dropped/deferred) AND
  // contentGeneration is not from a superseded navigation. contentGeneration is
  // the entry/timeline generation stamped on the frame (minted at START_FILE,
  // advanced onto frames at each PLAYBACK_RESTART), so rapid consecutive jumps
  // converge to the latest target's frame; the presenter presents in monotonic
  // content-generation order (>= passes, strictly lower is dropped).
  presentSurface(
    presenterId: string,
    poolGeneration: number,
    surfaceIndex: number,
    contentGeneration: number
  ): void
  // Observes NSWindowDidChangeOcclusionStateNotification for the window resolved
  // from the Electron native handle, so the presenter can suspend presentation
  // when the window is fully covered by other windows (the occlusion signal
  // Electron does not expose). onChange fires on the JS thread with the window's
  // current visibility, once immediately on registration and on every occlusion
  // change. Idempotent per window (re-observing replaces the prior callback); the
  // observer self-cleans when the window closes.
  observeWindowOcclusion(windowHandle: Buffer, onChange: (visible: boolean) => void): void
  // Removes the occlusion observer for the window resolved from the handle and
  // releases its callback. Safe to call for an unobserved window.
  unobserveWindowOcclusion(windowHandle: Buffer): void
}

// Windows/Linux: mpv renders into an OS video window the utility process owns;
// the main-process presenter reparents it into the app window. No mach frame
// link exists, so the mach-link functions are absent by design.
export type LibMpvWindowAddon = LibMpvEmbeddedCoreAddon & {
  getPresentationKind(): 'window'
  // Overlay only. See LibMpvWindowAttachOptions.
  createPresenter(
    presenterId: string,
    windowHandle: Buffer,
    options: LibMpvWindowAttachOptions
  ): LibMpvRenderSize
  // The session's video window handle (HWND / X11 window id, as a number), read
  // by the utility runtime and shipped to the main process. null when the
  // session is unknown or has no window yet.
  getVideoWindowHandle(sessionId: string): number | null
  // Hands the presenter the session's video window handle so it can reparent it
  // into the app window (reparents now if the parent is already known).
  adoptVideoWindow(presenterId: string, childWindowHandle: number): void
}

// A loaded backend is exactly one of the two facets, discriminated by the kind
// probed at load time. Consumers branch on getPresentationKind()'s value via this
// union to reach a facet's functions.
export type LibMpvEmbeddedNativeAddon = LibMpvLayerAddon | LibMpvWindowAddon

export type LoadedEmbeddedLibMpvAddon =
  | {
      presentationKind: 'layer'
      addon: LibMpvLayerAddon
      runtime: LibMpvRuntime
    }
  | {
      presentationKind: 'window'
      addon: LibMpvWindowAddon
      runtime: LibMpvRuntime
    }

export type EmbeddedLibMpvAddonLoadOptions = LibMpvRuntimeResolveOptions & {
  requireAddon?: NodeRequire
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type FunctionProperties<Names extends readonly string[]> = {
  [Name in Names[number]]: (...args: never[]) => unknown
}

function hasFunctions<const Names extends readonly string[]>(
  candidate: Record<string, unknown>,
  names: Names
): candidate is Record<string, unknown> & FunctionProperties<Names> {
  return names.every((name) => typeof candidate[name] === 'function')
}

// Shared core surface required of every backend. Native modules enter as unknown,
// so every callable used through LibMpvEmbeddedCoreAddon is checked at the boundary.
const CORE_FUNCTIONS = [
  'isSupported',
  'getPresentationKind',
  // Session-side (playback utility process).
  'createSession',
  'disposeSession',
  'loadPlayback',
  'getSessionSnapshot',
  'captureFrame',
  'setRenderSize',
  'setPresentationSuspended',
  'reloadSubtitle',
  'seek',
  'replay',
  // Playlist (single-session collection playback).
  'playlistSync',
  'playlistPlayIndex',
  'playlistLocateIndex',
  'setPlaylistAutoAdvance',
  // Extended playback controls.
  'setAbLoop',
  'setAspect',
  'setAudioDelay',
  'setAudioTrack',
  'setSubtitleDelay',
  'setSubtitleTrack',
  'setVideoRotation',
  'setVideoZoom',
  'setVideoPan',
  'setVideoAdjustments',
  'setAudioPitchCorrection',
  'setLoudnessNormalization',
  'setAudioVisualization',
  'setLoopFile',
  'setPaused',
  'setSecondarySubtitleTrack',
  'setSpeed',
  'setVolume',
  'startRecording',
  'stopRecording',
  // Presenter-side (main process).
  'createPresenter',
  'setPresenterBounds',
  'refreshPresenterScale',
  'setPresenterSuspended',
  'destroyPresenter',
  'setWindowBackdrop'
] as const

// mach-link facet ('layer').
const LAYER_FUNCTIONS = [
  'configureFrameLink',
  'startPresenterLink',
  'stopPresenterLink',
  'presentSurface',
  'observeWindowOcclusion',
  'unobserveWindowOcclusion'
] as const

// Window-embedding facet ('window').
const WINDOW_FUNCTIONS = ['getVideoWindowHandle', 'adoptVideoWindow'] as const

function isLibMpvLayerAddon(
  candidate: Record<string, unknown>
): candidate is Record<string, unknown> & LibMpvLayerAddon {
  return hasFunctions(candidate, CORE_FUNCTIONS) && hasFunctions(candidate, LAYER_FUNCTIONS)
}

function isLibMpvWindowAddon(
  candidate: Record<string, unknown>
): candidate is Record<string, unknown> & LibMpvWindowAddon {
  return hasFunctions(candidate, CORE_FUNCTIONS) && hasFunctions(candidate, WINDOW_FUNCTIONS)
}

export type NormalizedEmbeddedAddon =
  | { presentationKind: 'layer'; addon: LibMpvLayerAddon }
  | { presentationKind: 'window'; addon: LibMpvWindowAddon }

// Validates the core surface, probes getPresentationKind(), then validates the
// facet functions the reported kind requires. Returns the addon tagged with its
// kind so callers get a discriminated union to branch on — never an untyped
// object whose facet functions might be missing.
export function normalizeEmbeddedAddon(value: unknown): NormalizedEmbeddedAddon {
  const candidate = isObject(value) && 'default' in value ? value.default : value

  if (!isObject(candidate) || !hasFunctions(candidate, CORE_FUNCTIONS)) {
    throw new Error('libmpv native addon must export the embedded MPV session/presenter core API.')
  }

  const presentationKind = candidate.getPresentationKind()

  if (presentationKind === 'layer') {
    if (!isLibMpvLayerAddon(candidate)) {
      throw new Error('libmpv native addon reports layer but is missing its mach frame-link API.')
    }
    return { presentationKind, addon: candidate }
  }

  if (presentationKind === 'window') {
    if (!isLibMpvWindowAddon(candidate)) {
      throw new Error(
        'libmpv native addon reports window but is missing its video-window embedding API.'
      )
    }
    return { presentationKind, addon: candidate }
  }

  throw new Error(
    `libmpv native addon reported an unknown presentation kind: ${String(presentationKind)}.`
  )
}

export function loadEmbeddedLibMpvAddonFromPath(
  addonPath: string,
  requireAddon: NodeRequire = createRequire(import.meta.url)
): LibMpvEmbeddedNativeAddon {
  return normalizeEmbeddedAddon(requireAddon(addonPath)).addon
}

export async function loadEmbeddedLibMpvAddon(
  options: EmbeddedLibMpvAddonLoadOptions = {}
): Promise<LoadedEmbeddedLibMpvAddon> {
  const runtime = await assertLibMpvRuntime(options)
  const requireAddon = options.requireAddon ?? createRequire(import.meta.url)
  const normalized = normalizeEmbeddedAddon(requireAddon(runtime.addonPath))

  return { ...normalized, runtime }
}
