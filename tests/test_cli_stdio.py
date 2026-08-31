from __future__ import annotations

import os
import subprocess
import sys


def test_cli_entrypoint_overrides_legacy_windows_encoding() -> None:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "0"
    env["PYTHONIOENCODING"] = "cp1252"
    script = (
        "import sys; sys.argv = ['hhtools', 'web']; import hhtools.cli.main; print('✓ 中文文件名')"
    )

    completed = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    assert completed.stdout.decode("utf-8").strip() == "✓ 中文文件名"
