import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(desktopRoot, '..')
const runtimeRoot = resolve(desktopRoot, '.runtime')
const runtimePython = join(runtimeRoot, 'python')
const runtimeApplication = join(runtimeRoot, 'app')

function fail(message) {
  throw new Error(`[prepare-runtime] ${message}`)
}

function assertSafeRuntimeTarget() {
  if (dirname(runtimeRoot) !== desktopRoot || !runtimeRoot.endsWith(`${sep}.runtime`)) {
    fail(`refusing to replace unexpected staging path: ${runtimeRoot}`)
  }
}

function resolvePythonHome() {
  const override = process.env.HHTOOLS_RUNTIME_PYTHON_HOME
  if (override) return realpathSync(resolve(override))

  const configuration = join(repositoryRoot, '.venv', 'pyvenv.cfg')
  if (!existsSync(configuration)) {
    fail(`missing ${configuration}; run uv sync before packaging`)
  }
  const match = readFileSync(configuration, 'utf8').match(/^home\s*=\s*(.+)$/m)
  if (!match) fail(`unable to read the base Python path from ${configuration}`)
  // uv exposes the unversioned interpreter directory as a Windows junction.
  // Dereference it here so packaging works without Developer Mode/admin rights.
  return realpathSync(resolve(match[1].trim()))
}

function shouldCopyPythonBase(sourceRoot, sourcePath) {
  const path = relative(sourceRoot, sourcePath).replaceAll('\\', '/')
  if (!path) return true
  if (path === 'Lib/site-packages' || path.startsWith('Lib/site-packages/')) return false
  return !path.split('/').includes('__pycache__') && !path.endsWith('.pyc')
}

const developmentPackagePrefixes = [
  '__editable__.hhtools-',
  '__editable___hhtools_',
  '_pytest',
  'a1_coverage.pth',
  'coverage',
  'mypy',
  'mypyc',
  'pytest',
  'pytest_cov',
  'ruff',
]

function shouldCopySitePackage(sourceRoot, sourcePath) {
  const path = relative(sourceRoot, sourcePath).replaceAll('\\', '/')
  if (!path) return true
  const [topLevel] = path.split('/')
  if (developmentPackagePrefixes.some((prefix) => topLevel.startsWith(prefix))) return false
  if (topLevel === '_virtualenv.pth' || topLevel === '_virtualenv.py') return false
  return !path.split('/').includes('__pycache__') && !path.endsWith('.pyc')
}

function shouldCopyApplication(sourcePath) {
  const path = relative(repositoryRoot, sourcePath).replaceAll('\\', '/')
  if (!path) return true
  const segments = path.split('/')
  if (segments.includes('__pycache__') || segments.includes('node_modules')) return false
  if (segments.includes('.git') || segments.includes('.venv')) return false
  if (path.endsWith('.pyc') || path.endsWith('.pyo') || path.endsWith('.map')) return false
  if (/\/(SMPL|SMPLH|SMPLX)_[^/]+\.(npz|pkl)$/i.test(`/${path}`)) return false
  return true
}

function copyDirectory(source, destination, filter) {
  if (!existsSync(source)) fail(`required directory is missing: ${source}`)
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (candidate) => filter(source, candidate),
  })
}

function copyApplicationDirectory(name) {
  const source = join(repositoryRoot, name)
  const destination = join(runtimeApplication, name)
  copyDirectory(source, destination, (_root, candidate) => shouldCopyApplication(candidate))
}

function copyTrackedMotionAssets() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'assets/motions'],
    { cwd: repositoryRoot, encoding: 'buffer' },
  )
  const files = output.toString('utf8').split('\0').filter(Boolean)
  for (const file of files) {
    const source = join(repositoryRoot, file)
    if (!existsSync(source) || !statSync(source).isFile()) continue
    const destination = join(runtimeApplication, file)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { force: true })
  }
  return files.length
}

function copyBundledRobots() {
  const configured = process.env.HHTOOLS_BUNDLED_ROBOT_DIR
  const source = configured
    ? resolve(configured)
    : join(process.env.USERPROFILE ?? '', '.config', 'hhtools', 'robots')
  if (!source || !existsSync(source)) return { source: null, count: 0 }

  const destination = join(runtimeApplication, 'configs', 'robots')
  mkdirSync(destination, { recursive: true })
  let count = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const robotSource = join(source, entry.name)
    const robotDestination = join(destination, entry.name)
    cpSync(robotSource, robotDestination, {
      recursive: true,
      force: true,
      filter: (candidate) => shouldCopyApplication(candidate),
    })
    count += 1
  }
  return { source, count }
}

function treeSummary(root) {
  let files = 0
  let bytes = 0
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
      }
    }
  }
  return { files, bytes }
}

assertSafeRuntimeTarget()
rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(runtimeApplication, { recursive: true })

const pythonHome = resolvePythonHome()
const sitePackages = resolve(
  process.env.HHTOOLS_RUNTIME_SITE_PACKAGES
    ?? join(repositoryRoot, '.venv', 'Lib', 'site-packages'),
)

console.log(`[prepare-runtime] Python: ${pythonHome}`)
copyDirectory(pythonHome, runtimePython, shouldCopyPythonBase)
copyDirectory(
  sitePackages,
  join(runtimePython, 'Lib', 'site-packages'),
  shouldCopySitePackage,
)

for (const directory of ['hhtools', 'configs', 'assets/reference_poses', 'docker/gvhmr']) {
  copyApplicationDirectory(directory)
}
for (const file of ['LICENSE', 'README.md', 'pyproject.toml']) {
  cpSync(join(repositoryRoot, file), join(runtimeApplication, file), { force: true })
}

const motionFileCount = copyTrackedMotionAssets()
const robots = copyBundledRobots()

const pythonExecutable = join(runtimePython, 'python.exe')
const verification = spawnSync(
  pythonExecutable,
  [
    '-c',
    [
      'import fastapi, hhtools, mujoco, newton, torch, warp',
      'from hhtools.web.server import create_app',
      "print('runtime-ok', torch.__version__, mujoco.__version__)",
    ].join('; '),
  ],
  {
    cwd: runtimeApplication,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: runtimeApplication,
      PYTHONUTF8: '1',
    },
  },
)
if (verification.status !== 0) {
  fail(`bundled Python import check failed:\n${verification.stdout}\n${verification.stderr}`)
}

const summary = treeSummary(runtimeRoot)
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  pythonHome,
  sitePackages,
  motionFileCount,
  bundledRobotSource: robots.source,
  bundledRobotCount: robots.count,
  files: summary.files,
  bytes: summary.bytes,
}
writeFileSync(
  join(runtimeRoot, 'runtime-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log(verification.stdout.trim())
console.log(
  `[prepare-runtime] Ready: ${summary.files.toLocaleString()} files, `
    + `${(summary.bytes / 1024 / 1024).toFixed(1)} MiB, ${robots.count} bundled robots, `
    + `${motionFileCount} tracked motion files.`,
)
