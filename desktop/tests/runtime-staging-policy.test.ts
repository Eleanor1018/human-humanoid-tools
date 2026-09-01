import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertPathInside,
  assertRobotDestinationAvailable,
  listApplicationSourceFiles,
  resolveBundledRobotDirectory
} from '../scripts/runtime-staging-policy.mjs'

describe('runtime staging policy', () => {
  it('selects tracked files without copying untracked or ignored content', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-staging-git-'))
    mkdirSync(join(root, 'hhtools'), { recursive: true })
    writeFileSync(join(root, 'hhtools', 'tracked.py'), 'tracked\n', 'utf8')
    writeFileSync(join(root, 'hhtools', 'untracked.secret'), 'private\n', 'utf8')
    writeFileSync(join(root, '.gitignore'), '*.secret\n', 'utf8')
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', 'add', '.gitignore', 'hhtools/tracked.py'],
      { cwd: root }
    )

    const selected = listApplicationSourceFiles(root, ['hhtools'], {})

    expect(selected.provenance).toBe('git-tracked-worktree')
    expect(selected.files).toEqual(['hhtools/tracked.py'])
  })

  it('requires explicit trust for an extracted source archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-staging-archive-'))
    mkdirSync(join(root, 'hhtools'), { recursive: true })
    writeFileSync(join(root, 'hhtools', 'app.py'), '', 'utf8')

    expect(() => listApplicationSourceFiles(root, ['hhtools'], {})).toThrow(
      'HHTOOLS_TRUST_SOURCE_ARCHIVE=1'
    )
    expect(
      listApplicationSourceFiles(root, ['hhtools'], { HHTOOLS_TRUST_SOURCE_ARCHIVE: '1' })
    ).toEqual({ provenance: 'trusted-archive', files: ['hhtools/app.py'] })
  })

  it('does not infer bundled robots from HOME or XDG paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-staging-robots-'))

    expect(
      resolveBundledRobotDirectory(
        { HOME: '/home/nora', XDG_CONFIG_HOME: '/tmp/config' },
        root
      )
    ).toBeNull()
    expect(
      resolveBundledRobotDirectory({ HHTOOLS_BUNDLED_ROBOT_DIR: 'robots' }, root)
    ).toBe(join(root, 'robots'))
  })

  it('rejects a robot name that would merge into an existing destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-staging-robot-name-'))
    const destination = join(root, 'g1')
    mkdirSync(destination)

    expect(() => assertRobotDestinationAvailable(destination, 'g1')).toThrow(
      'refusing to merge duplicate bundled robot: g1'
    )
  })

  it('rejects staged paths outside the runtime root', () => {
    const root = mkdtempSync(join(tmpdir(), 'hhtools-staging-root-'))

    expect(() =>
      assertPathInside(root, join(root, 'python', 'lib'), 'outside runtime', {
        allowRoot: false
      })
    ).not.toThrow()
    expect(() =>
      assertPathInside(root, join(root, '..', 'system-python'), 'outside runtime', {
        allowRoot: false
      })
    ).toThrow('outside runtime')
    expect(() =>
      assertPathInside(root, root, 'site-packages cannot equal Python root', {
        allowRoot: false
      })
    ).toThrow('site-packages cannot equal Python root')
  })
})
