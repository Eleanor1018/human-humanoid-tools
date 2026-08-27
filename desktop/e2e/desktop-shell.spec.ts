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

test('loads the existing WebUI and shuts down its Python sidecar', async ({}, testInfo) => {
  const packagedExecutable = process.env.HHTOOLS_E2E_EXECUTABLE
  const userDataDirectory = testInfo.outputPath('user-data')
  const electronApp = await electron.launch({
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
    args: [
      `--user-data-dir=${userDataDirectory}`,
      ...(packagedExecutable === undefined ? [join(desktopRoot, 'out', 'main', 'index.js')] : []),
    ],
    cwd: desktopRoot,
    env: {
      ...process.env,
      HHTOOLS_REPO_ROOT: repositoryRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })

  let backendPid: number | undefined
  try {
    const page = await electronApp.firstWindow({ timeout: 90_000 })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.evaluate(() => localStorage.setItem('hhtools.web.tutorial.v1.done', '1'))

    await expect(page).toHaveTitle('hhtools')
    await expect(page.locator('#app')).toBeVisible()
    await expect(page.locator('#app')).toHaveClass(/workspace-shell/)
    await expect(page.locator('#app')).toHaveClass(/electron-host/)
    await expect(page.locator('#topbar .desktop-brand-name')).toHaveText('HHTOOLS')
    await expect(page.locator('#topbar .ui-build')).toBeHidden()
    await expect(page.locator('#topbar .command-palette-trigger')).toBeHidden()
    await expect(page.locator('#motion-pill')).toBeHidden()
    await expect(page.locator('#robot-pill')).toBeHidden()
    await expect(page.locator('.desktop-menu-trigger')).toHaveCount(5)
    await expect(page.locator('.nav-item[data-panel]')).toHaveCount(6)
    await expect(page.locator('#stage-empty .big')).toContainText('把动作拖到这里预览')

    const stage = page.locator('#stage')
    const viewMenu = page.locator('#view-hud')
    await expect(viewMenu).toBeVisible()
    await expect(viewMenu.locator('#tg-skeleton .lbl')).toHaveText('Skeleton')
    const stageBounds = await stage.boundingBox()
    const viewMenuBounds = await viewMenu.boundingBox()
    expect(viewMenuBounds?.x).toBeCloseTo((stageBounds?.x ?? 0) + 12, 0)
    expect(viewMenuBounds?.y).toBeCloseTo((stageBounds?.y ?? 0) + 12, 0)

    const topbarLayer = await page.locator('#topbar').evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10)
    )
    const stageToolsLayer = await page.locator('.stage-top-tools').evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10)
    )
    expect(topbarLayer).toBeGreaterThan(stageToolsLayer)

    await page.locator('[data-menu-trigger="file"]').click()
    const fileMenu = page.locator('[data-menu-popup="file"]')
    await expect(fileMenu).toBeVisible()
    const fileMenuBounds = await fileMenu.boundingBox()
    const overlapPoint = {
      x: Math.max(fileMenuBounds?.x ?? 0, viewMenuBounds?.x ?? 0) + 12,
      y: Math.max(fileMenuBounds?.y ?? 0, viewMenuBounds?.y ?? 0) + 12,
    }
    expect(overlapPoint.x).toBeLessThan(Math.min(
      (fileMenuBounds?.x ?? 0) + (fileMenuBounds?.width ?? 0),
      (viewMenuBounds?.x ?? 0) + (viewMenuBounds?.width ?? 0),
    ))
    expect(overlapPoint.y).toBeLessThan(Math.min(
      (fileMenuBounds?.y ?? 0) + (fileMenuBounds?.height ?? 0),
      (viewMenuBounds?.y ?? 0) + (viewMenuBounds?.height ?? 0),
    ))
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-menu-popup="file"]') !== null,
    overlapPoint)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('desktop-file-menu.png'), fullPage: true })
    await page.keyboard.press('Escape')

    const jobPanel = page.locator('.docked-job-panel')
    await expect(jobPanel.locator('.job-summary-title')).toHaveText('Tasks')
    const collapsedJobBounds = await jobPanel.boundingBox()
    const collapsedStageBounds = await stage.boundingBox()
    expect(collapsedJobBounds?.height).toBeCloseTo(34, 0)
    expect((collapsedJobBounds?.y ?? 0) + (collapsedJobBounds?.height ?? 0))
      .toBeCloseTo(await page.evaluate(() => window.innerHeight), 0)

    await page.locator('.job-drawer-summary').click()
    await expect(jobPanel).toHaveClass(/open/)
    await expect(page.locator('.job-panel-resizer')).toBeVisible()
    await expect(jobPanel.getByText('Import Config', { exact: true })).toHaveCount(0)
    const expandedJobBounds = await jobPanel.boundingBox()
    const reducedStageBounds = await stage.boundingBox()
    expect(expandedJobBounds?.height).toBeGreaterThanOrEqual(180)
    expect(reducedStageBounds?.height).toBeLessThan((collapsedStageBounds?.height ?? 0) - 100)
    await page.screenshot({ path: testInfo.outputPath('desktop-tasks-expanded.png'), fullPage: true })

    await page.keyboard.press('Control+J')
    await expect(jobPanel).not.toHaveClass(/open/)

    const expandedSidebar = await page.locator('#sidebar').boundingBox()
    const expandedInspector = await page.locator('#inspector').boundingBox()
    expect(expandedSidebar?.width).toBeCloseTo(208, 0)
    expect(expandedInspector?.width).toBeCloseTo(360, 0)

    await page.locator('#hide-sidebar').click()
    const collapsedSidebar = await page.locator('#sidebar').boundingBox()
    expect(collapsedSidebar?.width).toBeCloseTo(52, 0)
    await expect(page.locator('#sidebar .nav-item-label').first()).toBeHidden()
    await page.locator('#hide-sidebar').click()

    await page.locator('#hide-inspector').click()
    await expect(page.locator('#inspector')).toBeHidden()
    await page.locator('#show-inspector').click()
    await expect(page.locator('#inspector')).toBeVisible()

    await page.locator('[data-menu-trigger="analysis"]').click()
    const pae = page.locator('.desktop-menu-item', { hasText: 'PAE Analysis' })
    await expect(pae).toBeDisabled()
    await expect(pae).toContainText('Coming soon')
    await page.screenshot({ path: testInfo.outputPath('desktop-analysis-menu.png'), fullPage: true })
    await page.keyboard.press('Escape')

    await page.locator('[data-menu-trigger="settings"]').click()
    await page.locator('.desktop-menu-item', { hasText: 'Settings' }).click()
    const settings = page.locator('.workspace-settings-dialog')
    await expect(settings).toBeVisible()
    await expect(settings.locator('.workspace-setting-row')).toHaveCount(3)
    await expect(settings.locator('.workspace-language-select')).toHaveValue('en')
    await settings.locator('.workspace-language-select').selectOption('zh-CN')
    await expect(page.locator('#sidebar .side-panel-title')).toHaveText('导航')
    await settings.locator('.workspace-language-select').selectOption('en')
    await expect(page.locator('#sidebar .side-panel-title')).toHaveText('Navigation')
    await page.screenshot({ path: testInfo.outputPath('desktop-settings.png'), fullPage: true })
    await settings.locator('.workspace-settings-reset').click()
    await settings.locator('.workspace-settings-done').click()
    await expect(settings).toBeHidden()

    await page.locator('[data-menu-trigger="settings"]').click()
    await page.locator('.desktop-menu-item', { hasText: 'Dark Mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.locator('[data-menu-trigger="settings"]').click()
    await page.locator('.desktop-menu-item', { hasText: 'Light Mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    const canvasBounds = await page.locator('#three-canvas').boundingBox()
    expect(canvasBounds?.width).toBeGreaterThan(400)
    expect(canvasBounds?.height).toBeGreaterThan(300)

    const toast = page.locator('#toast')
    await expect(toast).toBeHidden()
    await toast.evaluate((element) => {
      element.textContent = 'Layout check'
      element.classList.add('show')
    })
    await expect(toast).toBeVisible()
    // Electron pages do not expose Playwright's emulated viewport size.
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    await expect.poll(async () => {
      const bounds = await toast.boundingBox()
      return (bounds?.y ?? 0) + (bounds?.height ?? 0)
    }).toBeLessThanOrEqual(viewportHeight)
    await toast.evaluate((element) => element.classList.remove('show'))
    await expect(toast).toBeHidden()

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
    await page.screenshot({ path: testInfo.outputPath('desktop-home.png'), fullPage: true })
  } finally {
    await electronApp.close()
  }

  if (backendPid !== undefined) {
    await expect.poll(() => processIsAlive(backendPid as number), { timeout: 10_000 }).toBe(false)
  }
})
