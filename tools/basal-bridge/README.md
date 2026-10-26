# basal-bridge

Host-side HTTP bridge between the Karakeep container and the local `basal` decision engine.
Karakeep never talks to `basal-serve` directly; it only knows `BASAL_BRIDGE_URL`.

```
Karakeep (container)  ->  http://host.docker.internal:8010  ->  basal-bridge  ->  basal-serve 127.0.0.1:8011
```

## Why a bridge

* `basal-serve` has **no authentication**. It must stay on loopback, so something has to
  expose a narrow, typed surface to the container.
* The bridge owns the `basal-serve` child process and the calibration lifecycle: after a
  successful calibration it restarts the engine with the new calibration file.
* Karakeep only needs two verbs (`score`, `train`) plus `health`; it does not need the full
  `systemone` API, prompt rendering, option orders or log-probability handling.

Binding: the bridge binds to the **Karakeep docker bridge gateway** (detected with
`docker network inspect karakeep_default -f '{{(index .IPAM.Config 0).Gateway}}'`,
`172.22.0.1` on this host). That address is reachable from containers on that network and
from nothing else - not from the LAN, not from Tailscale.

## Verified versions on this host

| Component | Value |
|---|---|
| `basal` pip package | **2.4.1** (`uv pip install --python ~/basal-env/bin/python 'basal==2.4.1'`) |
| Model | `Remek/basal-2.0-mini-GGUF`, `basal-2.0-mini-Q8_0.gguf` (1.70 GB) |
| Mode | `gguf` (llama-cpp-python 0.3.36, CPU only, i7-7700) |
| Shipped calibration | `CALIBRATION.llamacpp.json` from the same HF repo (sha256 is the calibration id) |
| Python | 3.12.13 in `~/basal-env` (uv) |

`BASAL_MODEL` and `BASAL_MODE` are the only knobs needed to switch to `basal-omni-pico`
(812 MB) or to `llamacpp`/`ollama` mode - nothing in the logic is hardcoded.

## API

### `GET /health`

```json
{"ok": true, "model": "basal-2.0-mini-GGUF", "mode": "gguf",
 "calibration_id": "10e962ea...", "calibration_path": "/home/pawel/models/.../CALIBRATION.llamacpp.json",
 "engine_version": "2.4.1", "bridge_version": "1.1.0", "serve_running": true,
 "serve_idle": false, "serve_starting": false, "idle_timeout_s": 900.0, "idle_seconds": 12.3,
 "calibrating": false, "serve_status": {"status": "ok"}, "serve_models": ["basal-2.0-mini-GGUF"]}
```

The endpoint never throws. States:

| Engine state | `ok` | `serve_running` | other fields |
|---|---|---|---|
| running and answering | `true` | `true` | `serve_status`, `serve_models` |
| never started yet, or stopped after the idle timeout | `true` | `false` | `serve_idle: true`; the port is not probed |
| starting for a waiting request | `true` | `true` | `serve_starting: true` |
| calibration in progress | `false` | `false` | `calibrating: true`, `error` |
| started, then the process died | `false` | `false` | `error` names the exit code |

`calibration_id` is reported in every state, also while the engine is stopped.

### `POST /score`

```json
{"items": [{"id": "bookmark-id", "state": "Tytuł: ...\nDomena: ...\nTreść: ..."}]}
```

Response per item: `score` (expected level 0..2), `label` (`slaby` / `sredni` / `ciekawy`,
argmax), `probabilities` keyed by label, `confidence`, `model`, `calibration_id`,
`latency_ms`. `question` may be supplied to override the default usefulness question
(the rubric lives in `USEFULNESS_QUESTION` in `bridge.py`).

Top level: `ok`, `results`, `errors`, `model`, `calibration_id`, `elapsed_ms` (scoring
only), `engine_started` (true when this request had to start the engine) and `start_ms`
(time spent starting it, `0` when it was already up). A request that arrives while the
engine is starting waits for it and gets a normal answer, never a 503. `/score` answers
503 only while a calibration runs, or when the engine fails to start.

### `POST /train`

```json
{"requests": ["{\"id\": \"...\", \"group\": \"feed:...\", \"state\": \"...\", \"questions\": {...\"gold\": 2}}", "..."]}
```

Runs `basal-calibrate` in a subprocess with the same model/mode and `--targets 0.01,0.05
--min-per-type 50`, writes `~/basal-bridge/calibrations/<sha256>.json`, restarts
`basal-serve` with it and returns `{calibration_id, path, duration_s, restart_ms, report}`
where `report` holds accuracy, ECE, fitted thresholds and the automated share and
`restart_ms` is the engine restart time after the calibration. Timeout `BASAL_TRAIN_TIMEOUT`
(3600 s); one calibration at a time (409 while busy). The engine is stopped while
`basal-calibrate` runs; a `/score` that arrives then gets 503, and nothing can start the
engine until the restart with the new calibration is done.

## Engine lifecycle: lazy start and idle stop

`basal-serve` holds about 1.94 GB RSS, so the bridge does not keep it up:

* The bridge does **not** start the engine at boot. The first `/score` or `/train` starts
  it (cold start, ~10 s on this host for `basal-2.0-mini` Q8_0) and waits until it answers.
  Concurrent requests share that one start (`_start_lock`); none of them gets a 503.
* After `BASAL_IDLE_TIMEOUT` seconds (default **900**) without a `/score` or `/train`
  request, a watchdog thread stops the engine. The idle clock restarts at the start and
  the end of every request, and the engine is never stopped while a request is in flight
  or a calibration runs. `BASAL_IDLE_TIMEOUT=0` disables the stop (the start stays lazy).
* `/health` does not start the engine and does not count as activity.
* On SIGTERM/SIGINT (`systemctl --user stop`) the bridge stops the engine and exits 0, so
  port 8011 is free afterwards.

Verify on the host:

```bash
GW=172.22.0.1
curl -s http://$GW:8010/health | jq '{ok, serve_running, serve_idle, idle_seconds}'
# -> ok true, serve_running false, serve_idle true while idle
curl -s -X POST http://$GW:8010/score -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"t","state":"Tytuł: test"}]}' | jq '{ok, engine_started, start_ms, elapsed_ms}'
# -> engine_started true on the first call, false (start_ms 0) on the next one
ss -ltnp 'sport = :8011'                        # basal-serve listening while warm
journalctl --user -u basal-bridge -n 20 | grep -E 'starting it|idle for'
# after BASAL_IDLE_TIMEOUT: "basal-serve idle for 900s (timeout 900s); stopping it"
```

Tests (stdlib only, against the fake engine in `stub_serve.py`; never touch
`~/basal-bridge` or a real engine):

```bash
python3 tools/basal-bridge/test_bridge.py
```

## Install

```bash
~/basal-bridge/install.sh          # installs the systemd --user unit and starts it
systemctl --user status basal-bridge
journalctl --user -u basal-bridge -n 50
```

`install.sh` first stops whatever bridge listens on :8010 (and an orphaned `basal-serve`
on :8011), installs the files, enables lingering (`loginctl enable-linger`) so the unit
starts at boot without a login, runs `systemctl --user enable --now basal-bridge.service`
and prints `/health`. It does not wait for the engine: right after install `/health`
reports `"serve_running": false`, which is expected. Logs go to the journal.

Manual run (what the tests used):

```bash
~/basal-env/bin/python ~/basal-bridge/bridge.py
```

## Measured on this host (i7-7700, CPU only, mini Q8_0)

| Action | Time |
|---|---|
| engine start (`basal-serve`, model load) | ~10 s |
| one `score` decision, ~270-token state, idle box | 3.8-4.2 s |
| one `score` decision while another job hogs the CPU | 7.7 s |
| `/score` batch of 3 items (4 workers) | 23 s |
| `basal-calibrate` on 12 labelled lines (in process) | 31 s idle, 83 s under load |
| accuracy on that 12-line toy set | 0.917 (fitted temperature 0.758, ECE 0.536) |

Certified thresholds need far more data: a 0.05 bound needs >= 59 accepted FIT decisions,
a 0.01 bound >= 299. With 12 lines `basal-calibrate` still writes a usable calibration file
(fitted temperatures), but reports `thresholds: null`. That is expected, not a bug.

## Files

| Path | Purpose |
|---|---|
| `~/basal-bridge/bridge.py` | the whole bridge (stdlib only) |
| `~/basal-bridge/basal-bridge.service` | systemd `--user` unit |
| `~/basal-bridge/install.sh` | installer |
| `~/basal-bridge/state.json` | active calibration + model + mode |
| `~/basal-bridge/calibrations/` | `dataset-*.jsonl`, `<sha256>.json`, `report-*.txt` |
| `~/basal-bridge/basal-serve.log` | engine stdout/stderr |
| `tools/basal-bridge/test_bridge.py`, `stub_serve.py` | lifecycle tests and the fake engine they use (repo only) |

A copy of these files lives in the Karakeep repo under `tools/basal-bridge/`.
