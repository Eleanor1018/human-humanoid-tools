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
      HHTOOLS_WEB_SETTINGS_PATH: testInfo.outputPath('web-settings.json'),
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

    await expect(page.locator('.side-panel-head')).toHaveCount(0)
    await expect(page.locator('.nav-group-label')).toHaveCount(0)
    const motionPanel = page.locator('#inspector-body .panel.active')
    await expect(motionPanel.locator('h2')).toHaveText('动作 Motion')
    await expect(motionPanel.locator(':scope > .lead')).toHaveCount(0)
    await expect(motionPanel.locator('#motion-assets-hint')).toHaveCount(0)
    await expect(motionPanel.locator('.motion-import-card')).toHaveCount(3)
    await expect(motionPanel.locator('.motion-import-card .dz-title')).toHaveText([
      'intermimic',
      'meshmimic',
      'mimic',
    ])

    const motionInfoTriggers = motionPanel.locator('.motion-import-info-trigger')
    const intermimicInfo = motionPanel.locator('#motion-info-intermimic')
    await expect(motionInfoTriggers).toHaveCount(3)
    await expect(intermimicInfo).toBeHidden()
    await motionInfoTriggers.first().click()
    await expect(motionInfoTriggers.first()).toHaveAttribute('aria-expanded', 'true')
    await expect(intermimicInfo).toBeVisible()
    await expect(intermimicInfo).toContainText('<clip>/<clip>.pkl')
    await page.screenshot({ path: testInfo.outputPath('desktop-motion-upload-info.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(intermimicInfo).toBeHidden()

    // The native file dialog filters individual motion files, while directory
    // pickers stay unfiltered so required object and terrain sidecars survive.
    const motionFileChooserPromise = page.waitForEvent('filechooser')
    await motionPanel.locator('[data-pick="mimic"]:not([data-folder])').click()
    const motionFileChooser = await motionFileChooserPromise
    expect(await motionFileChooser.element().getAttribute('accept'))
      .toBe('.bvh,.glb,.gltf,.npz,.npy,.pkl,.pt')
    await motionFileChooser.setFiles({
      name: 'not-a-motion.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('unsupported motion content'),
    })
    await expect(page.locator('#toast.err')).toContainText('未找到可识别的动作文件（mimic）')
    await expect(page.locator('#toast.err')).not.toContainText('"detail"')

    const intermimicFolderChooserPromise = page.waitForEvent('filechooser')
    await motionPanel.locator('[data-pick="intermimic"][data-folder="1"]').click()
    const intermimicFolderChooser = await intermimicFolderChooserPromise
    expect(await intermimicFolderChooser.element().evaluate((element) => {
      const input = element as HTMLInputElement
      return { accept: input.accept, directory: input.webkitdirectory }
    })).toEqual({ accept: '', directory: true })
    await intermimicFolderChooser.element().evaluate((element) => {
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const leftDrawerHandle = page.locator('#toggle-sidebar')
    const rightDrawerHandle = page.locator('#toggle-inspector')
    await expect(leftDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-left')
    await expect(leftDrawerHandle).toHaveAttribute('aria-expanded', 'true')
    await expect(rightDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-right')
    await expect(rightDrawerHandle).toHaveAttribute('aria-expanded', 'true')

    const [topbarBounds, leftHandleBounds, rightHandleBounds, viewport] = await Promise.all([
      page.locator('#topbar').boundingBox(),
      leftDrawerHandle.boundingBox(),
      rightDrawerHandle.boundingBox(),
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    ])
    expect(leftHandleBounds?.x).toBeCloseTo(
      (expandedSidebar?.x ?? 0) + (expandedSidebar?.width ?? 0),
      0,
    )
    expect((rightHandleBounds?.x ?? 0) + (rightHandleBounds?.width ?? 0)).toBeCloseTo(
      expandedInspector?.x ?? 0,
      0,
    )
    expect(leftHandleBounds?.height).toBeCloseTo(116, 0)
    expect(rightHandleBounds?.height).toBeCloseTo(116, 0)
    const drawerCenterY = ((topbarBounds?.y ?? 0) + (topbarBounds?.height ?? 0) + viewport.height) / 2
    expect((leftHandleBounds?.y ?? 0) + (leftHandleBounds?.height ?? 0) / 2).toBeCloseTo(drawerCenterY, 0)
    expect((rightHandleBounds?.y ?? 0) + (rightHandleBounds?.height ?? 0) / 2).toBeCloseTo(drawerCenterY, 0)

    const handleStyleBeforeHover = await leftDrawerHandle.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderTopWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        color: style.color,
        cursor: style.cursor,
      }
    })
    expect(handleStyleBeforeHover).toMatchObject({
      borderRadius: '0px',
      borderTopWidth: '0px',
      boxShadow: 'none',
      cursor: 'pointer',
    })
    await leftDrawerHandle.hover()
    const handleStyleAfterHover = await leftDrawerHandle.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        color: style.color,
      }
    })
    expect(handleStyleAfterHover).toEqual({
      backgroundColor: handleStyleBeforeHover.backgroundColor,
      boxShadow: handleStyleBeforeHover.boxShadow,
      color: handleStyleBeforeHover.color,
    })

    // The panel and its edge handle must track a resize without drawer-animation lag.
    const sidebarResizer = page.locator('#resize-sidebar')
    const sidebarResizerBounds = await sidebarResizer.boundingBox()
    await page.mouse.move(
      (sidebarResizerBounds?.x ?? 0) + (sidebarResizerBounds?.width ?? 0) / 2,
      (sidebarResizerBounds?.y ?? 0) + 80,
    )
    await page.mouse.down()
    await page.mouse.move((sidebarResizerBounds?.x ?? 0) + 20, (sidebarResizerBounds?.y ?? 0) + 80)
    await expect.poll(async () => (await page.locator('#sidebar').boundingBox())?.width ?? 0).toBeGreaterThan(220)
    await expect.poll(async () => (await leftDrawerHandle.boundingBox())?.x ?? 0).toBeGreaterThan(220)
    await page.mouse.move((sidebarResizerBounds?.x ?? 0) + (sidebarResizerBounds?.width ?? 0) / 2, (sidebarResizerBounds?.y ?? 0) + 80)
    await page.mouse.up()
    await expect.poll(async () => (await page.locator('#sidebar').boundingBox())?.width ?? 0).toBeCloseTo(208, 0)

    const stageBeforeLeftCollapse = await stage.boundingBox()
    await leftDrawerHandle.click()
    await expect(leftDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-right')
    await expect(leftDrawerHandle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden', 'true')
    await expect.poll(async () => (await page.locator('#sidebar').boundingBox())?.width ?? 0).toBeCloseTo(0, 0)
    const [stageWithoutSidebar, collapsedLeftHandle] = await Promise.all([
      stage.boundingBox(),
      leftDrawerHandle.boundingBox(),
    ])
    expect(stageWithoutSidebar?.width).toBeGreaterThan((stageBeforeLeftCollapse?.width ?? 0) + 200)
    expect(collapsedLeftHandle?.x).toBeGreaterThanOrEqual(0)
    expect((collapsedLeftHandle?.x ?? 0) + (collapsedLeftHandle?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath('desktop-left-drawer-collapsed.png'), fullPage: true })
    await leftDrawerHandle.click()
    await expect(leftDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-left')
    await expect.poll(async () => (await page.locator('#sidebar').boundingBox())?.width ?? 0).toBeCloseTo(208, 0)

    const stageBeforeRightCollapse = await stage.boundingBox()
    await rightDrawerHandle.click()
    await expect(rightDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-left')
    await expect(rightDrawerHandle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#inspector')).toHaveAttribute('aria-hidden', 'true')
    await expect.poll(async () => (await page.locator('#inspector').boundingBox())?.width ?? 0).toBeCloseTo(0, 0)
    const [stageWithoutInspector, collapsedRightHandle] = await Promise.all([
      stage.boundingBox(),
      rightDrawerHandle.boundingBox(),
    ])
    expect(stageWithoutInspector?.width).toBeGreaterThan((stageBeforeRightCollapse?.width ?? 0) + 340)
    expect(collapsedRightHandle?.x).toBeGreaterThanOrEqual(0)
    expect((collapsedRightHandle?.x ?? 0) + (collapsedRightHandle?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath('desktop-right-drawer-collapsed.png'), fullPage: true })
    await rightDrawerHandle.click()
    await expect(rightDrawerHandle.locator('svg')).toHaveAttribute('data-icon', 'chevron-right')
    await expect.poll(async () => (await page.locator('#inspector').boundingBox())?.width ?? 0).toBeCloseTo(360, 0)
    await page.screenshot({ path: testInfo.outputPath('desktop-drawers.png'), fullPage: true })

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
    await expect(settings.locator('.workspace-setting-row')).toHaveCount(5)
    await expect(settings.locator('.workspace-language-select')).toHaveValue('en')
    const stateBeforeSettingsSave = await page.evaluate(() =>
      (window.hhtoolsDesktop as HHToolsDesktopApi).getRuntimeState()
    )
    await expect(settings.locator('.workspace-max-running-jobs')).toBeEnabled()
    await settings.locator('.workspace-max-running-jobs').fill('2')
    await settings.locator('.workspace-max-queued-jobs').fill('32')
    await settings.locator('.workspace-settings-save').click()
    await expect(settings.getByText('Saved and applied immediately. No restart is required.')).toBeVisible()
    const appliedSettings = await page.evaluate(async () => {
      const [runtimeState, response] = await Promise.all([
        (window.hhtoolsDesktop as HHToolsDesktopApi).getRuntimeState(),
        fetch('/api/settings/job-admission'),
      ])
      return { runtimeState, scheduler: await response.json() }
    })
    expect(appliedSettings.runtimeState.backendPid).toBe(stateBeforeSettingsSave.backendPid)
    expect(appliedSettings.scheduler).toMatchObject({
      max_running_jobs: 2,
      max_queued_jobs: 32,
    })
    await settings.locator('.workspace-language-select').selectOption('zh-CN')
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-label', '导航')
    await expect(page.locator('#inspector')).toHaveAttribute('aria-label', '控制面板')
    await expect(page.locator('#sidebar .nav-item-label').first()).toHaveText('动作')
    await settings.locator('.workspace-language-select').selectOption('en')
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-label', 'Navigation')
    await expect(page.locator('#inspector')).toHaveAttribute('aria-label', 'Inspector')
    await expect(page.locator('#sidebar .nav-item-label').first()).toHaveText('Motion')
    await page.screenshot({ path: testInfo.outputPath('desktop-settings.png'), fullPage: true })
    await settings.locator('.workspace-settings-reset').click()
    await settings.locator('.workspace-settings-done').click()
    await expect(settings).toBeHidden()

    await page.locator('[data-menu-trigger="settings"]').click()
    await page.locator('.desktop-menu-item', { hasText: 'Settings' }).click()
    await expect(settings.locator('.workspace-max-running-jobs')).toHaveValue('2')
    await expect(settings.locator('.workspace-max-queued-jobs')).toHaveValue('32')
    await settings.locator('.workspace-settings-done').click()

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
