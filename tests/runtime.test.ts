import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LibMpvRuntimeError, assertLibMpvRuntime, resolveLibMpvRuntime } from '../src/runtime.ts'

// Fixtures describe a runtime the way a real staged one looks on disk: the addon
// under addon/, the shared library under lib/. Names are the real artifact names
// mpv and napi produce, not values read back out of the resolver.
const ADDON_RELATIVE_PATH = join('addon', 'empv.node')
const PRESENTER_ADDON_RELATIVE_PATH = join('addon', 'empv_presenter.node')
const DARWIN_LIBRARY_RELATIVE_PATH = join('lib', 'libmpv.dylib')

const temporaryRoots: string[] = []

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'empv-runtime-test-'))
  temporaryRoots.push(directory)
  return directory
}

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

// A complete darwin-arm64 runtime directory.
function stageRuntimeDirectory(directory: string): string {
  writeFile(join(directory, ADDON_RELATIVE_PATH))
  writeFile(join(directory, PRESENTER_ADDON_RELATIVE_PATH))
  writeFile(join(directory, DARWIN_LIBRARY_RELATIVE_PATH))
  return directory
}

// A resource root laid out the way a packaged app ships one.
function stageResourceRoot(root: string): string {
  stageRuntimeDirectory(join(root, 'resources', 'libmpv', 'darwin-arm64'))
  return root
}

const darwinOptions = { platform: 'darwin', arch: 'arm64', env: {} } as const

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

describe('resolveLibMpvRuntime', () => {
  test('resolves the runtime directory it was handed', async () => {
    const directory = stageRuntimeDirectory(makeTemporaryDirectory())

    const runtime = await resolveLibMpvRuntime({ ...darwinOptions, runtimeDirectory: directory })

    assert.equal(runtime.available, true)
    assert.equal(runtime.runtimeDirectory, directory)
    assert.equal(runtime.addonPath, join(directory, ADDON_RELATIVE_PATH))
    assert.equal(runtime.presenterAddonPath, join(directory, PRESENTER_ADDON_RELATIVE_PATH))
    assert.equal(runtime.libraryPath, join(directory, DARWIN_LIBRARY_RELATIVE_PATH))
    assert.deepEqual(runtime.missing, [])
  })

  test('an explicitly supplied directory outranks a staged resource root', async () => {
    const explicitDirectory = stageRuntimeDirectory(makeTemporaryDirectory())
    const resourceRoot = stageResourceRoot(makeTemporaryDirectory())

    const runtime = await resolveLibMpvRuntime({
      ...darwinOptions,
      runtimeDirectory: explicitDirectory,
      resourceRoots: [resourceRoot]
    })

    assert.equal(runtime.runtimeDirectory, explicitDirectory)
  })

  test('EMPV_RUNTIME_DIR is honoured when no directory is supplied', async () => {
    const directory = stageRuntimeDirectory(makeTemporaryDirectory())

    const runtime = await resolveLibMpvRuntime({
      ...darwinOptions,
      env: { EMPV_RUNTIME_DIR: directory }
    })

    assert.equal(runtime.runtimeDirectory, directory)
  })

  test('resource roots are searched in the order they were given', async () => {
    const firstRoot = stageResourceRoot(makeTemporaryDirectory())
    const secondRoot = stageResourceRoot(makeTemporaryDirectory())

    const runtime = await resolveLibMpvRuntime({
      ...darwinOptions,
      resourceRoots: [firstRoot, secondRoot]
    })

    assert.equal(runtime.runtimeDirectory, join(firstRoot, 'resources', 'libmpv', 'darwin-arm64'))
  })

  test("a staged resource root outranks the package's own build output", async (t) => {
    const packageBuildOutput = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'dist',
      'native'
    )
    if (!existsSync(packageBuildOutput)) {
      t.skip(
        `No local build output at ${packageBuildOutput}; run "pnpm run build:native" to cover this precedence.`
      )
      return
    }

    const resourceRoot = stageResourceRoot(makeTemporaryDirectory())
    const runtime = await resolveLibMpvRuntime({ ...darwinOptions, resourceRoots: [resourceRoot] })

    assert.equal(
      runtime.runtimeDirectory,
      join(resourceRoot, 'resources', 'libmpv', 'darwin-arm64'),
      'A runtime bundled with the app must win over one left behind by a local native build.'
    )
  })

  test('reports a missing runtime directory rather than guessing', async () => {
    const runtime = await resolveLibMpvRuntime({
      ...darwinOptions,
      runtimeDirectory: join(makeTemporaryDirectory(), 'absent'),
      resourceRoots: [makeTemporaryDirectory()]
    })

    assert.equal(runtime.available, false)
    assert.deepEqual(runtime.missing, ['runtime-directory'])
    assert.equal(runtime.addonPath, null)
    assert.equal(runtime.presenterAddonPath, null)
    assert.equal(runtime.libraryPath, null)
  })

  test('names the parts that are absent from an incomplete runtime', async () => {
    const directory = makeTemporaryDirectory()
    writeFile(join(directory, DARWIN_LIBRARY_RELATIVE_PATH))
    writeFile(join(directory, PRESENTER_ADDON_RELATIVE_PATH))

    const withoutAddon = await resolveLibMpvRuntime({
      ...darwinOptions,
      runtimeDirectory: directory
    })
    assert.equal(withoutAddon.available, false)
    assert.deepEqual(withoutAddon.missing, ['native-addon'])

    const runtimeWithoutLibrary = makeTemporaryDirectory()
    writeFile(join(runtimeWithoutLibrary, ADDON_RELATIVE_PATH))
    writeFile(join(runtimeWithoutLibrary, PRESENTER_ADDON_RELATIVE_PATH))

    const withoutLibrary = await resolveLibMpvRuntime({
      ...darwinOptions,
      runtimeDirectory: runtimeWithoutLibrary
    })
    assert.equal(withoutLibrary.available, false)
    assert.deepEqual(withoutLibrary.missing, ['libmpv-library'])

    const runtimeWithoutPresenter = makeTemporaryDirectory()
    writeFile(join(runtimeWithoutPresenter, ADDON_RELATIVE_PATH))
    writeFile(join(runtimeWithoutPresenter, DARWIN_LIBRARY_RELATIVE_PATH))
    const withoutPresenter = await resolveLibMpvRuntime({
      ...darwinOptions,
      runtimeDirectory: runtimeWithoutPresenter
    })
    assert.equal(withoutPresenter.available, false)
    assert.deepEqual(withoutPresenter.missing, ['native-presenter-addon'])
  })

  test('reads the paths a runtime manifest declares', async () => {
    const directory = makeTemporaryDirectory()
    writeFile(join(directory, 'custom', 'addon.node'))
    writeFile(join(directory, 'custom', 'presenter.node'))
    writeFile(join(directory, 'custom', 'mpv.dylib'))
    writeFile(
      join(directory, 'runtime-manifest.json'),
      JSON.stringify({
        id: 'libmpv',
        files: {
          addon: 'custom/addon.node',
          presenterAddon: 'custom/presenter.node',
          library: 'custom/mpv.dylib'
        }
      })
    )

    const runtime = await resolveLibMpvRuntime({ ...darwinOptions, runtimeDirectory: directory })

    assert.equal(runtime.available, true)
    assert.equal(runtime.addonPath, join(directory, 'custom', 'addon.node'))
    assert.equal(runtime.presenterAddonPath, join(directory, 'custom', 'presenter.node'))
    assert.equal(runtime.libraryPath, join(directory, 'custom', 'mpv.dylib'))
  })
})

describe('assertLibMpvRuntime', () => {
  test('returns the runtime when it is complete', async () => {
    const directory = stageRuntimeDirectory(makeTemporaryDirectory())

    const runtime = await assertLibMpvRuntime({ ...darwinOptions, runtimeDirectory: directory })

    assert.equal(runtime.runtimeDirectory, directory)
  })

  test('throws with the resolution attached instead of returning an unusable runtime', async () => {
    const missingDirectory = join(makeTemporaryDirectory(), 'absent')

    await assert.rejects(
      () =>
        assertLibMpvRuntime({
          ...darwinOptions,
          runtimeDirectory: missingDirectory,
          resourceRoots: [makeTemporaryDirectory()]
        }),
      (error: unknown) => {
        assert.ok(error instanceof LibMpvRuntimeError)
        // The caller has to be able to tell what was missing without parsing the
        // message, and the message has to name it too.
        assert.deepEqual(error.runtime.missing, ['runtime-directory'])
        assert.match(error.message, /runtime-directory/)
        return true
      }
    )
  })
})
