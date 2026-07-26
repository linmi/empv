#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 构建脚本：console 是其面向终端的输出通道 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import {
  applyMpvPatches,
  commandExists,
  downloadSources,
  ensureTools,
  log,
  packagesMetadata,
  run,
  sourceMetadata
} from './runtime-build-core.mjs'
import { mpvPatchesByPlatform, mpvSource, runtimeBuildRoot } from './runtime-pins.mjs'

const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const [arch, rawPrefix] = args
const validArchitectures = new Set(['arm64', 'x64'])
const macosDeploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET ?? '11.0'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const patchesDir = path.join(scriptDir, 'patches')

const sourcePackages = [
  {
    id: 'freetype',
    version: '2.13.3',
    url: 'https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz',
    license: 'FreeType License or GPL-2.0-or-later'
  },
  {
    id: 'fribidi',
    version: '1.0.16',
    url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz',
    license: 'LGPL-2.1-or-later'
  },
  {
    id: 'harfbuzz',
    version: '8.5.0',
    url: 'https://github.com/harfbuzz/harfbuzz/releases/download/8.5.0/harfbuzz-8.5.0.tar.xz',
    license: 'MIT'
  },
  {
    id: 'libass',
    version: '0.17.3',
    url: 'https://github.com/libass/libass/releases/download/0.17.3/libass-0.17.3.tar.xz',
    license: 'ISC'
  },
  {
    id: 'ffmpeg',
    version: '8.1',
    url: 'https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz',
    license: 'LGPL-compatible configuration'
  },
  {
    id: 'libplacebo',
    version: '7.360.1',
    tag: 'v7.360.1',
    gitUrl: 'https://github.com/haasn/libplacebo.git',
    license: 'LGPL-2.1-or-later'
  },
  mpvSource
]

if (process.platform !== 'darwin') {
  console.error('Embedded MPV runtime builds are supported on macOS only.')
  process.exit(1)
}

if (!validArchitectures.has(arch) || !rawPrefix) {
  console.error(
    [
      'Usage: pnpm --filter empv build-runtime:macos -- <arm64|x64> <output-prefix>',
      '',
      'Builds a pinned LGPL-compatible macOS libmpv runtime from source.'
    ].join('\n')
  )
  process.exit(1)
}

// Nothing here cross-compiles: every package is configured for the host and the
// arch argument only chooses the build root and the label on the manifest. Asked
// for x64 on an Apple Silicon runner it would happily produce arm64 binaries,
// stage them under darwin-x64, and the mismatch would not surface until a user
// on an Intel Mac installed the prebuilt and got "mach-o file, but is an
// incompatible architecture" out of dlopen. Refuse at the top instead.
if (arch !== process.arch) {
  console.error(
    `Cannot build a ${arch} runtime on a ${process.arch} host: this script configures ` +
      'every package for the host machine and does not cross-compile. Build each ' +
      'architecture on a machine of that architecture.'
  )
  process.exit(1)
}

const prefix = path.resolve(rawPrefix)
const buildRoot = runtimeBuildRoot(arch)
const archiveRoot = path.join(buildRoot, 'archives')
const sourceRoot = path.join(buildRoot, 'sources')
const packageById = new Map(sourcePackages.map((source) => [source.id, source]))
const parallelism = process.env.MAKEFLAGS?.match(/-j\s*(\d+)/)?.[1] ?? String(os.cpus().length)

const ffmpegConfigureFlags = [
  `--prefix=${prefix}`,
  '--enable-shared',
  '--disable-static',
  '--disable-doc',
  '--disable-debug',
  '--disable-programs',
  '--disable-autodetect',
  '--disable-gpl',
  '--disable-nonfree',
  '--enable-pic',
  '--enable-securetransport',
  '--enable-audiotoolbox',
  '--enable-videotoolbox'
]

const mpvMesonFlags = [
  '-Dgpl=false',
  '-Dlibmpv=true',
  '-Dcplayer=false',
  '-Dbuild-date=false',
  '-Dtests=false',
  '-Dlua=disabled',
  '-Djavascript=disabled',
  '-Dcplugins=disabled',
  '-Dmanpage-build=disabled',
  '-Dhtml-build=disabled',
  '-Dpdf-build=disabled',
  '-Dlibarchive=disabled',
  '-Dlibbluray=disabled',
  '-Ddvdnav=disabled',
  '-Dcdda=disabled',
  '-Ddvbin=disabled',
  '-Djpeg=disabled',
  '-Dlcms2=disabled',
  '-Drubberband=disabled',
  '-Duchardet=disabled',
  '-Dzimg=disabled',
  '-Dvulkan=disabled',
  '-Dshaderc=disabled',
  '-Dspirv-cross=disabled',
  '-Dcocoa=disabled',
  '-Dgl-cocoa=disabled',
  '-Dmacos-cocoa-cb=disabled',
  '-Dswift-build=disabled',
  '-Davfoundation=enabled',
  '-Dcoreaudio=disabled',
  '-Dplain-gl=enabled',
  // Zero-copy VideoToolbox<->OpenGL interop (hwdec_mac_gl.c). Requires the
  // videotoolbox-gl-without-cocoa patch; enabled (not auto) so a regression that
  // drops the interop fails the build loudly instead of silently disabling it.
  '-Dvideotoolbox-gl=enabled'
]

function buildEnv() {
  const pkgConfigDirs = [
    path.join(prefix, 'lib', 'pkgconfig'),
    path.join(prefix, 'share', 'pkgconfig')
  ].join(path.delimiter)

  return {
    ...process.env,
    PATH: [path.join(prefix, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
    PKG_CONFIG_PATH: pkgConfigDirs,
    PKG_CONFIG_LIBDIR: pkgConfigDirs,
    CMAKE_PREFIX_PATH: prefix,
    DYLD_LIBRARY_PATH: path.join(prefix, 'lib'),
    MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget,
    CFLAGS: [`-I${path.join(prefix, 'include')}`, process.env.CFLAGS].filter(Boolean).join(' '),
    LDFLAGS: [`-L${path.join(prefix, 'lib')}`, process.env.LDFLAGS].filter(Boolean).join(' ')
  }
}

function sourcePathFor(packageId) {
  return path.join(sourceRoot, packageId)
}

function configureMakeInstall(packageId, configureArgs) {
  const packageSourcePath = sourcePathFor(packageId)
  const env = buildEnv()
  run('./configure', [`--prefix=${prefix}`, ...configureArgs], {
    cwd: packageSourcePath,
    env
  })
  run('make', [`-j${parallelism}`], { cwd: packageSourcePath, env })
  run('make', ['install'], { cwd: packageSourcePath, env })
}

function mesonInstall(packageId, mesonArgs) {
  const packageSourcePath = sourcePathFor(packageId)
  const buildDir = path.join(packageSourcePath, 'build-empv')
  const env = buildEnv()
  fs.rmSync(buildDir, { recursive: true, force: true })
  run(
    'meson',
    [
      'setup',
      buildDir,
      `--prefix=${prefix}`,
      '--libdir=lib',
      '--buildtype=release',
      '--default-library=shared',
      ...mesonArgs
    ],
    { cwd: packageSourcePath, env }
  )
  run('meson', ['compile', '-C', buildDir], { cwd: packageSourcePath, env })
  run('meson', ['install', '-C', buildDir], { cwd: packageSourcePath, env })
}

function buildRuntime() {
  fs.rmSync(prefix, { recursive: true, force: true })
  fs.mkdirSync(prefix, { recursive: true })

  configureMakeInstall('freetype', ['--enable-shared', '--disable-static'])
  configureMakeInstall('fribidi', ['--enable-shared', '--disable-static'])
  mesonInstall('harfbuzz', [
    '-Dglib=disabled',
    '-Dgobject=disabled',
    '-Dcairo=disabled',
    '-Dchafa=disabled',
    '-Dicu=disabled',
    '-Dfreetype=enabled',
    '-Dtests=disabled',
    '-Dintrospection=disabled',
    '-Ddocs=disabled',
    '-Dutilities=disabled',
    '-Dbenchmark=disabled'
  ])
  configureMakeInstall('libass', [
    '--enable-shared',
    '--disable-static',
    '--disable-fontconfig',
    '--enable-coretext',
    '--disable-libunibreak'
  ])

  const ffmpegSourcePath = sourcePathFor('ffmpeg')
  const ffmpegEnv = buildEnv()
  run('./configure', ffmpegConfigureFlags, { cwd: ffmpegSourcePath, env: ffmpegEnv })
  run('make', [`-j${parallelism}`], { cwd: ffmpegSourcePath, env: ffmpegEnv })
  run('make', ['install'], { cwd: ffmpegSourcePath, env: ffmpegEnv })

  mesonInstall('libplacebo', [
    '-Dopengl=enabled',
    '-Dvulkan=disabled',
    '-Dvk-proc-addr=disabled',
    '-Dglslang=disabled',
    '-Dshaderc=disabled',
    '-Dlcms=disabled',
    '-Ddovi=disabled',
    '-Dlibdovi=disabled',
    '-Ddemos=false',
    '-Dtests=false',
    '-Dbench=false',
    '-Dfuzz=false',
    '-Dunwind=disabled',
    '-Dxxhash=disabled'
  ])
  mesonInstall('mpv', mpvMesonFlags)
}

function listDylibs(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return []
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.dylib'))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort()
}

function validateRuntimeLinks() {
  if (!commandExists('otool')) {
    log('Skipping otool validation because otool is unavailable.')
    return
  }

  const libDir = path.join(prefix, 'lib')
  const errors = []
  const allowedSystemPrefixes = ['/System/Library/', '/usr/lib/']
  const forbiddenPrefixes = ['/opt/homebrew/', '/usr/local/']

  for (const dylibPath of listDylibs(libDir)) {
    const result = spawnSync('otool', ['-L', dylibPath], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
    if (result.status !== 0) {
      errors.push(`Unable to inspect ${dylibPath}: ${result.stderr}`)
      continue
    }

    for (const dependencyPath of result.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/)[0])
      .filter(Boolean)) {
      if (
        allowedSystemPrefixes.some((prefixValue) => dependencyPath.startsWith(prefixValue)) ||
        dependencyPath.startsWith('@loader_path/') ||
        dependencyPath.startsWith('@rpath/') ||
        dependencyPath.startsWith(prefix)
      ) {
        continue
      }

      if (forbiddenPrefixes.some((prefixValue) => dependencyPath.startsWith(prefixValue))) {
        errors.push(`${dylibPath} links to forbidden ${dependencyPath}`)
        continue
      }

      if (path.isAbsolute(dependencyPath)) {
        errors.push(`${dylibPath} links to external ${dependencyPath}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(['Embedded MPV runtime link validation failed.', ...errors].join('\n'))
  }
}

function writeManifest() {
  const manifest = {
    origin: 'vendored-lgpl-source-build',
    arch,
    generatedAt: new Date().toISOString(),
    macosDeploymentTarget,
    buildHost: {
      platform: process.platform,
      arch: process.arch
    },
    packages: packagesMetadata(sourcePackages),
    ffmpeg: {
      ...sourceMetadata(packageById.get('ffmpeg')),
      licensePolicy: 'LGPL, built without --enable-gpl and --enable-nonfree',
      configureFlags: ffmpegConfigureFlags
    },
    mpv: {
      ...sourceMetadata(packageById.get('mpv')),
      licensePolicy: 'LGPL-compatible libmpv, built with -Dlibmpv=true -Dgpl=false',
      mesonFlags: mpvMesonFlags
    },
    sourceDistribution:
      'Attach the downloaded source archives, the libplacebo git checkout metadata, this manifest, and any local patches with the macOS binary release.'
  }

  fs.writeFileSync(
    path.join(prefix, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

try {
  ensureTools(['curl', 'tar', 'make', 'meson', 'ninja', 'pkg-config', 'git', 'patch'])
  fs.mkdirSync(buildRoot, { recursive: true })
  downloadSources({ sourcePackages, archiveRoot, sourceRoot, sourcePathFor, env: process.env })
  applyMpvPatches({
    mpvPackage: packageById.get('mpv'),
    mpvSourcePath: sourcePathFor('mpv'),
    patchesDir,
    patchNames: mpvPatchesByPlatform.darwin,
    env: process.env
  })
  buildRuntime()
  validateRuntimeLinks()
  writeManifest()
  log(`Built LGPL-compatible runtime prefix at ${prefix}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
