# Human-Humanoid Tools

This directory contains the standalone Electron GUI for the existing FastAPI and three.js WebUI.
The desktop app keeps the current HTTP routes and Python business logic while supervising its own
local Python sidecar.

## Development

Prerequisites:

- Node.js 22.12 or newer
- The repository `.venv` with the hhtools Web dependencies installed
- A working browser version of `uv run hhtools web`

From this directory:

```powershell
npm install
npm run dev
```

On Linux, the equivalent commands are:

```bash
npm install
npm run dev
```

The shell discovers the repository by walking upward from the current app path. Override runtime
locations when needed:

```powershell
$env:HHTOOLS_REPO_ROOT = 'C:\path\to\human-humanoid-tools'
$env:HHTOOLS_PYTHON = 'C:\path\to\python.exe'
npm run dev
```

```bash
HHTOOLS_REPO_ROOT=/path/to/human-humanoid-tools \
HHTOOLS_PYTHON=/path/to/python3 npm run dev
```

Optional data path overrides are `HHTOOLS_SOURCE_ROOT`, `HHTOOLS_SAVE_DIR`,
`HHTOOLS_CACHE_DIR`, and `HHTOOLS_LOG_DIR`.

Background-job admission is optional. Both settings have a factory default of `0`, preserving
unlimited concurrency for expert users:

```powershell
$env:HHTOOLS_MAX_RUNNING_JOBS = '1'
$env:HHTOOLS_MAX_QUEUED_JOBS = '32'
npm run dev
```

A positive running value enables the FIFO waiting queue. A queued value of `0` means unlimited
waiting; it has no effect while running is `0`. The same values are editable in local Electron
under **Settings → Background-job scheduling**; Save persists and hot-applies them without restarting the sidecar
or Electron. Active jobs are not interrupted. Explicit environment values remain startup
overrides and win again on the next launch. `HHTOOLS_WEB_SETTINGS_PATH` can redirect the
persistent JSON file for portable installs and isolated tests.
The Electron environment filter forwards these three named settings, not arbitrary variables or
secrets.
This cap covers scheduled Web jobs, not the optional Warp/Newton robot prewarm thread; it is not
a process-wide GPU concurrency guarantee.

## Verification

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run dist:win
npm run dist:linux
```

`test:e2e` builds and launches the real Electron application, checks the existing WebUI, captures
a screenshot, closes the app, and verifies that the supervised Python process exits.

## Windows package

`npm run dist:win` performs three steps:

1. Build the Electron main and preload processes.
2. Stage an isolated CPython runtime, production Python packages, the hhtools source, tracked sample
   motions, and any explicitly selected bundled robot assets under `desktop/.runtime`.
3. Build an assisted NSIS installer under `desktop/release`.

The staging step reads the base interpreter from `.venv/pyvenv.cfg`; run `uv sync` before packaging.
`HHTOOLS_RUNTIME_PYTHON_HOME`, `HHTOOLS_RUNTIME_SITE_PACKAGES`, and
`HHTOOLS_BUNDLED_ROBOT_DIR` are packaging-time overrides. Source files are selected with
`git ls-files`, so ignored and untracked files are not included. For a verified `git archive`
extraction without `.git`, set `HHTOOLS_TRUST_SOURCE_ARCHIVE=1`; other unversioned source trees are
rejected rather than copied wholesale.

Installed files use this shape:

```text
Human-Humanoid Tools/
├── Human-Humanoid Tools.exe
└── resources/
    ├── app.asar
    └── runtime/
        ├── app/       # hhtools source, WebUI, configs, and bundled assets
        └── python/    # isolated CPython and production dependencies
```

User-created motions, caches, logs, window state, and optional-component settings remain under
Electron's per-user data directory and are not removed by an application upgrade.

## Linux package

Build the Linux package on the oldest supported Linux distribution rather than cross-compiling it
from Windows. The staged Python runtime contains platform-specific native wheels, and building on
Ubuntu 22.04 keeps the resulting glibc requirement compatible with Ubuntu 22.04 or newer. A clean
Ubuntu 22.04 x86-64 builder can be prepared with:

```bash
sudo apt update
sudo apt install -y build-essential git libarchive-tools

# Install Node.js 22 and uv by the method used for the build host, then:
uv python install 3.12
uv sync --locked --managed-python --python 3.12 --extra all
cd desktop
npm ci
npm run dist:linux
```

Allow at least 25--30 GiB of free disk space for the uv environment, staged runtime, Electron
working files, and final package. Native Torch, CUDA, Warp, MuJoCo, and Newton files make the Linux
runtime substantially larger than a normal Electron-only application.

`dist:linux` builds the Electron bundles, stages the uv-managed CPython 3.12 installation and the
virtual environment's production packages, verifies imports using that staged interpreter, and
creates `release/hhtools-0.1.0-x64.deb`. The build intentionally rejects `/usr` and `/usr/local` as
Python homes: copying a distribution-managed Python tree is unsafe and generally not relocatable.
Recreate `.venv` after `uv python install 3.12` if this guard is triggered.

Install and remove the package with the system package manager so its desktop entry and runtime
dependencies are handled normally:

```bash
sudo apt install ./release/hhtools-0.1.0-x64.deb
sudo apt remove hhtools-desktop
```

For users who prefer `dpkg`, install the same package with:

```bash
sudo dpkg -i ./release/hhtools-0.1.0-x64.deb
# dpkg does not download dependencies. Run this only if it reports missing packages:
sudo apt-get -f install
```

The Debian package declares its Electron/GTK runtime libraries, so `apt` and graphical package
installers resolve them automatically. The install-time message repeats the recovery command for
terminal installations; no system Python, pip environment, Torch, or Newton install is required.

On a full Ubuntu desktop, double-click the `.deb` and open it with App Center. Minimal GNOME
installations need a graphical Debian-package handler such as GDebi. After installation, launch
**Human-Humanoid Tools** from the application menu or run `hhtools-desktop`. The separate
`hhtools` command invokes the bundled Python CLI from any working directory:

```bash
hhtools --help
hhtools robot list
hhtools web
```

The launcher isolates the bundled Python runtime from user site-packages and active virtualenvs.
It also gives packaged `web`/`ui` commands read-only sample motions plus writable XDG data/cache
defaults; explicit CLI options and `HHTOOLS_SOURCE_ROOT`, `HHTOOLS_SAVE_DIR`, or
`HHTOOLS_CACHE_DIR` still take precedence.

Robot files from `$HOME` or `$XDG_CONFIG_HOME` are never included implicitly. Set
`HHTOOLS_BUNDLED_ROBOT_DIR=/verified/robots` to include a reviewed robot library. The source must
contain one directory per robot and may not contain symbolic links; names that collide with tracked
robot directories are rejected instead of merged. The repository does not track the local built-in
robot library, so a clean builder intentionally produces a package without those extra robots.
The installed runtime is placed below the Electron application's `resources/runtime` directory and
uses `python/bin/python3`; no system Python is required when the application runs.

### Optional GVHMR

GVHMR is deliberately excluded from the core package. The installer can record that the user wants
it configured; on first launch, **Settings → Optional components** opens the guided setup. The same
entry remains available later for on-demand setup or repair.

The guided setup accepts an official GVHMR checkout and restarts the sidecar with
`HHTOOLS_GVHMR_ROOT`. Docker Desktop, the hhtools GVHMR image, official checkpoints, and licensed
SMPL/SMPL-X files stay external. The app never silently accepts or redistributes those third-party
licenses. A complete setup currently needs roughly 22 GB in addition to the core application.

## Runtime model

1. Electron allocates a random `127.0.0.1` port and a per-launch session secret.
2. `SidecarSupervisor` starts `python -m hhtools.cli.desktop_sidecar`.
3. Electron waits for `/api/health`, injects the session header into requests, and only then shows
   the existing WebUI.
4. Closing Electron stops the full Python process tree before the app exits.

Packaged builds always prefer `resources/runtime`. Development builds continue to discover the
repository checkout and `.venv`; `HHTOOLS_REPO_ROOT` and `HHTOOLS_PYTHON` remain explicit developer
overrides. The sidecar still receives an allowlisted environment rather than Electron's complete
environment. Linux display/session and native-library variables such as `DISPLAY`,
`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `LD_LIBRARY_PATH`, `MUJOCO_GL`,
and `PYOPENGL_PLATFORM` are retained so GNOME, MuJoCo, and GPU runtimes can initialize normally.
