import { fork } from 'node:child_process'

import type { EmpvRuntimeChildProcess, EmpvRuntimeProcessForkOptions } from './clientCore.ts'

function errorReport(error: Error): string {
  return error.stack ?? error.message
}

// Linux must not host libmpv inside Electron's Chromium utility process:
// Chromium has already loaded its own FFmpeg build into the process-wide symbol
// scope, and a distro libmpv can bind to that ABI-incompatible copy. Electron's
// own executable in ELECTRON_RUN_AS_NODE mode starts a plain Node process
// instead, preserving the packaged-app executable boundary without depending on
// a system Node installation.
export function forkEmpvNodeRuntimeProcess(
  modulePath: string,
  args: string[],
  options: EmpvRuntimeProcessForkOptions,
  execPath: string = process.execPath
): EmpvRuntimeChildProcess {
  const child = fork(modulePath, args, {
    detached: false,
    env: {
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    execArgv: [],
    execPath,
    serialization: 'advanced',
    silent: true
  })

  let failureListener: Parameters<EmpvRuntimeChildProcess['onceFailure']>[0] | null = null
  let pendingFailure: { type: 'process-error'; location: string; report: string } | null = null
  let processFailureReported = false

  function reportProcessFailure(error: Error, location: string): void {
    if (processFailureReported) return
    processFailureReported = true
    const failure = {
      type: 'process-error' as const,
      location,
      report: errorReport(error)
    }
    if (failureListener) {
      failureListener(failure)
    } else {
      pendingFailure = failure
    }
  }

  child.once('error', (error) => reportProcessFailure(error, 'node:child_process.fork'))

  return {
    get pid() {
      return child.pid
    },
    stderr: child.stderr,
    stdout: child.stdout,
    kill() {
      return child.kill()
    },
    onMessage(listener) {
      child.on('message', listener)
    },
    onceExit(listener) {
      child.once('exit', listener)
    },
    onceFailure(listener) {
      failureListener = listener
      if (pendingFailure) {
        const failure = pendingFailure
        pendingFailure = null
        listener(failure)
      }
    },
    onceSpawn(listener) {
      child.once('spawn', listener)
    },
    postMessage(message, onError) {
      if (!child.connected) {
        throw new Error(
          `Cannot send to empv runtime child ${String(child.pid)}: its IPC channel is disconnected.`
        )
      }
      child.send(message, (error) => {
        if (error) onError(error)
      })
    }
  }
}
