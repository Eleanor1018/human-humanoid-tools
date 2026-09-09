from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
INSTALLER_TEMPLATE = REPOSITORY_ROOT / "desktop" / "scripts" / "install-packaged-runtime.sh"
VERSION = "0.1.0"
WHEEL = f"hhtools-{VERSION}-py3-none-any.whl"


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _bootstrap(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "bootstrap"
    assets = root / "assets"
    bin_dir = root / "bin"
    assets.mkdir(parents=True)
    bin_dir.mkdir()
    (assets / WHEEL).write_text("wheel fixture\n", encoding="utf-8")
    (assets / "requirements-all.txt").write_text("dependency==1.0\n", encoding="utf-8")
    (assets / "installer-uv.toml").write_text("", encoding="utf-8")

    arguments = tmp_path / "uv-arguments.txt"
    uv = bin_dir / "uv"
    _write_executable(
        uv,
        """#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$HHTOOLS_TEST_UV_ARGUMENTS"
mkdir -p "$UV_TOOL_DIR/hhtools/bin" "$UV_TOOL_BIN_DIR"
cat > "$UV_TOOL_DIR/hhtools/bin/python" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$UV_TOOL_DIR/hhtools/bin/python"
cat > "$UV_TOOL_BIN_DIR/hhtools" <<'EOF'
#!/bin/sh
case "${1:-}" in
    --version) printf '%s\\n' 'hhtools 0.1.0' ;;
    doctor) exit 0 ;;
    *) exit 0 ;;
esac
EOF
chmod +x "$UV_TOOL_BIN_DIR/hhtools"
""",
    )

    checksum_paths = [
        f"assets/{WHEEL}",
        "assets/requirements-all.txt",
        "assets/installer-uv.toml",
        "bin/uv",
    ]
    checksums = "".join(
        f"{hashlib.sha256((root / relative).read_bytes()).hexdigest()}  {relative}\n"
        for relative in checksum_paths
    )
    (root / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    installer = INSTALLER_TEMPLATE.read_text(encoding="utf-8")
    installer = installer.replace("embedded_version=''", f"embedded_version='{VERSION}'")
    installer = installer.replace("embedded_wheel=''", f"embedded_wheel='{WHEEL}'")
    installer_path = root / "install.sh"
    _write_executable(installer_path, installer)
    return installer_path, arguments


def _environment(tmp_path: Path, arguments: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "HOME": str(tmp_path / "home"),
            "HHTOOLS_BIN_DIR": str(tmp_path / "installed" / "bin"),
            "HHTOOLS_CACHE_DIR": str(tmp_path / "installed" / "cache"),
            "HHTOOLS_INSTALL_ROOT": str(tmp_path / "installed" / "runtime"),
            "HHTOOLS_TEST_UV_ARGUMENTS": str(arguments),
        }
    )
    return environment


def _command(installer: Path) -> list[str]:
    command = ["sh", str(installer)]
    if os.geteuid() == 0:
        command.append("--system")
    return command


def test_packaged_installer_uses_local_inputs_and_publishes_runtime_marker(
    tmp_path: Path,
) -> None:
    installer, arguments = _bootstrap(tmp_path)

    completed = subprocess.run(
        _command(installer),
        env=_environment(tmp_path, arguments),
        capture_output=True,
        check=False,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert "[1/5] Verifying bundled HHTools 0.1.0" in completed.stdout
    assert "[5/5] HHTools runtime installation completed." in completed.stdout
    assert "curl" not in INSTALLER_TEMPLATE.read_text(encoding="utf-8")
    assert (tmp_path / "installed" / "runtime" / "runtime-version").read_text(
        encoding="utf-8"
    ) == "0.1.0\n"
    passed_arguments = arguments.read_text(encoding="utf-8").splitlines()
    assert passed_arguments[:2] == ["tool", "install"]
    assert "--with-requirements" in passed_arguments
    assert passed_arguments[-1].startswith("hhtools @ file://")


def test_packaged_installer_rejects_tampered_local_asset(tmp_path: Path) -> None:
    installer, arguments = _bootstrap(tmp_path)
    (installer.parent / "assets" / "requirements-all.txt").write_text(
        "tampered\n", encoding="utf-8"
    )

    completed = subprocess.run(
        _command(installer),
        env=_environment(tmp_path, arguments),
        capture_output=True,
        check=False,
        text=True,
    )

    assert completed.returncode != 0
    assert "bundled installation file verification failed" in completed.stderr
    assert not arguments.exists()
