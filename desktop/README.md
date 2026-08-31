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

The shell discovers the repository by walking upward from the current app path. Override runtime
locations when needed:

```powershell
$env:HHTOOLS_REPO_ROOT = 'C:\path\to\human-humanoid-tools'
$env:HHTOOLS_PYTHON = 'C:\path\to\python.exe'
npm run dev
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
```

`test:e2e` builds and launches the real Electron application, checks the existing WebUI, captures
a screenshot, closes the app, and verifies that the supervised Python process exits.

## Windows package

`npm run dist:win` performs three steps:

1. Build the Electron main and preload processes.
2. Stage an isolated CPython runtime, production Python packages, the hhtools source, tracked sample
   motions, and bundled robot assets under `desktop/.runtime`.
3. Build an assisted NSIS installer under `desktop/release`.

The staging step reads the base interpreter from `.venv/pyvenv.cfg`; run `uv sync` before packaging.
`HHTOOLS_RUNTIME_PYTHON_HOME`, `HHTOOLS_RUNTIME_SITE_PACKAGES`, and
`HHTOOLS_BUNDLED_ROBOT_DIR` are packaging-time overrides. Generated or untracked motion files are
not included.

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
overrides.
