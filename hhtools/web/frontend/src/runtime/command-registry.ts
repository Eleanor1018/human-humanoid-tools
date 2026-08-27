import type {
  ComparisonPreset,
  ImportCommandTarget,
  WorkspaceLocale,
  WorkspacePanelId,
  WorkspaceTheme,
  WorkflowId,
} from './types'

export type DesktopMenuId = 'file' | 'workflows' | 'analysis' | 'settings' | 'help'

export interface ApplicationCommand {
  id: string
  group: string
  label: string
  detail: string
  keywords: string
  shortcut?: string
  menu?: DesktopMenuId
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
  desktop?: boolean
  locale?: WorkspaceLocale
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
    panel: 'h2r', label: 'Human to Robot (H2R)', detail: '人体动作重映射到机器人',
    enLabel: 'Human to Robot (H2R)', enDetail: 'Retarget human motion to a robot',
    zhLabel: '人体到机器人 (H2R)', zhDetail: '将人体动作重映射到机器人',
    shortcut: 'Alt+3', menu: 'workflows',
  },
  {
    panel: 'r2r', label: 'Robot to Robot (R2R)', detail: '机器人轨迹跨本体重映射',
    enLabel: 'Robot to Robot (R2R)', enDetail: 'Retarget trajectories across robot embodiments',
    zhLabel: '机器人到机器人 (R2R)', zhDetail: '在不同机器人本体间重映射轨迹',
    shortcut: 'Alt+4', menu: 'workflows',
  },
  {
    panel: 'batch', label: 'Batch', detail: '批量 Retarget 与导出',
    enLabel: 'Batch', enDetail: 'Run batch retargeting and export',
    zhLabel: '批量处理', zhDetail: '批量执行动作重映射与导出',
    shortcut: 'Alt+5', menu: 'workflows',
  },
  {
    panel: 'dataset-viz', label: 'Manual Analysis', detail: '数据集可视化与手动分析',
    enLabel: 'Manual Analysis', enDetail: 'Visualize and inspect motion datasets',
    zhLabel: '手动分析', zhDetail: '可视化并检查动作数据集',
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
    keywords: `file import upload ${options.label} ${options.detail}`,
    run: () => requestImport(options.target),
  }
}

export function createApplicationCommands(
  context: CommandRegistryContext,
): ApplicationCommand[] {
  const commands: ApplicationCommand[] = []
  const locale = context.locale ?? (context.desktop ? 'en' : 'zh-CN')

  if (context.desktop) {
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
        id: 'open-settings',
        group: localize(locale, 'Settings', '设置'),
        label: localize(locale, 'Settings', '设置'),
        detail: localize(locale, 'Configure language and workspace layout', '调整语言与桌面工作区布局'),
        keywords: 'settings preferences language layout 设置 语言 布局',
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
    group: context.desktop
      ? item.menu === 'workflows'
        ? localize(locale, 'Workflows', '工作流')
        : item.menu === 'analysis'
          ? localize(locale, 'Analysis', '分析')
          : localize(locale, 'Workspace', '工作区')
      : item.menu === 'workflows' ? 'Workflows' : item.menu === 'analysis' ? 'Analysis' : '工作区',
    label: context.desktop ? localize(locale, item.enLabel, item.zhLabel) : item.label,
    detail: context.desktop ? localize(locale, item.enDetail, item.zhDetail) : item.detail,
    shortcut: item.shortcut,
    keywords: `${item.panel} ${item.label} ${item.detail}`,
    menu: item.menu,
    run: () => requestPanel(item.panel),
  })))

  if (context.desktop) {
    commands.push({
      id: 'analysis-pae',
      group: localize(locale, 'Analysis', '分析'),
      label: 'PAE Analysis',
      detail: localize(locale, 'Automated PAE analysis workflow', 'PAE 自动分析流程'),
      keywords: 'pae analysis 自动 分析',
      menu: 'analysis',
      enabled: false,
      disabledReason: localize(locale, 'Coming soon', '即将推出'),
      run: () => undefined,
    }, {
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
      group: context.desktop ? localize(locale, 'Playback', '播放') : '播放',
      label: context.desktop ? localize(locale, 'Play / Pause', '播放 / 暂停') : '播放 / 暂停',
      detail: context.desktop ? localize(locale, 'Control the active timeline', '控制当前时间轴') : '控制当前时间轴',
      shortcut: 'Space',
      keywords: 'play pause 播放 暂停 时间轴',
      run: () => playback('toggle'),
    },
    {
      id: 'playback-loop',
      group: context.desktop ? localize(locale, 'Playback', '播放') : '播放',
      label: context.desktop ? localize(locale, 'Toggle Loop', '切换循环播放') : '切换循环播放',
      detail: context.desktop ? localize(locale, 'Toggle looping for the active timeline', '切换当前时间轴循环状态') : '切换当前时间轴循环状态',
      keywords: 'loop 循环',
      run: () => playback('loop'),
    },
    {
      id: 'view-reset',
      group: context.desktop ? localize(locale, 'View', '视图') : '视图',
      label: context.desktop ? localize(locale, 'Reset 3D View', '重置 3D 视角') : '重置 3D 视角',
      detail: context.desktop ? localize(locale, 'Return to the default camera position', '回到当前对象的默认相机位置') : '回到当前对象的默认相机位置',
      shortcut: 'F',
      keywords: 'camera reset focus 相机 视角 重置',
      run: () => document.getElementById('view-reset-btn')?.click(),
    },
    {
      id: 'panels-reveal',
      group: context.desktop ? localize(locale, 'View', '视图') : '视图',
      label: context.desktop ? localize(locale, 'Show Side Panels', '显示左右面板') : '显示左右面板',
      detail: context.desktop ? localize(locale, 'Restore navigation and inspector panels', '恢复导航栏与控制面板') : '恢复导航栏与控制面板',
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
      const label = context.desktop ? localize(locale, enLabel, zhLabel) : zhLabel
      commands.push({
        id: `compare-${preset}`,
        group: context.desktop ? localize(locale, 'Result Comparison', '结果对比') : '结果对比',
        label,
        detail: context.desktop
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
