import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type LibMpvRuntimePlatform = NodeJS.Platform
export type LibMpvRuntimeArch = NodeJS.Architecture

export type LibMpvRuntimeMissingPart = 'runtime-directory' | 'native-addon' | 'libmpv-library'

export type LibMpvRuntimeManifest = {
  id?: 'libmpv' | string
  version?: string
  platform?: string
  arch?: string
  libmpvVersion?: string
  license?: string
  mpv?: {
    mesonFlags?: string[]
  }
  files?: {
    addon?: string
    include?: string
    library?: string
    libraries?: string[]
  }
}

export type ResolvedLibMpvRuntime = {
  addonPath: string | null
  arch: LibMpvRuntimeArch
  available: boolean
  includeDirectory: string | null
  libraryPath: string | null
  manifest: LibMpvRuntimeManifest | null
  manifestPath: string | null
  missing: LibMpvRuntimeMissingPart[]
  platform: LibMpvRuntimePlatform
  platformKey: string
  runtimeDirectory: string | null
}

export type LibMpvRuntime = ResolvedLibMpvRuntime & {
  addonPath: string
  available: true
  libraryPath: string
  runtimeDirectory: string
}

export type LibMpvRuntimeResolveOptions = {
  arch?: LibMpvRuntimeArch
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: LibMpvRuntimePlatform
  resourceRoots?: string[]
  runtimeDirectory?: string | null
}

export const LIBMPV_RUNTIME_DIRECTORY_NAME = 'libmpv'
export const LIBMPV_NATIVE_ADDON_NAME = 'embedded_mpv.node'

const RUNTIME_MANIFEST_FILE_NAME = 'runtime-manifest.json'
const ENV_RUNTIME_DIRECTORY = 'EMPV_RUNTIME_DIR'
const ENV_ADDON_PATH = 'EMPV_ADDON_PATH'
const ENV_LIBRARY_PATH = 'EMPV_LIBRARY_PATH'
const ENV_RESOURCE_ROOT = 'EMPV_RESOURCE_ROOT'

export class LibMpvRuntimeError extends Error {
  readonly runtime: ResolvedLibMpvRuntime

  constructor(runtime: ResolvedLibMpvRuntime) {
    super(`Missing libmpv runtime: ${runtime.missing.join(', ')}.`)
    this.name = 'LibMpvRuntimeError'
    this.runtime = runtime
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    if (!value) {
      continue
    }

    const normalizedValue = resolve(value)

    if (!seen.has(normalizedValue)) {
      seen.add(normalizedValue)
      result.push(normalizedValue)
    }
  }

  return result
}

function getPathAncestors(startPath: string): string[] {
  const ancestors: string[] = []
  let currentPath = resolve(startPath)

  while (!ancestors.includes(currentPath)) {
    ancestors.push(currentPath)

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      break
    }

    currentPath = parentPath
  }

  return ancestors
}

function firstExistingPath(paths: Array<string | null | undefined>): string | null {
  for (const path of paths) {
    if (path && existsSync(path)) {
      return resolve(path)
    }
  }

  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  return value
}

function resolveRuntimePath(runtimeDirectory: string, path: string): string {
  return isAbsolute(path) ? path : join(runtimeDirectory, path)
}

function getProcessResourcesPath(): string | null {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: unknown }

  return typeof processWithResources.resourcesPath === 'string'
    ? processWithResources.resourcesPath
    : null
}

function getDefaultResourceRoots(
  options: Required<Pick<LibMpvRuntimeResolveOptions, 'cwd'>>
): string[] {
  const rootSeeds = unique([options.cwd, process.cwd(), getProcessResourcesPath()])
  const roots = new Set<string>()

  for (const seed of rootSeeds) {
    roots.add(seed)

    for (const ancestor of getPathAncestors(seed)) {
      roots.add(ancestor)
    }
  }

  return Array.from(roots)
}

function getManifestFilePath(runtimeDirectory: string): string | null {
  return firstExistingPath([join(runtimeDirectory, RUNTIME_MANIFEST_FILE_NAME)])
}

async function readRuntimeManifest(
  manifestPath: string | null
): Promise<LibMpvRuntimeManifest | null> {
  if (!manifestPath) {
    return null
  }

  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown

    return isObject(parsed) ? (parsed as LibMpvRuntimeManifest) : null
  } catch {
    return null
  }
}

function getManifestRelativePath(
  manifest: LibMpvRuntimeManifest | null,
  key: keyof NonNullable<LibMpvRuntimeManifest['files']>
): string | null {
  return toRelativePath(manifest?.files?.[key])
}

function getManifestRelativePaths(
  manifest: LibMpvRuntimeManifest | null,
  key: keyof NonNullable<LibMpvRuntimeManifest['files']>
): string[] {
  const value = manifest?.files?.[key]

  if (!Array.isArray(value)) {
    const path = toRelativePath(value)
    return path ? [path] : []
  }

  return value.flatMap((item) => {
    const path = toRelativePath(item)
    return path ? [path] : []
  })
}

export function getLibMpvPlatformKey(
  platform: LibMpvRuntimePlatform = process.platform,
  arch: LibMpvRuntimeArch = process.arch
): string {
  return `${platform}-${arch}`
}

export function getLibMpvLibraryFileNames(
  platform: LibMpvRuntimePlatform = process.platform
): string[] {
  if (platform === 'darwin') {
    return ['libmpv.dylib', 'libmpv.2.dylib', 'libmpv.1.dylib']
  }

  if (platform === 'win32') {
    return ['libmpv-2.dll', 'mpv-2.dll', 'libmpv.dll', 'mpv.dll']
  }

  return ['libmpv.so', 'libmpv.so.2', 'libmpv.so.1']
}

function getAddonCandidatePaths(
  runtimeDirectory: string,
  manifest: LibMpvRuntimeManifest | null,
  env: NodeJS.ProcessEnv
): string[] {
  const manifestAddonPath = getManifestRelativePath(manifest, 'addon')

  return unique([
    env[ENV_ADDON_PATH],
    manifestAddonPath ? resolveRuntimePath(runtimeDirectory, manifestAddonPath) : null,
    join(runtimeDirectory, 'addon', LIBMPV_NATIVE_ADDON_NAME),
    join(runtimeDirectory, 'native', LIBMPV_NATIVE_ADDON_NAME),
    join(runtimeDirectory, LIBMPV_NATIVE_ADDON_NAME)
  ])
}

function getLibraryCandidatePaths(
  runtimeDirectory: string,
  platform: LibMpvRuntimePlatform,
  manifest: LibMpvRuntimeManifest | null,
  env: NodeJS.ProcessEnv
): string[] {
  const manifestLibraryPath = getManifestRelativePath(manifest, 'library')
  const manifestLibraryPaths = getManifestRelativePaths(manifest, 'libraries')
  const libraryFileNames = getLibMpvLibraryFileNames(platform)

  return unique([
    env[ENV_LIBRARY_PATH],
    manifestLibraryPath ? resolveRuntimePath(runtimeDirectory, manifestLibraryPath) : null,
    ...manifestLibraryPaths.map((path) => resolveRuntimePath(runtimeDirectory, path)),
    ...libraryFileNames.map((fileName) => join(runtimeDirectory, 'lib', fileName)),
    ...libraryFileNames.map((fileName) => join(runtimeDirectory, fileName))
  ])
}

function getIncludeDirectory(
  runtimeDirectory: string,
  manifest: LibMpvRuntimeManifest | null
): string | null {
  const manifestIncludePath = getManifestRelativePath(manifest, 'include')

  return firstExistingPath([
    manifestIncludePath ? resolveRuntimePath(runtimeDirectory, manifestIncludePath) : null,
    existsSync(join(runtimeDirectory, 'include', 'mpv', 'client.h'))
      ? join(runtimeDirectory, 'include')
      : null,
    existsSync(join(runtimeDirectory, 'include', 'client.h'))
      ? join(runtimeDirectory, 'include')
      : null
  ])
}

// The package root, whether this module runs from `src/` (sources) or `dist/`
// (published build). Both sit exactly one level under it.
function getPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function getPackageBuildOutputCandidates(): string[] {
  const packageRoot = getPackageRoot()

  return [join(packageRoot, 'dist', 'native'), join(packageRoot, 'native', 'build', 'Release')]
}

function getRuntimeDirectoryCandidates(
  options: Required<Pick<LibMpvRuntimeResolveOptions, 'cwd' | 'env'>> &
    Pick<LibMpvRuntimeResolveOptions, 'resourceRoots' | 'runtimeDirectory'>,
  platformKey: string
): string[] {
  // A caller that names a runtime directory -- through the option or through
  // EMPV_RUNTIME_DIR -- has said which runtime to use. If it is not there, that
  // is a packaging or configuration error and it must surface as one. Searching
  // on would quietly substitute a different runtime: on a developer machine that
  // is a stale local build, in a shipped app it is whatever else happens to be
  // on the filesystem, and either way the caller is told everything is fine.
  const pinnedDirectory = options.runtimeDirectory ?? options.env[ENV_RUNTIME_DIRECTORY]
  if (pinnedDirectory) {
    return unique([pinnedDirectory])
  }

  const roots = unique([
    ...(options.resourceRoots ?? []),
    options.env[ENV_RESOURCE_ROOT],
    ...getDefaultResourceRoots({ cwd: options.cwd })
  ])

  return unique([
    ...roots.flatMap((root) => [
      join(root, LIBMPV_RUNTIME_DIRECTORY_NAME, platformKey),
      join(root, LIBMPV_RUNTIME_DIRECTORY_NAME),
      join(root, 'resources', LIBMPV_RUNTIME_DIRECTORY_NAME, platformKey),
      join(root, 'resources', LIBMPV_RUNTIME_DIRECTORY_NAME)
    ]),
    // This package's own build output, resolved from the module rather than from
    // the caller's layout: `build:native` writes here whether the package sits in
    // a workspace or under a consumer's node_modules. Last, so a bundled release
    // runtime always wins over a locally built one.
    ...getPackageBuildOutputCandidates()
  ])
}

export async function resolveLibMpvRuntime(
  options: LibMpvRuntimeResolveOptions = {}
): Promise<ResolvedLibMpvRuntime> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const platformKey = getLibMpvPlatformKey(platform, arch)
  const explicitAddonPath = firstExistingPath([env[ENV_ADDON_PATH]])
  const explicitLibraryPath = firstExistingPath([env[ENV_LIBRARY_PATH]])
  const runtimeDirectory =
    firstExistingPath(getRuntimeDirectoryCandidates({ ...options, cwd, env }, platformKey)) ??
    (explicitAddonPath && explicitLibraryPath ? dirname(explicitAddonPath) : null)
  const missing: LibMpvRuntimeMissingPart[] = []
  let manifestPath: string | null = null
  let manifest: LibMpvRuntimeManifest | null = null
  let addonPath: string | null = null
  let libraryPath: string | null = null
  let includeDirectory: string | null = null

  if (!runtimeDirectory) {
    missing.push('runtime-directory')
  } else {
    manifestPath = getManifestFilePath(runtimeDirectory)
    manifest = await readRuntimeManifest(manifestPath)
    addonPath = firstExistingPath(getAddonCandidatePaths(runtimeDirectory, manifest, env))
    libraryPath = firstExistingPath(
      getLibraryCandidatePaths(runtimeDirectory, platform, manifest, env)
    )
    includeDirectory = getIncludeDirectory(runtimeDirectory, manifest)

    if (!addonPath) {
      missing.push('native-addon')
    }

    if (!libraryPath) {
      missing.push('libmpv-library')
    }
  }

  return {
    addonPath,
    arch,
    available: missing.length === 0,
    includeDirectory,
    libraryPath,
    manifest,
    manifestPath,
    missing,
    platform,
    platformKey,
    runtimeDirectory
  }
}

export async function assertLibMpvRuntime(
  options: LibMpvRuntimeResolveOptions = {}
): Promise<LibMpvRuntime> {
  const runtime = await resolveLibMpvRuntime(options)

  if (
    !runtime.available ||
    !runtime.runtimeDirectory ||
    !runtime.addonPath ||
    !runtime.libraryPath
  ) {
    throw new LibMpvRuntimeError(runtime)
  }

  return runtime as LibMpvRuntime
}
