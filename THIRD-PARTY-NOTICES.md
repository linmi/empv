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

empv does not statically link mpv or FFmpeg. It loads a **separately built,
dynamically linked** runtime at run time, resolved by `resolveLibMpvRuntime()`.
The runtime is not part of the npm tarball; you build or supply it yourself via
the scripts under `scripts/embedded-mpv/`.

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

1. **Dynamic linking only.** mpv and FFmpeg are shared libraries
   (`libmpv.2.dylib` / `libmpv-2.dll` / `libmpv.so.2`) loaded at run time. The
   addon never statically links them.
2. **The libraries are replaceable in place.** The staged runtime directory is
   plain files. Replacing `lib/libmpv.*` with your own build of the same
   soname/ABI is sufficient — no rebuild of empv is required. On macOS the addon
   resolves the library through `@loader_path/lib`, on Linux through `$ORIGIN/lib`.
3. **The runtime location is overridable.** `EMPV_RUNTIME_DIR`,
   `EMPV_LIBRARY_PATH` and `EMPV_ADDON_PATH` let a user point empv at a
   different runtime entirely, without touching the application bundle.
4. **The build is reproducible from published inputs.** Source URLs, checksums,
   patches and build flags are pinned in `scripts/embedded-mpv/runtime-pins.mjs`
   and recorded in the manifest; `pnpm run build-runtime:macos` rebuilds the
   runtime from those exact inputs.

If you redistribute a binary that bundles this runtime, you must ship with it:
the LGPL-2.1 text (`third-party/LGPL-2.1.txt`), this notice, the build's
`runtime-manifest.json`, the local patches under
`scripts/embedded-mpv/patches/`, and either the corresponding source archives or
a written offer to supply them. `runtime-manifest.json` carries a
`sourceDistribution` field stating exactly this.

### 2.2 Local patches applied to mpv

- `scripts/embedded-mpv/patches/mpv-videotoolbox-gl-without-cocoa.patch` —
  relaxes mpv's `meson.build` so the `videotoolbox-gl` feature builds under
  Cocoa/Swift-free flags. The patch header carries the rationale and its removal
  condition. Applied patches are listed in the manifest under `mpv.patches`.

## 3. What is deliberately excluded

The LGPL runtime policy is enforced, not merely documented:

- FFmpeg is built without `--enable-gpl` and without `--enable-nonfree`.
- mpv is built with `-Dlibmpv=true` and `-Dgpl=false`.
- Release packaging rejects a Homebrew-sourced mpv runtime; it is allowed for
  local development only, behind `EMPV_ALLOW_HOMEBREW=1`.
