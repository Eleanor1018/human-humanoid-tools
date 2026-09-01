import { spawnSync } from 'node:child_process'
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertPathInside,
  assertRobotDestinationAvailable,
  listApplicationSourceFiles,
  resolveBundledRobotDirectory,
} from './runtime-staging-policy.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(desktopRoot, '..')
const runtimeRoot = resolve(desktopRoot, '.runtime')
const runtimePython = join(runtimeRoot, 'python')
const runtimeApplication = join(runtimeRoot, 'app')
const runtimeCli = join(runtimeRoot, 'cli')

function fail(message) {
  throw new Error(`[prepare-runtime] ${message}`)
}

function assertSafeRuntimeTarget() {
  if (dirname(runtimeRoot) !== desktopRoot || !runtimeRoot.endsWith(`${sep}.runtime`)) {
    fail(`refusing to replace unexpected staging path: ${runtimeRoot}`)
  }
}

function readVirtualEnvironmentConfiguration() {
  const path = join(repositoryRoot, '.venv', 'pyvenv.cfg')
  if (!existsSync(path)) {
    fail(`missing ${path}; run uv sync before packaging`)
  }

  const values = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1].toLowerCase()] = match[2]
  }
  return { path, values }
}

function existingRealPath(candidate, description) {
  const resolved = resolve(candidate)
  if (!existsSync(resolved)) fail(`${description} is missing: ${resolved}`)
  return realpathSync(resolved)
}

function normalizePythonHome(candidate) {
  const resolved = existingRealPath(candidate, 'Python home')
  // POSIX pyvenv.cfg files normally record the interpreter's bin directory as `home`.
  // The relocatable runtime needs the installation root containing both bin/ and lib/.
  return process.platform !== 'win32' && basename(resolved) === 'bin'
    ? realpathSync(dirname(resolved))
    : resolved
}

function assertPortablePythonHome(pythonHome) {
  if (pythonHome === parse(pythonHome).root) {
    fail(`refusing to stage a filesystem root as Python home: ${pythonHome}`)
  }
  if (process.platform !== 'win32' && ['/usr', '/usr/local'].includes(pythonHome)) {
    fail(
      `refusing to copy the system Python tree (${pythonHome}); `
        + 'run `uv python install 3.12` and recreate .venv with that managed interpreter',
    )
  }
}

function resolvePythonHome(configuration) {
  const override = process.env.HHTOOLS_RUNTIME_PYTHON_HOME
  if (override) {
    const pythonHome = normalizePythonHome(override)
    assertPortablePythonHome(pythonHome)
    return pythonHome
  }

  if (process.platform !== 'win32') {
    const configuredExecutable = configuration.values.executable
    if (configuredExecutable && existsSync(resolve(configuredExecutable))) {
      const pythonHome = normalizePythonHome(dirname(resolve(configuredExecutable)))
      assertPortablePythonHome(pythonHome)
      return pythonHome
    }

    const virtualEnvironmentPython = join(repositoryRoot, '.venv', 'bin', 'python')
    if (existsSync(virtualEnvironmentPython)) {
      const pythonHome = normalizePythonHome(dirname(realpathSync(virtualEnvironmentPython)))
      assertPortablePythonHome(pythonHome)
      return pythonHome
    }
  }

  const configuredHome = configuration.values.home
  if (!configuredHome) fail(`unable to read the base Python path from ${configuration.path}`)
  // uv exposes the unversioned interpreter directory as a Windows junction.
  // Dereference it here so packaging works without Developer Mode/admin rights.
  const pythonHome = normalizePythonHome(configuredHome)
  assertPortablePythonHome(pythonHome)
  return pythonHome
}

function shouldCopyPythonBase(sourceRoot, sourcePath) {
  const path = relative(sourceRoot, sourcePath).replaceAll('\\', '/')
  if (!path) return true
  if (/^Lib\/site-packages(?:\/|$)/i.test(path)) return false
  if (/^lib(?:64)?\/python[^/]+\/site-packages(?:\/|$)/i.test(path)) return false
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
    // uv's POSIX distributions use relative links such as bin/python3 -> python3.12.
    // Rewriting those links against the build host would make an installed runtime non-portable.
    verbatimSymlinks: process.platform !== 'win32',
  })
}

function assertRelocatableSymlinks(root) {
  const canonicalRoot = realpathSync(root)
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isSymbolicLink()) continue

      const target = readlinkSync(path)
      if (isAbsolute(target)) {
        fail(`packaged runtime contains an absolute symlink: ${path} -> ${target}`)
      }
      const resolvedTarget = resolve(dirname(path), target)
      assertPathInside(
        root,
        resolvedTarget,
        `packaged runtime symlink escapes its root (${path} -> ${target})`,
      )
      if (!existsSync(resolvedTarget)) {
        fail(`packaged runtime contains a dangling symlink: ${path} -> ${target}`)
      }
      const canonicalTarget = realpathSync(resolvedTarget)
      assertPathInside(
        canonicalRoot,
        canonicalTarget,
        `packaged runtime symlink resolves outside its root (${path} -> ${target})`,
      )
    }
  }
}

function assertNoSymlinks(root, description) {
  if (lstatSync(root).isSymbolicLink()) {
    fail(`${description} must not be a symbolic link: ${root}`)
  }

  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        fail(`${description} contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

function virtualEnvironmentPython() {
  return process.platform === 'win32'
    ? join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
    : join(repositoryRoot, '.venv', 'bin', 'python')
}

function resolveSitePackages(configuration) {
  const override = process.env.HHTOOLS_RUNTIME_SITE_PACKAGES
  if (override) return existingRealPath(override, 'site-packages directory')

  const interpreter = virtualEnvironmentPython()
  if (existsSync(interpreter)) {
    const discovery = spawnSync(
      interpreter,
      ['-I', '-c', "import sysconfig; print(sysconfig.get_path('purelib'))"],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    const discovered = discovery.stdout?.trim().split(/\r?\n/).at(-1)
    if (discovery.status === 0 && discovered && existsSync(discovered)) {
      return realpathSync(discovered)
    }
  }

  const version = configuration.values.version_info?.match(/^(\d+\.\d+)/)?.[1]
  const fallback = process.platform === 'win32'
    ? join(repositoryRoot, '.venv', 'Lib', 'site-packages')
    : version
      ? join(repositoryRoot, '.venv', 'lib', `python${version}`, 'site-packages')
      : undefined
  if (!fallback) {
    fail(`unable to discover site-packages using ${interpreter}`)
  }
  return existingRealPath(fallback, 'site-packages directory')
}

function packagedPythonExecutable() {
  const executable = process.platform === 'win32'
    ? join(runtimePython, 'python.exe')
    : join(runtimePython, 'bin', 'python3')
  if (!existsSync(executable)) {
    fail(`packaged Python executable is missing: ${executable}`)
  }
  return executable
}

function stagedSitePackages(pythonExecutable) {
  const discovery = spawnSync(
    pythonExecutable,
    ['-I', '-c', "import sysconfig; print(sysconfig.get_path('purelib'))"],
    { cwd: runtimePython, encoding: 'utf8' },
  )
  const discovered = discovery.stdout?.trim().split(/\r?\n/).at(-1)
  if (discovery.status !== 0 || !discovered) {
    fail(
      `unable to discover site-packages using staged Python:\n`
        + `${discovery.stdout}\n${discovery.stderr}`,
    )
  }

  const destination = resolve(discovered)
  assertPathInside(
    runtimePython,
    destination,
    'staged Python reported site-packages outside its runtime root',
    { allowRoot: false },
  )
  return destination
}

const applicationInputs = [
  'hhtools',
  'configs',
  'assets/reference_poses',
  'assets/motions',
  'docker/gvhmr',
  'LICENSE',
  'README.md',
  'pyproject.toml',
]

function copyApplicationFiles(sourceFiles) {
  let copied = 0
  let motionFileCount = 0
  for (const file of sourceFiles.files) {
    const source = join(repositoryRoot, file)
    let metadata
    try {
      metadata = lstatSync(source)
    } catch {
      fail(`source file recorded by ${sourceFiles.provenance} is missing: ${source}`)
    }
    if (metadata.isDirectory() || !shouldCopyApplication(source)) continue

    const destination = join(runtimeApplication, file)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, {
      force: true,
      verbatimSymlinks: process.platform !== 'win32',
    })
    copied += 1
    if (file.replaceAll('\\', '/').startsWith('assets/motions/')) motionFileCount += 1
  }
  return { copied, motionFileCount, provenance: sourceFiles.provenance }
}

function stageLinuxCliLauncher() {
  if (process.platform === 'win32') return null

  const source = join(desktopRoot, 'scripts', 'hhtools-cli-launcher.sh')
  if (!existsSync(source)) fail(`missing Linux CLI launcher: ${source}`)

  const destination = join(runtimeCli, 'hhtools')
  mkdirSync(runtimeCli, { recursive: true })
  cpSync(source, destination, { force: true })
  // FPM preserves this mode when mapping the staged file into /usr/bin.
  chmodSync(destination, 0o755)
  return destination
}

function copyBundledRobots() {
  const source = resolveBundledRobotDirectory(process.env)
  if (!source) return { source: null, count: 0 }

  if (!existsSync(source)) fail(`bundled robot directory is missing: ${source}`)
  const sourceMetadata = lstatSync(source)
  if (sourceMetadata.isSymbolicLink()) fail(`bundled robot path is a symbolic link: ${source}`)
  if (!sourceMetadata.isDirectory()) fail(`bundled robot path is not a directory: ${source}`)
  assertNoSymlinks(source, 'bundled robot directory')

  const destination = join(runtimeApplication, 'configs', 'robots')
  mkdirSync(destination, { recursive: true })
  let count = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const robotSource = join(source, entry.name)
    const robotDestination = join(destination, entry.name)
    assertRobotDestinationAvailable(robotDestination, entry.name)
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

const configuration = readVirtualEnvironmentConfiguration()
const pythonHome = resolvePythonHome(configuration)
const sitePackages = resolveSitePackages(configuration)

console.log(`[prepare-runtime] Python: ${pythonHome}`)
copyDirectory(pythonHome, runtimePython, shouldCopyPythonBase)
assertRelocatableSymlinks(runtimePython)
const pythonExecutable = packagedPythonExecutable()
const packagedSitePackages = stagedSitePackages(pythonExecutable)
copyDirectory(sitePackages, packagedSitePackages, shouldCopySitePackage)

const applicationSource = listApplicationSourceFiles(
  repositoryRoot,
  applicationInputs,
  process.env,
)
if (applicationSource.provenance === 'trusted-archive') {
  console.warn('[prepare-runtime] Trusting allowlisted files from a source archive without .git.')
}
const application = copyApplicationFiles(applicationSource)
const robots = copyBundledRobots()
const cliLauncher = stageLinuxCliLauncher()
assertRelocatableSymlinks(runtimeRoot)

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
  platform: process.platform,
  pythonHome,
  sitePackages,
  packagedSitePackages: relative(runtimeRoot, packagedSitePackages).replaceAll('\\', '/'),
  applicationSourceProvenance: application.provenance,
  applicationFileCount: application.copied,
  motionFileCount: application.motionFileCount,
  bundledRobotSource: robots.source,
  bundledRobotCount: robots.count,
  cliLauncher: cliLauncher === null
    ? null
    : relative(runtimeRoot, cliLauncher).replaceAll('\\', '/'),
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
    + `${application.motionFileCount} tracked motion files.`,
)
