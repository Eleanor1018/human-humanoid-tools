import { _electron as electron, expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

test('closing the resident desktop preserves its Runtime', async ({}, testInfo) => {
  const desktopRoot = resolve(import.meta.dirname, '..')
  const repositoryRoot = resolve(desktopRoot, '..')
  const workspace = testInfo.outputPath('workspace')
  const application = await electron.launch({
    args: [`--user-data-dir=${testInfo.outputPath('user-data')}`, '--lang=en-US',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', join(desktopRoot, 'out/main/index.js')],
    cwd: desktopRoot,
    env: { ...process.env, HHTOOLS_LEGACY_SIDECAR: '0', HHTOOLS_REPO_ROOT: repositoryRoot,
      HHTOOLS_SAVE_DIR: workspace, XDG_CONFIG_HOME: testInfo.outputPath('config'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  let endpoint: string | undefined
  let closed = false
  try {
    await expect.poll(() => application.windows().some(page => page.url().startsWith('http')), { timeout: 90_000 }).toBe(true)
    const page = application.windows().find(page => page.url().startsWith('http'))!
    await expect(page.getByText('HHTools Runtime', { exact: true })).toBeVisible()
    endpoint = new URL(page.url()).origin
    const before = await (await fetch(`${endpoint}/api/runtime/v1/identity`)).json() as { runtime_id: string }
    await application.close()
    closed = true
    const after = await (await fetch(`${endpoint}/api/runtime/v1/identity`)).json() as { runtime_id: string }
    expect(after.runtime_id).toBe(before.runtime_id)
  } finally {
    if (!closed) await application.close()
    if (!endpoint) {
      try { endpoint = (JSON.parse(await readFile(join(workspace, '.hhtools-agent/runtime-connection.json'), 'utf8')) as { endpoint: string }).endpoint } catch {}
    }
    if (endpoint) await fetch(`${endpoint}/api/runtime/v1/admin/shutdown`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'cancel' }),
    }).catch(() => undefined)
  }
})
