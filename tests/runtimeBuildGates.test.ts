// The gates that decide whether a built runtime is fit to ship.
//
// Each of these guards a failure that is silent by construction: meson exits 0
// after disabling a feature it could not find, a DLL that quietly imports the
// compiler runtime loads fine on the machine that built it, and a mislabelled
// package installs without complaint and only fails on hardware nobody involved
// in the release owns. None of them announces itself, so the gate is the only
// thing standing between the mistake and a published artefact.
//
// The expected values here come from outside the implementation: the Mach-O, PE
// and ELF header constants are from those formats' specifications, and the meson
// output is a verbatim line from a real mpv 0.41.0 cross-compile.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  foreignImports,
  missingFeatures,
  parseReportedFeatures
} from '../scripts/embedded-mpv/runtime-build-core.mjs'

// The build scripts are plain .mjs, so their shapes are named here where the
// tests rely on them rather than left to inference across the language boundary.
type ForeignImport = { imported: string; reason: string }
import { readBinaryTarget } from '../scripts/pack-platform-package.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Verbatim from a MinGW cross-compile of the pinned mpv, so a change to how
// meson formats this line fails here rather than turning the gate into a no-op.
const MPV_MESON_OUTPUT = [
  'Run-time dependency libplacebo found: YES 7.360.1',
  'Message: List of enabled features: d3d-hwaccel d3d9-hwaccel dos-paths ffmpeg gl gl-dxinterop gl-dxinterop-d3d9 gl-win32 glob glob-win32 libass libavdevice libplacebo vector wasapi win32 win32-desktop win32-threads',
  '',
  'mpv 0.41.0'
].join('\n')

test('the reported feature list is read out of meson output', () => {
  const features = parseReportedFeatures(MPV_MESON_OUTPUT)

  // win32-desktop is where video/out/w32_common.c -- and therefore --wid --
  // comes from; without it a Windows build cannot embed at all.
  assert.ok(features.has('win32-desktop'))
  assert.ok(features.has('wasapi'))
  assert.ok(!features.has('x11'))
})

test('output with no feature summary is an error, not an empty feature set', () => {
  // An empty set would make every required feature "missing", which reads as a
  // broken build. A changed output format is a different problem and has to say
  // so, or the next person spends their time looking at meson flags.
  assert.throws(
    () => parseReportedFeatures('Run-time dependency libplacebo found: YES\n\nmpv 0.41.0'),
    /output format changed/
  )
})

test('a feature mpv silently dropped is reported as missing', () => {
  const output = MPV_MESON_OUTPUT.replace(' wasapi', '')

  assert.deepEqual(missingFeatures(output, ['win32-desktop', 'wasapi', 'libass']), ['wasapi'])
  assert.deepEqual(missingFeatures(MPV_MESON_OUTPUT, ['win32-desktop', 'wasapi', 'libass']), [])
})

test('a feature that only appears as a prefix of another does not count as present', () => {
  // "gl" and "gl-win32" are separate features and both are required. Matching by
  // substring would let a build that lost plain gl pass on the strength of
  // gl-win32 being in the same line.
  const output = MPV_MESON_OUTPUT.replace('ffmpeg gl gl-dxinterop', 'ffmpeg gl-dxinterop')

  assert.deepEqual(missingFeatures(output, ['gl']), ['gl'])
})

const BUILT_HERE = ['avcodec', 'avutil', 'placebo', 'ass']

test('a self-contained DLL importing only Windows passes', () => {
  const imports = [
    'KERNEL32.dll',
    'USER32.dll',
    'OPENGL32.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'bcrypt.dll'
  ]

  assert.deepEqual(foreignImports(imports, { builtHere: BUILT_HERE }), [])
})

test('a leaked compiler runtime is caught', () => {
  // This is what the static link flags exist to prevent. Missing it ships a DLL
  // that loads on the build machine and fails on a user's with a bare
  // "libwinpthread-1.dll was not found".
  const foreign = foreignImports(['KERNEL32.dll', 'libwinpthread-1.dll', 'libgcc_s_seh-1.dll'], {
    builtHere: BUILT_HERE
  })

  assert.deepEqual(
    (foreign as ForeignImport[]).map((entry) => entry.imported),
    ['libwinpthread-1.dll', 'libgcc_s_seh-1.dll']
  )
})

test('a dependency that should have been linked in is caught whatever its soname', () => {
  const foreign = foreignImports(['KERNEL32.dll', 'avcodec-62.dll', 'libplacebo-349.dll'], {
    builtHere: BUILT_HERE
  })

  assert.deepEqual(
    (foreign as ForeignImport[]).map((entry) => entry.imported),
    ['avcodec-62.dll', 'libplacebo-349.dll']
  )
})

// Header bytes are from the formats' specifications, not from the reader.
function machO({ cpuType }: { cpuType: number }): Buffer {
  // The mach_header_64 is 32 bytes; padded because the reader refuses anything
  // too short to hold any of the three formats' headers.
  const header = Buffer.alloc(64)
  header.writeUInt32LE(0xfeedfacf, 0) // MH_MAGIC_64
  header.writeInt32LE(cpuType, 4)
  return header
}

function portableExecutable({ machine }: { machine: number }): Buffer {
  const header = Buffer.alloc(0x100)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(0x80, 0x3c) // e_lfanew
  header.writeUInt32LE(0x00004550, 0x80) // "PE\0\0"
  header.writeUInt16LE(machine, 0x84)
  return header
}

function elf({ machine }: { machine: number }): Buffer {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0) // \x7fELF
  header.writeUInt16LE(machine, 0x12)
  return header
}

function withBinary<T>(contents: Buffer, run: (binaryPath: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), 'empv-binary-target-'))
  try {
    const binaryPath = path.join(directory, 'empv.node')
    writeFileSync(binaryPath, contents)
    return run(binaryPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('an addon reports the platform and architecture it was actually built for', () => {
  // CPU_TYPE_ARM64 (0x0100000C), CPU_TYPE_X86_64 (0x01000007), IMAGE_FILE_MACHINE_AMD64
  // (0x8664), IMAGE_FILE_MACHINE_ARM64 (0xAA64), EM_X86_64 (62), EM_AARCH64 (183).
  assert.deepEqual(withBinary(machO({ cpuType: 0x0100000c }), readBinaryTarget), {
    platform: 'darwin',
    arch: 'arm64'
  })
  assert.deepEqual(withBinary(machO({ cpuType: 0x01000007 }), readBinaryTarget), {
    platform: 'darwin',
    arch: 'x64'
  })
  assert.deepEqual(withBinary(portableExecutable({ machine: 0x8664 }), readBinaryTarget), {
    platform: 'win32',
    arch: 'x64'
  })
  assert.deepEqual(withBinary(portableExecutable({ machine: 0xaa64 }), readBinaryTarget), {
    platform: 'win32',
    arch: 'arm64'
  })
  assert.deepEqual(withBinary(elf({ machine: 62 }), readBinaryTarget), {
    platform: 'linux',
    arch: 'x64'
  })
  assert.deepEqual(withBinary(elf({ machine: 183 }), readBinaryTarget), {
    platform: 'linux',
    arch: 'arm64'
  })
})

test('an unrecognised binary is refused rather than guessed at', () => {
  // Packaging something whose format could not be read is how a text file or a
  // truncated download ends up inside a platform package.
  assert.throws(
    () => withBinary(Buffer.alloc(128, 0x41), readBinaryTarget),
    /not a Mach-O, PE or ELF/
  )
  // Short inputs must not surface as a Buffer RangeError: the message has to
  // name the file being packaged, or the failure reads as a bug in the packer.
  assert.throws(
    () => withBinary(Buffer.from('this is short'), readBinaryTarget),
    /too short to be a Mach-O, PE or ELF/
  )

  // An MZ stub whose e_lfanew points past the end of the file.
  const danglingPeOffset = Buffer.alloc(128)
  danglingPeOffset.write('MZ', 0, 'ascii')
  danglingPeOffset.writeUInt32LE(0xfffff, 0x3c)
  assert.throws(() => withBinary(danglingPeOffset, readBinaryTarget), /points past the end/)
})
