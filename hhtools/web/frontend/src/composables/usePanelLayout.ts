import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'

type PanelSide = 'sidebar' | 'inspector'

interface PanelLayoutState {
  sidebarWidth: number
  inspectorWidth: number
  sidebarHidden: boolean
  inspectorHidden: boolean
}

interface PanelLayoutOptions {
  docked?: boolean
}

const WEB_STORAGE_KEY = 'hhtools-panel-layout-v2'
const DOCKED_STORAGE_KEY = 'hhtools-desktop-panel-layout-v1'
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 520
const INSPECTOR_MIN = 240
const INSPECTOR_MAX = 640
const HANDLE_WIDTH = 6
const MIN_STAGE_WIDTH = 360
const DOCKED_SIDEBAR_WIDTH = 208

const DEFAULT_LAYOUT: PanelLayoutState = {
  sidebarWidth: 248,
  inspectorWidth: 360,
  sidebarHidden: false,
  inspectorHidden: false
}

function defaultLayout(docked: boolean): PanelLayoutState {
  return {
    ...DEFAULT_LAYOUT,
    sidebarWidth: docked ? DOCKED_SIDEBAR_WIDTH : DEFAULT_LAYOUT.sidebarWidth,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function loadLayout(storageKey: string, docked: boolean): PanelLayoutState {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<PanelLayoutState>
    return { ...defaultLayout(docked), ...saved }
  } catch {
    return defaultLayout(docked)
  }
}

export function usePanelLayout(options: PanelLayoutOptions = {}) {
  const docked = options.docked === true
  const storageKey = docked ? DOCKED_STORAGE_KEY : WEB_STORAGE_KEY
  const state = reactive<PanelLayoutState>(loadLayout(storageKey, docked))

  function availablePanelWidth(): number {
    const handles =
      (state.sidebarHidden ? 0 : HANDLE_WIDTH) + (state.inspectorHidden ? 0 : HANDLE_WIDTH)
    return Math.max(0, window.innerWidth - handles - MIN_STAGE_WIDTH)
  }

  function constrain(preferred?: PanelSide): void {
    state.sidebarWidth = clamp(state.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)
    state.inspectorWidth = clamp(state.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX)
    const available = availablePanelWidth()

    // Keep the visible drawer from consuming the stage when its peer is
    // collapsed, without overwriting the hidden drawer's remembered width.
    if (state.sidebarHidden && state.inspectorHidden) return
    if (state.sidebarHidden) {
      state.inspectorWidth = Math.min(state.inspectorWidth, available)
      return
    }
    if (state.inspectorHidden) {
      state.sidebarWidth = Math.min(state.sidebarWidth, available)
      return
    }

    if (state.sidebarWidth + state.inspectorWidth <= available) return

    // Preserve the panel currently being dragged and shrink its peer first.
    if (preferred === 'sidebar') {
      state.inspectorWidth = clamp(available - state.sidebarWidth, INSPECTOR_MIN, INSPECTOR_MAX)
      state.sidebarWidth = clamp(available - state.inspectorWidth, SIDEBAR_MIN, SIDEBAR_MAX)
      return
    }
    if (preferred === 'inspector') {
      state.sidebarWidth = clamp(available - state.inspectorWidth, SIDEBAR_MIN, SIDEBAR_MAX)
      state.inspectorWidth = clamp(available - state.sidebarWidth, INSPECTOR_MIN, INSPECTOR_MAX)
      return
    }

    const removable =
      state.sidebarWidth - SIDEBAR_MIN + (state.inspectorWidth - INSPECTOR_MIN)
    const overflow = state.sidebarWidth + state.inspectorWidth - available
    if (removable <= 0) return
    const sidebarShare = (state.sidebarWidth - SIDEBAR_MIN) / removable
    state.sidebarWidth = clamp(
      state.sidebarWidth - overflow * sidebarShare,
      SIDEBAR_MIN,
      SIDEBAR_MAX
    )
    state.inspectorWidth = clamp(available - state.sidebarWidth, INSPECTOR_MIN, INSPECTOR_MAX)
  }

  function save(): void {
    localStorage.setItem(storageKey, JSON.stringify(state))
  }

  function setHidden(side: PanelSide, hidden: boolean): void {
    if (side === 'sidebar') state.sidebarHidden = hidden
    else state.inspectorHidden = hidden
    constrain()
    save()
  }

  function revealBoth(): void {
    state.sidebarHidden = false
    state.inspectorHidden = false
    constrain()
    save()
  }

  function reset(): void {
    Object.assign(state, defaultLayout(docked))
    constrain()
    save()
  }

  function startResize(side: PanelSide, event: PointerEvent): void {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement | null
    target?.setPointerCapture(event.pointerId)
    target?.classList.add('dragging')
    const startX = event.clientX
    const startWidth = side === 'sidebar' ? state.sidebarWidth : state.inspectorWidth

    const move = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX
      if (side === 'sidebar') state.sidebarWidth = startWidth + delta
      else state.inspectorWidth = startWidth - delta
      constrain(side)
    }
    const stop = (): void => {
      target?.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      save()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }

  const style = computed(() => ({
    '--sidebar-w': state.sidebarHidden
      ? '0px'
      : `${Math.round(state.sidebarWidth)}px`,
    '--inspector-w': state.inspectorHidden ? '0px' : `${Math.round(state.inspectorWidth)}px`,
    '--sidebar-handle-w': state.sidebarHidden ? '0px' : `${HANDLE_WIDTH}px`,
    '--inspector-handle-w': state.inspectorHidden ? '0px' : `${HANDLE_WIDTH}px`
  }))

  const onWindowResize = (): void => constrain()
  onMounted(() => {
    constrain()
    window.addEventListener('resize', onWindowResize)
    window.__hhPanelLayout = { revealBoth, reset }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWindowResize)
    delete window.__hhPanelLayout
  })

  return { state, style, setHidden, startResize, reset }
}
