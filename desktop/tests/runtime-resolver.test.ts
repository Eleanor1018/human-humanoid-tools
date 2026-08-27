import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
    expect(environment.XDG_CONFIG_HOME).toBe('C:\\config')
    expect(environment.XDG_DATA_HOME).toBe('C:\\data')
    expect(environment.HHTOOLS_ARBITRARY_SECRET).toBeUndefined()
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(environment.PYTHONUTF8).toBe('1')
  })
})
