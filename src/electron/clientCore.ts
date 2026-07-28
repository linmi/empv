import { existsSync } from 'node:fs'

import {
  EMPV_FRAME_LINK_ENV_KEY,
  EMPV_RUNTIME_SESSION_CREATE_METHOD,
  EMPV_RUNTIME_UNOWNED_METHODS,
  type EmpvRuntimeArgs,
  type EmpvRuntimeEvent,
  type EmpvRuntimeMethod,
  type EmpvRuntimeOwnedMethod,
  type EmpvRuntimeRequest,
  type EmpvRuntimeResponse,
  type EmpvRuntimeResult,
  type EmpvRuntimeSessionCreateMethod,
  type EmpvRuntimeSessionState,
  type EmpvRuntimeUnownedMethod
} from './protocol.ts'

export type EmpvRuntimeSnapshotEvent = Extract<EmpvRuntimeEvent, { type: 'session.snapshot' }>
export type EmpvRuntimeFrameEvent = Extract<EmpvRuntimeEvent, { type: 'session.frame' }>

export type EmpvRuntimeTerminalReason =
  | {
      type: 'fatal-error'
      fatalType: 'FatalError'
      location: string
      report: string
    }
  | {
      type: 'request-timeout'
      requestId: number
      method: EmpvRuntimeMethod
      sessionId: string | null
      timeoutMs: number
    }
  | {
      type: 'runtime-failure'
      requestId: number
      method: EmpvRuntimeMethod
      sessionId: string | null
      errorName: string
      message: string
    }
  | {
      type: 'process-error'
      location: string
      report: string
    }
  | {
      type: 'request-send-failure'
      requestId: number
      method: EmpvRuntimeMethod
      sessionId: string | null
      message: string
    }
  | { type: 'terminate'; reason: string }
  | { type: 'unexpected-exit' }

export class EmpvRuntimeProcessFailure extends Error {
  readonly generation: number
  readonly terminalReason: EmpvRuntimeTerminalReason
  readonly exitCode: number | null
  readonly exitSignal: NodeJS.Signals | null

  constructor(
    generation: number,
    terminalReason: EmpvRuntimeTerminalReason,
    exitCode: number | null = null,
    exitSignal: NodeJS.Signals | null = null
  ) {
    super(formatProcessFailure(generation, terminalReason, exitCode, exitSignal))
    this.name = 'EmpvRuntimeProcessFailure'
    this.generation = generation
    this.terminalReason = terminalReason
    this.exitCode = exitCode
    this.exitSignal = exitSignal
  }
}

export type EmpvRuntimeClientDiagnostic =
  | {
      type: 'callback-threw'
      generation: number
      callback:
        | 'onSpawn'
        | 'onHeartbeat'
        | 'onStopped'
        | 'snapshot-listener'
        | 'frame-listener'
        | 'exit-listener'
      error: Error
    }
  | {
      type: 'kill-failed'
      generation: number
      terminalReason: EmpvRuntimeTerminalReason
      error: Error
    }

type EmpvRuntimeCallbackName = Extract<
  EmpvRuntimeClientDiagnostic,
  { type: 'callback-threw' }
>['callback']

export type EmpvRuntimeClientOptions = {
  resolveEntryPath: () => string
  frameLinkServiceName: string
  serviceName: string
  // A timed-out request leaves mutation completion unknown. The client therefore
  // terminates that whole runtime generation instead of retrying the request or
  // allowing later calls to observe a potentially half-mutated native state.
  requestTimeoutMs: number
  // Linux-only hard requirement for the public Electron client. The executable
  // must be a separately packaged plain Node runtime, not Electron in
  // ELECTRON_RUN_AS_NODE mode: Electron preloads Chromium's FFmpeg symbols
  // before JavaScript starts, which can corrupt a distribution libmpv.
  resolveLinuxNodeExecutablePath?: () => string
  resolveForkEnv?: () => NodeJS.ProcessEnv
  stdioPrefix?: string
  onSpawn?: () => void
  onHeartbeat?: () => void
  onStopped?: () => void
  // Listener and child-process kill failures cannot be thrown from process
  // event callbacks. They are reported here; without a handler the client
  // writes them to stderr.
  onDiagnostic?: (diagnostic: EmpvRuntimeClientDiagnostic) => void
}

export type EmpvRuntimeInvocation<Method extends EmpvRuntimeMethod> = {
  generation: number
  result: EmpvRuntimeResult<Method>
}

export type EmpvRuntimeClient = {
  invoke<Method extends EmpvRuntimeUnownedMethod>(
    method: Method,
    ...args: EmpvRuntimeArgs<Method>
  ): Promise<EmpvRuntimeResult<Method>>
  // Session owners need the generation and result from one response boundary.
  // Reading "the current generation" after awaiting a request is racy because
  // that generation may exit between the response and the later read.
  invokeWithGeneration<Method extends EmpvRuntimeSessionCreateMethod>(
    method: Method,
    ...args: EmpvRuntimeArgs<Method>
  ): Promise<EmpvRuntimeInvocation<Method>>
  // Cleanup and presenter mutations must never respawn and accidentally target
  // a raw id reused by a later process generation. This variant only sends when
  // the exact generation is still current and running.
  invokeInGeneration<Method extends EmpvRuntimeOwnedMethod>(
    generation: number,
    method: Method,
    ...args: EmpvRuntimeArgs<Method>
  ): Promise<EmpvRuntimeResult<Method>>
  onSnapshot(listener: (event: EmpvRuntimeSnapshotEvent) => void): () => void
  onFrame(listener: (event: EmpvRuntimeFrameEvent) => void): () => void
  onExit(
    listener: (error: EmpvRuntimeProcessFailure, sessions: EmpvRuntimeSessionState[]) => void
  ): () => void
  getProcessId(): number | null
  getSessionStates(): EmpvRuntimeSessionState[]
  terminate(reason: string): void
}

export type EmpvRuntimeChildProcess = {
  readonly pid: number | undefined
  readonly stderr: NodeJS.ReadableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  kill(): boolean
  onMessage(listener: (message: unknown) => void): void
  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  onceFailure(listener: (failure: EmpvRuntimeChildFailure) => void): void
  onceSpawn(listener: () => void): void
  postMessage(message: EmpvRuntimeRequest, onError: (error: Error) => void): void
}

export type EmpvRuntimeChildFailure =
  | {
      type: 'fatal-error'
      fatalType: 'FatalError'
      location: string
      report: string
    }
  | {
      type: 'process-error'
      location: string
      report: string
    }

export type EmpvRuntimeProcessForkOptions = {
  env: NodeJS.ProcessEnv
  serviceName: string
  stdio: 'pipe'
}

export type EmpvRuntimeProcessFork = (
  modulePath: string,
  args: string[],
  options: EmpvRuntimeProcessForkOptions
) => EmpvRuntimeChildProcess

type PendingRequest = {
  method: EmpvRuntimeMethod
  sessionId: string | null
  reject: (error: Error) => void
  resolve: (result: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type GenerationState = 'spawning' | 'running' | 'terminating' | 'stopped'

type Generation = {
  id: number
  state: GenerationState
  child: EmpvRuntimeChildProcess
  sessions: EmpvRuntimeSessionState[]
  pendingRequests: Map<number, PendingRequest>
  spawnPromise: Promise<Generation>
  resolveSpawn: (generation: Generation) => void
  rejectSpawn: (error: Error) => void
  spawnSettled: boolean
  terminalReason: EmpvRuntimeTerminalReason | null
  terminalError: EmpvRuntimeProcessFailure | null
  killAttempted: boolean
}

function createDeferred<Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: Error) => void
} {
  let resolve: ((value: Value) => void) | null = null
  let reject: ((error: Error) => void) | null = null
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  if (resolve === null || reject === null) {
    throw new Error('Failed to initialize the empv runtime generation promise.')
  }

  return { promise, resolve, reject }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function requestSessionId(args: readonly unknown[]): string | null {
  return typeof args[0] === 'string' ? args[0] : null
}

function formatProcessFailure(
  generation: number,
  reason: EmpvRuntimeTerminalReason,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null
): string {
  const exitFacts = [
    exitCode === null ? null : `code ${String(exitCode)}`,
    exitSignal === null ? null : `signal ${exitSignal}`
  ].filter((fact): fact is string => fact !== null)
  const exitSuffix = exitFacts.length === 0 ? '' : ` Final exit: ${exitFacts.join(', ')}.`
  if (reason.type === 'fatal-error') {
    return `The empv playback runtime process generation ${generation} encountered ${reason.fatalType} at ${reason.location}.\n${reason.report}${exitSuffix}`
  }
  if (reason.type === 'request-timeout') {
    const sessionSuffix = reason.sessionId === null ? '' : ` for session ${reason.sessionId}`
    return `The empv playback runtime process generation ${generation} did not answer ${reason.method} request #${reason.requestId}${sessionSuffix} within ${reason.timeoutMs}ms and was terminated because its native state is no longer trustworthy.${exitSuffix}`
  }
  if (reason.type === 'runtime-failure') {
    const sessionSuffix = reason.sessionId === null ? '' : ` for session ${reason.sessionId}`
    return `The empv playback runtime process generation ${generation} reported unrecoverable ${reason.errorName} during ${reason.method} request #${reason.requestId}${sessionSuffix}: ${reason.message}${exitSuffix}`
  }
  if (reason.type === 'process-error') {
    return `The empv playback runtime process generation ${generation} failed at ${reason.location}.\n${reason.report}${exitSuffix}`
  }
  if (reason.type === 'request-send-failure') {
    const sessionSuffix = reason.sessionId === null ? '' : ` for session ${reason.sessionId}`
    return `The empv playback runtime process generation ${generation} could not send ${reason.method} request #${reason.requestId}${sessionSuffix}: ${reason.message}. The generation was terminated because its IPC state is no longer trustworthy.${exitSuffix}`
  }
  if (reason.type === 'terminate') {
    return `The empv playback runtime process generation ${generation} was terminated: ${reason.reason}.${exitSuffix}`
  }
  if (exitFacts.length === 0) {
    return `The empv playback runtime process generation ${generation} exited unexpectedly without an exit code or signal.`
  }
  return `The empv playback runtime process generation ${generation} exited unexpectedly with ${exitFacts.join(', ')}.`
}

export function createEmpvRuntimeClientWithFork(
  options: EmpvRuntimeClientOptions,
  forkProcess: EmpvRuntimeProcessFork
): EmpvRuntimeClient {
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
    throw new Error(
      `empv runtime requestTimeoutMs must be a positive safe integer; received ${String(options.requestTimeoutMs)}.`
    )
  }

  const stdioPrefix = options.stdioPrefix ?? '[empv-runtime]'
  const unownedMethods = new Set<string>(EMPV_RUNTIME_UNOWNED_METHODS)

  let currentGeneration: Generation | null = null
  let nextGenerationId = 1
  let nextRequestId = 1
  const snapshotListeners = new Set<(event: EmpvRuntimeSnapshotEvent) => void>()
  const frameListeners = new Set<(event: EmpvRuntimeFrameEvent) => void>()
  const exitListeners = new Set<
    (error: EmpvRuntimeProcessFailure, sessions: EmpvRuntimeSessionState[]) => void
  >()

  function reportDiagnostic(diagnostic: EmpvRuntimeClientDiagnostic): void {
    if (options.onDiagnostic) {
      try {
        options.onDiagnostic(diagnostic)
        return
      } catch (error) {
        try {
          process.stderr.write(
            `[empv-runtime] onDiagnostic threw: ${toError(error).stack ?? toError(error).message}\n`
          )
        } catch {
          return
        }
      }
    }

    try {
      process.stderr.write(
        `[empv-runtime] ${diagnostic.type} in generation ${diagnostic.generation}: ${diagnostic.error.stack ?? diagnostic.error.message}\n`
      )
    } catch {
      // Diagnostics must never interrupt generation cleanup.
    }
  }

  function runCallback(
    generation: Generation,
    callback: EmpvRuntimeCallbackName,
    listener: () => void
  ): void {
    try {
      listener()
    } catch (error) {
      reportDiagnostic({
        type: 'callback-threw',
        generation: generation.id,
        callback,
        error: toError(error)
      })
    }
  }

  function settleSpawn(
    generation: Generation,
    outcome: { type: 'resolve' } | { type: 'reject'; error: Error }
  ): void {
    if (generation.spawnSettled) return
    generation.spawnSettled = true
    if (outcome.type === 'resolve') generation.resolveSpawn(generation)
    else generation.rejectSpawn(outcome.error)
  }

  function rejectPending(generation: Generation, error: Error): void {
    const pending = Array.from(generation.pendingRequests.values())
    generation.pendingRequests.clear()
    for (const request of pending) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
  }

  function beginTerminal(
    generation: Generation,
    reason: EmpvRuntimeTerminalReason,
    exitCode: number | null = null,
    exitSignal: NodeJS.Signals | null = null
  ): EmpvRuntimeProcessFailure {
    if (generation.terminalError) return generation.terminalError

    const error = new EmpvRuntimeProcessFailure(generation.id, reason, exitCode, exitSignal)
    generation.state = 'terminating'
    generation.terminalReason = reason
    generation.terminalError = error
    settleSpawn(generation, { type: 'reject', error })
    rejectPending(generation, error)
    return error
  }

  function notifyListeners<Event>(
    generation: Generation,
    callback: 'snapshot-listener' | 'frame-listener',
    listeners: Set<(event: Event) => void>,
    event: Event
  ): void {
    for (const listener of listeners) {
      runCallback(generation, callback, () => listener(event))
    }
  }

  function handleResponse(generation: Generation, response: EmpvRuntimeResponse): void {
    const request = generation.pendingRequests.get(response.id)
    if (!request) return

    if (response.type === 'done') {
      generation.pendingRequests.delete(response.id)
      clearTimeout(request.timeout)
      request.resolve(response.result)
      return
    }

    if (response.recoverability === 'generation') {
      beginTerminal(generation, {
        type: 'runtime-failure',
        requestId: response.id,
        method: request.method,
        sessionId: request.sessionId,
        errorName: response.name,
        message: response.message
      })
      killGeneration(generation)
      return
    }

    generation.pendingRequests.delete(response.id)
    clearTimeout(request.timeout)
    const error = new Error(
      `empv runtime request ${request.method} (#${response.id}, generation ${generation.id}) failed: ${response.message}`
    )
    error.name = response.name
    request.reject(error)
  }

  function handleMessage(
    generation: Generation,
    message: EmpvRuntimeResponse | EmpvRuntimeEvent
  ): void {
    if (currentGeneration !== generation || generation.state !== 'running') return

    if (message.type === 'done' || message.type === 'error') {
      handleResponse(generation, message)
      return
    }
    if (message.type === 'runtime.heartbeat') {
      generation.sessions = message.sessions.map((session) => ({
        ...session,
        windowPresenter: session.windowPresenter ? { ...session.windowPresenter } : null
      }))
      if (options.onHeartbeat) {
        runCallback(generation, 'onHeartbeat', options.onHeartbeat)
      }
      return
    }
    if (message.type === 'session.snapshot') {
      notifyListeners(generation, 'snapshot-listener', snapshotListeners, message)
      return
    }
    notifyListeners(generation, 'frame-listener', frameListeners, message)
  }

  function handleExit(
    generation: Generation,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (currentGeneration !== generation || generation.state === 'stopped') return

    const stoppedSessions = generation.sessions.map((session) => ({
      ...session,
      windowPresenter: session.windowPresenter ? { ...session.windowPresenter } : null
    }))
    const reason = generation.terminalReason ?? { type: 'unexpected-exit' }
    beginTerminal(generation, reason, code, signal)
    const finalError = new EmpvRuntimeProcessFailure(generation.id, reason, code, signal)
    generation.state = 'stopped'
    generation.sessions = []
    currentGeneration = null

    if (options.onStopped) {
      runCallback(generation, 'onStopped', options.onStopped)
    }
    for (const listener of exitListeners) {
      runCallback(generation, 'exit-listener', () =>
        listener(
          finalError,
          stoppedSessions.map((session) => ({
            ...session,
            windowPresenter: session.windowPresenter ? { ...session.windowPresenter } : null
          }))
        )
      )
    }
  }

  function killGeneration(generation: Generation): void {
    if (generation.killAttempted) return
    generation.killAttempted = true

    const terminalReason = generation.terminalReason
    if (!terminalReason) {
      reportDiagnostic({
        type: 'kill-failed',
        generation: generation.id,
        terminalReason: { type: 'unexpected-exit' },
        error: new Error(
          `Refused to kill empv runtime generation ${generation.id} without a terminal reason.`
        )
      })
      return
    }

    try {
      if (!generation.child.kill()) {
        reportDiagnostic({
          type: 'kill-failed',
          generation: generation.id,
          terminalReason,
          error: new Error(
            `The runtime child process kill operation returned false for generation ${generation.id}.`
          )
        })
      }
    } catch (error) {
      reportDiagnostic({
        type: 'kill-failed',
        generation: generation.id,
        terminalReason,
        error: toError(error)
      })
    }
  }

  function spawn(): Promise<Generation> {
    if (currentGeneration) {
      if (currentGeneration.state === 'spawning' || currentGeneration.state === 'running') {
        return currentGeneration.spawnPromise
      }
      return Promise.reject(
        currentGeneration.terminalError ??
          new Error(
            `The empv playback runtime process generation ${currentGeneration.id} is not invokable (${currentGeneration.state}).`
          )
      )
    }

    let entryPath: string
    let forkEnv: NodeJS.ProcessEnv
    try {
      entryPath = options.resolveEntryPath()
      if (!existsSync(entryPath)) {
        return Promise.reject(
          new Error(
            `The empv playback utility entry is missing at ${entryPath}. Build the utility entry before spawning the runtime.`
          )
        )
      }
      forkEnv = options.resolveForkEnv?.() ?? {}
    } catch (error) {
      return Promise.reject(toError(error))
    }

    const generationId = nextGenerationId++
    let child: EmpvRuntimeChildProcess
    try {
      child = forkProcess(entryPath, [], {
        env: {
          ...process.env,
          ...forkEnv,
          [EMPV_FRAME_LINK_ENV_KEY]: options.frameLinkServiceName
        },
        serviceName: options.serviceName,
        stdio: 'pipe'
      })
    } catch (error) {
      return Promise.reject(
        new Error(
          `Failed to fork empv playback runtime process generation ${generationId}: ${toError(error).message}`,
          { cause: error }
        )
      )
    }

    const spawnDeferred = createDeferred<Generation>()
    const generation: Generation = {
      id: generationId,
      state: 'spawning',
      child,
      sessions: [],
      pendingRequests: new Map(),
      spawnPromise: spawnDeferred.promise,
      resolveSpawn: spawnDeferred.resolve,
      rejectSpawn: spawnDeferred.reject,
      spawnSettled: false,
      terminalReason: null,
      terminalError: null,
      killAttempted: false
    }
    currentGeneration = generation

    child.stdout?.on('data', (chunk: Buffer | string) =>
      process.stdout.write(`${stdioPrefix} ${chunk}`)
    )
    child.stderr?.on('data', (chunk: Buffer | string) =>
      process.stderr.write(`${stdioPrefix} ${chunk}`)
    )
    child.onMessage((message) =>
      handleMessage(generation, message as EmpvRuntimeResponse | EmpvRuntimeEvent)
    )
    child.onceSpawn(() => {
      if (currentGeneration !== generation || generation.state !== 'spawning') return
      generation.state = 'running'
      settleSpawn(generation, { type: 'resolve' })
      if (options.onSpawn) runCallback(generation, 'onSpawn', options.onSpawn)
    })
    child.onceExit((code, signal) => handleExit(generation, code, signal))
    child.onceFailure((failure) => {
      if (currentGeneration !== generation || generation.state === 'stopped') return
      beginTerminal(generation, failure)
      killGeneration(generation)
    })

    return generation.spawnPromise
  }

  function invokeRequest<Method extends EmpvRuntimeMethod>(
    expectedGenerationId: number | null,
    method: Method,
    args: EmpvRuntimeArgs<Method>
  ): Promise<EmpvRuntimeInvocation<Method>> {
    const id = nextRequestId++
    const spawnPromise =
      expectedGenerationId === null
        ? spawn()
        : currentGeneration?.id === expectedGenerationId && currentGeneration.state === 'running'
          ? Promise.resolve(currentGeneration)
          : Promise.reject(
              new Error(
                `Cannot send empv runtime request ${method} in generation ${expectedGenerationId}: that generation is no longer current and running.`
              )
            )

    return new Promise((resolve, reject) => {
      let settled = false
      let generation: Generation | null = null
      const settleResolve = (result: unknown, resultGeneration: number): void => {
        if (settled) return
        settled = true
        resolve({
          generation: resultGeneration,
          result: result as EmpvRuntimeResult<Method>
        })
      }
      const settleReject = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const timeout = setTimeout(() => {
        if (settled) return

        const timedOutGeneration = generation ?? currentGeneration
        if (!timedOutGeneration) {
          settleReject(
            new Error(
              `empv runtime request ${method} (#${id}) timed out before a runtime generation could be created.`
            )
          )
          return
        }

        const reason: EmpvRuntimeTerminalReason = {
          type: 'request-timeout',
          requestId: id,
          method,
          sessionId: requestSessionId(args),
          timeoutMs: options.requestTimeoutMs
        }
        const terminalError = beginTerminal(timedOutGeneration, reason)
        killGeneration(timedOutGeneration)
        settleReject(terminalError)
      }, options.requestTimeoutMs)

      void spawnPromise.then(
        (spawnedGeneration) => {
          generation = spawnedGeneration
          if (settled) return
          if (
            currentGeneration !== spawnedGeneration ||
            spawnedGeneration.state !== 'running' ||
            spawnedGeneration.terminalError
          ) {
            clearTimeout(timeout)
            settleReject(
              spawnedGeneration.terminalError ??
                new Error(
                  `empv runtime generation ${spawnedGeneration.id} is not accepting requests.`
                )
            )
            return
          }

          spawnedGeneration.pendingRequests.set(id, {
            method,
            sessionId: requestSessionId(args),
            resolve: (result) => settleResolve(result, spawnedGeneration.id),
            reject: settleReject,
            timeout
          })
          const request = {
            id,
            method,
            args
          } as EmpvRuntimeRequest
          const handleSendFailure = (error: Error): void => {
            if (currentGeneration !== spawnedGeneration || spawnedGeneration.state === 'stopped') {
              return
            }
            beginTerminal(spawnedGeneration, {
              type: 'request-send-failure',
              requestId: id,
              method,
              sessionId: requestSessionId(args),
              message: error.message
            })
            killGeneration(spawnedGeneration)
          }
          try {
            spawnedGeneration.child.postMessage(request, handleSendFailure)
          } catch (error) {
            handleSendFailure(toError(error))
          }
        },
        (error: unknown) => {
          clearTimeout(timeout)
          settleReject(toError(error))
        }
      )
    })
  }

  return {
    invoke(method, ...args) {
      if (!unownedMethods.has(method)) {
        return Promise.reject(
          new Error(
            `Empv runtime method ${method} owns generation-scoped state and cannot use invoke; create sessions with invokeWithGeneration and send owned requests with invokeInGeneration.`
          )
        )
      }
      return invokeRequest(null, method, args).then(({ result }) => result)
    },
    invokeWithGeneration(method, ...args) {
      if (method !== EMPV_RUNTIME_SESSION_CREATE_METHOD) {
        return Promise.reject(
          new Error(
            `Empv runtime method ${method} cannot use invokeWithGeneration; only createSession establishes new generation-scoped ownership.`
          )
        )
      }
      return invokeRequest(null, method, args)
    },
    invokeInGeneration(generation, method, ...args) {
      if (unownedMethods.has(method) || (method as string) === EMPV_RUNTIME_SESSION_CREATE_METHOD) {
        return Promise.reject(
          new Error(
            `Empv runtime method ${method} does not target existing generation-scoped ownership and cannot use invokeInGeneration.`
          )
        )
      }
      return invokeRequest(generation, method, args).then(({ result }) => result)
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    onFrame(listener) {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    getProcessId() {
      return currentGeneration?.state === 'running' ? (currentGeneration.child.pid ?? null) : null
    },
    getSessionStates() {
      return currentGeneration
        ? currentGeneration.sessions.map((session) => ({
            ...session,
            windowPresenter: session.windowPresenter ? { ...session.windowPresenter } : null
          }))
        : []
    },
    terminate(reason) {
      try {
        const generation = currentGeneration
        if (!generation || generation.state === 'stopped') return

        beginTerminal(generation, { type: 'terminate', reason })
        killGeneration(generation)
      } catch (error) {
        const generation = currentGeneration
        if (generation) {
          reportDiagnostic({
            type: 'kill-failed',
            generation: generation.id,
            terminalReason: generation.terminalReason ?? ({ type: 'terminate', reason } as const),
            error: toError(error)
          })
        }
      }
    }
  }
}
