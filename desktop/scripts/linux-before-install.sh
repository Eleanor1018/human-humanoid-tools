#!/bin/sh

# Releases before the split registered /usr/bin/hhtools as an alternative for
# the Electron binary. Remove only that exact legacy target before dpkg unpacks
# the new, package-owned Python CLI wrapper at the same path. Never touch a
# normal file or an alternative supplied by another installation.
legacy_gui='/opt/Human-Humanoid Tools/hhtools'

if command -v update-alternatives >/dev/null 2>&1 && \
   update-alternatives --query hhtools 2>/dev/null | \
       grep -Fqx "Alternative: $legacy_gui"; then
    update-alternatives --remove hhtools "$legacy_gui" || true
fi

if [ -L /usr/bin/hhtools ] && \
   [ "$(readlink -f /usr/bin/hhtools 2>/dev/null)" = "$legacy_gui" ]; then
    rm -f /usr/bin/hhtools
fi

printf '%s\n' \
    'Human-Humanoid Tools declares its Linux GUI libraries in this Debian package.' \
    'When using dpkg directly, if it reports missing dependencies, run:' \
    '  sudo apt-get -f install'
