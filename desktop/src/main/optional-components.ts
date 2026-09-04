import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { dialog, shell, type BrowserWindow } from 'electron'

import type {
  GvhmrOptionalComponentState,
  GvhmrSetupResult,
  OptionalComponentsState,
} from '../shared/desktop-api'

const GVHMR_GUIDE_URL = 'https://github.com/zju3dv/GVHMR/blob/main/docs/INSTALL.md'
const GVHMR_ESTIMATED_ADDITIONAL_BYTES = 22 * 1024 * 1024 * 1024

interface OptionalComponentConfiguration {
  schemaVersion: 1
  gvhmr?: {
    requested?: boolean
    root?: string
    python?: string
  }
}

function isGvhmrCheckout(path: string): boolean {
  return existsSync(join(path, 'tools', 'demo', 'demo.py'))
}

function readConfiguration(path: string): OptionalComponentConfiguration {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as OptionalComponentConfiguration
    if (value.schemaVersion === 1) return value
  } catch {
    // Missing, truncated, or future config files fall back to a fresh v1 document.
  }
  return { schemaVersion: 1 }
}

export class OptionalComponentStore {
  private readonly path: string
  private readonly installerMarker: string
  private readonly platform: NodeJS.Platform
  private configuration: OptionalComponentConfiguration

  constructor(options: {
    userData: string
    localAppData?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
  }) {
    this.path = join(options.userData, 'optional-components.json')
    const localAppData = options.localAppData ?? options.env?.LOCALAPPDATA
    this.installerMarker = localAppData
      ? join(localAppData, 'hhtools', 'installer', 'gvhmr.requested')
      : join(options.userData, 'gvhmr.requested')
    this.platform = options.platform ?? process.platform
    this.configuration = readConfiguration(this.path)

    if (existsSync(this.installerMarker)) {
      this.configuration.gvhmr = { ...this.configuration.gvhmr, requested: true }
      this.save()
      rmSync(this.installerMarker, { force: true })
    }
  }

  getState(env: NodeJS.ProcessEnv = process.env): OptionalComponentsState {
    const configuredRoot = this.configuration.gvhmr?.root
    const environmentRoot = env.HHTOOLS_GVHMR_ROOT
    const conventionalRoot = this.platform === 'win32' ? 'C:\\GVHMR' : join(env.HOME ?? '', 'GVHMR')
    const root = [environmentRoot, configuredRoot, conventionalRoot]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find(isGvhmrCheckout)
    const python = this.resolveGvhmrPython(root, env)
    const runtime = this.platform === 'win32' ? 'docker' : 'local'

    return {
      gvhmr: {
        requested: this.configuration.gvhmr?.requested === true,
        configured: root !== undefined && (runtime === 'docker' || python !== undefined),
        root,
        python,
        runtime,
        guideUrl: GVHMR_GUIDE_URL,
        estimatedAdditionalBytes: GVHMR_ESTIMATED_ADDITIONAL_BYTES,
      },
    }
  }

  sidecarEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const state = this.getState(env).gvhmr
    const result: NodeJS.ProcessEnv = {}
    if (state.root && env.HHTOOLS_GVHMR_ROOT === undefined) {
      result.HHTOOLS_GVHMR_ROOT = state.root
    }
    if (state.python && env.HHTOOLS_GVHMR_PYTHON === undefined) {
      result.HHTOOLS_GVHMR_PYTHON = state.python
    }
    return result
  }

  configureGvhmr(root: string, python?: string): GvhmrOptionalComponentState {
    const resolved = resolve(root)
    if (!isGvhmrCheckout(resolved)) {
      throw new Error(`This folder is not an official GVHMR checkout: ${resolved}`)
    }
    const resolvedPython = python ? resolve(python) : this.resolveGvhmrPython(resolved, {})
    if (this.platform !== 'win32' && !resolvedPython) {
      throw new Error('Choose the Python executable from the installed GVHMR environment')
    }
    if (resolvedPython && !existsSync(resolvedPython)) {
      throw new Error(`The GVHMR Python executable does not exist: ${resolvedPython}`)
    }
    this.configuration.gvhmr = {
      requested: false,
      root: resolved,
      ...(resolvedPython ? { python: resolvedPython } : {}),
    }
    this.save()
    return this.getState().gvhmr
  }

  private resolveGvhmrPython(
    root: string | undefined,
    env: NodeJS.ProcessEnv,
  ): string | undefined {
    if (this.platform === 'win32') return undefined
    const home = env.HOME
    const candidates = [
      env.HHTOOLS_GVHMR_PYTHON,
      this.configuration.gvhmr?.python,
      root ? join(root, '.venv', 'bin', 'python') : undefined,
      root ? join(root, 'venv', 'bin', 'python') : undefined,
      home ? join(home, '.conda', 'envs', 'gvhmr', 'bin', 'python') : undefined,
      home ? join(home, 'anaconda3', 'envs', 'gvhmr', 'bin', 'python') : undefined,
      home ? join(home, 'miniconda3', 'envs', 'gvhmr', 'bin', 'python') : undefined,
    ]
    return candidates
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find(existsSync)
  }

  private save(): void {
    const directory = dirname(this.path)
    const temporaryPath = `${this.path}.tmp`
    // mkdir is intentionally lazy so merely launching the app never writes a config.
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(this.configuration, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, this.path)
  }
}

export async function runGvhmrSetup(options: {
  mainWindow: BrowserWindow
  store: OptionalComponentStore
  onConfigured: () => Promise<void>
}): Promise<GvhmrSetupResult> {
  const current = options.store.getState().gvhmr
  const localRuntime = current.runtime === 'local'
  const decision = await dialog.showMessageBox(options.mainWindow, {
    type: 'info',
    title: 'GVHMR video-to-motion',
    message: 'Set up the optional GVHMR component',
    detail: localRuntime
      ? 'GVHMR runs in its own Python environment and uses the official checkpoints plus licensed '
        + 'SMPL-X files. Choose the checkout and then that environment\'s Python executable.'
      : 'GVHMR runs separately through Docker Desktop and requires official checkpoints plus '
        + 'licensed SMPL-X files. Choose an existing official checkout, or open the installation guide.',
    buttons: ['Choose GVHMR folder', 'Open installation guide', 'Not now'],
    defaultId: 0,
    cancelId: 2,
  })

  if (decision.response === 1) {
    await shell.openExternal(GVHMR_GUIDE_URL)
    return { action: 'guide-opened', state: current }
  }
  if (decision.response !== 0) return { action: 'cancelled', state: current }

  const selection = await dialog.showOpenDialog(options.mainWindow, {
    title: 'Choose the official GVHMR repository',
    defaultPath: current.root,
    properties: ['openDirectory'],
  })
  const root = selection.filePaths[0]
  if (selection.canceled || root === undefined) {
    return { action: 'cancelled', state: options.store.getState().gvhmr }
  }

  let python: string | undefined
  if (localRuntime) {
    const pythonSelection = await dialog.showOpenDialog(options.mainWindow, {
      title: 'Choose Python from the GVHMR environment',
      defaultPath: current.python,
      properties: ['openFile'],
    })
    python = pythonSelection.filePaths[0]
    if (pythonSelection.canceled || python === undefined) {
      return { action: 'cancelled', state: options.store.getState().gvhmr }
    }
  }

  let state: GvhmrOptionalComponentState
  try {
    state = options.store.configureGvhmr(root, python)
  } catch (reason) {
    await dialog.showMessageBox(options.mainWindow, {
      type: 'error',
      title: 'GVHMR folder not recognized',
      message: reason instanceof Error ? reason.message : String(reason),
      detail: 'Choose the repository root containing tools/demo/demo.py.',
    })
    return { action: 'cancelled', state: options.store.getState().gvhmr }
  }

  await options.onConfigured()
  return { action: 'configured', state }
}
