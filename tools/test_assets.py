"""Tests for tools/assets.py, with a local directory as the rclone store.

Run: python3 -m unittest -v tools/test_assets.py  (also registered in CTest; needs rclone, see mise.toml).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("assets.py")


def find_rclone():
    """The real binary: a mise shim picks its version from the cwd, and the test repos have no mise.toml."""
    try:
        return subprocess.run(["mise", "which", "rclone"], cwd=SCRIPT.parent, capture_output=True, text=True,
                              check=True).stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return shutil.which("rclone")


RCLONE = find_rclone()


@unittest.skipUnless(RCLONE, "rclone not installed (mise install)")
class AssetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        (self.repo / "tools").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / "tools" / "assets.py")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "assets.json").write_text(json.dumps({
            "version": 1, "store": {"prefix": "sha256/"},
            "track": ["data/**", "!data/skip.bin"], "files": {}}))
        (self.repo / "data" / "sub").mkdir(parents=True)
        for i in range(8):
            (self.repo / "data" / "sub" / f"f{i}.bin").write_bytes(os.urandom(1000 + i * 5000))
        (self.repo / "data" / "skip.bin").write_bytes(b"skip")
        (self.repo / "other.txt").write_text("other\n")

        self.store = self.tmp / "remote"  # created by the first push
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("ASSETS_")}
        self.env["ASSETS_REMOTE"] = str(self.store)
        self.env["RCLONE"] = RCLONE

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_assets(self, *args, cwd=None, env=None, ok=True, repo=None):
        repo = repo or self.repo
        r = subprocess.run([sys.executable, str(repo / "tools" / "assets.py"), *args], cwd=cwd or repo,
                           env=env or self.env, capture_output=True, text=True)
        if ok:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def manifest(self):
        return json.loads((self.repo / "assets.json").read_text())

    def test_push_pull_roundtrip(self):
        out = self.run_assets("status").stdout
        self.assertIn("8 new", out)  # skip.bin excluded by the '!' glob
        self.run_assets("push")
        files = self.manifest()["files"]
        self.assertEqual(len(files), 8)
        self.assertNotIn("data/skip.bin", files)
        self.assertIn("nothing to publish", self.run_assets("push").stdout)
        self.assertEqual(len([p for p in self.store.rglob("*") if p.is_file()]), 8)
        self.assertIn("8 / 8 blobs present", self.run_assets("verify").stdout)

        # Delete one, modify another: pull restores the missing one, leaves the modified one.
        f0, f1 = self.repo / "data/sub/f0.bin", self.repo / "data/sub/f1.bin"
        orig1 = f1.read_bytes()
        f0.unlink()
        f1.write_bytes(b"local edit")
        r = self.run_assets("status", "--check", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("1 missing", r.stdout)
        self.assertIn("1 modified", r.stdout)
        self.assertIn("skip (locally modified", self.run_assets("pull").stdout)
        self.assertTrue(f0.exists())
        self.assertEqual(f1.read_bytes(), b"local edit")
        self.run_assets("pull", "--force", "data/sub/f1.bin")
        self.assertEqual(f1.read_bytes(), orig1)
        self.run_assets("status", "--check")

    def test_rm_warns_when_path_matches_track_glob(self):
        self.run_assets("push")
        r = self.run_assets("rm", "data/sub/f0.bin")
        self.assertIn("still match", r.stderr)
        self.assertIn("!<path>", r.stderr)
        self.assertNotIn("data/sub/f0.bin", self.manifest()["files"])
        r = self.run_assets("rm", "data/sub/f1.bin")
        self.assertIn("still match", r.stderr)
        # Not matching any glob (excluded): no warning.
        self.run_assets("add", "other.txt")
        self.assertNotIn("still match", self.run_assets("rm", "other.txt").stderr)

    def test_push_skips_temp_files(self):
        (self.repo / "data" / "sub" / "x.tmp").write_bytes(b"tmp")
        (self.repo / "data" / "sub" / "y.assets-tmp").write_bytes(b"tmp")
        self.run_assets("push")
        files = self.manifest()["files"]
        self.assertEqual(len(files), 8)
        self.assertFalse(any(f.endswith((".tmp", ".assets-tmp")) for f in files))

    def test_manifest_conflict_and_parse_errors(self):
        good = (self.repo / "assets.json").read_text()
        (self.repo / "assets.json").write_text("<<<<<<< HEAD\n" + good + "\n=======\n" + good + "\n>>>>>>> x\n")
        r = self.run_assets("status", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("merge conflict markers", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        (self.repo / "assets.json").write_text('{\n "version": 1,\n oops\n}\n')
        r = self.run_assets("status", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("line 3", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_add_explicit_file_and_paths_relative_to_cwd(self):
        self.run_assets("add", "other.txt")
        self.assertEqual(list(self.manifest()["files"]), ["other.txt"])
        self.run_assets("push", "sub", cwd=self.repo / "data")  # only data/sub/*
        self.assertEqual(len(self.manifest()["files"]), 9)
        self.run_assets("rm", "other.txt")
        self.assertNotIn("other.txt", self.manifest()["files"])
        self.assertTrue((self.repo / "other.txt").exists())

    def test_hash_mismatch_is_rejected(self):
        self.run_assets("push")
        sha = self.manifest()["files"]["data/sub/f2.bin"]["sha256"]
        (self.store / f"sha256/{sha[:2]}/{sha}").write_bytes(b"corrupt")
        (self.repo / "data/sub/f2.bin").unlink()
        r = self.run_assets("pull", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("hash mismatch", r.stderr)
        self.assertFalse((self.repo / "data/sub/f2.bin").exists())
        self.assertEqual([p for p in (self.repo / "data/sub").iterdir() if "assets-tmp" in p.name], [])
        self.assertFalse((self.repo / ".assets-staging").exists())

    def test_prune_and_gc(self):
        self.run_assets("push")
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(["git", "add", "assets.json"], cwd=self.repo, check=True)
        subprocess.run([*git, "commit", "-qm", "m"], cwd=self.repo, check=True)
        (self.repo / "data/sub/f3.bin").write_bytes(b"new version")
        self.run_assets("push")
        subprocess.run(["git", "checkout", "-q", "assets.json"], cwd=self.repo, check=True)  # never committed
        # The unpublished hash is still what f3 was last synced to (and f3 is "behind" now): gc keeps it.
        self.assertIn("0 blobs not referenced", self.run_assets("gc").stdout)
        self.run_assets("pull")  # f3 goes back to the committed version: the new blob is garbage
        self.assertIn("1 blobs not referenced", self.run_assets("gc").stdout)
        self.run_assets("gc", "--delete")
        self.assertIn("0 blobs not referenced", self.run_assets("gc").stdout)

        (self.repo / "data/sub/f4.bin").unlink()
        self.assertIn("missing locally (kept", self.run_assets("push").stdout)
        self.run_assets("push", "--prune")
        self.assertNotIn("data/sub/f4.bin", self.manifest()["files"])

    def test_push_restores_blobs_missing_from_store(self):
        self.run_assets("push")
        shutil.rmtree(self.store)  # e.g. a fresh store seeded from a full checkout
        self.assertIn("0 / 8 blobs present", self.run_assets("verify", ok=False).stdout)
        self.assertIn("uploading 8 blobs", self.run_assets("push").stdout)
        self.assertIn("8 / 8 blobs present", self.run_assets("verify").stdout)

    def test_duplicate_content_and_missing_blob(self):
        (self.repo / "data/dup.bin").write_bytes((self.repo / "data/sub/f0.bin").read_bytes())
        self.run_assets("push")
        self.assertEqual(len([p for p in self.store.rglob("*") if p.is_file()]), 8)
        (self.repo / "data/dup.bin").unlink()
        (self.repo / "data/sub/f0.bin").unlink()
        sha = self.manifest()["files"]["data/sub/f6.bin"]["sha256"]
        (self.store / f"sha256/{sha[:2]}/{sha}").unlink()
        (self.repo / "data/sub/f6.bin").unlink()
        r = self.run_assets("pull", ok=False)
        self.assertIn("not in store", r.stderr)
        self.assertEqual((self.repo / "data/dup.bin").read_bytes(), (self.repo / "data/sub/f0.bin").read_bytes())

    def test_store_config(self):
        self.run_assets("push")
        (self.repo / "data/sub/f5.bin").unlink()
        env = {k: v for k, v in self.env.items() if k != "ASSETS_REMOTE"}
        r = self.run_assets("pull", env=env, ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no asset store configured", r.stderr)
        (self.repo / ".assets.env").write_text(f"# hub\nASSETS_REMOTE='{self.store}'\n")
        self.run_assets("pull", env=env)
        self.assertTrue((self.repo / "data/sub/f5.bin").exists())
        r = self.run_assets("verify", env=dict(env, RCLONE="/nonexistent/rclone"), ok=False)
        self.assertIn("running rclone", r.stderr)

    def set_shared(self, dirs, prefix="sha256/"):
        m = self.manifest()
        m["shared"] = dirs
        m["store"]["prefix"] = prefix
        (self.repo / "assets.json").write_text(json.dumps(m))

    def test_shared_dir_roundtrip(self):
        self.set_shared(["rec/"])
        rec = self.repo / "rec"
        rec.mkdir()
        (rec / "a.gz").write_bytes(b"a" * 100)
        (rec / "b.gz").write_bytes(b"b" * 200)
        (rec / "mine.gz").write_bytes(b"private")
        before = (self.repo / "assets.json").read_text()

        self.run_assets("share", "a.gz", "b.gz", cwd=rec)
        self.assertEqual((self.repo / "assets.json").read_text(), before)  # no manifest change
        self.assertEqual((self.store / "shared/rec/a.gz").read_bytes(), b"a" * 100)
        self.assertFalse((self.store / "shared/rec/mine.gz").exists())
        self.assertIn("1 already shared", self.run_assets("share", "rec/a.gz").stdout)

        # Listing: shared + here, shared only, local only (hidden unless --all).
        (rec / "b.gz").unlink()
        out = self.run_assets("shared").stdout
        self.assertIn("2 shared (1 not here: pull); 1 local only", out)
        self.assertIn("↓ rec/b.gz", out)
        self.assertNotIn("mine.gz", out)
        self.assertIn("↑ rec/mine.gz", self.run_assets("shared", "--all").stdout)

        # pull fetches missing shared files; a path filter limits it; other files are left alone.
        self.run_assets("pull", "rec/a.gz")
        self.assertFalse((rec / "b.gz").exists())
        self.assertIn("downloaded 1 shared files", self.run_assets("pull").stdout)
        self.assertEqual((rec / "b.gz").read_bytes(), b"b" * 200)
        self.assertEqual((rec / "mine.gz").read_bytes(), b"private")
        self.assertIn("nothing to download", self.run_assets("pull").stdout)

        # A different file under a shared name: never overwritten in either direction.
        (rec / "a.gz").write_bytes(b"other")
        r = self.run_assets("share", "rec/a.gz", ok=False)
        self.assertIn("already shared", r.stderr)
        self.assertEqual((self.store / "shared/rec/a.gz").read_bytes(), b"a" * 100)
        self.assertIn("local file differs", self.run_assets("pull").stdout)
        self.assertEqual((rec / "a.gz").read_bytes(), b"other")

        self.run_assets("unshare", "rec/a.gz")
        self.assertFalse((self.store / "shared/rec/a.gz").exists())
        self.assertTrue((rec / "a.gz").exists())

    def test_shared_dir_boundaries(self):
        self.set_shared(["rec"], prefix="")  # empty prefix: blobs and shared/ share the store root
        (self.repo / "rec").mkdir()
        (self.repo / "rec/a.gz").write_bytes(b"a")
        self.assertIn("not in a shared dir", self.run_assets("share", "other.txt", ok=False).stderr)
        self.assertIn("use `share`", self.run_assets("add", "rec/a.gz", ok=False).stderr)
        self.run_assets("share", "rec")
        self.run_assets("push")
        self.assertIn("8 / 8 blobs present", self.run_assets("verify").stdout)
        self.assertIn("0 blobs not referenced", self.run_assets("gc").stdout)  # shared/ is not garbage
        self.run_assets("gc", "--delete")
        self.assertTrue((self.store / "shared/rec/a.gz").exists())

    # --- sync base, conflicts, trash -------------------------------------------------------------

    F1, F2 = "data/sub/f1.bin", "data/sub/f2.bin"

    def entry_hash(self, rel):
        return self.manifest()["files"][rel]["sha256"]

    def trash_files(self):
        return sorted(p for p in (self.repo / ".assets-trash").rglob("*") if p.is_file())

    def teammate_update(self, rel, data):
        """A second working copy (same store) publishes `data` for `rel`; its assets.json replaces ours,
        like a git pull that brought a new manifest."""
        mate = self.tmp / "mate"
        if not mate.exists():
            (mate / "tools").mkdir(parents=True)
            shutil.copy(SCRIPT, mate / "tools" / "assets.py")
            subprocess.run(["git", "init", "-q"], cwd=mate, check=True)
        shutil.copy(self.repo / "assets.json", mate / "assets.json")
        self.run_assets("pull", repo=mate)
        (mate / rel).write_bytes(data)
        self.run_assets("push", repo=mate)
        shutil.copy(mate / "assets.json", self.repo / "assets.json")

    def test_behind_fast_forwards_without_force(self):
        self.run_assets("push")
        old = (self.repo / self.F1).read_bytes()
        self.teammate_update(self.F1, b"teammate version")
        out = self.run_assets("status").stdout
        self.assertIn("1 behind", out)
        self.assertNotIn("modified", out)
        self.assertEqual(self.run_assets("status", "--check", ok=False).returncode, 1)
        self.assertEqual((self.repo / self.F1).read_bytes(), old)
        self.run_assets("pull")
        self.assertEqual((self.repo / self.F1).read_bytes(), b"teammate version")
        self.assertEqual(self.trash_files() if (self.repo / ".assets-trash").exists() else [], [])  # clean: no trash
        self.run_assets("status", "--check")

    def test_local_edit_is_kept_by_pull_and_published_by_push(self):
        self.run_assets("push")
        (self.repo / self.F1).write_bytes(b"my rebuild")
        self.assertIn("1 modified", self.run_assets("status").stdout)
        self.assertIn("skip (locally modified", self.run_assets("pull").stdout)
        self.assertEqual((self.repo / self.F1).read_bytes(), b"my rebuild")
        self.run_assets("push")
        self.assertEqual(self.entry_hash(self.F1), hashlib.sha256(b"my rebuild").hexdigest())
        self.run_assets("status", "--check")
        # Another unrelated teammate update arrives; the edited file stays publishable, the rest fast-forwards.
        (self.repo / self.F2).write_bytes(b"second edit")
        self.teammate_update(self.F1, b"newer")
        r = self.run_assets("status")
        self.assertIn("1 behind", r.stdout)
        self.assertIn("1 modified", r.stdout)

    def test_push_does_not_publish_a_stale_file(self):
        self.run_assets("push")
        self.teammate_update(self.F1, b"teammate version")
        newer = self.entry_hash(self.F1)
        r = self.run_assets("push")
        self.assertIn("behind", r.stdout)
        self.assertIn("run pull", r.stdout)
        self.assertEqual(self.entry_hash(self.F1), newer)
        self.run_assets("add", self.F1)  # explicit add is no way around it either
        self.assertEqual(self.entry_hash(self.F1), newer)

    def make_conflict(self):
        self.run_assets("push")
        mine = b"my version"
        (self.repo / self.F1).write_bytes(mine)
        self.teammate_update(self.F1, b"their version")
        return mine

    def test_conflict_is_reported_and_blocks_pull_and_push(self):
        mine = self.make_conflict()
        r = self.run_assets("status")
        self.assertIn("1 conflict", r.stdout)
        self.assertIn("resolve", r.stdout)
        manifest = (self.repo / "assets.json").read_text()
        r = self.run_assets("pull", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("conflict", r.stdout)
        (self.repo / self.F2).write_bytes(b"other edit")  # other paths carry on
        r = self.run_assets("push", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"conflict (changed here and in the manifest; keep yours: resolve {self.F1}", r.stdout)
        self.assertEqual(self.entry_hash(self.F2), hashlib.sha256(b"other edit").hexdigest())  # others published
        self.assertEqual((self.repo / self.F1).read_bytes(), mine)
        self.assertEqual(json.loads(manifest)["files"][self.F1], self.manifest()["files"][self.F1])
        self.assertEqual(self.run_assets("status", "--check", ok=False).returncode, 1)

    def test_resolve_ours_then_push_publishes(self):
        mine = self.make_conflict()
        self.run_assets("resolve", self.F1, "--ours")
        self.assertEqual((self.repo / self.F1).read_bytes(), mine)
        self.assertIn("1 modified", self.run_assets("status").stdout)
        self.assertIn("skip (locally modified", self.run_assets("pull").stdout)
        self.run_assets("push")
        self.run_assets("status", "--check")
        (self.repo / self.F1).unlink()
        self.run_assets("pull")
        self.assertEqual((self.repo / self.F1).read_bytes(), mine)

    def test_resolve_theirs_restores_manifest_version_and_trashes_mine(self):
        mine = self.make_conflict()
        r = self.run_assets("resolve", self.F1, "--theirs")
        self.assertIn(".assets-trash/", r.stdout)
        self.assertEqual((self.repo / self.F1).read_bytes(), b"their version")
        self.assertEqual([p.read_bytes() for p in self.trash_files()], [mine])
        self.run_assets("status", "--check")
        self.assertIn("nothing to resolve", self.run_assets("resolve", self.F1, "--theirs").stdout)

    def test_pull_force_trashes_edit_and_trash_restores_it(self):
        self.run_assets("push")
        orig = (self.repo / self.F1).read_bytes()
        (self.repo / self.F1).write_bytes(b"precious edit")
        r = self.run_assets("pull", "--force")
        self.assertIn("trash --restore", r.stdout)
        self.assertEqual((self.repo / self.F1).read_bytes(), orig)
        entry = self.trash_files()
        self.assertEqual(len(entry), 1)
        listing = self.run_assets("trash").stdout
        self.assertIn(self.F1, listing)
        self.assertIn("13 B", listing)

        # Restoring over the (clean, base-equal) store copy needs no trashing; over a different file it does.
        self.run_assets("trash", "--restore", self.F1)
        self.assertEqual((self.repo / self.F1).read_bytes(), b"precious edit")
        self.assertEqual(self.trash_files(), [])
        self.run_assets("pull", "--force")  # trashes the edit again
        (self.repo / self.F1).write_bytes(b"newer still")
        self.run_assets("trash", "--restore", self.F1)
        self.assertEqual((self.repo / self.F1).read_bytes(), b"precious edit")
        self.assertEqual([p.read_bytes() for p in self.trash_files()], [b"newer still"])
        stamp = self.trash_files()[0].relative_to(self.repo / ".assets-trash").parts[0]
        self.run_assets("trash", "--restore", self.F1, "--from", stamp)
        self.assertEqual((self.repo / self.F1).read_bytes(), b"newer still")
        self.assertEqual([p.read_bytes() for p in self.trash_files()], [b"precious edit"])
        self.assertIn("nothing in the trash", self.run_assets("trash", "--restore", "other.txt", ok=False).stderr)

    def test_clean_file_is_not_trashed_when_replaced(self):
        self.run_assets("push")
        self.teammate_update(self.F1, b"v2")
        self.run_assets("pull", "--force")
        self.assertFalse((self.repo / ".assets-trash").exists())

    def test_no_base_falls_back_to_modified(self):
        self.run_assets("push")
        (self.repo / ".assets-base.json").unlink()
        self.run_assets("status", "--check")  # equal to the manifest: base is recorded again
        self.assertTrue((self.repo / ".assets-base.json").exists())
        (self.repo / ".assets-base.json").unlink()
        (self.repo / self.F1).write_bytes(b"differs")
        out = self.run_assets("status").stdout
        self.assertIn("1 modified", out)
        self.assertIn("no sync record", out)
        out = self.run_assets("pull").stdout
        self.assertIn("skip", out)
        self.assertEqual(out.count("no sync record"), out.count("note:") + 1)  # one skip line, one note
        self.assertEqual((self.repo / self.F1).read_bytes(), b"differs")
        self.run_assets("pull", "--force")
        self.assertEqual(len(self.trash_files()), 1)
        # unbased + resolve --ours: kept, and push publishes it
        (self.repo / ".assets-base.json").unlink()
        (self.repo / self.F1).write_bytes(b"kept")
        self.run_assets("resolve", self.F1, "--ours")
        self.run_assets("push")
        self.assertEqual(len(self.trash_files()), 1)
        self.run_assets("status", "--check")

    def test_base_survives_manifest_removal(self):
        self.run_assets("push")
        self.run_assets("rm", self.F1)
        base = json.loads((self.repo / ".assets-base.json").read_text())
        self.assertNotIn(self.F1, base)
        self.assertIn(self.F2, base)
        # A path that vanishes from the manifest via git (stale base entry) is harmless and re-adds cleanly.
        m = self.manifest()
        del m["files"][self.F2]
        (self.repo / "assets.json").write_text(json.dumps(m))
        self.run_assets("status")
        self.run_assets("push")
        self.assertIn(self.F2, self.manifest()["files"])
        self.run_assets("status", "--check")

    def test_prune_forgets_base_and_cache_flows(self):
        self.run_assets("push")
        (self.repo / self.F1).unlink()
        self.run_assets("push", "data", "--prune")
        self.assertNotIn(self.F1, json.loads((self.repo / ".assets-base.json").read_text()))
        self.assertNotIn(self.F1, self.manifest()["files"])

    def test_trash_empty(self):
        self.run_assets("push")
        for name in (self.F1, self.F2):
            (self.repo / name).write_bytes(b"edit " + name.encode())
        self.run_assets("pull", "--force")
        self.assertEqual(len(self.trash_files()), 2)
        self.assertIn("deleted 0", self.run_assets("trash", "--empty", "--older-than", "1").stdout)
        self.assertEqual(len(self.trash_files()), 2)
        old = self.repo / ".assets-trash" / "20200101T000000Z" / "data" / "x.bin"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"old")
        self.assertIn("deleted 1", self.run_assets("trash", "--empty", "--older-than", "1").stdout)
        self.assertEqual(len(self.trash_files()), 2)
        self.run_assets("trash", "--empty")
        self.assertFalse((self.repo / ".assets-trash").exists())
        self.assertIn("empty", self.run_assets("trash").stdout)


if __name__ == "__main__":
    unittest.main()
