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
