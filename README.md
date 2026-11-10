# radar

Read-only 2D radar for SP-Tarkov, the single-player mod for Tarkov, reading the game's memory from a QEMU guest on a Linux host
via VMM (MemProcFS) + LeechCore. See `docs/design.md` for the design, and
`docs/verification-playbook.md` for what to verify on the real setup.

Status: **M6**. Attaches to the game process, finds raids, tracks players (position, look direction,
side, death, equipment), exfils (with status), grenades, tripwires and loot (kind, template id,
position, container contents, corpse equipment), and streams them to a browser radar with map
support, calibration, and a details panel (click a marker). Item names and prices (avg24hPrice, else
basePrice) come from tarkov.dev: the browser downloads them on first load and caches them for a day,
so it needs internet access then.

## Layout

| Path | Contents |
|---|---|
| `core/mem/` | Memory interface (`IMemoryBackend`), `VmmBackend`, `FakeBackend` (tests), `MemoryView`, `ReadBatch`, `Target` (attach state machine), PE fingerprint, pattern scanning |
| `core/il2cpp/` | Managed objects: strings, arrays, lists, dictionaries, class identity/inheritance, type-info table (statics) |
| `core/unity/` | GameObjectManager walk, components, batched transform world poses |
| `core/text/`, `core/math/` | UTF-16 → UTF-8; minimal Vec3/Quat |
| `core/sched/` | `TaskRunner` (periodic tasks per thread), `Published` (atomic snapshot publication) |
| `core/log/` | Minimal logging |
| `game/eft/` | Everything EFT-specific: names (`Names.hpp`), location ids (`Maps.hpp`), offsets (`offsets/eft.offsets.json`), layouts for the core readers (`Layouts.hpp`), build check, `Lifecycle` |
| `game/eft/world/` | Exfils, explosives (grenades, tripwires), loot |
| `game/eft/items/` | Item tree reading (slots, grids) for equipment and contents |
| `game/eft/players/`, `game/eft/model/` | Player tracking (`Players`, skeleton-based positions); published snapshots (`WorldState`) |
| `game/eft/raid/` | Raid discovery (`RaidFinder`), roster reading, raid-end detection (`RaidMonitor`), `RaidSession` |
| `server/` | HTTP/WebSocket server (Crow), message encoding, raid recordings (`docs/protocol.md`) |
| `web/` | Browser frontend (TypeScript, Vite, Canvas 2D) |
| `maps/` | Map folders (`docs/maps.md`); only `maps/demo` is committed |
| `tools/` | `il2cpp-dump` + `update-offsets.py` (refresh offsets from a game build; `docs/offset-tools.md`), `mem-dump` (raw physical memory dumps), `vmm-check` (VMM/QEMU setup sanity check: process list, kernel read), `make-demo-stream.py` (synthetic raid for frontend work) |
| `scripts/` | `setup.sh`: dependency check, submodules, VMM runtime files |
| `app/` | `radar-backend` entry point, CLI options, `--diagnose` |
| `cmake/` | VMM/LeechCore build (`vmm.cmake`), offsets codegen (`gen_offsets.py`) |
| `patches/` | Local patches to submodules, applied automatically at configure time |
| `tests/` | Unit tests (doctest, against `FakeBackend`) and codegen tests |
| `third_party/` | Submodules: LeechCore, MemProcFS (VMM), LeechCore-plugins, Crow, Asio, doctest |

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
`leechcore_device_qemu.so`. They find each other through `$ORIGIN` RPATH, so keep them together.

**Runtime files not in any source repo:** `info.db` and `libpdbcrust.so` from the official MemProcFS
Linux release must sit in `build/bin/`. VMM uses them for Windows symbol and PDB parsing.
`scripts/setup.sh` downloads them (the release matching the vendored MemProcFS version, for this
machine's architecture); pass `--build-dir` for a different build directory.

**Patches:** local patches to submodules (`patches/`) are applied automatically when CMake
configures. They're skipped if already applied, so re-running is safe. The patched submodule is
marked `ignore = dirty`, so it doesn't show as modified.

## Running

```sh
# Live QEMU guest (guest RAM must be a memfd or hugetlbfs memory backend):
sudo ./build/bin/radar-backend --device "qemu://hugepage-pid=$(pgrep -f 'guest=')" --once

# Offline, against a raw physical memory dump:
./build/bin/radar-backend --device /path/to/dump.raw
```

Without `--once` the backend keeps running: it waits for the game, finds raids, tracks players, and
serves the radar at <http://127.0.0.1:8080/> (`--listen` to change; LAN access is opt-in). Paths
default to `web/dist`, `maps` and `data` relative to the working directory, so run it from the repo
root or pass `--web-root`/`--maps-root`. `--once` only checks connectivity (attach, print modules,
exit). `--help` lists every option.

### Without a game

```sh
python3 tools/make-demo-stream.py                      # writes recordings/demo.jsonl
./build/bin/radar-backend --offline                    # then open http://127.0.0.1:8080/
```

Every raid is recorded to `recordings/` (one file per raid; `--recordings <dir>`, `--no-record`,
`--keep-recordings <n>`). In the frontend, the Raids view lists the current raid and past ones;
picking one opens its timeline: what happened (click an entry to jump there) and a scrubber to go
back in time, with playback at 1–16× (`space` plays/pauses, `[`/`]` step 10 s). The indicator at
the left of the status bar opens the timeline of what's shown; while replaying a past raid, the
status bar turns blue and has an exit button. Selecting a player draws where it's been; the Map
view can show everyone's trails.
`--offline` serves the frontend and those recordings without a memory source.

For frontend development with hot reload, run `npm run dev` in `web/` (it proxies `/ws`, `/api`,
`/maps` and `/data` to the backend at `RADAR_BACKEND`, default `http://127.0.0.1:8080`).

Use `--vmm-printf --vmm-arg -v` to see VMM's own diagnostics.

**Checking a new setup or game build:** `radar-backend --device … --diagnose` (best in a raid) runs
through the whole read chain once: attach, type table, raid discovery, players, positions,
equipment, exfils, explosives, loot. It prints what each step read; for each failure it names the
offsets to check.

**Memory dumps for offline work:** pause the VM (`virsh suspend <vm>`), run
`build/bin/mem-dump --device … --out raid.raw`, resume (`virsh resume <vm>`). Then
`radar-backend --device raid.raw` works against the frozen state. Dumps are as big as the guest's RAM
(sparse where there's no memory). Opening the QEMU process's memory
needs root or the QEMU process's user. The privilege model is still an open decision (`docs/design.md`).

## Offsets

`game/eft/offsets/eft.offsets.json` is the single source of truth. At build time
`cmake/gen_offsets.py` turns it into `build/generated/eft_offsets.hpp` (`off::<Group>::<Name>`
constants). Nothing is read at runtime. The initial values are live-EFT reference values; refresh
them for another game build with `il2cpp-dump` and `tools/update-offsets.py` (`docs/offset-tools.md`). The `build` section holds the PE fingerprints of the game build the offsets belong to:
`null` until verified. On attach, a mismatch is logged as a warning only.
