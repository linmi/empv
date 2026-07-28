import { resolveEmpvRuntimeParentPort } from '../../dist/electron/runtimeProcess.js'

const parentPort = resolveEmpvRuntimeParentPort()

if (!parentPort) {
  throw new Error('The empv runtime client smoke fixture requires a parent IPC channel.')
}

const heartbeat = setInterval(() => {
  parentPort.postMessage({
    type: 'runtime.heartbeat',
    pid: process.pid,
    sentAt: Date.now(),
    sessions: [{ sessionId: 'smoke-session', state: 'disposing', windowPresenter: null }]
  })
}, 50)

parentPort.on('message', ({ data }) => {
  if (data.method === 'createSession') {
    parentPort.postMessage({
      id: data.id,
      type: 'done',
      result: { sessionId: 'smoke-session' }
    })
    return
  }

  if (data.method === 'disposeSession') {
    // Deliberately keep heartbeating without settling this request. This is the
    // fault the smoke verifies: liveness is not request completion.
    return
  }

  if (data.method === 'isSupported') {
    parentPort.postMessage({ id: data.id, type: 'done', result: true })
    return
  }

  parentPort.postMessage({
    id: data.id,
    type: 'error',
    name: 'Error',
    recoverability: 'request',
    message: `Unexpected smoke method: ${String(data.method)}`
  })
})

process.once('exit', () => clearInterval(heartbeat))
