import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { join } from 'node:path'

describe('integrated Electron playback smoke', () => {
  it('keeps the multi-session crash/recovery acceptance gate wired to package CI', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const smoke = readFileSync(
      join(process.cwd(), 'scripts/electron-runtime-playback-smoke.mjs'),
      'utf8'
    )
    const runtimeEntry = readFileSync(
      join(process.cwd(), 'scripts/fixtures/electron-playback-runtime.mjs'),
      'utf8'
    )
    const client = readFileSync(join(process.cwd(), 'src/electron/client.ts'), 'utf8')
    const nodeRuntimeFork = readFileSync(
      join(process.cwd(), 'src/electron/nodeRuntimeFork.ts'),
      'utf8'
    )
    const workflow = readFileSync(
      join(process.cwd(), '.github/workflows/native-compile.yml'),
      'utf8'
    )
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')

    assert.equal(
      packageJson.scripts['smoke:electron-playback'],
      'pnpm run build && electron scripts/electron-runtime-playback-smoke.mjs'
    )
    assert.match(runtimeEntry, /startEmpvRuntimeProcess\(\)/)
    assert.match(client, /platform === ['"]linux['"] \? forks\.node : forks\.utility/)
    assert.match(nodeRuntimeFork, /ELECTRON_RUN_AS_NODE: ['"]1['"]/)
    assert.match(nodeRuntimeFork, /serialization: ['"]advanced['"]/)
    assert.doesNotMatch(nodeRuntimeFork, /RTLD_DEEPBIND/)
    assert.match(smoke, /createEmpvRuntimeClient\(\{/)
    assert.match(smoke, /createEmpvPlaybackHost\(\{ client, frameLinkServiceName \}\)/)
    assert.match(smoke, /const first = await createPlaybackSession\(/)
    assert.match(smoke, /const second = await createPlaybackSession\(/)
    assert.match(smoke, /await disposePlaybackSession\(first\)/)
    assert.match(smoke, /process\.kill\(runtimePid, 'SIGKILL'\)/)
    assert.match(smoke, /terminalReason\.type, 'unexpected-exit'/)
    assert.match(smoke, /restarted\.runtimeSessionId,\s+first\.runtimeSessionId/)
    assert.match(smoke, /await loadSource\(restarted, secondFixturePath/)
    assert.match(smoke, /await disposePlaybackSession\(restarted\)/)
    assert.match(smoke, /assert\.deepEqual\(diagnostics, \[\]\)/)
    assert.match(workflow, /Run crash-isolated Electron playback smoke/)
    assert.match(workflow, /Run crash-isolated Electron playback smoke under Xvfb/)
    assert.match(
      workflow,
      /pnpm exec electron --no-sandbox\s+\\\s+scripts\/electron-runtime-playback-smoke\.mjs/
    )
    assert.match(readme, /Native session ids are generation-scoped and may repeat after/)
    assert.doesNotMatch(readme, /bindSessionToPresenter\(sessionId, sessionId\)/)
  })
})
