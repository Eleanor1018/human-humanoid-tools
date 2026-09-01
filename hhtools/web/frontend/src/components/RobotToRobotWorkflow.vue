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

const trajectoryPickerOpen = ref(false)

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

async function importTrajectory(options?: { folder?: boolean }): Promise<void> {
  trajectoryPickerOpen.value = false
  await window.__hhApp?.pickR2rTrajectory({ folder: options?.folder === true })
}
</script>

<template>
  <div class="panel-stack workflow-panel-stack">
    <h2>{{ text('Robot → Robot', '机器人 → 机器人') }}</h2>
    <WorkflowPipeline workflow="r2r" :locale="locale" />

    <details id="r2r-step-source" class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('1. Source robot', '1. 源机器人') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-picker-row">
          <select id="r2r-source-select" class="search"></select>
          <button type="button" class="btn secondary small" @click="emit('request-panel', 'robot-assets')">
            {{ text('Import robot', '导入机器人') }}
          </button>
        </div>
        <button id="r2r-source-load" type="button" class="btn workflow-load-button">
          {{ text('Load robot', '加载机器人') }}
        </button>
        <p id="r2r-source-status" class="hint workflow-status-line" role="status">{{ text('No source robot loaded.', '尚未加载源机器人。') }}</p>
      </div>
    </details>

    <details id="r2r-step-trajectory" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('2. Source trajectory', '2. 源轨迹') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-selection-row">
          <span id="r2r-trajectory-value" class="workflow-selection-value">{{ text('Not loaded', '未加载') }}</span>
          <button type="button" class="btn secondary small" @click="trajectoryPickerOpen = true">
            {{ text('Select trajectory', '选择轨迹') }}
          </button>
        </div>
        <label class="video-workflow-field workflow-inline-field">
          <span class="k">{{ text('Source trajectory FPS', '源轨迹 FPS') }}</span>
          <input id="r2r-source-fps" class="search" type="number" min="1" step="1" value="50" />
        </label>
        <p id="r2r-traj-status" class="hint workflow-status-line" role="status">{{ text('Load the source robot, then select a trajectory.', '先加载源机器人，再选择轨迹。') }}</p>
        <div id="r2r-traj-progress" class="progress video-workflow-progress" style="display:none"><div class="bar"></div></div>
      </div>
    </details>

    <details id="r2r-step-target" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('3. Target robot', '3. 目标机器人') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-picker-row">
          <select id="r2r-target-select" class="search"></select>
          <button type="button" class="btn secondary small" @click="emit('request-panel', 'robot-assets')">
            {{ text('Import robot', '导入机器人') }}
          </button>
        </div>
        <button id="r2r-target-load" type="button" class="btn workflow-load-button">
          {{ text('Load robot', '加载机器人') }}
        </button>
        <p id="r2r-target-status" class="hint workflow-status-line" role="status">{{ text('No target robot loaded.', '尚未加载目标机器人。') }}</p>
      </div>
    </details>

    <details id="r2r-step-calibration" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('4. Calibration', '4. 标定') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-selection-row">
          <div class="workflow-selection-copy">
            <span class="k">{{ text('Calibration', '标定') }}</span>
            <strong id="r2r-cal"><span class="status-chip"><span class="dot"></span>—</span></strong>
          </div>
          <button id="r2r-calib-btn" type="button" class="btn secondary small" disabled>
            {{ text('Calibrate', '开始标定') }}
          </button>
        </div>
        <p id="r2r-calibration-scope" class="hint workflow-status-line">{{ text('Target robot + source robot', '目标机器人 + 源机器人') }}</p>
        <div id="r2r-calibration-validation-summary" class="validation-summary" aria-live="polite"></div>
        <div id="r2r-calibration-save-summary" class="calibration-save-summary" aria-live="polite"></div>

        <div id="r2r-calib-edit" class="workflow-calibration-editor" style="display:none">
          <CalibrationEditorControls workflow="r2r" :locale="locale" />
          <div id="r2r-calib-sliders" class="calibration-joint-list"></div>
          <div class="workflow-button-row">
            <button id="r2r-calib-zero" type="button" class="btn secondary small">{{ text('Zero', '归零') }}</button>
            <button id="r2r-calib-cancel" type="button" class="btn secondary small">{{ text('Cancel', '取消') }}</button>
            <button id="r2r-calib-save" type="button" class="btn small">{{ text('Save', '保存标定') }}</button>
          </div>
        </div>
      </div>
    </details>

    <details id="r2r-step-result" class="video-workflow-step">
      <summary class="video-workflow-step-summary">
        <span>{{ text('5. Result', '5. 结果') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-field-grid">
          <label class="video-workflow-field">
            <span class="k">{{ text('Solver', '求解器') }}</span>
            <select id="r2r-backend" class="search">
              <option value="newton">Newton IK</option>
              <option value="interaction_mesh">Interaction-Mesh</option>
            </select>
          </label>
          <label class="video-workflow-field">
            <span class="k">Retarget FPS</span>
            <input id="r2r-retarget-fps" class="search" type="number" min="1" step="1" :placeholder="text('Trajectory FPS', '轨迹原始帧率')" />
          </label>
        </div>
        <button id="r2r-retarget-btn" type="button" class="btn" disabled>{{ text('Start Retarget', '开始 Retarget') }}</button>
        <p id="r2r-disabled-reason" class="disabled-action-reason" role="status">{{ text('Select the source robot, trajectory, and target robot first.', '请先加载源机器人、源轨迹与目标机器人。') }}</p>
        <div id="r2r-progress" class="progress video-workflow-progress" style="display:none"><div class="bar"></div></div>
        <p id="r2r-status" class="hint workflow-status-line" role="status"></p>

        <ResultEvaluationPanel workflow="r2r" :locale="locale" />

        <div id="r2r-export-card" class="workflow-export-section" style="display:none">
          <div class="workflow-field-grid">
            <label class="video-workflow-field">
              <span class="k">{{ text('Export FPS', '导出 FPS') }}</span>
              <input id="r2r-export-fps" class="search" type="number" min="1" step="1" :placeholder="text('Result FPS', '结果帧率')" />
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ text('Format', '格式') }}</span>
              <select id="r2r-export-format" class="search">
                <option value="csv">CSV</option>
                <option value="pkl">PKL</option>
              </select>
            </label>
          </div>
          <div class="workflow-field-grid">
            <label class="video-workflow-field">
              <span class="k">{{ text('Start (s)', '起始 (s)') }}</span>
              <input id="r2r-export-t-start" class="search" type="number" min="0" step="0.01" placeholder="0" />
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ text('End (s)', '截止 (s)') }}</span>
              <input id="r2r-export-t-end" class="search" type="number" min="0" step="0.01" :placeholder="text('End', '结尾')" />
            </label>
          </div>
          <label class="workflow-checkbox-row">
            <input id="r2r-csv-header" type="checkbox" checked />
            <span>{{ text('Include CSV header', 'CSV 含注释与列名表头') }}</span>
          </label>
          <p id="r2r-export-bundle-hint" class="hint workflow-status-line" style="display:none"></p>
          <button id="r2r-export-btn" type="button" class="btn secondary">{{ text('Download result', '下载导出文件') }}</button>
        </div>
      </div>
    </details>

    <!-- File-menu commands retain stable import hooks. The visible R2R batch
         workspace now lives under Batch, alongside the H2R batch mode. -->
    <div class="workflow-hidden-runtime" hidden aria-hidden="true">
      <div id="r2r-drop-mimic" data-r2r-profile="mimic">
        <button type="button" data-r2r-pick="mimic"></button>
        <button type="button" data-r2r-pick="mimic" data-folder="1"></button>
      </div>
      <div id="r2r-drop-intermimic" data-r2r-profile="intermimic">
        <button type="button" data-r2r-pick="intermimic" data-folder="1"></button>
      </div>
      <div id="r2r-drop-meshmimic" data-r2r-profile="meshmimic">
        <button type="button" data-r2r-pick="meshmimic" data-folder="1"></button>
      </div>
    </div>

    <MotionPickerDialog
      :open="trajectoryPickerOpen"
      :locale="locale"
      mode="load"
      asset-kind="robot_trajectory"
      @close="trajectoryPickerOpen = false"
      @import="importTrajectory"
    />
  </div>
</template>
