"""Tests for scripts/assets.py, with a local directory as the rclone store.

Run: python3 -m unittest -v scripts/test_assets.py  (also registered in CTest; needs rclone, see mise.toml).
"""
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
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / "scripts" / "assets.py")
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

    def run_assets(self, *args, cwd=None, env=None, ok=True):
        r = subprocess.run([sys.executable, str(self.repo / "scripts" / "assets.py"), *args], cwd=cwd or self.repo,
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


if __name__ == "__main__":
    unittest.main()
