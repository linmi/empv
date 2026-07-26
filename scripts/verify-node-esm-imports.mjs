#!/usr/bin/env node
/* oxlint-disable no-console -- CLI 校验脚本：console 是其面向终端的输出通道 */
// empv ships standalone, so it carries its own copy of this check rather than
// reaching into a workspace-root script. `repositoryRoot` below resolves to the
// package root here, which is exactly the reporting root a standalone package
// wants.
import { existsSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectModuleSpecifiers } from './lib/module-specifiers.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const runtimeExtensions = new Set(['.cjs', '.js', '.json', '.mjs', '.node', '.ts', '.tsx'])
const suggestedExtensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.node']
const ignoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
  'vendor'
])

function usage() {
  return `Usage: node scripts/verify-node-esm-imports.mjs --root <path> [--root <path> ...]

Options:
  --root <path>  Source directory to scan for Node ESM runtime imports.
  --help         Show this help text.`
}

function takeValue(args, index, name) {
  const value = args[index + 1]

  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }

  return value
}

function parseArgs(argv) {
  const options = {
    roots: [],
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--root':
        options.roots.push(resolve(takeValue(argv, index, arg)))
        index += 1
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function listTypeScriptFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) {
        files.push(...listTypeScriptFiles(entryPath))
      }
      continue
    }

    if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(entryPath)
    }
  }

  return files
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function stripSpecifierSuffix(specifier) {
  const suffixIndex = specifier.search(/[?#]/)
  return suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex)
}

function findExistingTarget(importerPath, specifierPath) {
  const basePath = resolve(dirname(importerPath), specifierPath)

  if (existsSync(basePath)) {
    return basePath
  }

  for (const extension of suggestedExtensions) {
    const candidate = `${basePath}${extension}`

    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function formatLocation(importerPath, specifier) {
  return `${relative(repositoryRoot, importerPath)}:${specifier.line}:${specifier.column}`
}

function collectSpecifierIssue(importerPath, specifier) {
  if (!isRelativeSpecifier(specifier.text)) {
    return null
  }

  const specifierPath = stripSpecifierSuffix(specifier.text)
  const extension = extname(specifierPath)
  const location = formatLocation(importerPath, specifier)

  if (!runtimeExtensions.has(extension)) {
    const existingTarget = findExistingTarget(importerPath, specifierPath)
    const suggestion = existingTarget ? ` Use '${specifierPath}${extname(existingTarget)}'.` : ''
    return `${location} Relative Node ESM runtime import must include a file extension: '${specifier.text}'.${suggestion}`
  }

  const targetPath = resolve(dirname(importerPath), specifierPath)

  if (!existsSync(targetPath)) {
    return `${location} Relative Node ESM runtime import points to a missing file: '${specifier.text}'.`
  }

  return null
}

function collectIssues(filePath) {
  return collectModuleSpecifiers(filePath)
    .map((specifier) => collectSpecifierIssue(filePath, specifier))
    .filter((issue) => issue !== null)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(usage())
    return
  }

  if (options.roots.length === 0) {
    throw new Error('At least one --root path is required.')
  }

  const files = [...new Set(options.roots.flatMap(listTypeScriptFiles))]
  const issues = files.flatMap(collectIssues)

  if (issues.length > 0) {
    console.error('[node-esm-imports] Invalid runtime imports:')
    for (const issue of issues) {
      console.error(`- ${issue}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`[node-esm-imports] Checked ${files.length} files.`)
}

try {
  main()
} catch (error) {
  console.error(`[node-esm-imports] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
