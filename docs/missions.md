# Writing a mission

A mission is how a company puts its own work on this engine: a folder of data and configuration, never code in the
core. The engine (core and gate) knows no mission by name. This guide is what you need to write one; fourteen complete
examples are in `tests/usecases/` (a bug fix, a data migration, a disk incident, a release with rollback, a refund
claim, a meeting, a purchase, a data access request, a month-end reconciliation, a shortlist, a dunning run, a
calculator in PHP, a supplier onboarding three levels deep, an offsite tree), each with a test. The dunning run (`tests/usecases/dunning`) follows "A pattern: send now, hear
back later" end to end; the calculator (`tests/usecases/calculator`) checks code in another language with a frame of
its own.

```
node bin/check-mission.mjs <id>        # checks a mission before it runs (see "Checking a mission")
```

Read "Design before you write" first: three decisions there shape every file that follows. You do not have to write
a mission at all, though: see "Without a mission" right below.

## Without a mission

A mission is a head start, not a must. A task can be given in plain words, with a kind of task if you want one:

```
POST /api/tasks   { "task": "Send HR a short summary of our onboarding checklist.", "kind": "hr-summaries" }
```

(the control room has a card for it; `kind` is a plain name, `general` when none is given). The agent then sets up
what the kind needs, and a person confirms each part where it is asked:

- **The goal.** The model drafts it from the task, G1 checks it, the person confirms the back-translation at the gate
  (3.2). For a kind that has no strategy yet, every outcome type is allowed: G1 asks for deadlines, budget and
  channels, not for a way that nobody proposed yet.
- **The ways.** With no strategy to choose, the strategist proposes one from the catalog's moves. It runs as a process
  of its own: trusted code checks it, a person approves exactly that version, and only then it enters the catalog and
  the goal plans again (6.1, 19). The agent may propose new moves (compositions of the five base moves) and new
  criterion types (conjunctions of existing ones) the same way, and strategy gates for the kind (7.3).
- **What stays.** The kind is kept below the core's storage (`tasks/<kind>`), what a person approved in the core's
  ledger. The next task of the same kind, also after a restart, uses the approved ways and proposes nothing new.

Without more, a task works with the catalog's moves and actions (draft a text, send a report or a reply, ask a person,
read the knowledge), and nothing leaves the machine but through the gate, after a person's approval of exactly that
action. With `AGENCY_PROPOSALS=1` (in the core's and the gate's environment) the agent may also propose what the gate
checks against; the operator decides at the gate, with the pin, in the control room:

- **An action the table lacks** (`notice`: what it carries, its criticality, what it says). The gate refuses anything
  below `outward`, money below `money_or_law`, and every name it has. Approved, trusted code derives its send move
  (`notice.send`); each use still waits for a person's approval of exactly that message, and without a registered
  channel it lands in the outbox. A goal names such a message by its class until the action exists
  (`"action": "carries:message"`).
- **A master-data value** for the tasks of one kind (a recipient, a contact `"<ref> <address>"`). Never an account,
  nor a kind an account rule of the goal checks against; never a value from outside or of unknown origin; never for a
  case that came from outside; and only a value the goal a person confirmed names itself. So a value from a supplier's
  mail cannot be laundered into the master data: a person checks it through a channel they trust and enters it.

An approved proposal can be taken back at the gate (`POST /proposals/:id/revoke`). The channels that deliver, the
data a run may see and trusted tools are code or data of the operator and are never proposed.

### From a kind of task to a mission

What people approved for a kind lives in the ledgers of core and gate. Once the kind has proved itself, write it down
as a mission folder, so it can be read, reviewed, versioned and taken along:

```
node bin/promote.mjs hr-summaries --to missions          # from the running core (CORE_URL, CORE_BOARD_PIN)
node bin/promote.mjs --bundle hr-summaries.mission.json --to missions   # from the control room's "Save as a mission"
```

The folder holds the strategies, moves and strategy gates people approved (each strategy with who approved it), the
actions and master data the operator approved at the gate for this kind (`actions.json`, `master.json`, with the send
moves of the actions), and the last goal a person confirmed as its `contract.json`. Nothing is written over an existing
folder, and `bin/check-mission.mjs` checks it right away. Writing it is a deliberate step of the operator, never one
the agent takes: review and commit it, add the folder to `AGENCY_MISSIONS` of core and gate, restart both. From then on
it is a mission like any other: its actions and master data are the operator's files (they win over anything learned),
a task of that kind is sent to the mission, and what the ledgers held stays there as history. When a kind of task grows into something a
company runs often, writing it down as a mission (below) gives it its own moves, data, actions and checks.

## Design before you write

1. **What closes the goal, and on whose evidence.** A goal closes the moment every criterion has its evidence (U1);
   whatever its strategy still had to do is cancelled, its expectations stop listening, and a reply that comes later
   becomes a case of its own. So an item counts as done when the evidence of being done exists: the gate's receipt
   of the action that settles it, a person's answer, or a trusted tool's own observation. Never conclude it from the
   path a strategy took ("the wait ran out, so the reminder must have gone").
2. **Who answers which wall.** Without a wall only `direct` strategies run. Every other strategy answers a wall whose
   cause the diagnosis maps to its class, and most causes are mapped to `"*"` (any class) unless your mission maps
   them (see "Walls and diagnosis"). A strategy that presumes something happened must not be reachable through `"*"`.
3. **What comes back from outside.** An answer to something the mission sent is matched to its expectation while the
   goal still listens. Anything else (a later reply, a new question, a complaint) is a new case whose goal is to
   answer its sender, read by the mission's `request.read` and handled by the strategies in `requests.json`. A process
   that sends now and hears back days later (reminders, quotes, invitations) settles each item on the gate's receipt
   and handles the replies as cases (see "A pattern: send now, hear back later").

## Where missions live

`AGENCY_MISSIONS` names the folders that hold missions, separated by commas, relative to the repository or absolute
(default `missions`). Keep your own next to the demo's (`AGENCY_MISSIONS=missions,../acme/missions`) or instead of
them. Core and gate read the same folders; an id in two folders stops the start.

## The folder

| file | needed | what it is |
|---|---|---|
| `mission.json` | yes | id, title, kind, task, the files below, invariants, defaults |
| `contract.json` | yes | the goal: criteria, deadline, budget (see "The goal") |
| `moves.json` | yes | the steps this mission may take (see "Moves") |
| `strategies.json` | yes | ways to reach the goal, built from moves (see "Strategies") |
| `data/` | often | the mission's data; each run works on its own copy (the vault) |
| `tools/` | often | trusted Python scripts the code moves run in the sandbox (`"tool": "./tools/x.py"`) |
| `actions.json` | when it acts | the outgoing actions it adds: refund, deploy, order (see "Actions") |
| `master.json` | when it acts | the gate's master data: accounts, recipients, contacts (see "Master data") |
| `requests.json`, `inbound.json` | for messages | strategies for new messages from outside, and the demo's messages |
| `criteria.json` | rarely | criterion types it adds (type → class name; the class from `AGENCY_OVERRIDES`) |
| `diagnosis.json` | often | which class of strategy answers which wall (see "Walls and diagnosis") |
| `knowledge/` | optional | text a step may read through the read gate (`knowledge.find`) |
| `world.json`, `stub.json` | for tests | a scripted world, and the model's answers without a model |

`mission.json` names each file it uses (`"moves": "moves.json"`); a file it does not name is not read, except
`actions.json` and `criteria.json`, which are read from every mission folder.

```json
{ "id": "refund", "title": "Refund", "kind": "support-refund",
  "contract": "contract.json", "data": "data", "master": "master.json", "moves": "moves.json",
  "strategies": "strategies.json", "diagnosis": "diagnosis.json", "stub": "stub.json",
  "task": "Answer customer cust-1042 on the double charge of 2 November under the refund policy.",
  "invariants": [ { "type": "account_from_master", "values": { "param": "method", "kind": "payment_method" } } ],
  "defaults": { "budget": 10, "value": 15, "deadlineHours": 24 } }
```

More keys of `mission.json`:

| key | what it does |
|---|---|
| `params` | values a strategy's placeholders can name (`{"asOf": "2026-11-09"}` fills `{{asOf}}`) |
| `startTokens` | the root's start budget for this kind of task (R1); 20 when not set. A goal with many items and several attempts each needs more |
| `directory` | a file in the vault that says who belongs to which team; replies from people outside it are not counted |
| `gates` | a file of strategy gates (rules a plan must pass at G2) for this kind of task |
| `knowledge` | `{ "labels": [...] }`: the labels of the mission's knowledge (own unless said) |
| `invariants` | criteria every goal of this kind carries, also one a model drafts from a task: rules, and checks the kind prescribes (a frozen suite: `test_green`) |
| `defaults` | `budget`, `value`, `deadlineHours` of a goal drafted from a task; `caseBudget`: the budget of each case from outside (6 when not set, at most 60; a person's minutes cost one unit each) |

`contract.json` must contain the mission's invariants too (marked `"immutable": true`), or the goal is refused (G1,
K7). A goal is frozen when a person confirms it: a weekly list of items is part of that week's goal, so a process
that runs every week writes its `contract.json` (or its `params`) from the week's data before it starts.

## The goal

A goal is a list of criteria of fixed types; code checks each one, a model never decides that a goal is met.

| type | kind | met when |
|---|---|---|
| `report_delivered` | outcome | a message of an action (`action`, default `report`) reached `to` |
| `test_green` | outcome | the frozen suite `test` passed in the sandbox (`commit` is the suite's version) |
| `confirmed_by` | outcome | a person in `role` said yes to `question` |
| `number_in_range` | outcome | a value the system measured itself lies in `min`..`max` (an observation, never a message) |
| `items_resolved` | outcome | every item of a collection ended in an allowed outcome (paid, reminded, escalated) |
| `count_matches`, `state_is`, `event_occurred`, `document_present`, `commitment_received` | outcome | see `catalog/criteria.json` and `core/criteria/` |
| `exactly_once` | invariant | each item gets the action at most once, across every goal at the gate |
| `account_from_master` | invariant | money (or `param`) only to a value in the gate's master data (`kind`) |
| `sum_max` | invariant | the total stays at or below `max`; it admits every commitment that moves money |
| `human_approval` | invariant | a person approves each of these actions |
| `min_group`, `no_difference` | invariant | data about people leaves only as a group of at least k, never a difference of fewer than k |
| `to_data_subject` | invariant | data about one person leaves only to that person, at the address on file |
| `soft` | soft | free text a reviewer assesses; never closes a goal alone |

Deadlines in `contract.json` are relative: `"deadline": "{{in:48h}}"`.

**The goal in the app.** In the app a model drafts the goal from the task, G1 checks it, and a person confirms the
back-translation (3.2); `contract.json` is the goal of tests and `check-mission`. So whatever must hold for every goal
of this kind goes into `mission.json` `invariants`: code adds each to every draft, immutable, and G1 refuses a goal
that lacks one or loosens it (K7). That holds for an outcome too: a coding mission prescribes its frozen suite
(`{ "type": "test_green", "values": { "test": "calculator-hidden", "commit": "501f..." } }`), so no drafted goal closes
on a person's yes alone (G-5). A strategy's `fits` (`{ "commit": "^501f0df1e2bdcaa2$" }`, patterns for the values of
the criterion it serves) says what it can work on; a drafted criterion no strategy fits is refused (K8).

An item of `items_resolved` is settled by a fact `item_resolved` with `{ "item", "outcome" }`, of one of two classes:

- **observation**: the gate's receipt of an action whose move `resolves` the item (`"resolves": { "item": "invoiceId",
  "outcome": "reminded" }`: the item is the action's parameter `invoiceId`), or a trusted tool's own finding (a code
  move with `"fact": "item_resolved"` that prints `{"value": {"item": "2026-0301", "outcome": "paid"}}` after
  matching the bank statement);
- **confirmation**: a person's answer to a human step that `resolves` the item.

An item is a plain id of up to 64 characters (letters, digits, `.`, `_`, `-`, `:`; no `@`, no blanks). An item that is
settled gets no step of a later attempt, and no child even later in the same plan.

## Moves

A move is one step of one of five kinds. Every move needs `executor`, `criticality` (`read`, `internal`, `outward`,
`irreversible`, `money_or_law`) and `price`; the rest has defaults (`evidence: []`, `params: {}`, no signal or horizon,
a lease of 2 minutes for code and 3 for a model, reversible only for `wait` and `human`).

- **code**: runs `tool` in a fresh sandbox without network. The tool reads JSON on stdin (the step's params, and its
  inputs as `inputs`) and prints `{"value": ...}`, or `{"value": ..., "wall": {"cause", "reason"}}` when the way does
  not work, and `"fieldLabels": { field: [labels] }` when fields of one result differ (a name confidential, a count
  own). The mission's data is in `AGENCY_DATA`. `labels` says what the result is: `own` (our data), `foreign` (a
  customer's text) or `confidential` (about people). A result about people declares them: print `"cohort": [ids]` and
  mark the move `"group": true` (see "Data about people"). `fact` turns the result into evidence of that kind, an
  observation (only plain numbers and ids go into a fact).
- **code with an action**: `"action": "refund"` hands the action to the gate. `param` takes a single input as that
  parameter (a text body); otherwise the input's fields are the parameters. The step names the `target`.
  `resolves` settles an item on the gate's receipt. `creates.expectation` waits for an answer (see "Messages from
  outside").
- **ai**: `role`, `instructions`, and `contract.fields` (`string`, `number`, `enum` with `values`, `list`, `records`).
  The model gets only the inputs the step names (`from`), never the vault. Its answer is checked against the fields;
  a broken answer gets one repair, then the step fails. A model's output inherits the labels of its inputs.
- **human**: `person.decide` (a question with options, optionally `classes`, see "Walls and diagnosis") and
  `person.confirm` (a yes for `confirmed_by`) are in the base catalog; a ticket goes to a person. The ticket shows
  the inputs the step names (`from`) as its excerpt, each cut short with its labels; a confidential input is shown as
  withheld, never its content. `resolves` on a human move settles an item by the person's answer.
- **wait**: waits for the expectation of an earlier step (`"for": "<as of that step>"`), or for minutes. Minutes are
  real minutes, also in a test (the scripted world runs faster, the waits do not; shorten them in a test with
  `office({ edit })`).
- **child**: a sub-goal from a template (`"template": "child.json"`), with every invariant of its parent. A step with
  `forEach` runs once per item; the children of one strategy run **one after another**, so a child that waits days
  for a reply holds up every child after it.
- Reserved names: `request.read` is the reader of new messages (see "Messages from outside"); the base catalog
  (`catalog/moves.json`) has `report.draft`, `report.send`, `reply.send`, `person.decide`, `person.confirm`,
  `knowledge.find`, `move.cancel` and the `meta.*` moves. A mission's move of the same name replaces the base one.

## Strategies

```json
{ "id": "explain-from-ledger", "serves": "report_delivered", "class": "explain", "price": 0.6,
  "startCurve": { "p0": 0.6, "tauH": 2 },
  "steps": [ { "move": "mail.read", "as": "mail" },
             { "move": "claim.read", "from": [ "mail" ], "as": "claim" },
             { "move": "ledger.check", "from": [ "claim" ], "params": { "customer": "cust-1042" }, "as": "ledger" },
             { "move": "reply.draft", "from": [ "mail", "ledger" ], "as": "answer" },
             { "move": "reply.send", "from": "answer", "target": "cust-1042" } ] }
```

- `serves` is the criterion type it reaches. `class` decides when it runs: **without a wall only `direct` strategies
  are chosen** (the direct way first, 4.3); the others answer a wall (see "Walls and diagnosis").
- A step names its `move`, its inputs (`from`), its result (`as`), fixed `params`, the `target` of an action, and
  `labels` for values typed into the step. `price` and `startCurve` (chance at the start, hours to it) rank strategies.
- `slots` let the model fill values from an allowed list; it never sees data when it does.
- `depth` keeps a strategy to one level of the tree: `0` for the root goal, `1` for its children (a child's "check
  this one invoice" must not run on the root's twelve). Without `depth` a strategy serves every level whose goal has
  the criterion it serves. `kind` does the same across kinds of goal.
- A strategy that hit a wall is not chosen again for the next attempt ("another way means another strategy").
  To look again, give the same steps a second strategy of another class.
- **Placeholders** in params and targets: `{{name}}` is filled from the mission's `params`, the values of the goal's
  criteria (`{{to}}` of `report_delivered`), the item (`{{item}}`: the current item of a `forEach`, or a child's own
  item), a slot, or, in a case from outside, what `request.read` read from the message. Filters: `{{item|subject}}`
  is the part after the first colon (`2026-0322:C104` → `C104`), `{{list|first}}` the first entry. A placeholder
  nothing fills is empty; `check-mission` refuses a target that names one.
- A target is fixed by the plan, never taken from data: a model or a message can never choose a recipient. A
  recipient that differs per item is the item's reference (`{{item|subject}}`), and the gate resolves it to the
  address on file (see "Master data"). An action whose table entry says `"recipient": "contact"` goes only to such a
  reference; anything else, a plain address too, is refused at the gate.

## Sub-goals and preconditions

A goal splits in two ways, and both build the same tree: every child runs the same loop, closes on its own evidence,
and brings back only its facts.

- **One child per item:** a step with `forEach` and a `child` move (`"template": "child.json"`). The child's goal is
  the template with `{{item}}` filled; it serves the parent's criterion with a part of it (R6: one invoice of two).
- **A missing precondition:** a strategy gate (`gates.json`, `"rule": "precondition"`) blocks a move until a criterion
  holds, or a trusted tool prints a wall with `"precondition": { "id", "type", "values" }`. The judgment makes the
  precondition a child of its own (U2), whose only outcome is exactly that criterion (R6); its goal reads
  "Precondition <id> for <criterion>". A gate's criterion values may name `{{param}}` (a parameter of the blocked
  step) or `{{target}}`, so one rule covers every item: `{ "rule": "precondition", "move": "payment.send",
  "criterion": { "type": "confirmed_by", "values": { "role": "purchasing", "question": "Supplier {{supplier}} verified?" } } }`.
  A precondition child has no item of its own: what it needs to know travels in those values.

What every child gets, and what it costs:

- every invariant of every ancestor (K7, R6), a deadline before its parent's with a buffer (R3), and half of what its
  parent has left as budget and value unless the template names its own;
- a start token (R1): `startTokens` in `mission.json`, 20 when not set; a tree of 20 nodes needs more;
- at most depth 5 (R2, `maxDepth`); a chain deeper than that is cut.

When a child resembles an ancestor closely, it asks its parent first (R5). The parent lets it go on when it is a
narrower part of the criterion it serves or a precondition the parent named itself; anything else is a rewording and
is stopped.

When a precondition child fails, its parent hits a wall `child_failed` and the diagnosis leads to the next class, as
for any wall. If the blocked move is still gated, a person gets "Check the gates"; only a person lifts a gate (21),
and when the precondition was tried and is not met, lifting it is not what the ticket recommends.

What comes back from a child: a fulfilled child brings its `item_resolved` facts, a precondition child the fact that
its precondition is met. Nothing else travels up; a parent that needs a count from its children has it as their
items' outcomes, or reads it from the vault. A child template knows `{{item}}` only.

When a precondition is met, the strategy that stopped at it runs again from its first step (R7). Keep what must not
happen twice (an invitation) out of a strategy that a gate can stop later: one strategy sends and waits, the next
counts behind the gate. The gate's own rules (`exactly_once`) refuse a second send anyway, but a refusal is a wall.

A sibling waits for siblings through the parent: a gate on the parent's step that starts the later child, whose
criterion holds once the earlier children's facts are in the parent.

Rules on the same move and the same criterion type replace each other (the stricter holds). `check-mission` seeds
`gates.json` as the system does and refuses a rule no strategy can satisfy: an order no strategy keeps, or a
precondition that only the blocked move brings about (R4).

## Strategy gates

`gates.json` holds rules a plan must pass (21): `{ "rule": "precondition", "move": "person.confirm", "criterion": {
"type": "test_green", "values": {...} } }` blocks a move until a criterion holds; the judgment then makes the criterion
a child goal (U2). Gates are seeded when the mission starts and hold for 180 days: a changed `gates.json` applies once
the old gate expired or a person lifted it.

## Walls and diagnosis

Branching is by walls (5.6), never inside a strategy. A step that finds the way does not work prints a wall with a
cause from `catalog/causes.json`; the diagnosis reads the cause as hypotheses, each pointing to a class, and the next
strategy is one of those classes.

- The base diagnosis is `catalog/diagnosis.json`. A mission's `diagnosis.json` **replaces** the base entry of every
  cause it names: `{ "move_failed": [ { "hypothesis": "the_ledger_does_not_hold_it", "class": "explain" } ] }`.
- The base maps most causes (`not_reached`, `plan_refused`, `lease_expired`, `child_failed`, `rejected_by_person`,
  `not_sent`, `soft_rule`, and `move_failed` after `hand_over`) to `"*"`: any class may answer them. A strategy that
  presumes something happened (a reminder went out, a payment was booked) must not answer such a wall: map those
  causes in your mission to the classes that may. `check-mission` lists the causes left to `"*"`.
- Content decides through trusted code: put what decides into the vault (an expectation's `store`) and let a tool
  print a wall.
- A person decides through `person.decide` with `classes`, a map from an option to a class: `{ "options": [ "propose
  the week after", "drop the meeting" ], "classes": { "propose the week after": "later" } }`. At a wall, the chosen
  option's class is learned for this kind of task and the next strategy is one of it (`tests/usecases/scheduling`).
  A wall nobody has diagnosed yet asks the person for the class by itself.

## Code the agent writes

Two frames, both trusted code that checks what the model's code did, in sandbox runs of their own:

1. **Acceptance tests** (`sandbox/tools/acceptance.py`): the code move gets `suite`, frozen `cases`
   (`{ "call": "fn", "args": [...], "expect": value }` or `{ "expect": { "raises": "ValueError" } }`) and the
   `modules` the code may import. Green is a `test_run` fact for `test_green`; its `commit` is the suite's version
   (`node bin/check-mission.mjs <id>` prints it).
2. **A frame over data** (`"tool": "./tools/frame.py", "agentCode": "sandbox/tools/agent_code.py"`): the frame's
   `prepare` phase reads the data and hands the code only the rows it may see; the code runs alone; the `check`
   phase verifies the result against what it must be and prints `"verified": true`. A frame that does not verify is
   refused. See `tests/usecases/{reconcile,migration,hiring}/tools/frame.py`.

3. **A frame of your own**, for another language (`tests/usecases/calculator`: PHP): a trusted Python tool that runs
   the language's runtime in the sandbox, checks the code before and while it runs, and prints for `test_green`
   `{"value": {"test", "commit", "result": "green", "passed", "of"}}` from a move with `"fact": "test_run"`. The
   `commit` is your frame's own version (a hash of the frame, the suite and its cases); `check-mission` computes it
   only for `sandbox/tools/acceptance.py`, so compare yours by hand. A failure prints a wall with a `repair` in the
   protocol below; error kinds are Python's names, so map yours to the nearest (a forbidden call to `PermissionError`).
   The production sandbox image (`SANDBOX_IMAGE`, `python:3.12-slim`) has no other runtime: build one that has it, and
   run the containment check (`infra/smoke.sh`) on it, whose probes are Python's.

The code a model wrote lives in its run; the result keeps its hash. To hand it on, add a step after the green run
that sends it (an outward action a person approves). A model step gets one repair per attempt; more tries are more
strategies.

When the code fails, the model hears only the core's repair report: a built-in error kind and its line (and for a
NameError the missing name, if it is a word of its own code), the schema keys, wrong figures, or how many cases
failed. A frame reports `{ "error", "line" }`, `{ "schema", "keys" }`, `{ "differs", "keys" }`, `{ "failed", "of" }` or
`{ "problem" }` with a problem from `Executor.PROBLEMS`.

## Actions

`actions.json` adds a mission's actions; a name the catalog or another mission has is refused. The catalog itself
holds only what every mission may use (`report`, `reply`); even the demo's `payment` and `invite` are actions of their
missions. An action that carries `money` must have the criticality `money_or_law`; any other is refused at the start.

```json
{ "refund": { "criticality": "money_or_law", "carries": [ "money" ], "sensitive": [ "method" ],
              "commits": "refund", "says": "a refund to the payment method it was taken from", "idempotencyH": 168 },
  "reminder": { "criticality": "outward", "carries": [ "data", "message" ], "says": "a payment reminder to a customer" } }
```

- **Approval.** Every action `outward` and above waits for a person's approval of exactly that action, bound to its
  hash (G-6); `money_or_law` needs a reason, `irreversible` an explicit yes. There is no threshold below which an
  outward action goes alone: a rule like "a person approves reminders above 10,000 EUR" is met by approving each
  reminder (the amount is in what the person approves). Approval load at volume is a known limit (paper, chapter 11).
- **carries** says what an action carries: `money`, `data` (about people), `message` (a text for a person). Only an
  action that carries a message gets the soft rules of the user's base setup (formal address, no exclamation marks,
  no prices, no contact on quiet days). A message leaves the company unless the entry says `"inside": true` (a report
  to HR, an invitation to a team); only the written rules hold for those. A soft rule never stops an action: a text
  that breaks one is reworked once if a model wrote it, else the action goes to the person marked. An action that
  carries nothing (a deploy, a log rotation) gets `"carries": []`.
- **sensitive** parameters never take a value from a message.
- **recipient**: `"contact"` makes the gate send this action only to a reference with an address in the master data
  (6.2: the recipient is a contact reference). Use it for every message to a customer or supplier.
- The soft rules are the user's base setup (`catalog/base.json`, or the file `AGENCY_BASE` names): one for the whole
  deployment, not per mission. A process whose messages must name amounts (a reminder) either lives with the mark at
  approval or the deployment sets `"namePrices": true`. Its `timeZone` (an IANA name, `UTC` by default) says which
  day it is for quiet days and for the daily capacity of people.
- **What a goal admits.** A move may commit to something (`commits`, or the `commits` of its action) only when a
  criterion of the goal admits it: `items_resolved` admits a move that settles an item with one of its allowed outcomes
  (the move's `"resolves": { "item", "outcome" }`), `sum_max` a move whose action carries money. No name of a
  commitment or an outcome is known to the engine.

## Master data

`master.json` (or the file `mission.json` names under `"master"`, next to it) holds what only the operator may say; the
gate reads it itself at start. Its values serve **only the goals of this mission's kind** (the kind of the root goal,
which a person confirmed); a value the file no longer holds is revoked at the next start. The operator adds values
for one kind or for every goal at the gate (`POST /master` with `scope`) and takes them back (`POST /master/revoke`).

- `account`, or a kind of your own, for `account_from_master`, which names the parameter that holds the account
  (`{ "param": "iban" }`, or `{ "param": "method", "kind": "payment_method" }` with `{ "payment_method": [ ... ] }`);
- `recipient`: who may receive data about people (any release goes only to a target listed here);
- `contact`: `"<ref> <address>"` pairs. **The gate resolves a target that is such a reference to its one address**
  (6.2, 18.5): the person approves that address, the hash covers it, the channel sends there, and a change of it
  after the approval does not move the approved action. A reference with two addresses on file is refused. The
  same pairs say which address is on file for a person (`to_data_subject`). The target stays the reference, so
  `report_delivered` and `exactly_once` see what the plan named.
- `sender`: senders known by their role (`supplier`): the logs name them so; anyone else, and every person, gets a
  pseudonym there. A `recipient` counts as a known role too.
- What the gate checks about a recipient: a target that is a reference is resolved; an action of recipient type
  `contact` goes to a reference only; a release of data about people goes only to a `recipient` and, under
  `to_data_subject`, only to that person's address. A target the plan names otherwise goes out as named: it was
  written by the operator or chosen from a slot's allowed list, never taken from a message (10.4).
- To bind a message to the party it is about (a reminder about C104's invoice goes to C104 and nobody else), the
  trusted tool that writes it declares that party as its cohort (`"cohort": ["C104"]`, the move `"group": true`) and
  the goal carries `to_data_subject`: the gate then pairs the cohort with the resolved address, so even a plan that
  names the wrong customer sends nothing (`tests/usecases/dunning`).

## Data about people

Data about people is labelled `confidential` where it is read (a code move's `labels`), and leaves only as a group
the goal allows. A step that hands it on declares whom it is about: the tool prints `"cohort": [ids]` and the move
says `"group": true`. The gate's rules for people (`min_group`, `no_difference`, `to_data_subject`, `recipient`)
count that cohort. The plan check (G2) lets confidential data leave only through an action a criterion of the goal
allows it for (`min_group`, `to_data_subject`), and only as a group. Label a customer's own record confidential when it
is about a person, so it cannot leave without its cohort.

## Messages from outside

- An answer to something the mission sent: the sending move has `creates.expectation` with a `key` (a reference
  the answer carries, e.g. `[REF-123]` in the subject), the `fact` it becomes, `need` (how many answers), `minutes`,
  `extract` (the fields a model reads, each with a type: `integer`, `number`, `enum`, `date`, ...), `parser`
  (regular expressions code reads the same fields with; a field both read differently goes to a person), `store`
  (rows trusted code writes into the vault), and `each` (a field that makes one sender's answers a series, e.g. the
  minute of a monitoring report). Every sender counts once per expectation, or once per value of `each`.
- A stored row holds the extracted fields plus `from`, `team` (the target the expectation was for) and `id` (the
  sender's id from the directory, or a pseudonym). Cells lose commas and line breaks and are cut to 200 characters.
- A reply whose reading breaks the expectation's schema (a required field missing, a value out of its range, the
  model down) leaves no fact, and a person gets a ticket with the message's excerpt (7.2). Mark a field
  `"required": false` when a reply may lack it.
- A message whose reading says it also asks for something else is that many concerns (8.1).
- A new message (no expectation, or one whose goal closed): the mission's `request.read` move (role planner) reads it
  into concerns with a `concern` schema (`intent` and lists); each concern is a case whose goal is to answer the
  sender, with the strategies of `requests.json` (`"kind": "request"`, `intents`). Without `request.read` a person
  gets a ticket with the message's excerpt (8.4).
- Everything from outside is foreign and a claim, never an observation.
- A deployment feeds real messages in with `POST /api/missions/<id>/messages` (header `x-inbound-token` with
  `INBOUND_TOKEN`; body `{ "id", "from", "to", "subject", "text" }`, the id once per message): a mail bridge or a form
  posts what it received, and it reaches the mission's latest run. Without `INBOUND_TOKEN` the channel is off. The
  canned messages of `inbound.json` exist for the demo only (`AGENCY_DEMO=1`).

## A pattern: send now, hear back later

Reminders, quotes, invitations: one action per item, answers that come days later or never.

- One child per item (`forEach` + `child`), its strategies with `"depth": 1`. Its direct strategy first lets a
  trusted tool look at its item: found paid in the bank statement, the tool prints `{"value": {"item":
  "2026-0301:C104", "outcome": "paid"}}` from a code move with `"fact": "item_resolved"` and the child closes; still
  open, the tool prints a wall and the next strategy sends the reminder, whose move `resolves` the item on the gate's
  receipt (`reminded`). The child closes on the receipt; it does not wait for the reply, so the next child is not held
  up. (One code move settles one item.)
- The item carries the customer's reference (`2026-0322:C104`), so the step can name both. The parameter `resolves`
  reads holds the whole item, and `exactly_once` keys on the same parameter (`{ "key": "item", "action": "reminder" }`):

  ```json
  { "move": "reminder.send", "from": "letter", "target": "{{item|subject}}",
    "params": { "item": "{{item}}" } }
  ```
  with the move `"action": "reminder", "resolves": { "item": "item", "outcome": "reminded" }` and the action
  `"recipient": "contact"` in `actions.json`.
- Replies arrive after the item closed: they are new cases. `request.read` reads the intent (`paid`, `dispute`,
  `other`) and the item it names; `requests.json` answers each: a claim of payment is checked against the data by
  a trusted tool and answered; a dispute goes to a person (`person.decide` with the reply as its input) and is
  answered when they decide.
- The summary for the team lead is a step after the children, built by a trusted tool. It sees its inputs and the
  vault, not what the children did (their facts are the goal's evidence, not a step's input): it counts from the
  data, so it says what was due, not what was sent; the gate's ledger and the event log say what was sent.
- A case's budget is `defaults.caseBudget` (6 by default); a person's minutes cost one unit each, so a strategy
  that asks a colleague for ten minutes needs a budget above ten.

## What a person sees

- **Approvals**: action, target, the address the gate resolved, parameters, the group it names, and a mark for a
  broken soft rule.
- **Tickets** (8.4): question, options, recommendation, reason, and an excerpt (the message, or the step's inputs).
- **Calibration samples** (B7): now and then a ticket asks whether a model's answer was right (`right`/`wrong`);
  the measured error rate decides whether that step is put under a person's review.

## Testing a mission

- `stub.json`: per role one answer, a list used in turn, or `{ "when": "text in the input", "answer": ... }` entries.
- `world.json`: `people` answer an invitation to their team (the actions listed in `invitations`; nobody answers
  when it lists none), under the world's `keySubject` for a reply with the key and its `subject` otherwise (both
  `{{name}}` templates; `Re: <action>` without either); `responders` answer an action to a target
  (`{ "on": { "action", "target", "params" }, "replies": [ { "after", "from", "subject", "text" } ] }`, `{{name}}`
  filled from the message, in subjects and texts of both). Seconds are world time (`WORLD_SPEED`).
- A test runs the mission through the real loop and gate with `tests/office.mjs` and a person you script
  (`approve`, `person`). See `tests/usecases/usecases.test.mjs`. An approval that was redeemed ends as `consumed`.
  More options of `office()`: `provider` (a model of your own, e.g. a stub that records what each role heard),
  `edit` (change the loaded mission), `share` and `resume` (a restart), `answers` (stub answers).
- A timer raced against a run keeps the test process alive until it fires: `unref()` it, or clear it.
- A restart: `office.crash()` stops the core's calls to the gate; crash it while it waits for an approval (as
  `tests/core/restore.test.mjs` does), not inside a wait, where it would go on in the same process.
- Run tests through `node tests/run.mjs --test <files>` (what `npm test` does): every run's vault copy lands in a
  temporary folder that is removed afterwards.
- A tool runs alone in its sandbox: it cannot import another file of the mission. Shared code is copied into each
  tool, or one tool takes a `mode` parameter.
- The vault is the mission's data as it was when the run started; data that changes during a run (a new bank
  statement) comes in as a message or in the next run.
- Live: set `LLM_API_KEY` and `LLM_MODEL`; `LLM_MODELS=coder=<model>` gives a role its own model (a reasoning model
  writes code far better than a fast one). `LLM_EFFORT=coder=medium` bounds how long it thinks: without it, the
  reasoning models of the endpoint thought a whole PHP parser's 32,768 tokens away and answered nothing; the provider
  then names the token limit instead of a broken answer.

## Checking a mission

`node bin/check-mission.mjs <id>` loads the mission from `AGENCY_MISSIONS` and checks: every file it names, the
goal as G1 checks it, every step's move, inputs, parameters, target and files, that a `direct` strategy serves every
outcome, the reader of new messages, the placeholders of every target, the stub's roles and the world's actions. It
prints the version of every frozen acceptance suite and the causes any strategy class may answer (`"*"`). It checks
structure, not meaning: whether a strategy's premise holds at the walls that reach it is yours to decide.

## Beyond a mission

- `AGENCY_OVERRIDES=<folder>` with an `overrides.json` replaces or adds classes: your own channels (below), your own
  criterion types (listed in a mission's `criteria.json`).

### Channels

A channel is how the gate reaches one service. It is an object with

- `send( delivery )` → `{ ok: true, receipt }` when the service took it, else `{ ok: false, error }`. The delivery
  carries `id` (use it as the idempotency key), `action`, `target`, `address` (the address the gate resolved a
  reference to; send there when it is set, else to `target`) and `params`, exactly as the person approved them;
- `lookup( delivery )` (optional) → `{ receipt }` when the service has the operation of that key, else `null`; the gate
  asks after a crash instead of sending again (O4);
- `static IDEMPOTENT = true` on its class only when the service really ignores a second send with the same key; then
  the gate repeats a failed attempt for as long as the action table's `idempotencyH` says, else never (O2, O3).

The gate gives each send `sendMs` and treats a timeout, a throw or an answer it cannot read as a failed attempt. A
deployment registers its channels in a file only the gate reads, named by `AGENCY_CHANNELS`; every action without a
channel of its own goes into the local outbox:

```json
{
  "mail": { "class": "Acme.Channel.Mail", "actions": [ "reply", "reminder" ], "options": { "from": "ap@acme.example" } },
  "bank": { "class": "Acme.Channel.Bank", "actions": [ "payment" ] }
}
```

`"*"` among the actions makes a channel the one of every action without its own. The class comes in through
`AGENCY_OVERRIDES` (`{ "Acme.Channel.Mail": "mail.js" }` in its `overrides.json`) and is made once with
`{ db, options, log }`:

```js
// overrides/mail.js
app.define( 'Acme.Channel.Mail', [], () => class Mail {
	static IDEMPOTENT = false;
	constructor( { options } ) {
		this.from = options.from;
	}
	async send( delivery ) {
		const _answer = await fetch( process.env.ACME_MAIL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { from: this.from, to: delivery.address || delivery.target, key: delivery.id, body: delivery.params.body } ),
			signal: AbortSignal.timeout( 30000 ) } );
		return _answer.ok ? { ok: true, receipt: { id: ( await _answer.json() ).messageId } } : { ok: false, error: `mail ${_answer.status}` };
	}
} );
```

The gate refuses to start when the registry is unclear: a class it cannot load or that has no `send()`, an action the
action table does not know, an action two channels claim, or a channel named `default` or `outbox`. It logs which
channels it registered (`channels_loaded`), never their options. Secrets never go into the registry: a channel reads
its own from the gate's environment. Set `AGENCY_CHANNELS` and `AGENCY_OVERRIDES` for the gate's process only; the
core never needs a channel.
- `GATE_LEDGER_SCOPE=goal` keeps "exactly once" and "no difference" to each goal (only for a demo whose runs are
  separate worlds).

## Limits, honestly

- Every outward action is approved by a person, one by one (G-6); there is no threshold by amount or kind.
- The children of a strategy run one after another.
- A person's role in `confirmed_by` is a label: whoever answers the ticket counts. Identities and roles of people
  are the deployment's (who may log in to the board), not the engine's.
- `sum_max` counts the money of one goal and its children, not of a calendar week.
- A case from outside knows the sender's address, not who they are in the mission's data: mapping a sender to a
  customer is a trusted tool's job (the vault's customer list), or a person's.
- No step reads the outcomes of the children; a summary counts from the data.
- A plan branches on walls and their diagnosis, never inside a strategy: content through a trusted tool's wall, a
  person through the class of the option they choose.
- A message from outside is never an observation: a goal that needs a measurement of a live system (disk usage,
  error rate) is closed by a person's confirmation, since sandboxes have no network and no read path to live systems.
- A new message always becomes "answer the sender".
- The causes of walls are a fixed list (`catalog/causes.json`); a mission maps them with `diagnosis.json`.
- The gate checks recipients, amounts, groups and approvals, not what a text says: a rule about wording ("never
  threaten legal steps") holds through a trusted template or a person's approval, not through the gate.
- Labels know own, foreign and confidential; protected attributes (age, gender) are kept out by the frame that
  prepares the data, not by a label of their own.
