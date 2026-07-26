#!/usr/bin/env node
/* oxlint-disable no-console -- Windows runtime preparation CLI */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { windowsMpvDevPackage } from './runtime-pins.mjs'

const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const [outputPrefix] = args

function fail(message) {
  throw new Error(message)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })

  if (result.error) {
    fail(`Failed to execute ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`
      : ''
    fail(`${command} exited with status ${String(result.status)}.${detail}`)
  }

  return result.stdout ?? ''
}

function assertFile(filePath, description) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    fail(`${description} does not exist: ${filePath}`)
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function assertEmptyDestination(destination) {
  if (!existsSync(destination)) {
    return
  }
  if (!statSync(destination).isDirectory()) {
    fail(`Output prefix exists and is not a directory: ${destination}`)
  }
  if (readdirSync(destination).length > 0) {
    fail(
      `Output prefix must be absent or empty; refusing to overwrite existing files: ${destination}`
    )
  }
}

function parseExports(dumpbinOutput) {
  const exports = []
  for (const line of dumpbinOutput.split(/\r?\n/)) {
    const match = line.match(/^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(\S+)/)
    if (match) {
      exports.push(match[1])
    }
  }
  return exports
}

function main() {
  if (process.platform !== 'win32') {
    fail(`prepare-windows-runtime.mjs requires Windows, got ${process.platform}.`)
  }
  if (process.arch !== 'x64') {
    fail(`The pinned Windows runtime supports x64 only, got ${process.arch}.`)
  }
  if (!outputPrefix) {
    fail('Usage: pnpm --filter empv prepare-runtime:windows -- <empty-output-prefix>')
  }

  const prefix = path.resolve(outputPrefix)
  assertEmptyDestination(prefix)
  mkdirSync(prefix, { recursive: true })

  const workDirectory = path.join(prefix, '_work')
  const extractedDirectory = path.join(workDirectory, 'extracted')
  const archivePath = path.join(workDirectory, 'mpv-dev.7z')
  const suppliedArchive = process.env.EMPV_WINDOWS_DEV_ASSET

  mkdirSync(extractedDirectory, { recursive: true })
  if (suppliedArchive) {
    const resolvedArchive = path.resolve(suppliedArchive)
    assertFile(resolvedArchive, 'Supplied Windows mpv development archive')
    cpSync(resolvedArchive, archivePath)
    console.log(`Using supplied pinned Windows mpv archive: ${resolvedArchive}`)
  } else {
    console.log(
      `Downloading pinned Windows mpv development archive ${windowsMpvDevPackage.version}`
    )
    run('curl.exe', ['-L', '--fail', '--retry', '3', '-o', archivePath, windowsMpvDevPackage.url])
  }

  const actualSha256 = sha256(archivePath)
  if (actualSha256 !== windowsMpvDevPackage.sha256) {
    fail(
      `Windows mpv archive SHA256 mismatch: got ${actualSha256}, ` +
        `expected ${windowsMpvDevPackage.sha256}.`
    )
  }

  run('tar.exe', ['-xf', archivePath, '-C', extractedDirectory])

  const includeDirectory = path.join(extractedDirectory, 'include')
  const headerPath = path.join(includeDirectory, 'mpv', 'client.h')
  const dllPath = path.join(extractedDirectory, windowsMpvDevPackage.dllName)
  assertFile(headerPath, 'Pinned Windows mpv client header')
  assertFile(dllPath, 'Pinned Windows mpv runtime DLL')

  const dumpbinOutput = run('dumpbin.exe', ['/nologo', '/exports', dllPath], {
    capture: true
  })
  const exports = parseExports(dumpbinOutput)
  if (exports.length === 0) {
    fail(`No exports were parsed from ${dllPath}.`)
  }

  const outputIncludeDirectory = path.join(prefix, 'include')
  const outputLibraryDirectory = path.join(prefix, 'lib')
  const outputBinaryDirectory = path.join(prefix, 'bin')
  const defPath = path.join(outputLibraryDirectory, 'mpv.def')
  const importLibraryPath = path.join(outputLibraryDirectory, 'mpv.lib')
  const outputDllPath = path.join(outputBinaryDirectory, windowsMpvDevPackage.dllName)

  mkdirSync(outputLibraryDirectory, { recursive: true })
  mkdirSync(outputBinaryDirectory, { recursive: true })
  cpSync(includeDirectory, outputIncludeDirectory, { recursive: true })
  cpSync(dllPath, outputDllPath)
  writeFileSync(defPath, `EXPORTS\n${exports.join('\n')}\n`, 'ascii')
  run('lib.exe', [
    '/nologo',
    `/def:${defPath}`,
    '/machine:x64',
    `/name:${windowsMpvDevPackage.dllName}`,
    `/out:${importLibraryPath}`
  ])
  assertFile(importLibraryPath, 'Generated MSVC COFF import library')

  writeFileSync(
    path.join(prefix, 'runtime-manifest.json'),
    `${JSON.stringify(
      {
        origin: 'ci-compile-input',
        platform: 'win32',
        arch: 'x64',
        version: windowsMpvDevPackage.version,
        sourceUrl: windowsMpvDevPackage.url,
        sha256: windowsMpvDevPackage.sha256,
        dllName: windowsMpvDevPackage.dllName,
        note: 'Compile and interactive smoke input only; not an LGPL release runtime.'
      },
      null,
      2
    )}\n`
  )

  rmSync(workDirectory, { recursive: true, force: true })
  console.log(`Prepared Windows libmpv compile input at ${prefix}`)
  console.log(`Parsed ${exports.length} exports and generated ${importLibraryPath}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
