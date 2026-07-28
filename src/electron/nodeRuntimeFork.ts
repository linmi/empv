import { fork } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { EmpvRuntimeChildProcess, EmpvRuntimeProcessForkOptions } from './clientCore.ts'

function errorReport(error: Error): string {
  return error.stack ?? error.message
}

export function resolveEmpvNodeExecutablePath(resolvePath: (() => string) | undefined): string {
  if (!resolvePath) {
    throw new Error(
      'empv on Linux requires resolveLinuxNodeExecutablePath to return an absolute path to a separately packaged plain Node executable.'
    )
  }

  let executablePath: string
  try {
    executablePath = resolvePath()
  } catch (error) {
    throw new Error(
      `Failed to resolve the empv Linux Node executable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (!isAbsolute(executablePath)) {
    throw new Error(
      `The empv Linux Node executable path must be absolute; received ${JSON.stringify(executablePath)}.`
    )
  }
  if (!existsSync(executablePath)) {
    throw new Error(`The empv Linux Node executable does not exist at ${executablePath}.`)
  }
  try {
    accessSync(executablePath, constants.X_OK)
  } catch (error) {
    throw new Error(`The empv Linux Node executable is not executable at ${executablePath}.`, {
      cause: error
    })
  }
  return executablePath
}

// Linux must not host libmpv inside Electron's Chromium utility process or
// Electron's executable in ELECTRON_RUN_AS_NODE mode:
// Chromium has already loaded its own FFmpeg build into the process-wide symbol
// scope, and a distro libmpv can bind to that ABI-incompatible copy. Electron's
// executable retains those symbols even in Node mode. A separately packaged
// plain Node executable provides the required process and dynamic-linker
// boundary without depending on a system installation or PATH lookup.
export function forkEmpvNodeRuntimeProcess(
  modulePath: string,
  args: string[],
  options: EmpvRuntimeProcessForkOptions,
  execPath: string
): EmpvRuntimeChildProcess {
  const child = fork(modulePath, args, {
    detached: false,
    env: options.env,
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
