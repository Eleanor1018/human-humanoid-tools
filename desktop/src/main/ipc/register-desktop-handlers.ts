import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'

import { DESKTOP_CHANNELS } from '../../shared/desktop-api'
import type { RuntimeState } from '../../shared/runtime-state'
import { assertTrustedIpcSender } from './validate-ipc-sender'

export function registerDesktopHandlers(options: {
  mainWindow: BrowserWindow
  trustedOrigin: string
  getRuntimeState: () => RuntimeState
  restartBackend: () => Promise<RuntimeState>
}): () => void {
  // Every handler applies the same WebContents, main-frame, and origin checks before doing work.
  const trusted = (event: Electron.IpcMainInvokeEvent): void =>
    assertTrustedIpcSender(event, options.mainWindow, options.trustedOrigin)

  ipcMain.handle(DESKTOP_CHANNELS.getRuntimeState, (event) => {
    trusted(event)
    return options.getRuntimeState()
  })
  ipcMain.handle(DESKTOP_CHANNELS.restartBackend, async (event) => {
    trusted(event)
    return options.restartBackend()
  })
  ipcMain.handle(DESKTOP_CHANNELS.selectDirectory, async (event) => {
    trusted(event)
    const result = await dialog.showOpenDialog(options.mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(DESKTOP_CHANNELS.openExternal, async (event, value: unknown) => {
    trusted(event)
    if (typeof value !== 'string' || value.length > 2_048) {
      throw new Error('Invalid external URL')
    }
    const url = new URL(value)
    // Reject file:, shell:, and custom protocols before handing the URL to the operating system.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP(S) external URLs are allowed')
    }
    await shell.openExternal(url.toString())
  })

  return () => {
    ipcMain.removeHandler(DESKTOP_CHANNELS.getRuntimeState)
    ipcMain.removeHandler(DESKTOP_CHANNELS.restartBackend)
    ipcMain.removeHandler(DESKTOP_CHANNELS.selectDirectory)
    ipcMain.removeHandler(DESKTOP_CHANNELS.openExternal)
  }
}
