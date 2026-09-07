# Human-Humanoid Tools

This directory contains the Electron GUI shell for the existing FastAPI and three.js WebUI.
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

## Desktop packages

The installer is intentionally a thin Electron shell, matching the original Desktop Alpha design.
It does not duplicate Python, Torch, CUDA, Newton, or the hhtools source tree. The target computer
uses an existing checkout and its `.venv`; set `HHTOOLS_REPO_ROOT` and, when needed,
`HHTOOLS_PYTHON` before launching an installed build.

Both package commands build Electron, stage only the local neutral SMPL-X model, and then invoke
electron-builder:

```bash
npm run dist:linux   # release/hhtools-0.1.0-amd64.deb
npm run dist:win     # release/hhtools-0.1.0-x64-setup.exe
```

`configs/body_models/smplx/SMPLX_NEUTRAL.npz` is a required local build input. It remains ignored
by Git and is copied to `resources/body_models` only for the installer. A missing file fails the
build immediately. The package adds about 104 MiB for this model instead of several GiB for a
duplicated GPU environment.

Install the Linux package with `sudo apt install ./release/hhtools-0.1.0-amd64.deb`, then launch
`hhtools-desktop`. The package does not install or replace the separate `hhtools` CLI command.

GVHMR itself remains external. On Linux, choose its checkout and Python from the desktop setup; on
Windows, configure the existing Docker-backed runtime. The bundled neutral model is passed to both
hhtools and GVHMR automatically.

## Runtime model

1. Electron allocates a random `127.0.0.1` port and a per-launch session secret.
2. `SidecarSupervisor` starts `python -m hhtools.cli.desktop_sidecar`.
3. Electron waits for `/api/health`, injects the session header into requests, and only then shows
   the existing WebUI.
4. Closing Electron stops the full Python process tree before the app exits.

Packaged and development builds use the same external checkout and `.venv` resolution;
`HHTOOLS_REPO_ROOT` and `HHTOOLS_PYTHON` remain explicit overrides. The sidecar receives the
packaged model path and an allowlisted environment rather than Electron's complete environment.
Linux display/session and native-library variables such as `DISPLAY`,
`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `LD_LIBRARY_PATH`, `MUJOCO_GL`,
and `PYOPENGL_PLATFORM` are retained so GNOME, MuJoCo, and GPU runtimes can initialize normally.
