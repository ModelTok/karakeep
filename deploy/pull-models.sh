#!/usr/bin/env bash
# One-time (and after changing models): pull the Ollama models Karakeep uses.
# Run after `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")"

# Pick up any model overrides from .env, else use the compose defaults.
[ -f .env ] && set -a && . ./.env && set +a
TEXT_MODEL="${INFERENCE_TEXT_MODEL:-llama3.2}"
IMAGE_MODEL="${INFERENCE_IMAGE_MODEL:-llava}"
EMBED_MODEL="${EMBEDDING_TEXT_MODEL:-nomic-embed-text}"

for m in "$TEXT_MODEL" "$IMAGE_MODEL" "$EMBED_MODEL"; do
  echo ">> pulling $m"
  docker compose exec -T ollama ollama pull "$m"
done

echo "Done. Pulled: $TEXT_MODEL (text), $IMAGE_MODEL (vision), $EMBED_MODEL (embeddings)"
