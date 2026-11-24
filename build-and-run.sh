#!/usr/bin/env bash
set -euo pipefail

cmake -S . -B build -G Ninja
cmake --build build

# The QEMU guest process (its command line contains "guest=").
qemu_pids=$(pgrep -f 'guest=' || true)
if [[ -z "$qemu_pids" ]]; then
    echo "error: no QEMU process found (pgrep -f 'guest=')" >&2
    exit 1
fi
if [[ $(wc -l <<<"$qemu_pids") -gt 1 ]]; then
    echo "error: more than one QEMU process found: $(tr '\n' ' ' <<<"$qemu_pids")" >&2
    exit 1
fi

XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" \
    ./build/bin/radar-backend --device "qemu://hugepage-pid=$qemu_pids" "$@"
