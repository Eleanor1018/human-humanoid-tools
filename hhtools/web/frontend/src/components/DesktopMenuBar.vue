<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  createApplicationCommands,
  DESKTOP_MENUS,
  type ApplicationCommand,
  type DesktopMenuId,
} from '../runtime/command-registry'
import type { WorkspaceLocale, WorkspacePanelId, WorkspaceTheme } from '../runtime/types'

const props = withDefaults(defineProps<{
  activePanel: WorkspacePanelId
  locale?: WorkspaceLocale
  theme?: WorkspaceTheme
}>(), {
  locale: 'en',
  theme: 'light',
})

const emit = defineEmits<{
  openSettings: []
  toggleTheme: []
}>()

const root = ref<HTMLElement | null>(null)
const openMenu = ref<DesktopMenuId | null>(null)

const commands = computed(() => createApplicationCommands({
  activePanel: props.activePanel,
  openSettings: () => emit('openSettings'),
  theme: props.theme,
  toggleTheme: () => emit('toggleTheme'),
  applicationMode: true,
  locale: props.locale,
}))

const menuLabels: Record<WorkspaceLocale, Record<DesktopMenuId, string>> = {
  en: { file: 'File', workflows: 'Workflows', analysis: 'Analysis', settings: 'Settings', help: 'Help' },
  'zh-CN': { file: '文件', workflows: '工作流', analysis: '分析', settings: '设置', help: '帮助' },
}

function menuLabel(menu: DesktopMenuId): string {
  return menuLabels[props.locale][menu]
}

function commandsFor(menu: DesktopMenuId): ApplicationCommand[] {
  return commands.value.filter((command) => command.menu === menu)
}

function menuIndex(menu: DesktopMenuId): number {
  return DESKTOP_MENUS.findIndex((candidate) => candidate.id === menu)
}

function triggerFor(menu: DesktopMenuId): HTMLButtonElement | null {
  return root.value?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${menu}"]`) ?? null
}

function enabledItems(menu: DesktopMenuId): HTMLButtonElement[] {
  return [...(root.value?.querySelectorAll<HTMLButtonElement>(
    `[data-menu-popup="${menu}"] .desktop-menu-item:not(:disabled)`,
  ) ?? [])]
}

function focusFirst(menu: DesktopMenuId): void {
  void nextTick(() => enabledItems(menu)[0]?.focus())
}

function selectMenu(index: number, focusItem: boolean): void {
  const menu = DESKTOP_MENUS[(index + DESKTOP_MENUS.length) % DESKTOP_MENUS.length]
  openMenu.value = menu.id
  if (focusItem) focusFirst(menu.id)
  else void nextTick(() => triggerFor(menu.id)?.focus())
}

function toggleMenu(menu: DesktopMenuId): void {
  openMenu.value = openMenu.value === menu ? null : menu
}

function run(command: ApplicationCommand): void {
  if (command.enabled === false) return
  openMenu.value = null
  command.run()
}

function handleTriggerKeydown(event: KeyboardEvent, menu: DesktopMenuId): void {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openMenu.value = menu
    focusFirst(menu)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    selectMenu(menuIndex(menu) + 1, false)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    selectMenu(menuIndex(menu) - 1, false)
  } else if (event.key === 'Escape') {
    openMenu.value = null
  }
}

function focusSibling(menu: DesktopMenuId, current: HTMLButtonElement, delta: number): void {
  const items = enabledItems(menu)
  const index = items.indexOf(current)
  if (index < 0 || !items.length) return
  items[(index + delta + items.length) % items.length]?.focus()
}

function handleItemKeydown(event: KeyboardEvent, menu: DesktopMenuId): void {
  const current = event.currentTarget as HTMLButtonElement
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusSibling(menu, current, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusSibling(menu, current, -1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    enabledItems(menu)[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    enabledItems(menu).at(-1)?.focus()
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    selectMenu(menuIndex(menu) + (event.key === 'ArrowRight' ? 1 : -1), true)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    openMenu.value = null
    void nextTick(() => triggerFor(menu)?.focus())
  }
}

function handleDocumentPointer(event: PointerEvent): void {
  if (root.value?.contains(event.target as Node)) return
  openMenu.value = null
}

function closeMenus(): void {
  openMenu.value = null
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointer)
  window.addEventListener('blur', closeMenus)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointer)
  window.removeEventListener('blur', closeMenus)
})
</script>

<template>
  <nav ref="root" class="desktop-menubar" role="menubar" aria-label="Application menu">
    <div v-for="menu in DESKTOP_MENUS" :key="menu.id" class="desktop-menu-root">
      <button
        type="button"
        class="desktop-menu-trigger"
        :class="{ active: openMenu === menu.id }"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="openMenu === menu.id"
        :data-menu-trigger="menu.id"
        @click="toggleMenu(menu.id)"
        @mouseenter="openMenu && (openMenu = menu.id)"
        @keydown="handleTriggerKeydown($event, menu.id)"
      >
        {{ menuLabel(menu.id) }}
      </button>

      <div
        v-if="openMenu === menu.id"
        class="desktop-menu-popup"
        role="menu"
        :aria-label="menuLabel(menu.id)"
        :data-menu-popup="menu.id"
      >
        <template v-for="command in commandsFor(menu.id)" :key="command.id">
          <div v-if="command.dividerBefore" class="desktop-menu-separator" role="separator"></div>
          <button
            type="button"
            class="desktop-menu-item"
            role="menuitem"
            :disabled="command.enabled === false"
            :aria-disabled="command.enabled === false"
            :title="command.disabledReason || command.detail"
            @click="run(command)"
            @keydown="handleItemKeydown($event, menu.id)"
          >
            <span class="desktop-menu-item-copy">
              <span>{{ command.label }}</span>
            </span>
            <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
            <small v-else-if="command.disabledReason" class="desktop-menu-disabled">{{ command.disabledReason }}</small>
          </button>
        </template>
      </div>
    </div>
  </nav>
</template>
