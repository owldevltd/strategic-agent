# Shared settings of the infra/ scripts (sourced). Secrets come from ../.env and are never printed.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

: "${VULTR_REGION:=fra}"                  # Frankfurt
: "${VULTR_PLAN:=vc2-2c-4gb}"             # 2 vCPU, 4 GB, 80 GB
: "${VULTR_OS_ID:=2284}"                  # Ubuntu 24.04 LTS x64
: "${VM_LABEL:=strategic-agency}"
: "${SSH_KEY:=$HOME/.ssh/vultr_hackathon}"
: "${NODE_VERSION:=24.22.2}"
: "${DOMAIN:=}"                           # empty: <ip>.sslip.io (Let's Encrypt works with it)
: "${WORLD_SPEED:=4}"                     # the simulated colleagues answer four times faster than in real time

INSTANCE_FILE="$ROOT/infra/.instance-id"
SSHKEY_ID_FILE="$ROOT/infra/.sshkey-id"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "'$1' is not installed"; }
