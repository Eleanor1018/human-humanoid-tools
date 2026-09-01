import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildSidecarEnvironment, resolveRuntime } from '../src/main/runtime-resolver'

describe('resolveRuntime', () => {
  it('finds a repository above the desktop working directory', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const runtime = resolveRuntime({
      appPath: join(root, 'desktop'),
      cwd: join(root, 'desktop'),
      userData: join(root, '.test-user-data')
    })

    expect(runtime.repoRoot).toBe(resolve(root))
    expect(runtime.sourceRoot).toBe(join(root, 'assets', 'motions'))
    expect(runtime.cacheDirectory).toBe(join(root, '.test-user-data', 'hhtools-cache'))
    expect(runtime.bundled).toBe(false)
  })

  it.each([
    ['win32', ['python', 'python.exe']],
    ['linux', ['python', 'bin', 'python3']]
  ] as const)('uses the bundled application and Python runtime on %s', (platform, pythonParts) => {
    const resourcesPath = mkdtempSync(join(tmpdir(), 'hhtools-packaged-runtime-test-'))
    const repoRoot = join(resourcesPath, 'runtime', 'app')
    const pythonExecutable = join(resourcesPath, 'runtime', ...pythonParts)
    mkdirSync(join(repoRoot, 'hhtools'), { recursive: true })
    mkdirSync(dirname(pythonExecutable), { recursive: true })
    writeFileSync(join(repoRoot, 'pyproject.toml'), '', 'utf8')
    writeFileSync(pythonExecutable, '', 'utf8')

    const runtime = resolveRuntime({
      appPath: 'C:\\Program Files\\hhtools',
      cwd: 'C:\\Program Files\\hhtools',
      userData: join(resourcesPath, 'user-data'),
      isPackaged: true,
      resourcesPath,
      env: {},
      platform
    })

    expect(runtime.repoRoot).toBe(repoRoot)
    expect(runtime.pythonExecutable).toBe(pythonExecutable)
    expect(runtime.bundled).toBe(true)
  })

  it('finds a checkout-local Linux virtual environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-linux-runtime-test-'))
    const pythonExecutable = join(root, '.venv', 'bin', 'python')
    mkdirSync(join(root, 'hhtools'), { recursive: true })
    mkdirSync(dirname(pythonExecutable), { recursive: true })
    writeFileSync(join(root, 'pyproject.toml'), '', 'utf8')
    writeFileSync(pythonExecutable, '', 'utf8')

    const runtime = resolveRuntime({
      appPath: join(root, 'desktop'),
      cwd: root,
      userData: join(root, 'data'),
      env: {},
      platform: 'linux'
    })

    expect(runtime.pythonExecutable).toBe(pythonExecutable)
    expect(runtime.bundled).toBe(false)
  })

  it('honors an explicit checkout and Python runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-runtime-test-'))
    mkdirSync(join(root, 'hhtools'), { recursive: true })
    writeFileSync(join(root, 'pyproject.toml'), '', 'utf8')
    const runtime = resolveRuntime({
      appPath: root,
      cwd: root,
      userData: join(root, 'data'),
      env: { HHTOOLS_REPO_ROOT: root, HHTOOLS_PYTHON: 'python-test' }
    })

    expect(runtime.pythonExecutable).toBe('python-test')
  })

  it('does not copy unrelated parent secrets into the sidecar environment', () => {
    const environment = buildSidecarEnvironment('C:\\repo', {
      PATH: 'C:\\bin',
      AWS_SECRET_ACCESS_KEY: 'do-not-copy',
      CUDA_PATH: 'C:\\cuda',
      HHTOOLS_MAX_RUNNING_JOBS: '2',
      HHTOOLS_MAX_QUEUED_JOBS: '32',
      HHTOOLS_WEB_SETTINGS_PATH: 'C:\\config\\web-settings.json',
      HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH: 'C:\\config\\motion-library-settings.json',
      HHTOOLS_ROBOT_DIR: 'C:\\config\\robots',
      LD_LIBRARY_PATH: '/opt/cuda/lib64',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':1',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/home/nora/.Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      MUJOCO_GL: 'egl',
      PYOPENGL_PLATFORM: 'egl',
      XDG_CONFIG_HOME: 'C:\\config',
      XDG_DATA_HOME: 'C:\\data',
      HHTOOLS_ARBITRARY_SECRET: 'do-not-copy-either'
    })

    expect(environment.PATH).toBe('C:\\bin')
    expect(environment.CUDA_PATH).toBe('C:\\cuda')
    expect(environment.HHTOOLS_MAX_RUNNING_JOBS).toBe('2')
    expect(environment.HHTOOLS_MAX_QUEUED_JOBS).toBe('32')
    expect(environment.HHTOOLS_WEB_SETTINGS_PATH).toBe('C:\\config\\web-settings.json')
    expect(environment.HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH).toBe(
      'C:\\config\\motion-library-settings.json'
    )
    expect(environment.HHTOOLS_ROBOT_DIR).toBe('C:\\config\\robots')
    expect(environment.LD_LIBRARY_PATH).toBe('/opt/cuda/lib64')
    expect(environment.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(environment.DISPLAY).toBe(':1')
    expect(environment.WAYLAND_DISPLAY).toBe('wayland-0')
    expect(environment.XAUTHORITY).toBe('/home/nora/.Xauthority')
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    expect(environment.MUJOCO_GL).toBe('egl')
    expect(environment.PYOPENGL_PLATFORM).toBe('egl')
    expect(environment.XDG_CONFIG_HOME).toBe('C:\\config')
    expect(environment.XDG_DATA_HOME).toBe('C:\\data')
    expect(environment.HHTOOLS_ARBITRARY_SECRET).toBeUndefined()
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(environment.PYTHONNOUSERSITE).toBe('1')
    expect(environment.PYTHONUTF8).toBe('1')
  })
})
