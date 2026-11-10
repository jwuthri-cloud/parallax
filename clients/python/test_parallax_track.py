"""Tests for parallax_track against a stub HTTP server. Run: python3 -m unittest test_parallax_track"""

import json
import math
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import parallax_track as px


class Stub(BaseHTTPRequestHandler):
    events: list = []
    fail = False

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"items":[]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if Stub.fail:
            self.send_response(503)
            self.end_headers()
            return
        Stub.events.extend(body["events"])
        self.send_response(201)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class TrackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.events, Stub.fail = [], False
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def test_online_run_sends_events_and_writes_the_log(self):
        run = px.init(url=self.url, dir=self.dir, name="fixture", config={"lr": 0.1}, system=False)
        run.log({"train/loss": 1.0})
        run.log({"train": {"loss": 0.5}, "acc": True})
        run.log({"val/loss": math.nan}, step=10)
        run.summary["best"] = 0.5
        run.finish()
        kinds = [e["type"] for e in Stub.events]
        self.assertEqual(kinds, ["start", "log", "log", "log", "summary", "finish"])
        logs = [e for e in Stub.events if e["type"] == "log"]
        self.assertEqual([e["step"] for e in logs], [0, 1, 10])
        self.assertEqual(logs[1]["values"], {"train/loss": 0.5, "acc": 1.0})
        self.assertIsNone(logs[2]["values"]["val/loss"])
        self.assertEqual(Stub.events[0]["config"], {"lr": 0.1})
        self.assertIn("host", Stub.events[0]["meta"])
        written = Path(self.dir, f"{run.id}.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(x) for x in written], Stub.events)

    def test_failed_posts_are_retried(self):
        Stub.fail = True
        run = px.init(url=self.url, dir=self.dir, mode="online", system=False)
        run.log({"loss": 1.0})
        run._flush()
        self.assertEqual(Stub.events, [])
        Stub.fail = False
        run.finish("failed", 2)
        self.assertEqual([e["type"] for e in Stub.events], ["start", "log", "finish"])
        self.assertEqual(Stub.events[-1]["exitCode"], 2)

    def test_offline_then_sync(self):
        run = px.init(url=self.url, dir=self.dir, mode="offline", id="fx-off", system=False)
        run.log({"loss": 2.0}, step=5)
        run.finish()
        self.assertEqual(Stub.events, [])
        self.assertEqual(px.sync([self.dir], url=self.url), 3)
        self.assertEqual(Stub.events[1]["values"], {"loss": 2.0})

    def test_rejects_non_numbers_and_logging_after_finish(self):
        run = px.init(url=self.url, dir=self.dir, mode="offline", system=False)
        with self.assertRaises(TypeError):
            run.log({"name": "text"})
        run.finish()
        with self.assertRaises(RuntimeError):
            run.log({"loss": 1})

    def test_system_sampler_reports_disk_everywhere(self):
        values = px._SystemSampler(Path(self.dir)).sample()
        self.assertIn("system/disk.used_pct", values)


if __name__ == "__main__":
    unittest.main()
