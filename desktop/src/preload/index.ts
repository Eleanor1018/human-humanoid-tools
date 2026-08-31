import { contextBridge, ipcRenderer } from 'electron'

import { DESKTOP_CHANNELS, type HHToolsDesktopApi } from '../shared/desktop-api'
import type { RuntimeState } from '../shared/runtime-state'

// Expose named operations only. The renderer never receives raw ipcRenderer or Node primitives.
const desktopApi: HHToolsDesktopApi = {
  getRuntimeState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getRuntimeState),
  restartBackend: () => ipcRenderer.invoke(DESKTOP_CHANNELS.restartBackend),
  selectDirectory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.selectDirectory),
  openExternal: (url: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
  onRuntimeStateChanged: (listener: (state: RuntimeState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: RuntimeState): void => listener(state)
    ipcRenderer.on(DESKTOP_CHANNELS.runtimeStateChanged, wrapped)
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.runtimeStateChanged, wrapped)
  }
}

contextBridge.exposeInMainWorld('hhtoolsDesktop', desktopApi)
