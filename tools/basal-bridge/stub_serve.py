#!/usr/bin/env python3
"""A fake `basal-serve` for test_bridge.py. Stdlib only, loopback only.

Accepts the flags the bridge passes and ignores all but --host/--port. Appends
`start <pid> <timestamp>` to $STUB_LOG on startup and `stop <pid>` on SIGTERM.
$STUB_START_DELAY seconds (default 0) are slept before binding so a cold start
is observable.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def note(line: str) -> None:
    path = os.environ.get("STUB_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        elif self.path == "/v1/models":
            self._send(200, {"models": [{"name": "stub"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/systemone":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        answer = {"score": 1.0, "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7}, "confidence": 0.7}
        names = list((body.get("questions") or {}).keys()) or ["usefulness"]
        self._send(200, {"answers": {name: answer for name in names}})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    for flag in ("--model", "--mode", "--gguf", "--calibration", "--llamacpp-url", "--ollama-url", "--ollama-model"):
        parser.add_argument(flag)
    args = parser.parse_args()

    pid = os.getpid()

    def on_term(_signum, _frame) -> None:
        note(f"stop {pid}")
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    note(f"start {pid} {time.time():.3f}")
    time.sleep(float(os.environ.get("STUB_START_DELAY", "0")))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
