# empv

Embedded [libmpv](https://mpv.io) player for Electron: a Rust/N-API addon with a
typed session contract, plus the runtime discovery and LGPL runtime build
tooling around it.

Unlike "spawn an mpv process and talk IPC" wrappers, empv runs libmpv **in
process** and composites its output into your Electron window: an IOSurface pool
handed to a `CALayer` over a mach frame link on macOS, an embedded native child
window on Windows and Linux.

> **Status: pre-1.0, extracted from a shipping application.** The playback core
> is mature and exercised on all three platforms; the packaging story is not.
> Read [Limitations](#limitations) before adopting.

## What you get

One addon, one contract (`LibMpvEmbeddedCoreAddon`), two presentation backends
selected at load time by `getPresentationKind()`:

|             | macOS                                                                   | Windows / Linux                         |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------- |
| kind        | `layer`                                                                 | `window`                                |
| video out   | `vo=libmpv`, rendered by a Rust worker into a three-slot IOSurface pool | `vo=gpu` into an app-owned child window |
| transport   | mach frame link → main-process `CALayer` presenter                      | main process reparents the child window |
| compositing | under **or** over the web contents (`zOrder`)                           | above the web contents                  |

Playback surface, all through the same session id: load/seek/replay, pause,
volume, speed, aspect, A-B loop, chapters, audio and subtitle track selection
(including `secondary-sid`), audio/subtitle delay, pitch correction, loudness
normalization, `lavfi-complex` audio visualization (spectrum/waveform), video
rotate/zoom/pan and brightness/contrast/saturation/gamma, `stream-record`
recording, frame capture, and a gapless **playlist** (whole-queue reconciliation,
plus play/locate-by-index).

State comes back as one ~55-field snapshot through a single
`onSnapshotChanged` notification; important changes are pushed immediately while
position/cache/dropped-frame churn is coalesced to at most one notification per
250 ms.

## Requirements

- Node.js ≥ 18.17 (N-API 9), Electron built on a matching Node-API version
- A Rust toolchain (stable) — the addon is built from source
- A dynamically linked, LGPL-compatible libmpv runtime (see below)
- Cross-building the Windows runtime: MinGW-w64, meson, ninja, nasm, cmake
- Linux: X11 or Xwayland. **Native Wayland is not supported** — empv fails loudly
  when `DISPLAY` is unset.

## Install

empv is not on npm yet. Prebuilt packages are attached to each
[release](https://github.com/linmi/empv/releases), and because an optional
dependency can only be resolved from a registry, the platform package is named
alongside the main one:

```bash
# macOS, Apple Silicon — addon and libmpv runtime, nothing to build
npm install \
  https://github.com/linmi/empv/releases/download/v0.2.0/empv-0.2.0.tgz \
  https://github.com/linmi/empv/releases/download/v0.2.0/empv-darwin-arm64-0.2.0.tgz
```

`empv-darwin-x64` and `empv-win32-x64` are attached to the same release. No Rust
toolchain is involved either way: the addon is prebuilt, and on macOS so is the
runtime it loads. Once empv is published, `npm install empv` will pull the right
platform package on its own.

The Windows package carries its libmpv too. Every _prebuilt_ Windows libmpv is
GPL, so the only way to bundle one was to build it: the release cross-compiles
mpv 0.41 with MinGW-w64 under `-Dgpl=false` and links every dependency into a
single `libmpv-2.dll` that imports nothing but Windows itself. mpv only gates
`cdda`, `dvbin`, `dvdnav`, `jack`, `oss-audio`, `caca`, `direct3d` and `x11`
behind GPL, and none of those is something a player on Windows needs —
`win32-desktop`, which is where `--wid` lives, is not gated, and neither is the
D3D11 renderer `vo=gpu` runs through — that one is gated behind `shaderc` and
`spirv-cross`, which are cross-compiled alongside everything else.

Linux has no prebuilt. It would also be addon-only, since distributions package
libmpv and the addon links it by soname, but the resolver still looks for the
library inside the runtime directory and on Linux it lives in `/usr/lib`. That
needs system-path discovery first.

### From source

```bash
# 1. Build (or stage) an LGPL-compatible libmpv runtime for your platform.
#    macOS builds from source; see "Runtime" below for the other platforms.
npm run build-runtime:macos -- arm64 /tmp/empv-prefix
npm run stage-runtime -- darwin arm64 /tmp/empv-prefix

# 2. Build the native addon against it.
npm run build:native
```

## Runtime

The resolver looks for an exact runtime directory from `EMPV_RUNTIME_DIR`, then
for bundled resources under common app roots:

```text
resources/libmpv/darwin-arm64/
  runtime-manifest.json
  addon/empv.node
  lib/libmpv.dylib
  include/mpv/client.h
```

Windows and Linux use the same shape, with platform library names such as
`libmpv-2.dll` or `libmpv.so.2`.

Development overrides:

```text
EMPV_RUNTIME_DIR=/absolute/path/to/runtime
EMPV_ADDON_PATH=/absolute/path/to/empv.node
EMPV_LIBRARY_PATH=/absolute/path/to/libmpv.dylib
```

How you obtain the runtime differs by platform, and this is currently uneven:

- **macOS** — `build-runtime:macos` builds mpv + FFmpeg + deps from pinned
  sources under an LGPL configuration and writes a prefix plus a
  `runtime-manifest.json`.
- **Windows** — `build-runtime:windows` cross-compiles the same pinned sources
  with MinGW-w64 and links them into one self-contained `libmpv-2.dll`. It runs
  on Linux (or any host with the toolchain), not on Windows, because mpv has no
  MSVC build; the MSVC-built addon links the result through an import library
  synthesised from the DLL's exports.
  `prepare-runtime:windows` still exists and fetches a pinned upstream mpv
  development package, but that archive is _compile and test input only_ — it is
  a GPL build, and the compile gate uses it because answering "does this still
  compile" does not justify an hour of cross-compilation.
- **Linux** — bring your own LGPL-compatible prefix and `stage-runtime` it.

Release builds must use an LGPL-compatible runtime: FFmpeg without
`--enable-gpl`/`--enable-nonfree`, mpv with `-Dlibmpv=true -Dgpl=false`,
dynamically linked. A Homebrew mpv is rejected by release packaging and is
allowed for local development only, behind `EMPV_ALLOW_HOMEBREW=1`.

## Usage

```ts
import { loadEmbeddedLibMpvAddon } from 'empv'

const loaded = await loadEmbeddedLibMpvAddon()

const sessionId = await loaded.addon.createSession(
  { volume: 1 },
  () => {
    const snapshot = loaded.addon.getSessionSnapshot(sessionId)
    // status / position / duration / tracks / …
  },
  (surfaceIndex, poolGeneration, contentGeneration) => {
    // macOS only: hand the rendered slot to the main-process presenter.
  }
)

loaded.addon.loadPlayback(sessionId, { streamUrl: '/path/to/video.mkv' })
loaded.addon.setPaused(sessionId, false)
```

`loaded` is a discriminated union — branch on `loaded.presentationKind` before
reaching for a backend-specific function; the two facets are disjoint by design.

Subtitles you own should be passed as an explicit ASS file through
`subtitlePath`, with `disableDefaultSubtitles` set so embedded media subtitle
tracks do not compete with them.

## Crash isolation (`empv/electron`)

Loading the addon straight into your main process means a native mpv crash takes
the whole app down. `empv/electron` runs the sessions in an Electron **utility
process** instead, and keeps the presenter in the main process, so a crash costs
you the playback runtime and nothing else.

Your utility entry is two lines — your bundler still decides where it lands:

```ts
// src/main/playbackRuntime.ts -> built to out/main/playbackRuntime.js
import { startEmpvRuntimeProcess } from 'empv/electron/runtime-process'

startEmpvRuntimeProcess()
```

The main process drives it through a typed client and a playback host:

```ts
import {
  createEmpvFrameLinkServiceName,
  createEmpvPlaybackHost,
  createEmpvRuntimeClient
} from 'empv/electron'

// One name for this main process; the client injects it into every utility
// spawn and the host registers it with the native presenter.
const frameLinkServiceName = createEmpvFrameLinkServiceName()

const client = createEmpvRuntimeClient({
  resolveEntryPath: () => join(app.getAppPath(), 'out/main/playbackRuntime.js'),
  frameLinkServiceName,
  serviceName: 'Playback Runtime',
  onHeartbeat: () => watchdog.heartbeat()
})

// Loads the addon in this process for the presenter, registers the frame link,
// and presents every bound session's frames. Build it when you first need a
// presenter -- session control does not require it.
const host = await createEmpvPlaybackHost({ client, frameLinkServiceName })

const { sessionId } = await client.invoke('createSession', { options: { volume: 1 } })
const renderSize = host.createPresenter(sessionId, window.getNativeWindowHandle(), {
  ...bounds,
  zOrder: 'underlay'
})
host.bindSessionToPresenter(sessionId, sessionId)

await client.invoke('setRenderSize', sessionId, renderSize.widthPixels, renderSize.heightPixels)
await client.invoke('loadPlayback', sessionId, { streamUrl: '/path/to/video.mkv' })
await client.invoke('setPaused', sessionId, false)

client.onSnapshot(({ snapshot }) => render(snapshot))
client.onExit((error, activeSessionIds) => recover(error, activeSessionIds))
```

Frames never appear in your code: the host turns each one into the right
`presentSurface` call for whichever presenter the session is bound to, and drops
frames for sessions that are not bound. Unbind before destroying a presenter.

The protocol methods are the addon's own -- `seek`, `setVolume`, `playlistSync`
-- because the contract is derived from the addon interface rather than restated.
A method added to the addon is callable through `client.invoke` without editing a
table, and a method missing from the forwarding list fails to compile.

The client owns spawn/respawn, request-reply correlation and event fan-out. It
deliberately does **not** own a liveness watchdog: it reports heartbeats through
`onHeartbeat` and exposes `terminate(reason)` and `getProcessId()`, so an app
that already supervises several utility processes keeps one watchdog policy
instead of inheriting a second one from a library. `terminate` is one call
because the ordering matters -- in-flight requests have to fail before the
process dies, or callers hang until the exit event lands.

`empv/electron` needs `electron` as a peer. It is built and verified against
Electron 42; earlier versions with a stable `utilityProcess` API are likely fine
but are not covered here.

## Limitations

Know these before adopting:

- **Electron-shaped.** The presenter API takes an Electron native window handle
  (`BrowserWindow.getNativeWindowHandle()`). The session API alone runs in plain
  Node, but there is no presentation path outside Electron.
- **Not on npm.** Prebuilts are attached to each release and verified before
  upload -- packed, installed into a project outside the repository, dlopened,
  played -- but until they are published the platform package has to be named on
  the install command line rather than resolved as an optional dependency.
- **Linux has no prebuilt**, and on Linux there is no LGPL libmpv to build
  against either: mpv gates X11 behind `-Dgpl=true`, and `x11_common.c` is where
  `--wid` is implemented. An LGPL Linux runtime would be Wayland-only, so Wayland
  support and an LGPL-clean Linux are the same piece of work.
- **No native Wayland**, and no verified `linux-arm64` / `win32-arm64` builds.

## Architecture notes

Windows and Linux use mpv `wid` with an app-owned child window. macOS uses
`vo=libmpv`: a Rust render worker renders into a three-slot IOSurface pool, a
mach frame link transfers the pool to the main process, and a CALayer presenter
displays the latest valid frame. The Objective-C++ files under
`native/shims/macos/` are framework/C-ABI adapters only; playback, rendering,
generation, retry, and presenter decisions live in Rust.

macOS audio is pinned to mpv's AVFoundation output. Do not restore the CoreAudio
output path: mpv 0.41 registers its CoreAudio hotplug listener before
channel-map initialization completes, so a failed channel-map setup can leave a
callback pointing at a freed audio-output instance and crash the Electron
renderer. The pinned runtime therefore builds with `-Davfoundation=enabled` and
`-Dcoreaudio=disabled`; selecting AVFoundation only at playback time is
insufficient because mpv also initializes CoreAudio as its global hotplug
provider.

`build:native` builds through Cargo and napi-rs. The staged runtime is read from
`vendor/embedded-mpv/<platform>-<arch>/`; native build output is written under
`native/build/Release/` and copied to `dist/native/`.

## Upgrading the pinned mpv

The mpv version pin lives in one place: `mpvSource` in
`scripts/embedded-mpv/runtime-pins.mjs` (`version` + tarball `url`). That module
also owns the patch list (`mpvPatches`) and the videotoolbox-gl invariants.
`build-macos-runtime.mjs` and `verify-patches.mjs` both import it, so the two
never drift.

The runtime carries one vendored patch:
`scripts/embedded-mpv/patches/mpv-videotoolbox-gl-without-cocoa.patch`. It
relaxes mpv's `meson.build` so the `videotoolbox-gl` feature (the zero-copy
VideoToolbox↔OpenGL interop in `video/out/hwdec/hwdec_mac_gl.c`) builds under our
Cocoa/Swift-free flags (`-Dcocoa=disabled -Dgl-cocoa=disabled
-Dplain-gl=enabled`), and links the OpenGL/IOSurface/CoreVideo frameworks that
file needs. See the patch header for the full rationale and its **removal
condition**: delete the patch **and** drop `-Dvideotoolbox-gl=enabled` from
`build-macos-runtime.mjs` once upstream mpv accepts plain-gl for
`videotoolbox-gl`, or once the runtime moves off the OpenGL render API.

To bump the pin:

1. Edit `mpvSource.version` and `mpvSource.url` in
   `scripts/embedded-mpv/runtime-pins.mjs`.
2. Run the patch preflight **first** — it is network-light (reuses the build's
   cached archive when present) and never builds anything:

   ```bash
   npm run verify:runtime-patches
   ```

   It extracts a clean copy of the pinned mpv source, `patch -p1 --forward
--dry-run`s every patch in `patches/`, and asserts the invariants the build
   relies on: the `videotoolbox-gl` option still exists in the source's
   `meson.options`, and `build-macos-runtime.mjs` still passes
   `-Dvideotoolbox-gl=enabled`. If a patch no longer applies, it fails loudly
   with the per-patch `patch` output. A failure reading `Ignoring previously
applied (or reversed) patch.` means upstream already relaxed the dependency
   and the patch is now redundant — follow the removal condition above. Any other
   reject means upstream moved the context and the patch must be regenerated.

3. Once the preflight passes, rebuild and re-stage the runtime for each target
   arch (macOS builds from source; see `scripts/embedded-mpv/README.md` for the
   full policy):

   ```bash
   npm run build-runtime:macos -- <arm64|x64> <output-prefix>
   npm run stage-runtime -- <darwin|win32|linux> <arch> <lgpl-runtime-prefix>
   ```

The applied patches and build flags are recorded in the runtime manifest so a
release can prove what was built: `mpv.patches` and `packages.mpv.patches` list
the applied patch filenames, `mpv.mesonFlags` records the mpv Meson flags
(including `-Dvideotoolbox-gl=enabled`), and `ffmpeg.configureFlags` records the
FFmpeg configure flags.

## Releasing

The `version` field in `package.json` is what starts a release. Push a bump to
`main` and the release workflow builds all three platform packages, verifies
each one by installing it into an empty project and opening an mpv session, and
publishes them under `v<version>` — creating the tag at the commit it built.

There is no tag to push and no button to press, so **the version bump is the
irreversible step**. A push whose version already has a release does nothing
beyond one cheap API call, which is why re-pushing after a failed build is safe:
it retries, and it cannot publish twice.

To exercise the whole path without publishing, run the workflow manually with
`dry_run` left on.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

Portions originally derive from [IPTVnator](https://github.com/4gray/iptvnator)
and remain under the MIT License; its notices are preserved in
`third-party/iptvnator/`.

The libmpv/FFmpeg runtime empv loads is LGPL-2.1-or-later and is **not** covered
by the Apache licence. If you redistribute a build that bundles it, read
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) and
[`third-party/LGPL-2.1.txt`](./third-party/LGPL-2.1.txt).
