import { describe, expect, it } from 'vitest'

import appSource from '../../src/workbench/browser/components/video-to-motion-panel.tsx?raw'
import runtimeSource from '../../src/runtime/webui-runtime.ts?raw'

describe('GVHMR custom checkpoint frontend contract', () => {
  it('renders the best-effort custom checkpoint controls', () => {
    expect(appSource).toContain('<option value="custom">')
    expect(appSource).toContain('id="gvhmr-custom-checkpoint"')
    expect(appSource).toContain('id="gvhmr-pick-checkpoint"')
    expect(appSource).toContain('id="gvhmr-checkpoint-name"')
    expect(appSource).toContain('Compatibility is not guaranteed.')
  })

  it('keeps the selected source through confirmation and accepts any filename', () => {
    const sourceChange = runtimeSource.slice(
      runtimeSource.indexOf('weightSource.onchange ='),
      runtimeSource.indexOf('setupDropzone(dropzone'),
    )

    expect(sourceChange).toContain(
      'gvhmrWorkspace.weightSource = weightSource.value === "custom" ? "custom" : "official";',
    )
    expect(sourceChange).not.toContain('gvhmrWorkspace.weightSource = "official";')
    expect(sourceChange).toContain('selectGvhmrCheckpoint(await pickFiles());')
    expect(runtimeSource).not.toContain('GVHMR_CHECKPOINT_ACCEPT')
    expect(runtimeSource).not.toContain('GVHMR_CHECKPOINT_EXTENSIONS')
    expect(runtimeSource).not.toContain('Custom GVHMR weights must be a CKPT, PT, or PTH file.')
  })
})
