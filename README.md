# radar

Read-only 2D radar for SP-Tarkov, the single-player mod for Tarkov, reading the game's memory 
from a QEMU guest on a Linux host via VMM (MemProcFS) + LeechCore.

## Building

```sh
# checks dependencies, inits submodules, fetches the VMM runtime files
scripts/setup.sh
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

```sh
# web/dist, served by radar-backend
cd web && npm install && npm test && npm run build
```

Everything ends up in `build/bin/`: `radar-backend`, `vmm.so`, `leechcore.so` and
`leechcore_device_qemu.so`.  They depend on being next to each other.

**Runtime files not in any source repo:** `info.db` and `libpdbcrust.so` from the official MemProcFS
Linux release must sit in `build/bin/`. VMM uses them for Windows symbol and PDB parsing.
`scripts/setup.sh` downloads them (the release matching the vendored MemProcFS version, for this
machine's architecture); pass `--build-dir` for a different build directory.

**Patches:** local patches to submodules (`patches/`) are applied automatically when CMake
configures. They're skipped if already applied, so re-running is safe. The patched submodule is
marked `ignore = dirty`, so it doesn't show as modified.

## Data files (Backblaze B2)

Large or copyrighted files are not in git. They live in a private B2 bucket and
are listed in `assets.json` by path and SHA-256: the il2cpp dump, the map
images and their `map.json` calibrations (except `maps/demo`), a couple of
sample recordings and the 3D map extraction cache. `scripts/assets.py` (stdlib
Python, no install) manages them:

```sh
scripts/assets.py status               # missing / modified / new files
scripts/assets.py pull                 # download everything missing (or: pull maps/ dumps/)
scripts/assets.py push                 # upload changed tracked files, update assets.json
scripts/assets.py add recordings/X.gz  # start tracking a file (or directory)
```

`push` and `add` change `assets.json`; commit it like code. Blobs are stored
under their hash and never overwritten, so older commits stay pullable.
`assets.json` → `track` lists globs whose new files `push` picks up
automatically.

Credentials: an application key with access to the bucket, as
`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` in the environment or in a
gitignored `.assets.env` at the repo root:

```sh
B2_APPLICATION_KEY_ID=...
B2_APPLICATION_KEY=...
```

## Running/Development

```sh
# Live QEMU guest (guest RAM must be a memfd or hugetlbfs memory backend):
sudo ./build/bin/radar-backend --device "qemu://hugepage-pid=$(pgrep -f 'guest=')"

# Offline, against a raw physical memory dump:
./build/bin/radar-backend --device /path/to/dump.raw

# Offline, just serving saved replays:
./build/bin/radar-backend --offline
```

```sh
cd web/
npm run dev
```
