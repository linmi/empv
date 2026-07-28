const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  copyRuntimeToNativeBuild,
  copyFileOrSymlink,
  findLibMpv,
  hasRequiredMacosAudioOutputBackend,
  hasRequiredMacosAudioRuntimePolicy,
  patchAddonForBundledRuntime,
  validateMacosPresenterAddon,
  validateNoForbiddenRuntimeLinks
} = require('./packaging/embedded-mpv-packaging.cjs')

const packageRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(packageRoot, '..', '..')
const addonRoot = path.join(packageRoot, 'native')
const presenterAddonRoot = path.join(addonRoot, 'presenter')
const outputDir = path.join(addonRoot, 'build', 'Release')
const outputFile = path.join(outputDir, 'empv.node')
const presenterOutputFile = path.join(outputDir, 'empv_presenter.node')
const outputLibDir = path.join(outputDir, 'lib')
const distNativeDir = path.join(packageRoot, 'dist', 'native')
const unavailableMarkerFile = path.join(outputDir, 'embedded-mpv-unavailable.txt')
const homebrewIncludeDir = '/opt/homebrew/include'
const homebrewLibDir = '/opt/homebrew/lib'
const targetPlatform = process.env.EMPV_PLATFORM || process.platform
const targetArch = process.env.EMPV_ARCH || process.env.npm_config_arch || process.arch
const vendoredRuntimeRoot = path.join(
  packageRoot,
  'vendor',
  'embedded-mpv',
  `${targetPlatform}-${targetArch}`
)
const vendoredIncludeDir = path.join(vendoredRuntimeRoot, 'include')
const vendoredLibDir = path.join(vendoredRuntimeRoot, 'lib')
const vendoredBinDir = path.join(vendoredRuntimeRoot, 'bin')
const homebrewFallbackEnabled = process.env.EMPV_ALLOW_HOMEBREW === '1'
const embeddedMpvRequired = ['1', 'true', 'yes', 'on'].includes(
  (process.env.EMPV_REQUIRE ?? '').trim().toLowerCase()
)

function log(message) {
  process.stdout.write(`[embedded-mpv] ${message}\n`)
}

function cleanWindowsOutputRuntimeDlls() {
  if (!fs.existsSync(outputDir)) {
    return
  }
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry.toLowerCase().endsWith('.dll')) {
      fs.rmSync(path.join(outputDir, entry), { force: true })
    }
  }
}

function cleanOutput() {
  fs.rmSync(outputFile, { force: true })
  fs.rmSync(presenterOutputFile, { force: true })
  if (fs.existsSync(outputDir)) {
    for (const entry of fs.readdirSync(outputDir)) {
      if (/^empv\..+\.node$/.test(entry)) {
        fs.rmSync(path.join(outputDir, entry), { force: true })
      }
    }
  }
  fs.rmSync(outputLibDir, { recursive: true, force: true })
  cleanWindowsOutputRuntimeDlls()
  fs.rmSync(path.join(outputDir, '.deps'), { recursive: true, force: true })
  fs.rmSync(path.join(outputDir, 'obj.target'), {
    recursive: true,
    force: true
  })
  fs.rmSync(path.join(outputDir, 'runtime-manifest.json'), {
    force: true
  })
  fs.writeFileSync(
    unavailableMarkerFile,
    'Embedded MPV native runtime is not available for this build.\n'
  )
}

function cleanDistNativeOutput() {
  fs.rmSync(distNativeDir, { recursive: true, force: true })
}

function readRuntimeManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    return {}
  }

  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function fileExists(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
}

function listRuntimeFiles(runtimeDir, predicate) {
  if (!runtimeDir || !fs.existsSync(runtimeDir)) {
    return []
  }

  return fs
    .readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.join(runtimeDir, entry.name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile()
      } catch {
        return false
      }
    })
    .filter(predicate)
    .sort()
}

function runtimeFilePredicate(filePath) {
  const fileName = path.basename(filePath)

  switch (targetPlatform) {
    case 'darwin':
      return fileName.endsWith('.dylib')
    case 'win32':
      return fileName.endsWith('.dll') || fileName.endsWith('.lib')
    case 'linux':
      return /\.so(?:\.\d+)*$/.test(fileName)
    default:
      return false
  }
}

function findWindowsImportLib(libDir) {
  for (const candidate of ['mpv.lib', 'mpv-2.lib']) {
    const candidatePath = path.join(libDir, candidate)
    if (fileExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

function findWindowsLibMpv(runtimeRoot) {
  for (const candidate of [
    path.join(runtimeRoot, 'lib', 'libmpv-2.dll'),
    path.join(runtimeRoot, 'bin', 'libmpv-2.dll'),
    path.join(runtimeRoot, 'lib', 'mpv-2.dll'),
    path.join(runtimeRoot, 'bin', 'mpv-2.dll'),
    path.join(runtimeRoot, 'lib', 'libmpv.dll'),
    path.join(runtimeRoot, 'bin', 'libmpv.dll'),
    path.join(runtimeRoot, 'lib', 'mpv.dll'),
    path.join(runtimeRoot, 'bin', 'mpv.dll')
  ]) {
    if (fileExists(candidate)) {
      return candidate
    }
  }

  return null
}

function findLinuxLibMpv(libDir) {
  for (const candidate of ['libmpv.so.2', 'libmpv.so.1', 'libmpv.so']) {
    const candidatePath = path.join(libDir, candidate)
    if (fileExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

function resolveRuntime() {
  const vendoredLibMpv =
    targetPlatform === 'darwin'
      ? findLibMpv(vendoredLibDir)
      : targetPlatform === 'win32'
        ? findWindowsLibMpv(vendoredRuntimeRoot)
        : targetPlatform === 'linux'
          ? findLinuxLibMpv(vendoredLibDir)
          : null
  const vendoredHeader = path.join(vendoredIncludeDir, 'mpv', 'client.h')

  if (vendoredLibMpv && fs.existsSync(vendoredHeader)) {
    const windowsImportLib =
      targetPlatform === 'win32' ? findWindowsImportLib(vendoredLibDir) : null
    if (targetPlatform === 'win32' && !windowsImportLib) {
      return null
    }

    return {
      origin: 'vendored-lgpl',
      includeDir: vendoredIncludeDir,
      libDir: vendoredLibDir,
      binDir: vendoredBinDir,
      manifest: readRuntimeManifest(vendoredRuntimeRoot),
      windowsImportLib
    }
  }

  if (targetPlatform === 'darwin' && homebrewFallbackEnabled) {
    const homebrewLibMpv = findLibMpv(homebrewLibDir)
    const homebrewHeader = path.join(homebrewIncludeDir, 'mpv', 'client.h')
    if (homebrewLibMpv && fs.existsSync(homebrewHeader)) {
      log(
        'Using Homebrew libmpv as a development-only fallback. Release packaging will reject this runtime.'
      )
      return {
        origin: 'homebrew-dev',
        includeDir: homebrewIncludeDir,
        libDir: homebrewLibDir,
        binDir: undefined,
        manifest: {
          warning: 'Development-only runtime. Do not ship this in release artifacts.'
        },
        windowsImportLib: null
      }
    }
  }

  return null
}

function copyFile(sourcePath, destinationPath) {
  copyFileOrSymlink(sourcePath, destinationPath)
}

function copyGenericRuntimeToNativeBuild(runtime) {
  fs.rmSync(outputLibDir, { recursive: true, force: true })
  fs.mkdirSync(outputLibDir, { recursive: true })
  if (targetPlatform === 'win32') {
    cleanWindowsOutputRuntimeDlls()
  }

  const runtimeFiles = [
    ...listRuntimeFiles(runtime.libDir, runtimeFilePredicate),
    ...listRuntimeFiles(runtime.binDir, runtimeFilePredicate)
  ]
  const copiedFiles = new Set()

  for (const runtimeFile of runtimeFiles) {
    const fileName = path.basename(runtimeFile)
    if (copiedFiles.has(fileName)) {
      continue
    }
    copyFile(runtimeFile, path.join(outputLibDir, fileName))
    copiedFiles.add(fileName)
  }

  if (targetPlatform === 'win32') {
    for (const fileName of copiedFiles) {
      if (fileName.endsWith('.dll')) {
        copyFile(path.join(outputLibDir, fileName), path.join(outputDir, fileName))
      }
    }
  }

  if (targetPlatform === 'linux') {
    const libMpvPath = findLinuxLibMpv(outputLibDir)
    if (libMpvPath && path.basename(libMpvPath) !== 'libmpv.so') {
      copyFile(libMpvPath, path.join(outputLibDir, 'libmpv.so'))
      copiedFiles.add('libmpv.so')
    }
  }

  const manifest = {
    ...runtime.manifest,
    origin: runtime.origin,
    generatedAt: new Date().toISOString(),
    libDir: 'lib',
    runtimeFiles: [...copiedFiles].sort(),
    platform: targetPlatform,
    targetArch
  }

  fs.writeFileSync(
    path.join(outputDir, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )

  return manifest
}

function resolveNapiCliBin() {
  const napiPackageJsonPath = require.resolve('@napi-rs/cli/package.json', {
    paths: [packageRoot, workspaceRoot]
  })
  const napiPackageJson = require(napiPackageJsonPath)
  return path.resolve(path.dirname(napiPackageJsonPath), napiPackageJson.bin.napi)
}

function resolveRustTarget() {
  const targetKey = `${targetPlatform}-${targetArch}`
  const rustTargets = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc'
  }
  const rustTarget = rustTargets[targetKey]
  if (!rustTarget) {
    throw new Error(`Unsupported Rust target for Embedded MPV: ${targetKey}.`)
  }
  return rustTarget
}

function runNapiBuild(env, build) {
  const napiCliBin = resolveNapiCliBin()
  const rustTarget = resolveRustTarget()
  const result = spawnSync(
    process.execPath,
    [
      napiCliBin,
      'build',
      '--release',
      '--target',
      rustTarget,
      '--cwd',
      build.root,
      '--manifest-path',
      build.manifestPath,
      '--package-json-path',
      build.packageJsonPath,
      '--output-dir',
      outputDir
    ],
    {
      cwd: workspaceRoot,
      env,
      stdio: 'inherit'
    }
  )

  if (result.status !== 0) {
    throw new Error(`napi build failed with status ${result.status ?? 1}.`)
  }

  const suffixedOutputs = fs
    .readdirSync(outputDir)
    .filter((entry) => /^empv\..+\.node$/.test(entry))
  if (suffixedOutputs.length > 0) {
    throw new Error(
      `napi build produced forbidden platform-suffixed output: ${suffixedOutputs.join(', ')}.`
    )
  }
}

function recordNativeRolesInManifest() {
  const manifestPath = path.join(outputDir, 'runtime-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.files = {
    ...manifest.files,
    addon: 'empv.node',
    ...(targetPlatform === 'darwin' ? { presenterAddon: 'empv_presenter.node' } : {})
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  cleanDistNativeOutput()

  if (targetPlatform !== process.platform) {
    cleanOutput()
    if (embeddedMpvRequired) {
      throw new Error(
        `Embedded MPV is required for ${targetPlatform}-${targetArch}, but this host is ${process.platform}-${process.arch}.`
      )
    }
    log(
      `Skipping build for ${targetPlatform}-${targetArch} on ${process.platform}-${process.arch}.`
    )
    return
  }

  const runtime = resolveRuntime()
  if (!runtime) {
    cleanOutput()
    const message = [
      `Skipping build because no embedded MPV runtime was found for ${targetPlatform}-${targetArch}.`,
      `Expected vendored runtime at ${vendoredRuntimeRoot}.`,
      targetPlatform === 'darwin'
        ? 'For local development only, set EMPV_ALLOW_HOMEBREW=1 to use Homebrew libmpv.'
        : 'Stage a vendored LGPL-compatible runtime before requiring Embedded MPV on this platform.'
    ].join('\n')
    if (embeddedMpvRequired) {
      throw new Error(message)
    }

    log(message)
    return
  }

  if (
    targetPlatform === 'darwin' &&
    runtime.origin === 'vendored-lgpl' &&
    !hasRequiredMacosAudioRuntimePolicy(runtime.manifest)
  ) {
    throw new Error(
      [
        'The staged macOS libmpv runtime still includes the crash-prone CoreAudio hotplug path.',
        'Rebuild and stage it with AVFoundation enabled and CoreAudio disabled.'
      ].join('\n')
    )
  }

  const runtimeManifest =
    targetPlatform === 'darwin'
      ? copyRuntimeToNativeBuild({
          runtimeLibDir: runtime.libDir,
          outputLibDir,
          runtimeOrigin: runtime.origin,
          runtimeManifest: {
            targetArch,
            ...runtime.manifest
          }
        })
      : copyGenericRuntimeToNativeBuild(runtime)
  fs.rmSync(unavailableMarkerFile, { force: true })

  const env = {
    ...process.env,
    LIBMPV_INCLUDE_DIR: runtime.includeDir,
    LIBMPV_LIBRARY_DIR: outputLibDir,
    ...(runtime.windowsImportLib
      ? { LIBMPV_IMPORT_LIB: path.join(outputLibDir, path.basename(runtime.windowsImportLib)) }
      : {})
  }

  log(
    `Building Rust native addon using ${runtime.origin} runtime for ${targetPlatform}-${targetArch}...`
  )
  runNapiBuild(env, {
    root: addonRoot,
    manifestPath: path.join(addonRoot, 'Cargo.toml'),
    packageJsonPath: path.join(packageRoot, 'package.json')
  })

  if (!fs.existsSync(outputFile)) {
    throw new Error(`Build finished without producing ${outputFile}.`)
  }

  if (targetPlatform === 'darwin') {
    log('Building the libmpv-free macOS presenter addon...')
    runNapiBuild(env, {
      root: presenterAddonRoot,
      manifestPath: path.join(presenterAddonRoot, 'Cargo.toml'),
      packageJsonPath: path.join(presenterAddonRoot, 'package.json')
    })
    if (!fs.existsSync(presenterOutputFile)) {
      throw new Error(`Build finished without producing ${presenterOutputFile}.`)
    }
    const presenterIsolationErrors = validateMacosPresenterAddon(presenterOutputFile)
    if (presenterIsolationErrors.length > 0) {
      throw new Error(presenterIsolationErrors.join('\n'))
    }

    if (!hasRequiredMacosAudioOutputBackend(outputFile)) {
      throw new Error(
        `Built native addon is missing the required AVFoundation audio backend policy: ${outputFile}`
      )
    }

    patchAddonForBundledRuntime(outputFile, outputLibDir)
    const forbiddenLinkErrors = validateNoForbiddenRuntimeLinks([
      outputFile,
      ...runtimeManifest.dylibs.map((dylib) => path.join(outputLibDir, dylib))
    ])
    if (runtime.origin === 'vendored-lgpl' && forbiddenLinkErrors.length > 0) {
      throw new Error(forbiddenLinkErrors.join('\n'))
    }
  }

  recordNativeRolesInManifest()
  log(`Built ${path.relative(workspaceRoot, outputFile)}.`)
  fs.rmSync(distNativeDir, { recursive: true, force: true })
  fs.mkdirSync(distNativeDir, { recursive: true })
  fs.cpSync(outputDir, distNativeDir, {
    dereference: false,
    recursive: true,
    verbatimSymlinks: true
  })
  log(`Copied native output to ${path.relative(workspaceRoot, distNativeDir)}.`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[embedded-mpv] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
