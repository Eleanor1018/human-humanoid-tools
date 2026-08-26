<script setup lang="ts">
import type { WorkspacePanelId } from '../runtime/types'

interface NavigationItem {
  id: WorkspacePanelId
  label: string
  icon: string
  badgeId?: string
}

interface NavigationGroup {
  label: string
  items: NavigationItem[]
}

defineProps<{
  activePanel: WorkspacePanelId
}>()

const emit = defineEmits<{
  request: [panel: WorkspacePanelId]
}>()

const groups: NavigationGroup[] = [
  {
    label: '资产 Assets',
    items: [
      { id: 'motion', label: '动作 Motion', icon: '🎞' },
      { id: 'robot-assets', label: '机器人 Robot', icon: '🤖' },
    ],
  },
  {
    label: '工作流 Workflows',
    items: [
      { id: 'h2r', label: '人体 → 机器人 H2R', icon: '↗' },
      { id: 'r2r', label: '机器人 → 机器人 R2R', icon: '🔁' },
      { id: 'batch', label: '批量 Batch', icon: '🧺', badgeId: 'basket-badge' },
    ],
  },
  {
    label: '分析 Analysis',
    items: [
      { id: 'dataset-viz', label: '数据集 Dataset', icon: '📊' },
    ],
  },
]
</script>

<template>
  <div class="nav-groups">
    <section v-for="group in groups" :key="group.label" class="nav-group">
      <h2 class="nav-group-label">{{ group.label }}</h2>
      <button
        v-for="item in group.items"
        :key="item.id"
        type="button"
        class="nav-item"
        :class="{ active: activePanel === item.id }"
        :data-panel="item.id"
        @click="emit('request', item.id)"
      >
        <span class="icon" aria-hidden="true">{{ item.icon }}</span>
        <span class="nav-item-label">{{ item.label }}</span>
        <span v-if="item.badgeId" :id="item.badgeId" class="badge" style="display:none">0</span>
      </button>
    </section>

    <section class="nav-group nav-help-group">
      <h2 class="nav-group-label">帮助 Help</h2>
      <button
        id="nav-tour"
        type="button"
        class="nav-item nav-tour hidden"
        title="重新查看 Web 操作教程"
      >
        <span class="icon" aria-hidden="true">?</span>
        <span class="nav-item-label">操作教程 Tutorial</span>
      </button>
    </section>
  </div>
</template>
