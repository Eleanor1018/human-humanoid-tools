import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
  openExternal: vi.fn()
}))

const securityMocks = vi.hoisted(() => ({
  assertTrustedIpcSender: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: electronMocks.showOpenDialog },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  shell: { openExternal: electronMocks.openExternal }
}))

vi.mock('../src/main/ipc/validate-ipc-sender', () => ({
  assertTrustedIpcSender: securityMocks.assertTrustedIpcSender
}))

import { registerDesktopHandlers } from '../src/main/ipc/register-desktop-handlers'
import { DESKTOP_CHANNELS } from '../src/shared/desktop-api'

describe('registerDesktopHandlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
    electronMocks.handle.mockImplementation((channel, handler) => {
      electronMocks.handlers.set(channel, handler)
    })
  })

  function register(): { event: IpcMainInvokeEvent; mainWindow: BrowserWindow } {
    const event = {} as IpcMainInvokeEvent
    const mainWindow = {} as BrowserWindow
    registerDesktopHandlers({
      mainWindow,
      trustedOrigin: 'http://127.0.0.1:43100',
      getRuntimeState: () => ({ appPhase: 'ready', backendState: 'ready' }),
      restartBackend: async () => ({ appPhase: 'ready', backendState: 'ready' })
    })
    return { event, mainWindow }
  }

  it('opens a trusted native directory picker and returns the selected path', async () => {
    const { event, mainWindow } = register()
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\motions']
    })

    const handler = electronMocks.handlers.get(DESKTOP_CHANNELS.selectDirectory)
    await expect(handler?.(event)).resolves.toBe('C:\\motions')

    expect(securityMocks.assertTrustedIpcSender).toHaveBeenCalledWith(
      event,
      mainWindow,
      'http://127.0.0.1:43100'
    )
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    })
    expect(securityMocks.assertTrustedIpcSender.mock.invocationCallOrder[0]).toBeLessThan(
      electronMocks.showOpenDialog.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('returns null when the native directory picker is cancelled', async () => {
    const { event } = register()
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    const handler = electronMocks.handlers.get(DESKTOP_CHANNELS.selectDirectory)

    await expect(handler?.(event)).resolves.toBeNull()
  })

  it('removes the directory picker handler during cleanup', () => {
    const mainWindow = {} as BrowserWindow
    const unregister = registerDesktopHandlers({
      mainWindow,
      trustedOrigin: 'http://127.0.0.1:43100',
      getRuntimeState: () => ({ appPhase: 'ready', backendState: 'ready' }),
      restartBackend: async () => ({ appPhase: 'ready', backendState: 'ready' })
    })

    unregister()

    expect(electronMocks.removeHandler).toHaveBeenCalledWith(DESKTOP_CHANNELS.selectDirectory)
  })
})
