import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { forkEmpvNodeRuntimeProcess } from '../src/electron/nodeRuntimeFork.ts'
import type { EmpvRuntimeRequest } from '../src/electron/protocol.ts'

const ECHO_ENTRY = fileURLToPath(new URL('./fixtures/nodeRuntimeEcho.mjs', import.meta.url))

test('the Node runtime fork preserves IPC values and owns an explicit process boundary', async () => {
  const child = forkEmpvNodeRuntimeProcess(
    ECHO_ENTRY,
    [],
    {
      env: {},
      serviceName: 'empv node runtime test',
      stdio: 'pipe'
    },
    process.execPath
  )

  const spawned = new Promise<void>((resolve) => child.onceSpawn(resolve))
  const fatal = new Promise<never>((_resolve, reject) => {
    child.onceFailure((failure) => {
      reject(new Error(`Runtime child failed at ${failure.location}: ${failure.report}`))
    })
  })
  const response = new Promise<unknown>((resolve) => child.onMessage(resolve))

  await Promise.race([spawned, fatal])
  const payload = {
    args: [],
    id: 42,
    method: 'isSupported'
  } satisfies EmpvRuntimeRequest
  child.postMessage(payload, (error) => {
    throw error
  })

  const reply = await Promise.race([response, fatal])
  assert.deepEqual(reply, {
    bytes: Buffer.from([1, 2, 3]),
    message: payload,
    runAsNode: '1'
  })
  assert.ok(typeof reply === 'object' && reply !== null)
  assert.ok(
    Buffer.isBuffer(Reflect.get(reply, 'bytes')),
    'advanced IPC serialization must preserve captured-frame Buffers'
  )
  assert.ok(child.pid)

  const exited = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => {
    child.onceExit((code, signal) => resolve({ code, signal }))
  })
  assert.equal(child.kill(), true)
  const exit = await exited
  assert.equal(exit.code, null)
  assert.equal(exit.signal, 'SIGTERM')
})
