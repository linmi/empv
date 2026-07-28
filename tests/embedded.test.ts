import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizeEmbeddedAddon, normalizeEmbeddedPresenterAddon } from '../src/embedded.ts'

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
  'stopRecording'
]

const LAYER_RUNTIME_FUNCTION_NAMES = ['configureFrameLink']

const LAYER_PRESENTER_FUNCTION_NAMES = [
  'getPresenterKind',
  'createPresenter',
  'setPresenterBounds',
  'refreshPresenterScale',
  'setPresenterSuspended',
  'destroyPresenter',
  'setWindowBackdrop',
  'startPresenterLink',
  'stopPresenterLink',
  'presentSurface',
  'observeWindowOcclusion',
  'unobserveWindowOcclusion'
]

const WINDOW_FUNCTION_NAMES = [
  'createPresenter',
  'setPresenterBounds',
  'refreshPresenterScale',
  'setPresenterSuspended',
  'destroyPresenter',
  'setWindowBackdrop',
  'getVideoWindowHandle',
  'adoptVideoWindow'
]

function makeAddon(presentationKind: string, functionNames: string[]): Record<string, unknown> {
  const addon: Record<string, unknown> = {}
  for (const name of functionNames) addon[name] = () => undefined
  addon.getPresentationKind = () => presentationKind
  return addon
}

function makeLayerAddon(): Record<string, unknown> {
  return makeAddon('layer', [...CORE_FUNCTION_NAMES, ...LAYER_RUNTIME_FUNCTION_NAMES])
}

function makePresenterAddon(): Record<string, unknown> {
  const addon = makeAddon('unused', LAYER_PRESENTER_FUNCTION_NAMES)
  delete addon.getPresentationKind
  addon.getPresenterKind = () => 'layer'
  return addon
}

function makeWindowAddon(): Record<string, unknown> {
  return makeAddon('window', [...CORE_FUNCTION_NAMES, ...WINDOW_FUNCTION_NAMES])
}

describe('normalizeEmbeddedAddon', () => {
  test('tags a layer backend with the kind it reports', () => {
    const normalized = normalizeEmbeddedAddon(makeLayerAddon())

    assert.equal(normalized.presentationKind, 'layer')
    assert.equal(typeof normalized.addon.configureFrameLink, 'function')
  })

  test('tags a window-embedding backend with the kind it reports', () => {
    const normalized = normalizeEmbeddedAddon(makeWindowAddon())

    assert.equal(normalized.presentationKind, 'window')
    assert.equal(typeof normalized.addon.adoptVideoWindow, 'function')
  })

  test('unwraps a default-exported module', () => {
    const normalized = normalizeEmbeddedAddon({ default: makeWindowAddon() })

    assert.equal(normalized.presentationKind, 'window')
  })

  test('refuses a backend that is missing any part of the shared core', () => {
    for (const missingName of CORE_FUNCTION_NAMES) {
      const addon = makeLayerAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /session API/,
        `Dropping ${missingName} must not load.`
      )
    }
  })

  test('refuses a layer runtime that cannot configure the Mach sender', () => {
    for (const missingName of LAYER_RUNTIME_FUNCTION_NAMES) {
      const addon = makeLayerAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /Mach sender/,
        `Dropping ${missingName} must not load as layer.`
      )
    }
  })

  test('refuses the historical combined layer runtime and presenter surface', () => {
    const combined = makeAddon('layer', [
      ...CORE_FUNCTION_NAMES,
      ...LAYER_RUNTIME_FUNCTION_NAMES,
      ...LAYER_PRESENTER_FUNCTION_NAMES
    ])
    assert.throws(() => normalizeEmbeddedAddon(combined), /must not export.*presenter bridge/)
  })

  test('refuses a window backend that cannot embed its video window', () => {
    for (const missingName of WINDOW_FUNCTION_NAMES) {
      const addon = makeWindowAddon()
      delete addon[missingName]

      assert.throws(
        () => normalizeEmbeddedAddon(addon),
        /video-window embedding/,
        `Dropping ${missingName} must not load as window.`
      )
    }
  })

  // The two facets are disjoint: a backend must not be accepted on the strength
  // of the other facet's functions.
  test('refuses a backend whose facet does not match the kind it reports', () => {
    const layerShapedButReportingWindow = makeAddon('window', [
      ...CORE_FUNCTION_NAMES,
      ...LAYER_RUNTIME_FUNCTION_NAMES
    ])

    assert.throws(
      () => normalizeEmbeddedAddon(layerShapedButReportingWindow),
      /video-window embedding/
    )
  })

  test('refuses a kind it does not know how to drive', () => {
    const addon = makeAddon('vulkan-swapchain', CORE_FUNCTION_NAMES)

    assert.throws(() => normalizeEmbeddedAddon(addon), /unknown presentation kind/)
  })

  test('refuses something that is not an addon at all', () => {
    for (const value of [null, undefined, 42, 'addon', {}]) {
      assert.throws(() => normalizeEmbeddedAddon(value), /session API/)
    }
  })
})

describe('normalizeEmbeddedPresenterAddon', () => {
  test('accepts the libmpv-free layer presenter surface', () => {
    const addon = normalizeEmbeddedPresenterAddon(makePresenterAddon())
    assert.equal(addon.getPresenterKind(), 'layer')
    assert.equal(typeof addon.presentSurface, 'function')
  })

  test('requires every presenter bridge function', () => {
    for (const missingName of LAYER_PRESENTER_FUNCTION_NAMES) {
      const addon = makePresenterAddon()
      delete addon[missingName]
      assert.throws(
        () => normalizeEmbeddedPresenterAddon(addon),
        /presenter bridge API/,
        `Dropping ${missingName} must not load.`
      )
    }
  })

  test('rejects a presenter addon that also exports the libmpv session API', () => {
    const combined = {
      ...makePresenterAddon(),
      ...makeAddon('layer', CORE_FUNCTION_NAMES)
    }
    assert.throws(
      () => normalizeEmbeddedPresenterAddon(combined),
      /must not export or load.*session API/
    )
  })
})
