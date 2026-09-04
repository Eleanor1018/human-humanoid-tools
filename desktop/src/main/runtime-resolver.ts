/** Resolve either the bundled desktop runtime or a development checkout. */
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export interface RuntimeConfig {
  repoRoot: string
  pythonExecutable: string
  sourceRoot: string
  saveDirectory: string
  cacheDirectory: string
  logDirectory: string
  bundled: boolean
}

export interface ResolveRuntimeOptions {
  appPath: string
  cwd: string
  userData: string
  isPackaged?: boolean
  resourcesPath?: string
  env?: NodeJS.ProcessEnv
  /** Override the host platform in deterministic resolver tests. */
  platform?: NodeJS.Platform
}

function isRepositoryRoot(candidate: string): boolean {
  return existsSync(join(candidate, 'pyproject.toml')) && existsSync(join(candidate, 'hhtools'))
}

function walkForRepository(start: string): string | undefined {
  let current = resolve(start)
  while (true) {
    if (isRepositoryRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function bundledRuntime(options: ResolveRuntimeOptions): {
  repoRoot: string
  pythonExecutable: string
} | undefined {
  if (!options.isPackaged || options.resourcesPath === undefined) return undefined

  const runtimeRoot = join(options.resourcesPath, 'runtime')
  const repoRoot = join(runtimeRoot, 'app')
  const pythonExecutable =
    (options.platform ?? process.platform) === 'win32'
      ? join(runtimeRoot, 'python', 'python.exe')
      : join(runtimeRoot, 'python', 'bin', 'python3')

  if (!isRepositoryRoot(repoRoot)) {
    throw new Error(`Bundled hhtools application files are missing: ${repoRoot}`)
  }
  if (!existsSync(pythonExecutable)) {
    throw new Error(`Bundled Python runtime is missing: ${pythonExecutable}`)
  }
  return { repoRoot, pythonExecutable }
}

function resolveRepositoryRoot(options: ResolveRuntimeOptions, env: NodeJS.ProcessEnv): string {
  const configured = env.HHTOOLS_REPO_ROOT
  if (configured !== undefined) {
    // An explicit path is authoritative; fail early instead of silently using another checkout.
    const resolved = resolve(configured)
    if (!isRepositoryRoot(resolved)) {
      throw new Error(`HHTOOLS_REPO_ROOT is not a hhtools checkout: ${resolved}`)
    }
    return resolved
  }

  // Dev and unpacked builds normally live below the repository, so walking upward is enough.
  for (const candidate of [options.cwd, options.appPath, dirname(options.appPath)]) {
    const found = walkForRepository(candidate)
    if (found !== undefined) return found
  }
  throw new Error('Unable to find the hhtools repository. Set HHTOOLS_REPO_ROOT.')
}

function resolvePython(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  if (env.HHTOOLS_PYTHON !== undefined) {
    if (isAbsolute(env.HHTOOLS_PYTHON) && !existsSync(env.HHTOOLS_PYTHON)) {
      throw new Error(`HHTOOLS_PYTHON does not exist: ${env.HHTOOLS_PYTHON}`)
    }
    return env.HHTOOLS_PYTHON
  }

  const candidates =
    platform === 'win32'
      ? [join(repoRoot, '.venv', 'Scripts', 'python.exe')]
      : [join(repoRoot, '.venv', 'bin', 'python')]
  const localPython = candidates.find((candidate) => existsSync(candidate))
  return localPython ?? (platform === 'win32' ? 'python' : 'python3')
}

export function resolveRuntime(options: ResolveRuntimeOptions): RuntimeConfig {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const packaged = env.HHTOOLS_REPO_ROOT === undefined ? bundledRuntime(options) : undefined
  const repoRoot = packaged?.repoRoot ?? resolveRepositoryRoot(options, env)
  const pythonExecutable =
    env.HHTOOLS_PYTHON ?? packaged?.pythonExecutable ?? resolvePython(repoRoot, env, platform)

  return {
    repoRoot,
    pythonExecutable,
    sourceRoot: resolve(env.HHTOOLS_SOURCE_ROOT ?? join(repoRoot, 'assets', 'motions')),
    saveDirectory: resolve(env.HHTOOLS_SAVE_DIR ?? join(options.userData, 'save_npz')),
    // Keep Python's generated assets separate from Electron/Chromium's Cache directory.
    cacheDirectory: resolve(env.HHTOOLS_CACHE_DIR ?? join(options.userData, 'hhtools-cache')),
    logDirectory: resolve(env.HHTOOLS_LOG_DIR ?? join(options.userData, 'logs')),
    bundled: packaged !== undefined
  }
}

const ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'HHTOOLS_MAX_QUEUED_JOBS',
  'HHTOOLS_MAX_RUNNING_JOBS',
  'HHTOOLS_MOTION_LIBRARY_ROOT',
  'HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH',
  'HHTOOLS_GVHMR_BODY_MODELS',
  'HHTOOLS_GVHMR_IMAGE',
  'HHTOOLS_GVHMR_PYTHON',
  'HHTOOLS_GVHMR_ROOT',
  'HHTOOLS_GVHMR_TIMEOUT_SECONDS',
  'HHTOOLS_ROBOT_DIR',
  'HHTOOLS_ROBOT_PATH',
  'HHTOOLS_WEB_SETTINGS_PATH',
  'LOCALAPPDATA',
  'LD_LIBRARY_PATH',
  'MUJOCO_GL',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PYOPENGL_PLATFORM',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'VIRTUAL_ENV',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'WAYLAND_DISPLAY',
  'XAUTHORITY'
])

export function buildSidecarEnvironment(
  repoRoot: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}

  // Do not forward the entire Electron environment. Keep OS/runtime variables plus GPU toolchains.
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (ENV_ALLOWLIST.has(key.toUpperCase()) ||
        key.toUpperCase().startsWith('CUDA_') ||
        key.toUpperCase().startsWith('NVIDIA_') ||
        key.toUpperCase().startsWith('CONDA_'))
    ) {
      result[key] = value
    }
  }

  // Import the working checkout and make Python logs deterministic and immediately visible.
  result.PYTHONPATH = [repoRoot, source.PYTHONPATH].filter(Boolean).join(delimiter)
  result.PYTHONDONTWRITEBYTECODE = '1'
  result.PYTHONNOUSERSITE = '1'
  result.PYTHONUTF8 = '1'
  result.PYTHONUNBUFFERED = '1'
  return result
}
