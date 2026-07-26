import os from 'os'
import path from 'path'

// Single source of truth for the pinned mpv runtime inputs.
//
// build-macos-runtime.mjs (source build) and verify-patches.mjs (patch
// dry-run) both import from here so the version pin, patch list, and cache
// location can never drift between "what we build" and "what we verify".

// Pinned mpv source. When bumping the version, update ONLY this object and run
// `pnpm run verify:runtime-patches` before rebuilding.
export const mpvSource = {
  id: 'mpv',
  version: '0.41.0',
  url: 'https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz',
  license: 'LGPL-compatible configuration with -Dgpl=false'
}

// Windows CI and the interactive hardware gate compile against this exact
// upstream development archive. It is compile/test input only: the archive is
// not promoted to the packaged vendored runtime because its upstream build
// configuration is outside our LGPL release pipeline.
export const windowsMpvDevPackage = {
  version: '20260718-git-94335ab87a',
  url: 'https://github.com/zhongfly/mpv-winbuild/releases/download/2026-07-18-94335ab87a/mpv-dev-x86_64-20260718-git-94335ab87a.7z',
  sha256: '55a75e13533aaf7299029fd9e6fe152332d23905d4322be88f9d37a5eea19fed',
  dllName: 'libmpv-2.dll'
}

// mpv source patches applied (in order) after extraction, before configuring.
// Keep in sync with scripts/embedded-mpv/patches/ and record in the manifest.
export const mpvPatches = ['mpv-videotoolbox-gl-without-cocoa.patch']

// Invariants the videotoolbox-gl patch depends on:
// - the meson option it toggles must still exist in the source's meson.options
// - the build must still request it via this exact flag, otherwise the patched
//   hwdec_mac_gl.c interop is silently dropped from the build.
export const videotoolboxGlOption = 'videotoolbox-gl'
export const videotoolboxGlBuildFlag = '-Dvideotoolbox-gl=enabled'

// Where build-macos-runtime.mjs lands downloaded archives and extracted
// sources for a given arch. verify-patches.mjs reuses this to find (and prime)
// the same archive cache.
export function runtimeBuildRoot(arch) {
  return path.resolve(
    process.env.EMPV_BUILD_ROOT ?? path.join(os.tmpdir(), 'empv-runtime-build', arch)
  )
}

// Archive filename the build writes under <buildRoot>/archives for the pinned
// mpv source (matches build-macos-runtime.mjs archivePathFor()).
export function mpvArchiveName() {
  const extension = mpvSource.url.endsWith('.tar.xz') ? '.tar.xz' : '.tar.gz'
  return `${mpvSource.id}-${mpvSource.version}${extension}`
}
