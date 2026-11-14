# radar

Read-only radar for SP-Tarkov, the single-player mod for Tarkov, reading the game's memory 
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

## Data files (asset store)

Large or copyrighted files are not in git. They live in a private asset store on
the local network (plain files, moved by rclone) and are listed in `assets.json`
by path and SHA-256: the il2cpp dump, the 3D maps
(`maps/3d`, see `docs/maps3d.md`), the cache they are built from
(`tools/maps3d/cache`) and a couple of sample recordings. `scripts/assets.py` (stdlib
Python plus `rclone`, which `mise install` provides) manages them:

```sh
scripts/assets.py status               # missing / modified / new files
scripts/assets.py pull                 # download everything missing (or: pull maps/ dumps/)
                                       # running the radar needs maps/; tools/maps3d/cache only to rebuild 3D maps
scripts/assets.py push                 # upload changed tracked files, update assets.json
scripts/assets.py add recordings/X.gz  # start tracking a file (or directory)
```

`push` and `add` change `assets.json`; commit it like code. Blobs are stored
under their hash and never overwritten, so older commits stay pullable.
`assets.json` → `track` lists globs whose new files `push` picks up
automatically.

The store is a directory of blobs on one always-on machine (the hub); every
other machine reaches it over SFTP. Set `ASSETS_REMOTE` to an rclone path, in
the environment or in a gitignored `.assets.env` at the repo root:

```sh
# on the hub: the store is just a local directory
ASSETS_REMOTE=~/.local/share/tarkdar-assets
```

```sh
# elsewhere: define an sftp remote once (uses your ssh keys/agent) ...
rclone config create tarkdar-hub sftp host=<hub hostname or IP> user=<user>
# ... and point at the hub's directory (absolute path on the hub)
ASSETS_REMOTE=tarkdar-hub:/home/<user>/.local/share/tarkdar-assets
```

Any other rclone backend works the same way. `scripts/assets.py verify` checks the
store has every blob the manifest needs; `push` uploads any it is missing, so a
full checkout can re-seed an empty store. The store is the only copy of older
commits' blobs, so back it up with the hub.

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
