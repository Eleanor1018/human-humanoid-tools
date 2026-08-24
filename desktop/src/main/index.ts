/**
 * Electron main-process bootstrap.
 *
 * Startup is intentionally linear: resolve the external Python runtime, create a
 * secured localhost session, start and health-check the sidecar, load the existing
 * WebUI, then reveal the window. Shutdown follows the reverse ownership chain.
 */
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, session } from 'electron'

import { DESKTOP_CHANNELS } from '../shared/desktop-api'
import type { RuntimeState } from '../shared/runtime-state'
import { AppLifecycle } from './app-lifecycle'
import { DesktopLogger } from './desktop-logger'
import { diagnosticsDataUrl } from './diagnostics-page'
import { registerDesktopHandlers } from './ipc/register-desktop-handlers'
import { createMainWindow } from './main-window'
import { findAvailablePort } from './network'
import { buildSidecarEnvironment, resolveRuntime, type RuntimeConfig } from './runtime-resolver'
import { configureDesktopSession } from './security/configure-session'
import { SidecarSupervisor, type SidecarSnapshot } from './sidecar-supervisor'
import { WindowStateStore } from './window-state-store'

const lifecycle = new AppLifecycle()

// These references are process-wide because requestSingleInstanceLock() guarantees one owner.
let mainWindow: BrowserWindow | undefined
let supervisor: SidecarSupervisor | undefined
let logger: DesktopLogger | undefined
let runtime: RuntimeConfig | undefined
let backendOrigin: string | undefined
let allowQuit = false
let shutdownPromise: Promise<void> | undefined
let crashDialogOpen = false

function runtimeState(snapshot: SidecarSnapshot | undefined = supervisor?.snapshot): RuntimeState {
  return {
    appPhase: lifecycle.phase,
    backendState: snapshot?.state ?? 'stopped',
    backendOrigin,
    backendPid: snapshot?.pid,
    error: snapshot?.error
  }
}

function broadcastRuntimeState(snapshot?: SidecarSnapshot): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.runtimeStateChanged, runtimeState(snapshot))
  }
}

async function offerCrashRecovery(snapshot: SidecarSnapshot): Promise<void> {
  if (
    crashDialogOpen ||
    lifecycle.phase === 'shutting-down' ||
    mainWindow === undefined ||
    mainWindow.isDestroyed()
  ) {
    return
  }
  crashDialogOpen = true
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'hhtools backend stopped',
      message: 'The local Python backend stopped unexpectedly.',
      detail: snapshot.error ?? 'See the desktop log for details.',
      buttons: ['Restart backend', 'Close'],
      defaultId: 0,
      cancelId: 1
    })
    if (result.response === 0 && supervisor !== undefined) await supervisor.restart()
  } finally {
    crashDialogOpen = false
  }
}

async function startDesktop(): Promise<void> {
  app.setAppUserModelId('com.roboparty.hhtools.desktop.alpha')
  const userData = app.getPath('userData')

  // The Alpha shell reuses a checked-out Python environment instead of bundling GPU runtimes.
  runtime = resolveRuntime({ appPath: app.getAppPath(), cwd: process.cwd(), userData })
  logger = new DesktopLogger(runtime.logDirectory)
  logger.info('Desktop startup began', { repoRoot: runtime.repoRoot })

  const port = await findAvailablePort()
  const secret = randomBytes(32).toString('hex')
  backendOrigin = `http://127.0.0.1:${port}`

  // Electron injects this per-launch secret below the renderer boundary. WebUI code never sees it.
  configureDesktopSession(session.defaultSession, backendOrigin, secret)

  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), '../preload/index.cjs')
  const stateStore = new WindowStateStore(join(userData, 'window-state.json'))
  const windowResult = createMainWindow({
    preloadPath,
    trustedOrigin: backendOrigin,
    stateStore,
    logger
  })
  mainWindow = windowResult.window

  supervisor = new SidecarSupervisor(
    {
      command: runtime.pythonExecutable,
      args: [
        '-m',
        'hhtools.cli.desktop_sidecar',
        '--source',
        runtime.sourceRoot,
        '--save-dir',
        runtime.saveDirectory,
        '--cache',
        runtime.cacheDirectory,
        '--host',
        '127.0.0.1',
        '--port',
        String(port)
      ],
      cwd: runtime.repoRoot,
      env: {
        ...buildSidecarEnvironment(runtime.repoRoot),
        // Use the environment rather than argv so the secret is absent from process listings.
        HHTOOLS_DESKTOP_SESSION_SECRET: secret
      },
      origin: backendOrigin,
      sessionSecret: secret
    },
    logger
  )

  const removeStateListener = supervisor.onStateChange((snapshot) => {
    broadcastRuntimeState(snapshot)
    if (snapshot.state === 'crashed' && lifecycle.phase === 'after-window-open') {
      void offerCrashRecovery(snapshot)
    }
  })

  // Every resource owned by Main registers one cleanup hook in the same shutdown coordinator.
  lifecycle.registerShutdownJoiner('runtime-state-listener', removeStateListener)
  lifecycle.registerShutdownJoiner('python-sidecar', () => supervisor?.stop())

  const removeDesktopHandlers = registerDesktopHandlers({
    mainWindow,
    trustedOrigin: backendOrigin,
    getRuntimeState: () => runtimeState(),
    restartBackend: async () => {
      if (lifecycle.phase === 'shutting-down' || supervisor === undefined) {
        throw new Error('The application is shutting down')
      }
      const snapshot = await supervisor.restart()
      return runtimeState(snapshot)
    }
  })
  lifecycle.registerShutdownJoiner('desktop-ipc', removeDesktopHandlers)

  lifecycle.transition('backend-starting')
  broadcastRuntimeState()

  // start() resolves only after the authenticated /api/health endpoint answers successfully.
  await supervisor.start()
  lifecycle.transition('ready')
  broadcastRuntimeState()

  await mainWindow.loadURL(backendOrigin)
  await windowResult.readyToShow

  // Keeping the window hidden until backend and renderer are ready avoids a blank or error flash.
  if (!mainWindow.isDestroyed()) mainWindow.show()
  lifecycle.transition('after-window-open')
  broadcastRuntimeState()
  logger.info('Desktop window opened', { origin: backendOrigin })
}

async function showStartupFailure(reason: unknown): Promise<void> {
  const message = reason instanceof Error ? reason.message : String(reason)
  logger?.error('Desktop startup failed', { error: message })

  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 760,
      height: 520,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
  }
  await mainWindow.loadURL(
    diagnosticsDataUrl({
      title: 'hhtools could not start',
      message,
      stage: lifecycle.phase,
      logPath: logger?.filePath,
      pythonPath: runtime?.pythonExecutable
    })
  )
  if (!mainWindow.isDestroyed()) mainWindow.show()
}

async function shutdown(): Promise<void> {
  // Electron can emit before-quit more than once; all callers share one shutdown operation.
  if (shutdownPromise !== undefined) return shutdownPromise
  shutdownPromise = (async () => {
    const result = await lifecycle.runShutdownJoiners(7_000)
    if (result.timedOut) logger?.warn('Desktop shutdown timed out')
    for (const failure of result.failures) {
      logger?.error('Shutdown joiner failed', {
        name: failure.name,
        error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
      })
    }
    logger?.info('Desktop shutdown complete')
    await logger?.close()
    allowQuit = true
    app.quit()
  })()
  return shutdownPromise
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(startDesktop).catch((reason: unknown) => void showStartupFailure(reason))

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (allowQuit) return

    // Delay the actual quit until the sidecar, IPC handlers, and log stream are closed.
    event.preventDefault()
    void shutdown()
  })
}
