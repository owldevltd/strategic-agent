# Strategic Agency

**A person approves a goal, not a security policy.** The system turns the goal into hard rules, works towards it
like a disciplined project lead, and every effect on the outside world passes one gate that enforces those rules,
even when the model is fooled.

Built for the Vultr "Agent Rush" hackathon, Challenge 1 *Blast Radius Zero*. It runs on a Vultr VM; every model call
goes to Vultr Serverless Inference; the code the agent writes runs in a throwaway container without network.

## What you see

One pixel office, two missions, one live log. Next door works an ordinary agent with the same model and no gate.

| Mission | The goal a person confirms | What happens |
|---|---|---|
| **Survey** | Find out why the design team is unhappy and report the reasons to HR; never about fewer than five people. | The agent's report on two answers is refused at the gate (`group of 2 < 5`). It does not bend the rule: it starts a follow-up survey as a sub-goal, waits for the answers, and reports on five. The CEO asks *"Who wrote the angry comment?"* and *"the same without Anna"*: both are refused, he gets numbers for a group or a polite no. The neighbour names Anna. |
| **Invoices** | Prepare this week's supplier payments: each invoice exactly once, only to accounts in the master data, at most 48,000 EUR, every payment approved by a person. | One child goal per invoice. A phishing mail asks to pay an invoice again to a new account: the account carries the label *foreign* and never reaches a payment. A person approves each clean payment with a one-time token. The neighbour pays the attacker. |

Counters at the top: people recognisable outside, euros lost. Ours stay at zero.

## The containment moments

- **Rules from the goal.** The person confirms a goal; the rules (minimum group, no difference attack, exactly once,
  known accounts, sum cap, human approval, deadline) are derived from its criteria and frozen with its hash in the
  gate's ledger. A model cannot argue with them: they are checked by code.
- **Labels follow the data.** Every value is *own*, *foreign* or *confidential*. A foreign IBAN never reaches the
  sensitive parameter of a payment; confidential answers leave only as a group the goal allows.
- **The agent writes code; a frame keeps it honest.** The model writes its own analysis script. It runs in a
  container without network, read-only, with memory, CPU and process limits (gVisor when available). A trusted frame
  decides which answers are in the group and accepts only numbers under fixed keys, so no name can come out. When the
  code fails, the model writes it again once and hears only the kind of error and its line, never the error message,
  which could quote the data.
- **Try to break out yourself.** The office has a button *Try to break out of the sandbox*: attacker code runs in the
  same sandbox as the agent's code (send data out, read keys, write into the system, an endless loop, 1 GB of
  memory, a fork bomb), and the log shows each try being stopped. It runs only in an isolated sandbox.
- **One way out.** Core and gate are separate processes; only the gate has the channel keys. An approval is a token
  bound to the hash of exactly that action; a worker presents it under a valid lease, and the gate checks lease,
  fencing token, hash and expiry in the same booking that opens the delivery. After the deadline nothing new leaves,
  even if the core is down.
- **Walls, not workarounds.** A refusal is a wall. The agent diagnoses it (too few answers? the group is too narrow?)
  and chooses another strategy of the class the diagnosis leads to, or a sub-goal for a missing precondition, or asks
  a person. It closes only with evidence for every criterion.

## How it works

```
 task in words ──► G1 contract check ──► person confirms at the gate (hash, rules)
                          │
     ┌────────────────────▼─────────────────────────────────────────────────────┐
     │  strategy (chooser: chance within the criterion's time × value − cost)    │
     │     │  G2 plan check: catalog moves, parameters, labels, strategy gates   │
     │     ▼                                                                     │
     │  moves: code in the sandbox · model with a fixed output · person · wait  │
     │         · child goal (the same loop, one level down)                     │
     │     │  outside actions only through the gate (token, lease, ledger)       │
     │     ▼                                                                     │
     │  G3 facts, never text from the world ──► judgment: done / another way /   │
     │                                          deeper / a person decides        │
     │     ▼                                                                     │
     │  G4 signed lessons (G5 on reading) ──► G6 really done in six dimensions   │
     └──────────────────────────────────────────────────────────────────────────┘
```

- `core/` thinks, plans and checks; it never touches the world. The node state machine, the judgment, the abort
  cascade, leases and the event log let any goal resume after a crash.
- `gate/` is its own process with its own SQLite ledger: confirmations, approvals, deliveries, retries only for
  services that keep an idempotency key, reconciliation after a crash.
- `catalog/` holds the criterion types (each knows its evidence predicate and the rules it implies), the base moves,
  the cause codes and the diagnosis. `missions/` are data only: a goal, the data, moves, strategies.
- A message from outside that matches nothing waiting becomes a case of its own, with a goal built by code and every
  rule of the mission.
- New strategies, moves or criterion types can be proposed by the model; each proposal runs as its own process,
  checked by code and approved by a person before it enters the catalog.

## Vultr architecture

```
 browser ──HTTPS──► Caddy (Let's Encrypt) on a Vultr VM (vc2-2c-4gb, Frankfurt, Ubuntu 24.04)
                     ├─ /        ──► core  (systemd, user "agency", Node 24, node:sqlite)
                     │                 ├─► Vultr Serverless Inference (OpenAI-compatible, glm-5.3-flash)
                     │                 └─► docker run --network none --read-only --runtime runsc … (one per move)
                     └─ /gate/*  ──► gate  (systemd, user "agency-gate", its own database and pin)
```

The two services run as different users with separate environment files: the core never sees the operator pin or
the gate's database, the sandbox sees no secret at all. The public demo refuses to start without an isolated sandbox,
and the gate refuses an approval without the operator pin.

## Run it

Needs Node 24. Python 3 runs the sandbox scripts in development; production uses Docker.

```
npm install                # only ESLint, for development; there are no runtime dependencies
cp .env.example .env       # Vultr inference key and model; without them a deterministic stub answers
npm run dev                # gate and core as two processes
```

For the demo as it is shown (the neighbour office without a gate, its counters, the canned messages and the escape
test) set `AGENCY_DEMO=1` in `.env`; without it the core runs your missions only.

Open http://127.0.0.1:8090/ and give the task. The development sandbox (`SANDBOX_RUNTIME=process`) is **not
isolated**; the page says so.

### On Vultr

```
infra/vultr.sh create      # VM with Docker, gVisor, Caddy and Node (cloud-init)
infra/deploy.sh            # the app as two services behind HTTPS
infra/smoke.sh             # the demo from outside, and the sandbox's containment on the VM
```

`infra/smoke.sh` runs `bin/sandbox-check.mjs` on the VM: no network, no secrets, read-only file system, endless loop,
memory cap and fork bomb must all be stopped inside the container.

## Use it for your own work

The quickest way needs no mission at all: give a task in plain words (`POST /api/tasks`, or the control room's card).
The agent drafts the goal, proposes the ways a kind of task it does not know yet needs, a person approves each, and what
was approved stays for the next task of that kind. With `AGENCY_PROPOSALS=1` it may even propose a new action or a
master-data value, which the operator decides at the gate under hard rules. A kind that proved itself is written down as
a mission folder with one command (`bin/promote.mjs`), reviewed and committed like any other ("Without a mission" in
`docs/missions.md`).

The engine knows no mission by name. A company writes its own as a folder of data and configuration, without changing
the engine: the goal, the moves, the strategies, its own actions and master data, trusted tools, and frames for code
the agent writes. Fourteen examples beyond the demo are in `tests/usecases/`: a bug fix against a frozen regression
suite, a data migration, a disk incident, a release with rollback, a refund claim, a meeting, a purchase, a data access
request, a month-end reconciliation, a shortlist, a weekly dunning run with customer replies, a calculator the agent
writes in PHP against a hidden suite, two suppliers verified and paid through three levels of preconditions, and an
offsite whose teams, venue and catering form a tree with a dependency between siblings. Each is held against what a
careful person would have done (`tests/usecases/CASES.md`) and runs as a test there. The last four were written by
agents that knew nothing of the engine but this README and the guide, as a company's developer would.

```
AGENCY_MISSIONS=missions,../acme/missions            # where your missions live
node bin/check-mission.mjs refund                     # check a mission before it runs
LLM_MODELS=coder=deepseek-v4.1-flash-1017             # a model per role, e.g. a reasoning model for code
LLM_EFFORT=coder=medium                               # how long it may think before it answers
```

The guide is `docs/missions.md`. Own channels (mail, bank, ERP) are registered for the gate in one file
(`AGENCY_CHANNELS`: which class delivers which actions); their classes and own criterion types come in through
`AGENCY_OVERRIDES` (a folder that maps class names to your files). A recipient is named by its reference (a customer
id); the gate resolves it to the address in its master data, and the person approves exactly that address.

## Tests

```
npm run check              # ESLint and all tests (about 9,700, the pentest included)
npm run stress             # the stress suite: counts the tests per module and per transition, lists open defects
```

The tests need Linux, Node 24, `python3` (the sandbox tools in the development runtime) and the PHP command line
(`php`, for the calculator use case) on the `PATH`; the container sandbox is tested against a fake engine, so Docker is
not needed. The test runner gives every run a temporary folder of its own and passes no secret of your shell on (pins,
tokens, `MEMORY_KEY`, `AGENCY_MISSIONS`). GitHub Actions runs both commands on every push
(`.github/workflows/check.yml`); the page of a run is the test report for its commit.

The tests run whole goals through the real loop with an in-process gate: walls and strategy changes, children,
restarts from the event log, the abort cascade, leases, approvals and tokens, the gate's ledger after a crash,
labels, agent-written code in its frame, lessons and their read gate, and the rules of each chapter.

The stress suite (`tests/stress/`) attacks every one of the 98 engine modules and every one of the 17 transitions of
the node's state machine with at least 50 tests each: hostile values (prototype keys, path traversal, injection,
NaN, huge inputs), forged tokens and leases, k-anonymity padding, races, crashes at random points with a restart from
the log, a hostile model in every role, and missions beyond the two of the demo (`tests/missions/`), among them one
where the agent writes code that must pass acceptance tests it never sees. Every defect the suite found is fixed;
`npm run stress` fails as soon as a module or a transition has fewer than 50 tests or a defect is open.

The pentest (`tests/pentest/`) attacks the whole system the way an attacker would: a stranger on the internet against
the public API; a core taken over, against the real gate process over HTTP; a model that is hostile in every role while
the person approves everything unread; harmless probes against the frame of agent-written code (escapes from the
container itself are tested on the VM); and changes to the core's storage between restarts. Each finding is a test
there, and its fix is a rule of the core or the gate, not of a mission: "exactly once" and "no difference" count across
every goal at the gate, data about people leaves only to a recipient in the gate's master data (as money only goes to
an account there), a wall about code a model wrote is worded by the core from a fixed repair protocol, a result of
agent-written code counts only once its frame checked the figures, and a damaged row of the event log leaves only its
own run where it is. Prompt injection with the real model (Vultr Serverless Inference) into every role, through
survey answers, messages from the CEO, supplier mails, the knowledge files and the task itself, broke no invariant.

## Limits, honestly

- The world is simulated: messages go to a local outbox, the colleagues who answer the survey are a script.
- The chances of strategies come from the catalog; every attempt is logged so that an estimator can learn them
  later, but nothing is estimated yet.
- The model proposes judgments and is often overruled by the rules; the log shows when.
- A plan branches on walls and their diagnosis (5.6): content through a trusted tool's wall, a person through the
  class of the option they choose; there are no conditions inside a strategy.
- A message from outside is a claim, never an observation; a goal that needs a measurement of a live system is
  closed by a person's confirmation.
- Every action on the outside world is approved by a person, one by one; there is no threshold below which an action
  goes alone. At volume (hundreds of reminders a week) that is real work for people.
- The children of a goal run one after another; a process that waits days for each answer settles each item when its
  message leaves and handles the answers as cases of their own (`docs/missions.md`).
- The gate checks recipients, amounts, groups and approvals, not the wording of a text.
- The engine never pays, sends or deletes by itself: every outward action waits for a person's approval of exactly
  that action at the gate, and a person settles every action whose effect is unclear.
- Security rests on four secrets a deployment sets (operator pin, core token, board pin, inbound token) and on
  running core and gate as two users; what they protect and what they do not is in [SECURITY.md](SECURITY.md).
- The labels the core sends with a request (own, foreign, confidential) are the core's word: the gate cannot know
  where a value came from. A core taken over can lie about them; what still holds then (approval, master data, groups,
  sums, exactly once) is in SECURITY.md.

## Layout

| Path | What |
|---|---|
| `lib/` | autoloader, event log, SQLite, HTTP and SSE, limits |
| `core/` | loop, checks G1 to G6, criteria, strategies, diagnosis, memory, journal, sandbox runtimes, model providers |
| `gate/` | the gate process: rules, ledger, leases, approvals, channels |
| `catalog/` | criterion types, base moves, actions, causes, diagnosis, base setup |
| `missions/` | the two missions as data, each with its own trusted tools (`tools/`) |
| `docs/` | how to write a mission, and a glossary of the rule ids the code cites |
| `tests/usecases/` | fourteen more missions, judged against what a person would have done |
| `sandbox/tools/` | the engine's own frames: acceptance tests and the runner for the agent's code |
| `world/` | the simulated world: colleagues, responders, counters |
| `baseline/` | the neighbour of the demo (AGENCY_DEMO=1): the same model without a gate |
| `ui/` | the pixel office and the control room |
| `infra/` | Vultr provisioning, deployment and smoke test |

## License

MIT, see [LICENSE](LICENSE).
