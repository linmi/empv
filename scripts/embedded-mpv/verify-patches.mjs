#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 校验脚本：console 是其面向终端的输出通道 */
//
// verify-patches.mjs — fast, network-light preflight for the vendored mpv
// runtime patches. Run this BEFORE bumping the pinned mpv version:
//
//   pnpm --filter empv run verify:runtime-patches
//
// It fetches (or reuses the cached) PINNED mpv source archive, extracts a fresh
// clean tree, and `patch -p1 --dry-run`s every patch in patches/. It also
// asserts the invariants the build relies on. It NEVER runs meson/ninja/make or
// builds anything.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  mpvArchiveName,
  allMpvPatches,
  mpvSource,
  runtimeBuildRoot,
  videotoolboxGlBuildFlag,
  videotoolboxGlOption
} from './runtime-pins.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const patchesDir = path.join(scriptDir, 'patches')
const buildScriptPath = path.join(scriptDir, 'build-macos-runtime.mjs')

function log(message) {
  process.stdout.write(`[verify-runtime-patches] ${message}\n`)
}

function commandExists(command) {
  return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

// Candidate archive dirs the build script would have populated. When
// EMPV_BUILD_ROOT is set it is arch-independent; otherwise the build
// splits by arch, so probe both.
function candidateArchiveDirs() {
  if (process.env.EMPV_BUILD_ROOT) {
    return [path.join(runtimeBuildRoot('arm64'), 'archives')]
  }
  return ['arm64', 'x64'].map((arch) => path.join(runtimeBuildRoot(arch), 'archives'))
}

function findCachedArchive() {
  const name = mpvArchiveName()
  for (const dir of candidateArchiveDirs()) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

// Resolve the pinned mpv archive, preferring the build cache and only touching
// the network when nothing is cached. Downloads land in the host-arch build
// cache so a subsequent `build-runtime:macos` reuses them.
function resolveArchive() {
  const cached = findCachedArchive()
  if (cached) {
    log(`Using cached mpv archive: ${cached}`)
    return cached
  }

  if (!commandExists('curl')) {
    throw new Error(
      `No cached mpv archive found and curl is unavailable. Expected one of:\n` +
        candidateArchiveDirs()
          .map((dir) => `  ${path.join(dir, mpvArchiveName())}`)
          .join('\n')
    )
  }

  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const downloadDir = path.join(runtimeBuildRoot(hostArch), 'archives')
  const target = path.join(downloadDir, mpvArchiveName())
  fs.mkdirSync(downloadDir, { recursive: true })
  log(`No cached mpv archive found; downloading ${mpvSource.url}`)
  const result = spawnSync(
    'curl',
    ['-fL', '--retry', '3', '--retry-delay', '5', '-o', target, mpvSource.url],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    fs.rmSync(target, { force: true })
    throw new Error(
      `Failed to download pinned mpv source (${mpvSource.url}). ` +
        `Re-run with network access, or prime the cache via ` +
        `\`pnpm run build-runtime:macos\`, then retry.`
    )
  }
  return target
}

function extractFreshSource(archivePath) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empv-verify-mpv-patches-'))
  log(`Extracting a clean mpv ${mpvSource.version} tree into ${extractDir}`)
  const result = spawnSync(
    'tar',
    ['-xf', archivePath, '-C', extractDir, '--strip-components', '1'],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    fs.rmSync(extractDir, { recursive: true, force: true })
    throw new Error(`Failed to extract ${archivePath}`)
  }
  return extractDir
}

function readPatchHeaderRemovalCondition(patchPath) {
  const text = fs.readFileSync(patchPath, 'utf8')
  const start = text.indexOf('REMOVAL CONDITION')
  if (start === -1) {
    return null
  }
  const lines = text.slice(start).split(/\r?\n/)
  const collected = []
  for (const line of lines) {
    if (line.startsWith('---')) {
      break
    }
    collected.push(line.replace(/^#\s?/, ''))
    if (collected.length >= 8) {
      break
    }
  }
  return collected.join('\n').trim()
}

function dryRunPatch(patchName, extractDir, failures) {
  const patchPath = path.join(patchesDir, patchName)
  if (!fs.existsSync(patchPath)) {
    failures.push(`Missing patch file listed in mpvPatchesByPlatform: ${patchPath}`)
    return
  }

  // --forward is critical: without it, patch auto-assumes -R when it detects an
  // already-applied hunk and the dry-run "succeeds" (exit 0), silently hiding
  // the "upstream already relaxed the dependency" case. --forward makes patch
  // refuse to reverse and exit non-zero instead. input:'' keeps it fully
  // non-interactive (no "File to patch?" / "Assume -R?" prompts).
  const result = spawnSync('patch', ['-p1', '--forward', '--dry-run', '--input', patchPath], {
    cwd: extractDir,
    encoding: 'utf8',
    input: ''
  })

  if (result.status === 0) {
    log(`OK (dry-run applies cleanly): ${patchName}`)
    return
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  const removalCondition = readPatchHeaderRemovalCondition(patchPath)
  failures.push(
    [
      `Patch does NOT apply cleanly to pinned mpv ${mpvSource.version}: ${patchName}`,
      '',
      '--- patch --dry-run output ---',
      output || '(no output captured)',
      '--- end patch output ---',
      '',
      'This means one of:',
      "  1. Upstream moved the context around the patched block (a 'Hunk FAILED'",
      '     / reject or fuzzy match). Regenerate the patch against the new source.',
      '  2. Upstream ALREADY RELAXED the videotoolbox-gl dependency, so the patch',
      "     is now redundant. `patch --forward` reports this as 'Ignoring",
      "     previously applied (or reversed) patch.' If so, the patch is no longer",
      `     needed: delete ${patchName} AND drop ${videotoolboxGlBuildFlag} from`,
      '     build-macos-runtime.mjs.',
      ...(removalCondition
        ? ['', 'Removal condition (from the patch header):', removalCondition]
        : [])
    ].join('\n')
  )
}

function findMesonOptions(extractDir) {
  for (const name of ['meson.options', 'meson_options.txt']) {
    const candidate = path.join(extractDir, name)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function assertMesonOptionExists(extractDir, failures) {
  const optionsPath = findMesonOptions(extractDir)
  if (!optionsPath) {
    failures.push(
      `Could not find meson.options / meson_options.txt in the mpv source. ` +
        `Upstream may have restructured its build options; the ` +
        `${videotoolboxGlOption} invariant can no longer be verified.`
    )
    return
  }

  const text = fs.readFileSync(optionsPath, 'utf8')
  const optionPattern = new RegExp(`option\\(\\s*'${videotoolboxGlOption}'`)
  if (optionPattern.test(text)) {
    log(`OK: meson option '${videotoolboxGlOption}' exists in ${path.basename(optionsPath)}`)
    return
  }

  failures.push(
    `Meson option '${videotoolboxGlOption}' no longer exists in ` +
      `${path.basename(optionsPath)}. Upstream likely renamed or removed it. ` +
      `The videotoolbox-gl patch and ${videotoolboxGlBuildFlag} must be revisited.`
  )
}

function assertBuildScriptPassesFlag(failures) {
  const text = fs.readFileSync(buildScriptPath, 'utf8')
  if (text.includes(videotoolboxGlBuildFlag)) {
    log(`OK: build-macos-runtime.mjs still passes ${videotoolboxGlBuildFlag}`)
    return
  }

  failures.push(
    `build-macos-runtime.mjs no longer passes ${videotoolboxGlBuildFlag}. ` +
      `Without it the patched hwdec_mac_gl.c interop is silently dropped from the ` +
      `build. Either restore the flag, or (if intentionally removing the interop) ` +
      `delete the videotoolbox-gl patch as well.`
  )
}

function main() {
  log(`Verifying ${allMpvPatches.length} patch(es) against pinned mpv ${mpvSource.version}`)

  for (const tool of ['tar', 'patch']) {
    if (!commandExists(tool)) {
      throw new Error(`Required tool '${tool}' is not available on PATH.`)
    }
  }

  const failures = []
  const archivePath = resolveArchive()
  const extractDir = extractFreshSource(archivePath)

  try {
    for (const patchName of allMpvPatches) {
      dryRunPatch(patchName, extractDir, failures)
    }
    assertMesonOptionExists(extractDir, failures)
    assertBuildScriptPassesFlag(failures)
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.stderr.write('\n')
    for (const failure of failures) {
      process.stderr.write(`[verify-runtime-patches] FAIL\n${failure}\n\n`)
    }
    throw new Error(
      `${failures.length} runtime-patch check(s) failed for pinned mpv ${mpvSource.version}. ` +
        `See details above.`
    )
  }

  log(`All runtime-patch checks passed for pinned mpv ${mpvSource.version}.`)
}

try {
  main()
} catch (error) {
  console.error(
    `[verify-runtime-patches] ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
