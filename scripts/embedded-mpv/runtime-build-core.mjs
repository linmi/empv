// The parts of a from-source libmpv build that do not depend on which platform
// is being built for: fetching the pinned sources, proving they are the pinned
// sources, applying the mpv patches, and recording all of it.
//
// What stays in the per-platform scripts is everything that genuinely differs --
// the configure and meson flags, the order things are built in, how the result
// is linked, and what "correctly linked" means for that platform. Those are not
// variations on a theme; a macOS dylib graph with @loader_path install names and
// a single self-contained Windows DLL have nothing mechanical in common.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

export function log(message) {
  process.stdout.write(`[embedded-mpv-runtime] ${message}\n`)
}

export function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    ...options
  })

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${result.status ?? 1}.`)
  }
}

export function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: 'pipe',
    // spawnSync's 1MB default is not enough for the output these builds
    // produce: `objdump -p` on a 50MB statically linked DLL runs to tens of
    // megabytes, and the failure it causes is an ENOBUFS spawn error that
    // reads as though the tool is missing rather than too talkative.
    maxBuffer: 256 * 1024 * 1024,
    ...options
  })

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : ''
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with status ${result.status ?? 1}.${stderr}`
    )
  }

  return result.stdout.trim()
}

export function commandExists(command) {
  return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

export function ensureTools(requiredCommands) {
  const missing = requiredCommands.filter((command) => !commandExists(command))
  if (missing.length > 0) {
    throw new Error(`Missing required build tools: ${missing.join(', ')}`)
  }
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function archivePathFor(archiveRoot, sourcePackage) {
  const extension = sourcePackage.url.endsWith('.tar.xz') ? '.tar.xz' : '.tar.gz'
  return path.join(archiveRoot, `${sourcePackage.id}-${sourcePackage.version}${extension}`)
}

// libplacebo is a git checkout rather than a release archive, and its submodules
// are build inputs, so both the commit and the submodule states are recorded --
// a manifest that named only the tag would not identify what was built.
const LIBPLACEBO_SUBMODULES = [
  '3rdparty/glad',
  '3rdparty/jinja',
  '3rdparty/markupsafe',
  '3rdparty/fast_float',
  '3rdparty/Vulkan-Headers'
]

function cloneGitSource(sourcePackage, packageSourcePath, env) {
  fs.rmSync(packageSourcePath, { recursive: true, force: true })

  run(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      sourcePackage.tag,
      sourcePackage.gitUrl,
      packageSourcePath
    ],
    { env }
  )
  run('git', ['submodule', 'update', '--init', '--depth', '1', ...LIBPLACEBO_SUBMODULES], {
    cwd: packageSourcePath,
    env
  })

  sourcePackage.gitCommit = runCapture('git', ['rev-parse', 'HEAD'], {
    cwd: packageSourcePath,
    env
  })
  sourcePackage.submodules = runCapture('git', ['submodule', 'status', ...LIBPLACEBO_SUBMODULES], {
    cwd: packageSourcePath,
    env
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/// Fetches every pinned source into `sourceRoot`, reusing archives already in
/// `archiveRoot`. Mutates each package with the digest or commit it resolved to,
/// which is what the manifest later reports.
export function downloadSources({ sourcePackages, archiveRoot, sourceRoot, sourcePathFor, env }) {
  fs.mkdirSync(archiveRoot, { recursive: true })
  fs.mkdirSync(sourceRoot, { recursive: true })

  for (const sourcePackage of sourcePackages) {
    const packageSourcePath = sourcePathFor(sourcePackage.id)

    if (sourcePackage.gitUrl) {
      cloneGitSource(sourcePackage, packageSourcePath, env)
      continue
    }

    const archivePath = archivePathFor(archiveRoot, sourcePackage)
    if (!fs.existsSync(archivePath)) {
      run(
        'curl',
        ['-fL', '--retry', '3', '--retry-delay', '5', '-o', archivePath, sourcePackage.url],
        {
          env
        }
      )
    }

    fs.rmSync(packageSourcePath, { recursive: true, force: true })
    fs.mkdirSync(packageSourcePath, { recursive: true })
    run('tar', ['-xf', archivePath, '-C', packageSourcePath, '--strip-components', '1'], { env })
    sourcePackage.sha256 = sha256File(archivePath)
  }
}

/// Applies the pinned mpv patches to a freshly extracted tree and records which
/// ones were applied. The tree is always unpatched at this point, so a failure
/// means the patch no longer matches the pinned mpv source -- which is exactly
/// what should stop a build rather than be worked around.
export function applyMpvPatches({ mpvPackage, mpvSourcePath, patchesDir, patchNames, env }) {
  const applied = []

  for (const patchName of patchNames) {
    const patchPath = path.join(patchesDir, patchName)
    if (!fs.existsSync(patchPath)) {
      throw new Error(`Missing mpv patch: ${patchPath}`)
    }

    log(`Applying mpv patch ${patchName}`)
    run('patch', ['-p1', '--input', patchPath], { cwd: mpvSourcePath, env })
    applied.push(patchName)
  }

  mpvPackage.patches = applied
}

/// The features meson says it enabled, out of its configure output.
///
/// meson prints "List of enabled features: a b c" and then exits 0 whether or
/// not the build lost something important, so this line is the only place a
/// silently disabled feature is visible.
export function parseReportedFeatures(mesonOutput) {
  const summary = mesonOutput
    .split(/\r?\n/)
    .find((line) => line.includes('List of enabled features:'))
  if (!summary) {
    throw new Error('meson did not report a feature list; its output format changed.')
  }

  return new Set(summary.split('List of enabled features:')[1].trim().split(/\s+/).filter(Boolean))
}

export function missingFeatures(mesonOutput, requiredFeatures) {
  const enabled = parseReportedFeatures(mesonOutput)
  return requiredFeatures.filter((feature) => !enabled.has(feature))
}

/// Imports a self-contained library must not have: anything this build produced
/// (it should have been linked in) and any compiler runtime (it would have to
/// ship alongside).
///
/// Expressed as a rule rather than as a list of permitted system DLLs, because
/// an allowlist needs editing whenever mpv reaches for a new Windows API and
/// would start rejecting correct builds.
///
/// @param {string[]} importedNames
/// @param {{ builtHere: string[] }} options
/// @returns {{ imported: string, reason: string }[]}
export function foreignImports(importedNames, { builtHere }) {
  const compilerRuntime = /^(libgcc_s|libwinpthread|libstdc\+\+|libssp|libatomic|libquadmath)/i
  const stems = new Set(
    builtHere.flatMap((name) => [name.toLowerCase(), `lib${name}`.toLowerCase()])
  )

  return importedNames.flatMap((imported) => {
    if (compilerRuntime.test(imported)) {
      return [{ imported, reason: 'compiler runtime' }]
    }
    if (stems.has(imported.replace(/-?\d*\.dll$/i, '').toLowerCase())) {
      return [{ imported, reason: 'built here, should have been linked in' }]
    }
    return []
  })
}

export function sourceMetadata(sourcePackage) {
  return {
    version: sourcePackage.version,
    sourceUrl: sourcePackage.url ?? sourcePackage.gitUrl,
    ...(sourcePackage.tag ? { sourceTag: sourcePackage.tag } : {}),
    ...(sourcePackage.sha256 ? { sourceSha256: sourcePackage.sha256 } : {}),
    ...(sourcePackage.gitCommit ? { sourceGitCommit: sourcePackage.gitCommit } : {}),
    ...(sourcePackage.submodules ? { sourceSubmodules: sourcePackage.submodules } : {}),
    ...(sourcePackage.patches ? { patches: sourcePackage.patches } : {}),
    license: sourcePackage.license
  }
}

export function packagesMetadata(sourcePackages) {
  return Object.fromEntries(
    sourcePackages.map((sourcePackage) => [sourcePackage.id, sourceMetadata(sourcePackage)])
  )
}
