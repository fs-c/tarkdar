#!/usr/bin/env python3
"""Large/binary repo files, stored in Backblaze B2 instead of git (or git-lfs).

`assets.json` (repo root, committed) maps repo-relative paths to content
hashes. The files themselves are gitignored and live in a B2 bucket under
their content address, `<prefix><sha[:2]>/<sha256>`. Blobs are immutable and
never overwritten, so any commit's manifest can be pulled later.

    scripts/assets.py status [PATH...]        what is missing / modified / new
    scripts/assets.py pull   [PATH...]        download missing or outdated files
    scripts/assets.py add    PATH...          hash + upload + record files/dirs
    scripts/assets.py push   [PATH...]        re-add every changed tracked file
                                              (and new files matching "track")
    scripts/assets.py rm     PATH...          stop tracking (keeps local + remote)
    scripts/assets.py verify                  check the bucket has every blob
    scripts/assets.py gc     [--delete]       blobs no commit's manifest references

PATH arguments are files, directories or prefixes (relative to the current
directory); they filter which manifest entries a command touches.

Credentials (needed for every network command): B2_APPLICATION_KEY_ID and
B2_APPLICATION_KEY in the environment, or in `.assets.env` (KEY=VALUE lines,
gitignored) at the repo root. A key restricted to the bucket is enough;
`gc --delete` additionally needs deleteFiles.

Standard library only (Python 3.13+ for PurePath.full_match), so it runs before any venv exists.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets.json"
ENV_FILE = ROOT / ".assets.env"
MANIFEST_VERSION = 1
# Overridable for tests (a local mock of the B2 API).
AUTH_URL = os.environ.get("ASSETS_B2_AUTH_URL", "https://api.backblazeb2.com/b2api/v3/b2_authorize_account")
JOBS = 8
CHUNK = 1 << 20


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
    m.setdefault("track", [])
    m.setdefault("files", {})
    return m


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
# B2 native API (minimal)
# ---------------------------------------------------------------------------

class B2Error(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


def _creds() -> tuple[str, str]:
    env = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    kid, key = env.get("B2_APPLICATION_KEY_ID"), env.get("B2_APPLICATION_KEY")
    if not kid or not key:
        die("no B2 credentials: set B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY "
            f"(environment or {ENV_FILE.name})")
    return kid, key


def _request(url: str, *, method="GET", headers=None, data=None, timeout=300):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise B2Error(e.code, e.read().decode(errors="replace")) from None


def _retry(fn, what: str, tries: int = 5):
    for attempt in range(tries):
        try:
            return fn()
        except B2Error as e:
            # 401: expired token, 408/429/5xx: transient (B2 asks clients to retry).
            if e.status not in (401, 408, 429, 500, 503) or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == tries - 1:
                raise B2Error(0, f"{what}: {e}") from None
        time.sleep(min(2 ** attempt, 16))


class B2:
    def __init__(self, bucket: str):
        self.bucket = bucket
        self._local = threading.local()
        self._lock = threading.Lock()
        self._authorize()

    def _authorize(self):
        kid, key = _creds()
        basic = base64.b64encode(f"{kid}:{key}".encode()).decode()
        with _request(AUTH_URL, headers={"Authorization": f"Basic {basic}"}) as r:
            a = json.load(r)
        api = a.get("apiInfo", {}).get("storageApi", a)  # v3, or v2 flat layout
        self.account = a["accountId"]
        self.token = a["authorizationToken"]
        self.api_url = api["apiUrl"]
        self.download_url = api["downloadUrl"]
        allowed = api.get("allowed") or {}
        buckets = allowed.get("buckets") or ([{"id": allowed["bucketId"], "name": allowed.get("bucketName")}]
                                             if allowed.get("bucketId") else [])
        bucket_id = next((b["id"] for b in buckets if b.get("name") == self.bucket), None)
        if bucket_id is None:
            res = self.call("b2_list_buckets", {"accountId": self.account, "bucketName": self.bucket})
            if not res.get("buckets"):
                die(f"bucket {self.bucket!r} not found or not accessible with this key")
            bucket_id = res["buckets"][0]["bucketId"]
        self.bucket_id = bucket_id

    def call(self, name: str, body: dict) -> dict:
        def go():
            with _request(f"{self.api_url}/b2api/v3/{name}", method="POST",
                          headers={"Authorization": self.token, "Content-Type": "application/json"},
                          data=json.dumps(body).encode()) as r:
                return json.load(r)
        try:
            return _retry(go, name)
        except B2Error as e:
            if e.status == 401:
                with self._lock:
                    self._authorize()
                return _retry(go, name)
            raise

    def _file_url(self, key: str) -> str:
        return f"{self.download_url}/file/{urllib.parse.quote(self.bucket)}/{urllib.parse.quote(key)}"

    def exists(self, key: str) -> bool:
        def go():
            try:
                with _request(self._file_url(key), method="HEAD", headers={"Authorization": self.token}):
                    return True
            except B2Error as e:
                if e.status == 404:
                    return False
                raise
        return _retry(go, f"HEAD {key}")

    def upload(self, key: str, path: Path, sha1: str, size: int) -> None:
        if size > 5_000_000_000:
            die(f"{path}: larger than 5 GB (large-file upload is not implemented)")

        def go():
            up = getattr(self._local, "upload", None)
            if up is None:
                up = self._local.upload = self.call("b2_get_upload_url", {"bucketId": self.bucket_id})
            try:
                with open(path, "rb") as f:
                    with _request(up["uploadUrl"], method="POST", data=f, headers={
                        "Authorization": up["authorizationToken"],
                        "X-Bz-File-Name": urllib.parse.quote(key),
                        "Content-Type": "application/octet-stream",
                        "Content-Length": str(size),
                        "X-Bz-Content-Sha1": sha1,
                    }):
                        return
            except (B2Error, OSError):
                self._local.upload = None  # B2: get a fresh upload URL after any failure
                raise
        _retry(go, f"upload {key}")

    def download(self, key: str, dest: Path) -> None:
        def go():
            with _request(self._file_url(key), headers={"Authorization": self.token}) as r, open(dest, "wb") as f:
                while chunk := r.read(CHUNK):
                    f.write(chunk)
        _retry(go, f"download {key}")

    def list_keys(self, prefix: str):
        start = None
        while True:
            body = {"bucketId": self.bucket_id, "prefix": prefix, "maxFileCount": 10000}
            if start:
                body["startFileName"] = start
            res = self.call("b2_list_file_names", body)
            for f in res["files"]:
                yield f["fileName"], f.get("fileId")
            start = res.get("nextFileName")
            if not start:
                return


def connect(m: dict) -> B2:
    store = m.get("store", {})
    if store.get("provider") != "b2":
        die(f"unsupported store provider {store.get('provider')!r}")
    return B2(os.environ.get("ASSETS_B2_BUCKET", store["bucket"]))


def parallel(fn, items, label: str):
    items = list(items)
    done = 0
    errors = []
    with cf.ThreadPoolExecutor(JOBS) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for fut in cf.as_completed(futs):
            done += 1
            try:
                fut.result()
            except (B2Error, OSError) as e:
                errors.append((futs[fut], e))
            if sys.stderr.isatty():
                print(f"\r{label} {done}/{len(items)}", end="", file=sys.stderr, flush=True)
    if sys.stderr.isatty() and items:
        print(file=sys.stderr)
    return errors


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
    if not todo:
        print("nothing to download")
        return 0
    total = sum(e["size"] for _, e in todo)
    print(f"downloading {len(todo)} files, {fmt_size(total)}")
    b2 = connect(m)

    def fetch(item):
        rel, e = item
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".assets-tmp")
        try:
            b2.download(blob_key(m, e["sha256"]), tmp)
            h = hashlib.sha256()
            with open(tmp, "rb") as f:
                while chunk := f.read(CHUNK):
                    h.update(chunk)
            if h.hexdigest() != e["sha256"]:
                raise OSError(f"hash mismatch after download of {rel}")
            tmp.replace(dest)
        finally:
            tmp.unlink(missing_ok=True)

    errors = parallel(fetch, todo, "pull")
    for (rel, _), e in errors:
        print(f"error: {rel}: {e}", file=sys.stderr)
    print(f"downloaded {len(todo) - len(errors)} files" + (f", {len(errors)} failed" if errors else ""))
    return 1 if errors else 0


def _publish(m: dict, rels: list[str], dry_run: bool) -> int:
    """Hash, upload what the bucket lacks, record in the manifest."""
    hc = HashCache()
    changed = []
    for rel in rels:
        sha, size = hc.sha256(rel)
        e = m["files"].get(rel)
        if e is None or e["sha256"] != sha:
            changed.append((rel, sha, size))
    hc.save()
    if not changed:
        print("nothing to publish")
        return 0
    print(f"{len(changed)} files to record, {fmt_size(sum(s for _, _, s in changed))}")
    if dry_run:
        for rel, _, size in changed:
            print(f"  {rel} ({fmt_size(size)})")
        return 0
    b2 = connect(m)
    uploaded = []

    def put(item):
        rel, sha, size = item
        key = blob_key(m, sha)
        if b2.exists(key):
            return
        h1 = hashlib.sha1()
        with open(ROOT / rel, "rb") as f:
            while chunk := f.read(CHUNK):
                h1.update(chunk)
        b2.upload(key, ROOT / rel, h1.hexdigest(), size)
        uploaded.append(size)

    errors = parallel(put, changed, "push")
    failed = {item[0] for item, _ in errors}
    for (rel, _, _), e in errors:
        print(f"error: {rel}: {e}", file=sys.stderr)
    for rel, sha, size in changed:
        if rel not in failed:
            m["files"][rel] = {"sha256": sha, "size": size}
    save_manifest(m)
    print(f"uploaded {len(uploaded)} blobs ({fmt_size(sum(uploaded))}), "
          f"{len(changed) - len(failed) - len(uploaded)} already present; manifest updated"
          + (f"; {len(failed)} failed" if failed else ""))
    leaked = git_tracked([r for r, _, _ in changed])
    if leaked:
        print(f"note: {len(leaked)} of these are tracked by git; `git rm --cached` them and gitignore the paths")
    return 1 if errors else 0


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


def cmd_verify(args) -> int:
    m = load_manifest()
    b2 = connect(m)
    present = {k for k, _ in b2.list_keys(m["store"].get("prefix", ""))}
    missing = sorted(r for r, e in m["files"].items() if blob_key(m, e["sha256"]) not in present)
    print(f"{len(m['files']) - len(missing)} / {len(m['files'])} blobs present in {b2.bucket}")
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
    b2 = connect(m)
    orphans = [(k, fid) for k, fid in b2.list_keys(m["store"].get("prefix", "")) if k not in referenced]
    print(f"{len(orphans)} blobs not referenced by any of {len(revs)} commits' manifests (or the working copy)")
    if args.delete:
        for k, fid in orphans:
            b2.call("b2_delete_file_version", {"fileName": k, "fileId": fid})
        print(f"deleted {len(orphans)}")
    else:
        for k, _ in orphans[:20]:
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
    p = sub.add_parser("verify", help="check every manifest blob exists in the bucket")
    p.set_defaults(fn=cmd_verify)
    p = sub.add_parser("gc", help="list (or --delete) blobs no commit references")
    p.add_argument("--delete", action="store_true")
    p.set_defaults(fn=cmd_gc)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
