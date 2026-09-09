import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(desktopRoot, '..')
const outputRoot = resolve(desktopRoot, '.bootstrap')
const source = join(repositoryRoot, 'install.sh')
const destination = join(outputRoot, 'install.sh')

if (dirname(outputRoot) !== desktopRoot || !outputRoot.endsWith(`${sep}.bootstrap`)) {
  throw new Error(`refusing to replace unexpected bootstrap path: ${outputRoot}`)
}
if (!existsSync(source)) throw new Error(`release installer is missing: ${source}`)

const packageJson = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
const repositoryUrl = String(packageJson.repository?.url ?? '')
const repositoryMatch = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
if (!repositoryMatch) throw new Error(`unsupported desktop repository URL: ${repositoryUrl}`)
const repository = repositoryMatch[1]
const version = String(process.env.HHTOOLS_DESKTOP_RELEASE_VERSION ?? packageJson.version)
if (!/^[0-9A-Za-z._+-]+$/.test(version)) throw new Error(`invalid desktop version: ${version}`)

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
cpSync(source, destination)
const template = readFileSync(destination, 'utf8')
for (const field of ['embedded_repository', 'embedded_version']) {
  if (!new RegExp(`^${field}=.*$`, 'm').test(template)) {
    throw new Error(`release installer has no ${field} field`)
  }
}
const embedded = template
  .replace(/^embedded_repository=.*$/m, `embedded_repository='${repository}'`)
  .replace(/^embedded_version=.*$/m, `embedded_version='${version}'`)
writeFileSync(destination, embedded, 'utf8')
chmodSync(destination, 0o755)
console.log(`[prepare-bootstrap] ${repository}@${version} -> ${destination}`)
