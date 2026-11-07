# Security

Strategic Agency runs as two processes. The **core** thinks, plans and checks; it holds no key of any channel and can
reach the world only by asking the **gate**. The gate holds the channels, its own ledger and the operator's master
data, and lets an action out only when the rules of its confirmed goal allow it and a person approved exactly that
action. A deployment runs them as two users with separate environment files (`infra/deploy.sh`).

## The four secrets

| Setting | Lives in | Guards | Carried as |
|---|---|---|---|
| `GATE_OPERATOR_PIN` | gate | confirming a goal, deciding an approval, settling an unclear action, adding or revoking master data | header `x-operator-pin` (or the field `pin` of the JSON body) |
| `GATE_CORE_TOKEN` | gate and core | proposing a goal, leases, submitting, withdrawing and redeeming an action | header `x-core-token` |
| `CORE_BOARD_PIN` | core | the board: missions, giving a task, answering a question, aborting, the logs and the live log | header `x-board-pin` |
| `INBOUND_TOKEN` | core | `POST /api/missions/:id/messages`, the channel for messages from outside | header `x-inbound-token` |

Reading the gate (its ledger, the approvals, the unclear actions, an outbox, the log) needs the operator pin or the
core token. The core never has the operator pin, and the gate never sees the board pin.

Every secret is compared in constant time. After five wrong answers in a row a secret is locked for a minute, then
twice as long each time, up to an hour; the lock is logged (`access_locked`). The pins need at least 6 characters, the
tokens at least 24; a shorter one stops the process at its start. A pin or token is never accepted in a URL, a cookie
or another header.

Without a secret its routes are open. That is for development only. `infra/deploy.sh` keeps the operator pin and the
core token that are already on the host and makes new ones on the first deploy; the board pin and the inbound token
are taken from your `.env` when you set them. Without `INBOUND_TOKEN` the inbound channel is off: nothing from outside
starts a process. Without `CORE_BOARD_PIN` the board is open, which is acceptable only for a demo on simulated data.

## Browsers

The pages send the pins in headers and read the live logs with `fetch`, never with a pin in a URL. Only the origins in
`GATE_UI_ORIGIN` get CORS answers from the gate (by default the core's own page on its port); any other origin gets
none, and its preflight is refused. Behind one host (the deployment serves the gate under `/gate`) page and gate share
an origin and need no CORS at all. The operator's endpoints take JSON requests only, so a form of another site cannot
post to them.

## If the core is taken over

An attacker who holds the core holds its token, its leases and every request it makes; `tests/pentest/` plays this
through against the real gate. What still holds:

- No action leaves without a person's approval of exactly that action; the token of an approval is bound to the hash
  of the action, used once, and expires with its goal.
- A goal is confirmed by a person, at the gate; a child goal only by derivation from a confirmed parent, and only as
  strict as the parent or stricter.
- Money only goes to accounts, and data about people only to recipients, that the operator put into the gate's master
  data; the core can add nothing there.
- "Exactly once", sums and "no difference" between released groups count across every goal at the gate.
- Nothing new leaves after the deadline plus the buffer, even while the core is down.

What does **not** hold: the labels a request carries (own, foreign, confidential) are the core's word. The gate checks
that every sensitive parameter carries labels and refuses foreign values there, but it cannot know where a value came
from. A core that lies about labels is stopped by the rules above and by the person who sees exactly what would leave,
not by the labels.

## Tasks without a mission

A task given without a mission (`POST /api/tasks`, board pin) lets the agent propose its goal, strategies, moves and
criterion types; each becomes real only after a person approved exactly that version.

What the gate checks against stays the operator's. Only with `AGENCY_PROPOSALS=1` may the agent propose a new action or
a master-data value there; the gate's own code applies hard rules before a person even sees it (an action at least
outward, money only as `money_or_law`, no existing name; a master-data value never an account, never from outside, never
for a case from outside, and only one the person-confirmed goal names), and nothing changes before the operator
approved exactly that proposal with the pin. Channels, data and trusted tools are never proposed. The switch is off by
default and in the demo's deployment.

## Actions whose effect is unclear

When a service gives no clear answer and does not keep an idempotency key, the gate never sends the action again. It
books it as unclear; it counts as if it went out until a person who checked outside settles it at the gate as executed
or not sent (`POST /unclear/:id`, operator pin). Settling sends nothing.

## Data

- Each run works on its own copy of the mission's data (the vault). The copies of finished runs are deleted after
  `VAULT_RETENTION_DAYS` days without a change (30 by default); an open run keeps its copy.
- The logs name people by a keyed pseudonym; a sender the mission's master data names (a role such as `supplier`) is
  logged as that role.
- The gate's master data is scoped: what a mission folder brings serves only the goals of that mission's kind (the kind
  of the root goal, which a person confirmed), and what a folder no longer holds is revoked at the next start. The
  operator adds values for one kind or for every goal and revokes them with `POST /master/revoke`.
- The sandbox gets the vault read-only and no secret at all.

## The sandbox

Code a model wrote runs in Docker with gVisor when the host has it: no network, a read-only root, a small tmpfs, limits
on memory, CPU, processes and time, no capabilities, an unprivileged user. `infra/smoke.sh` checks this on the VM. The
development runtime (`SANDBOX_RUNTIME=process`) is not isolated; a public demo (`PUBLIC_DEMO=1`) refuses to start with
it.

## Not covered

- There are no user accounts or roles: whoever has the operator pin is the operator.
- TLS ends at the reverse proxy (Caddy in the deployment); the two processes talk over plain HTTP on 127.0.0.1.
- The limits per caller of a public demo slow down a single visitor; they are no protection against a distributed attack.
- The model provider sees what the core sends it: the task, excerpts of messages and mission data. Choose the
  provider and the data accordingly.
- The secrets live in environment files on the host, readable by the user of each service.

## Reporting a vulnerability

Please report it privately to the maintainers (a private security advisory on the repository), not in a public issue.
