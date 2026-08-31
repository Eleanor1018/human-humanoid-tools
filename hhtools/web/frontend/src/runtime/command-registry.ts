import type {
  ComparisonPreset,
  ImportCommandTarget,
  WorkspaceLocale,
  WorkspacePanelId,
  WorkspaceTheme,
  WorkflowId,
} from './types'

export type DesktopMenuId = 'file' | 'workflows' | 'analysis' | 'settings' | 'help'
export type DesktopSubmenuId = 'file-import' | 'file-export'

export interface ApplicationCommand {
  id: string
  group: string
  label: string
  detail: string
  keywords: string
  shortcut?: string
  menu?: DesktopMenuId
  submenu?: DesktopSubmenuId
  dividerBefore?: boolean
  enabled?: boolean
  disabledReason?: string
  run: () => void
}

export interface CommandRegistryContext {
  activePanel: WorkspacePanelId
  openSettings: () => void
  theme?: WorkspaceTheme
  toggleTheme?: () => void
  applicationMode?: boolean
  locale?: WorkspaceLocale
  canExportResult?: boolean
  exportResult?: () => void
  canExitApplication?: boolean
  exitApplication?: () => void
}

export const DESKTOP_MENUS: ReadonlyArray<{ id: DesktopMenuId; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
]

const PANEL_COMMANDS: ReadonlyArray<{
  panel: WorkspacePanelId
  label: string
  detail: string
  enLabel: string
  enDetail: string
  zhLabel: string
  zhDetail: string
  shortcut: string
  menu?: DesktopMenuId
}> = [
  {
    panel: 'motion', label: '动作 Motion', detail: '导入与检查人体动作',
    enLabel: 'Motion', enDetail: 'Import and inspect human motion',
    zhLabel: '动作', zhDetail: '导入与检查人体动作', shortcut: 'Alt+1',
  },
  {
    panel: 'robot-assets', label: '机器人 Robot', detail: '管理机器人模型',
    enLabel: 'Robot', enDetail: 'Manage robot models and assets',
    zhLabel: '机器人', zhDetail: '管理机器人模型与资产', shortcut: 'Alt+2',
  },
  {
    panel: 'video-to-motion', label: 'Video to Motion', detail: '使用 GVHMR 从视频生成人体动作',
    enLabel: 'Video to Motion', enDetail: 'Generate human motion from a video with GVHMR',
    zhLabel: '视频生成动作', zhDetail: '使用 GVHMR 从视频生成人体动作',
    shortcut: 'Alt+7', menu: 'workflows',
  },
  {
    panel: 'h2r', label: 'Human to Robot', detail: '人体动作重映射到机器人',
    enLabel: 'Human to Robot', enDetail: 'Retarget human motion to a robot',
    zhLabel: '人体到机器人', zhDetail: '将人体动作重映射到机器人',
    shortcut: 'Alt+3', menu: 'workflows',
  },
  {
    panel: 'r2r', label: 'Robot to Robot', detail: '机器人轨迹跨本体重映射',
    enLabel: 'Robot to Robot', enDetail: 'Retarget trajectories across robot embodiments',
    zhLabel: '机器人到机器人', zhDetail: '在不同机器人本体间重映射轨迹',
    shortcut: 'Alt+4', menu: 'workflows',
  },
  {
    panel: 'batch', label: 'Batch', detail: '批量 Retarget 与导出',
    enLabel: 'Batch', enDetail: 'Run batch retargeting and export',
    zhLabel: '批量处理', zhDetail: '批量执行动作重映射与导出',
    shortcut: 'Alt+5', menu: 'workflows',
  },
  {
    panel: 'dataset-viz', label: 'Data Analysis', detail: '分析动作与机器人轨迹数据',
    enLabel: 'Data Analysis', enDetail: 'Analyze motion and robot trajectory datasets',
    zhLabel: '数据分析', zhDetail: '分析动作与机器人轨迹数据',
    shortcut: 'Alt+6', menu: 'analysis',
  },
]

function localize(locale: WorkspaceLocale, en: string, zh: string): string {
  return locale === 'zh-CN' ? zh : en
}

function requestPanel(panel: WorkspacePanelId): void {
  window.dispatchEvent(new CustomEvent('hhtools:panel-request', { detail: panel }))
}

function requestImport(target: ImportCommandTarget): void {
  window.dispatchEvent(new CustomEvent('hhtools:import-command', { detail: { target } }))
}

function playback(action: 'toggle' | 'loop'): void {
  window.dispatchEvent(new CustomEvent('hhtools:playback-command', { detail: { action } }))
}

function workflowForPanel(panel: WorkspacePanelId): WorkflowId | null {
  return panel === 'h2r' || panel === 'r2r' ? panel : null
}

function compare(workflow: WorkflowId, preset: ComparisonPreset): void {
  window.dispatchEvent(new CustomEvent('hhtools:comparison-command', {
    detail: { workflow, preset },
  }))
}

function importCommand(options: {
  id: string
  label: string
  detail: string
  target: ImportCommandTarget
  dividerBefore?: boolean
}, locale: WorkspaceLocale): ApplicationCommand {
  return {
    ...options,
    group: localize(locale, 'File', '文件'),
    menu: 'file',
    submenu: 'file-import',
    keywords: `file import upload ${options.label} ${options.detail}`,
    run: () => requestImport(options.target),
  }
}

export function createApplicationCommands(
  context: CommandRegistryContext,
): ApplicationCommand[] {
  const commands: ApplicationCommand[] = []
  const locale = context.locale ?? (context.applicationMode ? 'en' : 'zh-CN')

  if (context.applicationMode) {
    commands.push(
      importCommand({
        id: 'import-motion-file',
        label: localize(locale, 'Import Motion File', '导入动作文件'),
        detail: localize(locale, 'Import BVH, GLB, NPZ, and other motion files', '导入 BVH、GLB、NPZ 等动作文件'),
        target: 'motion-file',
      }, locale),
      importCommand({
        id: 'import-motion-folder',
        label: localize(locale, 'Import Motion Folder', '导入动作文件夹'),
        detail: localize(locale, 'Import a general motion dataset folder', '导入通用动作数据目录'),
        target: 'motion-folder',
      }, locale),
      importCommand({
        id: 'import-video-file',
        label: localize(locale, 'Import Video', '导入视频'),
        detail: localize(locale, 'Select a video for the Video to Motion workflow', '为视频生成动作工作流选择视频'),
        target: 'video-file',
        dividerBefore: true,
      }, locale),
      importCommand({
        id: 'import-robot-urdf',
        label: localize(locale, 'Import Robot URDF', '导入机器人 URDF'),
        detail: localize(locale, 'Select a robot URDF description file', '选择机器人 URDF 描述文件'),
        target: 'robot-urdf',
        dividerBefore: true,
      }, locale),
      importCommand({
        id: 'import-robot-mesh-folder',
        label: localize(locale, 'Import Robot Mesh Folder', '导入机器人 Mesh 文件夹'),
        detail: localize(locale, 'Select the mesh folder referenced by the URDF', '选择与 URDF 配套的 meshes 目录'),
        target: 'robot-mesh-folder',
      }, locale),
      importCommand({
        id: 'import-robot-trajectory',
        label: localize(locale, 'Import Robot Trajectory', '导入机器人轨迹'),
        detail: localize(locale, 'Import the source robot trajectory for R2R', '导入 R2R 源机器人轨迹'),
        target: 'robot-trajectory',
        dividerBefore: true,
      }, locale),
      importCommand({
        id: 'import-dataset-folder',
        label: localize(locale, 'Import Dataset Folder', '导入数据集文件夹'),
        detail: localize(locale, 'Select a dataset folder to analyze', '选择要分析的数据集目录'),
        target: 'dataset-folder',
      }, locale),
      importCommand({
        id: 'import-job-spec',
        label: localize(locale, 'Import JobSpec', '导入 JobSpec'),
        detail: localize(locale, 'Import a reproducible JobSpec JSON file', '导入可验证和重放的 JobSpec JSON'),
        target: 'job-spec',
      }, locale),
      {
        id: 'export-current-result',
        group: localize(locale, 'File', '文件'),
        label: localize(locale, 'Current Result…', '当前结果……'),
        detail: localize(locale, 'Download the result of the active workflow', '下载当前工作流的处理结果'),
        keywords: 'file export result download 文件 导出 结果 下载',
        menu: 'file',
        submenu: 'file-export',
        enabled: context.canExportResult === true,
        disabledReason: context.canExportResult === true
          ? undefined
          : localize(locale, 'No exportable result', '暂无可导出的结果'),
        run: context.exportResult ?? (() => undefined),
      },
      {
        id: 'exit-application',
        group: localize(locale, 'File', '文件'),
        label: localize(locale, 'Exit', '退出'),
        detail: localize(locale, 'Close HHTOOLS', '关闭 HHTOOLS'),
        keywords: 'file exit quit close 文件 退出 关闭',
        menu: 'file',
        dividerBefore: true,
        enabled: context.canExitApplication === true,
        disabledReason: context.canExitApplication === true
          ? undefined
          : localize(locale, 'Desktop app only', '仅桌面应用可用'),
        run: context.exitApplication ?? (() => undefined),
      },
      {
        id: 'open-settings',
        group: localize(locale, 'Settings', '设置'),
        label: localize(locale, 'Settings', '设置'),
        detail: localize(
          locale,
          'Configure language, workspace layout, and background jobs',
          '调整语言、工作区布局与后台任务调度',
        ),
        keywords: 'settings preferences language layout jobs queue concurrency 设置 语言 布局 任务 队列 并发',
        menu: 'settings',
        run: context.openSettings,
      },
      {
        id: 'toggle-theme',
        group: localize(locale, 'Settings', '设置'),
        label: context.theme === 'dark'
          ? localize(locale, 'Light Mode', '浅色模式')
          : localize(locale, 'Dark Mode', '深色模式'),
        detail: context.theme === 'dark'
          ? localize(locale, 'Switch to the light appearance', '切换为浅色外观')
          : localize(locale, 'Switch to the dark appearance', '切换为深色外观'),
        keywords: 'theme light dark appearance 主题 浅色 深色 外观',
        menu: 'settings',
        run: context.toggleTheme ?? (() => undefined),
      },
    )
  }

  commands.push(...PANEL_COMMANDS.map((item) => ({
    id: `panel-${item.panel}`,
    group: context.applicationMode
      ? item.menu === 'workflows'
        ? localize(locale, 'Workflows', '工作流')
        : item.menu === 'analysis'
          ? localize(locale, 'Analysis', '分析')
          : localize(locale, 'Workspace', '工作区')
      : item.menu === 'workflows' ? 'Workflows' : item.menu === 'analysis' ? 'Analysis' : '工作区',
    label: context.applicationMode ? localize(locale, item.enLabel, item.zhLabel) : item.label,
    detail: context.applicationMode ? localize(locale, item.enDetail, item.zhDetail) : item.detail,
    shortcut: item.shortcut,
    keywords: `${item.panel} ${item.label} ${item.detail}`,
    menu: item.menu,
    run: () => requestPanel(item.panel),
  })))

  if (context.applicationMode) {
    commands.push({
      id: 'help-tutorial',
      group: localize(locale, 'Help', '帮助'),
      label: localize(locale, 'Tutorial', '操作教程'),
      detail: localize(locale, 'Run the interactive tutorial again', '重新运行交互式操作教程'),
      keywords: 'help tutorial tour 教程 帮助',
      menu: 'help',
      run: () => window.__hhTour?.start(0),
    }, {
      id: 'help-contact',
      group: localize(locale, 'Help', '帮助'),
      label: localize(locale, 'Contact', '联系我们'),
      detail: localize(locale, 'Contact the hhtools team', '联系 hhtools 团队'),
      keywords: 'help contact support 联系 支持',
      menu: 'help',
      enabled: false,
      disabledReason: localize(locale, 'Coming soon', '即将推出'),
      run: () => undefined,
    })
  }

  commands.push(
    {
      id: 'playback-toggle',
      group: context.applicationMode ? localize(locale, 'Playback', '播放') : '播放',
      label: context.applicationMode ? localize(locale, 'Play / Pause', '播放 / 暂停') : '播放 / 暂停',
      detail: context.applicationMode ? localize(locale, 'Control the active timeline', '控制当前时间轴') : '控制当前时间轴',
      shortcut: 'Space',
      keywords: 'play pause 播放 暂停 时间轴',
      run: () => playback('toggle'),
    },
    {
      id: 'playback-loop',
      group: context.applicationMode ? localize(locale, 'Playback', '播放') : '播放',
      label: context.applicationMode ? localize(locale, 'Toggle Loop', '切换循环播放') : '切换循环播放',
      detail: context.applicationMode ? localize(locale, 'Toggle looping for the active timeline', '切换当前时间轴循环状态') : '切换当前时间轴循环状态',
      keywords: 'loop 循环',
      run: () => playback('loop'),
    },
    {
      id: 'view-reset',
      group: context.applicationMode ? localize(locale, 'View', '视图') : '视图',
      label: context.applicationMode ? localize(locale, 'Reset 3D View', '重置 3D 视角') : '重置 3D 视角',
      detail: context.applicationMode ? localize(locale, 'Return to the default camera position', '回到当前对象的默认相机位置') : '回到当前对象的默认相机位置',
      shortcut: 'F',
      keywords: 'camera reset focus 相机 视角 重置',
      run: () => document.getElementById('view-reset-btn')?.click(),
    },
    {
      id: 'panels-reveal',
      group: context.applicationMode ? localize(locale, 'View', '视图') : '视图',
      label: context.applicationMode ? localize(locale, 'Show Side Panels', '显示左右面板') : '显示左右面板',
      detail: context.applicationMode ? localize(locale, 'Restore navigation and inspector panels', '恢复导航栏与控制面板') : '恢复导航栏与控制面板',
      keywords: 'sidebar inspector panel 显示 面板 导航',
      run: () => window.__hhPanelLayout?.revealBoth(),
    },
  )

  const workflow = workflowForPanel(context.activePanel)
  if (workflow) {
    const comparisonCommands: Array<[ComparisonPreset, string, string, string]> = [
      ['source', 'Source Only', '只看源数据', 'Alt+S'],
      ['target', 'Target Only', '只看缩放目标', 'Alt+T'],
      ['result', 'Result Only', '只看机器人结果', 'Alt+R'],
      ['overlay', 'Overlay', '叠加对比', 'Alt+O'],
    ]
    for (const [preset, enLabel, zhLabel, shortcut] of comparisonCommands) {
      const label = context.applicationMode ? localize(locale, enLabel, zhLabel) : zhLabel
      commands.push({
        id: `compare-${preset}`,
        group: context.applicationMode ? localize(locale, 'Result Comparison', '结果对比') : '结果对比',
        label,
        detail: context.applicationMode
          ? localize(locale, `${workflow.toUpperCase()} result view`, `${workflow.toUpperCase()} 结果视图`)
          : `${workflow.toUpperCase()} 结果视图`,
        shortcut,
        keywords: `${preset} compare 对比 ${label}`,
        run: () => compare(workflow, preset),
      })
    }
  }

  return commands
}
