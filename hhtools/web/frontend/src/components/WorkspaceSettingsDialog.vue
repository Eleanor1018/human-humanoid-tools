<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import type { WorkspaceLocale } from '../runtime/types'

const props = defineProps<{
  open: boolean
  locale: WorkspaceLocale
  sidebarHidden: boolean
  inspectorHidden: boolean
}>()

const emit = defineEmits<{
  close: []
  setLocale: [locale: WorkspaceLocale]
  setHidden: [side: 'sidebar' | 'inspector', hidden: boolean]
  reset: []
}>()

const copy = computed(() => props.locale === 'zh-CN'
  ? {
      title: '工作区设置',
      subtitle: '桌面语言与面板布局',
      close: '关闭设置',
      language: '语言',
      languageDetail: '设置桌面菜单和导航使用的语言。',
      left: '左侧导航',
      leftDetail: '保持工作区导航栏展开。',
      right: '右侧控制面板',
      rightDetail: '显示工作流控制与参数。',
      reset: '↺ 重置布局',
      done: '完成',
    }
  : {
      title: 'Workspace Settings',
      subtitle: 'Desktop language and panel layout',
      close: 'Close settings',
      language: 'Language',
      languageDetail: 'Set the language used by desktop menus and navigation.',
      left: 'Left navigation',
      leftDetail: 'Keep the workspace navigation expanded.',
      right: 'Right inspector',
      rightDetail: 'Show workflow controls and parameters.',
      reset: '↺ Reset layout',
      done: 'Done',
    })

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
        </div>
        <footer class="workspace-settings-actions">
          <button type="button" class="workspace-settings-reset" @click="emit('reset')">{{ copy.reset }}</button>
          <button type="button" class="workspace-settings-done" @click="emit('close')">{{ copy.done }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
