import { describe, expect, it } from 'vitest'

import appSource from '../../src/workbench/contrib/video-to-motion/browser/video-to-motion-panel.tsx?raw'
import runtimeSource from '../../src/runtime/webui-runtime.ts?raw'

describe('GVHMR result import frontend contract', () => {
  it('offers a compact import action in the result step', () => {
    expect(appSource).toContain('id="gvhmr-import-result"')
    expect(appSource).toContain('Import existing GVHMR result (.pt)')
    expect(appSource).toContain('导入已有 GVHMR 结果 (.pt)')
  })

  it('reuses motion ingestion and publishes the imported result to the pipeline', () => {
    const importFlow = runtimeSource.slice(
      runtimeSource.indexOf('async function importExistingGvhmrResult'),
      runtimeSource.indexOf('async function runGvhmrVideoToMotion'),
    )

    expect(importFlow).toContain('pickFiles({ accept: ".pt" })')
    expect(importFlow).toContain('ingestMotionFiles(files, "mimic")')
    expect(importFlow).toContain('gvhmrWorkspace.result = gvhmrResultSummary(payload)')
    expect(runtimeSource).toContain(
      'if (importResult) importResult.onclick = () => void importExistingGvhmrResult();',
    )
  })
})
