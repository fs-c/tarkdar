#!/usr/bin/env bash
# One-time setup for a checkout:
#   1. checks build dependencies (and says which Debian/Ubuntu packages provide missing ones),
#   2. initialises the git submodules,
#   3. downloads the VMM runtime files that aren't in any source repo (info.db, libpdbcrust.so) from
#      the official MemProcFS Linux release into the build output directory.
#
# Usage: scripts/setup.sh [--build-dir DIR] [--release TAG] [--force] [--skip-deps] [--skip-runtime]
#   --build-dir DIR   CMake build directory (default: build); files go to DIR/bin
#   --release TAG     MemProcFS release tag (default: the release matching the vendored MemProcFS
#                     submodule's version, falling back to the latest release)
#   --force           re-download runtime files even if present
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build"
RELEASE=""
FORCE=0
SKIP_DEPS=0
SKIP_RUNTIME=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-dir) BUILD_DIR="$(realpath -m "$2")"; shift 2 ;;
        --release) RELEASE="$2"; shift 2 ;;
        --force) FORCE=1; shift ;;
        --skip-deps) SKIP_DEPS=1; shift ;;
        --skip-runtime) SKIP_RUNTIME=1; shift ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

info() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. dependencies ------------------------------------------------------------------------------
if [[ $SKIP_DEPS -eq 0 ]]; then
    info "checking build dependencies"
    missing=()
    need() {  # need <command> <package hint>
        command -v "$1" >/dev/null 2>&1 || missing+=("$1 (package: $2)")
    }
    need git git
    need cmake cmake
    need python3 python3
    need pkg-config pkg-config
    need curl curl
    need tar tar
    if ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1; then
        missing+=("a C++23 compiler (package: g++, version 13 or newer)")
    fi
    if command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists libusb-1.0; then
        missing+=("libusb-1.0 headers (package: libusb-1.0-0-dev)")
    fi
    if ! command -v ninja >/dev/null 2>&1; then
        warn "ninja not found (optional; package: ninja-build). CMake will use make."
    fi
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
        warn "node/npm not found: needed to build the frontend (Node.js 20+)."
    elif [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
        warn "Node.js $(node --version) is older than 20; the frontend build may fail."
    fi
    if [[ ${#missing[@]} -gt 0 ]]; then
        printf '  missing: %s\n' "${missing[@]}" >&2
        die "install the missing dependencies and re-run"
    fi
fi

# ---- 2. submodules --------------------------------------------------------------------------------
info "initialising submodules"
git -C "$ROOT" submodule update --init --recursive

# ---- 3. VMM runtime files -------------------------------------------------------------------------
if [[ $SKIP_RUNTIME -eq 1 ]]; then
    info "skipping runtime files"
    exit 0
fi

BIN="$BUILD_DIR/bin"
if [[ $FORCE -eq 0 && -f "$BIN/info.db" && -f "$BIN/libpdbcrust.so" ]]; then
    info "runtime files already present in $BIN (use --force to re-download)"
    exit 0
fi

case "$(uname -m)" in
    x86_64|amd64) ARCH=linux_x64 ;;
    aarch64|arm64) ARCH=linux_aarch64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
esac

API=https://api.github.com/repos/ufrisk/MemProcFS/releases
if [[ -z "$RELEASE" ]]; then
    # Prefer the release matching the vendored submodule (e.g. v5.19-5-g6490ad8 → v5.19).
    sub_tag="$(git -C "$ROOT/third_party/MemProcFS" describe --tags --abbrev=0 2>/dev/null || true)"
    if [[ -n "$sub_tag" ]] && curl -fsS "$API/tags/$sub_tag" >/dev/null 2>&1; then
        RELEASE="$sub_tag"
    fi
fi
release_url="$API/latest"
[[ -n "$RELEASE" ]] && release_url="$API/tags/$RELEASE"

info "looking up MemProcFS release ${RELEASE:-latest} ($ARCH)"
release_json="$(curl -fsS "$release_url")" || die "couldn't query $release_url"
asset_url="$(python3 -I -c '
import json, sys
arch = sys.argv[1]
for a in json.loads(sys.stdin.read()).get("assets", []):
    if arch in a["name"] and a["name"].endswith(".tar.gz"):
        print(a["browser_download_url"]); break
' "$ARCH" <<<"$release_json")"
[[ -n "$asset_url" ]] || die "no $ARCH archive in that release"

# Extract into a fresh, empty directory and copy out only the two files we need.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
info "downloading $(basename "$asset_url")"
curl -fL --progress-bar -o "$tmp/memprocfs.tar.gz" "$asset_url"
mkdir "$tmp/extract"
tar -xzf "$tmp/memprocfs.tar.gz" -C "$tmp/extract" --no-same-owner --no-same-permissions

mkdir -p "$BIN"
for f in info.db libpdbcrust.so; do
    src="$(find "$tmp/extract" -type f -name "$f" -print -quit)"
    [[ -n "$src" ]] || die "$f not found in the archive"
    install -m 0644 "$src" "$BIN/$f"
    info "installed $BIN/$f"
done
chmod 0755 "$BIN/libpdbcrust.so"

info "done. Next: cmake -S . -B $(realpath --relative-to="$ROOT" "$BUILD_DIR") -G Ninja && cmake --build $(realpath --relative-to="$ROOT" "$BUILD_DIR")"
