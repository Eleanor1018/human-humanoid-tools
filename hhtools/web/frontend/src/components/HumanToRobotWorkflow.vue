<script setup lang="ts">
import { ref } from 'vue'

import CalibrationEditorControls from './CalibrationEditorControls.vue'
import MotionPickerDialog from './MotionPickerDialog.vue'
import ResultEvaluationPanel from './ResultEvaluationPanel.vue'
import WorkflowPipeline from './WorkflowPipeline.vue'
import type { WorkspaceLocale, WorkspacePanelId } from '../runtime/types'

const props = withDefaults(defineProps<{
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const emit = defineEmits<{
  'request-panel': [panel: WorkspacePanelId]
}>()

const motionPickerOpen = ref(false)

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

function openMotionImport(_options?: { folder?: boolean }): void {
  motionPickerOpen.value = false
  emit('request-panel', 'motion')
}
</script>

<template>
  <div class="panel-stack workflow-panel-stack">
    <h2>{{ text('Human → Robot', '人体 → 机器人') }}</h2>
    <WorkflowPipeline workflow="h2r" />

    <details id="h2r-step-motion" class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('1. Motion', '1. 动作') }}</span>
      </summary>
      <div class="video-workflow-step-body">
        <div class="workflow-selection-row">
          <span id="rt-motion" class="workflow-selection-value">{{ text('Not loaded', '未加载') }}</span>
          <button type="button" class="btn secondary small" @click="motionPickerOpen = true">
            {{ text('Select motion', '选择动作') }}
          </button>
        </div>
      </div>
    </details>

    <details id="h2r-step-robot" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('2. Target robot', '2. 目标机器人') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-picker-row">
          <select
            id="h2r-robot-select"
            class="search"
            :aria-label="text('Select target robot', '选择目标机器人')"
          ></select>
          <button type="button" class="btn secondary small" @click="emit('request-panel', 'robot-assets')">
            {{ text('Import robot', '导入机器人') }}
          </button>
        </div>
        <button id="h2r-robot-load" type="button" class="btn workflow-load-button" disabled>
          {{ text('Load robot', '加载机器人') }}
        </button>
        <p id="rt-robot" class="hint workflow-status-line" role="status">{{ text('Not loaded', '未加载') }}</p>
      </div>
    </details>

    <details id="h2r-step-calibration" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('3. Calibration', '3. 标定') }}</span>
      </summary>
      <div id="tour-calibration" class="video-workflow-step-body workflow-compact-controls">
        <label class="video-workflow-field">
          <span class="k">{{ text('Reference pose', '参考姿态') }}</span>
          <select
            id="rt-ref-select"
            class="search"
            disabled
            :title="text('Human reference skeleton used for calibration', '标定用人体参考骨架；自动识别有误时可手动切换')"
          >
            <option value="">—</option>
          </select>
        </label>
        <p id="rt-ref-hint" class="hint workflow-status-line" style="display:none"></p>
        <div class="workflow-selection-row">
          <div class="workflow-selection-copy">
            <span class="k">{{ text('Calibration', '标定') }}</span>
            <strong id="rt-cal"><span class="status-chip"><span class="dot"></span>—</span></strong>
          </div>
          <button id="recalib-btn" type="button" class="btn secondary small" disabled>
            {{ text('Calibrate', '开始标定') }}
          </button>
        </div>
        <div id="calibration-save-summary" class="calibration-save-summary" aria-live="polite"></div>

        <div id="calib-card" class="workflow-calibration-editor" style="display:none">
          <p id="calibration-scope" class="hint">{{ text('Target robot + source reference', '目标机器人 + 源参考格式') }}</p>
          <div id="calibration-validation-summary" class="validation-summary" aria-live="polite"></div>
          <CalibrationEditorControls workflow="h2r" />
          <div id="calib-sliders" class="calibration-joint-list"></div>
          <div class="workflow-button-row">
            <button id="calib-zero" type="button" class="btn secondary small">{{ text('Zero', '归零') }}</button>
            <button id="calib-restore" type="button" class="btn secondary small" disabled>{{ text('Reset', '重置') }}</button>
            <button id="calib-cancel" type="button" class="btn secondary small">{{ text('Cancel', '取消') }}</button>
            <button id="calib-save" type="button" class="btn small">{{ text('Save', '保存标定') }}</button>
          </div>
        </div>
      </div>
    </details>

    <details id="h2r-step-result" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('4. Result', '4. 结果') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div id="tour-retarget" class="workflow-field-grid">
          <label class="video-workflow-field">
            <span class="k">{{ text('Solver', '求解器') }}</span>
            <select id="rt-backend" class="search">
              <option value="newton">Newton IK</option>
              <option value="interaction_mesh">Interaction-Mesh</option>
            </select>
          </label>
          <label class="video-workflow-field">
            <span class="k">Retarget FPS</span>
            <input id="rt-retarget-fps" class="search" type="number" min="1" step="1" :placeholder="text('Original FPS', '动作原始帧率')" />
          </label>
        </div>
        <button id="retarget-btn" type="button" class="btn" disabled>{{ text('Start Retarget', '开始 Retarget') }}</button>
        <p id="retarget-disabled-reason" class="disabled-action-reason" role="status">{{ text('Select a motion and robot first.', '请先加载动作与机器人。') }}</p>
        <div id="rt-progress" class="progress video-workflow-progress" style="display:none"><div class="bar"></div></div>
        <p id="rt-status" class="hint workflow-status-line" role="status"></p>

        <ResultEvaluationPanel workflow="h2r" />

        <div id="rt-export-card" class="workflow-export-section" style="display:none">
          <div class="workflow-field-grid">
            <label class="video-workflow-field">
              <span class="k">{{ text('Export FPS', '导出 FPS') }}</span>
              <input id="rt-export-fps" class="search" type="number" min="1" step="1" :placeholder="text('Result FPS', '结果帧率')" />
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ text('Format', '格式') }}</span>
              <select id="rt-export-format" class="search">
                <option value="csv">CSV</option>
                <option value="pkl">PKL</option>
              </select>
            </label>
          </div>
          <div class="workflow-field-grid">
            <label class="video-workflow-field">
              <span class="k">{{ text('Start (s)', '起始 (s)') }}</span>
              <input id="rt-export-t-start" class="search" type="number" min="0" step="0.01" placeholder="0" />
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ text('End (s)', '截止 (s)') }}</span>
              <input id="rt-export-t-end" class="search" type="number" min="0" step="0.01" :placeholder="text('End', '结尾')" />
            </label>
          </div>
          <label class="workflow-checkbox-row">
            <input id="rt-csv-header" type="checkbox" checked />
            <span>{{ text('Include CSV header', 'CSV 含注释与列名表头') }}</span>
          </label>
          <p id="rt-export-srcfps" class="hint workflow-status-line"></p>
          <p id="rt-export-bundle-hint" class="hint workflow-status-line" style="display:none"></p>
          <button id="rt-export-btn" type="button" class="btn secondary">{{ text('Download result', '下载导出文件') }}</button>
        </div>
      </div>
    </details>

    <MotionPickerDialog
      :open="motionPickerOpen"
      :locale="locale"
      mode="load"
      asset-kind="human_motion"
      @close="motionPickerOpen = false"
      @import="openMotionImport"
    />
  </div>
</template>
