#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 构建脚本：console 是其面向终端的输出通道 */
//
// Builds the per-platform npm package that carries a prebuilt addon, so that
// `npm install empv` works on a machine with no Rust toolchain.
//
// The main package lists these as optionalDependencies with `os`/`cpu` set, so
// npm installs only the one that matches and silently skips the rest. empv's
// runtime resolver then finds the installed one and loads the addon out of it.
//
//   node scripts/pack-platform-package.mjs darwin arm64
//   node scripts/pack-platform-package.mjs win32 x64 --from native/build/Release
//
// WHAT GOES IN, AND WHY IT DIFFERS BY PLATFORM
//
// macOS has no system libmpv, so the package carries the LGPL runtime built
// from pinned sources by build-runtime:macos. Redistributing it brings LGPL
// obligations along, which is why the licence files are copied in beside the
// binaries rather than left behind in the source package -- a user who only ever
// sees this tarball still gets the notices, the licence text and the manifest
// naming every source archive.
//
// Windows ships the addon alone. Every libmpv build available for it is GPL --
// the pinned upstream development archive has no -Dgpl=false in its embedded
// configuration and exports libx264/libx265 symbols -- so bundling one would put
// this Apache-2.0 distribution under the GPL. Shipping only the addon avoids
// that entirely: the user drops libmpv-2.dll next to it, Windows searches the
// loading module's own directory first, and whatever licence that DLL carries
// stays their decision about their own distribution rather than ours.
//
// Linux has no package yet. It would also be addon-only -- distributions package
// libmpv and the addon links it by soname -- but the resolver looks for the
// library inside the runtime directory, and on Linux it lives in /usr/lib. That
// needs system-path discovery before an addon-only Linux package can resolve at
// all; Windows sidesteps it because the DLL sits in the same directory.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { cpSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

// Platforms whose prebuilt package carries the libmpv runtime. Anything absent
// here ships the addon alone and expects the system to provide libmpv.
const BUNDLES_RUNTIME = new Set(['darwin'])

// Copied next to the binaries so the obligations travel with them.
const LICENCE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']

// A staged macOS runtime is 14 real dylibs plus 21 symlinks, and the install
// names point at the symlinks: libmpv.2.dylib loads @loader_path/libavcodec.62
// .dylib, which on disk is a link to libavcodec.62.28.100.dylib. npm tarballs do
// not carry symlinks, so copying the directory verbatim ships a package whose
// every library is present under the wrong name and whose first dlopen fails.
//
// Walking the load commands instead materialises exactly the names that are
// actually referenced, once each: no duplicates, no dev-only unversioned links,
// and a missing link in the chain fails here rather than on a user's machine.
function readLoadCommands(binaryPath) {
  const result = spawnSync('otool', ['-L', binaryPath], { encoding: 'utf8' })
  if (result.error) {
    throw new Error(`Failed to run otool on ${binaryPath}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`otool -L ${binaryPath} exited ${String(result.status)}.`)
  }
  // otool prints the binary's own install name among the load commands. Counting
  // it as a dependency stores the same library twice, once under its soname and
  // once under its fully versioned name, which is how this package first came
  // out at 54MB instead of 28MB.
  const self = path.basename(binaryPath)
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/ \(.*$/, ''))
    .filter((name) => name.startsWith('@loader_path/'))
    .map((name) => name.slice('@loader_path/'.length))
    .filter((name) => path.basename(name) !== self)
}

// What the addon actually is, read out of its own header rather than inferred
// from where it was found. `--from` points this script at whatever directory a
// build left its output in, and the runtime manifest -- the only other evidence
// available -- records the arch but not the platform, so pointing a `win32 x64`
// pack at a macOS build directory would produce an `os: ["win32"]` package
// carrying a Mach-O binary. npm would install it happily and dlopen would fail
// on a machine nobody involved in the release owns.
function readBinaryTarget(binaryPath) {
  const header = readFileSync(binaryPath)

  // Mach-O: magic, then cputype. A fat binary is not something any build here
  // produces, so it is left to fall through to "unrecognised" rather than
  // handled speculatively.
  const magic = header.readUInt32LE(0)
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    const cpuType = header.readInt32LE(4)
    const architectures = new Map([
      [0x0100000c, 'arm64'],
      [0x01000007, 'x64']
    ])
    return { platform: 'darwin', arch: architectures.get(cpuType) ?? `cputype ${cpuType}` }
  }

  // PE: the DOS stub carries the offset of the COFF header, whose first field
  // is the machine type.
  if (header.readUInt16LE(0) === 0x5a4d) {
    const coffOffset = header.readUInt32LE(0x3c)
    if (header.readUInt32LE(coffOffset) !== 0x00004550) {
      throw new Error(`${binaryPath} starts with MZ but has no PE header.`)
    }
    const machine = header.readUInt16LE(coffOffset + 4)
    const architectures = new Map([
      [0x8664, 'x64'],
      [0xaa64, 'arm64']
    ])
    return {
      platform: 'win32',
      arch: architectures.get(machine) ?? `machine 0x${machine.toString(16)}`
    }
  }

  if (header.readUInt32BE(0) === 0x7f454c46) {
    const machine = header.readUInt16LE(0x12)
    const architectures = new Map([
      [0x3e, 'x64'],
      [0xb7, 'arm64']
    ])
    return {
      platform: 'linux',
      arch: architectures.get(machine) ?? `machine 0x${machine.toString(16)}`
    }
  }

  throw new Error(`${binaryPath} is not a Mach-O, PE or ELF binary.`)
}

// Every library reachable from the addon, keyed by the name its dependents use.
function collectReferencedLibraries(addonPath, libraryDirectory) {
  const wanted = new Map()
  const queue = readLoadCommands(addonPath)
    .filter((name) => name.startsWith('lib/'))
    .map((name) => name.slice('lib/'.length))

  while (queue.length > 0) {
    const name = queue.shift()
    if (!name || wanted.has(name)) continue

    const linkPath = path.join(libraryDirectory, name)
    if (!existsSync(linkPath)) {
      throw new Error(
        `The staged runtime is missing ${name}, which something in it loads by that name.`
      )
    }
    const realPath = realpathSync(linkPath)
    wanted.set(name, realPath)
    queue.push(...readLoadCommands(realPath))
  }

  return wanted
}

function fail(message) {
  console.error(`[pack-platform] ${message}`)
  process.exitCode = 1
  return null
}

function main() {
  const raw = process.argv.slice(2)
  const args = raw[0] === '--' ? raw.slice(1) : raw
  const [platform, arch] = args
  // Packing a prebuilt around a runtime the release policy rejects is refused by
  // default. The mechanism itself -- pack, install, dlopen -- still needs to be
  // exercised on every push, and CI has only a Homebrew runtime, so that check
  // opts in explicitly and by a name nobody reaches for accidentally.
  const allowNonReleaseRuntime = args.includes('--allow-non-release-runtime')

  if (!platform || !arch) {
    return fail('Usage: node scripts/pack-platform-package.mjs <platform> <arch>')
  }

  // Where the built addon is. Defaults to what build-native.cjs produces; CI
  // drives napi directly and leaves its output in native/build/Release, so that
  // path is passed explicitly rather than guessed at.
  const fromIndex = args.indexOf('--from')
  const sourceDirectory =
    fromIndex === -1
      ? path.join(packageRoot, 'dist', 'native')
      : path.resolve(packageRoot, args[fromIndex + 1] ?? '')
  if (!existsSync(path.join(sourceDirectory, 'empv.node'))) {
    return fail(
      `No built addon at ${sourceDirectory}/empv.node. Run "pnpm run build:native" for ${platform}-${arch} first.`
    )
  }

  const addonPath = path.join(sourceDirectory, 'empv.node')
  const built = readBinaryTarget(addonPath)
  if (built.platform !== platform || built.arch !== arch) {
    return fail(
      `${path.relative(packageRoot, addonPath)} is a ${built.platform}-${built.arch} binary, ` +
        `but this would package it as ${platform}-${arch}.`
    )
  }

  const bundlesRuntime = BUNDLES_RUNTIME.has(platform)
  const manifestPath = path.join(sourceDirectory, 'runtime-manifest.json')
  // Only a package that carries the runtime needs the manifest describing it.
  // An addon-only package has no runtime to describe, and the build that
  // produces it does not necessarily write one: CI drives napi directly rather
  // than through build-native.cjs, which is what writes the manifest.
  if (bundlesRuntime && !existsSync(manifestPath)) {
    return fail(`No runtime manifest at ${manifestPath}; the native build did not complete.`)
  }
  const runtimeManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { platform, arch, origin: 'addon-only' }

  // A prebuilt is a release artefact. Refuse to build one around a runtime the
  // release policy rejects rather than discover it after publishing.
  if (bundlesRuntime && runtimeManifest.origin !== 'vendored-lgpl' && !allowNonReleaseRuntime) {
    return fail(
      `Refusing to package a "${runtimeManifest.origin}" runtime for ${platform}-${arch}. ` +
        'A published prebuilt must carry the vendored LGPL runtime built from pinned sources.'
    )
  }
  // The addon's own header settles what it is; this settles what the staged
  // runtime beside it was built for. They can only disagree if a build reused a
  // directory, which is exactly the case worth catching.
  if (bundlesRuntime && runtimeManifest.arch !== arch) {
    return fail(`The staged runtime is ${String(runtimeManifest.arch)}, not ${arch}.`)
  }

  const name = `empv-${platform}-${arch}`
  const outputDirectory = path.join(packageRoot, 'platform-packages', name)
  rmSync(outputDirectory, { recursive: true, force: true })
  mkdirSync(outputDirectory, { recursive: true })

  cpSync(path.join(sourceDirectory, 'empv.node'), path.join(outputDirectory, 'empv.node'))
  if (existsSync(manifestPath)) {
    cpSync(manifestPath, path.join(outputDirectory, 'runtime-manifest.json'))
  } else {
    writeFileSync(
      path.join(outputDirectory, 'runtime-manifest.json'),
      `${JSON.stringify({ id: 'libmpv', platform, arch, origin: 'addon-only' }, null, 2)}\n`
    )
  }

  const files = ['empv.node', 'runtime-manifest.json', ...LICENCE_FILES]

  if (bundlesRuntime) {
    const libraryDirectory = path.join(sourceDirectory, 'lib')
    if (!existsSync(libraryDirectory) || !statSync(libraryDirectory).isDirectory()) {
      return fail(`${platform} bundles its runtime, but ${libraryDirectory} is missing.`)
    }
    const libraries = collectReferencedLibraries(
      path.join(sourceDirectory, 'empv.node'),
      libraryDirectory
    )
    mkdirSync(path.join(outputDirectory, 'lib'), { recursive: true })
    for (const [name, realPath] of libraries) {
      copyFileSync(realPath, path.join(outputDirectory, 'lib', name))
    }
    console.log(`[pack-platform] libraries: ${libraries.size} (from the addon's load commands)`)
    files.push('lib/', 'third-party/')
    cpSync(path.join(packageRoot, 'third-party'), path.join(outputDirectory, 'third-party'), {
      recursive: true
    })
  }

  for (const licenceFile of LICENCE_FILES) {
    cpSync(path.join(packageRoot, licenceFile), path.join(outputDirectory, licenceFile))
  }

  writeFileSync(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: mainManifest.version,
        description: `Prebuilt empv addon${bundlesRuntime ? ' and libmpv runtime' : ''} for ${platform}-${arch}.`,
        license: mainManifest.license,
        author: mainManifest.author,
        homepage: mainManifest.homepage,
        repository: mainManifest.repository,
        os: [platform],
        cpu: [arch],
        files
      },
      null,
      2
    )}\n`
  )

  writeFileSync(
    path.join(outputDirectory, 'README.md'),
    `# ${name}\n\n` +
      `Prebuilt \`empv.node\`${bundlesRuntime ? ' and the libmpv runtime it loads' : ''} for ` +
      `${platform}-${arch}. Installed automatically as an optional dependency of ` +
      `[\`empv\`](https://github.com/linmi/empv); there is no reason to depend on it directly.\n` +
      (bundlesRuntime
        ? '\nThe bundled libmpv and FFmpeg libraries are LGPL-2.1-or-later. See ' +
          '`THIRD-PARTY-NOTICES.md` for their versions and sources, and `runtime-manifest.json` ' +
          'for the exact build inputs of the binaries in this package.\n'
        : platform === 'win32'
          ? '\nThis package carries no libmpv, and deliberately so: every Windows build ' +
            'of it is GPL, and bundling one would relicense whatever ships it.\n\n' +
            'Put a `libmpv-2.dll` in this directory, beside `empv.node`. Windows searches ' +
            "the loading module's own directory first, so nothing else needs configuring. " +
            'Whether you may redistribute that DLL with your application depends on its ' +
            'licence, which is a decision about your distribution rather than this one.\n'
          : '\nThis package carries no libmpv: install it from your system and the addon ' +
            'will link it by soname.\n')
  )

  console.log(`[pack-platform] wrote ${path.relative(packageRoot, outputDirectory)}`)
  console.log(`[pack-platform] bundles runtime: ${bundlesRuntime}`)
  if (bundlesRuntime && runtimeManifest.origin !== 'vendored-lgpl') {
    console.log(
      `[pack-platform] WARNING: built around a "${runtimeManifest.origin}" runtime. ` +
        'This package exercises the mechanism; it must not be published.'
    )
  }
  return null
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
