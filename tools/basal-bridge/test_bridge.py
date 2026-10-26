#!/usr/bin/env python3
"""Lifecycle tests for bridge.py against stub_serve.py. Stdlib only.

    python3 tools/basal-bridge/test_bridge.py

Everything runs on 127.0.0.1 with free ports and a throwaway BASAL_BRIDGE_DIR;
nothing touches ~/basal-bridge or a real basal-serve.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUB = HERE / "stub_serve.py"
IDLE_TIMEOUT = 1.5


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def make_env(tmp: Path, stub_log: Path) -> dict[str, str]:
    """Bridge environment pointing at the stub engine inside `tmp`."""
    wrapper = tmp / "basal-serve"
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{STUB}" "$@"\n', encoding="utf-8")
    wrapper.chmod(0o755)
    model = tmp / "model"
    model.mkdir(exist_ok=True)
    calibration = model / "CALIBRATION.llamacpp.json"
    calibration.write_text("{}\n", encoding="utf-8")
    return {
        "BASAL_BRIDGE_DIR": str(tmp / "bridge"),
        "BASAL_BRIDGE_HOST": "127.0.0.1",
        "BASAL_BRIDGE_PORT": str(free_port()),
        "BASAL_SERVE_PORT": str(free_port()),
        "BASAL_SERVE_BIN": str(wrapper),
        "BASAL_MODEL": str(model),
        "BASAL_SHIPPED_CALIBRATION": str(calibration),
        "BASAL_IDLE_TIMEOUT": str(IDLE_TIMEOUT),
        "BASAL_START_TIMEOUT": "20",
        "STUB_LOG": str(stub_log),
        "STUB_START_DELAY": "0",
    }


TMP = Path(tempfile.mkdtemp(prefix="basal-bridge-test-"))
STUB_LOG = TMP / "stub.log"
os.environ.update(make_env(TMP, STUB_LOG))
sys.path.insert(0, str(HERE))

import bridge  # noqa: E402 - the environment above must be set first

BRIDGE_URL = f"http://127.0.0.1:{bridge.BIND_PORT}"


def http(method: str, url: str, body: dict | None = None, timeout: float = 30.0) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def log_lines(path: Path = STUB_LOG) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def wait_for(predicate, timeout: float, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


SCORE_BODY = {"items": [{"id": "b1", "state": "Tytuł: test"}]}


class BridgeLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Record the stub log before main() so test_01 can prove neither the
        # import nor main() started the engine.
        cls.lines_at_import = log_lines()
        cls.running_at_import = bridge.serve.running()
        cls.main_thread = threading.Thread(target=bridge.main, daemon=True)
        cls.main_thread.start()
        ok = wait_for(lambda: _health_ok(), timeout=10)
        if not ok:
            raise RuntimeError("bridge main() did not come up")

    @classmethod
    def tearDownClass(cls) -> None:
        bridge.request_shutdown("tests finished")
        cls.main_thread.join(timeout=30)
        os.environ["STUB_START_DELAY"] = "0"

    def setUp(self) -> None:
        bridge.serve.stop()
        os.environ["STUB_START_DELAY"] = "0"
        self.mark = len(log_lines())

    def new_lines(self, kind: str) -> list[str]:
        return [line for line in log_lines()[self.mark :] if line.split()[0] == kind]

    def test_01_import_and_main_do_not_start_engine(self) -> None:
        self.assertFalse(self.running_at_import)
        self.assertEqual([line for line in self.lines_at_import if line.startswith("start")], [])
        self.assertFalse(bridge.serve.running())
        self.assertIsNone(bridge.serve.proc)
        self.assertEqual([line for line in log_lines() if line.startswith("start")], [])
        # main() resolved the calibration without starting the engine.
        self.assertIsNotNone(bridge.serve.calibration_id())

    def test_02_ensure_running_cold_start(self) -> None:
        with bridge.in_flight():
            started = bridge.serve.ensure_running()
            self.assertTrue(started)
            self.assertTrue(bridge.serve.running())
            answer = bridge.ask_systemone("state", bridge.USEFULNESS_QUESTION)
        self.assertEqual(answer["answers"]["usefulness"]["score"], 1.0)
        self.assertEqual(len(self.new_lines("start")), 1)
        # Already running: the fast path does not start a second engine.
        self.assertFalse(bridge.serve.ensure_running())
        self.assertEqual(len(self.new_lines("start")), 1)

    def test_03_idle_timeout_stops_engine(self) -> None:
        bridge.serve.ensure_running()
        self.assertTrue(bridge.serve.running())
        stopped = wait_for(lambda: bool(self.new_lines("stop")), timeout=IDLE_TIMEOUT + 3)
        self.assertTrue(stopped, "the watchdog did not stop the idle engine")
        self.assertTrue(wait_for(lambda: not bridge.serve.running(), timeout=2))
        self.assertIsNone(bridge.serve.proc)

    def test_04_concurrent_ensure_running_starts_once(self) -> None:
        os.environ["STUB_START_DELAY"] = "1"
        barrier = threading.Barrier(2)
        results: list[bool] = []
        errors: list[BaseException] = []

        def worker() -> None:
            barrier.wait()
            try:
                results.append(bridge.serve.ensure_running())
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(len(self.new_lines("start")), 1)

    def test_05_request_during_start_waits_and_succeeds(self) -> None:
        os.environ["STUB_START_DELAY"] = "2"
        responses: dict[str, tuple[int, dict]] = {}

        def post(name: str) -> None:
            responses[name] = http("POST", f"{BRIDGE_URL}/score", SCORE_BODY)

        first = threading.Thread(target=post, args=("first",))
        first.start()
        self.assertTrue(wait_for(lambda: bool(self.new_lines("start")), timeout=5))
        # The engine is starting now: /health must not report an error.
        status, health = http("GET", f"{BRIDGE_URL}/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"], health)
        second = threading.Thread(target=post, args=("second",))
        second.start()
        first.join(timeout=30)
        second.join(timeout=30)
        for name in ("first", "second"):
            status, payload = responses[name]
            self.assertEqual(status, 200, payload)
            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["errors"], [], payload)
            self.assertEqual(payload["results"][0]["label"], "ciekawy")
        started = [responses[name][1] for name in ("first", "second") if responses[name][1]["engine_started"]]
        self.assertEqual(len(started), 1)
        self.assertGreaterEqual(started[0]["start_ms"], 1500)
        self.assertEqual(len(self.new_lines("start")), 1)

    def test_06_health_when_idle_stopped(self) -> None:
        bridge.serve.ensure_running()
        self.assertTrue(wait_for(lambda: bool(self.new_lines("stop")), timeout=IDLE_TIMEOUT + 3))
        self.assertTrue(wait_for(lambda: bridge.serve.proc is None, timeout=2))
        payload = bridge.health_payload()
        status, over_http = http("GET", f"{BRIDGE_URL}/health")
        self.assertEqual(status, 200)
        for info in (payload, over_http):
            self.assertTrue(info["ok"], info)
            self.assertFalse(info["serve_running"])
            self.assertTrue(info["serve_idle"])
            self.assertNotIn("error", info)
            self.assertEqual(info["idle_timeout_s"], IDLE_TIMEOUT)
            self.assertGreaterEqual(info["idle_seconds"], IDLE_TIMEOUT)
            self.assertIsNotNone(info["calibration_id"])

    def test_07_health_reports_a_crashed_engine(self) -> None:
        bridge.serve.ensure_running()
        bridge.serve.proc.kill()
        bridge.serve.proc.wait(timeout=5)
        payload = bridge.health_payload()
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["serve_idle"])
        self.assertIn("exited", payload["error"])

    def test_08_score_reports_warm_engine(self) -> None:
        status, cold = http("POST", f"{BRIDGE_URL}/score", SCORE_BODY)
        self.assertEqual(status, 200, cold)
        self.assertTrue(cold["engine_started"])
        status, warm = http("POST", f"{BRIDGE_URL}/score", SCORE_BODY)
        self.assertEqual(status, 200, warm)
        self.assertFalse(warm["engine_started"])
        self.assertEqual(warm["start_ms"], 0)

    def test_09_watchdog_skips_while_in_flight(self) -> None:
        bridge.serve.ensure_running()
        with bridge.in_flight():
            bridge.serve.last_used = time.monotonic() - IDLE_TIMEOUT * 10
            self.assertFalse(bridge.idle_tick())
            self.assertTrue(bridge.serve.running())


def _health_ok() -> bool:
    try:
        status, payload = http("GET", f"{BRIDGE_URL}/health", timeout=2)
    except OSError:
        return False
    return status == 200 and payload.get("ok") is True


class BridgeProcessTest(unittest.TestCase):
    """bridge.py as a real process: SIGTERM must take the engine down with it."""

    def test_sigterm_stops_engine(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="basal-bridge-proc-"))
        stub_log = tmp / "stub.log"
        env = {**os.environ, **make_env(tmp, stub_log)}
        url = f"http://127.0.0.1:{env['BASAL_BRIDGE_PORT']}"
        proc = subprocess.Popen(
            [sys.executable, str(HERE / "bridge.py")],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            self.assertTrue(wait_for(lambda: _probe(url), timeout=10), "bridge.py did not come up")
            self.assertEqual(log_lines(stub_log), [])
            status, payload = http("POST", f"{url}/score", SCORE_BODY)
            self.assertEqual(status, 200, payload)
            self.assertTrue(payload["engine_started"])
            starts = [line for line in log_lines(stub_log) if line.startswith("start")]
            self.assertEqual(len(starts), 1)
            engine_pid = starts[0].split()[1]
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=30), 0)
            self.assertIn(f"stop {engine_pid}", log_lines(stub_log))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


def _probe(url: str) -> bool:
    try:
        status, _ = http("GET", f"{url}/health", timeout=2)
    except OSError:
        return False
    return status == 200


if __name__ == "__main__":
    unittest.main(verbosity=2)
