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

// The compile gate and the interactive hardware gate build against this exact
// upstream development archive, and nothing else does. It is compile/test input
// and can never be shipped: the DLL is a GPL build -- its embedded mpv
// configuration carries no -Dgpl=false (mpv defaults to true) and enables
// libbluray, dvdnav and vapoursynth, and the binary exports libx264/libx265
// symbols, so its FFmpeg was configured --enable-gpl. Redistributing it inside
// an Apache-2.0 package would put that whole distribution under the GPL.
//
// What ships is built by build-windows-runtime.mjs instead. This stays because
// the gate runs on every push and cross-compiling seven packages to answer
// "does the addon still compile" would be paying an hour to learn a minute's
// worth; the release is where the shipped runtime is built and verified.
export const windowsMpvDevPackage = {
  version: '20260718-git-94335ab87a',
  url: 'https://github.com/zhongfly/mpv-winbuild/releases/download/2026-07-18-94335ab87a/mpv-dev-x86_64-20260718-git-94335ab87a.7z',
  sha256: '55a75e13533aaf7299029fd9e6fe152332d23905d4322be88f9d37a5eea19fed',
  dllName: 'libmpv-2.dll'
}

// mpv source patches applied (in order) after extraction, before configuring.
// Keyed by platform because a patch is not automatically portable: the
// videotoolbox one adds an unconditional dependency('appleframeworks', ...) to
// meson.build, so applying it to a Windows cross build fails configure with
// "Dependency appleframeworks not found" and nothing in that message points at
// a patch. Keep in sync with scripts/embedded-mpv/patches/.
export const mpvPatchesByPlatform = {
  darwin: ['mpv-videotoolbox-gl-without-cocoa.patch'],
  win32: ['mpv-shaderc-spirv-cross-static-pkgconfig.patch']
}

// Every patch, for the dry-run gate: whether a patch still applies to the
// pinned source is a question about the source, not about who consumes it.
export const allMpvPatches = [...new Set(Object.values(mpvPatchesByPlatform).flat())]

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
