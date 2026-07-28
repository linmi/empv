import { Buffer } from 'node:buffer'

import {
  loadEmbeddedLibMpvAddon,
  type LibMpvWindowAddon,
  type LoadedEmbeddedLibMpvAddon
} from '../embedded.ts'

import {
  EMPV_FORWARDED_METHODS,
  EMPV_FRAME_LINK_ENV_KEY,
  EMPV_RUNTIME_HEARTBEAT_INTERVAL_MS,
  type EmpvForwardedMethod,
  type EmpvRuntimeEvent,
  type EmpvRuntimeRequest,
  type EmpvRuntimeResponse,
  type EmpvRuntimeSessionLifecycle,
  type EmpvRuntimeSessionState,
  type EmpvRuntimeWindowPresenterLifecycle
} from './protocol.ts'

// Isolated playback process: owns embedded mpv sessions and, for the window
// backend, the native presenter that adopts each session's child video window.
// Keeping both HWND-owning resources on this process/thread boundary prevents
// synchronous cross-thread Win32 presentation calls from blocking Electron's
// main process. The macOS layer presenter remains in the main process and
// receives rendered IOSurfaces over the frame link.
//
// This module is the whole playback process. A consumer's runtime entry is
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

type RuntimeWindowPresenterState = {
  presenterId: string
  state: EmpvRuntimeWindowPresenterLifecycle
}

type RuntimeSessionRecord = {
  state: EmpvRuntimeSessionLifecycle
  windowPresenter: RuntimeWindowPresenterState | null
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

// Cross-process parent channel, typed structurally to only what this module
// uses. Electron utility processes supply process.parentPort; Linux Node
// children are adapted from process.send/process.on('message').
export type EmpvRuntimeParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  onDisconnect?(listener: () => void): () => void
  postMessage(message: unknown): void
}

type RuntimeProcessEnvironment = NodeJS.Process & {
  parentPort?: EmpvRuntimeParentPort
}

export function resolveEmpvRuntimeParentPort(
  runtimeProcess: RuntimeProcessEnvironment = process
): EmpvRuntimeParentPort | undefined {
  if (runtimeProcess.parentPort) {
    return runtimeProcess.parentPort
  }
  if (!runtimeProcess.connected || typeof runtimeProcess.send !== 'function') {
    return undefined
  }

  return {
    on(_event, listener) {
      runtimeProcess.on('message', (message) => listener({ data: message }))
    },
    onDisconnect(listener) {
      runtimeProcess.once('disconnect', listener)
      return () => runtimeProcess.off('disconnect', listener)
    },
    postMessage(message) {
      if (!runtimeProcess.connected || typeof runtimeProcess.send !== 'function') {
        throw new Error('Cannot post an empv runtime message: the parent IPC channel is closed.')
      }
      runtimeProcess.send(message, (error) => {
        if (!error) return
        try {
          runtimeProcess.stderr.write(
            `[empv-runtime] parent IPC send failed: ${error.stack ?? error.message}\n`
          )
        } finally {
          runtimeProcess.exit(1)
        }
      })
    }
  }
}

export type EmpvRuntimeProcessHandle = {
  // Clears the idle and heartbeat timers. A playback child never needs this --
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
  const suppliedParentPort = options.parentPort ?? resolveEmpvRuntimeParentPort()

  if (!suppliedParentPort) {
    throw new Error(
      'The empv playback runtime must have an Electron parentPort or a connected Node IPC channel.'
    )
  }

  const runtimeParentPort = suppliedParentPort
  const removeParentDisconnectListener =
    runtimeParentPort.onDisconnect?.(() => exitProcess(0)) ?? (() => {})

  const sessions = new Map<string, RuntimeSessionRecord>()
  const sessionByWindowPresenter = new Map<string, string>()
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
    return [...sessions].map(([sessionId, record]) => ({
      sessionId,
      state: record.state,
      windowPresenter: record.windowPresenter ? { ...record.windowPresenter } : null
    }))
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
    const record = sessions.get(sessionId)
    if (record) {
      record.state = state
    } else {
      sessions.set(sessionId, { state, windowPresenter: null })
    }
    publishHeartbeat()
  }

  function removeSession(sessionId: string): void {
    const record = sessions.get(sessionId)
    if (record?.windowPresenter) {
      sessionByWindowPresenter.delete(record.windowPresenter.presenterId)
    }
    sessions.delete(sessionId)
    publishHeartbeat()
  }

  function requireActiveSession(sessionId: string, method: string): RuntimeSessionRecord {
    const record = sessions.get(sessionId)
    if (record === undefined) {
      throw new Error(
        `Cannot run empv runtime method ${method}: session ${sessionId} does not exist in this process generation.`
      )
    }
    if (record.state !== 'active') {
      throw new Error(
        `Cannot run empv runtime method ${method}: session ${sessionId} is ${record.state}, not active.`
      )
    }
    return record
  }

  function requireWindowAddon(
    loaded: LoadedEmbeddedLibMpvAddon,
    method: string
  ): LibMpvWindowAddon {
    if (loaded.presentationKind !== 'window') {
      throw new Error(
        `Cannot run empv runtime method ${method}: the active backend is ${loaded.presentationKind}, not window.`
      )
    }
    return loaded.addon
  }

  function requireActiveWindowPresenter(
    presenterId: string,
    method: string
  ): { sessionId: string; session: RuntimeSessionRecord } {
    const sessionId = sessionByWindowPresenter.get(presenterId)
    if (!sessionId) {
      throw new Error(
        `Cannot run empv runtime method ${method}: window presenter ${presenterId} does not exist in this process generation.`
      )
    }
    const session = requireActiveSession(sessionId, method)
    const presenter = session.windowPresenter
    if (!presenter || presenter.presenterId !== presenterId) {
      throw new EmpvRuntimeGenerationFailure(
        `Window presenter index ${presenterId} points to session ${sessionId}, but the session does not own that presenter.`
      )
    }
    if (presenter.state !== 'active') {
      throw new Error(
        `Cannot run empv runtime method ${method}: window presenter ${presenterId} is ${presenter.state}, not active.`
      )
    }
    return { sessionId, session }
  }

  function setWindowPresenterState(
    session: RuntimeSessionRecord,
    presenterId: string,
    state: EmpvRuntimeWindowPresenterLifecycle
  ): void {
    session.windowPresenter = { presenterId, state }
    publishHeartbeat()
  }

  function clearWindowPresenter(session: RuntimeSessionRecord, presenterId: string): void {
    sessionByWindowPresenter.delete(presenterId)
    session.windowPresenter = null
    publishHeartbeat()
  }

  function destroyWindowPresenterNative(
    addon: LibMpvWindowAddon,
    session: RuntimeSessionRecord,
    presenterId: string
  ): void {
    setWindowPresenterState(session, presenterId, 'disposing')
    try {
      addon.destroyPresenter(presenterId)
    } catch (error) {
      setWindowPresenterState(session, presenterId, 'cleanup-required')
      throw new EmpvRuntimeGenerationFailure(
        `Native destruction failed for empv window presenter ${presenterId}; attachment ownership is unknown and this runtime generation cannot continue: ${normalizeError(error).message}`,
        { cause: error }
      )
    }
    clearWindowPresenter(session, presenterId)
  }

  function synchronizeWindowRenderSize(
    addon: LibMpvWindowAddon,
    sessionId: string,
    renderSize: { widthPixels: number; heightPixels: number }
  ): void {
    if (renderSize.widthPixels <= 0 || renderSize.heightPixels <= 0) return
    addon.setRenderSize(sessionId, renderSize.widthPixels, renderSize.heightPixels)
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
      case 'probe':
        return {
          presentationKind: loaded.presentationKind,
          supported: addon.isSupported()
        }
      case 'createSession': {
        const [input] = request.args
        // sessionId is only known once createSession resolves, so route the
        // snapshot/frame sinks through a mutable holder. A throw inside a sink
        // would escape the native ThreadSafeFunction dispatcher and crash this
        // process; contain it.
        let createdSessionId: string | null = null
        const onSnapshotChanged = (): void => {
          try {
            if (!createdSessionId || sessions.get(createdSessionId)?.state !== 'active') return
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
            if (!createdSessionId || sessions.get(createdSessionId)?.state !== 'active') return
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
          if (
            loaded.presentationKind === 'window' &&
            loaded.addon.getVideoWindowHandle(sessionId) === null
          ) {
            throw new Error(
              `Window-backed native session ${sessionId} did not expose the video window handle required for isolated presentation.`
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
          return { sessionId, snapshot }
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
      case 'createWindowPresenter': {
        const [input] = request.args
        const windowAddon = requireWindowAddon(loaded, request.method)
        const session = requireActiveSession(input.sessionId, request.method)
        if (session.windowPresenter) {
          throw new Error(
            `Cannot create empv window presenter ${input.presenterId}: session ${input.sessionId} already owns presenter ${session.windowPresenter.presenterId} (${session.windowPresenter.state}).`
          )
        }
        const existingSessionId = sessionByWindowPresenter.get(input.presenterId)
        if (existingSessionId) {
          throw new Error(
            `Cannot create duplicate empv window presenter ${input.presenterId}: it is already owned by session ${existingSessionId}.`
          )
        }
        if (!(input.parentWindowHandle instanceof Uint8Array)) {
          throw new Error(
            `Cannot create empv window presenter ${input.presenterId}: parentWindowHandle must be a Uint8Array.`
          )
        }

        sessionByWindowPresenter.set(input.presenterId, input.sessionId)
        setWindowPresenterState(session, input.presenterId, 'creating')
        let nativePresenterCreated = false
        try {
          const renderSize = windowAddon.createPresenter(
            input.presenterId,
            Buffer.from(input.parentWindowHandle),
            input.options
          )
          nativePresenterCreated = true
          const childWindowHandle = windowAddon.getVideoWindowHandle(input.sessionId)
          if (childWindowHandle === null) {
            throw new Error(
              `Window-backed native session ${input.sessionId} lost its video window before presenter ${input.presenterId} could adopt it.`
            )
          }
          windowAddon.adoptVideoWindow(input.presenterId, childWindowHandle)
          synchronizeWindowRenderSize(windowAddon, input.sessionId, renderSize)
          setWindowPresenterState(session, input.presenterId, 'active')
          return renderSize
        } catch (createError) {
          if (!nativePresenterCreated) {
            clearWindowPresenter(session, input.presenterId)
            throw createError
          }
          try {
            windowAddon.destroyPresenter(input.presenterId)
          } catch (rollbackError) {
            setWindowPresenterState(session, input.presenterId, 'cleanup-required')
            throw new EmpvRuntimeGenerationFailure(
              `Failed to create empv window presenter ${input.presenterId}: ${normalizeError(createError).message}. Native presenter rollback also failed, so generation ownership is unknown: ${normalizeError(rollbackError).message}`,
              { cause: rollbackError }
            )
          }
          clearWindowPresenter(session, input.presenterId)
          throw new Error(
            `Failed to create empv window presenter ${input.presenterId}; native creation was rolled back: ${normalizeError(createError).message}`,
            { cause: createError }
          )
        }
      }
      case 'setWindowPresenterBounds': {
        const [presenterId, bounds] = request.args
        const windowAddon = requireWindowAddon(loaded, request.method)
        const { sessionId } = requireActiveWindowPresenter(presenterId, request.method)
        try {
          const renderSize = windowAddon.setPresenterBounds(presenterId, bounds)
          synchronizeWindowRenderSize(windowAddon, sessionId, renderSize)
          return renderSize
        } catch (error) {
          throw new EmpvRuntimeGenerationFailure(
            `Failed to update empv window presenter ${presenterId} bounds; native presentation state is no longer trustworthy: ${normalizeError(error).message}`,
            { cause: error }
          )
        }
      }
      case 'refreshWindowPresenterScale': {
        const [presenterId] = request.args
        const windowAddon = requireWindowAddon(loaded, request.method)
        const { sessionId } = requireActiveWindowPresenter(presenterId, request.method)
        try {
          const renderSize = windowAddon.refreshPresenterScale(presenterId)
          synchronizeWindowRenderSize(windowAddon, sessionId, renderSize)
          return renderSize
        } catch (error) {
          throw new EmpvRuntimeGenerationFailure(
            `Failed to refresh empv window presenter ${presenterId} scale; native presentation state is no longer trustworthy: ${normalizeError(error).message}`,
            { cause: error }
          )
        }
      }
      case 'setWindowPresenterSuspended': {
        const [presenterId, suspended] = request.args
        const windowAddon = requireWindowAddon(loaded, request.method)
        const { sessionId } = requireActiveWindowPresenter(presenterId, request.method)
        try {
          windowAddon.setPresenterSuspended(presenterId, suspended)
          windowAddon.setPresentationSuspended(sessionId, suspended)
          return undefined
        } catch (error) {
          throw new EmpvRuntimeGenerationFailure(
            `Failed to update empv window presenter ${presenterId} suspension; native presentation state is no longer trustworthy: ${normalizeError(error).message}`,
            { cause: error }
          )
        }
      }
      case 'destroyWindowPresenter': {
        const [presenterId] = request.args
        const windowAddon = requireWindowAddon(loaded, request.method)
        const { session } = requireActiveWindowPresenter(presenterId, request.method)
        destroyWindowPresenterNative(windowAddon, session, presenterId)
        return undefined
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
        const session = requireActiveSession(sessionId, request.method)
        setSessionState(sessionId, 'disposing')
        const cleanupFailures: Error[] = []
        try {
          if (session.windowPresenter) {
            const presenterId = session.windowPresenter.presenterId
            try {
              destroyWindowPresenterNative(
                requireWindowAddon(loaded, request.method),
                session,
                presenterId
              )
            } catch (error) {
              cleanupFailures.push(normalizeError(error))
            }
          }
          try {
            await addon.disposeSession(sessionId)
          } catch (error) {
            cleanupFailures.push(normalizeError(error))
          }
          if (cleanupFailures.length > 0) {
            throw new EmpvRuntimeGenerationFailure(
              `Native disposal failed for empv runtime session ${sessionId}; presenter/session cleanup ownership is unknown: ${cleanupFailures.map((error) => error.message).join('; ')}`,
              { cause: cleanupFailures[0] }
            )
          }
          return undefined
        } catch (error) {
          if (error instanceof EmpvRuntimeGenerationFailure) throw error
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
      removeParentDisconnectListener()
      if (idleTimer) clearTimeout(idleTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (generationFailureExit) clearImmediate(generationFailureExit)
      idleTimer = null
      heartbeatTimer = null
      generationFailureExit = null
    }
  }
}
