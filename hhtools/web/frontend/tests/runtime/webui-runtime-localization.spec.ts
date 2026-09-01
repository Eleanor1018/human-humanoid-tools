import { describe, expect, it } from 'vitest'

import runtimeSource from '../../src/runtime/webui-runtime.ts?raw'

describe('WebUI runtime localization boundary', () => {
  it('keeps dynamic retarget status copy behind the locale helper', () => {
    const untranslatedRuntimeCopies = [
      'toast("请先上传源轨迹并加载目标机器人"',
      'toast("目标机器人尚未针对此源机器人标定，请先完成标定"',
      'r2rSetCalChip(calibrated ? "已标定"',
      'renderSpinnerStatus(status, "正在 retarget',
      'reason: "当前结果未返回可用的 tracking/contact 诊断。"',
      'toast("R2R Retarget 完成',
      'toast("已开始下载（保存到浏览器默认下载目录）"',
    ]

    for (const copy of untranslatedRuntimeCopies) {
      expect(runtimeSource).not.toContain(copy)
    }
  })

  it('re-emits stateful runtime copy when the workspace locale changes', () => {
    const localeListener = runtimeSource.slice(
      runtimeSource.indexOf('hhtools:workspace-locale-change'),
      runtimeSource.indexOf('// drag-drop helpers'),
    )

    expect(localeListener).toContain('publishH2rWorkflowState()')
    expect(localeListener).toContain('publishR2rWorkflowState()')
    expect(localeListener).toContain('setR2rRobotStatus("source"')
    expect(localeListener).toContain('setR2rRobotStatus("target"')
    expect(localeListener).toContain('r2rRenderBasket()')
  })
})
