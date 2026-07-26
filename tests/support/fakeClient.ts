// Type-only: pulling the real client in would pull `electron` in with it, and
// the whole point of the playback host is that it does not need one.
import type { EmpvRuntimeClient, EmpvRuntimeFrameEvent } from '../../src/electron/client.ts'

export type FakeRuntimeClient = {
  client: EmpvRuntimeClient
  invocations: { method: string; args: unknown[] }[]
  emitFrame(event: Omit<EmpvRuntimeFrameEvent, 'type'>): void
  terminated: string[]
}

export function makeFakeRuntimeClient(
  overrides: { invoke?: (method: string, args: unknown[]) => unknown } = {}
): FakeRuntimeClient {
  const invocations: { method: string; args: unknown[] }[] = []
  const terminated: string[] = []
  const frameListeners = new Set<(event: EmpvRuntimeFrameEvent) => void>()

  const client: EmpvRuntimeClient = {
    async invoke(method, ...args) {
      invocations.push({ method, args })
      return overrides.invoke?.(method, args) as never
    },
    onSnapshot() {
      return () => {}
    },
    onFrame(listener) {
      frameListeners.add(listener)
      return () => {
        frameListeners.delete(listener)
      }
    },
    onExit() {
      return () => {}
    },
    getProcessId() {
      return 1234
    },
    getActiveSessionIds() {
      return []
    },
    terminate(reason) {
      terminated.push(reason)
    }
  }

  return {
    client,
    invocations,
    emitFrame(event) {
      for (const listener of frameListeners) listener({ type: 'session.frame', ...event })
    },
    terminated
  }
}
