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
 "engine_version": "2.4.1", "bridge_version": "1.0.0", "serve_running": true,
 "serve_status": {"status": "ok"}, "serve_models": ["basal-2.0-mini-GGUF"]}
```

`ok` is false (with `error`) when the child engine is down; the endpoint never throws.

### `POST /score`

```json
{"items": [{"id": "bookmark-id", "state": "Tytuł: ...\nDomena: ...\nTreść: ..."}]}
```

Response per item: `score` (expected level 0..2), `label` (`slaby` / `sredni` / `ciekawy`,
argmax), `probabilities` keyed by label, `confidence`, `model`, `calibration_id`,
`latency_ms`. `question` may be supplied to override the default usefulness question
(the rubric lives in `USEFULNESS_QUESTION` in `bridge.py`).

### `POST /train`

```json
{"requests": ["{\"id\": \"...\", \"group\": \"feed:...\", \"state\": \"...\", \"questions\": {...\"gold\": 2}}", "..."]}
```

Runs `basal-calibrate` in a subprocess with the same model/mode and `--targets 0.01,0.05
--min-per-type 50`, writes `~/basal-bridge/calibrations/<sha256>.json`, restarts
`basal-serve` with it and returns `{calibration_id, path, report}` where `report` holds
accuracy, ECE, fitted thresholds and the automated share. Timeout 1800 s; one calibration
at a time (409 while busy).

## Install

```bash
~/basal-bridge/install.sh          # installs the systemd --user unit and starts it
systemctl --user status basal-bridge
journalctl --user -u basal-bridge -n 50
```

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

A copy of these files lives in the Karakeep repo under `tools/basal-bridge/`.
