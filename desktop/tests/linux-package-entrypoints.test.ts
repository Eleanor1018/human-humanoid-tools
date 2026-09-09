import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  desktopName: string
  scripts: Record<string, string>
  build: {
    productName: string
    extraResources: Array<{ from: string; to: string }>
    linux: { executableName: string }
    win: { extraResources: Array<{ from: string; to: string; filter: string[] }> }
    deb: {
      depends: string[]
      fpm: string[]
      afterInstall?: string
      afterRemove?: string
    }
    nsis: { include?: string }
  }
}

const desktopRoot = resolve(import.meta.dirname, '..')
const packageMetadata = JSON.parse(
  readFileSync(join(desktopRoot, 'package.json'), 'utf8')
) as DesktopPackage

describe('Linux package entry points', () => {
  it('keeps the desktop identity while separating GUI and CLI commands', () => {
    expect(packageMetadata.desktopName).toBe('hhtools')
    expect(packageMetadata.build.productName).toBe('Human-Humanoid Tools')
    expect(packageMetadata.build.linux.executableName).toBe('hhtools-desktop')

    // The thin GUI package does not install or shadow the Python CLI.
    expect(packageMetadata.build.deb.fpm).not.toContain(
      expect.stringContaining('/usr/bin/hhtools')
    )
    expect(packageMetadata.build.deb.afterInstall).toBeUndefined()
    expect(packageMetadata.build.deb.afterRemove).toBeUndefined()
  })

  it('packages the installer bootstrap without embedding a Linux Python runtime', () => {
    expect(packageMetadata.scripts.postinstall).toBe('npm run prepare:electron')
    expect(packageMetadata.scripts['dist:linux']).toContain('npm run prepare:electron')
    expect(packageMetadata.scripts['dist:linux']).not.toContain('npm run prepare:models')
    expect(packageMetadata.scripts['dist:linux']).toContain('npm run prepare:builtin')
    expect(packageMetadata.scripts['dist:linux']).toContain('npm run prepare:bootstrap')
    expect(packageMetadata.scripts['dist:linux']).not.toContain('prepare:runtime')
    expect(packageMetadata.build.extraResources).toEqual([
      { from: '.bootstrap', to: 'bootstrap', filter: ['install.sh'] },
      { from: '.builtin', to: 'builtin', filter: ['**/*'] }
    ])
    expect(packageMetadata.build.nsis.include).toBeUndefined()
  })

  it('restores a bundled runtime only for the standalone Windows installer', () => {
    expect(packageMetadata.scripts['dist:win']).toContain('npm run prepare:runtime')
    expect(packageMetadata.scripts['dist:win']).not.toContain('npm run prepare:models')
    expect(packageMetadata.build.win.extraResources).toEqual([
      { from: '.runtime', to: 'runtime', filter: ['**/*'] }
    ])
  })

  it('embeds an explicitly selected fork as the release download source', () => {
    const result = spawnSync(
      process.execPath,
      [join(desktopRoot, 'scripts', 'prepare-bootstrap.mjs')],
      {
        cwd: desktopRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HHTOOLS_DESKTOP_RELEASE_REPOSITORY: 'Eleanor1018/human-humanoid-tools'
        }
      }
    )

    expect(result.status).toBe(0)
    expect(readFileSync(join(desktopRoot, '.bootstrap', 'install.sh'), 'utf8')).toContain(
      "embedded_repository='Eleanor1018/human-humanoid-tools'"
    )
  })

  it('migrates only the exact legacy GUI alternative and explains dpkg recovery', () => {
    const beforeInstall = readFileSync(
      join(desktopRoot, 'scripts', 'linux-before-install.sh'),
      'utf8'
    )

    expect(packageMetadata.build.deb.fpm).toContain(
      '--before-install=scripts/linux-before-install.sh'
    )
    expect(beforeInstall).toContain("legacy_gui='/opt/Human-Humanoid Tools/hhtools'")
    expect(beforeInstall).toContain('update-alternatives --remove hhtools "$legacy_gui"')
    expect(beforeInstall).toContain('sudo apt-get -f install')
  })

  it('declares Electron libraries absent from minimal Ubuntu 22.04', () => {
    expect(packageMetadata.build.deb.depends).toEqual(
      expect.arrayContaining([
        'libgbm1',
        'libasound2',
        'ca-certificates',
        'curl',
        'policykit-1'
      ])
    )
  })
})
