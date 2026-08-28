<script setup lang="ts">
import type { WorkspaceLocale, WorkspacePanelId } from '../runtime/types'

interface NavigationItem {
  id?: WorkspacePanelId
  label: string
  enLabel: string
  zhLabel: string
  icon: string
  badgeId?: string
  disabled?: boolean
  disabledReason?: string
  workspaceOnly?: boolean
}

interface NavigationGroup {
  label: string
  enLabel: string
  zhLabel: string
  items: NavigationItem[]
}

const props = withDefaults(defineProps<{
  activePanel: WorkspacePanelId
  workspace?: boolean
  locale?: WorkspaceLocale
}>(), {
  workspace: false,
  locale: 'en',
})

const emit = defineEmits<{
  request: [panel: WorkspacePanelId]
}>()

const groups: NavigationGroup[] = [
  {
    label: '资产 Assets',
    enLabel: 'Assets',
    zhLabel: '资产',
    items: [
      { id: 'motion', label: '动作 Motion', enLabel: 'Motion', zhLabel: '动作', icon: '🎞' },
      { id: 'robot-assets', label: '机器人 Robot', enLabel: 'Robot', zhLabel: '机器人', icon: '🤖' },
    ],
  },
  {
    label: '工作流 Workflows',
    enLabel: 'Workflows',
    zhLabel: '工作流',
    items: [
      {
        id: 'video-to-motion',
        label: '视频 → 动作 Video to Motion',
        enLabel: 'Video → Motion',
        zhLabel: '视频 → 动作',
        icon: '🎥',
      },
      { id: 'h2r', label: '人体 → 机器人 H2R', enLabel: 'Human → Robot H2R', zhLabel: '人体 → 机器人 H2R', icon: '↗' },
      { id: 'r2r', label: '机器人 → 机器人 R2R', enLabel: 'Robot → Robot R2R', zhLabel: '机器人 → 机器人 R2R', icon: '🔁' },
      { id: 'batch', label: '批量 Batch', enLabel: 'Batch', zhLabel: '批量处理', icon: '🧺', badgeId: 'basket-badge' },
    ],
  },
  {
    label: '分析 Analysis',
    enLabel: 'Analysis',
    zhLabel: '分析',
    items: [
      {
        id: 'dataset-viz',
        label: '数据集 Dataset',
        enLabel: 'Manual Analysis',
        zhLabel: '手动分析',
        icon: '📊',
      },
      {
        label: 'PAE Analysis',
        enLabel: 'PAE Analysis',
        zhLabel: 'PAE 分析',
        icon: '◫',
        disabled: true,
        disabledReason: 'Coming soon',
        workspaceOnly: true,
      },
    ],
  },
]

function groupLabel(group: NavigationGroup): string {
  if (!props.workspace) return group.label
  return props.locale === 'zh-CN' ? group.zhLabel : group.enLabel
}

function itemLabel(item: NavigationItem): string {
  if (!props.workspace) return item.label
  return props.locale === 'zh-CN' ? item.zhLabel : item.enLabel
}

function disabledReason(item: NavigationItem): string | undefined {
  if (!item.disabledReason || props.locale === 'en') return item.disabledReason
  return '即将推出'
}
</script>

<template>
  <div class="nav-groups">
    <section
      v-for="group in groups"
      :key="group.label"
      class="nav-group"
      role="group"
      :aria-label="groupLabel(group)"
    >
      <button
        v-for="item in group.items"
        :key="item.id"
        type="button"
        class="nav-item"
        v-show="!item.workspaceOnly || workspace"
        :class="{ active: activePanel === item.id }"
        :data-panel="item.id"
        :disabled="item.disabled"
        :aria-disabled="item.disabled"
        :title="disabledReason(item) || itemLabel(item)"
        @click="item.id && emit('request', item.id)"
      >
        <span class="icon" aria-hidden="true">{{ item.icon }}</span>
        <span class="nav-item-label">{{ itemLabel(item) }}</span>
        <span v-if="item.badgeId" :id="item.badgeId" class="badge" style="display:none">0</span>
        <span v-else-if="item.disabledReason" class="nav-disabled-reason">{{ disabledReason(item) }}</span>
      </button>
    </section>

    <section
      class="nav-group nav-help-group"
      role="group"
      :aria-label="workspace ? (locale === 'zh-CN' ? '帮助' : 'Help') : '帮助 Help'"
    >
      <button
        id="nav-tour"
        type="button"
        class="nav-item nav-tour"
        :class="{ hidden: !workspace }"
        :title="locale === 'zh-CN' ? '重新查看操作教程' : 'Run the tutorial again'"
      >
        <span class="icon" aria-hidden="true">?</span>
        <span class="nav-item-label">{{ locale === 'zh-CN' ? '操作教程' : 'Tutorial' }}</span>
      </button>
    </section>
  </div>
</template>
