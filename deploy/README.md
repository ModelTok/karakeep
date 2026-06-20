# Karakeep deploy — self-hosted, Cloudflare Tunnel, local Ollama

Turnkey deployment of this Karakeep fork onto an **always-on Linux host** (e.g. a mini PC),
published at **https://karakeep.modeltok.com** via Cloudflare Tunnel, with **all AI inference
running locally through a bundled Ollama** (no OpenAI key required).

## What's in here
| File | Purpose |
|---|---|
| `docker-compose.yml` | The full stack: `web` + `meilisearch` + `chrome` + `ollama` + `cloudflared` |
| `.env.example` | Template for secrets/config — copy to `.env` (real `.env` is gitignored) |
| `pull-models.sh` | Pulls the Ollama models after first boot |

State persists in Docker named volumes (`data`, `meilisearch`, `ollama`) regardless of where
this repo is checked out.

## Architecture
```
  mini PC (this host)
  ┌─────────────────────────────────────────────┐         Cloudflare edge          You
  │ web ─ meilisearch ─ chrome ─ ollama (local)  │   ──►  cloudflared tunnel  ──►  karakeep.modeltok.com
  │            └────────── cloudflared ──────────┼──►     (auto CNAME + TLS,       (+ optional
  └─────────────────────────────────────────────┘         no open ports)           Cloudflare Access)
```

## Prerequisites
- Docker Engine + Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # then log out/in
  ```
- A Cloudflare account with the `modeltok.com` zone (already in use).
- ~5–10 GB free disk for the Ollama models. CPU-only works; NVIDIA GPU optional (see compose).

## Deploy

### 1. Create the Cloudflare Tunnel  *(CLI, one-time — no dashboard needed)*
```bash
cloudflared tunnel login                                   # browser auth; pick the modeltok.com zone
cloudflared tunnel create karakeep-minipc                  # writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns <UUID> karakeep.modeltok.com  # auto-creates the CNAME
```
> **Use the tunnel's UUID** (printed by `create`, also in `cloudflared tunnel list`), not the
> name, for `route dns` — some cloudflared builds misresolve the name to another tunnel.

Then wire the credentials + ingress into `deploy/cloudflared/` (the compose `cloudflared`
service runs in locally-managed mode from this dir — no `TUNNEL_TOKEN`):
```bash
cd deploy && mkdir -p cloudflared
cp ~/.cloudflared/<UUID>.json cloudflared/
chmod 644 cloudflared/<UUID>.json                          # readable by the container's nonroot user
cat > cloudflared/config.yml <<YAML
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json
ingress:
  - hostname: karakeep.modeltok.com
    service: http://web:3000
  - service: http_status:404
YAML
```
The `<UUID>.json` is gitignored (it is secret); `config.yml` is safe to commit.

### 2. Configure
```bash
cd deploy
cp .env.example .env
# generate the two secrets:
sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$(openssl rand -base64 36)|" .env
sed -i "s|^MEILI_MASTER_KEY=.*|MEILI_MASTER_KEY=$(openssl rand -base64 36)|" .env
# (no TUNNEL_TOKEN needed — the tunnel is configured via cloudflared/config.yml above)
```

### 3. Launch
```bash
docker compose up -d
docker compose logs -f cloudflared    # expect "Registered tunnel connection"
./pull-models.sh                      # one-time model download (can take a while on first run)
```

### 4. First login
Open **https://karakeep.modeltok.com** — the **first account created becomes admin**.
Then lock signups: add `DISABLE_SIGNUPS=true` to `.env` and `docker compose up -d`.

### 5. (Recommended) Restrict access
Add a **Cloudflare Access** application (Zero Trust → Access → Applications) over
`karakeep.modeltok.com` so only your email can reach it.

### 6. Connect clients
Install the **Chrome/Firefox extension** and **Android/iOS app**, set the server URL to
`https://karakeep.modeltok.com`, log in → one-click / share-sheet saving from X, LinkedIn, anywhere.

## AI inference (local Ollama)
Wired in `docker-compose.yml`, no external API:
| Var | Default | Role |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | bundled Ollama service |
| `INFERENCE_TEXT_MODEL` | `llama3.2` | tagging + summarization |
| `INFERENCE_IMAGE_MODEL` | `llava` | image tagging (vision-capable) |
| `EMBEDDING_TEXT_MODEL` | `nomic-embed-text` | semantic search embeddings |
| `INFERENCE_JOB_TIMEOUT_SEC` | `120` | generous for CPU-only |

To change models: set them in `.env`, then re-run `./pull-models.sh` and `docker compose up -d`.
Lighter text model for weak hardware: `llama3.2:1b`. Heavier/better: `qwen2.5:7b`.
For GPU acceleration, uncomment the `deploy:` block on the `ollama` service.

## Operations
```bash
docker compose pull && docker compose up -d   # update images
docker compose logs -f web                    # app logs
docker compose down                           # stop (volumes/data preserved)
# Backup the bookmarks DB + assets:
docker run --rm -v karakeep_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/karakeep-data-backup.tar.gz -C /data .
```

## Notes
- The host port `3000:3000` is only for LAN/first-run testing; remove it for tunnel-only exposure.
- Never commit `.env` — it holds secrets and is gitignored.
