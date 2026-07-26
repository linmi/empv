# Third-Party Notices

empv itself is Apache-2.0 licensed (see `LICENSE` and `NOTICE`). It links
against, and ships tooling to build, third-party components under their own
licenses. This file records what those are and how empv satisfies their terms.

## 1. Source code derived from IPTVnator

The original native integration was derived from IPTVnator commit
`06700b318ab84edf78e97bdd99dc76829cb4d633` ("feat(electron): add embedded mpv
support for windows and linux", #1031).

- Repository: https://github.com/4gray/iptvnator
- License: MIT, Copyright 2020-2021
- Original license text: `third-party/iptvnator/LICENSE.md`
- Scope of the derivation: `third-party/iptvnator/NOTICE.md`

The files that descend from it have since been rewritten (the C++/Objective-C++
node-gyp addon became a Rust/napi-rs addon with thin platform shims), but the
attribution stands. The MIT License permits redistributing a derivative work
under other terms provided the original notice is retained, which is why empv as
a whole is Apache-2.0 while those portions keep their MIT notice here and in
`third-party/iptvnator/`.

## 2. The libmpv runtime

The addon does not statically link mpv. It loads a **separately built,
dynamically linked** libmpv at run time, resolved by `resolveLibMpvRuntime()`.

The main `empv` tarball carries no runtime at all. The per-platform prebuilt
packages (`empv-darwin-arm64`, `empv-darwin-x64`, `empv-win32-x64`) do carry
one, built from the pinned sources below, and you can also build or supply your
own with the scripts under `scripts/embedded-mpv/`.

How that runtime is laid out differs by platform, and the difference matters for
§2.1 below. macOS ships the libraries as separate dylibs resolved through
`@loader_path/lib`. Windows ships **one** `libmpv-2.dll` with FFmpeg, libass,
libplacebo and the font stack linked into it statically -- not a preference but
a consequence of how Windows resolves transitive DLL dependencies for a
dynamically loaded module. Everything inside that DLL is LGPL, MIT, ISC or the
FreeType licence, so the combined library is LGPL-2.1-or-later.

The pinned build (see `scripts/embedded-mpv/runtime-pins.mjs` and the
`runtime-manifest.json` that every staged runtime carries) produces:

| Component    | Version | License                                                               |
| ------------ | ------- | --------------------------------------------------------------------- |
| mpv (libmpv) | 0.41.0  | LGPL-2.1-or-later (built with `-Dgpl=false`)                          |
| FFmpeg       | 8.1     | LGPL-2.1-or-later (built without `--enable-gpl` / `--enable-nonfree`) |
| libplacebo   | 7.360.1 | LGPL-2.1-or-later                                                     |
| fribidi      | 1.0.16  | LGPL-2.1-or-later                                                     |
| libass       | 0.17.3  | ISC                                                                   |
| HarfBuzz     | 8.5.0   | MIT ("Old MIT")                                                       |
| FreeType     | 2.13.3  | FreeType License or GPL-2.0-or-later                                  |

Exact source URLs and SHA-256 checksums for the archives are recorded per build
in `runtime-manifest.json` under `packages.<name>.sourceUrl` /
`.sourceSha256`, alongside the applied patches and the full mpv Meson flags and
FFmpeg configure flags. That manifest — not this table — is the authoritative
record for any given binary you ship.

The full text of the LGPL-2.1 is in `third-party/LGPL-2.1.txt`.

### 2.1 How the LGPL is satisfied

LGPL-2.1 §6 requires that a user be able to modify the LGPL libraries and relink
the work that uses them. empv satisfies this by construction:

1. **The addon links libmpv dynamically.** `libmpv.2.dylib` / `libmpv-2.dll` /
   `libmpv.so.2` is loaded at run time; nothing LGPL is linked into
   `empv.node`. This is the boundary that matters, because `empv.node` is the
   only part of the work that is not itself LGPL.
2. **libmpv is replaceable in place.** The runtime directory is plain files.
   Replacing the libmpv of the same soname/ABI with your own build is
   sufficient — no rebuild of empv is required. On macOS the addon resolves it
   through `@loader_path/lib`, on Linux through `$ORIGIN/lib`, on Windows from
   the directory the addon itself was loaded from.

   Stated precisely, because the two platforms differ: on macOS you can also
   replace an individual dependency, since FFmpeg and the rest are separate
   dylibs. On Windows they are inside `libmpv-2.dll`, so replacing FFmpeg alone
   means rebuilding that DLL — which is what point 4 exists to make possible,
   and why the Windows build recipe is pinned and published in full rather than
   described.

3. **The runtime location is overridable.** `EMPV_RUNTIME_DIR`,
   `EMPV_LIBRARY_PATH` and `EMPV_ADDON_PATH` let a user point empv at a
   different runtime entirely, without touching the application bundle.
4. **The build is reproducible from published inputs.** Source URLs, checksums,
   patches and build flags are pinned in `scripts/embedded-mpv/runtime-pins.mjs`
   and recorded in the manifest. `pnpm run build-runtime:macos` and
   `pnpm run build-runtime:windows` rebuild the runtime from those exact inputs;
   the Windows one cross-compiles with MinGW-w64 and runs on Linux or any host
   with the toolchain.

If you redistribute a binary that bundles this runtime, you must ship with it:
the LGPL-2.1 text (`third-party/LGPL-2.1.txt`), this notice, the build's
`runtime-manifest.json`, the local patches under
`scripts/embedded-mpv/patches/`, and either the corresponding source archives or
a written offer to supply them. `runtime-manifest.json` carries a
`sourceDistribution` field stating exactly this.

### 2.2 Local patches applied to mpv

- `scripts/embedded-mpv/patches/mpv-videotoolbox-gl-without-cocoa.patch`
  (macOS builds only; the Windows build applies no patches) — relaxes mpv's
  `meson.build` so the `videotoolbox-gl` feature builds under Cocoa/Swift-free
  flags. The patch header carries the rationale and its removal
  condition. Applied patches are listed in the manifest under `mpv.patches`.

## 3. What is deliberately excluded

The LGPL runtime policy is enforced, not merely documented:

- FFmpeg is built without `--enable-gpl` and without `--enable-nonfree`.
- mpv is built with `-Dlibmpv=true` and `-Dgpl=false`.
- Release packaging rejects a Homebrew-sourced mpv runtime; it is allowed for
  local development only, behind `EMPV_ALLOW_HOMEBREW=1`.
