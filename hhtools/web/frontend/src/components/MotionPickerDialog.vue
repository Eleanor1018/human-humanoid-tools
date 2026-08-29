<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import SearchField from './SearchField.vue'
import type {
  LibraryAssetKind,
  LibraryEntry,
  MotionCategory,
  WorkspaceLocale,
} from '../runtime/types'

type MotionPickerMode = 'load' | 'basket'
type MotionPickerCategory = 'all' | MotionCategory

const props = withDefaults(defineProps<{
  open: boolean
  locale?: WorkspaceLocale
  mode?: MotionPickerMode
  assetKind?: LibraryAssetKind
}>(), {
  locale: 'en',
  mode: 'load',
  assetKind: 'human_motion',
})

const emit = defineEmits<{
  close: []
  import: [options?: { folder?: boolean }]
  selected: [entry: LibraryEntry]
}>()

const entries = ref<LibraryEntry[]>([])
const query = ref('')
const category = ref<MotionPickerCategory>('all')
const loading = ref(false)
const error = ref<string | null>(null)
const selectingKey = ref<string | null>(null)
const basketSubmitting = ref(false)
const basketSelection = ref<Map<string, LibraryEntry>>(new Map())

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

const isRobotTrajectoryPicker = computed(() => props.assetKind === 'robot_trajectory')

function normalizedAssetKind(entry: LibraryEntry): LibraryAssetKind {
  if (entry.asset_kind === 'robot_trajectory') return 'robot_trajectory'
  if (entry.asset_kind === 'human_motion') return 'human_motion'
  return entry.dataset === 'robot' || entry.dataset === 'r2r'
    ? 'robot_trajectory'
    : 'human_motion'
}

function normalizedCategory(entry: LibraryEntry): MotionCategory {
  return entry.motion_category === 'object' || entry.motion_category === 'terrain'
    ? entry.motion_category
    : 'motion'
}

function categoryLabel(value: MotionCategory): string {
  if (value === 'object') return isRobotTrajectoryPicker.value
    ? text('Interaction', '交互')
    : text('Object', '物体')
  if (value === 'terrain') return text('Terrain', '地形')
  return isRobotTrajectoryPicker.value ? text('Trajectory', '轨迹') : text('Motion', '动作')
}

function entryTitle(entry: LibraryEntry): string {
  return entry.stem || entry.sequence_id || entry.display_name || entry.name || (
    isRobotTrajectoryPicker.value
      ? text('Untitled trajectory', '未命名轨迹')
      : text('Untitled motion', '未命名动作')
  )
}

function entryContext(entry: LibraryEntry): string {
  return entry.folder_label || entry.dataset || (
    isRobotTrajectoryPicker.value
      ? text('Robot Trajectory Library', '机器人轨迹资源库')
      : text('Motion Library', '动作资源库')
  )
}

function entryKey(entry: LibraryEntry): string {
  return entry.source_path || `${entryContext(entry)}/${entryTitle(entry)}`
}

const filteredEntries = computed(() => {
  const tokens = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return entries.value.filter((entry) => {
    const entryCategory = normalizedCategory(entry)
    if (category.value !== 'all' && category.value !== entryCategory) return false
    const haystack = [
      entry.folder_label,
      entry.dataset,
      entry.stem,
      entry.sequence_id,
      entry.display_name,
      entry.name,
      entryCategory,
      categoryLabel(entryCategory),
    ].filter(Boolean).join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
})

const selectedEntries = computed(() => Array.from(basketSelection.value.values()))
const selectedCount = computed(() => selectedEntries.value.length)

function isSelected(entry: LibraryEntry): boolean {
  return basketSelection.value.has(entryKey(entry))
}

function toggleBasketEntry(entry: LibraryEntry): void {
  const key = entryKey(entry)
  const nextSelection = new Map(basketSelection.value)
  if (nextSelection.has(key)) nextSelection.delete(key)
  else nextSelection.set(key, entry)
  basketSelection.value = nextSelection
}

async function refreshEntries(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const bridge = window.__hhApp
    if (!bridge) throw new Error(text('The motion runtime is not ready yet.', '动作运行时尚未就绪。'))
    const response = await bridge.API.get('/api/library')
    entries.value = (response.entries || []).filter(
      (entry) => normalizedAssetKind(entry) === props.assetKind,
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function selectEntry(entry: LibraryEntry): Promise<void> {
  if (props.mode === 'basket') {
    toggleBasketEntry(entry)
    return
  }

  const bridge = window.__hhApp
  if (!bridge || selectingKey.value) return
  selectingKey.value = entryKey(entry)
  error.value = null
  try {
    if (isRobotTrajectoryPicker.value) await bridge.loadR2rLibraryEntry(entry)
    else await bridge.loadHumanMotionEntry(entry)
    emit('selected', entry)
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    selectingKey.value = null
  }
}

async function addSelectedToBasket(): Promise<void> {
  if (props.mode !== 'basket' || !selectedCount.value || basketSubmitting.value) return

  const bridge = window.__hhApp
  if (!bridge) {
    error.value = text('The motion runtime is not ready yet.', '动作运行时尚未就绪。')
    return
  }

  basketSubmitting.value = true
  error.value = null
  try {
    const selection = selectedEntries.value
    await bridge.addToBasket(selection)
    selection.forEach((entry) => emit('selected', entry))
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    basketSubmitting.value = false
  }
}

function importAsset(folder = false): void {
  emit('import', { folder })
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    category.value = 'all'
    basketSelection.value = new Map()
    void refreshEntries()
    void nextTick(() => document.getElementById('motion-picker-search')?.focus())
  },
  { immediate: true },
)

window.addEventListener('keydown', handleKeydown)
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="motion-picker-backdrop" @mousedown.self="emit('close')">
      <section
        class="motion-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="motion-picker-title"
      >
        <header class="motion-picker-head">
          <h2 id="motion-picker-title">
            {{ isRobotTrajectoryPicker
              ? text('Select source trajectory', '选择源轨迹')
              : mode === 'basket'
                ? text('Add motions', '添加动作')
                : text('Select motion', '选择动作') }}
          </h2>
          <button
            type="button"
            class="motion-picker-close"
            :aria-label="text('Close motion picker', '关闭动作选择窗口')"
            @click="emit('close')"
          >×</button>
        </header>

        <div class="motion-picker-tools">
          <SearchField
            id="motion-picker-search"
            v-model="query"
            :label="isRobotTrajectoryPicker ? text('Search trajectories', '搜索轨迹') : text('Search motions', '搜索动作')"
            :placeholder="isRobotTrajectoryPicker
              ? text('Search by trajectory or dataset…', '按轨迹或数据集搜索……')
              : text('Search by motion or dataset…', '按动作或数据集搜索……')"
            :clear-label="text('Clear search', '清除搜索')"
          />
          <select
            v-model="category"
            class="search motion-picker-filter"
            :aria-label="isRobotTrajectoryPicker
              ? text('Filter by trajectory type', '按轨迹类型筛选')
              : text('Filter by motion type', '按动作类型筛选')"
          >
            <option value="all">{{ text('All types', '全部类型') }}</option>
            <option value="motion">{{ isRobotTrajectoryPicker ? text('Trajectory', '轨迹') : text('Motion', '动作') }}</option>
            <option value="object">{{ isRobotTrajectoryPicker ? text('Interaction', '交互') : text('Object', '物体') }}</option>
            <option value="terrain">{{ text('Terrain', '地形') }}</option>
          </select>
        </div>

        <div
          class="motion-picker-list"
          role="listbox"
          :aria-busy="loading"
          :aria-multiselectable="mode === 'basket' ? 'true' : undefined"
        >
          <p v-if="loading" class="motion-picker-message">{{ text('Loading motions…', '正在读取动作……') }}</p>
          <div v-else-if="error" class="motion-picker-message error">
            <span>{{ error }}</span>
            <button type="button" class="btn secondary small" @click="refreshEntries">
              {{ text('Retry', '重试') }}
            </button>
          </div>
          <p v-else-if="!entries.length" class="motion-picker-message">
            {{ isRobotTrajectoryPicker
              ? text('No robot trajectories are available.', '暂无可用的机器人轨迹。')
              : text('The Motion Library is empty.', '动作资源库为空。') }}
          </p>
          <p v-else-if="!filteredEntries.length" class="motion-picker-message">
            {{ isRobotTrajectoryPicker
              ? text('No matching trajectories.', '没有匹配的轨迹。')
              : text('No matching motions.', '没有匹配的动作。') }}
          </p>
          <template v-else>
            <button
              v-for="entry in filteredEntries.slice(0, 300)"
              :key="entryKey(entry)"
              type="button"
              class="motion-picker-row"
              :class="{ 'is-selected': mode === 'basket' && isSelected(entry) }"
              role="option"
              :aria-selected="mode === 'basket' ? isSelected(entry) : undefined"
              :disabled="selectingKey !== null || basketSubmitting"
              @click="selectEntry(entry)"
            >
              <span class="motion-picker-row-copy">
                <strong>{{ entryTitle(entry) }}</strong>
                <small>{{ entryContext(entry) }}</small>
              </span>
              <span class="motion-picker-category" :data-category="normalizedCategory(entry)">
                {{ categoryLabel(normalizedCategory(entry)) }}
              </span>
              <span class="motion-picker-action">
                {{ mode === 'basket'
                  ? (isSelected(entry) ? text('Selected', '已选择') : text('Select', '选择'))
                  : selectingKey === entryKey(entry)
                  ? text('Loading…', '加载中……')
                  : text('Select', '选择') }}
              </span>
            </button>
          </template>
        </div>

        <footer class="motion-picker-actions">
          <div v-if="isRobotTrajectoryPicker" class="workflow-button-row">
            <button type="button" class="btn secondary small" @click="importAsset(false)">
              {{ text('Import file', '导入文件') }}
            </button>
            <button type="button" class="btn secondary small" @click="importAsset(true)">
              {{ text('Import folder', '导入文件夹') }}
            </button>
          </div>
          <button v-else type="button" class="btn secondary small" @click="importAsset(false)">
            {{ text('Import motion', '导入动作') }}
          </button>
          <div v-if="mode === 'basket'" class="motion-picker-basket-actions">
            <span class="motion-picker-selection-count" role="status" aria-live="polite">
              {{ text(`${selectedCount} selected`, `已选择 ${selectedCount} 条`) }}
            </span>
            <button type="button" class="btn secondary small" @click="emit('close')">
              {{ text('Cancel', '取消') }}
            </button>
            <button
              type="button"
              class="btn small motion-picker-add-selected"
              :disabled="!selectedCount || basketSubmitting"
              @click="addSelectedToBasket"
            >
              {{ basketSubmitting
                ? text('Adding…', '正在添加……')
                : text(
                  `Add ${selectedCount} ${selectedCount === 1 ? 'motion' : 'motions'}`,
                  `添加 ${selectedCount} 条动作`,
                ) }}
            </button>
          </div>
          <button v-else type="button" class="btn secondary small" @click="emit('close')">
            {{ text('Cancel', '取消') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
