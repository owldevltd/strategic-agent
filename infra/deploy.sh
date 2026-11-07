#!/usr/bin/env bash
# Puts the app on the VM, sets up systemd and Caddy, and restarts. Idempotent: run it again after every change.
# The core and the gate run as two services under two users; each gets only its own settings.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need rsync; need ssh
: "${LLM_API_KEY:?LLM_API_KEY is missing in .env}"
: "${LLM_MODEL:?LLM_MODEL is missing in .env}"

IP=$("$ROOT/infra/vultr.sh" ip)
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
remote() { ssh "${SSH_OPTS[@]}" "root@$IP" "$@"; }

echo "→ waiting for the first provisioning ($IP)"
remote 'cloud-init status --wait >/dev/null || true; test -f /var/lib/agency-provisioned' \
  || die "provisioning incomplete; log: infra/vultr.sh ssh tail -50 /var/log/cloud-init-output.log"

echo "→ copying the app"
remote 'mkdir -p /opt/agency/src'
rsync -az --delete --exclude node_modules --exclude storage --exclude .env --exclude 'infra/.instance-id' \
  --exclude 'infra/.sshkey-id' -e "ssh ${SSH_OPTS[*]}" "$ROOT/" "root@$IP:/opt/agency/src/"

echo "→ writing the settings (secrets stay on the host, never in a sandbox)"
# The core token: only the core may propose, lease and submit at the gate. Both services get the same one; the one on
# the host is kept, on the first deploy a new random one is made. Never printed.
TOKEN=${GATE_CORE_TOKEN:-$(remote "sed -n 's/^GATE_CORE_TOKEN=//p' /etc/agency/gate.env 2>/dev/null" || true)}
if [ -z "$TOKEN" ]; then TOKEN=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); fi
ENGINE=$(remote "docker info --format '{{json .Runtimes}}' | grep -q runsc && echo runsc || true")
{
  printf 'LLM_BASE_URL=%s\nLLM_API_KEY=%s\nLLM_MODEL=%s\n' "${LLM_BASE_URL:-https://api.vultrinference.com/v1}" "$LLM_API_KEY" "$LLM_MODEL"
  # The roles that write long answers (code, a new strategy) think within bounds; unbounded, the endpoint's models can
  # spend their whole token limit on reasoning and answer nothing.
  printf 'LLM_EFFORT=%s\n' "${LLM_EFFORT:-coder=medium,strategist=medium}"
  printf 'CORE_HOST=127.0.0.1\nCORE_PORT=8090\nGATE_URL=http://127.0.0.1:8091\nGATE_PUBLIC_URL=/gate\n'
  printf 'SANDBOX_RUNTIME=docker\nSANDBOX_IMAGE=python:3.12-slim\nSANDBOX_TIMEOUT=10\nSANDBOX_DOCKER_RUNTIME=%s\n' "$ENGINE"
  # The demo's extras (the neighbour office, its counters, the canned messages, the escape test).
  printf 'STORAGE_DIR=/var/lib/agency/core\nWORLD_SPEED=%s\nPUBLIC_DEMO=1\nAGENCY_DEMO=1\n' "$WORLD_SPEED"
  printf 'GATE_CORE_TOKEN=%s\n' "$TOKEN"
  # Optional: the board pin closes the core's board (the open demo runs on simulated data only), the inbound token opens
  # the channel for messages from outside. Neither is printed.
  if [ -n "${CORE_BOARD_PIN:-}" ]; then printf 'CORE_BOARD_PIN=%s\n' "$CORE_BOARD_PIN"; fi
  if [ -n "${INBOUND_TOKEN:-}" ]; then printf 'INBOUND_TOKEN=%s\n' "$INBOUND_TOKEN"; fi
} | remote 'mkdir -p /etc/agency && umask 077 && cat > /etc/agency/core.env'
# The operator pin keeps the person's endpoints of the gate away from the core, which never has it. Without one in
# .env, the pin already on the host is kept; on the first deploy a new one is made. It is never printed here.
PIN=${GATE_OPERATOR_PIN:-$(remote "sed -n 's/^GATE_OPERATOR_PIN=//p' /etc/agency/gate.env 2>/dev/null" || true)}
if [ -z "$PIN" ]; then
  PIN=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
  echo "→ a new operator pin was made; read it with: infra/vultr.sh ssh grep PIN /etc/agency/gate.env"
fi
# The public demo: every run works on a fresh copy of the mission's data, a simulated week of its own, so the gate keeps
# "exactly once" and "no difference" to each goal. In operation the ledger spans every goal (the default, "gate").
{
  printf 'GATE_HOST=127.0.0.1\nGATE_PORT=8091\nGATE_OPERATOR_PIN=%s\nSTORAGE_DIR=/var/lib/agency/gate\nGATE_LEDGER_SCOPE=goal\n' "$PIN"
  printf 'GATE_CORE_TOKEN=%s\n' "$TOKEN"
} | remote 'umask 077 && cat > /etc/agency/gate.env'

# Until the submission the demo can sit behind a password (DEMO_USER and DEMO_PASSWORD in .env); without them it is open.
AUTH=""
if [ -n "${DEMO_USER:-}" ] && [ -n "${DEMO_PASSWORD:-}" ]; then
  HASH=$(printf '%s' "$DEMO_PASSWORD" | remote 'caddy hash-password --plaintext "$(cat)"')
  AUTH="basicauth * {
		$DEMO_USER $HASH
	}"
fi

echo "→ services and Caddy (sandbox engine: ${ENGINE:-runc})"
remote "DOMAIN='$DOMAIN' IP='$IP' AUTH='$AUTH' bash -s" <<'REMOTE'
set -euo pipefail
chown -R root:root /opt/agency/src && chmod -R a+rX /opt/agency/src
unit() { # unit NAME USER ENVFILE BIN AFTER
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=Strategic Agency $1
After=network-online.target $5
Wants=network-online.target

[Service]
User=$2
Group=$2
WorkingDirectory=/opt/agency/src
EnvironmentFile=$3
ExecStart=/usr/local/bin/node $4
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
}
unit agency-gate agency-gate /etc/agency/gate.env bin/gate.mjs ""
unit agency-core agency /etc/agency/core.env bin/core.mjs "agency-gate.service docker.service"

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	$AUTH
	handle_path /gate/* {
		reverse_proxy 127.0.0.1:8091
	}
	handle {
		reverse_proxy 127.0.0.1:8090
	}
}
CADDY

systemctl daemon-reload
systemctl enable -q agency-gate agency-core
systemctl restart agency-gate
sleep 1
systemctl restart agency-core
systemctl reload caddy || systemctl restart caddy
sleep 3
for name in agency-gate agency-core; do
  systemctl is-active --quiet "$name" || { journalctl -u "$name" -n 30 --no-pager; exit 1; }
done
curl -sf http://127.0.0.1:8090/api/health >/dev/null || { journalctl -u agency-core -n 30 --no-pager; exit 1; }
REMOTE

echo "✔ deployed: https://$DOMAIN (the certificate comes with the first request, about 30 s)"
echo "  check it: infra/smoke.sh"
