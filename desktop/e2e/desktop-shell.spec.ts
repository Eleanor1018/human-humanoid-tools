import { _electron as electron, expect, test } from '@playwright/test'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HHToolsDesktopApi } from '../src/shared/desktop-api'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = resolve(desktopRoot, '..')

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('starts the shared renderer and stops its Python sidecar', async ({}, testInfo) => {
  const packagedExecutable = process.env.HHTOOLS_E2E_EXECUTABLE
  const electronApp = await electron.launch({
    ...(packagedExecutable === undefined
      ? {}
      : { executablePath: packagedExecutable }),
    args: [
      `--user-data-dir=${testInfo.outputPath('user-data')}`,
      ...(packagedExecutable === undefined
        ? [join(desktopRoot, 'out', 'main', 'index.js')]
        : [])
    ],
    cwd: desktopRoot,
    env: {
      ...process.env,
      HHTOOLS_REPO_ROOT: repositoryRoot,
      HHTOOLS_WEB_SETTINGS_PATH: testInfo.outputPath('web-settings.json'),
      HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH: testInfo.outputPath(
        'motion-library-settings.json'
      ),
      XDG_CONFIG_HOME: testInfo.outputPath('config'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })

  let backendPid: number | undefined
  try {
    await expect
      .poll(
        () =>
          electronApp
            .windows()
            .some((window) => !window.url().startsWith('data:')),
        { timeout: 90_000 }
      )
      .toBe(true)
    const page = electronApp
      .windows()
      .find((window) => !window.url().startsWith('data:'))
    if (!page) throw new Error('Desktop main window did not open')
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await expect(page).toHaveTitle('Human-Humanoid Tools')
    await expect(page.locator("#app[data-hhtools-ready='true']")).toBeVisible()
    await expect(page.getByLabel('HHTOOLS')).toBeVisible()
    const menu = page.getByRole('navigation', { name: 'Application menu' })
    await expect(menu.getByRole('button')).toHaveText([
      'File',
      'Workflows',
      'Analysis',
      'Settings',
      'Help'
    ])
    const workflowsMenu = page.getByRole('menu', { name: 'Workflows' })
    await menu.getByRole('button', { name: 'Workflows', exact: true }).hover()
    await expect(workflowsMenu).toBeVisible()
    await expect(workflowsMenu.getByRole('menuitem')).toHaveText([
      'Video to MotionAlt+7',
      'Human to RobotAlt+3',
      'Robot to RobotAlt+4',
      'BatchAlt+5'
    ])
    await menu.getByRole('button', { name: 'Analysis', exact: true }).hover()
    await expect(workflowsMenu).toBeHidden()
    await expect(page.getByRole('menu', { name: 'Analysis' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Analysis' })).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.hhtoolsDesktop as HHToolsDesktopApi).getRuntimeState()
        )
      )
      .toMatchObject({ appPhase: 'after-window-open', backendState: 'ready' })

    const state = await page.evaluate(() =>
      (window.hhtoolsDesktop as HHToolsDesktopApi).getRuntimeState()
    )
    backendPid = state.backendPid
    expect(typeof backendPid).toBe('number')
    expect(pageErrors).toEqual([])
  } finally {
    await electronApp.close()
  }

  if (backendPid !== undefined) {
    await expect
      .poll(() => processIsAlive(backendPid as number), { timeout: 10_000 })
      .toBe(false)
  }
})
