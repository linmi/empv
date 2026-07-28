// Main-process surface. The isolated playback-process half is a separate entry
// (`empv/electron/runtime-process`) on purpose: it must never pull main-process
// Electron APIs into either a Chromium utility process or a Linux Node child.
export {
  createEmpvRuntimeClient,
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeClient,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeFrameEvent,
  type EmpvRuntimeInvocation,
  type EmpvRuntimeSnapshotEvent,
  type EmpvRuntimeTerminalReason
} from './client.ts'

export {
  createEmpvFrameLinkServiceName,
  createEmpvPlaybackHost,
  type EmpvLayerHost,
  type EmpvPlaybackHost,
  type EmpvPlaybackHostOptions,
  type EmpvWindowHost
} from './playbackHost.ts'

export {
  EMPV_FORWARDED_METHODS,
  EMPV_FRAME_LINK_ENV_KEY,
  EMPV_RUNTIME_HEARTBEAT_INTERVAL_MS,
  EMPV_RUNTIME_HEARTBEAT_TIMEOUT_MS,
  EMPV_RUNTIME_SESSION_CREATE_METHOD,
  EMPV_RUNTIME_UNOWNED_METHODS,
  type EmpvRuntimeCapturedFrame,
  type EmpvRuntimeArgs,
  type EmpvRuntimeMethod,
  type EmpvRuntimeOwnedMethod,
  type EmpvRuntimeResult,
  type EmpvRuntimeEvent,
  type EmpvRuntimeRequest,
  type EmpvRuntimeResponse,
  type EmpvRuntimeProbeResult,
  type EmpvRuntimeSessionCreateInput,
  type EmpvRuntimeSessionCreateMethod,
  type EmpvRuntimeSessionCreateResult,
  type EmpvRuntimeSessionLifecycle,
  type EmpvRuntimeSessionState,
  type EmpvRuntimeUnownedMethod,
  type EmpvRuntimeWindowPresenterCreateInput,
  type EmpvRuntimeWindowPresenterLifecycle
} from './protocol.ts'
