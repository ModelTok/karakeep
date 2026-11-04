# Recommendations: a native Basal server on the GPU

Karakeep's daily digest can rank the day's links by how well they fit **your taste**, using
[Basal](https://github.com/rkinas/basal), a small model that answers typed questions with calibrated probabilities
(no text generation). This folder installs and runs the Basal server **natively on Windows, on the GPU, without Docker**.
Karakeep (in Docker) calls it over HTTP.

## What it does

When `BASAL_URL` is set, each daily digest:

1. builds a **taste profile** from what you have already told Karakeep: articles you **favourited** (interested) and
   **archived** (not interested), newest first (up to 30 and 40; with only archived items it ranks by "least likely to be
   archived");
2. asks Basal one yes/no question per new article ("would this reader favourite it, or archive it?");
3. gives the **best-fitting articles to the briefing model first** (instead of the oldest), and adds a
   **"Picked for you"** section (`DIGEST_PICKS`, default 10) between the briefing and "Also saved".

Anything that goes wrong (Basal down, slow, or wrong; no favourites or archived items yet) is logged and the digest is
built exactly as it was before. Articles you already archived are never recommended back to you.

## Install

```powershell
cd deploy
Copy-Item .env.example .env          # if you have not already
.\basal-gpu\setup.ps1                # idempotent: verifies what is there, installs the rest, starts the servers
docker compose up -d web             # picks up BASAL_URL / BASAL_API_KEY
```

`setup.ps1` needs [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`) and a GPU driver with Vulkan. It
installs, under `%USERPROFILE%\basal-gpu` and without administrator rights:

| what | where | checked |
|---|---|---|
| llama.cpp `b12109`, Windows Vulkan build | `llama.cpp\` | pinned SHA-256 |
| `basal-2.0-mini` Q8_0 GGUF (1.7 GB, Apache-2.0) from Hugging Face | `models\basal-2.0-mini-GGUF\` | pinned SHA-256 |
| Python 3.12 + Basal 2.5.3 + CPU PyTorch (used only for prompt handling) | `venv\` | |
| `api-keys.json`: only a SHA-256 digest of the key | | the secret goes into `deploy\.env` as `BASAL_API_KEY` |
| `supervisor.ps1` and, unless `-NoTask`, the scheduled task **Karakeep Basal GPU server** | | |

Use `-Cpu` to run the model on the CPU instead of the GPU, `-NoTask` to skip the scheduled task.

## How it is wired

```
Karakeep (Docker)  --http, Bearer key-->  basal-serve  127.0.0.1:8000   (native, Python)
                      host.docker.internal               |
                                                         v
                                          llama-server   127.0.0.1:8080   (native, llama.cpp Vulkan, GPU)
```

* Both servers listen on **loopback only**. Docker Desktop forwards `host.docker.internal` to the host's loopback, so
  nothing is exposed to your network and no firewall rule is needed. (On Linux the compose file maps
  `host.docker.internal` to the host gateway, but the server would then have to listen on that interface; keep the API key.)
* `basal-serve` requires the API key (`--api-keys`); `GET /health` stays open. `llama-server` itself has no key, so do
  not forward port 8080.

## Operating it

```powershell
$d = "$env:USERPROFILE\basal-gpu"
& $d\supervisor.ps1                # start whatever is not healthy
& $d\supervisor.ps1 -Restart       # restart both
& $d\supervisor.ps1 -Stop          # stop both
& $d\supervisor.ps1 -Cpu           # run on the CPU
Get-Content $d\logs\supervisor.log -Tail 20
Disable-ScheduledTask -TaskName 'Karakeep Basal GPU server'    # pause the automatic checks
```

The supervisor starts only what is down, falls back to the CPU if the GPU server will not come up, and logs only when it
acts. Without the scheduled task nothing restarts Basal after a reboot; Karakeep simply builds digests without
recommendations until you run `supervisor.ps1` again.

## Settings (`deploy\.env`)

| variable | default | |
|---|---|---|
| `BASAL_URL` | unset (feature off) | `http://host.docker.internal:8000` |
| `BASAL_API_KEY` | unset | the secret `setup.ps1` generated |
| `BASAL_TIMEOUT_SEC` | 300 | give up and build the digest without recommendations |
| `BASAL_CHUNK` | 40 | articles judged per request (the model has an 8,192-token context) |
| `DIGEST_PICKS` | 10 | length of "Picked for you"; `0` keeps the ranking but drops the section |

## What to expect (measured on this machine: Ryzen AI 9 HX 470, Radeon 890M, 12 cores, Windows)

* **Speed.** Ranking 61 articles against a 44-item profile takes **7 to 13 seconds** (about 0.1 to 0.2 s per article);
  a day of about 100 articles is well under a minute. The same request took 77 s in Docker on the CPU. Most of that gap
  is native versus Docker: llama.cpp's own benchmark on this model gives 1,237 tokens/s on the GPU and 1,010 on the CPU
  for reading prompts, and about 35 on both for generating, because the integrated GPU shares the CPU's memory.
* **Quality.** Hiding each of 39 archived articles in turn and asking Basal to find it among 61 ordinary ones: mean rank
  **13.2 of 61**, AUC **0.80**, in the top 5 in **51%** of cases, against 27.0 / 0.57 / 15% for `nomic-embed-text`
  embeddings and 25.6 / 0.59 / 28% for word-overlap (random: 31 / 0.50 / 0%). Hiding each of 5 favourites: Basal mean
  rank **7.4 of 61** against 11.8 and 14.4. Five favourites is anecdotal.
* **It improves with data.** With 21 archived items instead of 39 the same test gave AUC 0.74 and was no better than
  word-overlap. Favourite and archive more, and re-check.
* **It is a ranking, not a verdict.** Scores are compressed (typically 0.2 to 0.6), so only the order is meaningful.

## Limits

* Basal's `rank` type is marked experimental by its authors, and `basal-2.0-mini` is a 1.5B model: validate on your own
  reading before trusting it.
* Basal's docs say the Vulkan path was tested by its authors on one device (an Apple GPU). Here it runs on a Radeon
  890M; see "GPU versus CPU" below for how closely it agrees with the CPU.
* The quality of the picks depends entirely on your favourites and archive; with none, nothing is ranked.

## GPU versus CPU

The same 53 articles were scored against the same profile on the GPU and on the CPU (`-ngl 0`):

| | GPU | CPU |
|---|---|---|
| time for the 53-article ranking | 10.9 s | 20.6 s |
| rank correlation (Spearman) | 0.991 | |
| score difference | mean 0.008, max 0.029 | |
| same top 5 / top 10 | 5 of 5 / 9 of 10 | |

So the Vulkan path on the Radeon 890M gives the same answers as the CPU, to within rounding, and is about 1.9 times
faster. Both are far faster than the Docker CPU spike (about 1.6 s per article, against 0.39 s for native CPU and 0.21 s
for native GPU). One run on one day's articles: re-check if you change the model, llama.cpp or the driver.
