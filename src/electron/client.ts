import { existsSync } from 'node:fs'

import { utilityProcess, type UtilityProcess } from 'electron'

import {
  EMPV_FRAME_LINK_ENV_KEY,
  type EmpvRuntimeArgs,
  type EmpvRuntimeEvent,
  type EmpvRuntimeMethod,
  type EmpvRuntimeRequest,
  type EmpvRuntimeResponse,
  type EmpvRuntimeResult
} from './protocol.ts'

// Main-process client for the playback utility process: spawn/respawn, typed
// request/reply correlation, and event fan-out.
//
// What lives here is mechanism. Policy stays with the consumer and is supplied
// through options: where the built utility entry is, what the process is called,
// what extra environment it gets, and what to do when it stops answering. In
// particular this client does NOT own a liveness watchdog — it reports
// heartbeats and lets the consumer decide the timeout budget and the kill, so an
// app that already runs several utility processes keeps one watchdog policy
// across all of them instead of inheriting a second one from here.

export type EmpvRuntimeSnapshotEvent = Extract<EmpvRuntimeEvent, { type: 'session.snapshot' }>
export type EmpvRuntimeFrameEvent = Extract<EmpvRuntimeEvent, { type: 'session.frame' }>

export type EmpvRuntimeClientOptions = {
  // Absolute path of the built utility entry — the file whose whole body is
  // `startEmpvRuntimeProcess()`. Resolved per spawn so a consumer may compute it
  // from the app path at call time rather than at module load.
  resolveEntryPath: () => string
  // The mach bootstrap service name for the video frame link, injected into
  // every spawn's environment. The consumer generates it and registers it
  // main-side (startPresenterLink) so both ends agree across respawns.
  frameLinkServiceName: string
  // Shown in Activity Monitor / Task Manager for the spawned process.
  serviceName: string
  // Extra environment merged over process.env at each spawn. The frame-link key
  // is added by the client and does not need to be listed here.
  resolveForkEnv?: () => NodeJS.ProcessEnv
  // Prefix for stdout/stderr lines forwarded from the utility process.
  stdioPrefix?: string
  // Fired once per successful spawn, before any request is sent.
  onSpawn?: () => void
  // Fired on every heartbeat. A consumer-owned watchdog hangs off this.
  onHeartbeat?: () => void
  // Fired when the process is gone and its pending requests have been rejected.
  onStopped?: () => void
}

export type EmpvRuntimeClient = {
  invoke<Method extends EmpvRuntimeMethod>(
    method: Method,
    ...args: EmpvRuntimeArgs<Method>
  ): Promise<EmpvRuntimeResult<Method>>
  onSnapshot(listener: (event: EmpvRuntimeSnapshotEvent) => void): () => void
  onFrame(listener: (event: EmpvRuntimeFrameEvent) => void): () => void
  onExit(listener: (error: Error, activeSessionIds: string[]) => void): () => void
  getProcessId(): number | null
  // Session ids the utility reported in its last heartbeat. Read when the
  // process dies so the consumer knows which sessions to reconcile.
  getActiveSessionIds(): string[]
  // Fails every in-flight request and kills the process. A watchdog calls this
  // and nothing else: the ordering matters -- killing first leaves callers
  // hanging until the exit event lands -- and that ordering is this client's to
  // know, not its caller's. The exit path then reports the stop as usual.
  terminate(reason: string): void
}

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (result: unknown) => void
}

export function createEmpvRuntimeClient(options: EmpvRuntimeClientOptions): EmpvRuntimeClient {
  const stdioPrefix = options.stdioPrefix ?? '[empv-runtime]'

  let runtime: UtilityProcess | null = null
  let spawnPromise: Promise<UtilityProcess> | null = null
  let nextRequestId = 1
  let activeSessionIds: string[] = []
  const pendingRequests = new Map<number, PendingRequest>()
  const snapshotListeners = new Set<(event: EmpvRuntimeSnapshotEvent) => void>()
  const frameListeners = new Set<(event: EmpvRuntimeFrameEvent) => void>()
  const exitListeners = new Set<(error: Error, activeSessionIds: string[]) => void>()

  function rejectPending(error: Error): void {
    for (const request of pendingRequests.values()) request.reject(error)
    pendingRequests.clear()
  }

  function handleResponse(response: EmpvRuntimeResponse): void {
    const request = pendingRequests.get(response.id)
    if (!request) return

    pendingRequests.delete(response.id)
    if (response.type === 'done') {
      request.resolve(response.result)
      return
    }

    const error = new Error(response.message)
    error.name = response.name
    request.reject(error)
  }

  function handleMessage(message: EmpvRuntimeResponse | EmpvRuntimeEvent): void {
    if (message.type === 'done' || message.type === 'error') {
      handleResponse(message)
      return
    }
    if (message.type === 'runtime.heartbeat') {
      activeSessionIds = message.activeSessionIds
      options.onHeartbeat?.()
      return
    }
    if (message.type === 'session.snapshot') {
      for (const listener of snapshotListeners) listener(message)
      return
    }
    for (const listener of frameListeners) listener(message)
  }

  function spawn(): Promise<UtilityProcess> {
    if (runtime) return Promise.resolve(runtime)
    if (spawnPromise) return spawnPromise

    const entryPath = options.resolveEntryPath()
    // A missing entry is a build/packaging mistake, not a runtime condition.
    // utilityProcess.fork reports it late and vaguely, so name it here.
    if (!existsSync(entryPath)) {
      return Promise.reject(
        new Error(
          `The empv playback utility entry is missing at ${entryPath}. Build the utility entry before spawning the runtime.`
        )
      )
    }

    spawnPromise = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(entryPath, [], {
        env: {
          ...process.env,
          ...options.resolveForkEnv?.(),
          [EMPV_FRAME_LINK_ENV_KEY]: options.frameLinkServiceName
        },
        serviceName: options.serviceName,
        stdio: 'pipe'
      })
      let didSpawn = false

      child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`${stdioPrefix} ${chunk}`))
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`${stdioPrefix} ${chunk}`))
      child.on('message', (message) =>
        handleMessage(message as EmpvRuntimeResponse | EmpvRuntimeEvent)
      )
      child.once('spawn', () => {
        didSpawn = true
        runtime = child
        options.onSpawn?.()
        resolve(child)
      })
      child.once('exit', (code) => {
        const stoppedSessionIds = activeSessionIds
        const error = new Error(
          `The empv playback utility process exited with code ${String(code)}.`
        )
        runtime = null
        spawnPromise = null
        activeSessionIds = []
        options.onStopped?.()
        rejectPending(error)
        for (const listener of exitListeners) listener(error, stoppedSessionIds)
      })
      child.once('error', (type, location, report) => {
        const error = new Error(
          `The empv playback utility process ${type} at ${location}.\n${report}`
        )
        if (!didSpawn) {
          spawnPromise = null
          reject(error)
        }
        rejectPending(error)
      })
    })

    return spawnPromise
  }

  return {
    async invoke(method, ...args) {
      const child = await spawn()
      const id = nextRequestId++

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: (result) => resolve(result as never),
          reject
        })
        try {
          child.postMessage({ id, method, args } as EmpvRuntimeRequest)
        } catch (error) {
          pendingRequests.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
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
      return runtime?.pid ?? null
    },
    getActiveSessionIds() {
      return activeSessionIds
    },
    terminate(reason) {
      rejectPending(new Error(reason))
      const pid = runtime?.pid
      if (pid === undefined) return
      process.kill(pid, 'SIGKILL')
    }
  }
}
