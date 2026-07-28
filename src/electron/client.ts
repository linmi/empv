import { utilityProcess } from 'electron'

import {
  createEmpvRuntimeClientWithFork,
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeChildProcess,
  type EmpvRuntimeClient,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeFrameEvent,
  type EmpvRuntimeProcessFork,
  type EmpvRuntimeProcessForkOptions,
  type EmpvRuntimeSnapshotEvent,
  type EmpvRuntimeTerminalReason
} from './clientCore.ts'
import { forkEmpvNodeRuntimeProcess, resolveEmpvNodeExecutablePath } from './nodeRuntimeFork.ts'

export {
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeClient,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeFrameEvent,
  type EmpvRuntimeSnapshotEvent,
  type EmpvRuntimeTerminalReason
}

function forkEmpvUtilityRuntimeProcess(
  modulePath: string,
  args: string[],
  options: EmpvRuntimeProcessForkOptions
): EmpvRuntimeChildProcess {
  const child = utilityProcess.fork(modulePath, args, options)

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
      child.once('exit', (code) => listener(code, null))
    },
    onceFailure(listener) {
      child.once('error', (fatalType, location, report) =>
        listener({
          type: 'fatal-error',
          fatalType,
          location,
          report
        })
      )
    },
    onceSpawn(listener) {
      child.once('spawn', listener)
    },
    postMessage(message, _onError) {
      child.postMessage(message)
    }
  }
}

export function selectEmpvRuntimeProcessFork(
  platform: NodeJS.Platform,
  forks: { node: EmpvRuntimeProcessFork; utility: EmpvRuntimeProcessFork }
): EmpvRuntimeProcessFork {
  return platform === 'linux' ? forks.node : forks.utility
}

export function createEmpvRuntimeClient(options: EmpvRuntimeClientOptions): EmpvRuntimeClient {
  const linuxNodeExecutablePath =
    process.platform === 'linux'
      ? resolveEmpvNodeExecutablePath(options.resolveLinuxNodeExecutablePath)
      : null

  return createEmpvRuntimeClientWithFork(
    options,
    selectEmpvRuntimeProcessFork(process.platform, {
      node: (modulePath, args, forkOptions) => {
        if (linuxNodeExecutablePath === null) {
          throw new Error('The empv Linux Node process fork was selected on a non-Linux platform.')
        }
        return forkEmpvNodeRuntimeProcess(modulePath, args, forkOptions, linuxNodeExecutablePath)
      },
      utility: forkEmpvUtilityRuntimeProcess
    })
  )
}
