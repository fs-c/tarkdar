#!/usr/bin/env python3
"""Large/binary repo files, kept in a content-addressed store instead of git (or git-lfs).

`assets.json` (repo root, committed) maps repo-relative paths to content
hashes. The files themselves are gitignored and live in the store under their
content address, `<prefix><sha[:2]>/<sha256>`. Blobs are immutable and never
overwritten, so any commit's manifest can be pulled later.

    tools/assets.py status [PATH...]        missing / behind / modified / conflict / new
    tools/assets.py pull   [PATH...]        download missing and behind files (locally
                                              modified ones are skipped unless --force)
    tools/assets.py add    PATH...          hash + upload + record files/dirs
    tools/assets.py push   [PATH...]        re-add every locally modified tracked file
                                              (and new files matching "track"),
                                              upload any blob the store lacks
    tools/assets.py resolve PATH... --ours|--theirs
                                            settle a conflict (changed here and in the
                                              manifest): keep mine / take the manifest's
    tools/assets.py trash  [--restore PATH... [--from TS]] [--empty [--older-than DAYS]]
                                            local files replaced by pull/resolve are moved
                                              to .assets-trash/, never deleted
    tools/assets.py rm     PATH...          stop tracking (keeps local + remote)
    tools/assets.py verify                  check the store has every blob
    tools/assets.py gc     [--delete]       blobs no commit's manifest references

Each working copy remembers the hash it last synced per path (`.assets-base.json`,
gitignored). Comparing the file with both that and the manifest tells a local
edit from a manifest that moved on (git pull), so neither gets overwritten.

Shared dirs (manifest "shared", e.g. recordings/) are for files that need no
versioning: unique names, never changed. They live in the store as plain files
under `shared/<repo path>` and never appear in the manifest, so adding one
needs no commit. `pull` also fetches shared files missing locally.

    tools/assets.py share   PATH...         upload files (never overwrites)
    tools/assets.py unshare PATH...         delete them from the store
    tools/assets.py shared  [PATH...]       list: in the store, here, or both

PATH arguments are files, directories or prefixes (relative to the current
directory); they filter which manifest entries a command touches.

The store (needed for every network command) is ASSETS_REMOTE, an rclone path:
a local directory on the machine that hosts it, an sftp remote such as
`hub:/home/me/tarkdar-assets` elsewhere, or any other rclone backend. Set it in
the environment or in `.assets.env` (KEY=VALUE lines, gitignored) at the repo
root. rclone comes from mise.toml (override the binary with RCLONE).

Python standard library + the rclone binary (Python 3.13+ for PurePath.full_match).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets.json"
ENV_FILE = ROOT / ".assets.env"
MANIFEST_VERSION = 1
JOBS = 8
CHUNK = 1 << 20
BASE_FILE = ROOT / ".assets-base.json"  # per working copy (the hash cache is shared by worktrees, this is not)
TRASH = ROOT / ".assets-trash"  # same filesystem as the work tree, so trashing is a rename
STAMP_FORMAT = "%Y%m%dT%H%M%SZ"
STAGING = ROOT / ".assets-staging"  # same filesystem as the work tree, so pulls can rename
SHARED_PREFIX = "shared/"  # store area for shared dirs: plain files under their repo path, no manifest entries
TEMP_SUFFIXES = (".tmp", ".assets-tmp")  # in-flight files, never published


def die(msg: str) -> None:
    print(f"assets: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def load_manifest() -> dict:
    if not MANIFEST.exists():
        die(f"{MANIFEST.name} not found")
    text = MANIFEST.read_text()
    if any(line.startswith(("<<<<<<<", "=======", ">>>>>>>")) for line in text.splitlines()):
        die(f"{MANIFEST.name} has merge conflict markers: resolve them first")
    try:
        m = json.loads(text)
    except json.JSONDecodeError as e:
        die(f"{MANIFEST.name}: invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
    if m.get("version") != MANIFEST_VERSION:
        die(f"{MANIFEST.name}: unsupported version {m.get('version')}")
    m.setdefault("store", {"prefix": "sha256/"})
    m.setdefault("track", [])
    m.setdefault("files", {})
    m["shared"] = [d.strip("/") for d in m.get("shared", [])]
    if m["store"].get("prefix", "").startswith(SHARED_PREFIX):
        die(f"{MANIFEST.name}: store prefix must not start with {SHARED_PREFIX!r}")
    return m


def shared_dir(m: dict, rel: str) -> str | None:
    """The shared dir containing `rel` (or equal to it), if any."""
    return next((d for d in m["shared"] if rel == d or rel.startswith(d + "/")), None)


def save_manifest(m: dict) -> None:
    """One line per file, sorted: small, stable git diffs."""
    head = {k: v for k, v in m.items() if k != "files"}
    lines = ["{"]
    for k in sorted(head):
        lines.append(f' {json.dumps(k)}: {json.dumps(head[k], sort_keys=True)},')
    lines.append(' "files": {')
    items = sorted(m["files"].items())
    for i, (path, e) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        lines.append(f'  {json.dumps(path)}: {json.dumps(e, sort_keys=True)}{comma}')
    lines.append(" }")
    lines.append("}")
    tmp = MANIFEST.with_suffix(".json.tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.replace(MANIFEST)


def blob_key(m: dict, sha: str) -> str:
    return f"{m['store'].get('prefix', '')}{sha[:2]}/{sha}"


def matches_track(m: dict, rel: str) -> bool:
    """`track` globs ('**' allowed); a leading '!' excludes. Last match wins."""
    p = PurePosixPath(rel)
    hit = False
    for pat in m["track"]:
        neg = pat.startswith("!")
        if p.full_match(pat[1:] if neg else pat):
            hit = not neg
    return hit


# ---------------------------------------------------------------------------
# Paths, hashing
# ---------------------------------------------------------------------------

def to_rel(arg: str) -> str:
    p = (Path.cwd() / arg).resolve()
    try:
        rel = p.relative_to(ROOT).as_posix()
    except ValueError:
        die(f"{arg} is outside the repository")
    return "" if rel == "." else rel


def selected(paths: list[str], rel: str) -> bool:
    return not paths or any(rel == p or rel.startswith(p.rstrip("/") + "/") or p == "" for p in paths)


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


class HashCache:
    """(size, mtime_ns) -> sha256 per path, kept in .git so status stays fast."""

    def __init__(self):
        try:
            gd = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True,
                                text=True, check=True).stdout.strip()
            self.path = (ROOT / gd / "assets-hashes.json").resolve()
        except (OSError, subprocess.CalledProcessError):
            self.path = ROOT / ".assets-hashes.json"
        try:
            self.data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.data = {}
        self.dirty = False
        self.lock = threading.Lock()

    def sha256(self, rel: str) -> tuple[str, int]:
        p = ROOT / rel
        st = p.stat()
        key = [st.st_size, st.st_mtime_ns]
        with self.lock:
            hit = self.data.get(rel)
        if hit and hit[:2] == key:
            return hit[2], st.st_size
        sha = hash_file(p)
        with self.lock:
            self.data[rel] = key + [sha]
            self.dirty = True
        return sha, st.st_size

    def save(self):
        if self.dirty:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, sort_keys=True))
            tmp.replace(self.path)


class SyncBase:
    """{path: sha256 this working copy last synced}: set when pull downloads a file, push publishes one,
    or a file is seen equal to the manifest. Without an entry, a differing file is "unbased"."""

    def __init__(self):
        try:
            self.data = json.loads(BASE_FILE.read_text())
        except (OSError, ValueError):
            self.data = {}
        self.dirty = False

    def get(self, rel: str) -> str | None:
        return self.data.get(rel)

    def set(self, rel: str, sha: str) -> None:
        if self.data.get(rel) != sha:
            self.data[rel] = sha
            self.dirty = True

    def forget(self, rel: str) -> None:
        if self.data.pop(rel, None) is not None:
            self.dirty = True

    def hashes(self) -> set[str]:
        return set(self.data.values())

    def save(self) -> None:
        if self.dirty:
            tmp = BASE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, sort_keys=True, indent=0))
            tmp.replace(BASE_FILE)
            self.dirty = False


def sync_state(local: str | None, base: str | None, manifest: str | None) -> str:
    """State of one path from three hashes: L local file, B base (last synced), M manifest.

        L missing                   missing   pull downloads it
        no manifest entry           new       push adds it
        L == M                      ok
        no B (L != M)               unbased   treated as modified, pull skips it unless --force
        L == B (M != B)             behind    manifest moved, local is clean: pull updates it, push skips it
        M == B (L != B)             modified  local edit: push publishes it, pull leaves it
        otherwise                   conflict  both changed: resolve --ours/--theirs
    """
    if local is None:
        return "missing"
    if manifest is None:
        return "new"
    if local == manifest:
        return "ok"
    if base is None:
        return "unbased"
    if local == base:
        return "behind"
    if manifest == base:
        return "modified"
    return "conflict"


def local_state(hc: HashCache, base: SyncBase, rel: str, entry: dict | None) -> str:
    """sync_state for a path on disk; a file seen equal to the manifest becomes the new base."""
    local = hc.sha256(rel)[0] if (ROOT / rel).is_file() else None
    manifest = entry["sha256"] if entry else None
    state = sync_state(local, base.get(rel), manifest)
    if state == "ok":
        base.set(rel, local)
    return state


def note_unbased(count: int) -> None:
    if count:
        print(f"note: {count} files differ from the manifest and have no sync record (first run of this version, "
              "or a fresh checkout), so they count as locally modified; `pull --force` takes the manifest's "
              "versions, `resolve --ours` keeps yours")


def trash_file(rel: str) -> None:
    """Move a local file into .assets-trash/<UTC timestamp>/<rel> (a rename; a copy only across devices)."""
    stamp = datetime.now(timezone.utc).strftime(STAMP_FORMAT)
    dest = TRASH / stamp / rel
    n = 0
    while dest.exists():
        n += 1
        dest = TRASH / f"{stamp}-{n}" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(ROOT / rel, dest)
    print(f"moved your {rel} to {dest.relative_to(ROOT)} (get it back: assets.py trash --restore {rel})")


def make_room(rel: str, new_sha: str, base: SyncBase) -> None:
    """Call before overwriting `rel` with content `new_sha`: a file that exists only here goes to the trash.

    Not trashed: identical content, or the hash this copy last synced (the store has that blob, and
    gc keeps it). Hashed afresh, not through the cache: this is the last line of defence."""
    p = ROOT / rel
    if not p.is_file():
        return
    sha = hash_file(p)
    if sha != new_sha and sha != base.get(rel):
        trash_file(rel)


def walk_files(rel: str) -> list[str]:
    p = ROOT / rel
    if p.is_file():
        return [rel]
    if p.is_dir():
        return sorted(q.relative_to(ROOT).as_posix() for q in p.rglob("*") if q.is_file())
    return []


def track_candidates(m: dict, paths: list[str]) -> list[str]:
    """Existing files matching the manifest's track globs (within `paths`)."""
    roots = set()
    for pat in m["track"]:
        if pat.startswith("!"):
            continue
        parts = []
        for part in PurePosixPath(pat).parts:
            if any(c in part for c in "*?["):
                break
            parts.append(part)
        roots.add("/".join(parts))
    out = set()
    for r in roots:
        for rel in walk_files(r):
            if matches_track(m, rel) and selected(paths, rel):
                out.add(rel)
    return sorted(out)


# ---------------------------------------------------------------------------
# Store: an rclone path (local directory, sftp remote, any rclone backend)
# ---------------------------------------------------------------------------

class StoreError(Exception):
    pass


def _env() -> dict:
    env = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


class Store:
    """Blobs under `<ASSETS_REMOTE>/<prefix><sha[:2]>/<sha>`, moved in bulk by rclone."""

    def __init__(self, m: dict):
        env = _env()
        loc = env.get("ASSETS_REMOTE")
        if not loc:
            die("no asset store configured: set ASSETS_REMOTE to an rclone path, e.g. a local directory "
                f"or 'hub:/srv/tarkdar-assets' (environment or {ENV_FILE.name}; see README)")
        self.name = loc
        self.root = os.path.expanduser(loc) if loc.startswith("~") else loc
        self.prefix = m["store"].get("prefix", "")
        self.rclone = env.get("RCLONE") or shutil.which("rclone")
        if not self.rclone:
            die("rclone not found (it is in mise.toml: run `mise install`)")

    def _path(self, sub: str = "") -> str:
        sub = sub.strip("/")
        if not sub:
            return self.root
        return self.root + sub if self.root.endswith((":", "/")) else f"{self.root}/{sub}"

    def _run(self, *args: str, stdin: str | None = None, capture: bool = False, progress: bool = False):
        cmd = [self.rclone, *args]
        if progress and sys.stdout.isatty():
            cmd += ["--progress", "--stats-one-line"]
        try:
            return subprocess.run(cmd, cwd=ROOT, input=stdin, text=True, stdout=subprocess.PIPE if capture else None,
                                  stderr=subprocess.PIPE if capture else None)
        except OSError as e:
            raise StoreError(f"running rclone: {e}") from None

    def keys(self) -> set[str]:
        r = self._run("lsf", "-R", "--files-only", self._path(self.prefix), capture=True)
        if r.returncode == 3:  # directory not found: empty store
            return set()
        if r.returncode:
            raise StoreError(f"listing {self.name}: {r.stderr.strip()}")
        # With an empty prefix the blobs share the root with shared/: never count those as blobs (gc!).
        return {self.prefix + line for line in r.stdout.splitlines()
                if line and not (self.prefix + line).startswith(SHARED_PREFIX)}

    def shared_files(self, dirs: list[str]) -> dict[str, int]:
        """{repo-relative path: size} of everything under shared/<dir>/ for each shared dir."""
        out: dict[str, int] = {}
        for d in dirs:
            r = self._run("lsf", "-R", "--files-only", "--format", "sp", "--separator", "\t",
                          self._path(SHARED_PREFIX + d), capture=True)
            if r.returncode == 3:  # nothing shared yet
                continue
            if r.returncode:
                raise StoreError(f"listing {self.name}: {r.stderr.strip()}")
            for line in r.stdout.splitlines():
                size, _, rel = line.partition("\t")
                if rel:
                    out[f"{d}/{rel}"] = int(size)
        return out

    def put_shared(self, rels: list[str]) -> None:
        """Upload repo files to shared/<same path>, never overwriting."""
        r = self._run("copy", "--files-from-raw", "-", "--ignore-existing", "--transfers", str(JOBS),
                      str(ROOT), self._path(SHARED_PREFIX), stdin="\n".join(rels) + "\n", progress=True)
        if r.returncode:
            raise StoreError(f"rclone copy to {self.name} failed (exit {r.returncode})")

    def get_shared(self, rels: list[str]) -> None:
        """Download shared/<path> to the same repo path; existing local files are left alone."""
        r = self._run("copy", "--files-from-raw", "-", "--ignore-existing", "--transfers", str(JOBS),
                      self._path(SHARED_PREFIX), str(ROOT), stdin="\n".join(rels) + "\n", progress=True)
        if r.returncode:
            print(f"assets: rclone copy from {self.name} reported errors (exit {r.returncode})", file=sys.stderr)

    def delete_shared(self, rels: list[str]) -> None:
        r = self._run("delete", "--files-from-raw", "-", self._path(SHARED_PREFIX), stdin="\n".join(rels) + "\n")
        if r.returncode:
            raise StoreError(f"rclone delete in {self.name} failed (exit {r.returncode})")

    def put(self, blobs: dict[str, Path]) -> None:
        """Upload {key: local file}. Staged as symlinks so one rclone call does it all."""
        if not blobs:
            return
        with tempfile.TemporaryDirectory(prefix="assets-") as stage:
            for key, src in blobs.items():
                link = Path(stage) / key
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(src.resolve())
            r = self._run("copy", "--copy-links", "--ignore-existing", "--transfers", str(JOBS),
                          stage, self.root, progress=True)
        if r.returncode:
            raise StoreError(f"rclone copy to {self.name} failed (exit {r.returncode})")

    def get(self, keys: list[str], dest: Path) -> None:
        """Download keys into dest/<key>; missing ones are simply absent afterwards."""
        r = self._run("copy", "--files-from-raw", "-", "--transfers", str(JOBS), self.root, str(dest),
                      stdin="\n".join(keys) + "\n", progress=True)
        if r.returncode:
            print(f"assets: rclone copy from {self.name} reported errors (exit {r.returncode})", file=sys.stderr)

    def delete(self, keys: list[str]) -> None:
        if not keys:
            return
        r = self._run("delete", "--files-from-raw", "-", self.root, stdin="\n".join(keys) + "\n")
        if r.returncode:
            raise StoreError(f"rclone delete in {self.name} failed (exit {r.returncode})")


def fmt_size(n: float) -> str:
    if n < 1000:
        return f"{n:.0f} B"
    for unit in ("KB", "MB"):
        n /= 1000
        if n < 1000:
            return f"{n:.1f} {unit}"
    return f"{n / 1000:.1f} GB"


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def git_tracked(rels: list[str]) -> set[str]:
    if not rels:
        return set()
    try:
        out = subprocess.run(["git", "ls-files", "-z", "--", *rels], cwd=ROOT, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return set()
    return {p for p in out.decode().split("\0") if p}


def cmd_status(args) -> int:
    m = load_manifest()
    hc = HashCache()
    base = SyncBase()
    paths = [to_rel(p) for p in args.paths]
    states: dict[str, list[str]] = {"conflict": [], "behind": [], "modified": [], "missing": [], "new": []}
    ok = 0
    unbased = 0
    entries = {r: e for r, e in m["files"].items() if selected(paths, r)}
    with cf.ThreadPoolExecutor(JOBS) as ex:
        for rel, st in zip(entries, ex.map(lambda r: local_state(hc, base, r, entries[r]), entries)):
            if st == "ok":
                ok += 1
                continue
            if st == "unbased":
                unbased += 1
                st = "modified"
            states[st].append(rel)
    for rel in track_candidates(m, paths):
        if rel not in m["files"]:
            states["new"].append(rel)
    hc.save()
    base.save()
    print(f"{ok} up to date")
    hints = {"conflict": "changed here and in the manifest: resolve PATH --ours (keep yours, then push) or --theirs",
             "behind": "the manifest has a newer version, yours is unchanged: run pull",
             "modified": "local edits: push to publish, pull --force to discard (kept in .assets-trash/)",
             "missing": "run pull",
             "new": "matches track globs, not in manifest: push to add"}
    for st, rels in states.items():
        if rels:
            print(f"{len(rels)} {st} ({hints[st]}):")
            for rel in rels[: args.limit]:
                print(f"  {rel}")
            if len(rels) > args.limit:
                print(f"  ... and {len(rels) - args.limit} more")
    note_unbased(unbased)
    leaked = git_tracked(list(entries))
    if leaked:
        print(f"warning: {len(leaked)} managed files are also tracked by git (git rm --cached them):")
        for rel in sorted(leaked)[: args.limit]:
            print(f"  {rel}")
    pending = states["conflict"] or states["behind"] or states["modified"] or states["missing"]
    return 1 if args.check and pending else 0


def cmd_pull(args) -> int:
    m = load_manifest()
    hc = HashCache()
    base = SyncBase()
    paths = [to_rel(p) for p in args.paths]
    todo, skipped, conflicts, unbased = [], [], [], []
    for rel, e in sorted(m["files"].items()):
        if not selected(paths, rel):
            continue
        st = local_state(hc, base, rel, e)
        if st in ("missing", "behind") or (args.force and st in ("modified", "unbased", "conflict")):
            todo.append((rel, e))
        elif st == "conflict":
            conflicts.append(rel)
        elif st == "modified":
            skipped.append(rel)
        elif st == "unbased":
            unbased.append(rel)
    hc.save()
    base.save()
    for rel in skipped:
        print(f"skip (locally modified, use --force): {rel}")
    for rel in unbased:
        print(f"skip (differs from the manifest, no sync record, use --force): {rel}")
    for rel in conflicts:
        print(f"conflict (changed here and in the manifest; keep yours: resolve {rel} --ours, "
              f"take the manifest's: resolve {rel} --theirs): {rel}")
    note_unbased(len(unbased))
    blocked = 1 if conflicts else 0
    shared = [d for d in m["shared"] if selected(paths, d) or any(shared_dir(m, p) == d for p in paths)]
    if not todo and not shared:
        print("nothing to download")
        return blocked
    store = Store(m)
    failed = _pull_blobs(m, store, todo, base) if todo else 0
    if shared:
        failed += _pull_shared(m, store, shared, paths)
    return 1 if failed or blocked else 0


def _pull_blobs(m: dict, store: Store, todo: list[tuple[str, dict]], base: SyncBase) -> int:
    """Download and install the manifest version of each path (a differing local file goes to the trash)."""
    total = sum(e["size"] for _, e in todo)
    print(f"downloading {len(todo)} files, {fmt_size(total)}")
    by_sha: dict[str, list[str]] = {}
    for rel, e in todo:
        by_sha.setdefault(e["sha256"], []).append(rel)
    shutil.rmtree(STAGING, ignore_errors=True)
    STAGING.mkdir()
    errors: list[tuple[str, str]] = []
    try:
        store.get([blob_key(m, sha) for sha in by_sha], STAGING)
        for sha, rels in by_sha.items():
            staged = STAGING / blob_key(m, sha)
            if not staged.is_file():
                errors += [(rel, f"blob {sha[:12]} not in store") for rel in rels]
                continue
            if hash_file(staged) != sha:
                errors += [(rel, "hash mismatch after download") for rel in rels]
                continue
            for i, rel in enumerate(rels):  # several paths may share a blob: copy, then move the last
                dest = ROOT / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                make_room(rel, sha, base)
                if i < len(rels) - 1:
                    tmp = dest.with_name(dest.name + ".assets-tmp")
                    shutil.copyfile(staged, tmp)
                    tmp.replace(dest)
                else:
                    staged.replace(dest)
                base.set(rel, sha)
    except StoreError as e:
        die(str(e))
    finally:
        shutil.rmtree(STAGING, ignore_errors=True)
        base.save()
    for rel, e in errors:
        print(f"error: {rel}: {e}", file=sys.stderr)
    print(f"downloaded {len(todo) - len(errors)} files" + (f", {len(errors)} failed" if errors else ""))
    return len(errors)


def _pull_shared(m: dict, store: Store, dirs: list[str], paths: list[str]) -> int:
    """Download shared files that don't exist locally. Names are unique, so existing ones are kept."""
    try:
        remote = {r: s for r, s in store.shared_files(dirs).items() if selected(paths, r)}
    except StoreError as e:
        die(str(e))
    todo, differs = [], []
    for rel, size in sorted(remote.items()):
        p = ROOT / rel
        if not p.is_file():
            todo.append(rel)
        elif p.stat().st_size != size:
            differs.append(rel)
    for rel in differs:
        print(f"skip (local file differs from the shared one, kept): {rel}")
    if not todo:
        print(f"shared ({', '.join(d + '/' for d in dirs)}): nothing to download")
        return 0
    print(f"downloading {len(todo)} shared files, {fmt_size(sum(remote[r] for r in todo))}")
    store.get_shared(todo)
    failed = [r for r in todo if not ((ROOT / r).is_file() and (ROOT / r).stat().st_size == remote[r])]
    for rel in failed:
        print(f"error: {rel}: download failed", file=sys.stderr)
    print(f"downloaded {len(todo) - len(failed)} shared files" + (f", {len(failed)} failed" if failed else ""))
    return len(failed)


def _publish(m: dict, rels: list[str], dry_run: bool, base: SyncBase) -> int:
    """Hash, upload whatever blobs the store lacks, record changes in the manifest.

    Paths that are behind (the manifest moved on) or in conflict are left out: publishing them
    would write an older hash over a teammate's update."""
    in_shared = [r for r in rels if shared_dir(m, r)]
    if in_shared:
        die(f"{in_shared[0]} is in a shared dir ({shared_dir(m, in_shared[0])}/): use `share` for it"
            + (" (and keep the track globs out of shared dirs)" if len(in_shared) > 1 else ""))
    hc = HashCache()
    hashed, conflicts, unbased = [], [], []
    for rel in rels:
        sha, size = hc.sha256(rel)
        e = m["files"].get(rel)
        st = sync_state(sha, base.get(rel), e["sha256"] if e else None)
        if st == "behind":
            print(f"skip (behind: the manifest has a newer version, run pull): {rel}")
            continue
        if st == "conflict":
            conflicts.append(rel)
            print(f"conflict (changed here and in the manifest; keep yours: resolve {rel} --ours, "
                  f"take the manifest's: resolve {rel} --theirs): {rel}")
            continue
        if st == "ok":
            base.set(rel, sha)
        elif st == "unbased":
            unbased.append(rel)
        hashed.append((rel, sha, size))
    hc.save()
    base.save()
    note_unbased(len(unbased))
    blocked = 1 if conflicts else 0
    changed = [(rel, sha, size) for rel, sha, size in hashed
               if (e := m["files"].get(rel)) is None or e["sha256"] != sha]
    if dry_run:
        print(f"{len(changed)} files to record, {fmt_size(sum(s for _, _, s in changed))}")
        for rel, _, size in changed:
            print(f"  {rel} ({fmt_size(size)})")
        return blocked
    if not hashed:
        print("nothing to publish")
        return blocked
    store = Store(m)
    try:
        present = store.keys()
        todo = {}
        for rel, sha, size in hashed:
            key = blob_key(m, sha)
            if key not in present and key not in todo:
                todo[key] = (ROOT / rel, size)
        if not changed and not todo:
            print("nothing to publish")
            return blocked
        print(f"{len(changed)} files to record; uploading {len(todo)} blobs, "
              f"{fmt_size(sum(s for _, s in todo.values()))}")
        failure = None
        try:
            store.put({k: p for k, (p, _) in todo.items()})
        except StoreError as e:
            failure = e
        present = store.keys() if todo else present
    except StoreError as e:
        die(str(e))
    failed = [rel for rel, sha, _ in changed if blob_key(m, sha) not in present]
    for rel, sha, size in changed:
        if rel not in failed:
            m["files"][rel] = {"sha256": sha, "size": size}
    save_manifest(m)  # before the base: a base that runs ahead of the manifest would read as "behind"
    for rel, sha, size in changed:
        if rel not in failed:
            base.set(rel, sha)
    base.save()
    uploaded = [s for k, (_, s) in todo.items() if k in present]
    print(f"uploaded {len(uploaded)} blobs ({fmt_size(sum(uploaded))}); manifest updated"
          + (f"; {len(failed)} files not recorded (upload failed)" if failed else ""))
    if failure:
        print(f"error: {failure}", file=sys.stderr)
    for rel in failed:
        print(f"error: {rel}: blob not in store", file=sys.stderr)
    leaked = git_tracked([r for r, _, _ in changed])
    if leaked:
        print(f"note: {len(leaked)} of these are tracked by git; `git rm --cached` them and gitignore the paths")
    return 1 if failure or failed or len(uploaded) < len(todo) or blocked else 0


def cmd_add(args) -> int:
    m = load_manifest()
    rels = []
    for p in args.paths:
        rel = to_rel(p)
        files = walk_files(rel)
        if not files:
            die(f"{p}: no such file or directory")
        rels.extend(f for f in files if not f.endswith(TEMP_SUFFIXES))
    return _publish(m, sorted(set(rels)), args.dry_run, SyncBase())


def cmd_push(args) -> int:
    m = load_manifest()
    base = SyncBase()
    paths = [to_rel(p) for p in args.paths]
    rels = {r for r in m["files"] if selected(paths, r) and (ROOT / r).is_file()}
    rels.update(r for r in track_candidates(m, paths) if not r.endswith(TEMP_SUFFIXES))
    gone = [r for r in m["files"] if selected(paths, r) and not (ROOT / r).is_file()]
    if gone:
        if args.prune:
            for r in gone:
                del m["files"][r]
                base.forget(r)
            print(f"pruned {len(gone)} entries whose files no longer exist")
            if not args.dry_run:
                save_manifest(m)
                base.save()
        else:
            print(f"{len(gone)} tracked files are missing locally (kept; --prune to drop, pull to restore)")
    return _publish(m, sorted(rels), args.dry_run, base)


def cmd_resolve(args) -> int:
    """A conflict is settled by choosing a side. --ours: base = manifest hash, so the file reads as a plain
    local edit and the next push publishes it. --theirs: install the manifest version (yours goes to the trash)."""
    m = load_manifest()
    hc = HashCache()
    base = SyncBase()
    paths = [to_rel(p) for p in args.paths]
    entries = {r: e for r, e in sorted(m["files"].items()) if selected(paths, r)}
    if not entries:
        die("no tracked files match those paths")
    todo = []
    for rel, e in entries.items():
        st = local_state(hc, base, rel, e)
        if st in ("modified", "unbased", "conflict"):
            todo.append((rel, e))
        elif st == "behind":
            print(f"nothing to resolve (behind, your copy is unchanged: run pull): {rel}")
        elif st == "missing":
            print(f"nothing to resolve (missing: run pull): {rel}")
    hc.save()
    if args.ours:
        for rel, e in todo:
            base.set(rel, e["sha256"])
            print(f"keeping yours: {rel} (push publishes it)")
        base.save()
        return 0
    if not todo:
        base.save()
        print("nothing to resolve")
        return 0
    store = Store(m)
    return 1 if _pull_blobs(m, store, todo, base) else 0


def cmd_rm(args) -> int:
    m = load_manifest()
    paths = [to_rel(p) for p in args.paths]
    gone = [r for r in m["files"] if selected(paths, r)]
    base = SyncBase()
    for r in gone:
        del m["files"][r]
        base.forget(r)
    save_manifest(m)
    base.save()
    print(f"removed {len(gone)} entries (local files and remote blobs untouched)")
    tracked = [r for r in gone if (ROOT / r).is_file() and matches_track(m, r)]
    if tracked:
        print(f"warning: {len(tracked)} removed paths still match a \"track\" glob in {MANIFEST.name}, so the "
              "next `push` will add them again; add a \"!<path>\" exclusion to \"track\" to keep them out:",
              file=sys.stderr)
        for r in tracked[:10]:
            print(f"  {r}", file=sys.stderr)
        if len(tracked) > 10:
            print(f"  ... and {len(tracked) - 10} more", file=sys.stderr)
    return 0


def _shared_args(m: dict, args_paths: list[str]) -> list[str]:
    paths = [to_rel(p) for p in args_paths]
    if not m["shared"]:
        die(f"no shared dirs configured ({MANIFEST.name} \"shared\")")
    for p, arg in zip(paths, args_paths):
        if not shared_dir(m, p):
            die(f"{arg} is not in a shared dir ({', '.join(d + '/' for d in m['shared'])})")
    return paths


def cmd_share(args) -> int:
    m = load_manifest()
    paths = _shared_args(m, args.paths)
    rels = []
    for p, arg in zip(paths, args.paths):
        files = walk_files(p)
        if not files:
            die(f"{arg}: no such file or directory")
        rels.extend(f for f in files if not f.endswith((".tmp", ".partial")))
    rels = sorted(set(rels))
    managed = [r for r in rels if r in m["files"]]
    if managed:
        die(f"{managed[0]} is in the manifest: `rm` it there first")
    store = Store(m)
    try:
        remote = store.shared_files(sorted({shared_dir(m, r) for r in rels}))
        new = [r for r in rels if r not in remote]
        conflicts = [r for r in rels if r in remote and remote[r] != (ROOT / r).stat().st_size]
        if args.dry_run:
            print(f"{len(new)} files to share, {fmt_size(sum((ROOT / r).stat().st_size for r in new))}")
            for rel in new:
                print(f"  {rel}")
        elif new:
            print(f"sharing {len(new)} files, {fmt_size(sum((ROOT / r).stat().st_size for r in new))}")
            store.put_shared(new)
            remote = store.shared_files(sorted({shared_dir(m, r) for r in new}))
    except StoreError as e:
        die(str(e))
    for rel in conflicts:
        print(f"error: {rel}: a different file with this name is already shared (rename yours, or unshare it)",
              file=sys.stderr)
    if args.dry_run:
        return 1 if conflicts else 0
    failed = [r for r in new if remote.get(r) != (ROOT / r).stat().st_size]
    for rel in failed:
        print(f"error: {rel}: upload failed", file=sys.stderr)
    already = len(rels) - len(new) - len(conflicts)
    print(f"shared {len(new) - len(failed)} files" + (f", {already} already shared" if already else "")
          + (f", {len(failed)} failed" if failed else ""))
    return 1 if conflicts or failed else 0


def cmd_unshare(args) -> int:
    m = load_manifest()
    paths = _shared_args(m, args.paths)
    store = Store(m)
    try:
        remote = store.shared_files(sorted({shared_dir(m, p) for p in paths}))
        gone = sorted(r for r in remote if selected(paths, r))
        if not gone:
            print("nothing shared under these paths")
            return 0
        if args.dry_run:
            print(f"{len(gone)} files to unshare:")
        else:
            store.delete_shared(gone)
            print(f"unshared {len(gone)} files (local copies untouched):")
    except StoreError as e:
        die(str(e))
    for rel in gone:
        print(f"  {rel}")
    return 0


def cmd_shared(args) -> int:
    m = load_manifest()
    paths = [to_rel(p) for p in args.paths]
    dirs = [d for d in m["shared"] if selected(paths, d) or any(shared_dir(m, p) == d for p in paths)]
    if not dirs:
        die(f"no shared dirs here (configured: {', '.join(d + '/' for d in m['shared']) or 'none'})")
    store = Store(m)
    try:
        remote = {r: s for r, s in store.shared_files(dirs).items() if selected(paths, r)}
    except StoreError as e:
        die(str(e))
    local = {r for d in dirs for r in walk_files(d) if selected(paths, r) and not r.endswith(".partial")}
    marks = {"both": " ", "remote": "↓", "local": "↑", "differs": "!"}
    rows = []
    for rel in sorted(set(remote) | local):
        if rel not in local:
            st = "remote"
        elif rel not in remote:
            st = "local"
        else:
            st = "both" if (ROOT / rel).stat().st_size == remote[rel] else "differs"
        if st != "local" or args.all:
            rows.append((st, rel))
    for st, rel in rows:
        size = remote.get(rel) or (ROOT / rel).stat().st_size
        print(f"{marks[st]} {rel}  ({fmt_size(size)})")
    n_local = sum(1 for r in local if r not in remote)
    print(f"{len(remote)} shared ({sum(1 for r in remote if r not in local)} not here: pull)"
          + (f"; {n_local} local only (share to publish{'' if args.all else ', --all lists them'})" if n_local else ""))
    return 0


def trash_entries() -> list[tuple[str, str, Path]]:
    """(timestamp, repo path, file) for everything in the trash, newest first."""
    out = []
    if TRASH.is_dir():
        for d in sorted((d for d in TRASH.iterdir() if d.is_dir()), key=lambda d: d.name, reverse=True):
            out.extend((d.name, f.relative_to(d).as_posix(), f) for f in sorted(d.rglob("*")) if f.is_file())
    return out


def stamp_time(stamp: str) -> datetime | None:
    try:
        return datetime.strptime(stamp[:16], STAMP_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def drop_empty_dirs(path: Path) -> None:
    """Remove `path` and its parents up to (and including) the trash dir, while they are empty."""
    while path != ROOT and path.is_relative_to(TRASH):
        try:
            path.rmdir()
        except OSError:
            return
        path = path.parent


def cmd_trash(args) -> int:
    if args.restore and args.empty:
        die("trash: use either --restore or --empty")
    if args.from_ and not args.restore:
        die("trash: --from only goes with --restore")
    if args.older_than is not None and not args.empty:
        die("trash: --older-than only goes with --empty")
    entries = trash_entries()
    if args.restore:
        return _trash_restore(args, entries)
    if args.empty:
        return _trash_empty(args, entries)
    if not entries:
        print("trash is empty")
        return 0
    for stamp, rel, f in entries:
        print(f"{stamp}  {fmt_size(f.stat().st_size):>9}  {rel}")
    print(f"{len(entries)} files, {fmt_size(sum(f.stat().st_size for _, _, f in entries))} in {TRASH.name}/ "
          "(trash --restore PATH [--from TIMESTAMP] puts one back; trash --empty frees the space)")
    return 0


def _trash_restore(args, entries: list[tuple[str, str, Path]]) -> int:
    paths = [to_rel(p) for p in args.restore]
    newest: dict[str, tuple[str, Path]] = {}  # entries are newest first
    for stamp, rel, f in entries:
        if selected(paths, rel) and (not args.from_ or stamp.startswith(args.from_)):
            newest.setdefault(rel, (stamp, f))
    if not newest:
        die("nothing in the trash matches (list it with `trash`)")
    base = SyncBase()
    for rel, (stamp, f) in sorted(newest.items()):
        make_room(rel, hash_file(f), base)  # a different file in the way is trashed first
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(f, dest)
        drop_empty_dirs(f.parent)
        print(f"restored {rel} (from {stamp}); `status` shows where it stands")
    return 0


def _trash_empty(args, entries: list[tuple[str, str, Path]]) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.older_than or 0)
    dirs = sorted({TRASH / stamp for stamp, _, _ in entries})
    doomed = []
    for d in dirs:
        when = stamp_time(d.name)
        if args.older_than is None or (when is not None and when < cutoff):
            doomed.append(d)
    freed = sum(f.stat().st_size for stamp, _, f in entries if TRASH / stamp in doomed)
    for d in doomed:
        shutil.rmtree(d)
    drop_empty_dirs(TRASH)
    print(f"deleted {len(doomed)} trash entries, freed {fmt_size(freed)}")
    return 0


def cmd_verify(args) -> int:
    m = load_manifest()
    store = Store(m)
    try:
        present = store.keys()
    except StoreError as e:
        die(str(e))
    missing = sorted(r for r, e in m["files"].items() if blob_key(m, e["sha256"]) not in present)
    print(f"{len(m['files']) - len(missing)} / {len(m['files'])} blobs present in {store.name}")
    for r in missing:
        print(f"  missing: {r}")
    return 1 if missing else 0


def cmd_gc(args) -> int:
    m = load_manifest()
    revs = subprocess.run(["git", "rev-list", "--all", "--", MANIFEST.name], cwd=ROOT, capture_output=True,
                          text=True, check=True).stdout.split()
    referenced = {blob_key(m, e["sha256"]) for e in m["files"].values()}  # working copy too
    # Blobs this working copy last synced stay: pull may overwrite a file that equals one without trashing it.
    referenced.update(blob_key(m, sha) for sha in SyncBase().hashes())
    for rev in revs:
        try:
            old = json.loads(subprocess.run(["git", "show", f"{rev}:{MANIFEST.name}"], cwd=ROOT,
                                            capture_output=True, text=True, check=True).stdout)
            referenced.update(blob_key(m, e["sha256"]) for e in old.get("files", {}).values())
        except (subprocess.CalledProcessError, ValueError):
            continue
    store = Store(m)
    try:
        orphans = sorted(store.keys() - referenced)
        print(f"{len(orphans)} blobs not referenced by any of {len(revs)} commits' manifests (or the working copy, or what it last synced)")
        if args.delete:
            store.delete(orphans)
            print(f"deleted {len(orphans)}")
            return 0
    except StoreError as e:
        die(str(e))
    for k in orphans[:20]:
        print(f"  {k}")
    if orphans:
        print("re-run with --delete to remove them (unpushed branches elsewhere may still need them)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("status", help="compare local files with the manifest and the last sync")
    p.add_argument("paths", nargs="*")
    p.add_argument("--limit", type=int, default=20, help="max paths listed per state")
    p.add_argument("--check", action="store_true", help="exit 1 if anything is missing, behind, modified or in conflict")
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser("pull", help="download missing and behind files (with --force, also modified and conflicting ones)")
    p.add_argument("paths", nargs="*")
    p.add_argument("--force", action="store_true", help="take the manifest version of modified/conflicting files (yours goes to .assets-trash/)")
    p.set_defaults(fn=cmd_pull)
    p = sub.add_parser("resolve", help="settle a conflict: keep your file (--ours) or take the manifest's (--theirs)")
    p.add_argument("paths", nargs="+")
    side = p.add_mutually_exclusive_group(required=True)
    side.add_argument("--ours", action="store_true", help="keep the local file; the next push publishes it")
    side.add_argument("--theirs", action="store_true", help="replace the local file with the manifest's (yours is trashed)")
    p.set_defaults(fn=cmd_resolve)
    p = sub.add_parser("trash", help="list, restore or empty the local files replaced by pull/resolve")
    p.add_argument("--restore", nargs="+", metavar="PATH", help="put the newest trashed copy of these paths back")
    p.add_argument("--from", dest="from_", metavar="TIMESTAMP", help="with --restore: a specific entry (prefix is enough)")
    p.add_argument("--empty", action="store_true", help="delete trash entries for good")
    p.add_argument("--older-than", type=float, metavar="DAYS", help="with --empty: only entries older than this")
    p.set_defaults(fn=cmd_trash)
    p = sub.add_parser("add", help="upload files/dirs and record them in the manifest")
    p.add_argument("paths", nargs="+")
    p.add_argument("-n", "--dry-run", action="store_true")
    p.set_defaults(fn=cmd_add)
    p = sub.add_parser("push", help="publish locally modified tracked files and new files matching track globs")
    p.add_argument("paths", nargs="*")
    p.add_argument("--prune", action="store_true", help="drop entries whose local file was deleted")
    p.add_argument("-n", "--dry-run", action="store_true")
    p.set_defaults(fn=cmd_push)
    p = sub.add_parser("rm", help="remove entries from the manifest")
    p.add_argument("paths", nargs="+")
    p.set_defaults(fn=cmd_rm)
    p = sub.add_parser("share", help="upload files in a shared dir (no manifest change)")
    p.add_argument("paths", nargs="+")
    p.add_argument("-n", "--dry-run", action="store_true")
    p.set_defaults(fn=cmd_share)
    p = sub.add_parser("unshare", help="delete shared files from the store (local copies stay)")
    p.add_argument("paths", nargs="+")
    p.add_argument("-n", "--dry-run", action="store_true")
    p.set_defaults(fn=cmd_unshare)
    p = sub.add_parser("shared", help="list shared files: here, in the store, or both")
    p.add_argument("paths", nargs="*")
    p.add_argument("-a", "--all", action="store_true", help="also list local files that are not shared")
    p.set_defaults(fn=cmd_shared)
    p = sub.add_parser("verify", help="check every manifest blob exists in the store")
    p.set_defaults(fn=cmd_verify)
    p = sub.add_parser("gc", help="list (or --delete) blobs no commit references")
    p.add_argument("--delete", action="store_true")
    p.set_defaults(fn=cmd_gc)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
