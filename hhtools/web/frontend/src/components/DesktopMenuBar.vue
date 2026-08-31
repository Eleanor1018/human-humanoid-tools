<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  createApplicationCommands,
  DESKTOP_MENUS,
  type ApplicationCommand,
  type DesktopMenuId,
  type DesktopSubmenuId,
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
const openSubmenu = ref<DesktopSubmenuId | null>(null)
const commandRevision = ref(0)

function isVisible(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current) {
    const style = window.getComputedStyle(current)
    if (current.hidden || style.display === 'none' || style.visibility === 'hidden') return false
    current = current.parentElement
  }
  return true
}

function exportButton(): HTMLButtonElement | null {
  const buttonIds: Partial<Record<WorkspacePanelId, string>> = {
    h2r: 'rt-export-btn',
    r2r: 'r2r-export-btn',
    batch: 'batch-result-download',
    'dataset-viz': 'dv-export-json',
  }
  const buttonId = buttonIds[props.activePanel]
  const button = buttonId ? document.getElementById(buttonId) : null
  return button instanceof HTMLButtonElement && !button.disabled && isVisible(button) ? button : null
}

function refreshCommands(): void {
  commandRevision.value += 1
}

const commands = computed(() => {
  // Runtime export controls are DOM-backed, so opening a menu refreshes capability state.
  void commandRevision.value
  return createApplicationCommands({
    activePanel: props.activePanel,
    openSettings: () => emit('openSettings'),
    theme: props.theme,
    toggleTheme: () => emit('toggleTheme'),
    applicationMode: true,
    locale: props.locale,
    canExportResult: exportButton() !== null,
    exportResult: () => exportButton()?.click(),
    canExitApplication: window.hhtoolsDesktop !== undefined,
    exitApplication: () => window.close(),
  })
})

const menuLabels: Record<WorkspaceLocale, Record<DesktopMenuId, string>> = {
  en: { file: 'File', workflows: 'Workflows', analysis: 'Analysis', settings: 'Settings', help: 'Help' },
  'zh-CN': { file: '文件', workflows: '工作流', analysis: '分析', settings: '设置', help: '帮助' },
}

function menuLabel(menu: DesktopMenuId): string {
  return menuLabels[props.locale][menu]
}

function commandsFor(menu: DesktopMenuId): ApplicationCommand[] {
  return commands.value.filter((command) => command.menu === menu && !command.submenu)
}

const submenuOrder: Partial<Record<DesktopMenuId, DesktopSubmenuId[]>> = {
  file: ['file-import', 'file-export'],
}

const submenuLabels: Record<WorkspaceLocale, Record<DesktopSubmenuId, string>> = {
  en: { 'file-import': 'Import', 'file-export': 'Export' },
  'zh-CN': { 'file-import': '导入', 'file-export': '导出' },
}

function submenusFor(menu: DesktopMenuId): DesktopSubmenuId[] {
  return submenuOrder[menu] ?? []
}

function submenuLabel(submenu: DesktopSubmenuId): string {
  return submenuLabels[props.locale][submenu]
}

function commandsForSubmenu(submenu: DesktopSubmenuId): ApplicationCommand[] {
  return commands.value.filter((command) => command.submenu === submenu)
}

function menuIndex(menu: DesktopMenuId): number {
  return DESKTOP_MENUS.findIndex((candidate) => candidate.id === menu)
}

function triggerFor(menu: DesktopMenuId): HTMLButtonElement | null {
  return root.value?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${menu}"]`) ?? null
}

function enabledItems(menu: DesktopMenuId, level = 'root'): HTMLButtonElement[] {
  return [...(root.value?.querySelectorAll<HTMLButtonElement>(
    `[data-menu-popup="${menu}"] .desktop-menu-item[data-menu-level="${level}"]:not(:disabled)`,
  ) ?? [])]
}

function focusFirst(menu: DesktopMenuId): void {
  void nextTick(() => enabledItems(menu)[0]?.focus())
}

function selectMenu(index: number, focusItem: boolean): void {
  const menu = DESKTOP_MENUS[(index + DESKTOP_MENUS.length) % DESKTOP_MENUS.length]
  refreshCommands()
  openMenu.value = menu.id
  openSubmenu.value = null
  if (focusItem) focusFirst(menu.id)
  else void nextTick(() => triggerFor(menu.id)?.focus())
}

function toggleMenu(menu: DesktopMenuId): void {
  refreshCommands()
  openMenu.value = openMenu.value === menu ? null : menu
  openSubmenu.value = null
}

function switchMenuOnHover(menu: DesktopMenuId): void {
  if (!openMenu.value || openMenu.value === menu) return
  refreshCommands()
  openMenu.value = menu
  openSubmenu.value = null
}

function submenuTriggerFor(submenu: DesktopSubmenuId): HTMLButtonElement | null {
  return root.value?.querySelector<HTMLButtonElement>(`[data-submenu-trigger="${submenu}"]`) ?? null
}

function openChildSubmenu(menu: DesktopMenuId, submenu: DesktopSubmenuId, focusItem: boolean): void {
  openSubmenu.value = submenu
  if (focusItem) void nextTick(() => enabledItems(menu, submenu)[0]?.focus())
}

function run(command: ApplicationCommand): void {
  if (command.enabled === false) return
  openMenu.value = null
  openSubmenu.value = null
  command.run()
}

function handleTriggerKeydown(event: KeyboardEvent, menu: DesktopMenuId): void {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    refreshCommands()
    openMenu.value = menu
    openSubmenu.value = null
    focusFirst(menu)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    selectMenu(menuIndex(menu) + 1, false)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    selectMenu(menuIndex(menu) - 1, false)
  } else if (event.key === 'Escape') {
    openMenu.value = null
    openSubmenu.value = null
  }
}

function focusSibling(menu: DesktopMenuId, current: HTMLButtonElement, delta: number): void {
  const level = current.dataset.menuLevel ?? 'root'
  const items = enabledItems(menu, level)
  const index = items.indexOf(current)
  if (index < 0 || !items.length) return
  items[(index + delta + items.length) % items.length]?.focus()
}

function handleItemKeydown(event: KeyboardEvent, menu: DesktopMenuId): void {
  const current = event.currentTarget as HTMLButtonElement
  const level = current.dataset.menuLevel ?? 'root'
  const submenu = current.dataset.submenuTrigger as DesktopSubmenuId | undefined
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusSibling(menu, current, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusSibling(menu, current, -1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    enabledItems(menu, level)[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    enabledItems(menu, level).at(-1)?.focus()
  } else if (submenu && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    openChildSubmenu(menu, submenu, true)
  } else if (level !== 'root' && event.key === 'ArrowLeft') {
    event.preventDefault()
    openSubmenu.value = null
    void nextTick(() => submenuTriggerFor(level as DesktopSubmenuId)?.focus())
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    selectMenu(menuIndex(menu) + (event.key === 'ArrowRight' ? 1 : -1), true)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (openSubmenu.value) {
      const submenuToFocus = openSubmenu.value
      openSubmenu.value = null
      void nextTick(() => submenuTriggerFor(submenuToFocus)?.focus())
    } else {
      openMenu.value = null
      void nextTick(() => triggerFor(menu)?.focus())
    }
  }
}

function handleDocumentPointer(event: PointerEvent): void {
  if (root.value?.contains(event.target as Node)) return
  openMenu.value = null
  openSubmenu.value = null
}

function closeMenus(): void {
  openMenu.value = null
  openSubmenu.value = null
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
        @mouseenter="switchMenuOnHover(menu.id)"
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
        <div
          v-for="submenu in submenusFor(menu.id)"
          :key="submenu"
          class="desktop-submenu-root"
        >
          <button
            type="button"
            class="desktop-menu-item desktop-menu-submenu-trigger"
            :class="{ 'is-submenu-open': openSubmenu === submenu }"
            role="menuitem"
            aria-haspopup="menu"
            :aria-expanded="openSubmenu === submenu"
            data-menu-level="root"
            :data-submenu-trigger="submenu"
            @click="openChildSubmenu(menu.id, submenu, false)"
            @mouseenter="openChildSubmenu(menu.id, submenu, false)"
            @keydown="handleItemKeydown($event, menu.id)"
          >
            <span class="desktop-menu-item-copy">
              <span>{{ submenuLabel(submenu) }}</span>
            </span>
            <span class="desktop-menu-submenu-arrow" aria-hidden="true">›</span>
          </button>

          <div
            v-if="openSubmenu === submenu"
            class="desktop-menu-popup desktop-submenu-popup"
            role="menu"
            :aria-label="submenuLabel(submenu)"
            :data-submenu-popup="submenu"
          >
            <template v-for="command in commandsForSubmenu(submenu)" :key="command.id">
              <div v-if="command.dividerBefore" class="desktop-menu-separator" role="separator"></div>
              <button
                type="button"
                class="desktop-menu-item"
                role="menuitem"
                :disabled="command.enabled === false"
                :aria-disabled="command.enabled === false"
                :title="command.disabledReason || command.detail"
                :data-menu-level="submenu"
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

        <template v-for="command in commandsFor(menu.id)" :key="command.id">
          <div v-if="command.dividerBefore" class="desktop-menu-separator" role="separator"></div>
          <button
            type="button"
            class="desktop-menu-item"
            role="menuitem"
            :disabled="command.enabled === false"
            :aria-disabled="command.enabled === false"
            :title="command.disabledReason || command.detail"
            data-menu-level="root"
            @click="run(command)"
            @mouseenter="openSubmenu = null"
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
