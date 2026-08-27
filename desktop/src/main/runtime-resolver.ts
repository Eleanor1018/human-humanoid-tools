/** Resolve the external Python checkout and writable desktop directories used by the Alpha. */
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export interface RuntimeConfig {
  repoRoot: string
  pythonExecutable: string
  sourceRoot: string
  saveDirectory: string
  cacheDirectory: string
  logDirectory: string
}

export interface ResolveRuntimeOptions {
  appPath: string
  cwd: string
  userData: string
  env?: NodeJS.ProcessEnv
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

function resolvePython(repoRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.HHTOOLS_PYTHON !== undefined) {
    if (isAbsolute(env.HHTOOLS_PYTHON) && !existsSync(env.HHTOOLS_PYTHON)) {
      throw new Error(`HHTOOLS_PYTHON does not exist: ${env.HHTOOLS_PYTHON}`)
    }
    return env.HHTOOLS_PYTHON
  }

  const candidates =
    process.platform === 'win32'
      ? [join(repoRoot, '.venv', 'Scripts', 'python.exe')]
      : [join(repoRoot, '.venv', 'bin', 'python')]
  const localPython = candidates.find((candidate) => existsSync(candidate))
  return localPython ?? (process.platform === 'win32' ? 'python' : 'python3')
}

export function resolveRuntime(options: ResolveRuntimeOptions): RuntimeConfig {
  const env = options.env ?? process.env
  const repoRoot = resolveRepositoryRoot(options, env)

  return {
    repoRoot,
    pythonExecutable: resolvePython(repoRoot, env),
    sourceRoot: resolve(env.HHTOOLS_SOURCE_ROOT ?? join(repoRoot, 'assets', 'motions')),
    saveDirectory: resolve(env.HHTOOLS_SAVE_DIR ?? join(options.userData, 'save_npz')),
    cacheDirectory: resolve(env.HHTOOLS_CACHE_DIR ?? join(options.userData, 'cache')),
    logDirectory: resolve(env.HHTOOLS_LOG_DIR ?? join(options.userData, 'logs'))
  }
}

const ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HHTOOLS_MAX_QUEUED_JOBS',
  'HHTOOLS_MAX_RUNNING_JOBS',
  'HHTOOLS_WEB_SETTINGS_PATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'VIRTUAL_ENV',
  'WINDIR'
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
  result.PYTHONUTF8 = '1'
  result.PYTHONUNBUFFERED = '1'
  return result
}
