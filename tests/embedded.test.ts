import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizeEmbeddedAddon } from '../src/embedded.ts'

// The contract a backend must satisfy, written out here rather than imported
// from the implementation: these are the functions a consumer is promised, so a
// silent removal on either side has to break this file.
const CORE_FUNCTION_NAMES = [
  'isSupported',
  'getPresentationKind',
  'createSession',
  'disposeSession',
  'loadPlayback',
  'getSessionSnapshot',
  'captureFrame',
  'setRenderSize',
  'setPresentationSuspended',
  'reloadSubtitle',
  'seek',
  'replay',
  'playlistSync',
  'playlistPlayIndex',
  'playlistLocateIndex',
  'setPlaylistAutoAdvance',
  'setAbLoop',
  'setAspect',
  'setAudioDelay',
  'setAudioTrack',
  'setSubtitleDelay',
  'setSubtitleTrack',
  'setVideoRotation',
  'setVideoZoom',
  'setVideoPan',
  'setVideoAdjustments',
  'setAudioPitchCorrection',
  'setLoudnessNormalization',
  'setAudioVisualization',
  'setLoopFile',
  'setPaused',
  'setSecondarySubtitleTrack',
  'setSpeed',
  'setVolume',
  'startRecording',
  'stopRecording',
  'createPresenter',
  'setPresenterBounds',
  'refreshPresenterScale',
  'setPresenterSuspended',
  'destroyPresenter',
  'setWindowBackdrop'
]

const IOSURFACE_MACH_FUNCTION_NAMES = [
  'configureFrameLink',
  'startPresenterLink',
  'stopPresenterLink',
  'presentSurface',
  'observeWindowOcclusion',
  'unobserveWindowOcclusion'
]

const WID_WINDOW_FUNCTION_NAMES = ['getVideoWindowHandle', 'adoptVideoWindow']

function makeAddon(presentationKind: string, functionNames: string[]): Record<string, unknown> {
  const addon: Record<string, unknown> = {}
  for (const name of functionNames) addon[name] = () => undefined
  addon.getPresentationKind = () => presentationKind
  return addon
}

function makeIoSurfaceMachAddon(): Record<string, unknown> {
  return makeAddon('iosurface-mach', [...CORE_FUNCTION_NAMES, ...IOSURFACE_MACH_FUNCTION_NAMES])
}

function makeWidWindowAddon(): Record<string, unknown> {
  return makeAddon('wid-window', [...CORE_FUNCTION_NAMES, ...WID_WINDOW_FUNCTION_NAMES])
}

describe('normalizeEmbeddedAddon', () => {
  test('tags a mach backend with the kind it reports', () => {
    const normalized = normalizeEmbeddedAddon(makeIoSurfaceMachAddon())

    assert.equal(normalized.presentationKind, 'iosurface-mach')
    assert.equal(typeof normalized.addon.presentSurface, 'function')
  })

  test('tags a window-embedding backend with the kind it reports', () => {
    const normalized = normalizeEmbeddedAddon(makeWidWindowAddon())

    assert.equal(normalized.presentationKind, 'wid-window')
    assert.equal(typeof normalized.addon.adoptVideoWindow, 'function')
  })

  test('unwraps a default-exported module', () => {
    const normalized = normalizeEmbeddedAddon({ default: makeWidWindowAddon() })

    assert.equal(normalized.presentationKind, 'wid-window')
  })

  test('refuses a backend that is missing any part of the shared core', () => {
    for (const missingName of CORE_FUNCTION_NAMES) {
      const addon = makeIoSurfaceMachAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /core API/,
        `Dropping ${missingName} must not load.`
      )
    }
  })

  test('refuses a mach backend that cannot do the mach frame link', () => {
    for (const missingName of IOSURFACE_MACH_FUNCTION_NAMES) {
      const addon = makeIoSurfaceMachAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /mach frame-link/,
        `Dropping ${missingName} must not load as iosurface-mach.`
      )
    }
  })

  test('refuses a window backend that cannot embed its video window', () => {
    for (const missingName of WID_WINDOW_FUNCTION_NAMES) {
      const addon = makeWidWindowAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /video-window embedding/,
        `Dropping ${missingName} must not load as wid-window.`
      )
    }
  })

  // The two facets are disjoint: a backend must not be accepted on the strength
  // of the other facet's functions.
  test('refuses a backend whose facet does not match the kind it reports', () => {
    const machShapedButReportingWid = makeAddon('wid-window', [
      ...CORE_FUNCTION_NAMES,
      ...IOSURFACE_MACH_FUNCTION_NAMES
    ])

    assert.throws(() => normalizeEmbeddedAddon(machShapedButReportingWid), /video-window embedding/)
  })

  test('refuses a kind it does not know how to drive', () => {
    const addon = makeAddon('vulkan-swapchain', CORE_FUNCTION_NAMES)

    assert.throws(() => normalizeEmbeddedAddon(addon), /unknown presentation kind/)
  })

  test('refuses something that is not an addon at all', () => {
    for (const value of [null, undefined, 42, 'addon', {}]) {
      assert.throws(() => normalizeEmbeddedAddon(value), /core API/)
    }
  })
})
