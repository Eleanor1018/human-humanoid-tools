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

The two desktop targets use different runtime delivery models:

- Windows stages the current all-extras `.venv` and tracked HHTools application files into the
  installer, so the installed EXE does not require a checkout or system Python.
- Linux keeps Python outside the Debian package. On first launch, a native setup page installs the
  version-matched GitHub Release runtime either for the current user (recommended) or under
  `/opt/hhtools`. System installation uses the operating system's `pkexec` authentication dialog;
  HHTools never reads or forwards the password.

Both packages include only the 30 motions and six robot bundles selected by
`configs/builtin-assets.json`. Before packaging, install the pinned robot bundles and point the
stager at that library:

```bash
uv run python scripts/install_builtin_robots.py --destination /path/to/release-robots
export HHTOOLS_BUNDLED_ROBOT_DIR=/path/to/release-robots
```

Then invoke electron-builder through the package scripts:

```bash
npm run dist:linux   # release/hhtools-0.1.0-amd64.deb
npm run dist:win     # release/hhtools-0.1.0-x64-setup.exe
```

`npm run dist:win` must run on Windows after `uv sync --all-extras --no-dev`; the runtime stager
rejects another host platform and excludes untracked files, development packages, caches, model
weights, and source-map files. `npm run dist:linux` never stages that runtime.

Before publishing the Windows installer, verify the final EXE stays below
[GitHub Releases' 2 GiB per-file limit](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas).
If the all-extras GPU runtime exceeds it, choose a smaller core runtime or a
separately downloaded, checksummed optional GPU payload rather than silently producing an
unpublishable release asset.

SMPL-family model files and GVHMR weights are not part of the default distributable. The separate
`npm run prepare:models` command exists only for a locally authorized build; a user checkbox cannot
grant redistribution rights for a model file.

Install the Linux package with `sudo apt install ./release/hhtools-0.1.0-amd64.deb`, then launch
`hhtools-desktop`. The first-run setup may download several gigabytes, shows live output, verifies
the release checksums, and restarts the app only after `hhtools doctor` succeeds. The Debian package
does not install or replace the separate `hhtools` CLI command. GVHMR remains optional: use its
dedicated setup from the Video to Motion view after the core application starts.

## Runtime model

1. Electron allocates a random `127.0.0.1` port and a per-launch session secret.
2. `SidecarSupervisor` starts `python -m hhtools.cli.desktop_sidecar`.
3. Electron waits for `/api/health`, injects the session header into requests, and only then shows
   the existing WebUI.
4. Closing Electron stops the full Python process tree before the app exits.

Development builds use the checkout and `.venv`; packaged Windows builds prefer their bundled
runtime, and packaged Linux builds prefer a completed user or system installation.
`HHTOOLS_REPO_ROOT` remains an explicit development/support override. The sidecar receives only an
allowlisted environment rather than Electron's complete environment, and bundled runtimes do not
inherit the host `PYTHONPATH`.
Linux display/session and native-library variables such as `DISPLAY`,
`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `LD_LIBRARY_PATH`, `MUJOCO_GL`,
and `PYOPENGL_PLATFORM` are retained so GNOME, MuJoCo, and GPU runtimes can initialize normally.
