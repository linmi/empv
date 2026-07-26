#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 构建脚本：console 是其面向终端的输出通道 */
//
// Builds an LGPL-compatible Windows libmpv from the same pinned sources the
// macOS runtime is built from, by cross-compiling with MinGW-w64.
//
//   node scripts/embedded-mpv/build-windows-runtime.mjs x64 /tmp/empv-win-prefix
//
// WHY THIS EXISTS AT ALL
//
// Every prebuilt libmpv available for Windows is GPL, so shipping one would
// relicense whatever ships it. mpv itself does not require that: reading
// meson.build for the pinned 0.41.0, the features gated behind -Dgpl=true are
// cdda, dvbin, dvdnav, jack, oss-audio, caca, direct3d and x11. Of those only
// direct3d -- the legacy D3D9 output -- exists on Windows and matters to a
// player, and it is not the D3D11 renderer empv drives vo=gpu through, which is
// a separate ungated feature. win32-desktop is not gated either, so
// video/out/w32_common.c, which is where --wid is implemented, is in an LGPL
// build. Linux is the opposite case: x11 is gated, so there --wid and LGPL are
// mutually exclusive.
//
// WHY ONE STATICALLY LINKED DLL
//
// The macOS runtime is a graph of dylibs resolved through @loader_path. Windows
// has no equivalent that survives the way an addon is loaded: libuv opens
// empv.node with LOAD_WITH_ALTERED_SEARCH_PATH, which reliably finds a
// libmpv-2.dll sitting beside it, but relying on that to also resolve a dozen
// transitive avcodec-*.dll loads is betting the package on search-order
// subtleties. Linking every dependency into libmpv-2.dll removes the question:
// one file, imports nothing but Windows itself, and the addon still links it
// dynamically -- which is the arrangement LGPL asks for. Everything inside is
// LGPL, Apache-2.0, MIT, BSD-3-Clause, ISC or the FreeType licence, none of them
// copyleft beyond the LGPL, so the combined DLL is LGPL-2.1-or-later and the
// manifest names every source archive it was built from.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  applyMpvPatches,
  downloadSources,
  ensureTools,
  foreignImports,
  log,
  missingFeatures,
  packagesMetadata,
  run,
  runCapture,
  sourceMetadata
} from './runtime-build-core.mjs'
import { mpvPatchesByPlatform, mpvSource, runtimeBuildRoot } from './runtime-pins.mjs'

const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const [arch, rawPrefix] = args
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const patchesDir = path.join(scriptDir, 'patches')

// One triple for now. win32-arm64 would need aarch64-w64-mingw32, which Ubuntu
// does not package, so claiming to support it here would be a lie the first
// caller discovers.
const TRIPLE = 'x86_64-w64-mingw32'

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
  // The three below exist only to give mpv its D3D11 renderer, which it gates
  // behind shaderc (GLSL to SPIR-V) and SPIRV-Cross (SPIR-V to HLSL). Without
  // them vo=gpu falls back to WGL, which works but leaves rendering at the mercy
  // of whatever OpenGL the display driver provides.
  //
  // glslang and SPIRV-Tools are not listed separately: shaderc_combined is one
  // archive that already contains them, so they are inputs to shaderc's build
  // rather than libraries of their own. Their revisions are the ones shaderc
  // pins in its own DEPS file, quoted here so a shaderc bump is a deliberate
  // three-line change rather than a silent drift in what got compiled.
  {
    id: 'spirv-headers',
    version: '29981f65241605e08b0ede4cfeb999fe3b723c6a',
    url: 'https://github.com/KhronosGroup/SPIRV-Headers/archive/29981f65241605e08b0ede4cfeb999fe3b723c6a.tar.gz',
    license: 'MIT',
    pinnedBy: 'shaderc v2026.3 DEPS: spirv_headers_revision'
  },
  {
    id: 'spirv-tools',
    version: 'b707790a898e44038547df54580022fc1cf89c3d',
    url: 'https://github.com/KhronosGroup/SPIRV-Tools/archive/b707790a898e44038547df54580022fc1cf89c3d.tar.gz',
    license: 'Apache-2.0',
    pinnedBy: 'shaderc v2026.3 DEPS: spirv_tools_revision'
  },
  {
    id: 'glslang',
    version: '168d452a4f460d24b588fed08477a81c44ee27a1',
    url: 'https://github.com/KhronosGroup/glslang/archive/168d452a4f460d24b588fed08477a81c44ee27a1.tar.gz',
    license: 'BSD-3-Clause AND Apache-2.0 AND MIT',
    pinnedBy: 'shaderc v2026.3 DEPS: glslang_revision'
  },
  {
    id: 'shaderc',
    version: '2026.3',
    url: 'https://github.com/google/shaderc/archive/refs/tags/v2026.3.tar.gz',
    license: 'Apache-2.0'
  },
  {
    id: 'spirv-cross',
    version: 'vulkan-sdk-1.4.350.1',
    url: 'https://github.com/KhronosGroup/SPIRV-Cross/archive/refs/tags/vulkan-sdk-1.4.350.1.tar.gz',
    license: 'Apache-2.0'
  },
  mpvSource
]

const validArchitectures = new Set(['x64'])

if (!validArchitectures.has(arch) || !rawPrefix) {
  console.error(
    [
      'Usage: node scripts/embedded-mpv/build-windows-runtime.mjs <x64> <output-prefix>',
      '',
      'Cross-compiles a pinned LGPL-compatible Windows libmpv with MinGW-w64.',
      'Runs on any host with the toolchain; CI uses Linux.'
    ].join('\n')
  )
  process.exit(1)
}

const prefix = path.resolve(rawPrefix)
const buildRoot = runtimeBuildRoot(`win32-${arch}`)
const archiveRoot = path.join(buildRoot, 'archives')
const sourceRoot = path.join(buildRoot, 'sources')
const crossFilePath = path.join(buildRoot, 'meson-cross-mingw.ini')
const cmakeToolchainPath = path.join(buildRoot, 'cmake-toolchain-mingw.cmake')
const packageById = new Map(sourcePackages.map((source) => [source.id, source]))
const parallelism = process.env.MAKEFLAGS?.match(/-j\s*(\d+)/)?.[1] ?? String(os.cpus().length)

const sourcePathFor = (packageId) => path.join(sourceRoot, packageId)

// -static is what keeps the GCC runtime out of the output. Without it the DLL
// imports libwinpthread-1.dll and libgcc_s_seh-1.dll, which would then have to
// be shipped and licence-documented alongside it; with it there is one file.
// The import validation at the end is what proves this actually took effect.
//
// -lstdc++ because libplacebo has C++ in it (convert.cc) and mpv links with the
// C driver, which does not bring the C++ standard library along. Whether that
// shows up depends on the toolchain: under GCC 16 the std::to_chars/from_chars
// floating-point overloads it calls resolved inline, under GCC 13 -- what Ubuntu
// ships, and therefore what CI uses -- they are out of line in libstdc++ and the
// link fails on four undefined references. The DLL contains C++ objects either
// way, so linking the C++ runtime is correct regardless of which compiler
// happens to hide the need for it.
const LINK_FLAGS = ['-static-libgcc', '-static-libstdc++', '-static', '-lstdc++']

const ffmpegConfigureFlags = [
  `--prefix=${prefix}`,
  '--enable-cross-compile',
  `--cross-prefix=${TRIPLE}-`,
  '--arch=x86_64',
  '--target-os=mingw32',
  '--enable-static',
  '--disable-shared',
  '--disable-doc',
  '--disable-debug',
  '--disable-programs',
  '--disable-autodetect',
  '--disable-gpl',
  '--disable-nonfree',
  '--enable-pic',
  // Explicit because --disable-autodetect turns off probing: TLS for network
  // streams, and the two hardware decode paths empv relies on for 4K.
  '--enable-schannel',
  '--enable-d3d11va',
  '--enable-dxva2',
  '--enable-w32threads'
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
  // The D3D11 renderer, and the two translators mpv needs to feed it: GLSL to
  // SPIR-V through shaderc, SPIR-V to HLSL through SPIRV-Cross. All three
  // enabled rather than auto, so a dependency that fails to build fails the
  // build instead of producing a libmpv that silently renders through WGL.
  '-Dshaderc=enabled',
  '-Dspirv-cross=enabled',
  '-Dd3d11=enabled'
]

// What the Windows runtime has to come out with. Every one of these is
// something mpv would otherwise disable silently when a header or dependency
// goes missing, leaving a libmpv that loads, plays nothing useful, and reports
// no error anyone can act on.
const REQUIRED_MPV_FEATURES = [
  // video/out/w32_common.c: the whole reason a Windows build is viable at all,
  // since it is where --wid is implemented.
  'win32-desktop',
  // vo=gpu's rendering path and the zero-copy hardware decode interop.
  'gl',
  'gl-win32',
  'gl-dxinterop',
  'd3d-hwaccel',
  // Audio out, subtitles, and the renderer mpv hands frames to.
  'wasapi',
  'libass',
  'libplacebo',
  // Proves -static did not quietly leave a libwinpthread dependency behind.
  'win32-threads',
  // The D3D11 renderer and the two shader translators it is gated behind. mpv
  // disables d3d11 silently when either is missing, leaving a libmpv whose
  // vo=gpu quietly falls back to WGL -- the exact regression this list exists to
  // catch, since nothing about playback looks different until you profile it.
  'shaderc',
  'spirv-cross',
  'd3d11'
]

function buildEnv() {
  const pkgConfigDirs = [
    path.join(prefix, 'lib', 'pkgconfig'),
    path.join(prefix, 'share', 'pkgconfig')
  ].join(path.delimiter)

  return {
    ...process.env,
    // LIBDIR rather than PATH alone: a cross build that falls through to the
    // host's .pc files finds host libraries and fails much later, in a link
    // error that says nothing about why.
    PKG_CONFIG_PATH: pkgConfigDirs,
    PKG_CONFIG_LIBDIR: pkgConfigDirs,
    CC: `${TRIPLE}-gcc`,
    CXX: `${TRIPLE}-g++`,
    AR: `${TRIPLE}-ar`,
    RANLIB: `${TRIPLE}-ranlib`,
    STRIP: `${TRIPLE}-strip`,
    WINDRES: `${TRIPLE}-windres`,
    CFLAGS: [`-I${path.join(prefix, 'include')}`, '-O2', process.env.CFLAGS]
      .filter(Boolean)
      .join(' '),
    CXXFLAGS: [`-I${path.join(prefix, 'include')}`, '-O2', process.env.CXXFLAGS]
      .filter(Boolean)
      .join(' '),
    LDFLAGS: [`-L${path.join(prefix, 'lib')}`, ...LINK_FLAGS, process.env.LDFLAGS]
      .filter(Boolean)
      .join(' ')
  }
}

// CMake has no equivalent of meson's --cross-file on the command line, so the
// toolchain is written out the same way. Deliberately no CMAKE_FIND_ROOT_PATH:
// the sysroot lives somewhere different under Homebrew than under Ubuntu, and
// pinning it would make this work on exactly one of them. CMAKE_PREFIX_PATH is
// enough -- the only non-toolchain libraries these projects look for are the
// ones already installed into our own prefix.
function writeCmakeToolchainFile() {
  const contents = `set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER ${TRIPLE}-gcc)
set(CMAKE_CXX_COMPILER ${TRIPLE}-g++)
set(CMAKE_RC_COMPILER ${TRIPLE}-windres)
set(CMAKE_PREFIX_PATH ${prefix})
`
  fs.writeFileSync(cmakeToolchainPath, contents)
  log(`Wrote cmake toolchain file at ${cmakeToolchainPath}`)
}

function cmakeInstall(packageId, cmakeArgs) {
  const packageSourcePath = sourcePathFor(packageId)
  const buildDir = path.join(packageSourcePath, 'build-empv')
  const env = buildEnv()
  fs.rmSync(buildDir, { recursive: true, force: true })

  run(
    'cmake',
    [
      '-S',
      packageSourcePath,
      '-B',
      buildDir,
      `-DCMAKE_TOOLCHAIN_FILE=${cmakeToolchainPath}`,
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      '-DCMAKE_INSTALL_LIBDIR=lib',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      ...cmakeArgs
    ],
    { cwd: packageSourcePath, env }
  )
  run('cmake', ['--build', buildDir, '--parallel', parallelism], {
    cwd: packageSourcePath,
    env
  })
  run('cmake', ['--install', buildDir], { cwd: packageSourcePath, env })
}

function writeCrossFile() {
  const contents = `[binaries]
c = '${TRIPLE}-gcc'
cpp = '${TRIPLE}-g++'
ar = '${TRIPLE}-ar'
ranlib = '${TRIPLE}-ranlib'
strip = '${TRIPLE}-strip'
windres = '${TRIPLE}-windres'
# libplacebo looks for a bare "llvm-dlltool" or "dlltool" on PATH, and a cross
# toolchain only installs the triple-prefixed one. Naming it here is what makes
# find_program resolve it; without this the build dies at libplacebo's configure
# with a message that mentions neither cross-compiling nor the prefix.
dlltool = '${TRIPLE}-dlltool'
nm = '${TRIPLE}-nm'
objcopy = '${TRIPLE}-objcopy'
pkg-config = 'pkg-config'
nasm = 'nasm'

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
`
  fs.writeFileSync(crossFilePath, contents)
  log(`Wrote meson cross file at ${crossFilePath}`)
}

function configureMakeInstall(packageId, configureArgs) {
  const packageSourcePath = sourcePathFor(packageId)
  const env = buildEnv()
  run('./configure', [`--prefix=${prefix}`, `--host=${TRIPLE}`, ...configureArgs], {
    cwd: packageSourcePath,
    env
  })
  run('make', [`-j${parallelism}`], { cwd: packageSourcePath, env })
  run('make', ['install'], { cwd: packageSourcePath, env })
}

function mesonSetupArgs(buildDir, defaultLibrary, mesonArgs) {
  return [
    'setup',
    buildDir,
    `--prefix=${prefix}`,
    '--libdir=lib',
    '--buildtype=release',
    `--default-library=${defaultLibrary}`,
    // Everything below libmpv is static, so dependency lookups have to ask
    // pkg-config for the static link lines or the final DLL comes up short at
    // link time with symbols that are sitting in the .a files.
    '--prefer-static',
    '--cross-file',
    crossFilePath,
    ...mesonArgs
  ]
}

function mesonInstall(packageId, mesonArgs, { defaultLibrary }) {
  const packageSourcePath = sourcePathFor(packageId)
  const buildDir = path.join(packageSourcePath, 'build-empv')
  const env = buildEnv()
  fs.rmSync(buildDir, { recursive: true, force: true })
  run('meson', mesonSetupArgs(buildDir, defaultLibrary, mesonArgs), {
    cwd: packageSourcePath,
    env
  })
  run('meson', ['compile', '-C', buildDir], { cwd: packageSourcePath, env })
  run('meson', ['install', '-C', buildDir], { cwd: packageSourcePath, env })
}

/// mpv is configured through runCapture so its feature summary can be asserted.
/// meson reports what it enabled and then exits 0 either way, so without this a
/// build that silently lost wasapi or win32-desktop ships as if nothing changed.
function mesonInstallMpv(mesonArgs) {
  const packageSourcePath = sourcePathFor('mpv')
  const buildDir = path.join(packageSourcePath, 'build-empv')
  const env = buildEnv()
  fs.rmSync(buildDir, { recursive: true, force: true })

  const output = runCapture('meson', mesonSetupArgs(buildDir, 'shared', mesonArgs), {
    cwd: packageSourcePath,
    env
  })
  process.stdout.write(`${output}\n`)

  const missing = missingFeatures(output, REQUIRED_MPV_FEATURES)
  if (missing.length > 0) {
    throw new Error(`mpv configured without required feature(s): ${missing.join(', ')}.`)
  }
  log(`mpv enabled every required feature: ${REQUIRED_MPV_FEATURES.join(' ')}`)

  run('meson', ['compile', '-C', buildDir], { cwd: packageSourcePath, env })
  run('meson', ['install', '-C', buildDir], { cwd: packageSourcePath, env })
}

// SPIRV-Cross's static pkg-config file names only the top archive, and the C API
// in it needs seven siblings: linking what the file says produces "undefined
// reference to vtable for spirv_cross::Compiler" out of an archive that is
// sitting right there in the same directory.
//
// This corrects incomplete metadata rather than inventing any: every library
// added below is one that spirv-cross-c genuinely requires and that the same
// install step already produced. The original line is matched exactly so an
// upstream fix surfaces here as a failure instead of being silently overwritten
// with our version of it.
function completeSpirvCrossPkgConfig() {
  const pkgConfigPath = path.join(prefix, 'lib', 'pkgconfig', 'spirv-cross-c.pc')
  const contents = fs.readFileSync(pkgConfigPath, 'utf8')
  const incomplete = 'Libs: -L${libdir} -lspirv-cross-c\n'

  if (!contents.includes(incomplete)) {
    throw new Error(
      `${pkgConfigPath} no longer has the incomplete Libs line this build corrects. ` +
        'Check whether SPIRV-Cross now lists the static closure itself, and drop this step if so.'
    )
  }

  // Dependents before dependencies: the archives are not in a link group here,
  // and spirv-cross-core has to come last because everything else needs it.
  const closure = [
    '-lspirv-cross-c',
    '-lspirv-cross-glsl',
    '-lspirv-cross-hlsl',
    '-lspirv-cross-msl',
    '-lspirv-cross-cpp',
    '-lspirv-cross-reflect',
    '-lspirv-cross-util',
    '-lspirv-cross-core'
  ].join(' ')

  fs.writeFileSync(pkgConfigPath, contents.replace(incomplete, `Libs: -L\${libdir} ${closure}\n`))
  log('Completed spirv-cross-c.pc with the static archives its C API requires')
}

function buildRuntime() {
  fs.rmSync(prefix, { recursive: true, force: true })
  fs.mkdirSync(prefix, { recursive: true })
  writeCrossFile()
  writeCmakeToolchainFile()

  configureMakeInstall('freetype', ['--disable-shared', '--enable-static'])
  configureMakeInstall('fribidi', ['--disable-shared', '--enable-static'])
  mesonInstall(
    'harfbuzz',
    [
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
    ],
    { defaultLibrary: 'static' }
  )
  // DirectWrite is libass's font provider on Windows, the way CoreText is on
  // macOS; fontconfig is neither present nor wanted.
  configureMakeInstall('libass', [
    '--disable-shared',
    '--enable-static',
    '--disable-fontconfig',
    '--enable-directwrite',
    '--disable-libunibreak'
  ])

  const ffmpegSourcePath = sourcePathFor('ffmpeg')
  const ffmpegEnv = buildEnv()
  run('./configure', ffmpegConfigureFlags, { cwd: ffmpegSourcePath, env: ffmpegEnv })
  run('make', [`-j${parallelism}`], { cwd: ffmpegSourcePath, env: ffmpegEnv })
  run('make', ['install'], { cwd: ffmpegSourcePath, env: ffmpegEnv })

  mesonInstall(
    'libplacebo',
    [
      '-Dopengl=enabled',
      '-Dd3d11=disabled',
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
    ],
    { defaultLibrary: 'static' }
  )
  // shaderc's own build subsumes glslang and SPIRV-Tools rather than linking
  // installed copies, so they are pointed at in place: SHADERC_*_DIR is exactly
  // what those cache variables are for, and it avoids shuffling three source
  // trees into third_party/ just to satisfy a default path.
  //
  // Tests are skipped, which is not only about build time: SPIRV_SKIP_TESTS is
  // what makes abseil, re2, effcee and googletest unnecessary, so skipping them
  // is the difference between three pinned sources and seven.
  cmakeInstall('shaderc', [
    `-DSHADERC_SPIRV_HEADERS_DIR=${sourcePathFor('spirv-headers')}`,
    `-DSHADERC_SPIRV_TOOLS_DIR=${sourcePathFor('spirv-tools')}`,
    `-DSHADERC_GLSLANG_DIR=${sourcePathFor('glslang')}`,
    '-DSHADERC_SKIP_TESTS=ON',
    '-DSHADERC_SKIP_EXAMPLES=ON',
    '-DSHADERC_SKIP_EXECUTABLES=ON',
    '-DSHADERC_SKIP_COPYRIGHT_CHECK=ON',
    '-DSHADERC_ENABLE_SHARED_CRT=OFF'
  ])
  // Static only. The shared variant would be a second DLL to ship, and the C++
  // API and CLI are of no use to mpv, which calls the C one.
  cmakeInstall('spirv-cross', [
    '-DSPIRV_CROSS_STATIC=ON',
    '-DSPIRV_CROSS_SHARED=OFF',
    '-DSPIRV_CROSS_CLI=OFF',
    '-DSPIRV_CROSS_ENABLE_TESTS=OFF'
  ])
  completeSpirvCrossPkgConfig()
  mesonInstallMpv(mpvMesonFlags)
}

function findLibMpvDll() {
  // meson puts a Windows shared library in bindir and its import library in
  // libdir. Searching both rather than assuming keeps this working if that ever
  // changes, and fails loudly if the DLL is simply not there.
  for (const directory of [path.join(prefix, 'bin'), path.join(prefix, 'lib')]) {
    if (!fs.existsSync(directory)) continue
    const match = fs.readdirSync(directory).find((entry) => /^(lib)?mpv-?\d*\.dll$/i.test(entry))
    if (match) return path.join(directory, match)
  }

  throw new Error(`No libmpv DLL was installed under ${prefix}.`)
}

// The libraries this build produces, so an import of one of them can be told
// apart from an import of Windows.
const BUILT_HERE = [
  'avcodec',
  'avformat',
  'avutil',
  'avfilter',
  'avdevice',
  'swscale',
  'swresample',
  'postproc',
  'placebo',
  'ass',
  'shaderc',
  'shaderc_shared',
  'spirv-cross-c-shared',
  'freetype',
  'fribidi',
  'harfbuzz'
]

function importedDlls(binaryPath) {
  return runCapture(`${TRIPLE}-objdump`, ['-p', binaryPath])
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^DLL Name:\s*(.+)$/i))
    .filter(Boolean)
    .map((match) => match[1].trim())
}

/// The DLL has to be self-contained: anything it imports beyond Windows itself
/// is a file that would have to ship beside it, and the whole point of linking
/// statically was that no such file exists.
function validateRuntimeImports(dllPath) {
  const imported = importedDlls(dllPath)
  const foreign = foreignImports(imported, { builtHere: BUILT_HERE })

  if (foreign.length > 0) {
    throw new Error(
      [
        `${path.basename(dllPath)} is not self-contained.`,
        ...foreign.map((entry) => `${entry.imported}: ${entry.reason}`)
      ].join('\n  ')
    )
  }

  log(`${path.basename(dllPath)} imports only system DLLs:`)
  for (const name of [...imported].sort()) log(`  ${name}`)
}

function writeManifest(dllPath) {
  const manifest = {
    origin: 'vendored-lgpl-source-build',
    platform: 'win32',
    arch,
    generatedAt: new Date().toISOString(),
    linkage: 'every dependency statically linked into a single libmpv DLL',
    library: path.basename(dllPath),
    toolchain: {
      triple: TRIPLE,
      compiler: runCapture(`${TRIPLE}-gcc`, ['--version']).split(/\r?\n/)[0]
    },
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
      'Attach the downloaded source archives, the libplacebo git checkout metadata, this manifest, and any local patches with the Windows binary release.'
  }

  fs.writeFileSync(
    path.join(prefix, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

try {
  ensureTools([
    'curl',
    'tar',
    'make',
    'meson',
    'ninja',
    'pkg-config',
    'git',
    'patch',
    'nasm',
    'cmake',
    `${TRIPLE}-gcc`,
    `${TRIPLE}-objdump`
  ])
  fs.mkdirSync(buildRoot, { recursive: true })
  downloadSources({ sourcePackages, archiveRoot, sourceRoot, sourcePathFor, env: process.env })
  applyMpvPatches({
    mpvPackage: packageById.get('mpv'),
    mpvSourcePath: sourcePathFor('mpv'),
    patchesDir,
    patchNames: mpvPatchesByPlatform.win32,
    env: process.env
  })
  buildRuntime()
  const dllPath = findLibMpvDll()
  validateRuntimeImports(dllPath)
  writeManifest(dllPath)
  log(`Built LGPL-compatible Windows runtime prefix at ${prefix}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
