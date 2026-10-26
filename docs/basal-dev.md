# Basal ratings, calibration and feed scoring — development notes

This document covers running the basal feature locally against a **copy** of the
production data. Production is never touched by these steps.

## What the feature is

Three user-driven pieces, all triggered from the UI:

1. **Ratings** — `Ciekawy` / `Średni` / `Słaby` on bookmarks and on feeds.
2. **Calibration** ("train") — ratings are turned into labelled `/v1/systemone`
   requests and passed to `basal-calibrate`, which fits per-question
   temperatures and certifies confidence thresholds. **Model weights never
   change.** The UI says so in one line under the button.
3. **Scoring** — `Oceń przychodzące` scores unrated, unscored, non-archived
   bookmarks; `Oceń feedy` scores each feed as a source. Scoring is manual
   only: nothing runs on `bookmarkAdded`, on a timer or on page load.

## Architecture

```
apps/web (Next.js)
   └─ packages/trpc/routers/basal.ts      session-authenticated tRPC surface
      └─ packages/trpc/lib/basalJobs.ts   in-process job runner (one job at a time)
         └─ packages/shared/basal/client.ts   typed HTTP client
            └─ basal-bridge (host, 172.22.0.1:8010)   tools/basal-bridge/
               └─ basal-serve (host, 127.0.0.1:8011)   unauthenticated, loopback only
```

- `BASAL_MODEL`, `BASAL_MODE` and the GGUF path are bridge-side environment
  variables (`tools/basal-bridge/README.md`), never hardcoded in app logic.
- The app talks to the bridge through `BASAL_BRIDGE_URL`
  (default `http://host.docker.internal:8010`). Timeouts: 900 s score,
  3600 s train. Both budgets are per request, not per decision: the bridge
  scores a batch sequentially and one full-text decision costs 45-55 s on this
  CPU (see "Measured latency" below).
- `BASAL_MOCK=1` produces deterministic hash-based scores for tests only; the
  settings page labels it loudly.

### Questions

| Kind | Question | State |
| --- | --- | --- |
| bookmark | `usefulness` (`score`, `[slaby, sredni, ciekawy]`) | title, url, domain, feed, tags, description/summary, extracted text (cap 12000 chars) |
| feed | `feed_value` (`score`, same levels) | feed name, url, last 10 headlines |

Training writes both kinds: every rated article request also carries a
`feed_value` question when that article's feed is rated (one request, two
decisions), and a feed rated with fewer than 3 rated articles gets a standalone
feed request. The group is always the feed id (or the domain for non-RSS
bookmarks), so the FIT/CERT split never leaks across one source.

### Calibration milestones

`basal-calibrate` fits on ~70% of the labelled decisions, so the thresholds
need more data than the raw counts suggest:

| Ratings | What it buys |
| --- | --- |
| 50 | minimal, sensibly fitted temperatures |
| ~85 | first certified 5% threshold |
| ~430 | certified 1% threshold |

The settings page shows these three milestones and never promises a certified
threshold at 50.

## Measured latency and model choice

Host: HP EliteDesk 800 G3 SFF, i7-7700, 16 GB RAM, CPU only, no GPU.

| Case | Measured |
| --- | --- |
| `basal-2.0-mini` Q8_0, short state (spike, 274 input tokens) | 3.8-4.2 s per decision; 7.7 s with the CPU otherwise busy |
| `basal-2.0-mini` Q8_0, full state (12 000 char text cap, ~3.5k input tokens) | 45-55 s per decision |
| `basal-calibrate` on 12 labelled lines | 83 s with the CPU busy |
| `basal-calibrate` on 25 labelled decisions, training states capped at 2 500 chars | **411 s** (~16 s per decision, measured 2026-10-26) |
| `scoreIncoming(limit=3)` end to end, 12 000 char scoring states | **121 s** (measured 2026-10-26) |
| `scoreFeeds(limit=3)`, feed summaries | **15 s** (measured 2026-10-26) |

Consequences, all of them reflected in code:

- `basal-2.0-mini` Q8_0 stays the chosen model: it is under the 8 s per decision
  budget for short states, and no measured decision came close to the 8 s
  fall-back threshold for `basal-omni-pico`.
- The score client budget scales with the batch: 90 s per item, capped at
  900 s per request (`scoreTimeoutForBatch` in
  `packages/shared/basal/client.ts`). The request goes through undici's own
  fetch with a dispatcher whose `headersTimeout`/`bodyTimeout` follow that
  budget, because Node's global fetch has a fixed 300 s header timeout that no
  option can raise — a 10-item batch of full-text states failed with
  `UND_ERR_HEADERS_TIMEOUT` before the Python-side timeout was ever reached.
- Training sends states capped at 2 500 characters (`BASAL_TRAIN_STATE_CHAR_CAP`)
  instead of the 12 000 used for scoring: calibration re-runs every labelled
  request through the model, so the cap is what keeps 25-85 decisions in the
  minutes range instead of the hours range.
- A default `maxItems` of 50 means roughly 40-45 minutes of CPU for one
  `Oceń przychodzące` click with full-text states. That is expected, not a hang;
  the job keeps its progress in the database and the settings page polls it.
- `pnpm typecheck`, `pnpm lint` and the unit tests do not need the engine, and
  `BASAL_MOCK=1` keeps the whole flow testable without a model.

## Running the dev instance

The engine and bridge are already installed on this host (`~/basal-env`,
`~/models/basal-2.0-mini-GGUF`, `~/basal-bridge`). To start the bridge:

```bash
~/basal-bridge/install.sh        # systemd --user unit, binds 172.22.0.1:8010
# or, ad hoc:
~/basal-env/bin/python ~/basal-bridge/bridge.py
curl -s http://172.22.0.1:8010/health | jq
```

The bridge keeps `basal-serve` (~1.94 GB RSS) out of RAM when idle:

- It does not start the engine at boot. The first `/score` or `/train` starts
  it and waits for it, so that request pays a cold start of ~10 s on this host
  (reported as `engine_started: true` and `start_ms` in the `/score`
  response). Requests that arrive during the start wait for the same start;
  none of them gets a 503.
- After `BASAL_IDLE_TIMEOUT` seconds without a `/score` or `/train` (default
  900, set in `basal-bridge.service`; `0` disables the stop) the engine is
  stopped. It is never stopped while a request is in flight or a calibration
  runs.
- While stopped, `/health` answers `ok: true`, `serve_running: false`,
  `serve_idle: true`, with `idle_timeout_s`, `idle_seconds` and the active
  `calibration_id`. `ok: false` means a real problem: a calibration in
  progress, or an engine process that died.
- The 90 s per item score budget on the Karakeep side absorbs the cold start.

Verify:

```bash
curl -s http://172.22.0.1:8010/health | jq '{ok, serve_running, serve_idle, idle_seconds}'
curl -s -X POST http://172.22.0.1:8010/score -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"t","state":"Tytuł: test"}]}' | jq '{ok, engine_started, start_ms}'
journalctl --user -u basal-bridge -n 20 | grep -E 'starting it|idle for'
python3 tools/basal-bridge/test_bridge.py   # stdlib tests against a fake engine
```

Then a dev instance on a copy of the production data:

```bash
DEV=~/karakeep-dev
mkdir -p "$DEV"
# 1. copy the database (safe, online backup)
sqlite3 /home/pawel/docker/karakeep/data/db.db ".backup '$DEV/db.db'"
# 2. copy assets once (about 886 MB)
cp -a /home/pawel/docker/karakeep/data/assets "$DEV/assets"
# 3. apply migrations to the copy only
cd /path/to/repo/karakeep
DATA_DIR="$DEV" pnpm db:migrate
# 4. run the web app on :3000 against the copy
cd apps/web
DATA_DIR="$DEV" \
NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
NEXTAUTH_URL="http://localhost:3000" \
BASAL_BRIDGE_URL="http://172.22.0.1:8010" \
PORT=3000 pnpm dev
```

`pnpm dev` is fine for clicking around, but it is **not** fine for running a
job: Turbopack re-evaluates the job module on any edit and the in-process job
dies with "Zadanie przerwane: serwer został zrestartowany." To exercise scoring
or calibration end to end, run a stable build instead:

```bash
cd apps/web && pnpm build
DATA_DIR="$DEV" NEXTAUTH_SECRET="..." NEXTAUTH_URL="http://localhost:3000" \
BASAL_BRIDGE_URL="http://172.22.0.1:8010" PORT=3000 pnpm start
```

`DATA_DIR` decides both the SQLite file (`$DATA_DIR/db.db`) and the assets
directory, so the copy never touches production.

To sign in on the copy without knowing the production password, set a known
password on the **copy**:

```bash
node - <<'EOF'
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const db = new Database(process.env.DEV + "/db.db");
const hash = bcrypt.hashSync("dev-only-password-123", 10);
db.prepare("UPDATE user SET password = ?, salt = '' WHERE email = ?").run(
  hash, "pawel.kinczyk@outlook.com");
db.close();
EOF
```

## Verifying without a browser

`basal.*` procedures are session-authenticated. Sign in through the normal
credentials flow and keep the cookie:

```bash
CSRF=$(curl -s -c /tmp/c.txt http://localhost:3000/api/auth/csrf | jq -r .csrfToken)
curl -s -b /tmp/c.txt -c /tmp/c.txt -X POST \
  http://localhost:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=pawel.kinczyk@outlook.com" \
  --data-urlencode "password=dev-only-password-123" \
  --data-urlencode "json=true"
TOKEN=$(awk '/session-token/{print $7}' /tmp/c.txt)
curl -s "http://localhost:3000/api/trpc/basal.status?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D" \
  -H "Cookie: next-auth.session-token=$TOKEN" | jq
```

Mutations use the batched tRPC shape:

```bash
curl -s -X POST "http://localhost:3000/api/trpc/basal.rate?batch=1" \
  -H "Cookie: next-auth.session-token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"0":{"json":{"bookmarkId":"<id>","rating":2}}}'
```

Inspect the copy directly for stored state:

```bash
sqlite3 -header -column "$DEV/db.db" \
  "select count(*) from basalRatings; select count(*) from basalScores;"
```

## Tests

```bash
cd packages/shared && pnpm vitest run basal/basal.test.ts
cd packages/trpc && pnpm vitest run routers/basal.test.ts
```

The router tests cover rating upsert/clear, article and feed gold mapping,
group assignment, feed-quality precedence, staleness, job transitions (score,
score_feeds, train) and the bridge client's request/response contract.

## Deliberate limits

- No gradient training, no LoRA, no weight updates. Calibration only.
- No refresh endpoint for stale scores: a new calibration marks older scores
  `stale` in the UI (derived by comparing `calibrationId`), it never deletes
  them.
- Scoring a feed never disables it. `suggestDisable` is display only.
- Auto-archive is off by default, needs both `label == slaby` and
  `P(slaby) >= minConfidence`, tags `basal:slabe`, and never deletes.
- Jobs live in the process that started them. A dev-server reload (Turbopack
  recompiles on any edit, which re-evaluates the job module) or a real restart
  orphans the running job; the next `status`/`job` query marks it failed with
  "Zadanie przerwane: serwer został zrestartowany." Do not edit files while a
  job is running if you need its result.
