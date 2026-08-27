<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  createApplicationCommands,
  type ApplicationCommand,
} from '../runtime/command-registry'
import type { WorkspaceLocale, WorkspacePanelId, WorkspaceTheme } from '../runtime/types'

const props = withDefaults(defineProps<{
  activePanel: WorkspacePanelId
  locale?: WorkspaceLocale
  theme?: WorkspaceTheme
}>(), {
  locale: 'zh-CN',
  theme: 'light',
})

const emit = defineEmits<{
  openSettings: []
  toggleTheme: []
}>()

const open = ref(false)
const query = ref('')
const selectedIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)

const commands = computed(() => createApplicationCommands({
  activePanel: props.activePanel,
  openSettings: () => emit('openSettings'),
  theme: props.theme,
  toggleTheme: () => emit('toggleTheme'),
  desktop: window.hhtoolsDesktop !== undefined,
  locale: props.locale,
}))

const copy = computed(() => props.locale === 'zh-CN'
  ? {
      trigger: '命令',
      title: '打开命令面板',
      dialog: '命令面板',
      placeholder: '搜索工作区、导入、播放或视图命令',
      search: '搜索命令',
      empty: '没有匹配的命令',
    }
  : {
      trigger: 'Commands',
      title: 'Open command palette',
      dialog: 'Command palette',
      placeholder: 'Search workspace, import, playback, or view commands',
      search: 'Search commands',
      empty: 'No matching commands',
    })

const filteredCommands = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return commands.value
  return commands.value.filter((command) =>
    `${command.label} ${command.detail} ${command.keywords}`.toLowerCase().includes(needle),
  )
})

function show(): void {
  open.value = true
  query.value = ''
  selectedIndex.value = 0
  void nextTick(() => input.value?.focus())
}

function close(): void {
  open.value = false
}

function run(command: ApplicationCommand): void {
  if (command.enabled === false) return
  command.run()
  close()
}

function runById(id: string): void {
  const command = commands.value.find((candidate) => candidate.id === id)
  if (command) run(command)
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function moveSelection(delta: number): void {
  if (!filteredCommands.value.length) return
  let next = selectedIndex.value
  do {
    next = (next + delta + filteredCommands.value.length) % filteredCommands.value.length
  } while (filteredCommands.value[next]?.enabled === false && next !== selectedIndex.value)
  selectedIndex.value = next
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    open.value ? close() : show()
    return
  }
  if (open.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = filteredCommands.value[selectedIndex.value]
      if (command) run(command)
    }
    return
  }
  if (isEditable(event.target)) return

  if (event.altKey && /^[1-6]$/.test(event.key)) {
    event.preventDefault()
    const panelIds = ['motion', 'robot-assets', 'h2r', 'r2r', 'batch', 'dataset-viz']
    runById(`panel-${panelIds[Number(event.key) - 1]}`)
    return
  }
  if (event.code === 'Space' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    runById('playback-toggle')
    return
  }
  if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    runById('view-reset')
    return
  }
  if (event.altKey && (props.activePanel === 'h2r' || props.activePanel === 'r2r')) {
    const preset = ({ s: 'source', t: 'target', r: 'result', o: 'overlay' } as const)[
      event.key.toLowerCase() as 's' | 't' | 'r' | 'o'
    ]
    if (preset) {
      event.preventDefault()
      runById(`compare-${preset}`)
    }
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <button type="button" class="command-palette-trigger" :title="copy.title" @click="show">
    <span aria-hidden="true">⌕</span>
    <span>{{ copy.trigger }}</span>
    <kbd>Ctrl K</kbd>
  </button>

  <Teleport to="body">
    <div v-if="open" class="command-palette-scrim" @mousedown.self="close">
      <section class="command-palette" role="dialog" aria-modal="true" :aria-label="copy.dialog">
        <div class="command-palette-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref="input"
            v-model="query"
            type="search"
            :placeholder="copy.placeholder"
            :aria-label="copy.search"
            @input="selectedIndex = 0"
          />
          <kbd>Esc</kbd>
        </div>
        <div class="command-palette-list" role="listbox">
          <button
            v-for="(command, index) in filteredCommands"
            :key="command.id"
            type="button"
            class="command-palette-item"
            :class="{ selected: selectedIndex === index, disabled: command.enabled === false }"
            role="option"
            :aria-selected="selectedIndex === index"
            :aria-disabled="command.enabled === false"
            :disabled="command.enabled === false"
            @mouseenter="selectedIndex = index"
            @click="run(command)"
          >
            <span class="command-palette-copy">
              <strong>{{ command.label }}</strong>
              <small>{{ command.group }} · {{ command.detail }}</small>
            </span>
            <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
            <small v-else-if="command.disabledReason" class="command-disabled-reason">{{ command.disabledReason }}</small>
          </button>
          <p v-if="!filteredCommands.length" class="command-palette-empty">{{ copy.empty }}</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
