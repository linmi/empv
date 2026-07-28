import { utilityProcess } from 'electron'

import {
  createEmpvRuntimeClientWithFork,
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeClient,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeFrameEvent,
  type EmpvRuntimeSnapshotEvent,
  type EmpvRuntimeTerminalReason
} from './clientCore.ts'

export {
  EmpvRuntimeProcessFailure,
  type EmpvRuntimeClient,
  type EmpvRuntimeClientDiagnostic,
  type EmpvRuntimeClientOptions,
  type EmpvRuntimeFrameEvent,
  type EmpvRuntimeSnapshotEvent,
  type EmpvRuntimeTerminalReason
}

export function createEmpvRuntimeClient(options: EmpvRuntimeClientOptions): EmpvRuntimeClient {
  return createEmpvRuntimeClientWithFork(options, (modulePath, args, forkOptions) =>
    utilityProcess.fork(modulePath, args, forkOptions)
  )
}
