# Embedded MPV Runtime

This folder contains tooling for preparing the `libmpv` runtime that empv loads at run time.

## Runtime Policy

Release builds must use an LGPL-compatible runtime:

- FFmpeg must be built without `--enable-gpl` and without `--enable-nonfree`.
- mpv must be built with `-Dlibmpv=true` and `-Dgpl=false`.
- The runtime must be dynamically linked so users can inspect and replace LGPL libraries.
- The exact source URLs, versions, build flags, local patches, and checksums must be published with the release.

Do not ship the Homebrew `mpv` runtime. It is acceptable only for local development when `EMPV_ALLOW_HOMEBREW=1` is set, and release packaging rejects it.

## Expected Layout

The native addon build consumes:

```text
packages/empv/vendor/embedded-mpv/
  darwin-arm64/
    include/mpv/client.h
    lib/*.dylib
    runtime-manifest.json
  darwin-x64/
    include/mpv/client.h
    lib/*.dylib
    runtime-manifest.json
  win32-x64/
    include/mpv/client.h
    lib/libmpv-2.dll
    lib/mpv.lib
    runtime-manifest.json
  linux-x64/
    include/mpv/client.h
    lib/libmpv.so.2
    lib/libmpv.so
    runtime-manifest.json
```

The generated `lib/` and `include/` directories are release inputs, not source files. They are ignored by git by default.

## Native Addon Layout

All platforms build the addon through Cargo and napi-rs:

```text
packages/empv/native/
  src/
    mpv/             libmpv FFI, owned handles/nodes, render-context wrapper
    playback/        shared playback reducer and compound commands
    session/         shared runtime/snapshot plus macOS render worker
    presentation/    Rust-owned macOS and WID presenter state
    napi/            shared core exports plus disjoint macOS/WID facets
  shims/
    macos/           AppKit, IOSurface, Mach, OpenGL, and CALayer C ABI adapters
    wid/             Win32/X11 native-window C ABI adapters
```

The shims contain platform calls and resource handles, not playback or rendering
policy. Rust owns lifecycle, frame-generation ordering, render retry/suspension,
and the N-API contract.

## Staging A Built Runtime

After building an LGPL-compatible prefix for one platform/architecture, stage it with:

```bash
pnpm --filter empv run stage-runtime -- darwin arm64 /path/to/lgpl-prefix
pnpm --filter empv run stage-runtime -- darwin x64 /path/to/lgpl-prefix
pnpm --filter empv run stage-runtime -- win32 x64 /path/to/lgpl-prefix
pnpm --filter empv run stage-runtime -- linux x64 /path/to/lgpl-prefix
```

For compatibility, the legacy macOS-only staging command is still available:

```bash
pnpm --filter empv run stage-runtime:macos -- arm64 /path/to/lgpl-prefix
pnpm --filter empv run stage-runtime:macos -- x64 /path/to/lgpl-prefix
```

The prefix must contain `include/mpv/client.h` and the platform runtime files:

- macOS: `lib/libmpv.2.dylib` or `lib/libmpv.dylib` plus all non-system dylib dependencies
- Windows: a COFF import library at `lib/mpv.lib` or `lib/mpv-2.lib`, plus
  `bin/libmpv-2.dll`, `lib/libmpv-2.dll`, or an equivalent supported DLL name
- Linux: `lib/libmpv.so.2`, `lib/libmpv.so.1`, or `lib/libmpv.so`; include a `libmpv.so` linker name when building locally

If the prefix contains `runtime-manifest.json`, the staging script copies its build metadata into the vendored manifest. At minimum, record:

- FFmpeg version, source URL, checksum, configure flags, and patches
- mpv version, source URL, checksum, Meson flags, and patches
- source-distribution URL for the corresponding release

## Building The CI Runtime

Tagged macOS release builds should build the runtime from pinned source archives before `empv` native builds. The workflow can also enable this path temporarily for macOS PR artifact testing:

```bash
pnpm --filter empv run build-runtime:macos -- arm64 /tmp/embedded-mpv-prefix
pnpm --filter empv run stage-runtime -- darwin arm64 /tmp/embedded-mpv-prefix
```

During temporary PR and main-branch artifact testing, CI can restore an exact-keyed GitHub Actions cache for the staged `packages/empv/vendor/embedded-mpv/<platform>-<arch>/` runtime before falling back to the macOS source build where available. The cache key includes the target platform, architecture, macOS deployment target, Xcode version when available, and hashes of the runtime build/staging scripts. Cache entries are saved only from trusted repository refs and are treated strictly as a speed optimization; tagged macOS release builds continue to rebuild from pinned sources unless a future signed and attested runtime artifact flow is introduced.

The builder currently pins:

- FFmpeg `8.1`, configured without `--enable-gpl` or `--enable-nonfree`, and with autodetected external libraries disabled
- mpv `0.41.0`, configured with `-Dlibmpv=true -Dgpl=false`
- libplacebo `7.360.1`, checked out from git with the `glad`, Python template, `fast_float`, and `Vulkan-Headers` submodules required by its Meson build
- libass `0.17.3` plus FreeType, FriBidi, and HarfBuzz

The build manifest records source URLs, downloaded archive SHA-256 values where applicable, libplacebo git commit/submodule metadata, and the exact FFmpeg/mpv flags. The staged manifest is normalized to `origin: vendored-lgpl`, which is the only embedded MPV runtime origin allowed in required macOS release packaging.

The macOS mpv build explicitly enables AVFoundation and disables CoreAudio. mpv 0.41 can leave its
CoreAudio device hotplug listener registered after channel-map initialization fails; because that
listener is also used by mpv's global hotplug provider, choosing `ao=avfoundation` at playback time
does not remove the crash path from the process.

## Build Integration

`packages/empv/scripts/build-native.cjs` invokes the Cargo/napi build for every
supported platform, links the addon against the staged runtime, copies runtime
libraries into `packages/empv/native/build/Release/lib/`, rewrites macOS Mach-O
paths to `@loader_path`, and writes the canonical `runtime-manifest.json`
consumed by runtime discovery and packaged-resource validation. There is no
second native build path.

For local macOS development with Homebrew `mpv`, use:

```bash
pnpm run serve:backend:embedded-mpv
```

The script rebuilds the native addon with `EMPV_ALLOW_HOMEBREW=1`. Use this only for local testing; release packaging rejects the resulting `homebrew-dev` runtime manifest.

The desktop `afterPack` hook should copy `packages/empv/dist/native/` into unpacked app resources so the addon, runtime manifest, and runtime libraries are available as real files on macOS, Windows, and Linux.

During release packaging, `tools/packaging/electron-after-pack.cjs` verifies that the packaged app uses a `vendored-lgpl` runtime. macOS artifacts additionally verify that Mach-O dependencies have no `/opt/homebrew` or `/usr/local` dynamic links for embedded MPV.

Set `EMPV_REQUIRE=1` when packaging a release artifact that must include Embedded MPV. The same variable is temporarily enabled for macOS PR and `master` push artifacts while the bundled runtime is being tested. Windows and Linux CI packaging requires Embedded MPV when an exact-keyed staged runtime cache is restored; otherwise those jobs build without the native addon and Settings keeps Embedded MPV hidden.

## Windows Runtime Smoke

Prepare the pinned compile-only development input from an x64 MSVC developer
shell:

```powershell
pnpm --filter empv prepare-runtime:windows -- $env:TEMP\empv-dev
```

The command downloads the single source defined by `windowsMpvDevPackage` in
`runtime-pins.mjs`, verifies its SHA256, and converts the MinGW import library
surface into a COFF `mpv.lib`. This input is for compile and smoke validation
only; it is deliberately marked `ci-compile-input` and must not be packaged as
an LGPL release runtime.

After compiling the addon and placing the prepared `libmpv-2.dll` beside
`empv.node`, validate the real addon, Win32 presenter, playback,
EOF/replay, and playlist behavior with:

```powershell
pnpm --filter empv smoke:windows
```

The smoke creates real Win32 parent/child HWNDs without Electron. It validates
the native presenter path.

The hosted Windows CI also runs `smoke:electron-playback`. It creates a real
Electron `BrowserWindow`, starts playback in `utilityProcess`, and creates and
adopts two presenter/session pairs inside that same isolated process. It tears
one down without disturbing the other, kills the utility, verifies that Electron
and the window survive without main loading the addon, starts a fresh generation,
replaces the source, and checks final cleanup. This is the mandatory Windows
runtime and lifecycle gate; it deliberately does not claim that video pixels
were composited into the visible desktop.

Pixel-composition validation must run in a logged-in interactive Windows
desktop. It attaches
the mpv child HWND to a real frameless BrowserWindow, moves the presenter,
captures the primary display through the desktop's native capture binding, and
samples it using the BrowserWindow's real screen coordinates and DPI scale. It
verifies video pixels at both positions and background restoration at the
vacated position, then destroys the presenter and session. Electron's
`desktopCapturer` window thumbnail is intentionally not used: it omits the
external child HWND. PNG captures and a JSON report are written to
`EMPV_ELECTRON_SMOKE_OUTPUT_DIR` or a logged temporary directory.

### Interactive self-hosted runner

`.github/workflows/libmpv-windows-interactive.yml` reruns the native smoke and
the pixel-sampling Electron smoke twice on the existing hardware-lab label set:

```text
self-hosted, capture-hardware, capture-windows-hardware
```

The Windows runner must be launched with `run.cmd` from the logged-in desktop;
do not install it as a Windows service, because Session 0 cannot create or
capture the D3D11-backed child window. The host needs Visual Studio 2022 C++
tools, Git, and `ffmpeg` on `PATH`; archive extraction uses the Windows
`tar.exe`. The workflow is started explicitly with `workflow_dispatch`;
pushes to `main` and pull requests never execute code on this self-hosted
runner.

## Platform Notes

- macOS uses the Rust-owned `vo=libmpv` render-context backend because mpv `wid`
  stays black inside Electron. Thin Objective-C++ shims expose IOSurface/Mach and
  AppKit/QuartzCore operations to Rust.
- Windows uses an embedded child `HWND` and passes it to mpv through `wid`.
- Linux uses an X11 child window and passes it to mpv through `wid`. Native Wayland is not supported in v1; run under X11/Xwayland so `DISPLAY` is set.
