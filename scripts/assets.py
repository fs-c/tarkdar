#!/usr/bin/env python3
"""Large/binary repo files, kept in a content-addressed store instead of git (or git-lfs).

`assets.json` (repo root, committed) maps repo-relative paths to content
hashes. The files themselves are gitignored and live in the store under their
content address, `<prefix><sha[:2]>/<sha256>`. Blobs are immutable and never
overwritten, so any commit's manifest can be pulled later.

    scripts/assets.py status [PATH...]        what is missing / modified / new
    scripts/assets.py pull   [PATH...]        download missing or outdated files
    scripts/assets.py add    PATH...          hash + upload + record files/dirs
    scripts/assets.py push   [PATH...]        re-add every changed tracked file
                                              (and new files matching "track"),
                                              upload any blob the store lacks
    scripts/assets.py rm     PATH...          stop tracking (keeps local + remote)
    scripts/assets.py verify                  check the store has every blob
    scripts/assets.py gc     [--delete]       blobs no commit's manifest references

Shared dirs (manifest "shared", e.g. recordings/) are for files that need no
versioning: unique names, never changed. They live in the store as plain files
under `shared/<repo path>` and never appear in the manifest, so adding one
needs no commit. `pull` also fetches shared files missing locally.

    scripts/assets.py share   PATH...         upload files (never overwrites)
    scripts/assets.py unshare PATH...         delete them from the store
    scripts/assets.py shared  [PATH...]       list: in the store, here, or both

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
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets.json"
ENV_FILE = ROOT / ".assets.env"
MANIFEST_VERSION = 1
JOBS = 8
CHUNK = 1 << 20
STAGING = ROOT / ".assets-staging"  # same filesystem as the work tree, so pulls can rename
SHARED_PREFIX = "shared/"  # store area for shared dirs: plain files under their repo path, no manifest entries


def die(msg: str) -> None:
    print(f"assets: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def load_manifest() -> dict:
    if not MANIFEST.exists():
        die(f"{MANIFEST.name} not found")
    m = json.loads(MANIFEST.read_text())
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
        h = hashlib.sha256()
        with open(p, "rb") as f:
            while chunk := f.read(CHUNK):
                h.update(chunk)
        sha = h.hexdigest()
        with self.lock:
            self.data[rel] = key + [sha]
            self.dirty = True
        return sha, st.st_size

    def save(self):
        if self.dirty:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, sort_keys=True))
            tmp.replace(self.path)


def file_state(hc: HashCache, rel: str, entry: dict | None) -> str:
    p = ROOT / rel
    if not p.is_file():
        return "missing"
    if entry is None:
        return "new"
    if p.stat().st_size != entry["size"]:
        return "modified"
    return "ok" if hc.sha256(rel)[0] == entry["sha256"] else "modified"


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


def connect(m: dict) -> Store:
    return Store(m)


def fmt_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return ""


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
    paths = [to_rel(p) for p in args.paths]
    states: dict[str, list[str]] = {"missing": [], "modified": [], "new": []}
    ok = 0
    entries = {r: e for r, e in m["files"].items() if selected(paths, r)}
    with cf.ThreadPoolExecutor(JOBS) as ex:
        for rel, st in zip(entries, ex.map(lambda r: file_state(hc, r, entries[r]), entries)):
            if st == "ok":
                ok += 1
            else:
                states[st].append(rel)
    for rel in track_candidates(m, paths):
        if rel not in m["files"]:
            states["new"].append(rel)
    hc.save()
    print(f"{ok} up to date")
    hints = {"missing": "run pull", "modified": "local differs from manifest: push to publish, pull --force to discard",
             "new": "matches track globs, not in manifest: push to add"}
    for st, rels in states.items():
        if rels:
            print(f"{len(rels)} {st} ({hints[st]}):")
            for rel in rels[: args.limit]:
                print(f"  {rel}")
            if len(rels) > args.limit:
                print(f"  ... and {len(rels) - args.limit} more")
    leaked = git_tracked(list(entries))
    if leaked:
        print(f"warning: {len(leaked)} managed files are also tracked by git (git rm --cached them):")
        for rel in sorted(leaked)[: args.limit]:
            print(f"  {rel}")
    return 1 if args.check and (states["missing"] or states["modified"]) else 0


def cmd_pull(args) -> int:
    m = load_manifest()
    hc = HashCache()
    paths = [to_rel(p) for p in args.paths]
    todo, skipped = [], []
    for rel, e in sorted(m["files"].items()):
        if not selected(paths, rel):
            continue
        st = file_state(hc, rel, e)
        if st == "missing" or (st == "modified" and args.force):
            todo.append((rel, e))
        elif st == "modified":
            skipped.append(rel)
    hc.save()
    for rel in skipped:
        print(f"skip (locally modified, use --force): {rel}")
    shared = [d for d in m["shared"] if selected(paths, d) or any(shared_dir(m, p) == d for p in paths)]
    if not todo and not shared:
        print("nothing to download")
        return 0
    store = connect(m)
    failed = _pull_blobs(m, store, todo) if todo else 0
    if shared:
        failed += _pull_shared(m, store, shared, paths)
    return 1 if failed else 0


def _pull_blobs(m: dict, store: Store, todo: list[tuple[str, dict]]) -> int:
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
            h = hashlib.sha256()
            with open(staged, "rb") as f:
                while chunk := f.read(CHUNK):
                    h.update(chunk)
            if h.hexdigest() != sha:
                errors += [(rel, "hash mismatch after download") for rel in rels]
                continue
            for i, rel in enumerate(rels):  # several paths may share a blob: copy, then move the last
                dest = ROOT / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if i < len(rels) - 1:
                    tmp = dest.with_name(dest.name + ".assets-tmp")
                    shutil.copyfile(staged, tmp)
                    tmp.replace(dest)
                else:
                    staged.replace(dest)
    except StoreError as e:
        die(str(e))
    finally:
        shutil.rmtree(STAGING, ignore_errors=True)
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


def _publish(m: dict, rels: list[str], dry_run: bool) -> int:
    """Hash, upload whatever blobs the store lacks, record changes in the manifest."""
    in_shared = [r for r in rels if shared_dir(m, r)]
    if in_shared:
        die(f"{in_shared[0]} is in a shared dir ({shared_dir(m, in_shared[0])}/): use `share` for it"
            + (" (and keep the track globs out of shared dirs)" if len(in_shared) > 1 else ""))
    hc = HashCache()
    hashed = []
    for rel in rels:
        sha, size = hc.sha256(rel)
        hashed.append((rel, sha, size))
    hc.save()
    changed = [(rel, sha, size) for rel, sha, size in hashed
               if (e := m["files"].get(rel)) is None or e["sha256"] != sha]
    if dry_run:
        print(f"{len(changed)} files to record, {fmt_size(sum(s for _, _, s in changed))}")
        for rel, _, size in changed:
            print(f"  {rel} ({fmt_size(size)})")
        return 0
    if not hashed:
        print("nothing to publish")
        return 0
    store = connect(m)
    try:
        present = store.keys()
        todo = {}
        for rel, sha, size in hashed:
            key = blob_key(m, sha)
            if key not in present and key not in todo:
                todo[key] = (ROOT / rel, size)
        if not changed and not todo:
            print("nothing to publish")
            return 0
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
    save_manifest(m)
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
    return 1 if failure or failed or len(uploaded) < len(todo) else 0


def cmd_add(args) -> int:
    m = load_manifest()
    rels = []
    for p in args.paths:
        rel = to_rel(p)
        files = walk_files(rel)
        if not files:
            die(f"{p}: no such file or directory")
        rels.extend(f for f in files if not f.endswith((".tmp", ".assets-tmp")))
    return _publish(m, sorted(set(rels)), args.dry_run)


def cmd_push(args) -> int:
    m = load_manifest()
    paths = [to_rel(p) for p in args.paths]
    rels = {r for r in m["files"] if selected(paths, r) and (ROOT / r).is_file()}
    rels.update(track_candidates(m, paths))
    gone = [r for r in m["files"] if selected(paths, r) and not (ROOT / r).is_file()]
    if gone:
        if args.prune:
            for r in gone:
                del m["files"][r]
            print(f"pruned {len(gone)} entries whose files no longer exist")
            if not args.dry_run:
                save_manifest(m)
        else:
            print(f"{len(gone)} tracked files are missing locally (kept; --prune to drop, pull to restore)")
    return _publish(m, sorted(rels), args.dry_run)


def cmd_rm(args) -> int:
    m = load_manifest()
    paths = [to_rel(p) for p in args.paths]
    gone = [r for r in m["files"] if selected(paths, r)]
    for r in gone:
        del m["files"][r]
    save_manifest(m)
    print(f"removed {len(gone)} entries (local files and remote blobs untouched)")
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
    store = connect(m)
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
    store = connect(m)
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
    store = connect(m)
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


def cmd_verify(args) -> int:
    m = load_manifest()
    store = connect(m)
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
    for rev in revs:
        try:
            old = json.loads(subprocess.run(["git", "show", f"{rev}:{MANIFEST.name}"], cwd=ROOT,
                                            capture_output=True, text=True, check=True).stdout)
            referenced.update(blob_key(m, e["sha256"]) for e in old.get("files", {}).values())
        except (subprocess.CalledProcessError, ValueError):
            continue
    store = connect(m)
    try:
        orphans = sorted(store.keys() - referenced)
        print(f"{len(orphans)} blobs not referenced by any of {len(revs)} commits' manifests (or the working copy)")
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
    p = sub.add_parser("status", help="compare local files with the manifest")
    p.add_argument("paths", nargs="*")
    p.add_argument("--limit", type=int, default=20, help="max paths listed per state")
    p.add_argument("--check", action="store_true", help="exit 1 if anything is missing or modified")
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser("pull", help="download missing (or, with --force, locally modified) files")
    p.add_argument("paths", nargs="*")
    p.add_argument("--force", action="store_true", help="overwrite locally modified files")
    p.set_defaults(fn=cmd_pull)
    p = sub.add_parser("add", help="upload files/dirs and record them in the manifest")
    p.add_argument("paths", nargs="+")
    p.add_argument("-n", "--dry-run", action="store_true")
    p.set_defaults(fn=cmd_add)
    p = sub.add_parser("push", help="publish changed tracked files and new files matching track globs")
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
