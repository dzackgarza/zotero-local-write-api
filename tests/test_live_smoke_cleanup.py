"""Regression for the smoke runner's failure handling, not an add-on runtime proof."""

from __future__ import annotations

import io
import json
import unittest
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx

from examples import live_smoke


@contextmanager
def cleanup_endpoint(
    failing_keys: set[str],
) -> Iterator[tuple[live_smoke.SmokeRun, list[tuple[str, str]]]]:
    requests: list[tuple[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            assert self.path == "/write"
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            operation = payload["operation"]
            field = {"trash_item": "item_key", "trash_collection": "collection_key"}[operation]
            key = payload[field]
            requests.append((operation, key))
            if key in failing_keys:
                self.send_error(503, "Cleanup unavailable")
            else:
                body = b'{"success":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = Thread(target=server.serve_forever)
        worker.start()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False) as http:
                yield live_smoke.SmokeRun(
                    http, "/write", "/attach", "0", "cleanup-test",
                    ["ITEM0001", "ITEM0002"], ["COLL0001", "COLL0002"],
                ), requests
        finally:
            server.shutdown()
            worker.join()


ALL_REQUESTS = [
    ("trash_item", "ITEM0001"),
    ("trash_item", "ITEM0002"),
    ("trash_collection", "COLL0001"),
    ("trash_collection", "COLL0002"),
]


class CleanupTests(unittest.TestCase):
    def test_cleanup_attempts_every_object_and_reports_failures(self) -> None:
        diagnostics = io.StringIO()
        with cleanup_endpoint({"ITEM0001", "COLL0001"}) as (smoke, requests):
            with redirect_stderr(diagnostics), self.assertRaises(live_smoke.SmokeFailure):
                live_smoke._trash_created(smoke)
            self.assertEqual(requests, ALL_REQUESTS)
        for key in ("ITEM0001", "COLL0001"):
            self.assertIn(key, diagnostics.getvalue())
        self.assertIn("503", diagnostics.getvalue())

    def test_failed_proof_remains_primary_when_cleanup_also_fails(self) -> None:
        primary = live_smoke.SmokeFailure("Primary proof failed")
        diagnostics = io.StringIO()
        with cleanup_endpoint({"ITEM0001"}) as (smoke, requests):
            with redirect_stderr(diagnostics):
                with self.assertRaises(live_smoke.SmokeFailure) as raised:
                    with live_smoke._cleanup_after_proof(smoke):
                        raise primary
            self.assertIs(raised.exception, primary)
            self.assertEqual(requests, ALL_REQUESTS)
        self.assertIn("ITEM0001", diagnostics.getvalue())
        self.assertIn("503", diagnostics.getvalue())

    def test_cleanup_failure_fails_otherwise_successful_proof(self) -> None:
        diagnostics = io.StringIO()
        with cleanup_endpoint({"COLL0001"}) as (smoke, requests):
            with redirect_stderr(diagnostics), self.assertRaisesRegex(
                live_smoke.SmokeFailure, "Cleanup failed for 1 object"
            ):
                with live_smoke._cleanup_after_proof(smoke):
                    pass
            self.assertEqual(requests, ALL_REQUESTS)
        self.assertIn("COLL0001", diagnostics.getvalue())

    def test_successful_proof_and_cleanup(self) -> None:
        diagnostics = io.StringIO()
        with cleanup_endpoint(set()) as (smoke, requests):
            with redirect_stderr(diagnostics), live_smoke._cleanup_after_proof(smoke):
                pass
            self.assertEqual(requests, ALL_REQUESTS)
        self.assertEqual(diagnostics.getvalue(), "")
