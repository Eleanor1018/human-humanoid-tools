<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { usePanelLayout } from './composables/usePanelLayout'
import AboutDialog from './components/AboutDialog.vue'
import BatchWorkflow from './components/BatchWorkflow.vue'
import PlaybackBar from './components/PlaybackBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import DataAnalysisPipeline from './components/DataAnalysisPipeline.vue'
import DesktopMenuBar from './components/DesktopMenuBar.vue'
import HumanToRobotWorkflow from './components/HumanToRobotWorkflow.vue'
import JobDrawer from './components/JobDrawer.vue'
import RobotToRobotWorkflow from './components/RobotToRobotWorkflow.vue'
import SearchField from './components/SearchField.vue'
import SidebarNavigation from './components/SidebarNavigation.vue'
import VideoToMotionPipeline from './components/VideoToMotionPipeline.vue'
import WorkspaceDrawerHandle from './components/WorkspaceDrawerHandle.vue'
import WorkspaceSettingsDialog from './components/WorkspaceSettingsDialog.vue'
import type {
  ImportCommandTarget,
  GvhmrOptionalComponentState,
  GvhmrRuntimeStatus,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
  WorkspacePanelId,
  WorkspaceTheme,
} from './runtime/types'
import {
  loadWorkspacePreferences,
  updateWorkspacePreferences,
} from './runtime/workspace-preferences'

const isElectronHost = window.hhtoolsDesktop !== undefined
const panelLayout = usePanelLayout({ docked: true })
const initialWorkspacePreferences = loadWorkspacePreferences()
const activePanel = ref<WorkspacePanelId>(initialWorkspacePreferences.activePanel)
const workspaceLocale = ref(initialWorkspacePreferences.locale)
const workspaceTheme = ref<WorkspaceTheme>(initialWorkspacePreferences.theme)
const settingsOpen = ref(false)
const aboutOpen = ref(false)
const jobAdmission = ref<JobAdmissionSnapshot | null>(null)
const jobAdmissionLoading = ref(false)
const jobAdmissionSaving = ref(false)
const jobAdmissionError = ref<string | null>(null)
const jobAdmissionErrorOperation = ref<'load' | 'save' | null>(null)
const jobAdmissionSaved = ref(false)
const motionLibrarySettings = ref<MotionLibrarySettingsSnapshot | null>(null)
const motionLibrarySettingsLoading = ref(false)
const motionLibrarySettingsSaving = ref(false)
const motionLibrarySettingsError = ref<string | null>(null)
const motionLibrarySettingsSaved = ref(false)
const gvhmrComponent = ref<GvhmrOptionalComponentState | null>(null)
const gvhmrRuntime = ref<GvhmrRuntimeStatus | null>(null)
const gvhmrLoading = ref(false)
const gvhmrSetupRunning = ref(false)
const gvhmrError = ref<string | null>(null)
const motionLibrarySearch = ref('')
const robotLibrarySearch = ref('')
type MotionUploadProfile = 'intermimic' | 'meshmimic' | 'mimic'
const motionUploadProfiles: ReadonlyArray<{ id: MotionUploadProfile; label: string }> = [
  { id: 'mimic', label: 'mimic' },
  { id: 'intermimic', label: 'intermimic' },
  { id: 'meshmimic', label: 'meshmimic' },
]
const motionUploadProfileMeta: Record<MotionUploadProfile, {
  glyph: string
  dropHintEn: string
  dropHintZh: string
}> = {
  mimic: {
    glyph: '🎞',
    dropHintEn: 'Drop a motion file or folder',
    dropHintZh: '拖入动作文件或文件夹',
  },
  intermimic: {
    glyph: '📦',
    dropHintEn: 'Drop a complete object-interaction motion folder',
    dropHintZh: '拖入完整的物体交互动作文件夹',
  },
  meshmimic: {
    glyph: '⛰',
    dropHintEn: 'Drop a complete terrain-motion folder',
    dropHintZh: '拖入完整的地形动作文件夹',
  },
}
const activeMotionUploadProfile = ref<MotionUploadProfile>('mimic')
const motionUploadInfoOpen = ref(false)
type RobotUploadInfo = 'urdf' | 'mesh'
const robotUploadInfoOpen = ref<RobotUploadInfo | null>(null)

document.documentElement.lang = workspaceLocale.value
document.documentElement.dataset.theme = workspaceTheme.value

function workspaceText(en: string, zh: string): string {
  return workspaceLocale.value === 'en' ? en : zh
}

function setWorkspaceLocale(locale: typeof workspaceLocale.value): void {
  workspaceLocale.value = locale
  document.documentElement.lang = locale
  updateWorkspacePreferences({ locale })
  // Most workspace copy is rendered by Vue, while library rows are rendered
  // by the legacy runtime. Notify that runtime so both layers switch language
  // after Vue patches the DOM, otherwise its patch can overwrite runtime text.
  void nextTick(() => window.dispatchEvent(new Event('hhtools:workspace-locale-change')))
}

function setWorkspaceTheme(theme: WorkspaceTheme): void {
  workspaceTheme.value = theme
  document.documentElement.dataset.theme = theme
  updateWorkspacePreferences({ theme })
}

function toggleWorkspaceTheme(): void {
  setWorkspaceTheme(workspaceTheme.value === 'light' ? 'dark' : 'light')
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseJobAdmissionSnapshot(value: unknown): JobAdmissionSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid job-admission response')
  }
  const candidate = value as Partial<JobAdmissionSnapshot>
  for (const key of [
    'max_running_jobs',
    'max_queued_jobs',
    'running_jobs',
    'queued_jobs',
    'reserved_jobs',
  ] as const) {
    if (!isNonNegativeInteger(candidate[key])) {
      throw new Error(`Invalid job-admission field: ${key}`)
    }
  }
  if (typeof candidate.editable !== 'boolean') {
    throw new Error('Invalid job-admission field: editable')
  }
  return candidate as JobAdmissionSnapshot
}

async function jobAdmissionHttpError(response: Response): Promise<Error> {
  let detail: unknown
  try {
    detail = (await response.json() as { detail?: unknown }).detail
  } catch {
    detail = null
  }
  if (typeof detail === 'string' && detail) return new Error(detail)
  if (detail && typeof detail === 'object' && 'msg' in detail) {
    return new Error(String((detail as { msg: unknown }).msg))
  }
  return new Error(`${response.status} ${response.statusText}`)
}

function parseMotionLibrarySettings(value: unknown): MotionLibrarySettingsSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid motion-library settings response')
  }
  const candidate = value as Partial<MotionLibrarySettingsSnapshot>
  if (typeof candidate.root !== 'string' || !candidate.root) {
    throw new Error('Invalid motion-library settings field: root')
  }
  if (typeof candidate.default_root !== 'string' || !candidate.default_root) {
    throw new Error('Invalid motion-library settings field: default_root')
  }
  if (typeof candidate.editable !== 'boolean') {
    throw new Error('Invalid motion-library settings field: editable')
  }
  for (const key of ['readonly_reason', 'source'] as const) {
    if (candidate[key] !== undefined && candidate[key] !== null && typeof candidate[key] !== 'string') {
      throw new Error(`Invalid motion-library settings field: ${key}`)
    }
  }
  return candidate as MotionLibrarySettingsSnapshot
}

function motionLibraryReadOnlyMessage(settings: MotionLibrarySettingsSnapshot): string {
  const reason = settings.readonly_reason?.trim().toLowerCase()
  const source = settings.source?.trim().toLowerCase()
  if (
    reason === 'environment_override'
    || reason === 'environment'
    || source === 'environment_override'
    || source === 'environment'
  ) {
    return workspaceText(
      'The library directory is managed by HHTOOLS_MOTION_LIBRARY_ROOT. Change or remove that environment variable, then restart the service.',
      '资源库目录由 HHTOOLS_MOTION_LIBRARY_ROOT 管理。请修改或移除该环境变量，然后重启服务。',
    )
  }
  if (reason === 'remote' || reason === 'remote_client' || reason === 'non_loopback') {
    return workspaceText(
      'The library directory can only be changed on the server, in Electron, or through an SSH loopback tunnel.',
      '资源库目录只能从服务器本机、Electron 或 SSH 本地回环连接修改。',
    )
  }
  return workspaceText(
    'The server has made the library directory read-only. Check the server launch configuration or connection permissions.',
    '服务端已将资源库目录设为只读。请检查服务器启动配置或连接权限。',
  )
}

function motionLibraryRootButtonTitle(): string {
  const settings = motionLibrarySettings.value
  if (settings?.editable === false) return motionLibraryReadOnlyMessage(settings)
  return settings?.root || workspaceText(
    'Choose the library directory managed by hhtools',
    '选择 hhtools 管理的资源库目录',
  )
}

async function requestMotionLibrarySettings(
  method: 'GET' | 'PATCH',
  root?: string,
): Promise<MotionLibrarySettingsSnapshot> {
  const response = await fetch('/api/settings/motion-library', {
    method,
    headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PATCH' ? JSON.stringify({ root }) : undefined,
  })
  if (!response.ok) throw await jobAdmissionHttpError(response)
  return parseMotionLibrarySettings(await response.json())
}

async function requestJobAdmission(
  method: 'GET' | 'PATCH',
  settings?: JobAdmissionSettings,
): Promise<JobAdmissionSnapshot> {
  const response = await fetch('/api/settings/job-admission', {
    method,
    headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PATCH' ? JSON.stringify(settings) : undefined,
  })
  if (!response.ok) throw await jobAdmissionHttpError(response)
  return parseJobAdmissionSnapshot(await response.json())
}

async function loadJobAdmission(): Promise<void> {
  if (jobAdmissionLoading.value || jobAdmissionSaving.value) return
  jobAdmissionLoading.value = true
  jobAdmissionError.value = null
  jobAdmissionErrorOperation.value = null
  jobAdmissionSaved.value = false
  try {
    jobAdmission.value = await requestJobAdmission('GET')
  } catch (error) {
    jobAdmissionError.value = error instanceof Error ? error.message : String(error)
    jobAdmissionErrorOperation.value = 'load'
  } finally {
    jobAdmissionLoading.value = false
  }
}

async function saveJobAdmission(settings: JobAdmissionSettings): Promise<void> {
  // The dialog also disables its button, but this guard protects against fast
  // double clicks and programmatic duplicate events reaching the HTTP boundary.
  if (jobAdmissionSaving.value || jobAdmissionLoading.value) return
  jobAdmissionSaving.value = true
  jobAdmissionError.value = null
  jobAdmissionErrorOperation.value = null
  jobAdmissionSaved.value = false
  try {
    jobAdmission.value = await requestJobAdmission('PATCH', settings)
    jobAdmissionSaved.value = true
  } catch (error) {
    // Keep the last effective snapshot; the dialog owns its draft values, so a
    // failed save can be corrected and retried without losing either input.
    jobAdmissionError.value = error instanceof Error ? error.message : String(error)
    jobAdmissionErrorOperation.value = 'save'
  } finally {
    jobAdmissionSaving.value = false
  }
}

async function loadMotionLibrarySettings(): Promise<void> {
  if (motionLibrarySettingsLoading.value || motionLibrarySettingsSaving.value) return
  motionLibrarySettingsLoading.value = true
  motionLibrarySettingsError.value = null
  motionLibrarySettingsSaved.value = false
  try {
    motionLibrarySettings.value = await requestMotionLibrarySettings('GET')
  } catch (error) {
    motionLibrarySettingsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    motionLibrarySettingsLoading.value = false
  }
}

async function loadGvhmrComponent(): Promise<void> {
  if (!window.hhtoolsDesktop || gvhmrLoading.value || gvhmrSetupRunning.value) return
  gvhmrLoading.value = true
  gvhmrError.value = null
  gvhmrRuntime.value = null
  try {
    const components = await window.hhtoolsDesktop.getOptionalComponents()
    gvhmrComponent.value = components.gvhmr

    const response = await fetch('/api/video-to-motion/status')
    if (!response.ok) throw await jobAdmissionHttpError(response)
    gvhmrRuntime.value = await response.json() as GvhmrRuntimeStatus
  } catch (error) {
    gvhmrError.value = error instanceof Error ? error.message : String(error)
  } finally {
    gvhmrLoading.value = false
  }
}

async function setupGvhmr(): Promise<void> {
  if (!window.hhtoolsDesktop || gvhmrSetupRunning.value) return
  gvhmrSetupRunning.value = true
  gvhmrError.value = null
  try {
    const result = await window.hhtoolsDesktop.setupGvhmr()
    gvhmrComponent.value = result.state
    // setupGvhmr keeps its own busy flag while the native folder picker is open.
    // Clear it before the runtime probe, otherwise loadGvhmrComponent correctly
    // treats the setup operation as still active and skips the refresh.
    if (result.action === 'configured') {
      gvhmrSetupRunning.value = false
      await loadGvhmrComponent()
    }
  } catch (error) {
    gvhmrError.value = error instanceof Error ? error.message : String(error)
  } finally {
    gvhmrSetupRunning.value = false
  }
}

async function chooseMotionLibraryRoot(): Promise<void> {
  if (motionLibrarySettingsLoading.value || motionLibrarySettingsSaving.value) return
  motionLibrarySettingsError.value = null
  motionLibrarySettingsSaved.value = false
  try {
    if (!motionLibrarySettings.value) {
      motionLibrarySettingsLoading.value = true
      motionLibrarySettings.value = await requestMotionLibrarySettings('GET')
      motionLibrarySettingsLoading.value = false
    }
    if (motionLibrarySettings.value.editable !== true) {
      throw new Error(motionLibraryReadOnlyMessage(motionLibrarySettings.value))
    }

    // Electron can return a real host path. A normal browser cannot expose an
    // absolute directory path, so local Web mode deliberately asks for the
    // server-side path instead of pretending a webkitdirectory upload is one.
    const selected = window.hhtoolsDesktop?.selectDirectory
      ? await window.hhtoolsDesktop.selectDirectory()
      : window.prompt(
          workspaceText('Enter the library directory on the server', '输入服务器上的资源库目录'),
          motionLibrarySettings.value.root,
        )
    const root = selected?.trim()
    if (!root) return

    motionLibrarySettingsSaving.value = true
    motionLibrarySettings.value = await requestMotionLibrarySettings('PATCH', root)
    motionLibrarySettingsSaved.value = true
    await window.__hhApp?.refreshLibrary()
    window.__hhApp?.toast(workspaceText(
      `Library directory changed: ${motionLibrarySettings.value.root}`,
      `资源库目录已切换：${motionLibrarySettings.value.root}`,
    ))
  } catch (error) {
    motionLibrarySettingsError.value = error instanceof Error ? error.message : String(error)
    window.__hhApp?.toast(motionLibrarySettingsError.value, true)
  } finally {
    motionLibrarySettingsLoading.value = false
    motionLibrarySettingsSaving.value = false
  }
}

function openWorkspaceSettings(): void {
  settingsOpen.value = true
  void loadJobAdmission()
  void loadMotionLibrarySettings()
  void loadGvhmrComponent()
}

function openAboutDialog(): void {
  aboutOpen.value = true
}

function setActivePanel(panel: string): void {
  // Keep old deep links and saved commands working after workspace consolidation.
  const normalizedPanel = panel === 'robot'
    ? 'h2r'
    : panel === 'video' ? 'video-to-motion' : panel
  activePanel.value = normalizedPanel as WorkspacePanelId
  updateWorkspacePreferences({ activePanel: activePanel.value })
}

function requestPanel(panel: string): void {
  window.dispatchEvent(new CustomEvent('hhtools:panel-request', { detail: panel }))
}

function requestVideoImport(): void {
  window.dispatchEvent(new CustomEvent('hhtools:import-command', {
    detail: { target: 'video-file' },
  }))
}

function showBoot(message: string): void {
  const element = document.getElementById('boot-error')
  if (!element) return
  element.style.display = 'block'
  element.textContent = workspaceText(
    `The interface could not initialize: ${message} (press F12 to view the console)`,
    `界面未能初始化：${message}（按 F12 查看 Console）`,
  )
}

const importTargets: Record<Exclude<ImportCommandTarget, 'job-spec'>, {
  panel: WorkspacePanelId
  selector: string
  motionProfile?: MotionUploadProfile
}> = {
  'motion-file': { panel: 'motion', selector: '#motion-pick-file', motionProfile: 'mimic' },
  'motion-folder': { panel: 'motion', selector: '#motion-pick-folder', motionProfile: 'mimic' },
  'video-file': { panel: 'video-to-motion', selector: '#video-pick-file' },
  'robot-urdf': { panel: 'robot-assets', selector: '#robot-pick-urdf' },
  'robot-mesh-folder': { panel: 'robot-assets', selector: '#robot-pick-mesh-folder' },
  'robot-trajectory': { panel: 'r2r', selector: '[data-r2r-pick="mimic"]:not([data-folder])' },
  'dataset-folder': { panel: 'dataset-viz', selector: '#dv-pick-folder' },
}

function handleImportCommand(event: WindowEventMap['hhtools:import-command']): void {
  if (event.detail.target === 'job-spec') {
    window.dispatchEvent(new CustomEvent('hhtools:job-spec-import-request'))
    return
  }

  const target = importTargets[event.detail.target]
  if (target.motionProfile) selectMotionUploadProfile(target.motionProfile)
  requestPanel(target.panel)
  window.setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(target.selector)
    if (button) button.click()
    else window.__hhApp?.toast(workspaceText(
      'The import entry point is not ready yet. Try again shortly.',
      '导入入口尚未准备完成，请稍后重试',
    ), true)
  }, 0)
}

function selectMotionUploadProfile(profile: MotionUploadProfile): void {
  activeMotionUploadProfile.value = profile
  motionUploadInfoOpen.value = false
}

function toggleMotionUploadInfo(): void {
  motionUploadInfoOpen.value = !motionUploadInfoOpen.value
}

function toggleRobotUploadInfo(target: RobotUploadInfo): void {
  robotUploadInfoOpen.value = robotUploadInfoOpen.value === target ? null : target
}

function closeImportInfo(event: Event): void {
  const target = event.target
  // Keep the popover open while its trigger or content is being used; any
  // click elsewhere in the workspace dismisses it without adding a modal.
  if (target instanceof Element && target.closest('.motion-import-info')) return
  motionUploadInfoOpen.value = false
  robotUploadInfoOpen.value = null
}

function handleImportInfoKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  motionUploadInfoOpen.value = false
  robotUploadInfoOpen.value = null
}

onMounted(async () => {
  window.showBoot = showBoot
  window.__hhUi = { setActivePanel, requestPanel }
  window.addEventListener('hhtools:import-command', handleImportCommand)
  document.addEventListener('click', closeImportInfo)
  document.addEventListener('keydown', handleImportInfoKeydown)
  // Load capability metadata up front so the always-visible library control
  // cannot advertise a write action on a read-only server connection.
  void loadMotionLibrarySettings()
  if (window.hhtoolsDesktop) {
    try {
      const components = await window.hhtoolsDesktop.getOptionalComponents()
      gvhmrComponent.value = components.gvhmr
      if (components.gvhmr.requested && !components.gvhmr.configured) settingsOpen.value = true
      void loadGvhmrComponent()
    } catch (error) {
      gvhmrError.value = error instanceof Error ? error.message : String(error)
    }
  }

  try {
    // The renderer owns UI markup; the runtime modules own Three.js and long-running workflows.
    await import('./runtime/webui-runtime')
    await import('./runtime/dataset-viz')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showBoot(message)
    console.error('hhtools renderer failed to initialize', error)
  }

  window.setTimeout(() => {
    if (!window.__hhtoolsReady) showBoot('Vue renderer runtime did not finish initialization')
  }, 4_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('hhtools:import-command', handleImportCommand)
  document.removeEventListener('click', closeImportInfo)
  document.removeEventListener('keydown', handleImportInfoKeydown)
  delete window.__hhUi
})
</script>

<template>
  <div
    id="app"
    :class="{
      'workspace-shell': true,
      'electron-host': isElectronHost,
      'web-host': !isElectronHost,
      'sidebar-hidden': panelLayout.state.sidebarHidden,
      'inspector-hidden': panelLayout.state.inspectorHidden
    }"
    :style="panelLayout.style.value"
  >
    <!-- top bar -->
    <header id="topbar">
      <div class="logo">
        <img class="desktop-logo-mark" src="/hhtools-robot.svg" alt="" />
        <span class="desktop-brand-name">HHTOOLS</span>
        <span v-show="false" class="ui-build" id="ui-build">UI·v25</span>
      </div>
      <DesktopMenuBar
        :active-panel="activePanel"
        :locale="workspaceLocale"
        :theme="workspaceTheme"
        @open-settings="openWorkspaceSettings"
        @open-about="openAboutDialog"
        @toggle-theme="toggleWorkspaceTheme"
      />
      <div class="spacer"></div>
      <CommandPalette
        :active-panel="activePanel"
        :locale="workspaceLocale"
        :theme="workspaceTheme"
        application-mode
        @open-settings="openWorkspaceSettings"
        @open-about="openAboutDialog"
        @toggle-theme="toggleWorkspaceTheme"
      />
      <span v-show="false" class="pill" id="motion-pill">未加载动作</span>
      <span v-show="false" class="pill" id="robot-pill">未加载机器人</span>
    </header>

    <!-- sidebar nav -->
    <nav
      id="sidebar"
      class="side-panel"
      :aria-label="workspaceText('Navigation', '导航')"
      :aria-hidden="panelLayout.state.sidebarHidden"
      :inert="panelLayout.state.sidebarHidden"
    >
      <div id="sidebar-body">
        <SidebarNavigation
          :active-panel="activePanel"
          workspace
          :locale="workspaceLocale"
          @request="requestPanel"
        />
      </div>
    </nav>
    <div
      class="col-resizer"
      id="resize-sidebar"
      :title="workspaceText('Drag to resize the navigation', '拖动调节左栏宽度')"
      @pointerdown="panelLayout.startResize('sidebar', $event)"
    ></div>
    <WorkspaceDrawerHandle
      side="left"
      :expanded="!panelLayout.state.sidebarHidden"
      :locale="workspaceLocale"
      @toggle="panelLayout.setHidden('sidebar', !panelLayout.state.sidebarHidden)"
    />

    <!-- 3D stage -->
    <main id="stage" :class="{ 'batch-stage-active': activePanel === 'batch' }">
      <canvas id="three-canvas"></canvas>
      <svg id="calib-mapping-overlay" class="calib-mapping-overlay" aria-hidden="true"></svg>
      <div id="calib-landmark-labels" class="calib-landmark-labels" aria-hidden="true"></div>
      <div id="calib-hud" class="calib-hud hidden" aria-hidden="true"></div>
      <div id="calib-hover-hint" class="calib-hover-hint" aria-hidden="true"></div>
      <div class="stage-top-tools">
        <div class="view-hud" id="view-hud">
          <div class="view-hud-row" data-row="motion">
            <button class="seg-btn" id="tg-skeleton" :title="workspaceText('Show/hide the source motion skeleton', '显示/隐藏原始动作骨架')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn on" id="tg-mesh" :title="workspaceText('Show/hide the body mesh (SMPL skin or tubular approximation)', '显示/隐藏身体 mesh（SMPL 皮肤或管状近似）')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Body', '身体') }}</span>
            </button>
            <button class="seg-btn" id="tg-env" disabled :title="workspaceText('Show/hide source-motion terrain and interaction objects', '显示/隐藏原始动作的地形与交互物体')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
          <div class="view-hud-row" data-row="robot">
            <button class="seg-btn" id="tg-scaled" disabled :title="workspaceText('Effector skeleton after robot scaling and before IK', '按机器人标定缩放后、IK 之前的效应器骨架')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Scaled Skeleton', '缩放骨架') }}</span>
            </button>
            <button class="seg-btn" id="tg-scaled-env" disabled :title="workspaceText('Scaled terrain and interaction objects in robot coordinates', '缩放后的地形与交互物体（与机器人同坐标系）')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Scaled Scene', '缩放场景') }}</span>
            </button>
            <button class="seg-btn" id="tg-robot" disabled :title="workspaceText('Show/hide the retargeted robot', '显示/隐藏重定向后的机器人')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
          </div>
        </div>
        <div class="view-hud hidden" id="view-hud-r2r">
          <div class="view-hud-row" data-row="r2r-src">
            <span class="view-hud-tag">{{ workspaceText('Source', '源') }}</span>
            <button class="seg-btn on" id="r2r-tg-src-robot" :title="workspaceText('Source robot mesh', '源机器人 mesh')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-src-skel" disabled :title="workspaceText('Source landmark skeleton (FK)', '源关键点骨架（FK）')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-src-env" disabled :title="workspaceText('Terrain and objects attached to the source trajectory', '源轨迹附带的地形/物体')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
          <div class="view-hud-row" data-row="r2r-tgt">
            <span class="view-hud-tag">{{ workspaceText('Target', '目标') }}</span>
            <button class="seg-btn" id="r2r-tg-tgt-robot" disabled :title="workspaceText('Target robot mesh', '目标机器人 mesh')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-tgt-skel" disabled :title="workspaceText('Scaled target skeleton (IK effectors)', '目标缩放骨架（IK 效应器）')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-tgt-env" disabled :title="workspaceText('Terrain and objects after target scaling', '目标缩放后的地形/物体')">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="stage-empty" id="stage-empty">
        <div>
          <div class="glyph">🎞</div>
          <div class="big">{{ workspaceText('Drop a motion here to preview', '把动作拖到这里预览') }}</div>
          <div class="sub">{{ workspaceText(
            'Supports BVH / GLB / NPZ and datasets such as AMASS, Motion-X, OMOMO, and holosoma.',
            '支持 BVH / GLB / NPZ 以及 AMASS、Motion-X、OMOMO、holosoma 等数据集。',
          ) }}</div>
        </div>
      </div>
      <div class="stage-overlay">
        <button
          type="button"
          class="view-reset-btn hidden"
          id="view-reset-btn"
          :title="workspaceText('Reset view', '回到默认视角')"
          :aria-label="workspaceText('Reset view', '回到默认视角')"
        >
          <svg class="view-reset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.25"/>
            <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/>
          </svg>
        </button>
        <PlaybackBar />
      </div>
    </main>
    <div
      class="col-resizer"
      id="resize-inspector"
      :title="workspaceText('Drag to resize the inspector', '拖动调节右栏宽度')"
      @pointerdown="panelLayout.startResize('inspector', $event)"
    ></div>

    <!-- right inspector -->
    <aside
      id="inspector"
      class="side-panel"
      :aria-label="workspaceText('Inspector', '控制面板')"
      :aria-hidden="panelLayout.state.inspectorHidden"
      :inert="panelLayout.state.inspectorHidden"
    >
      <div id="inspector-body">
      <!-- MOTION -->
      <section class="panel" :class="{ active: activePanel === 'motion' }" data-panel="motion">
        <h2>{{ workspaceText('Motion', '动作') }}</h2>

        <div class="motion-import-control" id="tour-motion-import">
          <!-- Native radios keep the compact profile switcher keyboard-friendly.
               The selected profile drives one shared dropzone and both pickers. -->
          <div
            class="motion-profile-switcher"
            role="radiogroup"
            :aria-label="workspaceText('Motion import type', '动作上传类型')"
          >
            <label
              v-for="profile in motionUploadProfiles"
              :key="profile.id"
              class="motion-profile-selector"
            >
              <input
                class="sr-only"
                type="radio"
                name="motion-upload-profile"
                :value="profile.id"
                :checked="activeMotionUploadProfile === profile.id"
                @change="selectMotionUploadProfile(profile.id)"
              />
              <span class="motion-profile-selector-content">{{ profile.label }}</span>
            </label>
          </div>

          <div
            class="dropzone motion-upload-shared"
            id="motion-drop-shared"
            :data-profile="activeMotionUploadProfile"
            role="group"
            :aria-label="workspaceText(
              `${activeMotionUploadProfile} import area`,
              `${activeMotionUploadProfile} 上传区`,
            )"
          >
            <div class="motion-import-info">
              <button
                type="button"
                class="motion-import-info-trigger"
                :aria-label="workspaceText(
                  `View ${activeMotionUploadProfile} import instructions`,
                  `查看 ${activeMotionUploadProfile} 上传说明`,
                )"
                aria-controls="motion-upload-info"
                :aria-expanded="motionUploadInfoOpen"
                :aria-describedby="motionUploadInfoOpen ? 'motion-upload-info' : undefined"
                @click.stop="toggleMotionUploadInfo"
              >?</button>
              <div
                v-show="motionUploadInfoOpen"
                id="motion-upload-info"
                class="motion-import-info-popover"
                role="tooltip"
                @click.stop
              >
                <template v-if="activeMotionUploadProfile === 'intermimic'">
                  <strong>{{ workspaceText('Object-interaction motion · OMOMO', '物体交互动作 · OMOMO') }}</strong>
                  <span>
                    {{ workspaceText('Choose a complete clip folder or an entire dataset directory. Requires ', '请选择完整 clip 文件夹或整个数据集目录。需要 ') }}
                    <code>&lt;clip&gt;/&lt;clip&gt;.pkl</code>{{ workspaceText('; interaction objects are usually ', '，交互物体通常为 ') }}<code>*_cleaned_simplified.obj</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
                <template v-else-if="activeMotionUploadProfile === 'meshmimic'">
                  <strong>{{ workspaceText('Terrain motion · parc_ms', '地形动作 · parc_ms') }}</strong>
                  <span>
                    {{ workspaceText('Choose a complete clip folder or an entire dataset directory. Requires ', '请选择完整 clip 文件夹或整个数据集目录。需要 ') }}
                    <code>&lt;clip&gt;/&lt;clip&gt;.pkl</code>{{ workspaceText(' or ', ' 或 ') }}<code>.npz</code>{{ workspaceText('; terrain meshes are usually ', '，地形通常为 ') }}<code>*_terrain.obj</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
                <template v-else>
                  <strong>{{ workspaceText('General human motion', '通用人体动作') }}</strong>
                  <span>
                    {{ workspaceText('Supports a single file or a nested dataset folder. Recognized formats: ', '支持单个文件或多级数据集文件夹。可识别 ') }}
                    <code>.bvh</code>, <code>.glb</code>, <code>.gltf</code>, <code>.npz</code>, <code>.npy</code>, <code>.pkl</code>, <code>.pt</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
              </div>
            </div>
            <div class="dz-glyph">{{ motionUploadProfileMeta[activeMotionUploadProfile].glyph }}</div>
            <div class="dz-title">{{ workspaceText(
              motionUploadProfileMeta[activeMotionUploadProfile].dropHintEn,
              motionUploadProfileMeta[activeMotionUploadProfile].dropHintZh,
            ) }}</div>
            <div class="row" style="margin-top:10px">
              <button
                v-show="activeMotionUploadProfile === 'mimic'"
                id="motion-pick-file"
                type="button"
                class="btn secondary small"
                :data-pick="activeMotionUploadProfile"
                data-accept=".bvh,.glb,.gltf,.npz,.npy,.pkl,.pt"
              >{{ workspaceText('Choose file', '选择文件') }}</button>
              <button
                id="motion-pick-folder"
                type="button"
                class="btn secondary small"
                :data-pick="activeMotionUploadProfile"
                data-folder="1"
              >{{ workspaceText('Choose folder', '选择文件夹') }}</button>
            </div>
          </div>
        </div>

        <!-- The library is a peer workspace, not another card nested under
             Motion. Only its scrollable result list owns a visual frame. -->
        <section class="motion-library" id="tour-motion-library" aria-labelledby="motion-library-title">
          <h2 id="motion-library-title">{{ workspaceText('Library', '资源库') }}</h2>

          <div class="motion-library-root-row">
            <button
              type="button"
              class="btn secondary small motion-library-root-button"
              :disabled="motionLibrarySettingsLoading || motionLibrarySettingsSaving || motionLibrarySettings?.editable === false"
              :title="motionLibraryRootButtonTitle()"
              @click="chooseMotionLibraryRoot"
            >{{ motionLibrarySettingsSaving
              ? workspaceText('Switching…', '正在切换…')
              : workspaceText('Choose library directory', '选择资源库目录') }}</button>
            <div class="motion-library-category-select-wrap">
              <select
                class="search motion-library-category-select"
                id="lib-category"
                :aria-label="workspaceText('Filter the library by motion type', '按动作类型筛选资源库')"
              >
                <option value="all">{{ workspaceText('All', '全部') }}</option>
                <option value="motion">{{ workspaceText('Motion', '纯动作') }}</option>
                <option value="object">{{ workspaceText('Object interaction', '物体交互') }}</option>
                <option value="terrain">{{ workspaceText('Terrain scene', '地形场景') }}</option>
              </select>
              <!-- Heroicons "chevron-down" outline path, MIT licensed. -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          <div class="motion-library-tools">
            <SearchField
              v-model="motionLibrarySearch"
              id="lib-search"
              :label="workspaceText('Search the Motion Library', '搜索资源库动作')"
              :placeholder="workspaceText('Search motions…', '搜索动作……')"
              :clear-label="workspaceText('Clear library search', '清除资源库搜索')"
            />
            <button
              type="button"
              class="btn secondary small"
              id="lib-link-path"
              :title="workspaceText('Link an external server directory to the current library', '把服务器上的外部数据集链接到当前资源库')"
            >{{ workspaceText('Link directory', '链接目录') }}</button>
          </div>
          <div class="motion-library-list-frame">
            <div class="lib-list" id="lib-list"></div>
          </div>
        </section>

        <div class="card" id="motion-meta-card" style="display:none">
          <h3 id="motion-name">—</h3>
          <div id="motion-meta"></div>
          <div class="validation-summary" id="motion-validation-summary" aria-live="polite"></div>
          <div class="divider"></div>
          <button class="btn secondary small" id="add-to-basket">
            {{ workspaceText('＋ Add to batch basket', '＋ 加入批量篮子') }}
          </button>
        </div>
      </section>

      <!-- VIDEO TO MOTION -->
      <section
        class="panel"
        :class="{ active: activePanel === 'video-to-motion' }"
        data-panel="video-to-motion"
      >
        <div class="panel-stack video-to-motion-stack">
          <h2>{{ workspaceText('Video → Motion', '视频 → 动作') }}</h2>
          <VideoToMotionPipeline :locale="workspaceLocale" />

          <details id="gvhmr-step-video" class="video-workflow-step" open>
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('1. Select video', '1. 选择视频') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <div class="motion-import-control">
                <div
                  class="dropzone motion-upload-shared video-upload-shared"
                  id="video-drop-shared"
                  role="group"
                  :aria-label="workspaceText('Video import area', '视频上传区')"
                >
                  <div class="dz-glyph">🎥</div>
                  <div class="dz-title">{{ workspaceText('Drop a video file here', '拖入一个视频文件') }}</div>
                  <div class="dz-sub">MP4, MOV, MKV, AVI, WebM, M4V</div>
                  <div class="row" style="margin-top:10px">
                    <button id="video-pick-file" type="button" class="btn secondary small">
                      {{ workspaceText('Choose video', '选择视频') }}
                    </button>
                  </div>
                </div>
              </div>

              <section id="gvhmr-video-selection" class="video-selection" style="display:none">
                <video id="gvhmr-video-preview" controls preload="metadata"></video>
                <div class="video-selection-row">
                  <div class="video-selection-copy">
                    <strong id="gvhmr-video-name">—</strong>
                    <span id="gvhmr-video-meta" class="hint"></span>
                  </div>
                  <button type="button" class="btn secondary small" @click="requestVideoImport">
                    {{ workspaceText('Replace video', '替换视频') }}
                  </button>
                </div>
              </section>
            </div>
          </details>

          <details id="gvhmr-step-environment" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('2. Select environment', '2. 选择环境') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <div class="video-environment-control">
                <label class="video-workflow-field">
                <span class="k">{{ workspaceText('Runtime environment', '运行环境') }}</span>
                  <select id="gvhmr-weight-source" class="search">
                    <option value="official">
                      {{ workspaceText('Official GVHMR', 'GVHMR 官方环境') }}
                    </option>
                    <option value="custom">
                      {{ workspaceText('Custom checkpoint (best effort)', '自定义 checkpoint（不保证兼容）') }}
                    </option>
                  </select>
                </label>
                <button id="gvhmr-confirm-environment" type="button" class="btn secondary small">
                  {{ workspaceText('Confirm', '确认环境') }}
                </button>
              </div>
              <div id="gvhmr-custom-checkpoint" class="video-custom-checkpoint" style="display:none">
                <div class="video-checkpoint-control">
                  <button id="gvhmr-pick-checkpoint" type="button" class="btn secondary small">
                    {{ workspaceText('Choose checkpoint', '选择 checkpoint') }}
                  </button>
                  <span id="gvhmr-checkpoint-name" class="video-checkpoint-name">
                    {{ workspaceText('No checkpoint selected', '尚未选择 checkpoint') }}
                  </span>
                </div>
                <p class="hint video-checkpoint-hint">
                  {{ workspaceText(
                    'Custom checkpoints are passed through as selected. Compatibility is not guaranteed.',
                    '自定义 checkpoint 会按所选文件直接传入，不保证兼容性。',
                  ) }}
                </p>
              </div>
            </div>
          </details>

          <details id="gvhmr-step-generate" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('3. Generate', '3. 生成动作') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <button id="gvhmr-run" type="button" class="btn" disabled>
                {{ workspaceText('Start GVHMR', '开始 GVHMR 推理') }}
              </button>
              <div id="gvhmr-progress" class="progress video-workflow-progress" style="display:none">
                <div class="bar"></div>
              </div>
              <p id="gvhmr-status" class="hint" role="status"></p>
            </div>
          </details>

          <details id="gvhmr-step-result" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('4. Motion result', '4. 动作结果') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <button id="gvhmr-import-result" type="button" class="btn secondary small">
                {{ workspaceText('Import existing GVHMR result (.pt)', '导入已有 GVHMR 结果 (.pt)') }}
              </button>
              <div id="gvhmr-result-card" style="display:none">
                <div class="meta-row"><span class="k">{{ workspaceText('Motion', '动作') }}</span><span class="v" id="gvhmr-result-name">—</span></div>
                <div class="meta-row"><span class="k">{{ workspaceText('Frames', '帧数') }}</span><span class="v" id="gvhmr-result-frames">—</span></div>
                <div class="meta-row"><span class="k">{{ workspaceText('Duration', '时长') }}</span><span class="v" id="gvhmr-result-duration">—</span></div>
                <button type="button" class="btn secondary" @click="requestPanel('motion')">
                  {{ workspaceText('Open Motion Library', '打开动作资源库') }}
                </button>
              </div>
            </div>
          </details>
        </div>
      </section>

      <!-- Robot assets and the H2R workflow share runtime state but have separate workspaces. -->
      <section
        class="panel"
        :class="{ active: activePanel === 'robot-assets' || activePanel === 'h2r' }"
        data-panel="robot"
      >
        <div v-show="activePanel === 'robot-assets'" class="panel-stack robot-assets-stack">
          <h2>{{ workspaceText('Robot', '机器人') }}</h2>

          <div class="robot-import-stack" id="tour-robot-import">
            <div
              class="dropzone robot-import-dropzone"
              id="robot-drop-urdf"
              role="group"
              :aria-label="workspaceText('URDF import area', 'URDF 导入区')"
            >
              <div class="motion-import-info">
                <button
                  type="button"
                  class="motion-import-info-trigger"
                  :aria-label="workspaceText('View URDF import instructions', '查看 URDF 导入说明')"
                  aria-controls="robot-urdf-info"
                  :aria-expanded="robotUploadInfoOpen === 'urdf'"
                  :aria-describedby="robotUploadInfoOpen === 'urdf' ? 'robot-urdf-info' : undefined"
                  @click.stop="toggleRobotUploadInfo('urdf')"
                >?</button>
                <div
                  v-show="robotUploadInfoOpen === 'urdf'"
                  id="robot-urdf-info"
                  class="motion-import-info-popover"
                  role="tooltip"
                  @click.stop
                >
                  <strong>{{ workspaceText('URDF description', 'URDF 描述文件') }}</strong>
                  <span>
                    {{ workspaceText('Drop a ', '拖入 ') }}<code>*.urdf</code>{{ workspaceText(' file here, or choose the robot description file. Import the URDF before adding its mesh assets.', ' 文件，或选择机器人描述文件。请先导入 URDF，再添加对应的 mesh 资源。') }}
                  </span>
                </div>
              </div>
              <div class="dz-glyph" aria-hidden="true">📄</div>
              <div class="dz-title">{{ workspaceText('1 · URDF file', '1 · URDF 文件') }}</div>
              <div class="row robot-import-actions">
                <button class="btn secondary small" id="robot-pick-urdf">
                  {{ workspaceText('Choose .urdf', '选择 .urdf') }}
                </button>
              </div>
            </div>

            <div
              class="dropzone robot-import-dropzone"
              id="robot-drop-mesh"
              role="group"
              :aria-label="workspaceText('Mesh folder import area', 'Mesh 文件夹导入区')"
            >
              <div class="motion-import-info">
                <button
                  type="button"
                  class="motion-import-info-trigger"
                  :aria-label="workspaceText('View mesh import instructions', '查看 Mesh 导入说明')"
                  aria-controls="robot-mesh-info"
                  :aria-expanded="robotUploadInfoOpen === 'mesh'"
                  :aria-describedby="robotUploadInfoOpen === 'mesh' ? 'robot-mesh-info' : undefined"
                  @click.stop="toggleRobotUploadInfo('mesh')"
                >?</button>
                <div
                  v-show="robotUploadInfoOpen === 'mesh'"
                  id="robot-mesh-info"
                  class="motion-import-info-popover"
                  role="tooltip"
                  @click.stop
                >
                  <strong>{{ workspaceText('Robot mesh assets', '机器人 Mesh 资源') }}</strong>
                  <span>
                    {{ workspaceText('After choosing the URDF, drop its ', '选择 URDF 后，拖入对应的 ') }}<code>meshes/</code>{{ workspaceText(' folder here. Supported formats: ', ' 文件夹。支持的格式：') }}<code>.stl</code>, <code>.obj</code>, <code>.dae</code>, <code>.ply</code>, <code>.glb</code>, <code>.gltf</code>{{ workspaceText('.', '。') }}
                  </span>
                </div>
              </div>
              <div class="dz-glyph" aria-hidden="true">📁</div>
              <div class="dz-title">{{ workspaceText('2 · Mesh folder', '2 · Mesh 文件夹') }}</div>
              <div class="row robot-import-actions">
                <button class="btn secondary small" id="robot-pick-mesh-folder">
                  {{ workspaceText('Choose mesh folder', '选择 mesh 文件夹') }}
                </button>
              </div>
            </div>
          </div>
          <p class="hint robot-import-status" id="robot-import-status" aria-live="polite">
            {{ workspaceText('No URDF selected.', '尚未选择 URDF。') }}
          </p>

          <section class="motion-library robot-library" aria-labelledby="robot-library-title">
            <h2 id="robot-library-title">{{ workspaceText('Robot Library', '机器人库') }}</h2>
            <div class="robot-library-tools">
              <SearchField
                v-model="robotLibrarySearch"
                id="robot-library-search"
                :label="workspaceText('Search the Robot Library', '搜索机器人库')"
                :placeholder="workspaceText('Search robots…', '搜索机器人……')"
                :clear-label="workspaceText('Clear robot search', '清除机器人搜索')"
              />
            </div>
            <div class="motion-library-list-frame robot-library-list-frame">
              <div class="lib-list robot-library-list" id="robot-library-list"></div>
            </div>
            <p class="hint robot-library-hint" id="robot-library-hint"></p>
          </section>

          <div class="card" id="robot-meta-card" style="display:none">
            <h3 id="robot-name">—</h3>
            <div id="robot-meta"></div>
            <div class="validation-summary" id="robot-validation-summary" aria-live="polite"></div>
          </div>
        </div>

        <div v-show="activePanel === 'h2r'">
          <HumanToRobotWorkflow
            :locale="workspaceLocale"
            @request-panel="requestPanel"
          />
        </div>
      </section>

      <!-- BATCH -->
      <section class="panel" :class="{ active: activePanel === 'batch' }" data-panel="batch">
        <BatchWorkflow
          :active="activePanel === 'batch'"
          :locale="workspaceLocale"
          @request-panel="requestPanel"
        />
      </section>

      <!-- ROBOT-TO-ROBOT (R2R) -->
      <section class="panel" :class="{ active: activePanel === 'r2r' }" data-panel="r2r">
        <RobotToRobotWorkflow
          :locale="workspaceLocale"
          @request-panel="requestPanel"
        />

      </section>

      <section class="panel panel-dataset-viz" :class="{ active: activePanel === 'dataset-viz' }" data-panel="dataset-viz">
        <div class="panel-stack data-analysis-stack">
          <h2>{{ workspaceText('Data Analysis', '数据分析') }}</h2>
          <DataAnalysisPipeline :locale="workspaceLocale" />

          <details id="dv-step-source" class="video-workflow-step" open>
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('1. Select data', '1. 选择数据') }}</span>
              <span class="dv-card-badge" id="dv-kind-badge" hidden></span>
            </summary>
            <div class="video-workflow-step-body">
              <div class="data-analysis-upload-grid">
                <div
                  id="dv-dropzone"
                  class="dropzone motion-upload-shared data-analysis-upload"
                  role="group"
                  :aria-label="workspaceText('Motion dataset upload', '动作数据上传区')"
                >
                  <div class="dz-glyph" id="dv-drop-icon">M</div>
                  <div class="dz-title">Motion</div>
                  <div class="dz-sub" id="dv-drop-label">
                    {{ workspaceText('Drop a motion dataset folder here', '拖入动作数据集文件夹') }}
                  </div>
                  <button type="button" class="btn secondary small" id="dv-pick-folder">
                    {{ workspaceText('Choose folder', '选择文件夹') }}
                  </button>
                </div>

                <div
                  id="dv-dropzone-robot"
                  class="dropzone motion-upload-shared data-analysis-upload"
                  role="group"
                  :aria-label="workspaceText('Robot trajectory upload', '机器人轨迹上传区')"
                >
                  <div class="dz-glyph" id="dv-drop-icon-robot">R</div>
                  <div class="dz-title">Robot</div>
                  <div class="dz-sub" id="dv-drop-label-robot">
                    {{ workspaceText('Drop a robot trajectory folder here', '拖入机器人轨迹文件夹') }}
                  </div>
                  <button type="button" class="btn secondary small" id="dv-pick-robot-folder">
                    {{ workspaceText('Choose folder', '选择文件夹') }}
                  </button>
                </div>
              </div>

              <p class="hint dv-drop-hint" id="dv-drop-hint">
                {{ workspaceText('You can append folders of the same type to the current batch.', '可向当前批次继续追加同一类型的文件夹。') }}
              </p>
              <div class="dv-upload-basket" id="dv-upload-basket" hidden>
                <div class="dv-basket-head">
                  <span class="dv-basket-title" id="dv-basket-summary">—</span>
                  <button type="button" class="btn-link" id="dv-clear-upload">
                    {{ workspaceText('Clear batch', '清空批次') }}
                  </button>
                </div>
                <ul class="dv-basket-list" id="dv-basket-list"></ul>
              </div>
              <div class="dv-source-display" id="dv-source-display">
                {{ workspaceText('No folder selected', '未指定目录') }}
              </div>
              <label class="dv-field dv-user-root" id="dv-user-root-wrap" hidden>
                <span>{{ workspaceText('Local data directory', '本地数据目录') }} <b>*</b></span>
                <input type="text" id="dv-user-source-root" class="dv-input"
                  placeholder="/home/motions or /home/motions/sub10_largebox_000_export" />
                <span class="hint">{{ workspaceText('Map an uploaded JSON manifest to its real local directory.', '将上传后的 JSON manifest 映射到真实本地目录。') }}</span>
              </label>
              <details class="dv-support-compact">
                <summary>{{ workspaceText('Supported formats', '支持格式') }}</summary>
                <div class="dv-format-grid" id="dv-format-grid"></div>
              </details>
              <input type="hidden" id="dv-source" value="" />
            </div>
          </details>

          <details id="dv-step-configure" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('2. Configure', '2. 分析配置') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <div class="dv-toolbar data-analysis-config">
                <label class="dv-field">
                  <span>Embedding</span>
                  <select id="dv-embedding">
                    <option value="handcrafted">{{ workspaceText('Handcrafted features (recommended)', '档A · 手工特征（推荐）') }}</option>
                    <option value="pae" disabled>{{ workspaceText('PAE (coming soon)', '档B · PAE（暂不可用）') }}</option>
                  </select>
                </label>
                <label class="dv-check"><input type="checkbox" id="dv-force" /> {{ workspaceText('Ignore cache', '忽略缓存') }}</label>
              </div>
            </div>
          </details>

          <details id="dv-step-analyze" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('3. Analyze', '3. 运行分析') }}</span>
            </summary>
            <div class="video-workflow-step-body">
              <button class="btn" id="dv-analyze">{{ workspaceText('Start analysis', '开始分析') }}</button>
              <div class="progress dv-progress" style="display:none" id="dv-progress"><div class="bar"></div></div>
              <div class="dv-status" id="dv-status" role="status"></div>
            </div>
          </details>

          <details id="dv-step-results" class="video-workflow-step">
            <summary class="video-workflow-step-summary">
              <span>{{ workspaceText('4. Results', '4. 分析结果') }}</span>
            </summary>
            <div class="video-workflow-step-body data-analysis-results-body">
              <p id="dv-results-empty" class="hint data-analysis-results-empty">
                {{ workspaceText('Run an analysis to view metrics, clusters, and recommended subsets.', '运行分析后可查看指标、聚类与推荐子集。') }}
              </p>
              <div class="dv-robot-preview" id="dv-robot-preview" hidden>
                <label class="dv-field">
                  <span>{{ workspaceText('Preview robot', '预览机器人') }}</span>
                  <select id="dv-robot-select"></select>
                </label>
                <span class="hint" id="dv-robot-hint">{{ workspaceText('Select a point or row to preview the trajectory.', '点击散点或列表中的条目以预览轨迹。') }}</span>
              </div>

              <div id="dv-results" hidden>
                <div class="dv-overview" id="dv-overview"></div>

                <div class="dv-card">
                  <div class="dv-card-head">
                    <span class="dv-card-title" id="dv-stage1-title">Stage I · 标签</span>
                    <div class="dv-tagmode">
                      <label><input type="radio" name="dv-tagmode" value="or" checked /> OR</label>
                      <label><input type="radio" name="dv-tagmode" value="and" /> AND</label>
                      <button type="button" class="btn-link" id="dv-clear-tags">清除</button>
                    </div>
                  </div>
                  <div class="dv-chips" id="dv-chips"></div>
                  <div class="dv-info-panel" id="dv-tag-info" hidden></div>
                </div>

                <div class="dv-card">
                  <div class="dv-card-head">
                    <span class="dv-card-title" id="dv-explore-title">探索 · 指标分布</span>
                    <button type="button" class="btn-link" id="dv-clear-brush">清除刷选</button>
                  </div>
                  <div class="dv-row dv-row-tight">
                    <select id="dv-view-dim" class="dv-select dv-select-grow"></select>
                  </div>
                  <div class="dv-info-panel dv-info-compact" id="dv-metric-info"></div>
                  <div class="dv-chart-wrap">
                    <canvas id="dv-hist-canvas" class="dv-canvas" width="640" height="240"></canvas>
                  </div>
                  <div class="dv-chart-footer">
                    <span class="dv-chart-stats" id="dv-hist-stats"></span>
                    <span class="hint" id="dv-hist-axis-hint"></span>
                  </div>
                </div>

                <div class="dv-card">
                  <div class="dv-card-head">
                    <span class="dv-card-title" id="dv-stage2-title">Stage II · 语义散点</span>
                    <button type="button" class="btn secondary small" id="dv-scatter-reset">默认视角</button>
                  </div>
                  <div class="dv-scatter-wrap">
                    <canvas id="dv-scatter-canvas" class="dv-canvas dv-scatter" width="640" height="400"></canvas>
                    <div class="dv-scatter-tip" id="dv-scatter-tip" hidden></div>
                  </div>
                  <div class="dv-scatter-toolbar">
                    <span class="hint">滚轮缩放 · 拖拽平移 · 点击预览 · 非推荐点可手动补选 · Shift 多选</span>
                    <div class="dv-legend" id="dv-legend"></div>
                  </div>
                  <div class="dv-clip-list-wrap">
                    <div class="dv-list-head">
                      <span>刷选结果</span>
                      <span class="hint" id="dv-list-count"></span>
                    </div>
                    <div class="dv-clip-list" id="dv-clip-list"></div>
                  </div>
                </div>

                <div class="dv-card dv-card-stage3">
                  <div class="dv-card-head">
                    <span class="dv-card-title" id="dv-stage3-title">Stage III · 子集推荐</span>
                  </div>
                  <div class="dv-slider-block">
                    <div class="dv-slider-row">
                      <label class="dv-slider-label">想要导出多少的子集</label>
                      <span class="dv-slider-val" id="dv-subset-pct">10%</span>
                    </div>
                    <input type="range" id="dv-subset-ratio" class="dv-range" min="1" max="100" value="10" />
                  </div>
                  <div class="dv-slider-block">
                    <div class="dv-slider-row">
                      <label class="dv-slider-label">多样性 α
                        <span class="dv-tip" title="α 越大越重视 embedding 空间多样性；越小越偏向高复杂度 clip">?</span>
                      </label>
                      <span class="dv-slider-val" id="dv-subset-alpha-val">0.99</span>
                    </div>
                    <input type="range" id="dv-subset-alpha" class="dv-range" min="50" max="100" value="99" />
                    <p class="hint dv-alpha-hint" id="dv-alpha-hint">α=0.99：优先选彼此差异大的 clip；降低 α 会更偏向高动态动作。</p>
                  </div>
                  <div class="dv-selbar" id="dv-selbar"></div>
                  <div class="dv-robot-export-opts" id="dv-robot-export-opts" hidden>
                    <label class="dv-check">
                      <input type="checkbox" id="dv-robot-export-files" checked />
                      打包轨迹文件夹 (ZIP)
                    </label>
                    <span class="hint">取消勾选 → 仅导出选中 clip 的 JSON 清单</span>
                  </div>
                  <div class="dv-actions-grid">
                    <button type="button" class="btn" id="dv-human-basket" disabled>人体数据 → 批量篮子</button>
                    <button type="button" class="btn" id="dv-export-robot" disabled>导出机器人数据</button>
                    <button type="button" class="btn secondary" id="dv-export-json">导出 manifest (JSON)</button>
                    <button type="button" class="btn secondary" id="dv-clear-sel">清除手动选中</button>
                  </div>
                  <div class="hint dv-clip-detail" id="dv-clip-detail"></div>
                </div>
              </div>
            </div>
          </details>
        </div>
      </section>
      </div>
    </aside>

    <WorkspaceDrawerHandle
      side="right"
      :expanded="!panelLayout.state.inspectorHidden"
      :locale="workspaceLocale"
      @toggle="panelLayout.setHidden('inspector', !panelLayout.state.inspectorHidden)"
    />
    <JobDrawer docked :locale="workspaceLocale" />
    <WorkspaceSettingsDialog
      :open="settingsOpen"
      :locale="workspaceLocale"
      :sidebar-hidden="panelLayout.state.sidebarHidden"
      :inspector-hidden="panelLayout.state.inspectorHidden"
      :job-admission="jobAdmission"
      :job-admission-loading="jobAdmissionLoading"
      :job-admission-saving="jobAdmissionSaving"
      :job-admission-error="jobAdmissionError"
      :job-admission-error-operation="jobAdmissionErrorOperation"
      :job-admission-saved="jobAdmissionSaved"
      :motion-library="motionLibrarySettings"
      :motion-library-loading="motionLibrarySettingsLoading"
      :motion-library-saving="motionLibrarySettingsSaving"
      :motion-library-error="motionLibrarySettingsError"
      :motion-library-saved="motionLibrarySettingsSaved"
      :gvhmr-component="gvhmrComponent"
      :gvhmr-runtime="gvhmrRuntime"
      :gvhmr-loading="gvhmrLoading"
      :gvhmr-setup-running="gvhmrSetupRunning"
      :gvhmr-error="gvhmrError"
      @close="settingsOpen = false"
      @set-locale="setWorkspaceLocale"
      @set-hidden="panelLayout.setHidden"
      @reset="panelLayout.reset"
      @refresh-job-admission="loadJobAdmission"
      @save-job-admission="saveJobAdmission"
      @refresh-motion-library="loadMotionLibrarySettings"
      @select-motion-library-root="chooseMotionLibraryRoot"
      @refresh-gvhmr="loadGvhmrComponent"
      @setup-gvhmr="setupGvhmr"
    />
    <AboutDialog
      :open="aboutOpen"
      :locale="workspaceLocale"
      @close="aboutOpen = false"
    />
  </div>

  <div id="load-overlay" class="hidden">
    <div class="load-card">
      <div class="load-label" id="load-label">{{ workspaceText('Loading…', '加载中…') }}</div>
      <div class="progress"><div class="bar" id="load-bar"></div></div>
      <div class="load-sub" id="load-sub"></div>
    </div>
  </div>

  <div id="calib-banner" class="hidden">
    <span class="dot"></span>{{ workspaceText(
      'Calibration mode · Align the grey robot to the blue reference skeleton',
      '标定模式 · 请将灰色机器人对齐到蓝色参考骨架',
    ) }}
  </div>

  <!-- Guided tour overlay -->
  <div id="tour-root" class="tour-root" aria-hidden="true">
    <div id="tour-highlight" class="tour-highlight"></div>
    <div id="tour-popover" class="tour-popover" role="dialog" aria-labelledby="tour-title">
      <div class="tour-popover-head">
        <span class="tour-step-badge" id="tour-step">1 / 9</span>
        <button type="button" class="tour-skip" id="tour-skip">
          {{ workspaceText('Skip tutorial', '跳过教程') }}
        </button>
      </div>
      <h3 class="tour-title" id="tour-title">{{ workspaceText('Tutorial', '操作教程') }}</h3>
      <p class="tour-body" id="tour-body"></p>
      <button type="button" class="btn tour-next" id="tour-next">
        {{ workspaceText('Next', '下一步') }}
      </button>
    </div>
  </div>

  <div id="toast"></div>
  <div id="boot-error" style="display:none;position:fixed;inset:auto 16px 16px 16px;z-index:200;
    background:#ff3b30;color:#fff;padding:12px 16px;border-radius:8px;font:14px/1.5 -apple-system,sans-serif">
  </div>
</template>
