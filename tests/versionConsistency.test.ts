// A version bump touches more than one place, and every place it misses fails
// somewhere other than here.
//
// The platform packages are published with the main package's version, because
// that is what pack-platform-package.mjs stamps on them, while the main package
// asks for them by an exact version written by hand. Disagree, and npm resolves
// nothing: the optional dependency is skipped without an error, the resolver
// reports a missing addon, and the trail leads back to a number nobody changed.
//
// The install commands in the README carry the version too, in URLs that only
// exist once a release is cut. A stale one is a copy-pasteable 404.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const manifest: {
  version: string
  optionalDependencies?: Record<string, string>
} = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8')

test('every platform package is required at the version it will be published with', () => {
  const optional = manifest.optionalDependencies ?? {}
  const platformPackages = Object.keys(optional).filter((name) => name.startsWith('empv-'))

  // Guards the guard: an empty list would make the assertion below vacuous, and
  // this package is only installable because these exist.
  assert.ok(platformPackages.length >= 2, 'expected the platform packages to be optional deps')

  for (const name of platformPackages) {
    assert.equal(
      optional[name],
      manifest.version,
      `${name} is required at ${optional[name]} but will be published as ${manifest.version}`
    )
  }
})

test('the README install commands point at this version', () => {
  // Every release asset carries the version in its filename, so there is no
  // stable "latest" URL to use instead: the numbers in these commands have to
  // move when the version does.
  const referenced = [...readme.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)].map(
    (match) => match[1]
  )
  const tarballs = [...readme.matchAll(/empv[a-z0-9-]*-(\d+\.\d+\.\d+)\.tgz/g)].map(
    (match) => match[1]
  )

  assert.ok(referenced.length > 0, 'expected the README to show a release download URL')
  assert.ok(tarballs.length > 0, 'expected the README to name a release tarball')

  for (const version of [...referenced, ...tarballs]) {
    assert.equal(version, manifest.version, `README refers to ${version}`)
  }
})
