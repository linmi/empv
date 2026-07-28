import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'

import {
  createNativeAddonModuleLoader,
  type NativeAddonModuleLoaderDependencies
} from '../src/nativeAddonLoader.ts'

function makeRequire(load: (addonPath: string) => unknown): NodeRequire {
  return Object.assign(load, createRequire(import.meta.url))
}

function makeDependencies(
  overrides: Partial<NativeAddonModuleLoaderDependencies> = {}
): NativeAddonModuleLoaderDependencies {
  return {
    dlopen: () => {
      throw new Error('Unexpected dlopen call.')
    },
    dlopenConstants: {
      RTLD_DEEPBIND: 4,
      RTLD_LOCAL: 2,
      RTLD_NOW: 1
    },
    platform: 'linux',
    requireAddon: makeRequire(() => {
      throw new Error('Unexpected require call.')
    }),
    ...overrides
  }
}

describe('createNativeAddonModuleLoader', () => {
  test('deep-binds Linux addon dependencies and initializes each path once', () => {
    const addon = { name: 'empv' }
    const dlopenCalls: Array<{ filename: string; flags: number | undefined }> = []
    const load = createNativeAddonModuleLoader(
      makeDependencies({
        dlopen(module, filename, flags) {
          dlopenCalls.push({ filename, flags })
          const addonModule = module as { exports: unknown }
          addonModule.exports = addon
        }
      })
    )

    assert.strictEqual(load('/runtime/empv.node'), addon)
    assert.strictEqual(load('/runtime/empv.node'), addon)
    assert.deepEqual(dlopenCalls, [{ filename: '/runtime/empv.node', flags: 7 }])
  })

  test('refuses Linux loading when dependency isolation is unavailable', () => {
    let dlopenCalled = false
    const load = createNativeAddonModuleLoader(
      makeDependencies({
        dlopen() {
          dlopenCalled = true
        },
        dlopenConstants: {
          RTLD_LOCAL: 2,
          RTLD_NOW: 1
        }
      })
    )

    assert.throws(
      () => load('/runtime/empv.node'),
      /does not expose RTLD_DEEPBIND for dependency isolation/
    )
    assert.equal(dlopenCalled, false)
  })

  test('attributes a Linux dlopen failure to the addon path and preserves its cause', () => {
    const cause = new Error('unresolved symbol av_frame_alloc')
    const load = createNativeAddonModuleLoader(
      makeDependencies({
        dlopen() {
          throw cause
        }
      })
    )

    assert.throws(
      () => load('/runtime/empv.node'),
      (error) =>
        error instanceof Error &&
        error.message.includes('/runtime/empv.node') &&
        error.message.includes('Linux dependency isolation') &&
        error.cause === cause
    )
  })

  test('keeps the native require loader on non-Linux platforms', () => {
    const requiredPaths: string[] = []
    const addon = { name: 'empv' }
    const load = createNativeAddonModuleLoader(
      makeDependencies({
        platform: 'darwin',
        requireAddon: makeRequire((addonPath) => {
          requiredPaths.push(addonPath)
          return addon
        })
      })
    )

    assert.strictEqual(load('/runtime/empv.node'), addon)
    assert.deepEqual(requiredPaths, ['/runtime/empv.node'])
  })

  test('honours an explicit loader without entering the platform strategy', () => {
    const requiredPaths: string[] = []
    const addon = { name: 'fake-empv' }
    const load = createNativeAddonModuleLoader(
      makeDependencies({
        dlopenConstants: {
          RTLD_LOCAL: 2,
          RTLD_NOW: 1
        }
      })
    )

    assert.strictEqual(
      load(
        '/fake/empv.node',
        makeRequire((addonPath) => {
          requiredPaths.push(addonPath)
          return addon
        })
      ),
      addon
    )
    assert.deepEqual(requiredPaths, ['/fake/empv.node'])
  })
})
