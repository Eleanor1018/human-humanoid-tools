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
    deb: { fpm: string[]; afterInstall?: string; afterRemove?: string }
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

  it('packages only the staged neutral model instead of a Python runtime', () => {
    expect(packageMetadata.scripts['dist:linux']).toContain('npm run prepare:models')
    expect(packageMetadata.scripts['dist:linux']).not.toContain('prepare:runtime')
    expect(packageMetadata.build.extraResources).toEqual([
      { from: '.models', to: 'body_models', filter: ['**/*'] }
    ])
    expect(packageMetadata.build.nsis.include).toBeUndefined()
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
})
