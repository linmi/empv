// Type-only: pulling the real client in would pull `electron` in with it, and
// the whole point of the playback host is that it does not need one.
import type { EmpvRuntimeClient, EmpvRuntimeFrameEvent } from '../../src/electron/client.ts'

export type FakeRuntimeClient = {
  client: EmpvRuntimeClient
  invocations: { method: string; args: unknown[] }[]
  generationInvocations: { generation: number; method: string; args: unknown[] }[]
  emitFrame(event: Omit<EmpvRuntimeFrameEvent, 'type'>): void
  emitExit(): void
  terminated: string[]
}

export function makeFakeRuntimeClient(
  overrides: {
    invoke?: (method: string, args: unknown[]) => unknown
    onFrame?: (listener: (event: EmpvRuntimeFrameEvent) => void) => () => void
    presentationKind?: 'layer' | 'window'
  } = {}
): FakeRuntimeClient {
  const invocations: { method: string; args: unknown[] }[] = []
  const generationInvocations: { generation: number; method: string; args: unknown[] }[] = []
  const terminated: string[] = []
  const frameListeners = new Set<(event: EmpvRuntimeFrameEvent) => void>()
  const exitListeners = new Set<Parameters<EmpvRuntimeClient['onExit']>[0]>()

  async function invoke(method: string, args: unknown[]): Promise<never> {
    invocations.push({ method, args })
    if (overrides.invoke) return overrides.invoke(method, args) as never
    if (method === 'probe') {
      return {
        presentationKind: overrides.presentationKind ?? 'layer',
        supported: true
      } as never
    }
    return undefined as never
  }

  const client: EmpvRuntimeClient = {
    async invoke(method, ...args) {
      return invoke(method, args)
    },
    async invokeWithGeneration(method, ...args) {
      return { generation: 1, result: await invoke(method, args) }
    },
    async invokeInGeneration(generation, method, ...args) {
      generationInvocations.push({ generation, method, args })
      return invoke(method, args)
    },
    onSnapshot() {
      return () => {}
    },
    onFrame(listener) {
      if (overrides.onFrame) {
        return overrides.onFrame(listener)
      }
      frameListeners.add(listener)
      return () => {
        frameListeners.delete(listener)
      }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    getProcessId() {
      return 1234
    },
    getSessionStates() {
      return []
    },
    terminate(reason) {
      terminated.push(reason)
    }
  }

  return {
    client,
    invocations,
    generationInvocations,
    emitFrame(event) {
      for (const listener of frameListeners) listener({ type: 'session.frame', ...event })
    },
    emitExit() {
      for (const listener of exitListeners) {
        listener(new Error('fake runtime exited') as never, [])
      }
    },
    terminated
  }
}
