// Produces the MSVC import library that link.exe needs to link against a DLL.
//
// Windows cannot link against a DLL directly, and the .dll.a that MinGW's
// linker emits is a GNU archive that link.exe will not read. The way across is
// the DLL's own export table: dumpbin lists it, lib.exe turns a .def built from
// that list into a COFF import library, and the MSVC-built addon links that.
//
// Both callers need this and neither should own it: prepare-windows-runtime
// does it for the pinned upstream dev DLL that the compile gate builds against,
// and the release does it for the LGPL DLL cross-built from pinned sources.
/* oxlint-disable no-console -- 直接执行时是 CLI，console 就是它的输出通道 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) {
    throw new Error(`Failed to execute ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${String(result.status)}.\n${[result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim()}`
    )
  }
  return result.stdout ?? ''
}

// dumpbin's export table rows are "ordinal hint RVA name". Anything else in the
// output -- headers, summaries, the blank lines between them -- does not match.
export function parseExports(dumpbinOutput) {
  const exports = []
  for (const line of dumpbinOutput.split(/\r?\n/)) {
    const match = line.match(/^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(\S+)/)
    if (match) {
      exports.push(match[1])
    }
  }
  return exports
}

/// Writes `mpv.def` and `mpv.lib` into `outputLibraryDirectory` and returns the
/// import library path. Requires dumpbin.exe and lib.exe, which means an MSVC
/// developer environment.
export function createMsvcImportLibrary({ dllPath, outputLibraryDirectory, machine = 'x64' }) {
  if (process.platform !== 'win32') {
    throw new Error(
      `Import libraries are generated with MSVC tooling, so on Windows only; got ${process.platform}.`
    )
  }
  if (!existsSync(dllPath)) {
    throw new Error(`No DLL to generate an import library from: ${dllPath}`)
  }

  const exports = parseExports(run('dumpbin.exe', ['/nologo', '/exports', dllPath]))
  if (exports.length === 0) {
    throw new Error(`No exports were parsed from ${dllPath}.`)
  }

  mkdirSync(outputLibraryDirectory, { recursive: true })
  const defPath = path.join(outputLibraryDirectory, 'mpv.def')
  const importLibraryPath = path.join(outputLibraryDirectory, 'mpv.lib')

  writeFileSync(defPath, `EXPORTS\n${exports.join('\n')}\n`, 'ascii')
  run('lib.exe', [
    '/nologo',
    `/def:${defPath}`,
    `/machine:${machine}`,
    `/name:${path.basename(dllPath)}`,
    `/out:${importLibraryPath}`
  ])

  if (!existsSync(importLibraryPath)) {
    throw new Error(`lib.exe reported success but produced no ${importLibraryPath}.`)
  }

  return { importLibraryPath, exportCount: exports.length }
}

// Also runnable directly, which is how the release job turns the cross-built
// libmpv-2.dll into something link.exe can use:
//
//   node scripts/embedded-mpv/msvc-import-lib.mjs <dll-path> <output-lib-dir>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dllPath, outputLibraryDirectory] = process.argv.slice(2)
  if (!dllPath || !outputLibraryDirectory) {
    console.error(
      'Usage: node scripts/embedded-mpv/msvc-import-lib.mjs <dll-path> <output-lib-dir>'
    )
    process.exit(1)
  }
  try {
    const { importLibraryPath, exportCount } = createMsvcImportLibrary({
      dllPath: path.resolve(dllPath),
      outputLibraryDirectory: path.resolve(outputLibraryDirectory)
    })
    console.log(`[msvc-import-lib] ${importLibraryPath} (${exportCount} exports)`)
  } catch (error) {
    console.error(`[msvc-import-lib] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
