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
  const electronApp = await electron.launch({
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
    args: packagedExecutable === undefined ? [join(desktopRoot, 'out', 'main', 'index.js')] : [],
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

    await expect(page).toHaveTitle('hhtools')
    await expect(page.locator('#app')).toBeVisible()
    await expect(page.locator('.nav-item[data-panel]')).toHaveCount(5)
    await expect(page.locator('#stage-empty .big')).toContainText('把动作拖到这里预览')

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
    const toastBounds = await toast.boundingBox()
    const viewport = page.viewportSize()
    expect((toastBounds?.y ?? 0) + (toastBounds?.height ?? 0)).toBeLessThanOrEqual(
      viewport?.height ?? 0
    )
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
