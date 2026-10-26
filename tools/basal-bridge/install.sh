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
USER="${USER:-$(id -un)}"

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

# PIDs listening on a TCP port, one per line (empty when the port is free).
listeners() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
}

# SIGTERM, wait up to 10 s, then SIGKILL.
terminate() {
  local pid="$1" what="$2" i
  echo "stopping $what (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || return 0
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "  $what (pid $pid) ignored SIGTERM; killing it"
  kill -KILL "$pid" 2>/dev/null || true
}

# Free ports 8010 (bridge) and 8011 (engine) so the new unit can bind. A bridge
# started by hand, or an older unit, is not managed by this unit file.
if systemctl --user is-active --quiet basal-bridge.service; then
  echo "stopping the running basal-bridge.service"
  systemctl --user stop basal-bridge.service || true
fi
for pid in $(listeners 8010); do
  terminate "$pid" "previous basal-bridge on :8010"
done
for pid in $(listeners 8011); do
  if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'basal-serve'; then
    terminate "$pid" "orphaned basal-serve on :8011"
  else
    echo "WARNING: pid $pid on :8011 is not basal-serve; leaving it alone" >&2
  fi
done

mkdir -p "$UNIT_DIR" "$HOME/basal-bridge/calibrations"
install -m 0644 "$HERE/basal-bridge.service" "$UNIT_DIR/basal-bridge.service"
install -m 0755 "$HERE/bridge.py" "$HOME/basal-bridge/bridge.py"
install -m 0644 "$HERE/README.md" "$HOME/basal-bridge/README.md"

# Without lingering, systemd --user units only start after a login: the bridge
# would not come back after a host reboot.
if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null || true)" != "Linger=yes" ]; then
  echo "enabling lingering for $USER so the unit starts at boot"
  loginctl enable-linger "$USER" \
    || echo "WARNING: loginctl enable-linger failed; run 'sudo loginctl enable-linger $USER'" >&2
fi

systemctl --user daemon-reload
systemctl --user enable --now basal-bridge.service

GATEWAY="$(docker network inspect karakeep_default -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 127.0.0.1)"
echo
echo "waiting for http://${GATEWAY}:8010/health (up to 20 s)"
HEALTH=""
for i in $(seq 1 40); do
  if HEALTH="$(curl -s -m 2 "http://${GATEWAY}:8010/health")" && [ -n "$HEALTH" ]; then
    break
  fi
  HEALTH=""
  sleep 0.5
done
systemctl --user --no-pager --lines=5 status basal-bridge.service || true
echo
if [ -n "$HEALTH" ]; then
  echo "$HEALTH"
  echo
  echo "basal-serve is started on demand: until the first /score or /train, /health"
  echo "reports \"serve_running\": false with \"ok\": true. That is expected."
else
  echo "bridge not answering yet - check: journalctl --user -u basal-bridge -n 50"
fi
echo
echo "Karakeep must point at BASAL_BRIDGE_URL=http://host.docker.internal:8010"
