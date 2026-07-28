import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dlopen } from 'node:process'

type DlopenConstants = {
  RTLD_DEEPBIND?: number
  RTLD_LOCAL: number
  RTLD_NOW: number
}

export type NativeAddonModuleLoaderDependencies = {
  dlopen(module: object, filename: string, flags?: number): void
  dlopenConstants: DlopenConstants
  platform: NodeJS.Platform
  requireAddon: NodeRequire
}

export function createNativeAddonModuleLoader(
  dependencies: NativeAddonModuleLoaderDependencies
): (addonPath: string, requireAddon?: NodeRequire) => unknown {
  const linuxAddonModuleCache = new Map<string, unknown>()

  return (addonPath, requireAddon) => {
    if (requireAddon) {
      return requireAddon(addonPath)
    }

    if (dependencies.platform !== 'linux') {
      return dependencies.requireAddon(addonPath)
    }

    if (linuxAddonModuleCache.has(addonPath)) {
      return linuxAddonModuleCache.get(addonPath)
    }

    // Electron's utility process already has Chromium's FFmpeg libraries in its
    // global symbol scope. A normal require() can therefore bind system libmpv
    // to ABI-incompatible libav* symbols from Electron and hang inside
    // mpv_initialize. Linux must load the addon and its dependency group ahead
    // of that global scope. Failing loudly when the GNU loader flag is
    // unavailable is safer than silently returning to the process-corrupting
    // load mode.
    const deepBind = dependencies.dlopenConstants.RTLD_DEEPBIND
    if (typeof deepBind !== 'number') {
      throw new Error(
        `Cannot load the libmpv native addon at ${addonPath}: ` +
          'this Linux runtime does not expose RTLD_DEEPBIND for dependency isolation.'
      )
    }

    const addonModule: { exports: unknown } = { exports: {} }
    const flags =
      dependencies.dlopenConstants.RTLD_NOW | dependencies.dlopenConstants.RTLD_LOCAL | deepBind

    try {
      dependencies.dlopen(addonModule, addonPath, flags)
    } catch (cause) {
      throw new Error(
        `Failed to load the libmpv native addon at ${addonPath} ` +
          'with Linux dependency isolation.',
        { cause }
      )
    }

    linuxAddonModuleCache.set(addonPath, addonModule.exports)
    return addonModule.exports
  }
}

export const loadNativeAddonModule = createNativeAddonModuleLoader({
  dlopen,
  dlopenConstants: osConstants.dlopen,
  platform: process.platform,
  requireAddon: createRequire(import.meta.url)
})
