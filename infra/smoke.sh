#!/usr/bin/env bash
# Checks the running demo from outside, and the sandbox's containment on the VM itself.
#   infra/smoke.sh              the VM from infra/.instance-id
set -uo pipefail
source "$(dirname "$0")/lib.sh"
need curl; need jq

IP=$("$ROOT/infra/vultr.sh" ip) || exit 1
BASE="https://${DOMAIN:-${IP//./-}.sslip.io}"
AUTH=()
[ -n "${DEMO_USER:-}" ] && [ -n "${DEMO_PASSWORD:-}" ] && AUTH=(-u "$DEMO_USER:$DEMO_PASSWORD")
echo "target: $BASE"

pass=0; fail=0
result() { # result <0 ok|1 failed> <name> <detail>
  if [ "$1" = 0 ]; then printf '  \e[32m✔\e[0m %-48s %s\n' "$2" "$3"; pass=$((pass+1))
  else                  printf '  \e[31m✘\e[0m %-48s %s\n' "$2" "$3"; fail=$((fail+1)); fi
}

echo "1) the demo from outside"
h=$(curl -sS -m 30 "${AUTH[@]}" "$BASE/api/health" 2>&1)
jq -e '.ok and .gate' >/dev/null 2>&1 <<<"$h"; result $? "core answers, gate reachable" "$(jq -c '{runtime, provider}' <<<"$h" 2>/dev/null)"
jq -e '.isolated' >/dev/null 2>&1 <<<"$h"; result $? "sandbox runtime is isolated" "$(jq -r '.runtime' <<<"$h" 2>/dev/null)"
BOARD=()
[ -n "${CORE_BOARD_PIN:-}" ] && BOARD=(-H "x-board-pin: $CORE_BOARD_PIN")
m=$(curl -sS -m 30 "${AUTH[@]}" "${BOARD[@]}" "$BASE/api/missions")
jq -e 'length == 2' >/dev/null 2>&1 <<<"$m"; result $? "both missions" "$(jq -r 'map(.id) | join(", ")' <<<"$m" 2>/dev/null)"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${AUTH[@]}" "$BASE/gate/approvals")
[ "$code" = 403 ]; result $? "the gate shows nothing without the pin or the core token" "HTTP $code"
if [ -n "${GATE_OPERATOR_PIN:-}" ]; then
  g=$(curl -sS -m 30 "${AUTH[@]}" -H "x-operator-pin: $GATE_OPERATOR_PIN" "$BASE/gate/approvals")
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$g"; result $? "gate behind /gate, read with the operator pin" ""
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${AUTH[@]}" -X POST -H 'Content-Type: application/json' -d '{"decision":"approve"}' \
  "$BASE/gate/approvals/smoke-test")
[ "$code" = 403 ]; result $? "an approval without the operator pin is refused" "HTTP $code"
if [ ${#AUTH[@]} -gt 0 ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$BASE/api/health")
  [ "$code" = 401 ]; result $? "closed without the password" "HTTP $code"
fi

echo "2) containment of the sandbox, on the VM"
# No probe output at all (ssh failed, unknown runtime) is a failure, never a pass: containment was not shown.
probes=0
while read -r line; do
  if jq -e 'has("probe")' >/dev/null 2>&1 <<<"$line"; then
    probes=$((probes+1))
    jq -e .ok >/dev/null <<<"$line"; result $? "$(jq -r .probe <<<"$line")" "$(jq -r '"exit \(.exit), \(.ms) ms \(.stderr // "")"' <<<"$line" | cut -c1-60)"
  elif jq -e '.ok == false' >/dev/null 2>&1 <<<"$line"; then
    result 1 "containment check" "$(jq -r '.reason // ""' <<<"$line" | cut -c1-60)"
  else
    echo "  $line"
  fi
done < <("$ROOT/infra/vultr.sh" ssh 'cd /opt/agency/src && set -a && . /etc/agency/core.env && set +a && runuser -u agency --preserve-environment -- /usr/local/bin/node bin/sandbox-check.mjs' 2>/dev/null)
[ "$probes" -gt 0 ]; result $? "the probes ran on the VM" "$probes probes"

echo
echo "result: $pass passed, $fail failed"
[ "$fail" = 0 ]
