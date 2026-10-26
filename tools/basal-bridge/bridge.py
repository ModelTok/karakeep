#!/usr/bin/env python3
"""basal-bridge: the only HTTP surface Karakeep is allowed to talk to.

It owns a `basal-serve` child process (loopback only), exposes three endpoints on
the Docker bridge gateway, and owns the calibration lifecycle. The engine holds
~2 GB of RAM, so it is started lazily by the first /score or /train and stopped
again after BASAL_IDLE_TIMEOUT seconds without requests:

    GET  /health  -> {ok, model, mode, calibration_id, engine_version, ...}
    POST /score   -> {items: [{id, state}], question?, questionName?} -> per-item decision
    POST /train   -> {requests: ["<json line>", ...]} -> calibration id + report

No authentication: bind it to the Karakeep docker bridge gateway so it is not
reachable from the LAN or from Tailscale. See README.md.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.1.0"

HOME = Path(os.path.expanduser("~"))
BRIDGE_DIR = Path(os.environ.get("BASAL_BRIDGE_DIR", HOME / "basal-bridge"))
CALIBRATIONS_DIR = Path(os.environ.get("BASAL_CALIBRATIONS_DIR", BRIDGE_DIR / "calibrations"))
STATE_FILE = Path(os.environ.get("BASAL_BRIDGE_STATE", BRIDGE_DIR / "state.json"))
MODEL_DIR = Path(os.environ.get("BASAL_MODEL", HOME / "models" / "basal-2.0-mini-GGUF"))
MODE = os.environ.get("BASAL_MODE", "gguf")
GGUF_PATH = Path(
    os.environ.get("BASAL_GGUF", str(MODEL_DIR / "basal-2.0-mini-Q8_0.gguf"))
)
SHIPPED_CALIBRATION = Path(
    os.environ.get("BASAL_SHIPPED_CALIBRATION", str(MODEL_DIR / "CALIBRATION.llamacpp.json"))
)
SERVE_BIN = Path(os.environ.get("BASAL_SERVE_BIN", HOME / "basal-env" / "bin" / "basal-serve"))
CALIBRATE_BIN = Path(
    os.environ.get("BASAL_CALIBRATE_BIN", HOME / "basal-env" / "bin" / "basal-calibrate")
)
SERVE_HOST = os.environ.get("BASAL_SERVE_HOST", "127.0.0.1")
SERVE_PORT = int(os.environ.get("BASAL_SERVE_PORT", "8011"))
BIND_PORT = int(os.environ.get("BASAL_BRIDGE_PORT", "8010"))


def _default_bind_host() -> str:
    """The docker bridge gateway, never 0.0.0.0.

    basal-bridge has no authentication, so its defaults must not expose it to
    the LAN or Tailscale. Karakeep reaches it through host.docker.internal,
    which resolves to this gateway inside the container.
    """
    try:
        out = subprocess.run(
            [
                "docker",
                "network",
                "inspect",
                os.environ.get("BASAL_DOCKER_NETWORK", "karakeep_default"),
                "-f",
                "{{(index .IPAM.Config 0).Gateway}}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        gateway = out.stdout.strip()
        if out.returncode == 0 and gateway:
            return gateway
    except (OSError, subprocess.SubprocessError):
        pass
    return "127.0.0.1"


BIND_HOST = os.environ.get("BASAL_BRIDGE_HOST") or _default_bind_host()
SCORE_TIMEOUT = float(os.environ.get("BASAL_SCORE_TIMEOUT", "600"))
TRAIN_TIMEOUT = float(os.environ.get("BASAL_TRAIN_TIMEOUT", "3600"))
# The engine is CPU bound and answers one request at a time, so scoring several
# items concurrently only queues them inside basal-serve: with 4 workers and 5
# full-text items (~50 s each) four of them hit SCORE_TIMEOUT while one
# finished. Sequential scoring keeps one item's wait equal to one decision.
SCORE_CONCURRENCY = int(os.environ.get("BASAL_SCORE_CONCURRENCY", "1"))
START_TIMEOUT = float(os.environ.get("BASAL_START_TIMEOUT", "180"))
# Seconds without /score or /train after which basal-serve is stopped to give its
# ~2 GB back. 0 disables the stop; the engine is still only started on demand.
IDLE_TIMEOUT = float(os.environ.get("BASAL_IDLE_TIMEOUT", "900"))
TARGETS = os.environ.get("BASAL_TARGETS", "0.01,0.05")
MIN_PER_TYPE = os.environ.get("BASAL_MIN_PER_TYPE", "50")

# The usefulness question. Kept in one place: scoring here and the labelled
# dataset in Karakeep must ask the model exactly the same thing.
USEFULNESS_QUESTION = {
    "type": "score",
    "instructions": "Jak wartościowy jest ten materiał dla Pawła (AEC/BIM/HVAC, AI, narzędzia inżynierskie)?",
    "criteria": [
        "slaby - materiał bez wartości: marketing, szum, treść nie na temat lub pusta",
        "sredni - materiał przeciętny: pobieżny, ogólnikowy albo tylko częściowo na temat",
        "ciekawy - materiał wartościowy: konkretny, na temat, wart przeczytania i zachowania",
    ],
}
LABELS = ["slaby", "sredni", "ciekawy"]

_lock = threading.Lock()  # guards the serve child process
# Serialises every start/stop sequence: lazy starts, the idle stop and the
# stop/calibrate/restart of /train. Always taken before _lock, never after it.
_start_lock = threading.Lock()
_train_lock = threading.Lock()  # one calibration at a time
# Set while basal-calibrate holds the machine and basal-serve is stopped. /score
# answers 503 instead of waiting on a dead engine, /health reports it.
_calibrating = threading.Event()
# Set while a lazy start waits for the engine to become ready.
_starting = threading.Event()
# Set on SIGTERM/SIGINT so a start in progress gives up instead of blocking exit.
_stopping = threading.Event()
# Requests doing scoring or training work. The idle watchdog never stops the
# engine while this is non-zero; it holds _inflight_lock while it decides and
# stops, so a request cannot slip in between the check and the stop.
_inflight = 0
_inflight_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=SCORE_CONCURRENCY)


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 60.0):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def engine_version() -> str | None:
    try:
        import importlib.metadata as md

        return md.version("basal")
    except Exception:  # pragma: no cover - metadata missing is not fatal
        return None


class ServeProcess:
    """Child `basal-serve` bound to loopback, restarted with a new calibration."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.ready = False  # set once wait_ready() succeeded for self.proc
        self.calibration_path: Path | None = None
        self.log_path = BRIDGE_DIR / "basal-serve.log"
        # time.monotonic() of the last /score or /train activity, None until the first.
        self.last_used: float | None = None

    # -- state ---------------------------------------------------------------
    def calibration_id(self) -> str | None:
        if self.calibration_path and self.calibration_path.exists():
            return sha256_file(self.calibration_path)
        return None

    def touch(self) -> None:
        self.last_used = time.monotonic()

    def idle_seconds(self) -> float | None:
        if self.last_used is None:
            return None
        return time.monotonic() - self.last_used

    def _command(self, calibration: Path | None) -> list[str]:
        cmd = [
            str(SERVE_BIN),
            "--model",
            str(MODEL_DIR),
            "--mode",
            MODE,
            "--host",
            SERVE_HOST,
            "--port",
            str(SERVE_PORT),
        ]
        if MODE == "gguf":
            cmd += ["--gguf", str(GGUF_PATH)]
        elif MODE == "llamacpp":
            cmd += ["--llamacpp-url", os.environ.get("BASAL_LLAMACPP_URL", "http://127.0.0.1:8080")]
        elif MODE == "ollama":
            cmd += [
                "--ollama-url",
                os.environ.get("BASAL_OLLAMA_URL", "http://127.0.0.1:11434"),
                "--ollama-model",
                os.environ.get("BASAL_OLLAMA_MODEL", "basal-2.0-mini:q8_0"),
            ]
        if calibration and calibration.exists():
            cmd += ["--calibration", str(calibration)]
        return cmd

    # -- lifecycle -----------------------------------------------------------
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def serving(self) -> bool:
        """Running and past wait_ready: the process is alive during a start too."""
        return self.ready and self.running()

    def wait_ready(self, timeout: float = START_TIMEOUT) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if _stopping.is_set():
                log("basal-bridge is shutting down; abandoning the basal-serve start")
                return False
            if self.proc is not None and self.proc.poll() is not None:
                log("basal-serve exited during startup")
                return False
            try:
                http_json("GET", f"http://{SERVE_HOST}:{SERVE_PORT}/health", timeout=3)
                return True
            except Exception:
                # Short poll: a request is waiting on this cold start.
                time.sleep(0.25)
        return False

    def ensure_running(self) -> bool:
        """Start the engine if it is down and block until it is ready.

        Returns True when this call started the engine. Raises RuntimeError when
        the start failed.
        """
        if self.serving():
            return False
        with _start_lock:
            if self.serving():
                # Another request (or a /train restart) won the race.
                return False
            calibration = self.calibration_path or self.load_active_calibration()
            log("basal-serve is down; starting it for an incoming request")
            _starting.set()
            try:
                self.start(calibration)
            finally:
                _starting.clear()
            # The idle clock starts when the engine is ready, not when the
            # request arrived: a slow start must not count as idle time.
            self.touch()
            return True

    def start(self, calibration: Path | None) -> None:
        with _lock:
            self.stop_locked()
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            logf = self.log_path.open("a", encoding="utf-8")
            logf.write(f"\n=== start {time.strftime('%Y-%m-%dT%H:%M:%S')} ===\n")
            logf.flush()
            with logf:  # the child keeps its own copy of the descriptor
                self.proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                    self._command(calibration),
                    stdout=logf,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            self.calibration_path = calibration
            if not self.wait_ready():
                log(f"basal-serve did not become ready; see {self.log_path}")
                self.stop_locked()
                raise RuntimeError(f"basal-serve did not start, see {self.log_path}")
            self.ready = True
            self.save_state()
            log(f"basal-serve ready on {SERVE_HOST}:{SERVE_PORT} (mode {MODE})")

    def stop_locked(self) -> None:
        self.ready = False
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.proc = None

    def stop(self) -> None:
        with _lock:
            self.stop_locked()

    def restart(self, calibration: Path | None) -> None:
        self.start(calibration)

    # -- persisted active calibration ---------------------------------------
    def save_state(self) -> None:
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(
                json.dumps(
                    {
                        "calibration": str(self.calibration_path) if self.calibration_path else None,
                        "model": str(MODEL_DIR),
                        "mode": MODE,
                        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    },
                    indent=1,
                ),
                encoding="utf-8",
            )
        except OSError as exc:  # pragma: no cover
            log(f"could not persist bridge state: {exc}")

    def load_active_calibration(self) -> Path | None:
        """The active calibration: last trained one if present, else the shipped one."""
        if STATE_FILE.exists():
            try:
                state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                candidate = state.get("calibration")
                if candidate and Path(candidate).exists():
                    return Path(candidate)
            except (OSError, ValueError) as exc:
                log(f"ignoring unreadable state file: {exc}")
        if SHIPPED_CALIBRATION.exists():
            return SHIPPED_CALIBRATION
        return None


serve = ServeProcess()


# -- idle lifecycle ------------------------------------------------------------
@contextmanager
def in_flight():
    """Mark a /score or /train request as busy and reset the idle clock."""
    global _inflight
    with _inflight_lock:
        _inflight += 1
        serve.touch()
    try:
        yield
    finally:
        with _inflight_lock:
            _inflight -= 1
            serve.touch()


def inflight_count() -> int:
    with _inflight_lock:
        return _inflight


def idle_tick(idle_timeout: float | None = None) -> bool:
    """Stop the engine when it has been idle long enough. True when it stopped it."""
    timeout = IDLE_TIMEOUT if idle_timeout is None else idle_timeout
    if timeout <= 0 or not serve.running() or _calibrating.is_set():
        return False
    # A start, an idle stop or a calibration is in progress: try again next tick.
    if not _start_lock.acquire(blocking=False):
        return False
    try:
        with _inflight_lock:
            idle = serve.idle_seconds()
            if (
                _inflight > 0
                or _calibrating.is_set()
                or not serve.running()
                or idle is None
                or idle < timeout
            ):
                return False
            log(f"basal-serve idle for {idle:.0f}s (timeout {timeout:g}s); stopping it")
            serve.stop()
            return True
    finally:
        _start_lock.release()


def idle_watchdog(stop: threading.Event, idle_timeout: float | None = None) -> None:
    timeout = IDLE_TIMEOUT if idle_timeout is None else idle_timeout
    if timeout <= 0:
        return
    tick = max(0.1, min(1.0, timeout / 5))
    while not stop.wait(tick):
        try:
            idle_tick(timeout)
        except Exception as exc:  # noqa: BLE001 - the watchdog must survive
            log(f"idle watchdog error: {type(exc).__name__}: {exc}")


def health_payload() -> dict:
    proc = serve.proc  # one snapshot: a concurrent stop may clear serve.proc
    exit_code = proc.poll() if proc is not None else None
    running = proc is not None and exit_code is None
    idle = serve.idle_seconds()
    info = {
        "ok": False,
        "model": MODEL_DIR.name,
        "mode": MODE,
        "calibration_id": serve.calibration_id(),
        "calibration_path": str(serve.calibration_path) if serve.calibration_path else None,
        "engine_version": engine_version(),
        "bridge_version": VERSION,
        "serve_running": running,
        "serve_idle": proc is None and not _calibrating.is_set(),
        "serve_starting": _starting.is_set(),
        "idle_timeout_s": IDLE_TIMEOUT,
        "idle_seconds": round(idle, 1) if idle is not None else None,
        "calibrating": _calibrating.is_set(),
    }
    if _calibrating.is_set():
        # basal-serve is stopped on purpose while basal-calibrate runs.
        info["error"] = "calibration in progress; the engine is stopped until it finishes"
        return info
    if _starting.is_set():
        # A request is waiting on a cold start; it will get a normal answer.
        info["ok"] = True
        return info
    if proc is None:
        # Never started or stopped after the idle timeout: the next /score or
        # /train starts it. Nothing listens on the engine port, do not probe it.
        info["ok"] = True
        return info
    if exit_code is not None:
        info["error"] = f"basal-serve exited with code {exit_code}; see {serve.log_path}"
        return info
    try:
        probe = http_json("GET", f"http://{SERVE_HOST}:{SERVE_PORT}/health", timeout=5)
        models = http_json("GET", f"http://{SERVE_HOST}:{SERVE_PORT}/v1/models", timeout=5)
        names = [m.get("name") for m in (models or {}).get("models", [])]
        info.update(
            {
                "ok": bool(probe) and probe.get("status") == "ok",
                "serve_status": probe,
                "serve_models": names,
            }
        )
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


# -- scoring ------------------------------------------------------------------
def ask_systemone(
    state: str, question: dict, question_name: str = "usefulness", timeout: float = SCORE_TIMEOUT
) -> dict:
    payload = {"state": state, "questions": {question_name: question}}
    return http_json(
        "POST", f"http://{SERVE_HOST}:{SERVE_PORT}/v1/systemone", payload, timeout=timeout
    )


def score_one(item: dict, question: dict, question_name: str = "usefulness") -> dict:
    answer = ask_systemone(item["state"], question, question_name)["answers"][question_name]
    raw = answer.get("probabilities") or {}
    probs = {LABELS[int(k)]: float(v) for k, v in raw.items() if str(k).isdigit()}
    for label in LABELS:
        probs.setdefault(label, 0.0)
    best = max(LABELS, key=lambda lab: (probs[lab], -LABELS.index(lab)))
    return {
        "id": item["id"],
        "score": float(answer.get("score", 0.0)),
        "label": best,
        "probabilities": probs,
        "confidence": float(answer.get("confidence", probs[best])),
        "model": MODEL_DIR.name,
        "calibration_id": serve.calibration_id(),
        "latency_ms": None,
    }


def score_items(items: list[dict], question: dict, question_name: str = "usefulness") -> list[dict]:
    started = time.time()
    futures = [_pool.submit(score_one, item, question, question_name) for item in items]
    results = []
    errors = []
    for item, fut in zip(items, futures):
        try:
            res = fut.result()
            results.append(res)
        except Exception as exc:  # noqa: BLE001 - reported per item
            errors.append({"id": item.get("id"), "error": f"{type(exc).__name__}: {exc}"})
    elapsed = time.time() - started
    if results:
        per_item = elapsed / len(results)
        for res in results:
            res["latency_ms"] = round(per_item * 1000, 1)
    if errors:
        return results, errors
    return results, []


# -- calibration ---------------------------------------------------------------
_NUM = r"[-+]?\d+(?:\.\d+)?"


def parse_report(raw: str) -> dict:
    """Pull the headline numbers out of the basal-calibrate table."""
    accuracy = None
    ece = None
    temperatures: dict[str, str] = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[0] == "score" and re.fullmatch(_NUM, parts[4]):
            accuracy = float(parts[4])
            tail = line.split("->")
            if len(tail) >= 2:
                temperatures["score"] = tail[0].strip().split()[-2:]
                ece = None
                m = re.search(r"(" + _NUM + r")\s*->\s*(" + _NUM + r")\s*$", line.strip())
                if m:
                    ece = float(m.group(2))
    automated = {}
    for line in raw.splitlines():
        m = re.match(r"max_error\s+(" + _NUM + r")\s+(" + _NUM + r"%)\s+\S+\s+(" + _NUM + r"%)", line)
        if m:
            automated[m.group(1)] = {
                "coverage": m.group(2),
                "error": m.group(3),
            }
    return {"accuracy": accuracy, "ece": ece, "temperatures": temperatures, "automated": automated}


def run_train(requests: list[str]) -> dict:
    CALIBRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S")
    dataset = CALIBRATIONS_DIR / f"dataset-{stamp}.jsonl"
    dataset.write_text("\n".join(requests) + "\n", encoding="utf-8")
    out = CALIBRATIONS_DIR / f"calibration-{stamp}.json"
    cmd = [
        str(CALIBRATE_BIN),
        str(dataset),
        "--model",
        str(MODEL_DIR),
        "--mode",
        MODE,
        "--no-calibration",
        "--targets",
        TARGETS,
        "--min-per-type",
        MIN_PER_TYPE,
        "--out",
        str(out),
    ]
    if MODE == "gguf":
        cmd += ["--gguf", str(GGUF_PATH)]
    if shutil.which("nice"):
        # Keep the box responsive for the desktop while the calibration runs.
        cmd = ["nice", "-n", "10", *cmd]
    # basal-calibrate loads its own copy of the model (~1.7 GB resident) and uses
    # every core. Running it next to basal-serve doubled peak memory and made a
    # concurrent 3-item /score time out after 244 s on this box, so the engine is
    # stopped for the duration and restarted with the new file afterwards.
    # _start_lock is held from the stop to the restart so no /score can start
    # the engine next to basal-calibrate; such a request waits for the restart.
    with _start_lock:
        return _calibrate_locked(requests, cmd, stamp, out)


def _calibrate_locked(requests: list[str], cmd: list[str], stamp: str, out: Path) -> dict:
    previous = serve.calibration_path or serve.load_active_calibration()
    log(f"basal-calibrate start ({len(requests)} requests); basal-serve stopped")
    serve.stop()
    _calibrating.set()
    started = time.time()
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            cmd, capture_output=True, text=True, timeout=TRAIN_TIMEOUT, check=False
        )
        raw = (proc.stdout or "") + (proc.stderr or "")
        (CALIBRATIONS_DIR / f"report-{stamp}.txt").write_text(raw, encoding="utf-8")
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError(
                f"basal-calibrate failed (exit {proc.returncode}): {raw[-2000:]}"
            )
        duration_s = time.time() - started
        cert_id = sha256_file(out)
        final = CALIBRATIONS_DIR / f"{cert_id}.json"
        out.replace(final)
        parsed = parse_report(raw)
        try:
            cal = json.loads(final.read_text(encoding="utf-8"))
            fitted = cal.get("fitted_on") or {}
            parsed["decisions"] = fitted.get("decisions")
            parsed["fit"] = fitted.get("fit")
            parsed["cert"] = fitted.get("cert")
            parsed["temperatures"] = cal.get("temperatures") or parsed.get("temperatures")
            parsed["thresholds"] = cal.get("thresholds") or {}
        except (OSError, ValueError) as exc:
            log(f"could not read the calibration file for the report: {exc}")
    except BaseException:
        # Never leave the engine down: restore whatever calibration was active.
        _calibrating.clear()
        try:
            serve.start(previous)
            serve.touch()
        except Exception as exc:  # noqa: BLE001 - report the calibration error, not this one
            log(f"basal-serve did not restart after the failed calibration: {exc}")
        raise
    _calibrating.clear()
    log(f"basal-calibrate done in {duration_s:.0f}s, calibration {cert_id}")
    restart_started = time.monotonic()
    serve.restart(final)
    restart_ms = round((time.monotonic() - restart_started) * 1000, 1)
    serve.touch()
    return {
        "calibration_id": cert_id,
        "path": str(final),
        "duration_s": round(duration_s),
        "restart_ms": restart_ms,
        "report": {
            "accuracy": parsed.get("accuracy"),
            "ece": parsed.get("ece"),
            "decisions": parsed.get("decisions") or len(requests),
            "fit": parsed.get("fit"),
            "cert": parsed.get("cert"),
            "automated_share": parsed.get("automated"),
            "thresholds": parsed.get("thresholds") or {},
            "duration_s": round(duration_s),
            "raw": raw[-4000:],
        },
    }


# -- HTTP layer ----------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = f"basal-bridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # keep the journal readable
        log(f"{self.address_string()} {fmt % args}")

    # -- helpers ------------------------------------------------------------
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError) as exc:
            # The caller went away mid-response (client timeout, cancelled or
            # restarted job). One line, no traceback: the work is simply gone.
            log(f"client disconnected before the response was written ({type(exc).__name__})")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes -------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            self._send(200, self.health())
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        try:
            body = self._body()
        except ValueError as exc:
            self._send(400, {"error": f"invalid JSON body: {exc}"})
            return
        if path == "/score":
            self.handle_score(body)
        elif path == "/train":
            self.handle_train(body)
        else:
            self._send(404, {"error": "not found"})

    def health(self) -> dict:
        return health_payload()

    def handle_score(self, body: dict) -> None:
        items = body.get("items") or []
        if not isinstance(items, list) or not items:
            self._send(400, {"error": "items must be a non-empty list"})
            return
        question = body.get("question") or USEFULNESS_QUESTION
        question_name = body.get("questionName") or "usefulness"
        if not isinstance(question_name, str):
            self._send(400, {"error": "questionName must be a string"})
            return
        if _calibrating.is_set():
            self._send(
                503,
                {
                    "ok": False,
                    "error": "calibration in progress; the engine is stopped until it finishes",
                    "health": self.health(),
                },
            )
            return
        with in_flight():
            start_began = time.monotonic()
            try:
                # Blocks through a cold start (or a /train restart) so the caller
                # gets a real answer instead of a 503.
                engine_started = serve.ensure_running()
            except Exception as exc:  # noqa: BLE001
                self._send(
                    503,
                    {
                        "ok": False,
                        "error": f"basal-serve failed to start: {exc}",
                        "health": self.health(),
                    },
                )
                return
            start_ms = round((time.monotonic() - start_began) * 1000, 1) if engine_started else 0
            try:
                started = time.time()
                results, errors = score_items(items, question, question_name)
                elapsed = time.time() - started
            except Exception as exc:  # noqa: BLE001
                self._send(502, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                return
        self._send(
            200,
            {
                "ok": True,
                "results": results,
                "errors": errors,
                "model": MODEL_DIR.name,
                "calibration_id": serve.calibration_id(),
                "elapsed_ms": round(elapsed * 1000, 1),
                "engine_started": engine_started,
                "start_ms": start_ms,
            },
        )

    def handle_train(self, body: dict) -> None:
        requests = body.get("requests") or []
        if not isinstance(requests, list) or not requests:
            self._send(400, {"error": "requests must be a non-empty list of JSON lines"})
            return
        if not _train_lock.acquire(blocking=False):
            self._send(409, {"ok": False, "error": "a calibration is already running"})
            return
        try:
            with in_flight():
                result = run_train(requests)
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": f"basal-calibrate timed out after {TRAIN_TIMEOUT}s"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return
        finally:
            _train_lock.release()
        self._send(200, {"ok": True, **result})


def detect_bind_host() -> str:
    """Default to the Karakeep docker bridge gateway when we can find it."""
    if os.environ.get("BASAL_BRIDGE_HOST"):
        return os.environ["BASAL_BRIDGE_HOST"]
    try:
        out = subprocess.run(  # noqa: S603,S607 - fixed argv
            ["docker", "network", "inspect", "karakeep_default", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        gw = (out.stdout or "").strip()
        if out.returncode == 0 and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", gw):
            return gw
    except Exception as exc:  # noqa: BLE001
        log(f"could not detect the docker gateway: {exc}")
    return "127.0.0.1"


_server: ThreadingHTTPServer | None = None
_watchdog_stop = threading.Event()


def request_shutdown(reason: str = "shutdown requested") -> None:
    """Stop serving and let main() stop the engine. Safe from a signal handler."""
    log(f"{reason}; stopping basal-bridge")
    _stopping.set()
    _watchdog_stop.set()
    if _server is not None:
        # shutdown() blocks until serve_forever() returns, and serve_forever()
        # runs on the thread the signal handler interrupted: call it elsewhere.
        threading.Thread(target=_server.shutdown, daemon=True).start()


def _install_signal_handlers() -> None:
    if threading.current_thread() is not threading.main_thread():
        return  # signal.signal only works there; tests run main() in a thread
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda num, _frame: request_shutdown(signal.Signals(num).name))


def main() -> int:
    global BIND_HOST, _server
    BIND_HOST = detect_bind_host()
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    CALIBRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    # The engine is not started here: the first /score or /train starts it.
    # Resolve the calibration anyway so /health reports its id while stopped.
    serve.calibration_path = serve.load_active_calibration()
    _server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    _install_signal_handlers()
    threading.Thread(
        target=idle_watchdog, args=(_watchdog_stop,), name="idle-watchdog", daemon=True
    ).start()
    idle = f"idle timeout {IDLE_TIMEOUT:g}s" if IDLE_TIMEOUT > 0 else "idle stop disabled"
    log(f"basal-bridge {VERSION} on http://{BIND_HOST}:{BIND_PORT} (engine {SERVE_HOST}:{SERVE_PORT} on demand, {idle}, model {MODEL_DIR.name}, mode {MODE})")
    try:
        _server.serve_forever()
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        _stopping.set()
        _watchdog_stop.set()
        _server.server_close()
        serve.stop()
        log("basal-bridge stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
