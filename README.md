# radar

Read-only radar for SP-Tarkov, the single-player mod for Tarkov, reading the game's memory
from a QEMU guest on a Linux host via VMM (MemProcFS) + LeechCore.

## Building

```sh
# checks dependencies, inits submodules, fetches the VMM runtime files
tools/setup.sh
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

The `assets-tool` test needs `rclone` (`mise install`); ctest shows it as skipped without it. The
`maps3d` test (the 3D map builder's Python tests) is registered only when `tools/maps3d/.venv`
exists at configure time (`make install` in `tools/maps3d`); `make test` there also runs the harness tests.

Layout: `tools/` is everything a developer runs that isn't the product (C++ tools, Python tools,
setup), `cmake/` is build-time only, `tests/` holds the C++ tests.

```sh
# web/dist, served by radar-backend
cd web && npm install && npm test && npm run build
```

Everything ends up in `build/bin/`: `radar-backend`, `vmm.so`, `leechcore.so` and
`leechcore_device_qemu.so`.  They depend on being next to each other.  The developer tools
(`docs/offset-tools.md`) are there too: `il2cpp-dump`, `mem-dump`, `vmm-check` and `radar-diagnose` (checks the whole read chain; run it in a raid).

**Overlay window** (`--overlay`, `docs/design.md`; a shelved experiment, not being developed): built when the Wayland, EGL and OpenGL ES
development files are found (Debian: `libwayland-dev wayland-protocols libegl-dev libgles-dev`;
Arch: `wayland wayland-protocols mesa`). Force it with `-DRADAR_OVERLAY_WINDOW=ON` or turn it off
with `OFF`. `build/bin/radar-overlay-demo` shows the window with a made-up scene, for checking it
on the desktop without the game. Dear ImGui (`third_party/imgui`) draws the shapes and text.

**Runtime files not in any source repo:** `info.db` and `libpdbcrust.so` from the official MemProcFS
Linux release must sit in `build/bin/`. VMM uses them for Windows symbol and PDB parsing.
`tools/setup.sh` downloads them (the release matching the vendored MemProcFS version, for this
machine's architecture); pass `--build-dir` for a different build directory.

**Patches:** local patches to submodules (`patches/`) are applied automatically when CMake
configures. They're skipped if already applied, so re-running is safe. The patched submodule is
marked `ignore = dirty`, so it doesn't show as modified.

## Documentation

- `docs/design.md`: the decisions and invariants behind the code
- `docs/protocol.md`: the backend's HTTP/WebSocket protocol
- `docs/offset-tools.md`: `il2cpp-dump` and `update-offsets.py`, keeping the offsets current
- `docs/maps3d.md`: the 3D map pipeline and viewer

## Data files (asset store)

Large or copyrighted files are not in git. They live in a private asset store on
the local network (plain files, moved by rclone) and are listed in `assets.json`
by path and SHA-256: the il2cpp dump, the 3D maps
(`maps/3d`, see `docs/maps3d.md`), the cache they are built from
(`tools/maps3d/cache`) and shared raid recordings. `tools/assets.py` (stdlib
Python plus `rclone`, which `mise install` provides) manages them:

```sh
tools/assets.py status               # missing / behind / modified / conflict / new files
tools/assets.py pull                 # download everything missing or behind (or: pull maps/ dumps/)
                                       # running the radar needs maps/; tools/maps3d/cache only to rebuild 3D maps
tools/assets.py push                 # upload locally modified tracked files, update assets.json
tools/assets.py add dumps/X.json     # start tracking a file (or directory)
```

`push` and `add` change `assets.json`; commit it like code. Blobs are stored
under their hash and never overwritten, so older commits stay pullable.
`assets.json` → `track` lists globs whose new files `push` picks up
automatically.

Your copy of an asset can differ from `assets.json` because you changed it or
because a `git pull` moved the manifest on. The tool tells them apart by
remembering, per path, the hash this checkout last synced
(`.assets-base.json`, gitignored):

| What happened | `status` | `pull` | `push` |
| --- | --- | --- | --- |
| `git pull` brought new hashes, your file is untouched | behind | updates it | skips it ("run pull") |
| You rebuilt or edited a file | modified | leaves it | publishes it |
| Both (you rebuilt, and a pull changed the hash) | conflict | refuses it, exit 1 | refuses it, exit 1 |

A conflict is settled per path, and the other paths carry on meanwhile:

```sh
tools/assets.py resolve maps/3d/customs --ours     # keep mine; the next push publishes it
tools/assets.py resolve maps/3d/customs --theirs   # take the manifest's version
```

Nothing is overwritten silently: before `pull --force` (take the manifest's
version of modified files), `resolve --theirs` or a restore replaces a file
that exists nowhere else, the old one is *moved* to
`.assets-trash/<UTC timestamp>/<path>`. A file equal to what you last pulled or
pushed is not trashed, since `pull` brings it back.

```sh
tools/assets.py trash                              # what is in there, with sizes
tools/assets.py trash --restore PATH [--from TS]   # put the newest (or that) copy back
tools/assets.py trash --empty [--older-than DAYS]  # free the space
```

After an upgrade, or in a fresh checkout whose files already exist, there is no
record yet: a file equal to the manifest is simply recorded, one that differs
counts as modified (`pull` skips it, `pull --force` trashes and replaces it,
`resolve --ours` keeps it). `gc` also keeps the blobs your checkout last synced.

`recordings/` is a *shared dir* (`assets.json` → `shared`): its files need no
versioning (unique names, never changed), so they are not in the manifest and
sharing one needs no commit. They sit in the store as plain files under
`shared/recordings/`; `pull` fetches the ones you don't have. The backend writes
every raid to `recordings/`, so nothing is shared until you say so:

```sh
tools/assets.py share recordings/X.jsonl.gz    # upload (never overwrites)
tools/assets.py shared                         # list: ↓ only in the store, ↑ only here (--all)
tools/assets.py unshare recordings/X.jsonl.gz  # delete from the store (local copy stays)
```

A test that depends on one exact recording should pin it as a normal asset
under its own path instead (e.g. `tests/fixtures/`), so it is versioned.

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

Any other rclone backend works the same way. `tools/assets.py verify` checks the
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

`./build-and-run.sh` (repo root) builds and starts the backend against the running QEMU guest.

```sh
cd web/
npm run dev
```
