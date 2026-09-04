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

    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(sidebar.getByRole('button')).toHaveText([
      'Motion',
      'Robot',
      'Video → Motion',
      'Human → Robot',
      'Robot → Robot',
      'Batch',
      'Data Analysis'
    ])
    await expect(sidebar.locator('.sidebar-icon')).toHaveCount(7)
    expect(
      await sidebar.locator('.sidebar-icon').evaluateAll((icons) =>
        icons.every((icon) => getComputedStyle(icon).maskImage.includes('/icons/sidebar/'))
      )
    ).toBe(true)
    await expect(sidebar.getByRole('button', { name: 'Motion', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )

    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector.getByRole('heading', { name: 'Motion' })).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Library' })).toBeVisible()
    const profilePicker = inspector.getByRole('radiogroup', { name: 'Motion import type' })
    await expect(profilePicker.getByRole('radio')).toHaveText([
      'mimic',
      'intermimic',
      'meshmimic'
    ])
    await expect(
      profilePicker.getByRole('radio', { name: 'mimic', exact: true })
    ).toBeChecked()
    await expect(inspector.getByText('Drop a motion file or folder')).toBeVisible()
    expect((await inspector.boundingBox())?.width).toBeCloseTo(360, 0)
    await profilePicker.getByRole('radio', { name: 'intermimic', exact: true }).click()
    await expect(
      inspector.getByText('Drop an object-interaction motion folder')
    ).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Choose file' })).toHaveCount(0)

    await sidebar.getByRole('button', { name: 'Robot', exact: true }).click()
    await expect(inspector.getByRole('heading', { name: 'Robot', exact: true })).toBeVisible()
    await expect(inspector.getByRole('group', { name: 'URDF import area' })).toBeVisible()
    await expect(inspector.getByRole('group', { name: 'Robot mesh import area' })).toBeVisible()
    await expect(inspector.getByText('No URDF selected.')).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Robot Library' })).toBeVisible()

    await sidebar.getByRole('button', { name: 'Video → Motion' }).click()
    await expect(inspector.getByRole('heading', { name: 'Video → Motion' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Video to Motion pipeline' })).toBeVisible()
    await expect(inspector.locator('details')).toHaveCount(4)
    await expect(inspector.getByRole('group', { name: 'Video import area' })).toBeVisible()

    await sidebar.getByRole('button', { name: 'Human → Robot' }).click()
    await expect(page.locator('#app')).toHaveAttribute('data-active-view', 'h2r')
    await expect(sidebar.getByRole('button', { name: 'Human → Robot' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect(inspector.getByRole('heading', { name: 'Human → Robot' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Human to Robot pipeline' })).toBeVisible()
    await expect(inspector.locator('details')).toHaveCount(4)
    await expect(inspector.getByRole('button', { name: 'Select motion' })).toBeDisabled()
    await expect(inspector.getByRole('heading', { name: 'Motion' })).toHaveCount(0)

    await sidebar.getByRole('button', { name: 'Robot → Robot' }).click()
    await expect(inspector.getByRole('heading', { name: 'Robot → Robot' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Robot to Robot pipeline' })).toBeVisible()
    await expect(inspector.locator('details')).toHaveCount(5)
    await expect(inspector.getByText('No source robot loaded.')).toBeVisible()
    await expect(page.locator('.workspace-drawer-handle, .col-resizer')).toHaveCount(0)

    const stage = page.getByRole('main', { name: 'Workspace content' })
    const stageMenu = stage.locator('[data-slot="toggle-group"][aria-label="Stage visibility"]')
    const stageToggles = stageMenu.locator('[data-slot="toggle-group-item"]')
    await expect(stageMenu).toBeVisible()
    await expect(stageToggles).toHaveText([
      'Skeleton',
      'Body',
      'Objects/Terrain',
      'Scaled',
      'Scaled',
      'Robot'
    ])
    await expect(stageMenu.getByRole('button', { name: 'Body', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(stageMenu.getByRole('button', { name: 'Robot', exact: true })).toBeDisabled()
    await stageMenu.getByRole('button', { name: 'Skeleton', exact: true }).click()
    await expect(stageMenu.getByRole('button', { name: 'Skeleton', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const [stageBounds, menuBounds, menuStyle, bodyStyle, eyeMask] = await Promise.all([
      stage.boundingBox(),
      stageMenu.boundingBox(),
      stageMenu.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          borderRadius: style.borderRadius,
          gap: style.gap,
          padding: style.padding
        }
      }),
      stageMenu.getByRole('button', { name: 'Body', exact: true }).evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          padding: style.padding
        }
      }),
      stageMenu.locator('.stage-layer-eye').first().evaluate(
        (element) => getComputedStyle(element).maskImage
      )
    ])
    expect(menuBounds?.x).toBeCloseTo((stageBounds?.x ?? 0) + 12, 0)
    expect(menuBounds?.y).toBeCloseTo((stageBounds?.y ?? 0) + 12, 0)
    expect(menuBounds?.width).toBeGreaterThan(300)
    expect(menuBounds?.height).toBeGreaterThan(64)
    expect(menuStyle).toEqual({ borderRadius: '8px', gap: '4px', padding: '6px 8px' })
    expect(bodyStyle).toEqual({
      backgroundColor: 'rgb(0, 113, 227)',
      fontSize: '12px',
      padding: '6px 12px'
    })
    expect(eyeMask).toContain('/icons/stage/eye.svg')
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
