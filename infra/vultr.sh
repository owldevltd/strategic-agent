#!/usr/bin/env bash
# A thin wrapper around the Vultr API v2 and Vultr Serverless Inference.
#
#   infra/vultr.sh account     account and credit (does the API key work?)
#   infra/vultr.sh llm-ping    inference key: one chat request to LLM_MODEL
#   infra/vultr.sh models      text models of Serverless Inference
#   infra/vultr.sh create      upload the SSH key (if needed), create the VM, wait for its IP
#   infra/vultr.sh status      state of the VM
#   infra/vultr.sh ip          the IP only
#   infra/vultr.sh ssh         SSH to the VM
#   infra/vultr.sh destroy     delete the VM (asks first)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need curl; need jq

API=https://api.vultr.com/v2
INFERENCE=https://api.vultrinference.com/v1

api() { # api METHOD PFAD [curl-Argumente...]
  local method=$1 path=$2; shift 2
  curl -sS --fail-with-body -X "$method" "$API$path" \
    -H "Authorization: Bearer ${VULTR_API_KEY:?VULTR_API_KEY is missing in .env}" \
    -H "Content-Type: application/json" "$@"
}

instance_id() { [ -s "$INSTANCE_FILE" ] || die "no VM known; run 'infra/vultr.sh create' first"; cat "$INSTANCE_FILE"; }

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY" ]; then
    echo "→ creating SSH key $SSH_KEY" >&2
    ssh-keygen -q -t ed25519 -N "" -C "vultr-hackathon" -f "$SSH_KEY"
  fi
  if [ -s "$SSHKEY_ID_FILE" ]; then cat "$SSHKEY_ID_FILE"; return; fi
  echo "→ uploading the public SSH key to Vultr" >&2
  api POST /ssh-keys -d "$(jq -n --arg k "$(cat "$SSH_KEY.pub")" '{name:"vultr-hackathon", ssh_key:$k}')" \
    | jq -r .ssh_key.id | tee "$SSHKEY_ID_FILE"
}

cmd_account() {
  api GET /account | jq '.account | {name, email, balance, pending_charges}'
  echo "(a negative 'balance' is credit, e.g. -200 after the hackathon code)" >&2
}

cmd_llm_ping() {
  local body t0 t1
  body=$(jq -n --arg m "${LLM_MODEL:?LLM_MODEL is missing in .env}" \
    '{model:$m, max_tokens:300, messages:[{role:"user", content:"Answer with exactly one word: Pong"}]}')
  t0=$(date +%s%N)
  curl -sS --fail-with-body "$INFERENCE/chat/completions" \
    -H "Authorization: Bearer ${LLM_API_KEY:?LLM_API_KEY is missing in .env}" \
    -H "Content-Type: application/json" -d "$body" \
    | jq '{model, answer: .choices[0].message.content, usage}'
  t1=$(date +%s%N)
  echo "took $(( (t1 - t0) / 1000000 )) ms" >&2
}

cmd_models() {
  curl -sS "$INFERENCE/models" | jq -r '
    .data[] | select(any(.output_modalities[]; .type=="text"))
    | [.id,
       (if any(.output_modalities[]; .supported_parameters.tools) then "tools" else "-" end),
       ([.input_modalities[].type] | join(",")),
       ((.output_modalities[0].pricing[0].cost_usd // "0" | tonumber) * 1e8 | round / 100 | tostring) + " $ per million tokens"]
    | @tsv'
}

cmd_create() {
  [ -s "$INSTANCE_FILE" ] && die "there is a VM already ($(cat "$INSTANCE_FILE")); 'destroy' it first"
  local key_id body id
  key_id=$(ensure_ssh_key)
  body=$(jq -n --arg r "$VULTR_REGION" --arg p "$VULTR_PLAN" --argjson os "$VULTR_OS_ID" \
              --arg l "$VM_LABEL" --arg k "$key_id" --arg ud "$(base64 -w0 "$ROOT/infra/cloud-init.sh")" \
    '{region:$r, plan:$p, os_id:$os, label:$l, hostname:$l, sshkey_id:[$k],
      user_data:$ud, backups:"disabled", enable_ipv6:true, tags:["hackathon"]}')
  echo "→ creating the VM: $VULTR_PLAN in $VULTR_REGION" >&2
  id=$(api POST /instances -d "$body" | jq -r .instance.id)
  echo "$id" > "$INSTANCE_FILE"
  echo "→ instance $id, waiting for its IP (1 to 3 minutes)" >&2
  for _ in $(seq 1 60); do
    read -r status ip < <(api GET "/instances/$id" | jq -r '.instance | "\(.status) \(.main_ip)"')
    if [ "$status" = active ] && [ "$ip" != 0.0.0.0 ]; then
      echo "✔ VM running: $ip"
      echo "  Provisioning (Docker, Caddy, gVisor, Node) runs for another 3 to 5 minutes."
      echo "  Then: infra/deploy.sh"
      return
    fi
    sleep 5
  done
  die "the VM is not active after 5 minutes; see 'infra/vultr.sh status'"
}

cmd_status() {
  api GET "/instances/$(instance_id)" \
    | jq '.instance | {id, "label": .label, region, plan, status, power_status, server_status, main_ip, v6_main_ip}'
}

cmd_ip() { api GET "/instances/$(instance_id)" | jq -r .instance.main_ip; }

cmd_ssh() { exec ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "root@$(cmd_ip)" "$@"; }

cmd_destroy() {
  local id; id=$(instance_id)
  if [ "${1:-}" != "-y" ]; then
    read -r -p "Really delete VM $id? All data on it is lost. [y/N] " a
    [[ "$a" =~ ^[yY]$ ]] || { echo "cancelled"; return; }
  fi
  api DELETE "/instances/$id" >/dev/null
  rm -f "$INSTANCE_FILE"
  echo "✔ VM $id deleted"
}

case "${1:-}" in
  account)  cmd_account ;;
  llm-ping) cmd_llm_ping ;;
  models)   cmd_models ;;
  create)   cmd_create ;;
  status)   cmd_status ;;
  ip)       cmd_ip ;;
  ssh)      shift; cmd_ssh "$@" ;;
  destroy)  shift; cmd_destroy "$@" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
