import { loadEmbeddedLibMpvAddon, type LoadedEmbeddedLibMpvAddon } from '../embedded.ts'

import {
  EMPV_FORWARDED_METHODS,
  EMPV_FRAME_LINK_ENV_KEY,
  EMPV_RUNTIME_HEARTBEAT_INTERVAL_MS,
  type EmpvForwardedMethod,
  type EmpvRuntimeEvent,
  type EmpvRuntimeRequest,
  type EmpvRuntimeResponse,
  type EmpvRuntimeSessionLifecycle,
  type EmpvRuntimeSessionState
} from './protocol.ts'

// Playback utility process: hosts the embedded mpv sessions (decode + GL render
// into IOSurfaces). Loading the native addon and running mpv here means a native
// mpv crash takes down only this process; the main process presenter survives
// and recovers. AppKit never runs here — rendered frames are handed to the
// main-process presenter over the MessagePort as pool ids + a per-frame index.
//
// This module is the whole utility process. A consumer's utility entry is
// expected to be nothing but:
//
//   import { startEmpvRuntimeProcess } from 'empv/electron'
//   startEmpvRuntimeProcess()
//
// so the consumer's bundler still owns where that entry lands on disk, while the
// behaviour behind it lives here.

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const FORWARDED_METHODS: ReadonlySet<string> = new Set(EMPV_FORWARDED_METHODS)

class EmpvRuntimeGenerationFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EmpvRuntimeGenerationFailure'
  }
}

export type EmpvRuntimeProcessOptions = {
  // How long the process stays alive with no sessions and no in-flight requests
  // before exiting. The client respawns on demand, so this only trades idle
  // memory against respawn latency.
  idleTimeoutMs?: number
  // The single impure boundary of this module, injectable so the dispatch and
  // startup ordering can be driven without a real addon and a real mpv runtime.
  // Production leaves it unset and gets loadEmbeddedLibMpvAddon.
  loadAddon?: () => Promise<LoadedEmbeddedLibMpvAddon>
  // The channel back to whoever spawned this process. Production leaves it unset
  // and gets Electron's process.parentPort.
  parentPort?: EmpvRuntimeParentPort
  // Process termination is injectable for unit tests. Production exits after
  // an unrecoverable native ownership failure instead of serving requests from
  // a generation whose cleanup state is unknown.
  exitProcess?: (code: number) => void
}

// Electron's utility-process parent port, typed structurally to just the two
// members this module uses. Structural on purpose: the utility entry must not
// need electron's main-process typings, and a caller can supply a port of its
// own without reproducing Electron's full MessagePort surface.
export type EmpvRuntimeParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export type EmpvRuntimeProcessHandle = {
  // Clears the idle and heartbeat timers. A utility process never needs this --
  // it exits by idle timeout or with its parent -- but anything hosting the
  // runtime in a longer-lived process does, and without it the idle timer alone
  // keeps an event loop alive until it fires.
  stop(): void
}

export function startEmpvRuntimeProcess(
  options: EmpvRuntimeProcessOptions = {}
): EmpvRuntimeProcessHandle {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const loadAddon = options.loadAddon ?? loadEmbeddedLibMpvAddon
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code))
  const suppliedParentPort: EmpvRuntimeParentPort | undefined =
    options.parentPort ?? (process as { parentPort?: EmpvRuntimeParentPort }).parentPort

  if (!suppliedParentPort) {
    throw new Error('The empv playback runtime must run inside an Electron utility process.')
  }

  const runtimeParentPort = suppliedParentPort

  const sessions = new Map<string, EmpvRuntimeSessionLifecycle>()
  let idleTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let generationFailureExit: NodeJS.Immediate | null = null
  let stopped = false
  let activeRequests = 0
  let loadedPromise: Promise<LoadedEmbeddedLibMpvAddon> | null = null

  function post(message: EmpvRuntimeResponse | EmpvRuntimeEvent): void {
    runtimeParentPort.postMessage(message)
  }

  function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }

  function sessionStates(): EmpvRuntimeSessionState[] {
    return [...sessions].map(([sessionId, state]) => ({ sessionId, state }))
  }

  function scheduleGenerationFailureExit(error: Error): void {
    if (generationFailureExit || stopped) return
    try {
      process.stderr.write(
        `[empv-runtime] unrecoverable generation failure: ${error.stack ?? error.message}\n`
      )
    } catch {
      // The exit is the recovery boundary; diagnostics must not prevent it.
    }
    generationFailureExit = setImmediate(() => {
      generationFailureExit = null
      exitProcess(1)
    })
  }

  function publishHeartbeat(): void {
    try {
      post({
        type: 'runtime.heartbeat',
        pid: process.pid,
        sentAt: Date.now(),
        sessions: sessionStates()
      })
    } catch (error) {
      scheduleGenerationFailureExit(
        new EmpvRuntimeGenerationFailure(
          `Failed to publish the empv runtime heartbeat: ${normalizeError(error).message}`,
          { cause: error }
        )
      )
    }
  }

  function setSessionState(sessionId: string, state: EmpvRuntimeSessionLifecycle): void {
    sessions.set(sessionId, state)
    publishHeartbeat()
  }

  function removeSession(sessionId: string): void {
    sessions.delete(sessionId)
    publishHeartbeat()
  }

  function requireActiveSession(sessionId: string, method: string): void {
    const state = sessions.get(sessionId)
    if (state === undefined) {
      throw new Error(
        `Cannot run empv runtime method ${method}: session ${sessionId} does not exist in this process generation.`
      )
    }
    if (state !== 'active') {
      throw new Error(
        `Cannot run empv runtime method ${method}: session ${sessionId} is ${state}, not active.`
      )
    }
  }

  async function getLoaded(): Promise<LoadedEmbeddedLibMpvAddon> {
    if (!loadedPromise) {
      loadedPromise = loadAddon()
        .then((loaded) => {
          // The mach frame link only exists on 'layer'; 'window'
          // renders straight into an OS window and has no link to configure. The
          // service name is injected at spawn and must be configured before any
          // session renders a pool — a missing name is a spawn misconfiguration,
          // so fail loudly rather than render blind.
          if (loaded.presentationKind === 'layer') {
            const frameLinkServiceName = process.env[EMPV_FRAME_LINK_ENV_KEY]
            if (!frameLinkServiceName) {
              throw new Error(
                `The empv playback runtime is missing ${EMPV_FRAME_LINK_ENV_KEY}; cannot establish the frame link.`
              )
            }
            loaded.addon.configureFrameLink(frameLinkServiceName)
          }
          return loaded
        })
        .catch((error) => {
          loadedPromise = null
          throw error
        })
    }
    return loadedPromise
  }

  function scheduleIdleShutdown(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (activeRequests > 0 || sessions.size > 0) return
    idleTimer = setTimeout(() => exitProcess(0), idleTimeoutMs)
  }

  async function runRequest(request: EmpvRuntimeRequest): Promise<unknown> {
    const loaded = await getLoaded()
    const { addon } = loaded

    switch (request.method) {
      case 'createSession': {
        const [input] = request.args
        // sessionId is only known once createSession resolves, so route the
        // snapshot/frame sinks through a mutable holder. A throw inside a sink
        // would escape the native ThreadSafeFunction dispatcher and crash this
        // process; contain it.
        let createdSessionId: string | null = null
        const onSnapshotChanged = (): void => {
          try {
            if (!createdSessionId || sessions.get(createdSessionId) !== 'active') return
            post({
              type: 'session.snapshot',
              sessionId: createdSessionId,
              snapshot: addon.getSessionSnapshot(createdSessionId)
            })
          } catch {
            // The main process reconciles from the next snapshot; drop this one.
          }
        }
        const onFrame = (
          surfaceIndex: number,
          poolGeneration: number,
          contentGeneration: number
        ): void => {
          try {
            if (!createdSessionId || sessions.get(createdSessionId) !== 'active') return
            post({
              type: 'session.frame',
              sessionId: createdSessionId,
              surfaceIndex,
              poolGeneration,
              contentGeneration
            })
          } catch {
            // Presenter keeps its last frame; drop this one.
          }
        }
        const sessionId = await addon.createSession(input.options, onSnapshotChanged, onFrame)
        if (sessions.has(sessionId)) {
          throw new EmpvRuntimeGenerationFailure(
            `Native createSession returned duplicate session id ${sessionId}; the generation cannot determine which native resource the id owns.`
          )
        }

        setSessionState(sessionId, 'creating')
        try {
          // No render size at create time: the session starts unsized and only
          // a real presenter bounds update (setRenderSize) supplies one.
          //
          // Assemble the complete public result before publishing the session
          // as active. If either read fails, native creation is rolled back and
          // the caller never receives an id for a partial session.
          const videoWindowHandle =
            loaded.presentationKind === 'window'
              ? loaded.addon.getVideoWindowHandle(sessionId)
              : null
          if (loaded.presentationKind === 'window' && videoWindowHandle === null) {
            throw new Error(
              `Window-backed native session ${sessionId} did not expose the video window handle required for adoption.`
            )
          }
          const snapshot = addon.getSessionSnapshot(sessionId)
          if (snapshot === null) {
            throw new Error(
              `Native session ${sessionId} disappeared before its initial snapshot could be read.`
            )
          }
          createdSessionId = sessionId
          setSessionState(sessionId, 'active')
          return { sessionId, snapshot, videoWindowHandle }
        } catch (createResultError) {
          createdSessionId = null
          setSessionState(sessionId, 'disposing')
          try {
            await addon.disposeSession(sessionId)
          } catch (rollbackError) {
            removeSession(sessionId)
            throw new EmpvRuntimeGenerationFailure(
              `Failed to roll back native session ${sessionId} after createSession result assembly failed: ${normalizeError(createResultError).message}. Rollback also failed: ${normalizeError(rollbackError).message}.`,
              { cause: rollbackError }
            )
          }
          removeSession(sessionId)
          throw new Error(
            `Failed to finish creating empv runtime session ${sessionId}; the native session was rolled back: ${normalizeError(createResultError).message}`,
            { cause: createResultError }
          )
        }
      }
      case 'loadPlayback': {
        const [sessionId, playback] = request.args
        requireActiveSession(sessionId, request.method)
        addon.loadPlayback(sessionId, playback)
        // Pause immediately so the first decoded frame stands as a poster
        // instead of the file running away before the presenter is sized.
        addon.setPaused(sessionId, true)
        const snapshot = addon.getSessionSnapshot(sessionId)
        if (snapshot === null) {
          throw new EmpvRuntimeGenerationFailure(
            `Native session ${sessionId} disappeared while loadPlayback was assembling its result.`
          )
        }
        return snapshot
      }
      case 'disposeSession': {
        const [sessionId] = request.args
        requireActiveSession(sessionId, request.method)
        setSessionState(sessionId, 'disposing')
        try {
          await addon.disposeSession(sessionId)
          return undefined
        } catch (error) {
          throw new EmpvRuntimeGenerationFailure(
            `Native disposal failed for empv runtime session ${sessionId}; the native registry already removed the session, but complete resource cleanup is unknown: ${normalizeError(error).message}`,
            { cause: error }
          )
        } finally {
          removeSession(sessionId)
        }
      }
      case 'captureFrame': {
        const [sessionId] = request.args
        requireActiveSession(sessionId, request.method)
        // The Buffer the addon returns arrives on the other side as a
        // Uint8Array; the shape is declared that way in the protocol.
        return addon.captureFrame(sessionId)
      }
      default: {
        // Everything else is the addon's own method, called with the addon's own
        // arguments. Checked against the allow-list first so an unknown name is
        // an error rather than a lookup of some arbitrary property.
        const method: string = request.method
        if (!FORWARDED_METHODS.has(method)) {
          throw new Error(`Unsupported empv playback runtime method: ${method}`)
        }
        if (method !== 'isSupported') {
          const [sessionId] = request.args
          if (typeof sessionId !== 'string') {
            throw new Error(
              `Invalid empv runtime ${method} request: the first argument must be a session id.`
            )
          }
          requireActiveSession(sessionId, method)
        }
        const forward = addon[method as EmpvForwardedMethod] as (...args: never[]) => unknown
        return forward(...(request.args as never[]))
      }
    }
  }

  async function handleRequest(request: EmpvRuntimeRequest): Promise<void> {
    activeRequests += 1
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    try {
      const result = await runRequest(request)
      try {
        post({ id: request.id, type: 'done', result })
      } catch (error) {
        scheduleGenerationFailureExit(
          new EmpvRuntimeGenerationFailure(
            `Failed to post the successful response for empv runtime request #${request.id} (${request.method}): ${normalizeError(error).message}`,
            { cause: error }
          )
        )
      }
    } catch (error) {
      const normalized = normalizeError(error)
      const recoverability =
        normalized instanceof EmpvRuntimeGenerationFailure ? 'generation' : 'request'
      try {
        post({
          id: request.id,
          type: 'error',
          message: normalized.message,
          name: normalized.name,
          recoverability
        })
      } catch (postError) {
        scheduleGenerationFailureExit(
          new EmpvRuntimeGenerationFailure(
            `Failed to post the error response for empv runtime request #${request.id} (${request.method}): ${normalizeError(postError).message}`,
            { cause: postError }
          )
        )
      }
      if (recoverability === 'generation') scheduleGenerationFailureExit(normalized)
    } finally {
      activeRequests -= 1
      scheduleIdleShutdown()
    }
  }

  runtimeParentPort.on('message', (event) => void handleRequest(event.data as EmpvRuntimeRequest))
  scheduleIdleShutdown()

  // Load the native addon now rather than on the first request. getLoaded() ends
  // in a require() of the addon, and that synchronous dlopen blocks this
  // process's event loop -- including the heartbeat timer installed below. macOS
  // validates the code signature of the addon and its vendored dylib chain on
  // the first load after the binary changes (an app update, a local rebuild),
  // measured at ~2s against an 8ms warm load. Deferring it to the first request
  // put that stall inside a client watchdog's liveness budget, so opening a
  // video right after launch read as a hung runtime and got this process
  // SIGKILLed. Loading before the first heartbeat puts it in the watchdog's
  // startup budget instead, where it belongs. Nothing is deferred by loading
  // eagerly: runRequest awaits getLoaded() for every method, so no request can
  // be served without it.
  void getLoaded()
    .catch((error: unknown) => {
      // Not swallowed -- getLoaded() already cleared its cached promise, so the
      // next request retries the load and rejects with the real error. This
      // handler keeps the preload's rejection from going unobserved and mirrors
      // it onto the stderr the client forwards, so a startup-time load failure
      // is visible even before any request arrives.
      const normalized = error instanceof Error ? error : new Error(String(error))
      process.stderr.write(
        `[empv-runtime] native addon preload failed: ${normalized.stack ?? normalized.message}\n`
      )
    })
    .finally(() => {
      // Heartbeats start whatever the outcome: a failed load leaves this process
      // alive and answerable, and it must not read as hung.
      publishHeartbeat()
      heartbeatTimer = setInterval(publishHeartbeat, EMPV_RUNTIME_HEARTBEAT_INTERVAL_MS)
      heartbeatTimer.unref()
    })

  return {
    stop() {
      stopped = true
      if (idleTimer) clearTimeout(idleTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (generationFailureExit) clearImmediate(generationFailureExit)
      idleTimer = null
      heartbeatTimer = null
      generationFailureExit = null
    }
  }
}
