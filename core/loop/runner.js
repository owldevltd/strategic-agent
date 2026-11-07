// The loop of chapter 4, the same for every node at every depth: goal check (G1) and confirmation by a person at
// the gate, then strategy, plan check (G2), execution, judgment, and closing with evidence (G6). The states and
// their transitions are those of table 16.1. Start tokens bound the number of rounds and children in the whole tree
// (R1), depth is capped (R2). Every state but closing and closed has a deadline (Z2); deadline, budget and abort
// come first (Z6) and start the cascade (16.5).

app.define( 'Core.Loop.Runner',
	[ 'Core.Check.ContractCheck', 'Core.Check.PlanCheck', 'Core.Strategy.Chooser', 'Core.Node.Node', 'Core.Loop.Plan', 'Core.Budget.Pot',
		'Core.Loop.Execution', 'Core.Loop.Cascade', 'Core.Loop.WaitGraph', 'Core.Move.Causes', 'Core.Loop.Judgment', 'Core.Loop.Closing',
		'Core.Strategy.Diagnosis', 'Core.Inbound.Cases', 'Core.Lease.Supervisor', 'Lib.Hash' ],
	( ...deps ) => {
		const [ ContractCheck, PlanCheck, Chooser, Node, Plan, Pot ] = deps;
		const [ Execution, Cascade, WaitGraph, Causes, Judgment, Closing, Diagnosis, Cases, Supervisor, Hash ] = deps.slice( 6 );
		return class Runner {

			// Z2: how long planning and judging may take before a timeout fact ends them; the model's part is cut off.
			static STATE_MINUTES = { planning: 3, judging: 3 };

			constructor( options ) {
				const { gate, executor, catalog, journal, log, mission, registry } = options;
				const { planner = null, judge = null, expectations = null, supervisor = null, memory = null } = options;
				const { meta = null, learner = null, gates = null, knowledge = null, proposals = false } = options;
				const { bufferMinutes = 5, maxDepth = 5, startTokens = 20, pollMs = 500, stateMinutes = Runner.STATE_MINUTES } = options;
				Object.assign( this, { gate, executor, catalog, journal, log, mission, registry } );
				Object.assign( this, { planner, judge, expectations, supervisor, memory, meta, learner, gates, knowledge } );
				this.causes = options.causes || Causes.load();
				Object.assign( this, { bufferMinutes, maxDepth, pollMs, stateMinutes, proposals: proposals === true } );
				this.execution = new Execution( this );
				this.cascade = new Cascade( this );
				this.judgment = new Judgment( this );
				this.closing = new Closing( this );
				this.waits = new WaitGraph();
				this.costOf = strategy => Pot.strategyCost( strategy, catalog );

				this.id = options.id || app.lib( 'node:crypto' ).randomUUID().slice( 0, 8 );
				// R1: the start account of this goal's tree, in the core's store (kept across a restart).
				this.account = options.account || null;
				this.account?.open( this.id, startTokens );
				this.nodes = new Map();
				this.chooser = new Chooser();
				// G5: a learned diagnosis quarantined on reading opens a ticket on the board (no node exists yet).
				const _learned = memory?.diagnoses( mission.kind, { board: executor.board || null } ) || [];
				this.diagnosis = new Diagnosis( Diagnosis.load( mission ).causes, _learned );
			}

			// owner: the node a process of its own belongs to (a new case, a proposal); it is no child, but an abort of the
			// owner reaches it (16.5).
			async start( given, parent = null, { owner = null } = {} ) {
				// K4: a criterion no channel can prove gets a person as its channel, before the goal is proposed.
				const contract = ContractCheck.channelled( given, this.catalog, this.registry );
				const _node = new Node( { contract, parent, log: this.log } );
				this.nodes.set( _node.id, _node );
				parent?.children.push( _node );
				owner?.processes.push( _node );
				_node.emit( 'node_created', {
					contract: contract.describe(), spec: contract.canonical(), parent: parent?.id || null, depth: _node.depth,
					run: this.id, mission: this.mission.id, owner: owner?.id || null,
				} );
				return _node;
			}

			// A child runs the very same route as its parent (chapter 17). Starting it burns a start token (R1).
			async spawn( parent, spec ) {
				const [ Contract ] = await app.use( [ 'Core.Contract.Contract' ] );
				const _child = await this.start( new Contract( spec, this.registry ), parent );
				const _refused = parent.stopping ? 'the parent is being aborted (G-1a)' : this.tokensLeft() <= 0 ? 'no start tokens left (R1)'
					: !Pot.reserve( parent, _child.contract.budget, _child ) ? 'the parent cannot reserve its budget (P4)' : null;
				const _started = !_refused && this.burn( () => parent.emit( 'child_started', { child: _child.id, serves: spec.serves || null } ) );
				if ( !_started ) {
					if ( !_refused ) { Pot.release( parent, _child ); }
					this.refuse( _child, { status: 'refused', reason: _refused || 'no start tokens left (R1)' } );
					return _child;
				}
				this.waits.add( parent.id, _child.id );
				await this.run( _child );
				this.waits.remove( parent.id, _child.id );
				Pot.release( parent, _child );
				return _child;
			}

			// A goal that never became a confirmed node closes at once, with the reason (16.1: draft → closing). The result is
			// logged with the move to closing already, so a restart in between finds it (Z4).
			refuse( node, result ) {
				node.result = result;
				node.move( 'closing', { reason: result.reason || 'refused', result } );
				node.move( 'closed', { result } );
				node.emit( 'node_closed', { result } );
			}

			async run( node, { resume = false } = {} ) {
				const _timers = this._deadlines( node );
				try {
					if ( !resume || node.state === 'draft' ) {
						await this._propose( node );
					}
					while ( node.state !== 'closed' ) {
						await this._step( node );
						// Each step gives the event loop a turn, so timers, the gate and the inbound side are never starved.
						await new Promise( resolve => setImmediate( resolve ) );
					}
				} catch ( error ) {
					node.emit( 'error', { message: error.message, stack: error.stack?.split( '\n' ).slice( 1, 4 ).join( ' | ' ) } );
					await this._failed( node, error );
				} finally {
					_timers.forEach( timer => timer.clear() );
				}
				return node;
			}

			// A node's deadline starts the cascade below it even while it waits (G-1c, Z6): for the root, and for a child
			// that waits for a person or an answer past its own deadline. A criterion's own deadline lets the system observe
			// what only time can show (B5). A deadline further ahead than a timer can count is waited for in parts. → { clear }
			_deadlines( node ) {
				const _timers = node.contract.criteria.filter( item => item.deadline )
					.map( item => Supervisor.at( Date.parse( item.deadline ) + 50, () => this.watch( node, true ) ) );
				_timers.push( Supervisor.at( Date.parse( node.contract.deadline ), () => {
					if ( node.state === 'closed' || node.stopping ) { return; }
					node.emit( 'deadline_reached', { of: node.parent ? 'node' : 'goal', at: node.contract.deadline } );
					this.abort( node, { reason: `the deadline of the ${node.parent ? 'node' : 'goal'} is reached`, status: 'failed' } ).catch( app.fail );
				} ) );
				return _timers;
			}

			// 16.5, by command of the client or from the deadline and the budget.
			abort( node, options ) {
				return this.cascade.abort( node, options );
			}

			// Z6: deadline, budget and abort come before anything else a node would do.
			async _step( node ) {
				if ( !node.stopping && Date.now() > Date.parse( node.contract.deadline ) ) {
					node.emit( 'deadline_reached', { of: 'node', at: node.contract.deadline } );
					await this.abort( node, { reason: 'the deadline is reached', status: 'failed' } );
				}
				if ( !node.stopping && Pot.left( node ) < 0 ) {
					await this.abort( node, { reason: `the budget is exhausted (${node.spent} of ${node.contract.budget})`, status: 'failed' } );
				}
				if ( node.stopping && node.state !== 'closing' ) {
					// The abort came before the node closed: a decision that had not closed it yet (a person's answer a restart
					// found in the log) gives way to it (16.3).
					node.result = null;
					node.move( 'closing', { reason: node.stopping.reason } );
				}
				const _handlers = {
					confirmed: () => node.move( 'planning' ), planning: () => this._plan( node ), executing: () => this.execution.run( node ),
					judging: () => this.judgment.judge( node ), closing: () => this.closing.close( node ),
					// A node left waiting with its move still open is taken up again, so an event that came meanwhile is heard.
					waiting: () => ( node.plan?.pending ? this.execution.run( node ) : Runner.sleep( this.pollMs ) ),
				};
				await _handlers[ node.state ]();
			}

			// G1, then the person's confirmation at the gate (3.2 steps 2 to 6); the node stays a draft until then.
			async _propose( node ) {
				const _root = !node.parent;
				const _check = new ContractCheck().check( node.contract, {
					ancestors: node.ancestors(), bufferMinutes: this.bufferMinutes, parent: node.parent,
					mandatory: _root ? this.mission.invariants || [] : [], strategies: this.mission.strategies, catalog: this.catalog,
				} );
				// R5: a child that closely resembles an ancestor is a question to its parent first.
				if ( _check.ok && _check.questions?.length && node.parent && this.judgment.answerChild( node.parent, node, _check.questions ) === 'stop' ) {
					_check.ok = false;
					_check.problems.push( ..._check.questions.map( question => `${question}; the parent stopped it` ) );
				}
				node.emit( 'check', _check );
				if ( node.depth > this.maxDepth ) {
					_check.ok = false;
					_check.problems.push( `depth ${node.depth} exceeds the maximum ${this.maxDepth} (R2)` );
				}
				if ( !_check.ok ) {
					this.refuse( node, { status: 'refused', problems: _check.problems, reason: 'goal refused at G1' } );
					return;
				}
				await this.gate.propose( node.contract );
				node.emit( 'contract_proposed', { hash: node.contract.hash, rules: node.contract.rules() } );
				for ( ;; ) {
					const _contract = await this.gate.contract( node.contract.hash );
					if ( _contract?.status === 'confirmed' ) {
						node.confirmed = node.contract.hash;
						node.immutables = node.contract.immutables();
						node.move( 'confirmed', { by: _contract.confirmedBy, hash: node.contract.hash } );
						node.emit( 'contract_confirmed', { hash: node.contract.hash, by: _contract.confirmedBy } );
						return;
					}
					// 16.3 knows fulfilled, failed and aborted: a goal whose deadline passes before it was confirmed failed; one the
					// client (or the cascade from above) aborted was aborted.
					const _late = !( Date.now() < Date.parse( node.contract.deadline ) );
					if ( node.stopping || _late ) {
						const _reason = _late ? 'never confirmed before the deadline' : 'never confirmed';
						// Nobody confirms it any more: the card leaves the person's list (a gate that cannot be reached keeps it).
						await this.gate.withdrawContract?.( node.contract.hash ).catch( () => null );
						this.refuse( node, { status: node.stopping?.status || 'failed', reason: _reason } );
						return;
					}
					await Runner.sleep( this.pollMs );
				}
			}

			async _plan( node ) {
				// An open attempt is carried on, not started again (19); it burns no new start token (R1).
				if ( node.plan?.open ) {
					node.move( 'executing', { resumed: node.plan.strategy, at: node.plan.steps[ node.plan.next ]?.move || null } );
					return;
				}
				const _left = Pot.left( node );
				const { chosen: _known, scored, wall, undiagnosed } = this.choose( node, _left );
				node.emit( 'strategy_scored', { scored } );
				// 5.6: a wall the system cannot read yet goes to a person; the decision is learned for the next time.
				const chosen = _known || ( undiagnosed ? await this._diagnose( node, wall ) : null );
				if ( !chosen && _left <= 0 ) {
					// Z6: nothing is left to pay any strategy with; the budget ends the goal, no person is asked.
					await this.abort( node, { reason: `the budget is exhausted (${node.spent} of ${node.contract.budget})`, status: 'failed' } );
					return;
				}
				if ( !chosen ) {
					// Table 16.1: planning → judging when no strategy is eligible; the verdict is "escalate" (8.4: with why not).
					Object.assign( node, { stuck: true, unchosen: scored.filter( item => item.reason ) } );
					node.move( 'judging', { reason: 'no eligible strategy left' } );
					return;
				}
				if ( this.tokensLeft() <= 0 ) {
					this._noTokens( node );
					return;
				}
				const _defaults = Plan.defaults( chosen, node, this.mission );
				const _points = scored.find( item => item.id === chosen.id )?.points ?? null;
				const _filling = this.planner && !chosen.proposed
					? this.planner.fill( chosen, node, this.mission, { experience: this.experience( node ), points: _points } ) : null;
				const _slots = _filling ? await this.within( node, 'planning', _filling, _defaults ) : _defaults;
				const _plan = Plan.resolve( chosen, node, this.mission, _slots );
				const _check = this.planCheck( node, _plan, _left );
				node.emit( 'check', _check );
				const _wall = node.walls.at( -1 )?.cause || null;
				if ( !_check.ok ) {
					// 19: G2(s) = ok is part of eligibility; a strategy whose plan G2 refused is not eligible for this node, and
					// planning goes on with the next one (16.1: to judging only when no strategy is eligible).
					node.refused = new Set( [ ...( node.refused || [] ), chosen.id ] );
					node.tried.push( { strategy: chosen.id, wall: _wall, outcome: 'wall', cause: 'plan_refused' } );
					// 21: the strategy gates that refused it are named by their ids, apart from the text (Judgment.gatesOf).
					node.hitWall( 'plan_refused', [ ..._check.problems, ...this.refusing( _plan ).map( id => ( { gate: id } ) ) ] );
					return;
				}
				// Z6: planning took time; deadline, budget and abort are checked again before the start token burns.
				if ( this.due( node ) ) { return; }
				this._begin( node, chosen, _plan, { wall: _wall, cost: _check.cost } );
			}

			// Z6: deadline, budget or abort hold the node before it does anything else; price: what the next step costs,
			// which must fit what is left.
			due( node, price = 0 ) {
				return Boolean( node.stopping ) || Date.now() > Date.parse( node.contract.deadline ) || !Pot.fits( node, price );
			}

			// L2: the attempt is protocolled with the criterion it aims at and what led to its choice; 19: its review
			// (Wiedervorlage) is due after t_signal of the strategy; R1: it starts with its event, and its token burns in
			// the same step.
			_begin( node, chosen, _plan, { wall: _wall, cost } ) {
				const _criterion = Chooser.serves( node, chosen )?.id || null;
				const _trigger = node.trigger || _wall || 'start';
				node.trigger = null;
				const _protocol = { criterion: _criterion, trigger: _trigger, horizonH: this.horizon( chosen ) };
				const _attempt = this.journal.start( node, chosen, { wall: _wall }, _protocol );
				const _review = this.signalHours( chosen );
				node.plan = {
					..._plan, wall: _wall, attempt: _attempt, spentBefore: node.spent, open: true, criterion: _criterion, trigger: _trigger,
					startedAt: Date.now(), tSignalH: _review, review: _review && Date.now() + _review * 3600000, values: { ...node.seed },
				};
				this.memory?.situation( node, 'strategy', { id: chosen.id, wall: _wall } );
				if ( !this.burn( () => node.emit( 'plan_accepted', { strategy: chosen.id, attempt: _attempt, cost } ) ) ) {
					node.plan.open = false;
					this.journal.end( _attempt, { outcome: 'wall', cause: 'aborted' } );
					this._noTokens( node );
					return;
				}
				node.move( 'executing', { strategy: chosen.id, steps: _plan.steps.map( step => step.move ) } );
			}

			// t_signal(s): the time to the next decision-relevant signal; it only sets the review (19). From the strategy (null:
			// it waits for no signal, e.g. for its children), else from its moves in the catalog.
			signalHours( strategy ) {
				if ( 'tSignalH' in strategy ) { return strategy.tSignalH; }
				const _moves = ( strategy.steps || [] ).map( step => this.catalog.get( step.move ) ).filter( Boolean );
				return Math.max( 0, ..._moves.map( move => move.tSignalH || 0 ) ) || null;
			}

			// H: how long an attempt is observed, the longest horizon of its moves (L2).
			horizon( strategy ) {
				const _moves = ( strategy.steps || [] ).map( step => this.catalog.get( step.move ) ).filter( Boolean );
				return strategy.horizonH || Math.max( 0, ..._moves.map( move => move.horizonH || 0 ) ) || undefined;
			}

			// The strategy gates in force that refuse this plan at G2 (21), each checked on its own.
			refusing( plan ) {
				const _Gates = this.gates?.constructor;
				if ( typeof _Gates?.plan !== 'function' ) { return []; }
				const _active = this.gates.active( this.mission.kind ) || [];
				return _active.filter( gate => _Gates.plan( plan, [ gate ] ).length ).map( gate => gate.id );
			}

			// G2 with everything it needs: the catalog, the contract, the budget, the wait graph and the strategy gates in force.
			planCheck( node, plan, budgetLeft ) {
				const _gates = this.gates?.active( this.mission.kind ) || [];
				const _waits = { graph: this.waits, node: node.id };
				const _given = {
					catalog: this.catalog, contract: node.contract, budgetLeft, waits: _waits, strategyGates: _gates, seed: node.seed,
				};
				return new PlanCheck().check( plan, _given );
			}

			// The chooser with the diagnosis and, after "other" (U3), without the strategy that just ended. Attempts still
			// open for a criterion, also those with a provisional timeout, keep their strategy from being chosen again (19).
			choose( node, budgetLeft = Pot.left( node ) ) {
				this.journal.sweep();
				const _open = this.journal.open( node.id );
				const _options = { budgetLeft, cost: this.costOf, diagnosis: this.diagnosis, exclude: node.exclude || null, open: _open };
				return this.chooser.choose( node, this.mission.strategies, _options );
			}

			async _diagnose( node, wall ) {
				const _mine = item => Chooser.serves( node, item ) && ( !item.kind || item.kind === node.contract.spec.kind );
				const _classes = [ ...new Set( this.mission.strategies.filter( _mine ).flatMap( item => Chooser.classes( item ) ) ) ]
					.filter( item => item !== 'direct' );
				// P1: the person's minutes are booked like any cost, and only when the pot can pay them.
				if ( !_classes.length || !this.executor.board || !Pot.fits( node, Runner.DIAGNOSIS_MINUTES ) ) { return null; }
				Pot.book( node, { what: 'diagnosis ticket', humanMinutes: Runner.DIAGNOSIS_MINUTES } );
				const _answer = await this.executor.board.ask( node, {
					question: `The wall "${wall}" is new to me. Which kind of strategy answers it?`, options: [ ..._classes, 'none of them' ],
					recommendation: 'none of them', minutes: Runner.DIAGNOSIS_MINUTES,
				} );
				if ( !_classes.includes( _answer.choice ) ) { return null; }
				this.memory?.learnDiagnosis( node, { kind: this.mission.kind, cause: wall, class: _answer.choice, by: _answer.by } );
				this.diagnosis.learned.push( { cause: wall, class: _answer.choice, by: _answer.by } );
				return this.choose( node ).chosen;
			}

			// 8.1: a message that matches nothing that waits is a new case, its own process on the same route.
			newCase( message, options = {} ) {
				this.cases = this.cases || new Cases( this );
				return this.cases.start( message, options );
			}

			// The trusted code moves of the core: a proposal's check and registration (6.1), knowledge through G5 (9.1).
			trusted( name, step, ctx ) {
				if ( name === 'find' ) {
					const _found = this.knowledge?.find( step.params?.query || '', { scope: this.mission.id, board: this.executor.board, node: ctx.node } ) || [];
					const _labels = [ ...new Set( _found.flatMap( entry => entry.labels ) ) ];
					return { value: { entries: _found }, labels: _labels.length ? _labels : [ 'own' ], cohort: null, facts: [] };
				}
				return this.meta.run( name, step, ctx );
			}

			// R1: one token per start, burnt in the same transaction as the start event; without an account (a bare runner in
			// a test) every start goes ahead.
			burn( start ) {
				return this.account ? this.account.burn( this.id, start ) : ( start() || true );
			}

			tokensLeft() {
				return this.account ? this.account.left( this.id ) : Infinity;
			}

			// R1: without a start token nothing new begins; the goal fails, it is not judged done. The result travels with the
			// move to closing (Z4).
			_noTokens( node ) {
				node.result = node.result || { status: 'failed', reason: 'no start tokens left (R1)' };
				node.move( 'closing', { reason: 'no start tokens left (R1)', result: node.result } );
			}

			// Z2: the model's part of planning, judging or closing must finish within the state's deadline (closing: what is
			// left of Δ); otherwise a timeout fact is recorded and the code goes on with its own reading (the fallback). A
			// configured 0 gives the model no time at all. Z6: an abort that reaches the node meanwhile cuts the model off at
			// once; the code's reading applies, and the abort comes first at the node's next step.
			async within( node, state, promise, fallback, ms = ( this.stateMinutes[ state ] ?? 3 ) * 60000 ) {
				let _timer;
				let _watch;
				const _calm = !node.stopping;
				const _late = new Promise( ( resolve ) => {
					_timer = setTimeout( () => resolve( Runner.LATE ), ms );
					_timer.unref?.();
					if ( !_calm ) { return; }
					_watch = setInterval( () => node.stopping && resolve( Runner.STOPPED ), Math.max( 1, Math.min( this.pollMs, 100 ) ) );
					_watch.unref?.();
				} );
				const _result = await Promise.race( [ Promise.resolve( promise ).catch( () => fallback ), _late ] );
				clearTimeout( _timer );
				clearInterval( _watch );
				if ( _result === Runner.STOPPED ) {
					node.emit( 'model_cut_off', { of: state, reason: node.stopping.reason } );
					return fallback;
				}
				if ( _result !== Runner.LATE ) { return _result; }
				node.emit( 'deadline_reached', { of: state } );
				node.addFact( { kind: 'timeout', evidenceClass: 'observation', source: 'system', origin: 'system', data: { state } } );
				return fallback;
			}

			static LATE = Symbol( 'late' );
			static STOPPED = Symbol( 'stopped' );
			static DIAGNOSIS_MINUTES = 2;

			// A fact from outside for this node (E4): always into its history; it wakes a waiting node for a judgment. While
			// the node plans, executes or judges it waits in the node's queue for the next point of judgment; while it closes
			// it is only recorded; after the node closed the reply is a new case (Z5).
			deliver( node, fact ) {
				if ( node.state === 'closed' ) {
					node.emit( 'fact_after_close', { kind: fact.kind, source: fact.source } );
					return false;
				}
				if ( node.state === 'closing' ) {
					node.emit( 'fact_recorded_only', { kind: fact.kind, source: fact.source } );
					return false;
				}
				// Z4: the whole fact is logged with its id, so a restart rebuilds the queue and knows which of it was taken over.
				const _fact = fact.id ? fact : { ...fact, id: Hash.id( 'fact' ) };
				node.emit( 'fact_queued', { kind: fact.kind, source: fact.source, late: Boolean( fact.late ), state: node.state, fact: _fact } );
				node.inbox = [ ...( node.inbox || [] ), _fact ];
				// E4: a late fact moves only a waiting node, into its judgment; whatever it makes unnecessary, the judgment
				// takes back (E6).
				if ( node.state === 'waiting' ) { node.wake( _fact ); }
				return true;
			}

			// E3: the queue is taken over at the points where the node may judge.
			drain( node ) {
				const _queued = node.inbox || [];
				node.inbox = [];
				// B5: what the system observed itself keeps its time (e.g. "no contradiction until the deadline"); a fact from
				// outside always gets the time it arrived.
				_queued.forEach( fact => node.addFact( fact, { at: fact.origin === 'system' ? fact.time ?? null : null } ) );
				this.book( node );
				return _queued.length;
			}

			// L4: what a node credited goes into the journal of the attempt it belongs to, also when that attempt has
			// already ended (a late effect, L5); only credit within the criterion's deadline counts.
			book( node ) {
				for ( const credit of Object.values( node.credited || {} ) ) {
					if ( credit.booked || !credit.attempt || !credit.inTime ) { continue; }
					credit.booked = true;
					this.journal.credit( credit.attempt, credit.criterion );
				}
			}

			// B5: what only time shows, the system observes itself, e.g. that no contradiction came in until a deadline.
			watch( node, deliver = false ) {
				for ( const item of node.contract.criteria.filter( entry => typeof entry.observe === 'function' ) ) {
					const _fact = item.observe( node.valid(), Date.now() );
					const _same = fact => fact.kind === _fact?.kind && JSON.stringify( fact.data ) === JSON.stringify( _fact?.data );
					const _known = _fact && node.facts.some( _same );
					if ( !_fact || _known ) { continue; }
					const _observed = { evidenceClass: 'observation', source: 'system', origin: 'system', ..._fact };
					if ( deliver ) { this.deliver( node, _observed ); } else { node.addFact( _observed, { at: _observed.time ?? null } ); }
				}
			}

			codeJudge() {
				if ( !this._ownJudge ) {
					this._ownJudge = new ( app.get( 'Core.Loop.Judge' ) )( { registry: this.registry, causes: this.causes } );
				}
				return this._ownJudge;
			}

			experience( node ) {
				return this.closing.experience( node );
			}

			afterChild( node, precondition, child ) {
				return this.judgment.afterChild( node, precondition, child );
			}

			// A child's goal (Core.Contract.Contract.child), with half of what the parent has left unless it names a budget.
			static childSpec( parent, { id, goal, criteria, serves, budget = null, value = null }, bufferMinutes = 5 ) {
				const _budget = budget ?? Math.max( 1, Pot.left( parent ) / 2 );
				return app.get( 'Core.Contract.Contract' ).child( parent.contract, { id, goal, criteria, serves, budget: _budget, value }, bufferMinutes );
			}

			// 18.6: an error in the core is treated like a system gate: abort, close, alarm (Closing.failed).
			_failed( node, error ) {
				return this.closing.failed( node, error );
			}

			static sleep( ms ) {
				return new Promise( resolve => setTimeout( resolve, ms ) );
			}

		};
	} );
