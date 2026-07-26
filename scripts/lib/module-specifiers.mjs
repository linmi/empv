import { readFileSync } from 'node:fs'

import { parse } from '@babel/parser'

const BABEL_PLUGINS = ['typescript', 'jsx', 'importAttributes']

// Recursively visit every AST node, skipping location/comment metadata.
function walk(node, visitor) {
  if (!node || typeof node.type !== 'string') {
    return
  }

  visitor(node)

  for (const key of Object.keys(node)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments'
    ) {
      continue
    }

    const value = node[key]

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') {
          walk(child, visitor)
        }
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visitor)
    }
  }
}

/**
 * Collect runtime (non-type-only) module specifiers from a TS/TSX source file:
 * static `import` declarations, `export … from` re-exports, and dynamic `import()`
 * calls with a string-literal argument. Type-only imports/exports are erased at
 * runtime and therefore skipped, matching Node's ESM resolution surface.
 *
 * @param {string} filePath absolute path to the source file
 * @returns {Array<{ text: string, line: number, column: number }>} 1-based locations
 */
export function collectModuleSpecifiers(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: BABEL_PLUGINS })
  const specifiers = []

  const record = (node) => {
    if (node && node.type === 'StringLiteral') {
      specifiers.push({
        text: node.value,
        line: node.loc.start.line,
        column: node.loc.start.column + 1
      })
    }
  }

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind !== 'type') {
        record(statement.source)
      }
    } else if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportAllDeclaration'
    ) {
      if (statement.exportKind !== 'type' && statement.source) {
        record(statement.source)
      }
    }
  }

  walk(ast.program, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Import' &&
      node.arguments.length > 0
    ) {
      record(node.arguments[0])
    }
  })

  return specifiers
}
