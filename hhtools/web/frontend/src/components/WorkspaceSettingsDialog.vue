<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type {
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
  WorkspaceLocale,
} from '../runtime/types'

const props = defineProps<{
  open: boolean
  locale: WorkspaceLocale
  sidebarHidden: boolean
  inspectorHidden: boolean
  jobAdmission: JobAdmissionSnapshot | null
  jobAdmissionLoading: boolean
  jobAdmissionSaving: boolean
  jobAdmissionError: string | null
  jobAdmissionErrorOperation: 'load' | 'save' | null
  jobAdmissionSaved: boolean
  motionLibrary: MotionLibrarySettingsSnapshot | null
  motionLibraryLoading: boolean
  motionLibrarySaving: boolean
  motionLibraryError: string | null
  motionLibrarySaved: boolean
}>()

const emit = defineEmits<{
  close: []
  setLocale: [locale: WorkspaceLocale]
  setHidden: [side: 'sidebar' | 'inspector', hidden: boolean]
  reset: []
  refreshJobAdmission: []
  saveJobAdmission: [settings: JobAdmissionSettings]
  refreshMotionLibrary: []
  selectMotionLibraryRoot: []
}>()

const maxRunningJobsDraft = ref('0')
const maxQueuedJobsDraft = ref('0')

function syncJobAdmissionDraft(snapshot: JobAdmissionSnapshot): void {
  maxRunningJobsDraft.value = String(snapshot.max_running_jobs)
  maxQueuedJobsDraft.value = String(snapshot.max_queued_jobs)
}

watch(
  () => props.jobAdmission,
  (snapshot) => {
    if (snapshot) syncJobAdmissionDraft(snapshot)
  },
  { immediate: true },
)

// Reopening Settings deliberately discards an abandoned local edit and starts
// from the latest effective values obtained by App.vue.
watch(
  () => props.open,
  (open) => {
    if (open && props.jobAdmission) syncJobAdmissionDraft(props.jobAdmission)
  },
)

function parseDraft(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parsedMaxRunningJobs = computed(() => parseDraft(maxRunningJobsDraft.value))
const parsedMaxQueuedJobs = computed(() => parseDraft(maxQueuedJobsDraft.value))
const jobAdmissionDraftValid = computed(() => (
  parsedMaxRunningJobs.value !== null && parsedMaxQueuedJobs.value !== null
))
const jobAdmissionDirty = computed(() => (
  props.jobAdmission !== null
  && (parsedMaxRunningJobs.value !== props.jobAdmission.max_running_jobs
    || parsedMaxQueuedJobs.value !== props.jobAdmission.max_queued_jobs)
))
const canSaveJobAdmission = computed(() => (
  props.jobAdmission !== null
  && props.jobAdmission.editable === true
  && !props.jobAdmissionLoading
  && !props.jobAdmissionSaving
  && jobAdmissionDraftValid.value
  && jobAdmissionDirty.value
))
const queuedLimitDormant = computed(() => (
  props.jobAdmission !== null && parsedMaxRunningJobs.value === 0
))

type MotionLibraryReadOnlyKind = 'environment' | 'remote' | 'generic'

const motionLibraryReadOnlyKind = computed<MotionLibraryReadOnlyKind>(() => {
  const reason = props.motionLibrary?.readonly_reason?.trim().toLowerCase()
  const source = props.motionLibrary?.source?.trim().toLowerCase()
  if (
    reason === 'environment_override'
    || reason === 'environment'
    || source === 'environment_override'
    || source === 'environment'
  ) return 'environment'
  if (reason === 'remote' || reason === 'remote_client' || reason === 'non_loopback') return 'remote'
  return 'generic'
})

const copy = computed(() => props.locale === 'zh-CN'
  ? {
      title: '工作区设置',
      subtitle: '语言、工作区布局与后台任务调度',
      close: '关闭设置',
      workspaceSection: '工作区',
      language: '语言',
      languageDetail: '设置菜单和导航使用的语言。',
      left: '左侧导航',
      leftDetail: '保持工作区导航栏展开。',
      right: '右侧控制面板',
      rightDetail: '显示工作流控制与参数。',
      librarySection: '动作资源库',
      librarySectionDetail: '选择 hhtools 管理的资源库容器；保存后立即生效，原目录内容不会被移动。',
      libraryRoot: '资源库目录',
      librarySelect: '选择目录',
      librarySelecting: '选择中…',
      libraryLoading: '正在读取资源库设置…',
      librarySaved: '资源库目录已切换，无需重启。',
      libraryReadOnly: '服务端已将资源库目录设为只读。请检查服务器启动配置或连接权限。',
      libraryReadOnlyRemote: '当前为远程只读连接。请在服务器本机、Electron，或 SSH 本地回环隧道中修改目录。',
      libraryReadOnlyEnvironment: '当前目录由 HHTOOLS_MOTION_LIBRARY_ROOT 管理。请修改或移除该环境变量，然后重启服务。',
      libraryRetry: '重新读取',
      jobsSection: '后台任务调度',
      jobsSectionDetail: '本机 Web/Electron（或 SSH 本地回环隧道）保存后立即生效，不会中断正在运行的任务，也无需重启。',
      running: '最大并发任务数',
      runningDetail: '同时执行的后台任务数量；0 表示不限制并发。',
      queued: '最大等待任务数',
      queuedDetail: '并发受限时允许排队的任务数量；0 表示等待队列不限。',
      queueDormant: '当前最大并发任务数为 0，等待队列上限暂不生效，但仍可编辑和保存。',
      readOnlyJobs: '当前为远程只读连接。请在服务器本机、Electron，或 SSH 本地回环隧道中修改此配置。',
      invalidInteger: '请输入 0 或更大的整数。',
      loadingJobs: '正在读取任务调度配置…',
      activity: (snapshot: JobAdmissionSnapshot) => `当前任务：运行 ${snapshot.running_jobs} · 等待 ${snapshot.queued_jobs} · 预留 ${snapshot.reserved_jobs}`,
      retryLoad: '重新读取',
      saved: '已保存并立即生效，无需重启。',
      save: '保存任务配置',
      saving: '保存中…',
      reset: '↺ 重置布局',
      done: '完成',
    }
  : {
      title: 'Workspace Settings',
      subtitle: 'Language, workspace layout, and background-job scheduling',
      close: 'Close settings',
      workspaceSection: 'Workspace',
      language: 'Language',
      languageDetail: 'Set the language used by menus and navigation.',
      left: 'Left navigation',
      leftDetail: 'Keep the workspace navigation expanded.',
      right: 'Right inspector',
      rightDetail: 'Show workflow controls and parameters.',
      librarySection: 'Motion library',
      librarySectionDetail: 'Choose the hhtools-managed library container. Changes apply immediately; existing files are not moved.',
      libraryRoot: 'Library directory',
      librarySelect: 'Choose directory',
      librarySelecting: 'Choosing…',
      libraryLoading: 'Loading motion-library settings…',
      librarySaved: 'Library directory changed. No restart is required.',
      libraryReadOnly: 'The server has made this directory read-only. Check the server launch configuration or connection permissions.',
      libraryReadOnlyRemote: 'This remote connection is read-only. Change the directory on the server, in Electron, or through an SSH loopback tunnel.',
      libraryReadOnlyEnvironment: 'This directory is managed by HHTOOLS_MOTION_LIBRARY_ROOT. Change or remove that environment variable, then restart the service.',
      libraryRetry: 'Reload',
      jobsSection: 'Background-job scheduling',
      jobsSectionDetail: 'Local Web/Electron (or an SSH loopback tunnel) applies saved limits immediately without interrupting active jobs; no restart is required.',
      running: 'Maximum running jobs',
      runningDetail: 'Background jobs allowed to run concurrently; 0 means unlimited.',
      queued: 'Maximum queued jobs',
      queuedDetail: 'Jobs allowed to wait when concurrency is limited; 0 means an unlimited queue.',
      queueDormant: 'The running limit is 0, so the queue limit is currently inactive, but it can still be edited and saved.',
      readOnlyJobs: 'This remote connection is read-only. Change these settings on the server, in Electron, or through an SSH loopback tunnel.',
      invalidInteger: 'Enter an integer greater than or equal to 0.',
      loadingJobs: 'Loading job-admission settings…',
      activity: (snapshot: JobAdmissionSnapshot) => `Current jobs: ${snapshot.running_jobs} running · ${snapshot.queued_jobs} queued · ${snapshot.reserved_jobs} reserved`,
      retryLoad: 'Reload',
      saved: 'Saved and applied immediately. No restart is required.',
      save: 'Save job settings',
      saving: 'Saving…',
      reset: '↺ Reset layout',
      done: 'Done',
    })

const motionLibraryReadOnlyCopy = computed(() => {
  if (motionLibraryReadOnlyKind.value === 'environment') return copy.value.libraryReadOnlyEnvironment
  if (motionLibraryReadOnlyKind.value === 'remote') return copy.value.libraryReadOnlyRemote
  return copy.value.libraryReadOnly
})

function saveJobAdmission(): void {
  if (!canSaveJobAdmission.value) return
  // The validation computed above guarantees both values are non-null here.
  emit('saveJobAdmission', {
    max_running_jobs: parsedMaxRunningJobs.value as number,
    max_queued_jobs: parsedMaxQueuedJobs.value as number,
  })
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="workspace-settings-backdrop" @mousedown.self="emit('close')">
      <section class="workspace-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title">
        <header class="workspace-settings-head">
          <div>
            <h2 id="workspace-settings-title">{{ copy.title }}</h2>
            <p>{{ copy.subtitle }}</p>
          </div>
          <button type="button" class="workspace-settings-close" :aria-label="copy.close" @click="emit('close')">×</button>
        </header>
        <div class="workspace-settings-body">
          <div class="workspace-settings-section-head">{{ copy.workspaceSection }}</div>
          <label class="workspace-setting-row">
            <span>
              <strong>{{ copy.language }}</strong>
              <small>{{ copy.languageDetail }}</small>
            </span>
            <select
              class="workspace-language-select"
              :value="locale"
              @change="emit('setLocale', ($event.target as HTMLSelectElement).value as WorkspaceLocale)"
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <label class="workspace-setting-row">
            <span>
              <strong>{{ copy.left }}</strong>
              <small>{{ copy.leftDetail }}</small>
            </span>
            <input type="checkbox" :checked="!sidebarHidden" @change="emit('setHidden', 'sidebar', !($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="workspace-setting-row">
            <span>
              <strong>{{ copy.right }}</strong>
              <small>{{ copy.rightDetail }}</small>
            </span>
            <input type="checkbox" :checked="!inspectorHidden" @change="emit('setHidden', 'inspector', !($event.target as HTMLInputElement).checked)" />
          </label>

          <div class="workspace-settings-section-head workspace-settings-library-head">
            <span>{{ copy.librarySection }}</span>
            <small>{{ copy.librarySectionDetail }}</small>
          </div>
          <div class="workspace-setting-row workspace-library-setting-row">
            <span>
              <strong>{{ copy.libraryRoot }}</strong>
              <code class="workspace-library-root" :title="motionLibrary?.root || undefined">{{ motionLibrary?.root || '—' }}</code>
            </span>
            <button
              type="button"
              class="workspace-library-select"
              :disabled="motionLibraryLoading || motionLibrarySaving || motionLibrary === null || motionLibrary.editable !== true"
              @click="emit('selectMotionLibraryRoot')"
            >{{ motionLibrarySaving ? copy.librarySelecting : copy.librarySelect }}</button>
          </div>
          <p v-if="motionLibrary && motionLibrary.editable !== true" class="workspace-settings-note">{{ motionLibraryReadOnlyCopy }}</p>
          <p v-if="motionLibraryLoading" class="workspace-settings-message" role="status">{{ copy.libraryLoading }}</p>
          <div v-else-if="motionLibraryError" class="workspace-settings-message error" role="alert">
            <span>{{ motionLibraryError }}</span>
            <button
              type="button"
              class="workspace-settings-retry"
              :disabled="motionLibrarySaving"
              @click="emit('refreshMotionLibrary')"
            >{{ copy.libraryRetry }}</button>
          </div>
          <p v-else-if="motionLibrarySaved" class="workspace-settings-message success" role="status">{{ copy.librarySaved }}</p>

          <div class="workspace-settings-section-head workspace-settings-jobs-head">
            <span>{{ copy.jobsSection }}</span>
            <small>{{ copy.jobsSectionDetail }}</small>
          </div>
          <label class="workspace-setting-row workspace-setting-number-row">
            <span>
              <strong>{{ copy.running }}</strong>
              <small>{{ copy.runningDetail }}</small>
            </span>
            <input
              class="workspace-number-input workspace-max-running-jobs"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :value="maxRunningJobsDraft"
              :disabled="jobAdmissionLoading || jobAdmissionSaving || jobAdmission === null || jobAdmission.editable !== true"
              :aria-invalid="parsedMaxRunningJobs === null"
              @input="maxRunningJobsDraft = ($event.target as HTMLInputElement).value"
              @keydown.enter.prevent="saveJobAdmission"
            />
          </label>
          <label class="workspace-setting-row workspace-setting-number-row">
            <span>
              <strong>{{ copy.queued }}</strong>
              <small>{{ copy.queuedDetail }}</small>
            </span>
            <input
              class="workspace-number-input workspace-max-queued-jobs"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :value="maxQueuedJobsDraft"
              :disabled="jobAdmissionLoading || jobAdmissionSaving || jobAdmission === null || jobAdmission.editable !== true"
              :aria-invalid="parsedMaxQueuedJobs === null"
              @input="maxQueuedJobsDraft = ($event.target as HTMLInputElement).value"
              @keydown.enter.prevent="saveJobAdmission"
            />
          </label>
          <p v-if="jobAdmission && jobAdmission.editable !== true" class="workspace-settings-note">{{ copy.readOnlyJobs }}</p>
          <p v-if="queuedLimitDormant" class="workspace-settings-note">{{ copy.queueDormant }}</p>
          <p v-if="!jobAdmissionDraftValid" class="workspace-settings-message error" role="alert">{{ copy.invalidInteger }}</p>
          <p v-else-if="jobAdmissionLoading" class="workspace-settings-message" role="status">{{ copy.loadingJobs }}</p>
          <div v-else-if="jobAdmissionError" class="workspace-settings-message error" role="alert">
            <span>{{ jobAdmissionError }}</span>
            <!-- Loading errors may be retried with a fresh GET. Save errors keep
                 the current draft and use the normal Save button, so a failed
                 PATCH can never overwrite the user's edits with stale values. -->
            <button
              v-if="jobAdmissionErrorOperation === 'load'"
              type="button"
              class="workspace-settings-retry"
              :disabled="jobAdmissionSaving"
              @click="emit('refreshJobAdmission')"
            >{{ copy.retryLoad }}</button>
          </div>
          <p v-else-if="jobAdmissionSaved && !jobAdmissionDirty" class="workspace-settings-message success" role="status">{{ copy.saved }}</p>
          <p v-else-if="jobAdmission" class="workspace-settings-message" role="status">{{ copy.activity(jobAdmission) }}</p>
        </div>
        <footer class="workspace-settings-actions">
          <button type="button" class="workspace-settings-reset" @click="emit('reset')">{{ copy.reset }}</button>
          <div class="workspace-settings-primary-actions">
            <button
              type="button"
              class="workspace-settings-save"
              :disabled="!canSaveJobAdmission"
              @click="saveJobAdmission"
            >{{ jobAdmissionSaving ? copy.saving : copy.save }}</button>
            <button type="button" class="workspace-settings-done" @click="emit('close')">{{ copy.done }}</button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
