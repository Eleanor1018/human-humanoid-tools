<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import MotionPickerDialog from './MotionPickerDialog.vue'
import SearchField from './SearchField.vue'
import type { MotionCategory, WorkspaceLocale, WorkspacePanelId } from '../runtime/types'

type BatchCategory = 'all' | MotionCategory

const props = withDefaults(defineProps<{
  active: boolean
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const emit = defineEmits<{
  'request-panel': [panel: WorkspacePanelId]
}>()

const pickerOpen = ref(false)
const basketQuery = ref('')
const basketCategory = ref<BatchCategory>('all')

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

function publishFilter(): void {
  window.dispatchEvent(new CustomEvent('hhtools:batch-filter', {
    detail: {
      query: basketQuery.value,
      category: basketCategory.value,
    },
  }))
}

function handleBasketChanged(): void {
  // Re-publish the current filter after the legacy runtime mutates the list.
  // This keeps the Vue search controls and runtime-rendered rows in sync.
  publishFilter()
}

function importFromMotionWorkspace(): void {
  pickerOpen.value = false
  emit('request-panel', 'motion')
}

watch([basketQuery, basketCategory], publishFilter)
watch(() => props.active, (active) => {
  if (!active) pickerOpen.value = false
})

onMounted(() => window.addEventListener('hhtools:batch-basket-changed', handleBasketChanged))
onBeforeUnmount(() => window.removeEventListener('hhtools:batch-basket-changed', handleBasketChanged))
</script>

<template>
  <!-- `#stage` belongs to the same App render tree. Vue 3.5's deferred
       Teleport resolves it after the stage has mounted, before the imperative
       runtime binds the stable IDs inside this workspace. -->
  <Teleport defer to="#stage">
    <section
      v-show="active"
      class="batch-stage-workspace"
      :aria-label="text('Batch inputs', '批量输入')"
    >
      <header class="batch-stage-header">
        <div>
          <h1>{{ text('Batch inputs', '批量输入') }}</h1>
          <p>{{ text('Build and validate the clip set before submitting a task.', '先整理并检查动作清单，再提交批量任务。') }}</p>
        </div>
        <div class="batch-stage-count" aria-live="polite">
          <strong id="basket-count">0</strong>
          <span>{{ text('clips', '条动作') }}</span>
        </div>
      </header>

      <div class="batch-stage-toolbar">
        <button id="batch-library-open" type="button" class="btn" @click="pickerOpen = true">
          {{ text('Add from Library', '从资源库添加') }}
        </button>
        <button id="batch-pick-file" type="button" class="btn secondary">
          {{ text('Import file', '导入文件') }}
        </button>
        <button id="batch-pick-folder" type="button" class="btn secondary">
          {{ text('Import folder', '导入文件夹') }}
        </button>
        <SearchField
          id="batch-basket-search"
          v-model="basketQuery"
          :label="text('Search batch inputs', '搜索批量动作')"
          :placeholder="text('Search clips…', '搜索动作……')"
          :clear-label="text('Clear batch search', '清除批量搜索')"
        />
        <select
          id="batch-basket-filter"
          v-model="basketCategory"
          class="search batch-basket-filter"
          :aria-label="text('Filter batch inputs by motion type', '按动作类型筛选批量清单')"
        >
          <option value="all">{{ text('All types', '全部类型') }}</option>
          <option value="motion">{{ text('Motion', '纯动作') }}</option>
          <option value="object">{{ text('Object', '物体交互') }}</option>
          <option value="terrain">{{ text('Terrain', '地形场景') }}</option>
        </select>
      </div>

      <div id="basket-drop" class="batch-basket-frame">
        <div class="batch-basket-columns" aria-hidden="true">
          <span class="batch-basket-check-column"></span>
          <span>{{ text('Clip', '动作') }}</span>
          <span>{{ text('Type', '类型') }}</span>
          <span>{{ text('Reference', '参考骨架') }}</span>
          <span>{{ text('Actions', '操作') }}</span>
        </div>
        <div id="basket-list" class="batch-basket-list" aria-live="polite"></div>
      </div>

      <footer class="batch-stage-footer">
        <label class="batch-select-all">
          <input id="batch-select-all" type="checkbox" />
          <span>{{ text('Select all visible', '全选当前结果') }}</span>
        </label>
        <span id="batch-selected-count" class="batch-selected-count">{{ text('0 selected', '已选择 0 条') }}</span>
        <span class="spacer"></span>
        <button id="batch-remove-selected" type="button" class="btn secondary small" disabled>
          {{ text('Remove selected', '移除所选') }}
        </button>
        <button id="basket-clear" type="button" class="btn secondary small" disabled>
          {{ text('Clear all', '清空全部') }}
        </button>
      </footer>

      <p class="batch-drop-hint">
        {{ text('You can also drop files or folders anywhere in the list.', '也可以把文件或文件夹直接拖入清单区域。') }}
      </p>
    </section>
  </Teleport>

  <div class="panel-stack batch-workflow-stack">
    <h2>{{ text('Batch', '批量处理') }}</h2>
    <p class="batch-workflow-scope">{{ text('Human motions → one target robot', '人体动作 → 单个目标机器人') }}</p>

    <div class="batch-step-summary">
      <span>{{ text('1. Inputs', '1. 输入动作') }}</span>
      <strong><span id="batch-inspector-count">0</span> {{ text('clips', '条') }}</strong>
    </div>

    <details class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('2. Target robot & compatibility', '2. 目标机器人与兼容性') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-picker-row">
          <select
            id="batch-robot-select"
            class="search"
            :aria-label="text('Select target robot', '选择目标机器人')"
          ></select>
          <button type="button" class="btn secondary small" @click="emit('request-panel', 'robot-assets')">
            {{ text('Import robot', '导入机器人') }}
          </button>
        </div>
        <button id="batch-robot-load" type="button" class="btn workflow-load-button" disabled>
          {{ text('Load target robot', '加载目标机器人') }}
        </button>
        <p id="batch-robot" class="workflow-status-line" role="status">{{ text('Not loaded', '未加载') }}</p>
        <div id="batch-ref-hint" class="batch-compatibility-list" aria-live="polite"></div>
      </div>
    </details>

    <details class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('3. Run settings', '3. 运行设置') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <div class="workflow-field-grid">
          <label class="video-workflow-field">
            <span class="k">{{ text('Solver', '求解器') }}</span>
            <select id="batch-backend" class="search">
              <option value="newton">Newton IK</option>
              <option value="interaction_mesh">Interaction-Mesh</option>
            </select>
          </label>
          <label class="video-workflow-field">
            <span class="k">{{ text('Output format', '输出格式') }}</span>
            <select id="batch-format" class="search">
              <option value="pkl">PKL</option>
              <option value="csv">CSV</option>
            </select>
          </label>
        </div>
        <p id="batch-settings-note" class="batch-settings-note"></p>

        <details class="batch-advanced-settings">
          <summary>{{ text('Advanced settings', '高级设置') }}</summary>
          <div class="batch-advanced-settings-body">
            <label class="video-workflow-field" id="batch-size-field">
              <span class="k">{{ text('GPU batch size', 'GPU 批大小') }}</span>
              <input id="batch-size" class="search" type="number" min="1" max="256" step="1" :placeholder="text('Auto (default 16)', '自动（默认 16）')" />
              <small>{{ text('The server may lower this value for the selected robot and device.', '服务器会根据机器人与设备能力自动下调。') }}</small>
            </label>
            <div class="workflow-field-grid">
              <label class="video-workflow-field">
                <span class="k">Retarget FPS</span>
                <input id="batch-retarget-fps" class="search" type="number" min="1" step="1" :placeholder="text('Original', '原始帧率')" />
              </label>
              <label class="video-workflow-field">
                <span class="k">Export FPS</span>
                <input id="batch-export-fps" class="search" type="number" min="1" step="1" :placeholder="text('Same as Retarget', '与 Retarget 相同')" />
              </label>
            </div>
            <div class="workflow-field-grid">
              <label class="video-workflow-field">
                <span class="k">{{ text('Start (s)', '起始 (s)') }}</span>
                <input id="batch-export-t-start" class="search" type="number" min="0" step="0.01" placeholder="0" />
              </label>
              <label class="video-workflow-field">
                <span class="k">{{ text('End (s)', '截止 (s)') }}</span>
                <input id="batch-export-t-end" class="search" type="number" min="0" step="0.01" :placeholder="text('End of each clip', '每条动作结尾')" />
              </label>
            </div>
            <label id="batch-csv-header-row" class="workflow-checkbox-row">
              <input id="batch-csv-header" type="checkbox" checked />
              <span>{{ text('Include CSV comments and column headers', 'CSV 含注释与列名表头') }}</span>
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ text('Result name', '结果名称') }}</span>
              <input id="batch-out" class="search" value="batch_export" :placeholder="text('ZIP filename', 'ZIP 文件名')" />
            </label>
          </div>
        </details>
      </div>
    </details>

    <section class="batch-run-panel" aria-labelledby="batch-run-title">
      <div class="batch-run-heading">
        <h3 id="batch-run-title">{{ text('4. Run', '4. 执行') }}</h3>
        <span class="batch-task-note">{{ text('Continues in Tasks', '任务会在底部继续运行') }}</span>
      </div>
      <p id="batch-run-summary" class="batch-run-summary">{{ text('No inputs selected.', '尚未选择输入动作。') }}</p>
      <button id="batch-run" type="button" class="btn" disabled>
        {{ text('Start batch task', '开始批量任务') }}
      </button>
      <p id="batch-disabled-reason" class="disabled-action-reason" role="status">
        {{ text('Add motions and select a target robot first.', '请先添加动作并选择目标机器人。') }}
      </p>

      <div id="batch-progress-stack" class="batch-progress-stack hidden">
        <div class="batch-progress-row">
          <span class="batch-progress-label">{{ text('Overall', '总进度') }}</span>
          <div id="batch-progress-total" class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar"></div></div>
        </div>
        <div class="batch-progress-row">
          <span class="batch-progress-label">{{ text('Current', '当前批次') }}</span>
          <div id="batch-progress-clip" class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar"></div></div>
        </div>
      </div>
      <p id="batch-status" class="workflow-status-line" role="status" aria-live="polite"></p>

      <div id="batch-result-card" class="batch-result-card hidden" aria-live="polite">
        <strong id="batch-result-title">{{ text('Batch complete', '批量任务完成') }}</strong>
        <p id="batch-result-summary"></p>
        <div class="workflow-button-row">
          <button id="batch-result-download" type="button" class="btn secondary small">
            {{ text('Download ZIP', '下载 ZIP') }}
          </button>
          <button id="batch-result-retry" type="button" class="btn secondary small" hidden>
            {{ text('Retry failed only', '仅重试失败项') }}
          </button>
          <button id="batch-result-tasks" type="button" class="btn secondary small">
            {{ text('Open Tasks', '打开任务面板') }}
          </button>
        </div>
      </div>
      <div id="batch-failures" class="batch-failures hidden"></div>
    </section>

    <MotionPickerDialog
      :open="pickerOpen"
      :locale="locale"
      mode="basket"
      asset-kind="human_motion"
      @close="pickerOpen = false"
      @import="importFromMotionWorkspace"
    />
  </div>
</template>
