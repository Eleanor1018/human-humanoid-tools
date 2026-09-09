#!/bin/sh
set -eu

umask 022

installer_name='HHTools desktop runtime installer'
embedded_version=''
embedded_wheel=''
python_request=${HHTOOLS_PYTHON:-'>=3.12,<3.14'}
system_install=0

say() {
    printf '%s\n' "$*"
}

die() {
    printf '%s: %s\n' "$installer_name" "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Install the HHTools runtime bundled with the Linux desktop package.

Usage:
  install.sh [--system]

Options:
  --system    Install under /opt/hhtools and link commands in /usr/local/bin.
              This mode must be run as root.
  -h, --help  Show this help.

The HHTools wheel, dependency lock, installer configuration, and uv executable
are read from this desktop package. Python and third-party packages are fetched
by uv from the configured package indexes; no unpublished Release is required.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --system)
            system_install=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

[ "$(uname -s)" = 'Linux' ] || die 'this installer supports Linux only'
case "$(uname -m)" in
    x86_64|amd64) ;;
    *) die 'the bundled uv executable supports Linux x86_64 only' ;;
esac

for command_name in cp dirname id mkdir mktemp mv rm sha256sum uname; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command not found: $command_name"
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
asset_dir="$script_dir/assets"
uv_bin="$script_dir/bin/uv"
checksum_file="$script_dir/SHA256SUMS"
version=$embedded_version
wheel_name=$embedded_wheel

[ -n "$version" ] || die 'the desktop package has no embedded runtime version'
[ -n "$wheel_name" ] || die 'the desktop package has no embedded HHTools wheel'
[ -f "$checksum_file" ] || die "bundled checksum file not found: $checksum_file"
[ -x "$uv_bin" ] || die "bundled uv executable not found: $uv_bin"
[ -f "$asset_dir/$wheel_name" ] || die "bundled wheel not found: $wheel_name"
[ -f "$asset_dir/requirements-all.txt" ] \
    || die 'bundled dependency lock not found: requirements-all.txt'
[ -f "$asset_dir/installer-uv.toml" ] \
    || die 'bundled uv configuration not found: installer-uv.toml'

if [ "$system_install" -eq 1 ]; then
    [ "$(id -u)" -eq 0 ] || die '--system must be run as root'
    install_root=${HHTOOLS_INSTALL_ROOT:-/opt/hhtools}
    bin_dir=${HHTOOLS_BIN_DIR:-/usr/local/bin}
    cache_dir=${HHTOOLS_CACHE_DIR:-/var/cache/hhtools/uv}
else
    [ "$(id -u)" -ne 0 ] || die 'do not run as root without --system'
    [ -n "${HOME:-}" ] || die 'HOME is required for a user installation'
    data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
    cache_home=${XDG_CACHE_HOME:-"$HOME/.cache"}
    install_root=${HHTOOLS_INSTALL_ROOT:-"$data_home/hhtools"}
    bin_dir=${HHTOOLS_BIN_DIR:-"${XDG_BIN_HOME:-$HOME/.local/bin}"}
    cache_dir=${HHTOOLS_CACHE_DIR:-"$cache_home/hhtools/uv"}
fi

say "[1/5] Verifying bundled HHTools $version installation files..."
(
    cd "$script_dir"
    sha256sum -c SHA256SUMS
) || die 'bundled installation file verification failed'

say '[2/5] Preparing the isolated runtime directories...'
mkdir -p "$install_root" "$bin_dir" "$cache_dir"
runtime_marker="$install_root/runtime-version"
rm -f -- "$runtime_marker"
temporary_parent=${TMPDIR:-/tmp}
work_dir=$(mktemp -d "$temporary_parent/hhtools-desktop-install.XXXXXX")
cleanup() {
    rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM
cp "$asset_dir/$wheel_name" "$work_dir/$wheel_name"
cp "$asset_dir/requirements-all.txt" "$work_dir/requirements-all.txt"
cp "$asset_dir/installer-uv.toml" "$work_dir/installer-uv.toml"

say "[3/5] Installing Python $python_request and locked dependencies with bundled uv..."
UV_TOOL_DIR="$install_root/tools" \
UV_TOOL_BIN_DIR="$bin_dir" \
UV_PYTHON_INSTALL_DIR="$install_root/python" \
UV_PYTHON_BIN_DIR="$install_root/python-bin" \
UV_CACHE_DIR="$cache_dir" \
    "$uv_bin" tool install \
        --force \
        --python "$python_request" \
        --config-file "$work_dir/installer-uv.toml" \
        --with-requirements "$work_dir/requirements-all.txt" \
        "hhtools @ file://$work_dir/$wheel_name"

say '[4/5] Verifying the installed CLI, WebUI, retargeting, and Agent runtime...'
hhtools_bin="$bin_dir/hhtools"
[ -x "$hhtools_bin" ] || die "installed command not found: $hhtools_bin"
"$hhtools_bin" --version
"$hhtools_bin" doctor --require web --require retarget --require mcp
runtime_python="$install_root/tools/hhtools/bin/python"
[ -x "$runtime_python" ] || die "installed runtime Python not found: $runtime_python"

runtime_marker_tmp="$install_root/.runtime-version.$$"
printf '%s\n' "$version" > "$runtime_marker_tmp"
mv "$runtime_marker_tmp" "$runtime_marker"

say '[5/5] HHTools runtime installation completed.'
say 'GVHMR and SMPL-family weights were not installed.'
