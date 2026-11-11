"""Tests for scripts/assets.py against an in-process mock of the B2 native API.

Run: python3 -m unittest -v scripts/test_assets.py  (also registered in CTest).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("assets.py")


class MockB2(BaseHTTPRequestHandler):
    """authorize / list_buckets / get_upload_url / upload / download (GET+HEAD) /
    list_file_names (3 per page) / delete_file_version. Every 5th upload: 503."""

    store: Path
    uploads = 0
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def reply(self, code, obj=None, body=None):
        data = body if body is not None else json.dumps(obj or {}).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def do_GET(self):
        if self.path.startswith("/b2api/v3/b2_authorize_account"):
            if not self.headers.get("Authorization", "").startswith("Basic "):
                return self.reply(401)
            return self.reply(200, {"accountId": "acc", "authorizationToken": "tok", "apiInfo": {"storageApi": {
                "apiUrl": self.base, "downloadUrl": self.base,
                "allowed": {"buckets": [{"id": "bid", "name": "test-bucket"}]}}}})
        if self.path.startswith("/file/test-bucket/"):
            if self.headers.get("Authorization") != "tok":
                return self.reply(401)
            p = self.store / urllib.parse.unquote(self.path[len("/file/test-bucket/"):])
            return self.reply(200, body=p.read_bytes()) if p.is_file() else self.reply(404)
        self.reply(404)

    do_HEAD = do_GET

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/upload":
            with MockB2.lock:
                MockB2.uploads += 1
                fail = MockB2.uploads % 5 == 0
            if self.headers.get("Authorization") != "uptok":
                return self.reply(401)
            if fail:
                return self.reply(503)
            if hashlib.sha1(body).hexdigest() != self.headers["X-Bz-Content-Sha1"]:
                return self.reply(400)
            p = self.store / urllib.parse.unquote(self.headers["X-Bz-File-Name"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            return self.reply(200, {})
        if self.headers.get("Authorization") != "tok":
            return self.reply(401)
        req = json.loads(body or b"{}")
        name = self.path.rsplit("/", 1)[-1]
        if name == "b2_get_upload_url":
            return self.reply(200, {"uploadUrl": self.base + "/upload", "authorizationToken": "uptok"})
        if name == "b2_list_file_names":
            keys = sorted(q.relative_to(self.store).as_posix() for q in self.store.rglob("*") if q.is_file())
            keys = [k for k in keys if k.startswith(req.get("prefix", "")) and k >= (req.get("startFileName") or "")]
            return self.reply(200, {"files": [{"fileName": k, "fileId": k} for k in keys[:3]],
                                    "nextFileName": keys[3] if len(keys) > 3 else None})
        if name == "b2_delete_file_version":
            (self.store / req["fileName"]).unlink()
            return self.reply(200, {})
        self.reply(404)


class AssetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / "scripts" / "assets.py")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "assets.json").write_text(json.dumps({
            "version": 1, "store": {"provider": "b2", "bucket": "test-bucket", "prefix": "sha256/"},
            "track": ["data/**", "!data/skip.bin"], "files": {}}))
        (self.repo / "data" / "sub").mkdir(parents=True)
        for i in range(8):
            (self.repo / "data" / "sub" / f"f{i}.bin").write_bytes(os.urandom(1000 + i * 5000))
        (self.repo / "data" / "skip.bin").write_bytes(b"skip")
        (self.repo / "other.txt").write_text("other\n")

        MockB2.store = self.tmp / "remote"
        MockB2.store.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockB2)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = dict(os.environ, B2_APPLICATION_KEY_ID="kid", B2_APPLICATION_KEY="key",
                        ASSETS_B2_AUTH_URL=f"http://127.0.0.1:{self.server.server_port}/b2api/v3/b2_authorize_account")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
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
        self.assertEqual(len([p for p in MockB2.store.rglob("*") if p.is_file()]), 8)
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
        (MockB2.store / f"sha256/{sha[:2]}/{sha}").write_bytes(b"corrupt")
        (self.repo / "data/sub/f2.bin").unlink()
        r = self.run_assets("pull", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("hash mismatch", r.stderr)
        self.assertFalse((self.repo / "data/sub/f2.bin").exists())
        self.assertEqual([p for p in (self.repo / "data/sub").iterdir() if "assets-tmp" in p.name], [])

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

    def test_missing_credentials(self):
        self.run_assets("push")
        (self.repo / "data/sub/f5.bin").unlink()
        env = {k: v for k, v in self.env.items() if not k.startswith("B2_")}
        r = self.run_assets("pull", env=env, ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no B2 credentials", r.stderr)
        (self.repo / ".assets.env").write_text("B2_APPLICATION_KEY_ID=kid\nB2_APPLICATION_KEY='key'\n")
        self.run_assets("pull", env=env)
        self.assertTrue((self.repo / "data/sub/f5.bin").exists())


if __name__ == "__main__":
    unittest.main()
