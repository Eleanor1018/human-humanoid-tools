#!/bin/sh

# Keep this path in sync with productName in desktop/package.json. A packaging
# regression test guards the relationship so a future product rename cannot
# silently strand the CLI.
runtime_root='/opt/Human-Humanoid Tools/resources/runtime'
application_root="$runtime_root/app"
python_executable="$runtime_root/python/bin/python3"

if [ ! -x "$python_executable" ] || [ ! -d "$application_root/hhtools" ]; then
    printf '%s\n' 'hhtools: the bundled Python runtime is incomplete.' >&2
    printf 'Expected runtime: %s\n' "$runtime_root" >&2
    exit 1
fi

# The packaged CLI must use only its bundled modules and dependencies. In
# particular, ignore an active virtualenv and user site-packages so an unrelated
# Python installation cannot silently alter a packaged command.
unset PYTHONHOME VIRTUAL_ENV
export PYTHONPATH="$application_root"
export PYTHONNOUSERSITE=1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUTF8=1
export PYTHONUNBUFFERED=1

# The source-tree CLI defaults are relative to a checkout. Supply writable,
# per-user defaults in the installed package while preserving explicit caller
# overrides and the caller's working directory.
if [ -z "${HHTOOLS_SOURCE_ROOT:-}" ]; then
    HHTOOLS_SOURCE_ROOT="$application_root/assets/motions"
    export HHTOOLS_SOURCE_ROOT
fi

if [ -z "${HHTOOLS_SAVE_DIR:-}" ]; then
    data_root=${XDG_DATA_HOME:-${HOME:+$HOME/.local/share}}
    if [ -n "$data_root" ]; then
        HHTOOLS_SAVE_DIR="$data_root/hhtools/save_npz"
        export HHTOOLS_SAVE_DIR
    fi
fi

if [ -z "${HHTOOLS_CACHE_DIR:-}" ]; then
    cache_root=${XDG_CACHE_HOME:-${HOME:+$HOME/.cache}}
    if [ -n "$cache_root" ]; then
        HHTOOLS_CACHE_DIR="$cache_root/hhtools"
        export HHTOOLS_CACHE_DIR
    fi
fi

# Call the same Typer object declared by the Python package's console entry
# point. Executing hhtools.cli.main with `python -m` would first import it from
# hhtools.cli.__init__ and then execute it a second time, producing a noisy
# runpy warning even though the command succeeds.
exec "$python_executable" -c \
    'from hhtools.cli.main import app; app(prog_name="hhtools")' "$@"
