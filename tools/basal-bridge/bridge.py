#!/usr/bin/env python3
"""basal-bridge: the only HTTP surface Karakeep is allowed to talk to.

It owns a `basal-serve` child process (loopback only), exposes three endpoints on
the Docker bridge gateway, and owns the calibration lifecycle:

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
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"

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
BIND_HOST = os.environ.get("BASAL_BRIDGE_HOST", "0.0.0.0")
BIND_PORT = int(os.environ.get("BASAL_BRIDGE_PORT", "8010"))
SCORE_TIMEOUT = float(os.environ.get("BASAL_SCORE_TIMEOUT", "180"))
TRAIN_TIMEOUT = float(os.environ.get("BASAL_TRAIN_TIMEOUT", "1800"))
SCORE_CONCURRENCY = int(os.environ.get("BASAL_SCORE_CONCURRENCY", "4"))
START_TIMEOUT = float(os.environ.get("BASAL_START_TIMEOUT", "180"))
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
_train_lock = threading.Lock()  # one calibration at a time
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
        self.calibration_path: Path | None = None
        self.log_path = BRIDGE_DIR / "basal-serve.log"

    # -- state ---------------------------------------------------------------
    def calibration_id(self) -> str | None:
        if self.calibration_path and self.calibration_path.exists():
            return sha256_file(self.calibration_path)
        return None

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

    def wait_ready(self, timeout: float = START_TIMEOUT) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                log("basal-serve exited during startup")
                return False
            try:
                http_json("GET", f"http://{SERVE_HOST}:{SERVE_PORT}/health", timeout=3)
                return True
            except Exception:
                time.sleep(1.0)
        return False

    def start(self, calibration: Path | None) -> None:
        with _lock:
            self.stop_locked()
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            logf = self.log_path.open("a", encoding="utf-8")
            logf.write(f"\n=== start {time.strftime('%Y-%m-%dT%H:%M:%S')} ===\n")
            logf.flush()
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
            self.save_state()
            log(f"basal-serve ready on {SERVE_HOST}:{SERVE_PORT} (mode {MODE})")

    def stop_locked(self) -> None:
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
    log(f"basal-calibrate start ({len(requests)} requests)")
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        cmd, capture_output=True, text=True, timeout=TRAIN_TIMEOUT, check=False
    )
    raw = (proc.stdout or "") + (proc.stderr or "")
    (CALIBRATIONS_DIR / f"report-{stamp}.txt").write_text(raw, encoding="utf-8")
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"basal-calibrate failed (exit {proc.returncode}): {raw[-2000:]}")
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
    log(f"basal-calibrate done, calibration {cert_id}")
    serve.restart(final)
    return {
        "calibration_id": cert_id,
        "path": str(final),
        "report": {
            "accuracy": parsed.get("accuracy"),
            "ece": parsed.get("ece"),
            "decisions": parsed.get("decisions") or len(requests),
            "fit": parsed.get("fit"),
            "cert": parsed.get("cert"),
            "automated_share": parsed.get("automated"),
            "thresholds": parsed.get("thresholds") or {},
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
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        info = {
            "ok": False,
            "model": MODEL_DIR.name,
            "mode": MODE,
            "calibration_id": serve.calibration_id(),
            "calibration_path": str(serve.calibration_path) if serve.calibration_path else None,
            "engine_version": engine_version(),
            "bridge_version": VERSION,
            "serve_running": serve.running(),
        }
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
        if not serve.running():
            self._send(503, {"ok": False, "error": "basal-serve is not running", "health": self.health()})
            return
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


def main() -> int:
    global BIND_HOST
    BIND_HOST = detect_bind_host()
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    CALIBRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    active = serve.load_active_calibration()
    try:
        serve.start(active)
    except Exception as exc:  # noqa: BLE001 - keep serving /health so the UI can show why
        log(f"basal-serve failed to start: {exc}")
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    log(f"basal-bridge {VERSION} on http://{BIND_HOST}:{BIND_PORT} (engine {SERVE_HOST}:{SERVE_PORT}, model {MODEL_DIR.name}, mode {MODE})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        serve.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
