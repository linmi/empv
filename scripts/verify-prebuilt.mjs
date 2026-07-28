#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 校验脚本：console 是其面向终端的输出通道 */
//
// Proves the claim `npm install empv` makes: that a machine with no Rust
// toolchain and no staged runtime can load the addon.
//
// It packs the main package and the platform package, installs both into an
// empty project outside this repository, and drives a real mpv session there.
// Nothing about that is simulated -- the failure this guards against is the
// tarball being subtly wrong (a file the `files` list forgot, a dylib present
// under a name nothing loads), and only a real install and a real dlopen can
// see those.
//
//   node scripts/verify-prebuilt.mjs
//   node scripts/verify-prebuilt.mjs --allow-non-release-runtime
//
// The flag is for CI, which has a Homebrew runtime rather than the vendored LGPL
// one: the mechanism is worth checking on every push even where the artefact
// would not be publishable.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platformKey = `${process.platform}-${process.arch}`
const platformPackageName = `empv-${platformKey}`

function log(message) {
  console.log(`[verify-prebuilt] ${message}`)
}

// npm and pnpm are .cmd shims on Windows, and Node refuses to spawn a .cmd or
// .bat without a shell -- the CVE-2024-27980 mitigation. Naming the shim gets
// EINVAL, not ENOENT, so the first fix for this replaced one confusing error
// with another.
//
// A shell is therefore required, and that means arguments stop being passed as
// argv and start being parsed by cmd. Only these two commands get it, and only
// their arguments are quoted, so nothing else in this script changes shape on
// one platform.
function quoteForCmd(value) {
  return /[\s"&|<>^()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

function spawnPlan(command, args) {
  const isShim = process.platform === 'win32' && (command === 'npm' || command === 'pnpm')
  return isShim
    ? { command, args: args.map(quoteForCmd), shell: true }
    : { command, args, shell: false }
}

function run(command, args, options = {}) {
  const plan = spawnPlan(command, args)
  const result = spawnSync(plan.command, plan.args, {
    shell: plan.shell,
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.inherit ? '' : `\n${[result.stdout, result.stderr].join('\n').trim()}`
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}.${detail}`)
  }
  return result.stdout ?? ''
}

// npm pack prints the tarball it wrote as the last line of stdout. Reading the
// directory instead and taking the last entry sorts alphabetically, which
// silently returns empv-darwin-arm64-*.tgz for both packs and leaves the main
// package uninstalled.
function packInto(directory, cwd) {
  const stdout = run('npm', ['pack', '--pack-destination', directory], { cwd })
  const name = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .pop()
  if (!name) throw new Error(`npm pack did not report a tarball for ${cwd}.`)
  const tarball = path.join(directory, name)
  if (!existsSync(tarball)) throw new Error(`npm pack reported ${name}, which is not there.`)
  return tarball
}

function main() {
  const allowNonRelease = process.argv.includes('--allow-non-release-runtime')

  const platformPackage = path.join(packageRoot, 'platform-packages', platformPackageName)
  const packArgs = ['scripts/pack-platform-package.mjs', process.platform, process.arch]
  if (allowNonRelease) packArgs.push('--allow-non-release-runtime')
  run(process.execPath, packArgs, { inherit: true })
  if (!existsSync(platformPackage)) {
    throw new Error(`The platform package was not produced at ${platformPackage}.`)
  }

  run('pnpm', ['run', 'build'], { inherit: true })

  const workspace = mkdtempSync(path.join(tmpdir(), 'empv-verify-prebuilt-'))
  try {
    const tarballs = path.join(workspace, 'tarballs')
    const project = path.join(workspace, 'project')
    mkdirSync(tarballs)
    mkdirSync(project)

    const platformTarball = packInto(tarballs, platformPackage)
    const mainTarball = packInto(tarballs, packageRoot)
    log(`packed ${path.basename(platformTarball)} and ${path.basename(mainTarball)}`)

    run('npm', ['init', '-y'], { cwd: project })
    // The platform package is an optionalDependency that is not on the registry
    // yet, so it is installed explicitly. Once published, npm picks it up on its
    // own through the os/cpu fields.
    run('npm', ['install', platformTarball, mainTarball], { cwd: project })
    log('installed both tarballs into a project outside this repository')

    const probe = `
      import {
        resolveLibMpvRuntime,
        loadEmbeddedLibMpvAddon,
        loadEmbeddedLibMpvPresenterAddon
      } from 'empv'
      const runtime = await resolveLibMpvRuntime()
      if (!runtime.available) {
        throw new Error('The installed prebuilt did not resolve: missing ' + runtime.missing.join(', '))
      }
      if (!runtime.runtimeDirectory.includes('${platformPackageName}')) {
        throw new Error('Resolved ' + runtime.runtimeDirectory + ', not the installed prebuilt.')
      }
      const loaded = await loadEmbeddedLibMpvAddon()
      if ('createPresenter' in loaded.addon || 'startPresenterLink' in loaded.addon) {
        throw new Error('The runtime addon still exports the main-process presenter API.')
      }
      let presenterKind = 'not-required'
      if (process.platform === 'darwin') {
        const presenter = await loadEmbeddedLibMpvPresenterAddon()
        if ('createSession' in presenter.addon || 'configureFrameLink' in presenter.addon) {
          throw new Error('The presenter addon still exports the libmpv runtime API.')
        }
        presenterKind = presenter.addon.getPresenterKind()
      }
      const sessionId = await loaded.addon.createSession({ volume: 1 }, () => {}, () => {})
      const status = loaded.addon.getSessionSnapshot(sessionId)?.status
      await loaded.addon.disposeSession(sessionId)
      console.log(
        'kind=' + loaded.presentationKind +
        ' presenter=' + presenterKind +
        ' session=' + sessionId +
        ' status=' + status
      )
    `
    const output = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: project })
    log(output.trim())
    log('PASS: a project with no Rust toolchain and no staged runtime played through the prebuilt.')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`[verify-prebuilt] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
