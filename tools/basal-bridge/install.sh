#!/usr/bin/env bash
# Install basal-bridge as a systemd --user service.
#
# Requirements already on the host:
#   ~/basal-env          uv venv, python 3.12, pip package `basal` (pinned, see README)
#   ~/models/basal-2.0-mini-GGUF   GGUF weights + CALIBRATION.llamacpp.json
#
# The service binds to the Karakeep docker bridge gateway (detected at runtime with
# `docker network inspect karakeep_default`) so it is reachable from the container as
# http://host.docker.internal:8010 and NOT from the LAN or Tailscale.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MODEL_DIR="${BASAL_MODEL:-$HOME/models/basal-2.0-mini-GGUF}"

command -v "$HOME/basal-env/bin/basal-serve" >/dev/null || {
  echo "ERROR: $HOME/basal-env/bin/basal-serve is missing. Create the venv first:" >&2
  echo "  uv venv --python 3.12 ~/basal-env" >&2
  echo "  uv pip install --python ~/basal-env/bin/python 'basal==<pinned version>'" >&2
  exit 1
}
[ -d "$MODEL_DIR" ] || {
  echo "ERROR: weights not found in $MODEL_DIR. Download them first, e.g.:" >&2
  echo "  hf download Remek/basal-2.0-mini-GGUF --local-dir $MODEL_DIR" >&2
  exit 1
}

mkdir -p "$UNIT_DIR" "$HOME/basal-bridge/calibrations"
install -m 0644 "$HERE/basal-bridge.service" "$UNIT_DIR/basal-bridge.service"
install -m 0755 "$HERE/bridge.py" "$HOME/basal-bridge/bridge.py"
install -m 0644 "$HERE/README.md" "$HOME/basal-bridge/README.md"

systemctl --user daemon-reload
systemctl --user enable --now basal-bridge.service
sleep 3
systemctl --user --no-pager --lines=5 status basal-bridge.service || true

GATEWAY="$(docker network inspect karakeep_default -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 127.0.0.1)"
echo
echo "health check: curl -s http://${GATEWAY}:8010/health | jq"
curl -s -m 10 "http://${GATEWAY}:8010/health" || echo "bridge not answering yet - check: journalctl --user -u basal-bridge -n 50"
echo
echo "Karakeep must point at BASAL_BRIDGE_URL=http://host.docker.internal:8010"
