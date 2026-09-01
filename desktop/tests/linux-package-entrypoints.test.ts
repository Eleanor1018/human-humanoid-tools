import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  desktopName: string
  build: {
    productName: string
    linux: { executableName: string }
    deb: { fpm: string[]; afterInstall?: string; afterRemove?: string }
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

    // The CLI is a real dpkg-owned file. The GUI keeps electron-builder's
    // default post-install/remove hooks, including sandbox and AppArmor setup.
    expect(packageMetadata.build.deb.fpm).toContain(
      '.runtime/cli/hhtools=/usr/bin/hhtools'
    )
    expect(packageMetadata.build.deb.afterInstall).toBeUndefined()
    expect(packageMetadata.build.deb.afterRemove).toBeUndefined()
  })

  it('launches the bundled Python CLI without changing the caller environment', () => {
    const launcher = readFileSync(
      join(desktopRoot, 'scripts', 'hhtools-cli-launcher.sh'),
      'utf8'
    )

    expect(launcher).toContain(
      `runtime_root='/opt/${packageMetadata.build.productName}/resources/runtime'`
    )
    expect(launcher).toContain('export PYTHONPATH="$application_root"')
    expect(launcher).toContain('unset PYTHONHOME VIRTUAL_ENV')
    expect(launcher).toContain(
      `'from hhtools.cli.main import app; app(prog_name="hhtools")' "$@"`
    )
    expect(launcher).not.toMatch(/\n\s*cd\s/)
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
