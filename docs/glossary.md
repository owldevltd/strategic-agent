# Glossary of rule ids and chapters

The ids below come from the concept paper behind the engine. They are cited in code comments and test names so a
reader can find the rule a line of code enforces.

## The checks G1–G6 (chapter 7.2)
| id | what it means |
|---|---|
| G1 | Contract check, from task to goal: every criterion fits its type's schema, rules K1–K8 hold, a channel exists for each required evidence class and a person confirmed the back-translation. For a child also R5 and R6. A failure returns a list of defects. |
| G2 | Plan check, from strategy to execution: only catalog moves with valid parameters, the budget fits, labels allow every data flow into sensitive parameters, commitments stay within the contract, the contract hash matches and no cycle appears in the wait graph (R4). |
| G3 | Fact check, from inbound or execution to judgment: only facts in the schema of their expectation, each with evidence class, origin and the matching contract hash. Text from the world never passes. |
| G4 | Write gate of the memory: a lesson has a fixed schema, carries evidence, is signed and has no field for rights, gates or the catalog. Anything else is dropped or becomes a proposal in a ticket. |
| G5 | Read gate of the memory: every piece of knowledge, the system's own lessons included, is checked for signature, origin and label when read. A lesson may only influence which strategy is chosen. |
| G6 | Closing check inside a node: a node closes as met only when every evidence predicate holds and immutable criteria are unchanged. In every case children and moves must be final, the lesson written and the budget booked. |

## Guarantees G-1…G-10 (chapter 13)
Each guarantee is enforced by a mechanism, never by a model, and holds under the failure model of 18.6.

| id | what it means |
|---|---|
| G-1a | No start after the end: once the deadline or the budget is reached no new move starts, and the whole tree has at most B starts of rounds and children, B being the root's start tokens. |
| G-1b | Nothing new is sent after the root deadline plus the abort buffer, even if the core is down. An action sent earlier that only takes effect later is excepted (O6). |
| G-1c | Every node reaches a final state in the log by the root deadline plus the abort buffer while the core runs; after a core outage, by the restart plus the restart buffer. |
| G-2 | Every child serves an open precondition of its parent, and a met precondition is not decomposed again while its evidence holds (R7, R8). |
| G-3 | A confirmed contract has no contradiction in its hard core: typed criteria and rules K1–K8; free text is never part of that core. |
| G-4 | No criterion counts as met until its evidence predicate holds, and no contract closes as met without all of them. The model's verdict is only a proposal; G6 decides. |
| G-5 | Checks the agent wrote itself (layer 2) never define fulfilment alone; G6 requires the layer 1 criteria. |
| G-6 | No effect on the outside world without approval of exactly that action: a one-time, expiring approval token over the hash of the resolved action, consumed atomically when the delivery operation is opened. |
| G-7a | Without help from the service (no idempotency, no atomic conditional operation) one approval allows at most one send attempt, and an unclear result is never retried automatically. |
| G-7b | With idempotency or a conditional operation at the service, all attempts of one delivery operation together cause at most one effect, and exactly one if the service accepts an attempt before expiry. |
| G-8 | No waiting process ever sees text from the world: inbound mail runs as its own process and G3 lets only facts in a schema through. |
| G-9 | A lesson never changes what is allowed: lessons only feed the scoring, and their schema has no field for rights, gates or the catalog. |
| G-10 | Immutable criteria stay unchanged, also while learning: they are flagged in the contract, G1 refuses changes and G6 checks them at every close. |

## Contract consistency K (chapter 14.2, checked at G1)
| id | what it means |
|---|---|
| K1 | No criterion's deadline lies after the contract's deadline. |
| K2 | In every time window the start lies before the end, and the end lies no later than the criterion's deadline unless the type asks for a later window. |
| K3 | Dependent criteria fit in time: when an event refers to a commitment, the commitment is due before the event's window ends. |
| K4 | For every required evidence class the catalog has a channel; otherwise a `confirmed_by` criterion is added and a person becomes the channel. |
| K5 | Every sentence of the desired effect is covered by a criterion from the client or a catalog invariant; uncovered sentences are listed in the back-translation. |
| K6 | Number ranges are not empty and tolerances are not negative. |
| K7 | The invariants the catalog prescribes for the process kind are present and marked immutable. |
| K8 | The budget covers at least the cheapest eligible strategy, and every deadline lies in the future. |

## Recursion R (chapter 17)
| id | what it means |
|---|---|
| R1 | Start tokens: the root holds B tokens; every start of a round or a child burns one atomically with its start event. Returned budget never adds tokens. |
| R2 | Depth: a child is one level below its parent and never deeper than the maximum depth, a system gate. |
| R3 | Deadlines: a child is due before its parent minus a buffer, and every expectation and ticket is due no later than its node. |
| R4 | Wait graph: the core tracks which node waits for which node or ticket, siblings included; G2 refuses a plan that would close a cycle. |
| R5 | No rewording: G1 compares a child contract with all its ancestors; the same criterion types with the same values are refused. |
| R6 | Contribution: a child names the parent criterion and precondition it serves; its G1 checks that the criterion is open, the precondition unmet and expressed exactly by the child's criteria. |
| R7 | Effect: a child closes as met only when its named precondition is met by its evidence predicate; new evidence alone is no progress. A met precondition stays met while its evidence is valid. |
| R8 | No repetition without benefit: no new child for a precondition that is met with valid evidence. If the parent's next wall names it missing again, the verdict is escalate. |

## Judgment U (chapter 16.4)
| id | what it means |
|---|---|
| U1 | Done, when every criterion's evidence predicate holds; it takes effect only through G6. |
| U2 | Deeper, when the wall carries the cause `precondition_missing` and names a precondition that catalog types can express, that serves an open criterion and is not yet met. It becomes the child's contract. |
| U3 | Another way, when the cause belongs to the chosen strategy (such as `no_reaction` or `not_reached`) and another eligible strategy has positive points (chapter 19). |
| U4 | Escalate in every other case, especially when a fact makes a criterion impossible or facts from different origins contradict each other. |

## Evidence B (chapter 15)
| id | what it means |
|---|---|
| B1 | Origin: every piece of evidence names its channel and source; evidence of the same origin counts once. |
| B2 | Validity: every piece of evidence has an expiry or a reference such as a commit; expired evidence does not count. |
| B3 | Cascades: a derived fact carries the weakest evidence class of its inputs. |
| B4 | Parser match: a model's reading becomes a claim only when a parser without a model reads the fixed fields the same; on a mismatch a person decides. |
| B5 | A confirmation over the same channel stays a claim; silence until the deadline is the system's own observation. Together they prove a commitment arrived and was not withdrawn. |
| B6 | Evidence predicate: each criterion type states what must be proven and which evidence proves it (source, role, class, freshness). G6 checks the predicate, never the class alone. |
| B7 | Calibration, not self-assessment: a model's own confidence never counts; a person samples every AI step, and above an error threshold the step goes to human review. |
| B8 | Provisional results: a timeout is provisional; a late fact corrects the attempt's result, never a past decision. |

## Events E (chapters 18.2, 18.3)
| id | what it means |
|---|---|
| E1 | Versions: a transition is written only if the node's version is unchanged; otherwise the node is read and judged again. |
| E2 | Duplicates: an event with a known id is dropped. |
| E3 | One judgment at a time per node; further facts wait in the node's queue. |
| E4 | A late fact is always recorded and queued; it triggers a transition only in waiting, waits for the next judgment in other states, is only logged while closing and opens a new case after close. |
| E5 | Contradiction: of facts with the same origin the newer wins; facts from different origins create a conflict fact, which blocks G6 for that criterion and leads to escalate. |
| E6 | Cancellation: the judgment may cancel a move marked reversible, such as an open call ticket after a late commitment; the cancellation is a move of its own with evidence. |

## Learning L (chapter 20)
| id | what it means |
|---|---|
| L1 | Reorder, never remove: lessons only change a strategy's target curve and signal time; no lesson makes a strategy ineligible. |
| L2 | Log instead of estimate: curves come from the catalog for now, but every attempt is logged in full (strategy, situation, outcome with time, end of observation, contribution) up to the move's horizon. |
| L3 | Three levels are logged apart: the attempt's own result, its contribution to criteria and the contract's success. |
| L4 | Credit for direct contribution only: an attempt succeeds when a fact from its origin is first to meet a criterion's evidence predicate in time. Contract success alone credits no strategy. |
| L5 | Late effect: a signal after a timeout corrects the attempt from timeout to late effect (B8); it counts as success only under L4. |

## Outbox O (chapter 18.4)
The gate's ledger holds one delivery operation per approved action, with the status open, executed, unclear or not sent.

| id | what it means |
|---|---|
| O1 | Order at the gate: check the approval, consume the token and open the delivery operation in one atomic booking; book each attempt durably before sending. After a crash, open operations are rebuilt from the ledger. |
| O2 | Exactly once only with the service's guarantee (idempotency key or atomic conditional operation), and only while the service keeps the key; the operation's expiry is shortened to that time. |
| O3 | No silent retries: without O2 nothing is retried automatically, not even by client libraries. |
| O4 | A status query clarifies but permits nothing: "not found" never allows an automatic retry unless O2 applies. |
| O5 | Unclear is a final state: if reconciliation does not show executed and O2 does not apply, the operation is unclear and a ticket goes to a person; resending needs a new approval. |
| O6 | An effect that has started cannot be recalled: a revoked lease or a withdrawn operation does not stop an attempt already sent. |
| O7 | With O2 the gate retries the same operation with the same idempotency key and growing pauses until confirmed or expired, without a new token; expiry without confirmation means unclear. |
| O8 | An attempt starts with one conditional booking: the operation is open and not withdrawn, not expired, its content hash equals the approved one and its key is unchanged. Expiry is checked again right before sending. |
| O9 | Withdrawal: aborting a node withdraws its open operations by a conditional booking that competes with O8; the operation ends as not sent, or as unclear if an attempt had started. |

## Leases and supervision A (chapter 18.6)
| id | what it means |
|---|---|
| A1 | Every running move holds a lease with a maximum duration from the catalog and renews it by heartbeat. |
| A2 | Calls to outside services have client timeouts shorter than the lease. |
| A3 | When a lease expires the supervisor ends the move: the sandbox is stopped and discarded, its tokens revoked, the move counts as aborted. An operation it opened runs on under 18.4. |
| A4 | A vanished worker is found by its expired lease; if it returns it can write nothing, since every write carries the lease's fencing token and expired tokens are rejected. |
| A5 | Tickets to people have deadlines (R3); an open ticket never holds up closing beyond the abort buffer and is withdrawn. |
| A6 | Workers have neither network nor credentials. One gate holds the credentials and, before opening an operation, checks a valid lease with its current fencing token, an unused approval token with matching hash and the expiry. |
| A7 | Every lease, fencing token, approval token and delivery operation has an absolute expiry no later than the root deadline plus the abort buffer; gate and sandbox enforce it without asking the core. |
| A8 | Fail closed: when the gate cannot check a permission with certainty, it does not send. |

## Approval tokens F (chapter 18.5)
| id | what it means |
|---|---|
| F1 | The token's hash covers every resolved parameter and content, not only references. |
| F2 | A token is used exactly once, to open exactly one delivery operation; a second use is refused, and the operation's technical attempts need no token. |
| F3 | A token expires after a set time. |
| F4 | The gate recomputes the hash right before opening the operation and checks lease, fencing token and expiry; on any difference nothing is sent and a new approval is needed. |
| F5 | Any change to recipient, content or attachment after approval needs a new approval. |

## State machine Z (chapter 16.2)
| id | what it means |
|---|---|
| Z1 | A node is always in exactly one state. |
| Z2 | Every state except closing and closed has a deadline; when it passes, a timeout fact sends the node to judgment. Closing is bounded by the abort buffer. |
| Z3 | Only the transitions of table 16.1 exist; any other is a system gate violation. |
| Z4 | Every transition is an event in the log, and a node's state is derived from the log. |
| Z5 | Closed is final: a closed node reacts to no event, not even its own deadlines; later messages become new cases. |
| Z6 | Events for root deadline, budget and abort take precedence over all other events of a node. |

## Budget P (chapter 23)
| id | what it means |
|---|---|
| P1 | One pot: every cost is counted in one unit for the choice of strategy. |
| P2 | Every move has a price in the catalog, people's minutes included. |
| P3 | Every start of a round or a child burns a start token (R1) and costs its moves, at least one unit. |
| P4 | A child reserves its budget from the rest of its parent; what is left flows back. |
| P5 | Compute cost, person minutes and duration are logged per move, even though only the sum counts for the choice. |
| P6 | Daily capacity: before a ticket to a person a soft gate checks the day's capacity; when it is used up, tickets are bundled for the next day if deadlines allow. |

## Chapters
| id | what it means |
|---|---|
| 2.3 | Borrowed from project management: each phase ends at a gate decided on evidence; "really done" has six dimensions: functional, formal, commercial, organisational, knowledge and structure. |
| 3.1 | Effect, not activity: the contract says what must be true in the world. Each criterion has its own deadline; the contract's is the latest. |
| 3.2 | Manifestation at G1: a model drafts typed criteria, code checks schema, K1–K8 and feasibility, a person confirms the back-translation, then the contract is frozen by hash. |
| 3.3 | Acceptance in two layers: layer 1 from the client and catalog invariants, layer 2 written by the agent, which adds proof but never defines fulfilment alone. |
| 3.4 | Truth from outside: the type's evidence predicate decides; when no channel can deliver the evidence, a person becomes the channel. |
| 4, 4.1 | The strategy loop: the frozen contract in the centre; strategy, act, check, judge and learn circle it until every criterion is proven. 4.1 lists the steps and who does each. |
| 4.2 | Three verdicts: done, continue (another way or deeper) and escalate. |
| 4.3 | Recursion: decompose only when the direct way fails; the child starts at the wall with the missing precondition and takes the same route. |
| 4.4 | Closing runs bottom up: one open piece in a child holds up its parent and the whole tree. |
| 5.2 | One pot: all costs in one unit, people's minutes the dearest; a deadline is a criterion, not budget. |
| 5.3 | Criticality: reading and internal changes run alone; outside effects, irreversible actions and money or law need a person's approval. |
| 5.4 | Budget in the tree: root, child, strategy and move; children reserve from the parent, rests flow back. |
| 5.5 | Strategy signals: an early signal may end a strategy but never confirm it; only the contract's criteria confirm. |
| 5.6 | Adaptation through diagnosis: wall, then cause as hypothesis, then strategy class, then concrete moves; a cheap test comes first. |
| 6.1 | Five base moves (code in the sandbox, model with fixed output, person, wait, child); new moves are only compositions of them. |
| 6.2 | A catalog entry: executor, evidence, criticality, idempotency, sensitive parameters, price, signal time, start curve, lease maximum, expectation. |
| 6.3 | Executors and guard rails: each move fixes who executes it; minimisation, approval, budget and log apply around every move. |
| 6.4 | Step contract: every model step has fixed fields and types, checked in code; a broken result goes to a person. |
| 7.1 | Three zones: thinking has no hands, executing has no ideas, processes never see the world. |
| 7.2 | The places where code checks: the table of G1–G6. |
| 7.3 | Three kinds of rules: system gates nobody changes, strategy gates the agent may only tighten, soft gates from the user. |
| 8.1 | Inbound is its own process: a waiting process files an expectation, and messages are matched by fixed keys first. |
| 8.2 | Life of an expectation: a timeout is a result, not an error; a late answer is still a valid fact. |
| 8.3 | Facts with evidence class: each fact has a class (observation, confirmation, claim, derivation), an origin and a validity. |
| 8.4 | Tickets: one mechanism for questions, approvals and escalations; only the asker waits, nothing waits forever. |
| 9.1 | Knowledge is always checked, the system's own included; a signature proves integrity, not truth. |
| 9.2 | Memory per node: goal (changed only by ticket), current situation (replaced) and history (append only). |
| 9.3 | Lessons reorder, never remove: they change estimated chances, never what is allowed. |
| 10.1 | Attack case: an instruction hidden in a reply mail never reaches a waiting process as text. |
| 10.2 | Tampered memory: a broken signature leads to quarantine and a ticket. |
| 10.3 | Rule of Two: a component may do at most two of: read untrusted input, access private data, act outside. |
| 10.4 | Three limits: origin labels for data flows, parser checks against manipulated readings, and classes that only fall in cascades. |
| 11 | Use cases and their breaking points, such as approval load at volume. |
| 14, 14.1 | Contract format: a hard core of typed criteria plus optional soft ones. 14.1 lists the criterion types and their evidence predicates. |
| 14.2 | The consistency rules K1–K8. |
| 14.3 | Test case: contradictory deadlines, caught by K1. |
| 16, 16.1 | The state machine of a node; 16.1 is the table of allowed transitions with trigger and gate. |
| 16.3 | Outcomes: met, failed, aborted; for failed and aborted G6 checks the clean-up instead of predicates. |
| 16.4 | The judgment rule U1–U4 and the fixed schema of a wall; walls are compared by codes and ids, never by wording. |
| 16.5 | Abort cascade: no new move, abort down, cancel what runs, settle outside actions, close bottom up, hand unclear actions to a person. |
| 17, 17.1 | Recursion invariants R1–R8; 17.1 shows why every run ends (G-1a to G-1c). |
| 18, 18.1 | Execution semantics; 18.1 is the append-only event log every node's state is derived from. |
| 18.3 | Late and contradictory events (E4–E6). |
| 18.4 | The gate's ledger of delivery operations and the restart (O1–O9). |
| 18.5 | Approval tokens (F1–F5). |
| 18.6 | Leases, supervision, the gate and the failure model (A1–A8): the core may fail but loses no confirmed event, the gate fails closed. |
| 19 | Strategy decision: eligible when the chance within the remaining time reaches a minimum, the cost fits and no attempt is open; points are chance times value minus cost. |
| 20, 20.1 | Learning; 20.1 is the attempt log and how success is credited (L1–L5). |
| 21 | Gate rules: fixed rule templates checked in code; the agent may add or tighten instances, never remove or loosen them. |
| 22 | Model roles: each is a move with a step contract, no tools and no keys. |
| 23 | Budget (P1–P6). |

## Terms
| term | what it means |
|---|---|
| layer 1 / layer 2 | Criteria from the client and catalog invariants / criteria the agent adds; layer 2 never closes alone (3.3). |
| evidence predicate | Per criterion type: what must be proven and which evidence proves it (B6). |
| expectation | What a waiting node wants to receive: from whom, about what, by when, with which matching keys (8.1). |
| ticket | The one way to ask a person or parent: with options, recommendation, deadline and acknowledgement (8.4). |
| wall | A refusal or failure reported in a fixed schema: criterion, cause code, optional missing precondition (16.4). |
| strategy class | The kind of strategy a diagnosed cause points to, such as proof by third parties (5.6). |
| start curve | The catalog's chance that an attempt meets its criterion within t: F0(t) = p0 · (1 − e^(−t/τ)) (19, L2). |
| start token | Burnt by every start of a round or child; bounds the starts of the whole tree (R1). |
| lesson | The signed record of what a strategy achieved in a situation, written through G4 and read through G5. |
| write gate, read gate | G4 and G5, the checks on writing to and reading from memory. |
| lease | A worker's time-limited right to run one move, with an absolute expiry (A1). |
| fencing token | Carried by every write under a lease, so a worker whose lease expired can write nothing (A4). |
| approval token | A person's one-time, expiring approval of exactly one resolved action, bound to its hash (18.5). |
| delivery operation | One approved outside action in the gate's ledger, opened as the token is consumed; it owns its attempts (18.4). |
| abort buffer, restart buffer | The time after the root deadline within which everything ends, and after a restart within which overdue deadlines are handled. |
| origin label | Own, foreign or confidential; decides which parameters a value may flow into (10.4). |

Not paper ids: `tests/pentest/` names its scenarios by pentest letter (A1–A6, C3, C4, D1–D10, E1–E6,
F1–F6, X1–X5), and F0 is the start curve.
