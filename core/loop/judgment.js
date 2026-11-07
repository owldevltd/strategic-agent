// The judgment of a node (4.2, 16.4): done, another way, deeper with a child, or escalate. The judge proposes, the
// rules U1 to U4 decide. An attempt that is still open (it waits, or has moves left) is not judged anew: it
// continues (19: an open attempt is not chosen again, it is carried on). A child's escalation goes up to its
// parent (8.4), the root's to a person.

app.define( 'Core.Loop.Judgment', [ 'Core.Budget.Pot', 'Core.Check.CloseCheck', 'Core.Check.FactCheck', 'Core.Loop.Judge' ], ( Pot, CloseCheck, FactCheck, Judge ) => class Judgment {

	static ESCALATION_MINUTES = 2;

	constructor( runner ) {
		this.runner = runner;
	}

	async judge( node ) {
		const r = this.runner;
		r.drain( node );
		// A goal a person closed stays closed (a restart found the answer in the log); a fact that came after the answer
		// is recorded only.
		if ( node.result && node.result.status !== 'fulfilled' && !node.stopping ) {
			node.move( 'closing', { reason: node.result.reason, result: node.result } );
			return;
		}
		r.watch( node );
		await this._contested( node );
		if ( node.plan?.open && !node.stopping && node.plan.reviewDue ) {
			return this._review( node );
		}
		if ( node.plan?.open && !node.stopping ) {
			return this._continue( node );
		}
		const _judge = r.judge || r.codeJudge();
		// "Other" (U3) means another strategy than the one that just ended.
		node.exclude = node.tried.at( -1 )?.strategy || null;
		const { scored } = r.choose( node );
		const _alternatives = this._alternatives( node, scored );
		if ( node.stuck && await this.propose( node ) ) {
			return;
		}
		// Stuck: no strategy is eligible, so the rules can only say "escalate" or "deeper"; the judge is still asked, for
		// the wall's suggestion and a possible change of the goal for the client (16.4, 3.2).
		// Z2: the judge's model is cut off at the deadline of judging (or by an abort); the code's reading then applies.
		const _asked = { alternatives: node.stuck ? [] : _alternatives, bound: promise => r.within( node, 'judging', promise, null ) };
		const _decided = node.stuck && !r.judge ? Judgment.stuck( node ) : await _judge.judge( node, _asked );
		node.amendment = _decided.amendment || null;
		node.stuck = false;
		// Z6: an abort that came while the node judged comes first; the runner's next step closes it.
		if ( node.stopping ) { return; }
		Pot.reallocate( node );
		if ( _decided.verdict === 'done' ) {
			node.move( 'closing' );
		} else if ( _decided.verdict === 'other' ) {
			node.move( 'planning' );
		} else if ( _decided.verdict === 'deeper' ) {
			await this.deeper( node, _decided.precondition );
		} else {
			await this.escalate( node );
		}
	}

	// The eligible strategies, and a new proposal once per wall while a planner can write one. It is shown to the judge
	// as a way, but it is no eligible strategy: it never counts for U3 (virtual).
	_alternatives( node, scored ) {
		const _wall = node.walls.at( -1 )?.cause || 'none';
		const _canPropose = this.runner.planner && !node.proposals?.has( _wall );
		return _canPropose ? [ ...scored, { id: 'a new proposal', points: 1, reason: null, virtual: true } ] : scored;
	}

	// U4, E5: contradicting facts or a criterion no fact can meet any more go to a person, also while an attempt is
	// open; what the attempt still has open is taken back first, then the judgment escalates.
	async _contested( node ) {
		if ( !node.plan?.open || node.stopping ) { return; }
		const _conflict = node.conflicts().length > 0;
		if ( !_conflict && !node.contract.check( node.valid() ).some( item => item.impossible ) ) { return; }
		const _cause = _conflict ? 'conflict' : 'unachievable';
		await this.runner.execution.cancel( node, 'contradicting facts or an unreachable criterion need a person' );
		node.hitWall( _cause, [], { reason: 'the open attempt ends; a person decides' } );
		this.runner.execution.close( node, 'wall', _cause );
	}

	// The open attempt goes on (or the goal is already proven, U1, and closes; what is still open is cancelled there).
	_continue( node ) {
		const _done = new CloseCheck().check( node ).results.filter( item => item.kind === 'outcome' ).every( item => item.met );
		const _verdict = _done ? { verdict: 'done', rule: 'U1' } : { verdict: 'continue', rule: 'open attempt (19)' };
		node.emit( 'verdict', { proposed: null, ..._verdict, overruled: false, open: node.openOutcomes().map( item => item.id ), next: _verdict.verdict } );
		node.move( _done ? 'closing' : 'planning', { continue: node.plan.strategy } );
	}

	// The review of an open attempt (Wiedervorlage, 19). Early signals may end a strategy but never confirm it (5.5):
	// without a signal from its origin since the previous review the strategy is dead for this case, the attempt ends
	// provisionally as a timeout and another one is chosen; with one it goes on until its next review, and only the
	// criteria confirm.
	async _review( node ) {
		const r = this.runner;
		const _plan = node.plan;
		_plan.reviewDue = false;
		const _signal = Judgment.signalled( node, r.journal.get( _plan.attempt )?.signalAt );
		_plan.reviewedAt = Date.now();
		if ( _signal ) {
			_plan.review = Date.now() + _plan.tSignalH * 3600000;
			const _verdict = { verdict: 'continue', rule: 'a signal does not confirm (5.5)' };
			node.emit( 'verdict', { proposed: null, ..._verdict, overruled: false, open: node.openOutcomes().map( item => item.id ), next: 'continue' } );
			node.move( 'planning', { continue: _plan.strategy, review: new Date( _plan.review ).toISOString() } );
			return;
		}
		await r.execution.cancel( node, 'no signal by the review' );
		node.hitWall( 'no_reaction', [ `no signal within t_signal (${_plan.tSignalH} h)` ], { reason: 'no signal by the review' } );
		r.execution.close( node, 'wall', 'no_reaction' );
		const _verdict = { verdict: 'other', rule: 'no signal by the review (5.5, 19)' };
		node.emit( 'verdict', { proposed: null, ..._verdict, overruled: false, open: node.openOutcomes().map( item => item.id ), next: 'other' } );
		node.exclude = _plan.strategy;
		node.trigger = 'review';
		node.move( 'planning', { review: _plan.strategy } );
	}

	// A signal of the attempt since its previous review: the journal's first signal (before any review), or an answer to
	// one of its expectations that came in after the previous review.
	static signalled( node, first ) {
		const _plan = node.plan;
		if ( _plan.reviewedAt === undefined ) { return Boolean( first ); }
		const _answers = node.facts.filter( fact => fact.attempt === _plan.attempt && fact.data?.expectation );
		return _answers.some( fact => Date.parse( fact.time ) > _plan.reviewedAt );
	}

	// 6.1, 19: a proposal for the catalog runs as its own process on the same route; the node that asked for it is
	// its client and waits for it (an edge of the wait graph, R4). Starting it burns a start token (R1). A node that has
	// nothing left to give a process starts none (P4).
	async process( node, kind, body ) {
		const r = this.runner;
		// A process whose budget cannot pay even the cheapest way to settle it would only end stuck at a person (6.1).
		const _ways = r.mission.strategies.filter( item => item.kind === 'meta' ).map( item => r.costOf( item ) );
		if ( !( Math.min( 4, Pot.left( node ) ) > 0 ) || !( Math.min( 4, Pot.left( node ) ) >= Math.min( ..._ways ) ) ) { return null; }
		const [ Contract, Proposals ] = await app.use( [ 'Core.Contract.Contract', 'Core.Meta.Proposals' ] );
		const _version = r.meta.submit( kind, body, { mission: r.mission.id, by: node.id } );
		const _buffer = Math.max( 10, r.bufferMinutes * 2 ) * 60000;
		const _deadline = new Date( Date.parse( node.contract.deadline ) - _buffer ).toISOString();
		const _given = { parent: node, deadline: _deadline, budget: Math.min( 4, Pot.left( node ) ) };
		const _spec = Proposals.contract( kind, body, _version, _given );
		_spec.criteria.push( ...node.contract.invariants().map( app.get( 'Core.Contract.Contract' ).inherited ) );
		if ( r.tokensLeft() <= 0 || !Pot.reserve( node, _spec.budget ) ) { return null; }
		const _process = await r.start( new Contract( _spec, r.registry ), null, { owner: node } );
		if ( !r.burn( () => node.emit( 'process_started', { process: _process.id, kind, version: _version, id: body.id || body.type } ) ) ) {
			Pot.release( node, _process );
			r.refuse( _process, { status: 'refused', reason: 'no start tokens left (R1)' } );
			return _process;
		}
		r.waits.add( node.id, _process.id );
		try {
			await r.run( _process );
		} finally {
			r.waits.remove( node.id, _process.id );
			Pot.release( node, _process );
		}
		node.emit( 'process_ended', { process: _process.id, kind, result: _process.result?.status || null } );
		return _process;
	}

	// 19: only when no known strategy is eligible, the model proposes a new one, once per wall. The proposal runs as its
	// own process (6.1): checked by trusted code, approved by a person, put into the catalog; this node waits for it and
	// then plans again. A goal about the catalog itself proposes nothing.
	async propose( node ) {
		const r = this.runner;
		const _wall = node.walls.at( -1 )?.cause || 'none';
		node.proposals = node.proposals || new Set();
		if ( !r.planner || !r.meta || node.contract.spec.kind === 'meta' || node.proposals.has( _wall ) ) { return false; }
		node.proposals.add( _wall );
		const _id = `proposed-${r.meta.count() + 1}`;
		// The class follows the diagnosis of the wall (5.6); "*" stands for any other way.
		const _hypotheses = node.walls.length ? r.diagnosis.of( _wall ) || [] : [];
		const _classes = _hypotheses.length ? [ ...new Set( _hypotheses.map( item => ( item.class === '*' ? 'other' : item.class ) ) ) ] : [ 'direct' ];
		const _proposed = await r.within( node, 'judging', r.planner.propose( node, { id: _id, classes: _classes, needs: r.proposals } ), null );
		if ( !_proposed ) { return false; }
		const { needs: _needs = null, ..._strategy } = _proposed;
		const _open = node.openOutcomes().map( item => item.id );
		node.emit( 'verdict', { proposed: null, verdict: 'other', rule: 'a new strategy as its own process (6.1, 19)', overruled: false, open: _open, next: 'other' } );
		node.move( 'planning', { proposal: _id } );
		node.move( 'executing', { process: 'proposal' } );
		node.toWaiting( { for: 'a proposal process', proposal: _id }, { why: 'a proposal process' } );
		// What the strategy needs at the gate first: the operator decides it there (AGENCY_PROPOSALS).
		const _ready = !_needs || await r.meta.gateSetUp( node, _needs, r );
		const _process = _ready ? await this.process( node, 'strategy', _strategy ) : null;
		if ( node.state === 'waiting' ) { node.move( 'judging', { event: 'process_ended', result: _process?.result?.status || null } ); }
		if ( _process?.result?.status !== 'fulfilled' ) { return false; }
		node.stuck = false;
		node.move( 'planning', { proposal: _id, approved: true } );
		return true;
	}

	static stuck( node ) {
		const _decided = { verdict: 'escalate', rule: 'U4', overruled: false };
		const _open = node.openOutcomes().map( item => item.id );
		node.emit( 'verdict', { proposed: null, ..._decided, open: _open, reason: 'no eligible strategy left' } );
		return _decided;
	}

	// U2: a missing precondition becomes a child on the very same route; once it is met, the strategies that stopped at
	// it may run again.
	async deeper( node, precondition ) {
		const r = this.runner;
		const _spec = r.constructor.childSpec( node, {
			id: precondition.id,
			goal: `Precondition ${precondition.id} for ${precondition.serves}`,
			// The parent is the child's client: the precondition is the child's own outcome (chapter 17).
			criteria: [ { id: 'c1', type: precondition.type, values: precondition.values || {}, origin: 'client' } ],
			serves: { criterion: precondition.serves, precondition: precondition.id },
		}, r.bufferMinutes );
		node.move( 'planning', { deeper: precondition.id } );
		node.move( 'executing', { child: precondition.id } );
		node.toWaiting( { for: 'a child', precondition: precondition.id }, { why: 'a child' } );
		const _child = await r.spawn( node, _spec );
		if ( node.state === 'waiting' ) { node.move( 'judging', { event: 'child_ended' } ); }
		this.afterChild( node, precondition, _child );
	}

	// What a child for a precondition brought back (R7): met, so the strategies that stopped there may run again; or not
	// met, which is a wall of its own.
	afterChild( node, precondition, child ) {
		if ( child.result?.status === 'fulfilled' ) {
			// B3: the parent's fact is never stronger than the child's evidence for it; B2, R7: and valid no longer than it.
			const _ids = child.contract.check( child.valid() ).flatMap( item => item.evidence || [] );
			const _evidence = child.facts.filter( fact => _ids.includes( fact.id ) );
			const _class = FactCheck.lowest( _evidence.map( fact => fact.evidenceClass ) );
			const _until = _evidence.map( fact => fact.validUntil ).filter( Boolean ).sort()[ 0 ] || null;
			node.addFact( { kind: 'precondition_met', evidenceClass: _class, source: `child ${child.id}`, data: { id: precondition.id }, validUntil: _until } );
			node.tried = node.tried.filter( item => item.cause !== 'precondition_missing' );
			// The strategy that stopped at the precondition may run again (R7); only the one before it counts as just tried.
			node.exclude = node.tried.at( -1 )?.strategy || null;
			if ( node.state === 'judging' ) { node.move( 'planning' ); }
			return;
		}
		node.preconditionsTried = new Set( [ ...( node.preconditionsTried || [] ), precondition.id ] );
		node.hitWall( 'child_failed', [ { id: child.id, status: child.result?.status, gates: Judgment.gatesOf( child ) } ], { precondition } );
	}

	// 3.2: only the client changes a confirmed contract, by ticket. The amended contract passes G1 again, including
	// G-10 (no immutable criterion changes), and a person confirms it at the gate like any goal; then it replaces
	// the old one, and plans made for the old one are void (G2 binds a plan to the hash of its contract). A change that
	// makes no contract at all (it names a criterion the contract does not have) is refused like any other at G1.
	async amend( node, change, { by } ) {
		const r = this.runner;
		const [ Contract, ContractCheck ] = await app.use( [ 'Core.Contract.Contract', 'Core.Check.ContractCheck' ] );
		let _amended;
		try {
			_amended = new Contract( node.contract.amend( change ), r.registry );
		} catch ( error ) {
			node.emit( 'check', { gate: 'G1', ok: false, problems: [ error.message ], amendment: true } );
			node.emit( 'amendment_refused', { change, problems: [ error.message ] } );
			return false;
		}
		const _check = new ContractCheck().check( _amended, {
			ancestors: node.ancestors(), bufferMinutes: r.bufferMinutes, parent: node.parent,
			mandatory: node.parent ? [] : r.mission.invariants || [], strategies: r.mission.strategies, catalog: r.catalog,
		} );
		const _problems = [ ..._check.problems, ...ContractCheck.amendment( node.contract, _amended ) ];
		node.emit( 'check', { gate: 'G1', ok: !_problems.length, problems: _problems, amendment: true } );
		if ( _problems.length ) {
			node.emit( 'amendment_refused', { change, problems: _problems } );
			return false;
		}
		await r.gate.propose( _amended );
		node.emit( 'contract_proposed', { hash: _amended.hash, rules: _amended.rules(), amends: node.contract.hash } );
		for ( ;; ) {
			if ( ( await r.gate.contract( _amended.hash ) )?.status === 'confirmed' ) { break; }
			if ( node.stopping || Date.now() > Date.parse( _amended.deadline ) ) { return false; }
			await Judgment.sleep( r.pollMs );
		}
		const _from = node.contract.hash;
		node.contract = _amended;
		node.confirmed = _amended.hash;
		// Z4: the amended contract's whole spec is logged, so a restart rebuilds the node with it, not with the old one.
		node.emit( 'contract_amended', { from: _from, to: _amended.hash, change, by, spec: _amended.canonical() } );
		return true;
	}

	// R5: a child that closely resembles an ancestor asks its parent. The parent answers from what it knows: go on when
	// the child expresses exactly a precondition the parent named itself, or a narrower part of the criterion it serves
	// (one invoice of two: R6); anything else is a rewording.
	answerChild( parent, child, questions ) {
		const _named = parent.walls.some( wall => wall.precondition?.id && wall.precondition.id === child.contract.serves?.precondition );
		const _served = ( parent.contract.criteria || [] ).find( item => item.id === child.contract.serves?.criterion );
		const _own = typeof child.contract.outcomes === 'function' ? child.contract.outcomes() : [];
		const _narrower = app.get( 'Core.Check.ContractCheck' ).narrower;
		const _part = Boolean( _served ) && _own.length > 0 && _own.every( item => _narrower( item, _served ) );
		const _answer = _named || _part ? 'go on' : 'stop';
		parent.emit( 'question_from_child', { child: child.id, questions, answer: _answer } );
		child.emit( 'answer_from_parent', { parent: parent.id, answer: _answer } );
		return _answer;
	}

	// U4: a person decides. "Once more" clears the tried strategies a single time; otherwise the goal closes. An open
	// conflict (E5) offers the values that disagree. A fact for the waiting node (E4) withdraws the question, and the
	// node judges again: the fact may have proven the goal. An answer that came first stands.
	async escalate( node ) {
		const _board = this.runner.executor.board;
		const _wall = Judge.wall( node );
		if ( node.parent ) {
			return this._toParent( node, _wall );
		}
		// 6.1: a proposal the person declined is decided; its process closes without asking that person again.
		if ( node.contract.spec?.kind === 'meta' && _wall?.cause === 'rejected_by_person' ) {
			node.result = { status: 'failed', reason: 'the person declined the proposal (6.1)', wall: 'rejected_by_person' };
			node.move( 'closing', { reason: node.result.reason, result: node.result } );
			return null;
		}
		if ( !_board ) {
			node.result = { status: 'failed', reason: 'stuck, nobody to ask', wall: _wall?.cause || null };
			node.move( 'closing', { reason: node.result.reason, result: node.result } );
			return null;
		}
		const _values = Judgment.disputed( node );
		node.move( 'waiting', { for: 'a person', why: 'escalated' } );
		node.waitingOn = { why: 'an escalation' };
		// The event loop gets a turn first, so what arrives right with the escalation (an abort, a fact) is heard before
		// a person can answer.
		await new Promise( resolve => setImmediate( resolve ) );
		this._booked( node, 'escalation ticket', Judgment.ESCALATION_MINUTES );
		const _asked = _board.ask( node, this._ticket( node, _wall, _values ) ).then( answer => ( { answer } ) );
		const _woken = node.nextEvent().then( event => ( { event } ) );
		// What came before the node began to wait wakes it as well: a queued fact (E4), an abort (Z6).
		if ( node.stopping ) {
			node.wake( { kind: 'abort_received', priority: true } );
		} else if ( node.inbox?.length ) {
			node.wake( { kind: 'queued' } );
		}
		const { answer: _answer, event: _event } = await Promise.race( [ _asked, _woken ] );
		if ( _event ) {
			_board.withdraw( [ node.id ], { reason: 'cancelled' } );
			_asked.catch( () => {} );
			// Z6: an abort comes first, the node closes; any other event sends it to its judgment (E4).
			if ( node.state === 'waiting' && node.stopping ) { return Judgment._aborted( node ); }
			if ( node.state === 'waiting' ) { node.move( 'judging', { event: _event.kind || 'event' } ); }
			return null;
		}
		if ( node.state !== 'waiting' ) { return null; }
		if ( node.stopping ) { return Judgment._aborted( node ); }
		// Z4: an answer that closes the goal is logged with its result, so a restart keeps the person's decision.
		const _closes = !Judgment.GOING_ON.includes( _answer.choice ) && !_values.some( item => item.option === _answer.choice );
		const _result = _closes ? Judgment.closed( _answer, _wall ) : null;
		node.move( 'judging', { answered: _answer.choice || 'withdrawn', ...( _result ? { result: _result } : {} ) } );
		await this._answered( node, _answer, { wall: _wall, values: _values } );
		return null;
	}

	static GOING_ON = [ 'change the goal as suggested', 'lift these gates and try once more', 'try once more' ];
	static NOT_CANDIDATES = [ 'serves no open outcome', 'meant for another depth', 'meant for another kind of goal', 'meant for another concern' ];

	static closed( answer, wall ) {
		return { status: 'failed', reason: `closed by ${answer.by} after escalation`, wall: wall?.cause || null };
	}

	// An abort reached the escalated node before a person decided: it closes as the abort says (16.3).
	static _aborted( node ) {
		node.move( 'closing', { reason: node.stopping.reason } );
		return null;
	}

	// The escalation ticket: the wall or the gates that paralyse the node, and what the person may choose.
	_ticket( node, wall, values ) {
		const _gates = this.paralysis( node );
		// Only a person lifts a strategy gate (21); the agent never can. It is no advice once a person refused the action.
		// U4: like "try once more", lifting and trying again is offered a single time; a lift that did not help is no way.
		const _lift = node.blockingGates?.length && this.runner.gates && !node.retried ? [ 'lift these gates and try once more' ] : [];
		const _refused = node.walls.some( item => item.cause === 'rejected_by_person' );
		// A precondition tried as a child and not met is no gate that is too strict: lifting it would let the move run
		// without what it needs (paying a supplier nobody verified). A person may still lift it; it is not advised.
		const _unmet = node.walls.some( item => item.cause === 'child_failed' && item.precondition );
		// 3.2: a suggested change of the goal is the client's to make, here by ticket.
		const _change = node.amendment ? [ 'change the goal as suggested' ] : [];
		const _retry = node.retried ? [] : [ 'try once more' ];
		const _suggested = node.amendment ? ` Suggested change of the goal: ${JSON.stringify( node.amendment )}.` : '';
		// 8.4: the reason, not only the dead end: why each strategy for this goal was not taken (codes of the chooser);
		// strategies meant for another goal, depth or concern were never candidates and are left out.
		const _mine = ( node.unchosen || [] ).filter( item => !Judgment.NOT_CANDIDATES.includes( item.reason ) );
		const _why = _mine.length ? ` No strategy fits: ${_mine.slice( 0, 8 ).map( item => `${item.id} (${item.reason})` ).join( '; ' ).slice( 0, 600 )}.` : '';
		return {
			question: ( _gates.length
				? `Check the gates: no strategy for "${node.contract.goal}" passes the strategy gates of the agent: ${_gates.join( '; ' )}.${_unmet ? ' A precondition was tried and is not met.' : ''} What now?`
				: `Stuck on "${node.contract.goal}": ${wall ? `${wall.cause}, ${wall.reason}` : 'no way forward'}.${_why} What now?` ) + _suggested,
			options: [ ...values.map( item => item.option ), ..._change, ..._lift, ..._retry, 'close as failed' ],
			// Paralysed by the agent's own strategy gates: the recommendation is to lift them (only a person can).
			recommendation: _lift.length && !_refused && !_unmet ? _lift[ 0 ] : 'close as failed', deadline: node.contract.deadline,
			kind: 'escalation', reason: wall?.cause || 'no eligible strategy',
		};
	}

	// What the person chose: a value of the conflict, a changed goal, lifted gates, once more, or the end. An abort that
	// came before the choice was applied comes first (Z6).
	async _answered( node, answer, { wall, values } ) {
		if ( node.stopping ) {
			Judgment._aborted( node );
			return;
		}
		const _value = values.find( item => item.option === answer.choice );
		if ( _value ) {
			// E5: the person's value settles the conflict; the node judges again on it.
			node.resolveConflict( _value.about, _value.value, answer.by );
			return;
		}
		if ( answer.choice === 'change the goal as suggested' && await this.amend( node, node.amendment, { by: answer.by } ) ) {
			// A changed goal voids the old attempts as well as the plans G2 refused for it.
			Object.assign( node, { amendment: null, tried: [], refused: new Set(), exclude: null } );
			node.move( 'planning', { reason: `${answer.by} changed the goal` } );
			return;
		}
		if ( answer.choice === 'lift these gates and try once more' ) {
			node.blockingGates.forEach( id => this.runner.gates.lift( id, { by: answer.by } ) );
		}
		if ( [ 'try once more', 'lift these gates and try once more' ].includes( answer.choice ) ) {
			Object.assign( node, { retried: true, tried: [], exclude: null, refused: new Set() } );
			node.move( 'planning', { reason: `${answer.by} asked to try once more` } );
			return;
		}
		node.result = Judgment.closed( answer, wall );
		node.move( 'closing', { reason: 'escalated', result: node.result } );
	}

	// P1: a person must still be asked, but the pot is never overspent for it: the ticket's minutes are booked up to what
	// is left, and a shortfall is logged.
	_booked( node, what, minutes ) {
		const _booked = Pot.round( Math.min( minutes, Math.max( 0, Pot.left( node ) ) ) );
		Pot.book( node, { what, humanMinutes: _booked } );
		if ( _booked < minutes ) { node.emit( 'budget_shortfall', { what, minutes, booked: _booked } ); }
	}

	// E5: the values of the first open conflict, each an option for the person (only when the node can settle it).
	static disputed( node ) {
		const [ _conflict ] = node.conflicts?.() || [];
		if ( !_conflict || typeof node.resolveConflict !== 'function' ) { return []; }
		const { about, of: _kind } = _conflict.data || {};
		const _facts = node.valid().filter( fact => fact.kind === _kind && fact.data?.about === about && 'value' in fact.data );
		const _values = new Map( _facts.map( fact => [ String( JSON.stringify( fact.data.value ) ), fact.data.value ] ) );
		return [ ..._values ].map( ( [ text, value ] ) => ( { option: `take ${text} for ${String( about )}`, about, value } ) );
	}

	// 8.4: a child's ticket goes one level up, with the strategy gates that stopped it (21). The parent answers it with
	// its own judgment: the child stops, and the parent judges the failed precondition (another way, or its own
	// escalation with "check the gates", and so on up to the root). The ticket and its receipt are history of both.
	_toParent( node, wall ) {
		const _gates = this.paralysis( node );
		const _board = this.runner.executor.board;
		const _question = `No way forward for the precondition of "${node.contract.goal}"${_gates.length ? `; blocked by ${_gates.join( '; ' )}` : ''}.`;
		_board?.ask( node, {
			question: _question, options: [ 'stop' ], recommendation: 'stop', to: 'parent', kind: 'escalation', reason: wall?.cause || null, minutes: 0,
		} ).catch( app.fail );
		const _ticket = _board?.list().find( item => item.from === node.id && item.to === 'parent' );
		if ( _ticket ) { _board.answer( _ticket.id, { choice: 'stop', by: `node ${node.parent.id}` } ); }
		node.emit( 'ticket_to_parent', { parent: node.parent.id, wall: wall?.cause || null, question: _question, gates: node.blockingGates || [] } );
		node.parent.emit( 'ticket_from_child', { child: node.id, wall: wall?.cause || null, answer: 'stop; the parent judges the precondition' } );
		node.result = { status: 'failed', reason: 'escalated to the parent node', wall: wall?.cause || null };
		node.move( 'closing', { reason: node.result.reason, result: node.result } );
		return null;
	}

	// Paralysis (21): no strategy is eligible any more because of strategy gates. → the blocking instances, each with
	// what it stopped: plans refused at G2, moves blocked before they ran, and the agent's own stricter rules.
	paralysis( node ) {
		const _agent = node.contract.criteria.filter( item => item.origin === 'agent' ).map( item => item.id );
		const _texts = Judgment._blocked( node );
		const _gates = Judgment.gatesOf( node );
		const _rules = _texts.filter( text => _agent.some( id => String( text ).includes( `(${id})` ) ) );
		const _blocking = [ ..._gates.map( id => `strategy gate ${id}` ), ...new Set( _rules ) ];
		if ( _blocking.length ) {
			node.emit( 'gates_paralysis', { blocking: _blocking, gates: _gates } );
		}
		node.blockingGates = _gates;
		return _blocking;
	}

	static _blocked( node ) {
		return node.walls.filter( wall => [ 'plan_refused', 'precondition_missing', 'child_failed' ].includes( wall.cause ) )
			.flatMap( wall => [ wall.reason, ...( wall.detail || [] ).map( item => ( typeof item === 'string' ? item : JSON.stringify( item ) ) ) ] );
	}

	// The strategy gates that stopped this node, and those a failed child reported with its wall (they block the parent's
	// way just the same, and only a person lifts them). Only a gate id in the structured detail of a wall names a gate:
	// text a wall picked up from outside (a document, a script) names none.
	static gatesOf( node ) {
		const _walls = node.walls.filter( wall => [ 'plan_refused', 'precondition_missing', 'child_failed' ].includes( wall.cause ) );
		const _details = _walls.flatMap( wall => ( Array.isArray( wall.detail ) ? wall.detail : [] ) )
			.filter( item => item && typeof item === 'object' );
		const _listed = _details.flatMap( item => ( Array.isArray( item.gates ) ? item.gates : [] ) );
		const _ids = [ ..._details.map( item => item.gate ), ..._listed ];
		return [ ...new Set( _ids.filter( id => typeof id === 'string' && /^sg-[0-9a-f]+$/.test( id ) ) ) ];
	}

	static sleep( ms ) {
		return new Promise( resolve => setTimeout( resolve, ms ) );
	}

} );
