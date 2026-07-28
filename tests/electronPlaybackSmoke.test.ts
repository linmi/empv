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
    const windowsWidShim = readFileSync(
      join(process.cwd(), 'native/shims/wid/native_window_win32.cc'),
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
    assert.match(nodeRuntimeFork, /resolveEmpvNodeExecutablePath/)
    assert.match(nodeRuntimeFork, /serialization: ['"]advanced['"]/)
    assert.doesNotMatch(nodeRuntimeFork, /process\.execPath/)
    assert.doesNotMatch(nodeRuntimeFork, /ELECTRON_RUN_AS_NODE: ['"]1['"]/)
    assert.doesNotMatch(nodeRuntimeFork, /RTLD_DEEPBIND/)
    assert.match(windowsWidShim, /std::thread windowThread_/)
    assert.match(windowsWidShim, /while \(GetMessageW\(/)
    assert.match(windowsWidShim, /SendMessageTimeoutW\(/)
    assert.match(windowsWidShim, /SMTO_ABORTIFHUNG \| SMTO_BLOCK/)
    assert.match(windowsWidShim, /commandTimeoutMs = 5'000/)
    assert.doesNotMatch(windowsWidShim, /SetParent\(child, nullptr\)/)
    assert.match(smoke, /createEmpvRuntimeClient\(\{/)
    assert.match(smoke, /EMPV_SMOKE_PRESENTER_ADDON_PATH/)
    assert.match(smoke, /EMPV_PRESENTER_ADDON_PATH/)
    assert.match(smoke, /runtime backend probed as \$\{host\.presentationKind\}/)
    assert.match(smoke, /creating runtime session/)
    assert.match(smoke, /runtime session \$\{runtimeSessionId\} created/)
    assert.match(smoke, /creating presenter/)
    assert.match(smoke, /presenter created/)
    assert.match(smoke, /client\.invokeWithGeneration\('createSession'/)
    assert.match(
      smoke,
      /await host\.createPresenter\(\s+presenterId,\s+runtimeGeneration,\s+runtimeSessionId,\s+browserWindow\.getNativeWindowHandle\(\)/
    )
    assert.doesNotMatch(smoke, /client\.invoke\(/)
    assert.doesNotMatch(smoke, /videoWindowHandle/)
    assert.doesNotMatch(smoke, /adoptVideoWindow/)
    assert.doesNotMatch(smoke, /onWarmUpFailed/)
    assert.match(smoke, /const first = await createPlaybackSession\(/)
    assert.match(smoke, /const second = await createPlaybackSession\(/)
    assert.match(smoke, /await disposePlaybackSession\(first\)/)
    assert.match(smoke, /process\.kill\(runtimePid, 'SIGKILL'\)/)
    assert.match(smoke, /terminalReason\.type, 'unexpected-exit'/)
    assert.match(smoke, /restarted\.runtimeSessionId,\s+first\.runtimeSessionId/)
    assert.match(smoke, /await loadSource\(restarted, secondFixturePath/)
    assert.match(smoke, /await disposePlaybackSession\(restarted\)/)
    assert.match(smoke, /await releasePresenter\(second, true\)/)
    assert.match(smoke, /assert\.deepEqual\(diagnostics, \[\]\)/)
    assert.match(smoke, /error instanceof AggregateError/)
    assert.match(smoke, /Aggregate error/)
    assert.match(workflow, /Install ffmpeg smoke dependency[\s\S]*choco install ffmpeg/)
    assert.match(workflow, /Stage the pinned runtime beside empv\.node/)
    assert.match(workflow, /EMPV_SMOKE_ADDON_PATH=\$nodeFile/)
    assert.match(workflow, /empv_presenter\.node/)
    assert.match(workflow, /EMPV_SMOKE_PRESENTER_ADDON_PATH/)
    assert.match(workflow, /must not load libmpv or bundled third-party libraries/)
    assert.match(workflow, /Run the Windows native runtime and presenter smoke/)
    assert.match(workflow, /Run crash-isolated Electron playback smoke/)
    assert.match(workflow, /Run crash-isolated Electron playback smoke under Xvfb/)
    assert.match(
      workflow,
      /Run the Windows native runtime and presenter smoke\s+run: pnpm run smoke:windows/
    )
    assert.match(
      workflow,
      /Stage the pinned runtime beside empv\.node[\s\S]*Run crash-isolated Electron playback smoke\s+timeout-minutes: 1\s+run: pnpm run smoke:electron-playback/
    )
    assert.match(
      workflow,
      /pnpm exec electron --no-sandbox\s+\\\s+scripts\/electron-runtime-playback-smoke\.mjs/
    )
    assert.match(readme, /Native session ids are generation-scoped and may repeat after/)
    assert.doesNotMatch(readme, /bindSessionToPresenter\(sessionId, sessionId\)/)
  })
})
