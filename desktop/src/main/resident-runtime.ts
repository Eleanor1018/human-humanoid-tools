/** Connect to a service whose lifetime is independent of the desktop window. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RuntimeConfig } from './runtime-resolver'

const execute = promisify(execFile)

export function validateRuntimeEndpoint(value: string): string {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a Runtime HTTP(S) origin; remote connections require HTTPS.')
  }
  return url.origin
}

export async function connectResidentRuntime(options: {
  runtime?: RuntimeConfig
  endpoint?: string
  token?: string
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  let endpoint = options.endpoint
  if (endpoint === undefined) {
    const runtime = options.runtime
    if (runtime === undefined) throw new Error('A local runtime installation is required.')
    const result = await execute(runtime.pythonExecutable, [
      '-m', 'hhtools.cli.main', 'runtime', 'start', '--workspace', runtime.saveDirectory,
      '--source', runtime.sourceRoot,
    ], { cwd: runtime.workingDirectory, env: options.env, timeout: 60_000, maxBuffer: 1024 * 1024 })
    const receipt: unknown = JSON.parse(result.stdout)
    if (typeof receipt !== 'object' || receipt === null || !('endpoint' in receipt) || typeof receipt.endpoint !== 'string') {
      throw new Error('The Runtime launcher returned an invalid connection receipt.')
    }
    endpoint = receipt.endpoint
  }
  const origin = validateRuntimeEndpoint(endpoint)
  const response = await fetch(`${origin}/api/runtime/v1/identity`, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Runtime handshake failed (HTTP ${response.status}).`)
  const identity = await response.json() as { persistent?: boolean; runtime_id?: string; workspace_id?: string }
  if (!identity.persistent || !identity.runtime_id || !identity.workspace_id) throw new Error('The endpoint is not a resident HHTools Runtime.')
  return origin
}
