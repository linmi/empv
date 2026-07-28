import type {
  LibMpvEmbeddedCoreAddon,
  LibMpvPlayback,
  LibMpvPresentationKind,
  LibMpvRenderSize,
  LibMpvSessionOptions,
  LibMpvSessionSnapshot,
  LibMpvVideoLayerBounds,
  LibMpvWindowAttachOptions
} from '../embedded.ts'

// Typed request/reply + event protocol between an Electron main process and the
// isolated playback process (runtimeProcess.ts). That process owns mpv sessions
// and Windows/Linux child-window presenters. The main process owns only the
// macOS CALayer/NSView presenter plus renderer-facing IPC.
//
// The protocol is DERIVED from the addon contract rather than restated. Most of
// the session API is "call this addon method with these arguments and send back
// what it returned", so those methods keep their own names and argument lists
// and are forwarded verbatim. Only the four below need the utility to do
// something the addon cannot do alone, and only those are written out by hand.
// Restating the other thirty-one produced a table, a switch and a validation
// list that had to agree three ways, and a single missed entry there once made
// the whole addon fail to load on Windows and Linux.

// Captured frame pixels cross the MessagePort as a structured-clone Uint8Array
// (the native addon returns a Buffer, which clones to a Uint8Array).
export type EmpvRuntimeCapturedFrame = {
  data: Uint8Array
  heightPixels: number
  widthPixels: number
}

// A session starts UNSIZED. A layer presenter derives the first pixel size in
// main and sends setRenderSize; a window presenter derives and applies it inside
// its runtime create/bounds transaction. Until then the utility renders through
// the SKIP_RENDERING consume path so vo_libmpv never stalls.
export type EmpvRuntimeSessionCreateInput = {
  options: LibMpvSessionOptions
}

export type EmpvRuntimeSessionCreateResult = {
  sessionId: string
  // A newly-created session is registered natively. A null snapshot would mean
  // the utility and native registries already disagree, so creation rolls back
  // instead of publishing such a result.
  snapshot: LibMpvSessionSnapshot
}

// The utility is the authority for a native session's lifecycle within one
// process generation. "creating" begins once native creation returns an id but
// before the utility has assembled the public create result. "disposing"
// begins before native teardown starts and remains visible until teardown
// settles. A removed session never appears in this snapshot.
export type EmpvRuntimeSessionLifecycle = 'creating' | 'active' | 'disposing'

export type EmpvRuntimeSessionState = {
  sessionId: string
  state: EmpvRuntimeSessionLifecycle
  windowPresenter: {
    presenterId: string
    state: EmpvRuntimeWindowPresenterLifecycle
  } | null
}

export type EmpvRuntimeWindowPresenterLifecycle =
  | 'creating'
  | 'active'
  | 'disposing'
  | 'cleanup-required'

export type EmpvRuntimeProbeResult = {
  presentationKind: LibMpvPresentationKind
  supported: boolean
}

export type EmpvRuntimeWindowPresenterCreateInput = {
  options: LibMpvWindowAttachOptions
  // Electron Buffer values cross utilityProcess and Node advanced IPC as a
  // structured-clone byte array. The runtime reconstructs the Buffer only at
  // the native boundary.
  parentWindowHandle: Uint8Array
  presenterId: string
  sessionId: string
}

// Layer presentation must attach AppKit state to the Electron-owned NSView, so
// that presenter remains in main. Window presentation is different: the runtime
// owns the child HWND/X11 Window and every operation on it must execute in that
// same isolated generation. These names are therefore hand-written protocol
// transactions rather than direct addon forwarding.
type EmpvPresenterMethod =
  | 'getPresentationKind'
  | 'createPresenter'
  | 'setPresenterBounds'
  | 'refreshPresenterScale'
  | 'setPresenterSuspended'
  | 'destroyPresenter'
  | 'setWindowBackdrop'

// Methods the utility cannot forward as-is:
// - probe reports the runtime's real backend without loading the addon in main.
// - createSession takes callbacks, which cannot cross a MessagePort; the
//   utility holds them and republishes them as events.
// - loadPlayback is followed by setPaused(true) so the first frame lands as a
//   poster, and answers with the post-load snapshot.
// - disposeSession has to leave the utility's own session bookkeeping correct.
// - captureFrame returns a Buffer, which arrives as a Uint8Array.
// - window presenter methods enforce generation/session ownership and make
//   native create+adopt one rollback-safe transaction.
type EmpvHandWrittenMethod =
  | 'probe'
  | 'createSession'
  | 'loadPlayback'
  | 'disposeSession'
  | 'captureFrame'
  | 'createWindowPresenter'
  | 'setWindowPresenterBounds'
  | 'refreshWindowPresenterScale'
  | 'setWindowPresenterSuspended'
  | 'destroyWindowPresenter'

export type EmpvForwardedMethod = Exclude<
  keyof LibMpvEmbeddedCoreAddon,
  EmpvPresenterMethod | EmpvHandWrittenMethod
>

// The runtime half of the same set: the utility checks an incoming method name
// against this before indexing the addon, so an unknown name is a clean error
// rather than a lookup of some arbitrary property.
export const EMPV_FORWARDED_METHODS = [
  'isSupported',
  'getSessionSnapshot',
  'setRenderSize',
  'setPresentationSuspended',
  'reloadSubtitle',
  'seek',
  'replay',
  'playlistSync',
  'playlistPlayIndex',
  'playlistLocateIndex',
  'setPlaylistAutoAdvance',
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
  'stopRecording'
] as const satisfies readonly EmpvForwardedMethod[]

// Completeness in the other direction: a method added to the addon contract has
// to appear above, or this line fails to compile and names the ones missing.
type MissingForwardedMethods = Exclude<EmpvForwardedMethod, (typeof EMPV_FORWARDED_METHODS)[number]>
const _forwardedMethodsAreComplete: MissingForwardedMethods extends never
  ? true
  : ['empv protocol is missing forwarded methods:', MissingForwardedMethods] = true
void _forwardedMethodsAreComplete

export type EmpvRuntimeMethod = EmpvForwardedMethod | EmpvHandWrittenMethod

export const EMPV_RUNTIME_UNOWNED_METHODS = ['probe', 'isSupported'] as const
export type EmpvRuntimeUnownedMethod = (typeof EMPV_RUNTIME_UNOWNED_METHODS)[number]
export const EMPV_RUNTIME_SESSION_CREATE_METHOD = 'createSession' as const
export type EmpvRuntimeSessionCreateMethod = typeof EMPV_RUNTIME_SESSION_CREATE_METHOD
export type EmpvRuntimeOwnedMethod = Exclude<
  EmpvRuntimeMethod,
  EmpvRuntimeUnownedMethod | EmpvRuntimeSessionCreateMethod
>

export type EmpvRuntimeArgs<Method extends EmpvRuntimeMethod> = Method extends EmpvForwardedMethod
  ? Parameters<LibMpvEmbeddedCoreAddon[Method]>
  : Method extends 'probe'
    ? []
    : Method extends 'createSession'
      ? [input: EmpvRuntimeSessionCreateInput]
      : Method extends 'loadPlayback'
        ? [sessionId: string, playback: LibMpvPlayback]
        : Method extends 'disposeSession'
          ? [sessionId: string]
          : Method extends 'captureFrame'
            ? [sessionId: string]
            : Method extends 'createWindowPresenter'
              ? [input: EmpvRuntimeWindowPresenterCreateInput]
              : Method extends 'setWindowPresenterBounds'
                ? [presenterId: string, bounds: LibMpvVideoLayerBounds]
                : Method extends 'refreshWindowPresenterScale'
                  ? [presenterId: string]
                  : Method extends 'setWindowPresenterSuspended'
                    ? [presenterId: string, suspended: boolean]
                    : Method extends 'destroyWindowPresenter'
                      ? [presenterId: string]
                      : never

export type EmpvRuntimeResult<Method extends EmpvRuntimeMethod> = Method extends EmpvForwardedMethod
  ? ReturnType<LibMpvEmbeddedCoreAddon[Method]>
  : Method extends 'probe'
    ? EmpvRuntimeProbeResult
    : Method extends 'createSession'
      ? EmpvRuntimeSessionCreateResult
      : Method extends 'loadPlayback'
        ? LibMpvSessionSnapshot
        : Method extends 'disposeSession'
          ? void
          : Method extends 'captureFrame'
            ? EmpvRuntimeCapturedFrame | null
            : Method extends
                  | 'createWindowPresenter'
                  | 'setWindowPresenterBounds'
                  | 'refreshWindowPresenterScale'
              ? LibMpvRenderSize
              : Method extends 'setWindowPresenterSuspended' | 'destroyWindowPresenter'
                ? void
                : never

export type EmpvRuntimeRequest<Method extends EmpvRuntimeMethod = EmpvRuntimeMethod> =
  Method extends EmpvRuntimeMethod
    ? { id: number; method: Method; args: EmpvRuntimeArgs<Method> }
    : never

export type EmpvRuntimeResponse =
  | { id: number; type: 'done'; result: unknown }
  | {
      id: number
      type: 'error'
      message: string
      name: string
      // A request failure leaves the generation usable. A generation failure
      // means native resource ownership can no longer be proven, so the client
      // rejects every pending request and terminates that generation.
      recoverability: 'request' | 'generation'
    }

export type EmpvRuntimeEvent =
  | {
      type: 'runtime.heartbeat'
      pid: number
      sentAt: number
      sessions: EmpvRuntimeSessionState[]
    }
  | {
      type: 'session.snapshot'
      sessionId: string
      snapshot: LibMpvSessionSnapshot | null
    }
  // Per-frame present. surfaceIndex is the rendered pool slot; poolGeneration is
  // the generation of the pool it belongs to; contentGeneration is the
  // entry/timeline generation (minted on every mpv START_FILE) used for
  // latest-wins present. The pool's surfaces are transferred to the main-process
  // presenter out-of-band over the mach frame link; the presenter presents this
  // slot only once it has received that pool generation AND the content
  // generation is not from a superseded navigation.
  | {
      type: 'session.frame'
      sessionId: string
      surfaceIndex: number
      poolGeneration: number
      contentGeneration: number
    }

export const EMPV_RUNTIME_HEARTBEAT_INTERVAL_MS = 1_000
export const EMPV_RUNTIME_HEARTBEAT_TIMEOUT_MS = 5_000

// Fork-env key carrying the mach bootstrap service name for the frame link. The
// main process generates the name, registers it (startPresenterLink), and
// injects it here so the utility can look it up (configureFrameLink) before any
// session renders. Injected at spawn so it survives every utility respawn.
export const EMPV_FRAME_LINK_ENV_KEY = 'EMPV_FRAME_LINK_SERVICE'
