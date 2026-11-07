// Executing one checked plan for one node (chapter 4, step "act"): move by move, each in its own lease, each booked in
// the pot. A move that leaves something open (a ticket, an expectation, an approval, a child) puts the node into
// "waiting"; only this node waits. When the awaited thing arrives, or any other event for the node, the node goes
// to its judgment (16.1, E4); the attempt stays open and continues from where it stood once the judgment says so. A
// move that is still running when an event comes in keeps running and is taken up again. While the node waits for
// a signal from outside, the review of the attempt (Wiedervorlage, t_signal after its start, chapter 19) is such an
// event as well. What a move found out reaches the node as a fact through G3. Gate refusals, failures and walls
// reported by trusted code end the attempt as a wall; a timeout ends it provisionally (B8, 20 L5).

app.define( 'Core.Loop.Execution', [ 'Core.Budget.Pot', 'Core.Check.FactCheck', 'Core.Lease.Supervisor' ], ( Pot, FactCheck, Supervisor ) => class Execution {

	static WAITING = [ 'human', 'wait', 'child' ];
	// Moves that wait for a signal from outside: the review of the attempt applies to them (5.5, 19).
	static SIGNAL = [ 'human', 'wait' ];

	constructor( runner ) {
		this.runner = runner;
	}

	async run( node ) {
		const _plan = node.plan;
		_plan.values = _plan.values || {};
		_plan.next = _plan.next || 0;
		while ( _plan.next < _plan.steps.length ) {
			if ( node.stopping ) {
				return this.end( node, 'wall', 'aborted' );
			}
			// Z6: no move starts after the node's deadline or with its budget spent; the next step aborts the node.
			if ( !_plan.pending && this.runner.due( node ) ) { return null; }
			const _step = _plan.steps[ _plan.next ];
			const _move = this.runner.catalog.get( _step.move );
			if ( !_plan.pending && await this._unpaid( node, _step, _move ) ) { return null; }
			if ( !_plan.pending ) {
				// 7.3: a strategy gate blocks the move; the judgment sees the precondition it names (U2).
				const _blocked = this._blocked( node, _step );
				if ( _blocked ) { return this.end( node, 'wall', 'precondition_missing' ); }
				_plan.pending = { index: _plan.next, began: Date.now(), promise: this._start( node, _step, _move ) };
				node.emit( 'move_started', { move: _step.move, index: _plan.next } );
			}
			this._waits( node, _step, _move );
			// E1 compares with the version at which the wait began; a move that begins to wait for an approval later sets it
			// again (_start), so its own transition is no reason to skip the judgment.
			_plan.waitVersion = node.version;
			const _ended = _plan.pending.promise.then( result => ( { result } ) );
			const _review = this._review( node, _move );
			const _event = node.nextEvent().then( event => ( { event } ) );
			// E4: a fact queued before the node began to wait wakes it as well.
			Execution.queued( node );
			const _next = await Promise.race( [ _ended, _event, _review.due ] );
			_review.clear();
			if ( _next.review ) {
				_plan.reviewDue = true;
				node.emit( 'review_due', { strategy: _plan.strategy, attempt: _plan.attempt, afterH: _plan.tSignalH } );
				this._judgeNow( node, { event: 'review_due' }, _plan.waitVersion );
				return null;
			}
			if ( _next.event ) {
				// An event for the waiting node: it is judged now; the move it waits for stays open.
				this._judgeNow( node, { event: _next.event.kind || 'event' }, _plan.waitVersion );
				return null;
			}
			const _finished = await this._finish( node, _step, _move, _next.result );
			if ( _finished ) { return _finished; }
		}
		return this.end( node, 'done', null );
	}

	// The move leaves something open (16.1 executing → waiting). Taken up again after a judgment, an action still waiting
	// for its approval waits again.
	_waits( node, step, move ) {
		if ( Execution.WAITING.includes( move.executor ) ) {
			const _for = { human: 'a person', wait: 'an answer', child: 'a child' }[ move.executor ];
			node.toWaiting( { for: _for, move: step.move }, { move: step.move, reversible: Boolean( move.reversible ) } );
		} else if ( node.plan.pending?.approval ) {
			node.toWaiting( { approval: node.plan.pending.approval, move: step.move }, { move: step.move, why: 'an approval' } );
		}
	}

	// Z6: a move whose price does not fit what is left would overspend the pot; the budget ends the node as an exhausted
	// one would, before the move starts.
	async _unpaid( node, step, move ) {
		const _price = Pot.price( move ).total;
		if ( Pot.fits( node, _price ) ) { return false; }
		await this.runner.abort( node, { reason: `the budget cannot pay ${step.move} (${_price} of ${Pot.left( node )} left)`, status: 'failed' } );
		return true;
	}

	_blocked( node, step ) {
		const { gates, registry, mission } = this.runner;
		const _found = gates?.blocking( step, node, mission.kind, registry ) || null;
		if ( !_found ) { return null; }
		const _reason = `${step.move} is blocked by a strategy gate until ${_found.precondition.type} holds (gate ${_found.gate.id})`;
		node.hitWall( 'precondition_missing', [ { gate: _found.gate.id, move: step.move } ], { precondition: _found.precondition, reason: _reason } );
		return _found;
	}

	// A waiting node with facts in its queue is woken for its judgment (E4).
	static queued( node ) {
		if ( node.state === 'waiting' && !node.stopping && node.inbox?.length ) { node.wake( { kind: 'queued' } ); }
	}

	// The review (Wiedervorlage) is due at start + t_signal(s); it only counts while the node waits for a signal. A
	// review further ahead than a timer can count is waited for in parts.
	_review( node, move ) {
		const _at = node.plan.review;
		if ( !_at || node.state !== 'waiting' || !Execution.SIGNAL.includes( move.executor ) ) {
			return { due: new Promise( () => {} ), clear: () => {} };
		}
		let _timer;
		const _due = new Promise( ( resolve ) => {
			_timer = Supervisor.at( _at, () => resolve( { review: true } ) );
		} );
		return { due: _due, clear: () => _timer.clear() };
	}

	// A move ended: book it, take what it brought. → the end of the attempt, the judgment after an awaited event, or null.
	// A move that brought nothing at all failed like one that threw.
	async _finish( node, step, move, ended ) {
		const { out } = ended;
		const error = ended.error || ( out === null || out === undefined ? new Error( `${step.move} returned nothing` ) : null );
		const _plan = node.plan;
		const _waited = node.state === 'waiting';
		Pot.book( node, { what: step.move, ...Pot.price( move ), ms: Date.now() - _plan.pending.began } );
		_plan.pending = null;
		node.emit( 'move_ended', { move: step.move, index: _plan.next, ok: !error && !out?.wall && !out?.leaseExpired } );
		if ( error ) {
			// A move that fails is a wall like any other: the loop judges it and may try another strategy.
			node.hitWall( 'move_failed', [ { move: step.move, error: error.message.slice( 0, 300 ) } ] );
			return this.end( node, 'wall', 'move_failed' );
		}
		this.runner.drain( node );
		const _stop = await this._take( node, step, move, out );
		_plan.next++;
		if ( _stop ) {
			return this.end( node, 'wall', _stop );
		}
		if ( step.as ) {
			_plan.values[ step.as ] = out;
			node.emit( 'value', { name: step.as, labels: out.labels, groupSize: out.cohort?.length ?? null } );
		}
		if ( _waited && _plan.next < _plan.steps.length ) {
			// The awaited thing arrived (16.1 waiting → judging); the attempt goes on after the judgment.
			this._judgeNow( node, { event: step.move } );
			return 'waited';
		}
		return null;
	}

	// E1: the transition is written only if nobody moved the node since it began to wait (an abort, say).
	_judgeNow( node, data, version = null ) {
		if ( node.stopping || node.state !== 'waiting' ) { return; }
		try {
			node.move( 'judging', data, { expect: version } );
		} catch ( error ) {
			node.emit( 'transition_skipped', { reason: error.message } );
		}
	}

	// One move under its lease. An action that needs a person's approval leaves its request at the gate and ends its
	// lease: a person is no worker. Once approved, the token is presented under a new lease, and the gate checks lease,
	// fencing token, hash and expiry in the same booking that opens the delivery (O1, A6, F4). Whatever the gate then
	// does with the operation belongs to the gate; the end of a lease does not end it (O8).
	async _start( node, step, move ) {
		const { executor, mission, supervisor, pollMs } = this.runner;
		const _ctx = { node, mission, values: node.plan.values, runner: this.runner, plan: node.plan.steps };
		const _leased = work => ( supervisor ? supervisor.hold( node, step, move, work ) : work( null ) );
		const _stop = () => Boolean( node.stopping || node.plan?.cancelled );
		try {
			const _out = await _leased( lease => executor.run( step, { ..._ctx, lease } ) );
			if ( !_out?.decision || _out.leaseExpired ) { return { out: _out }; }
			this._remember( node, _out );
			const _waiting = ( decision ) => {
				if ( node.plan?.pending ) { node.plan.pending.approval = decision.approval || true; }
				if ( !node.toWaiting( { approval: decision.approval, move: step.move }, { move: step.move, why: 'an approval' } ) ) { return; }
				if ( node.plan ) { node.plan.waitVersion = node.version; }
				Execution.queued( node );
			};
			const _decision = await executor.conclude( _out.decision, { leased: _leased, pollMs, stop: _stop, waiting: _waiting } );
			return { out: _decision.leaseExpired ? { ..._out, leaseExpired: true } : { ..._out, decision: _decision } };
		} catch ( error ) {
			return { error };
		}
	}

	// Every action the node started is remembered, so an abort or a restart can find what is still open (O9).
	_remember( node, out ) {
		const _id = out.decision.delivery;
		if ( !_id || ( node.deliveries || [] ).includes( _id ) ) { return; }
		node.deliveries = [ ...( node.deliveries || [] ), _id ];
		// L4: what the operation brings later is credited to the attempt that started it.
		node.deliveryAttempt = { ...( node.deliveryAttempt || {} ), [ _id ]: node.plan?.attempt ?? null };
		if ( out.decision.approval ) { node.deliveryApproval = { ...( node.deliveryApproval || {} ), [ _id ]: out.decision.approval }; }
		const _started = { delivery: _id, status: out.decision.status, action: out.action, expectation: out.expectation || null };
		node.emit( 'delivery_started', { ..._started, attempt: node.deliveryAttempt[ _id ] } );
	}

	// What one move brought: a wall, a gate decision, facts. Returns the cause of a wall, or null.
	async _take( node, step, move, out ) {
		// A3, A4: the lease ran out before the move returned; nothing it produced is written and its unused tokens are
		// revoked. A delivery operation it already opened belongs to the gate and runs on (O8); the node follows it.
		if ( out.leaseExpired ) {
			await this.runner.cascade.revoke( node );
			node.hitWall( 'lease_expired', [ { move: step.move } ], { reason: `${step.move} ran past its lease and was ended` } );
			return 'lease_expired';
		}
		// Trusted code can report a wall itself, e.g. a missing precondition with an id (16.4).
		if ( out.wall ) {
			const { precondition = null, reason, decided } = out.wall;
			node.hitWall( out.wall.cause, out.wall.detail || [], { precondition, reason, decided } );
			return out.wall.cause;
		}
		if ( out.decision ) {
			const _stop = this._outcome( node, out, move );
			if ( _stop ) { return _stop; }
		}
		for ( const fact of out.facts || [] ) {
			const _fact = out.child ? { ...fact, id: undefined, source: `child ${out.child.id}` } : fact;
			this.admit( node, _fact );
		}
		// A child not started because its item was settled already is no failure.
		if ( out.child && ![ 'fulfilled', 'settled' ].includes( out.child.status ) ) {
			node.hitWall( 'child_failed', [ out.child ] );
		}
		return null;
	}

	// G3 for facts from execution: of a declared kind, with class and origin, bound to this node's contract. What is
	// stored is what G3 checked: the plain data, never the original.
	admit( node, fact ) {
		const _fact = { origin: 'system', ...fact, contract: node.contract.hash };
		const _shown = { ..._fact, data: Execution.plain( _fact.data ) };
		const _check = new FactCheck().check( _shown, { expectation: { fact: _fact.kind }, contract: node.contract.hash } );
		if ( !_check.ok ) {
			node.emit( 'fact_rejected', { kind: _fact.kind, problems: _check.problems } );
			return null;
		}
		return node.addFact( _shown );
	}

	// Turns a final gate decision into facts. Returns the cause of a wall, or null when the step went through.
	_outcome( node, out, move ) {
		const { expectations } = this.runner;
		const _decision = out.decision;
		if ( _decision.status === 'executed' ) {
			if ( out.expectation ) { expectations?.activate( out.expectation ); }
			// L2: contacting the same other side again ends the observation of the earlier attempts there.
			this.runner.journal.contact( node, out.target, { by: node.plan?.attempt, trigger: node.plan?.trigger || null } );
			// The receipt as evidence for the invariants: the group it was about, the approval, the plain parameters (ids,
			// amounts), never free text.
			const _data = {
				action: out.action, to: out.target, delivery: _decision.delivery, receipt: _decision.receipt,
				approval: _decision.approval || null, cohort: out.cohort || null, params: Execution.params( out.params ),
			};
			node.addFact( { kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: _data } );
			node.outputs = [ ...( node.outputs || [] ), { action: out.action, to: out.target, text: out.params?.body || null } ];
			// A move can settle an item, e.g. a confirmed payment settles its invoice; the gate's receipt is the evidence.
			if ( move?.resolves ) {
				const _id = out.params[ move.resolves.item ];
				const _outcome = move.resolves.outcome;
				const _item = { item: _id, outcome: _outcome, delivery: _decision.delivery, about: _id, value: _outcome };
				node.addFact( { kind: 'item_resolved', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: _item } );
			}
			return null;
		}
		if ( out.expectation ) { expectations?.drop( out.expectation ); }
		if ( _decision.status === 'unclear' ) {
			node.unclear = [ ...new Set( [ ...( node.unclear || [] ), _decision.delivery ] ) ];
			this.runner.cascade.handOver( node );
		}
		const _rule = _decision.reasons?.[ 0 ]?.rule || _decision.status;
		const _cause = node.stopping ? 'aborted' : this.runner.causes.ofRule( _rule );
		node.addFact( { kind: 'refused', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { action: out.action, to: out.target, ..._decision } } );
		node.hitWall( _cause, _decision.reasons );
		return _cause;
	}

	// The attempt ends: protocol, credit, costs (L2–L4, P3), then the judgment. The log and the journal name the same
	// outcome: the one close() decided (Z4).
	end( node, outcome, cause ) {
		const _ended = this.close( node, outcome, cause ) || { outcome, cause };
		if ( node.state === 'executing' || node.state === 'waiting' ) {
			node.move( 'judging', _ended );
		}
		return _ended.outcome;
	}

	// Books the attempt without moving the node, e.g. when it closes while a move it no longer needs is still open.
	// No reaction in time is a provisional result: the attempt stays open for the choice until its observation ends,
	// and a late signal corrects it (B8, L5). Its credit was booked as its facts came in (L4).
	close( node, outcome, cause ) {
		if ( !node.plan?.open ) { return; }
		// A strategy that ran through but left its criterion open did not reach it: that is a wall as well.
		if ( outcome === 'done' && node.openOutcomes().length ) {
			node.hitWall( 'not_reached', [ 'the strategy ran through, the criterion is still open' ] );
			outcome = 'wall';
			cause = 'not_reached';
		}
		node.plan.open = false;
		node.plan.pending = null;
		node.tried.push( { strategy: node.plan.strategy, wall: node.plan.wall, outcome, cause } );
		this.runner.book( node );
		const _cost = Pot.closeRound( node, node.plan.spentBefore );
		const _result = cause === 'no_reaction' ? 'timeout' : outcome;
		this.runner.journal.end( node.plan.attempt, { outcome: _result, cause, cost: _cost } );
		this.runner.memory?.situation( node, 'last attempt', { strategy: node.plan.strategy, outcome: _result, cause } );
		return { outcome, cause };
	}

	// O8: an operation the gate owns runs on after the move that opened it ended; when it is final, what came of it
	// reaches the node as a fact (executed) or as an unclear action for a person.
	follow( node, delivery ) {
		node.followed = node.followed || new Set();
		if ( node.followed.has( delivery ) ) { return; }
		node.followed.add( delivery );
		const _stop = () => node.state === 'closed';
		const _done = this.runner.executor.settle( { delivery, status: 'open' }, { pollMs: this.runner.pollMs, stop: _stop } );
		_done.then( async ( decision ) => {
			if ( decision.status === 'executed' ) {
				const _row = await this.runner.gate.delivery( delivery );
				this.receipted( _row, node ).forEach( fact => this.runner.deliver( node, fact ) );
			} else if ( decision.status === 'unclear' ) {
				node.unclear = [ ...new Set( [ ...( node.unclear || [] ), delivery ] ) ];
				this.runner.cascade.handOver( node );
			}
		} ).catch( app.fail );
	}

	// The facts an executed delivery leaves: the receipt, and the item it settles if its move resolves one. Both belong
	// to the attempt that started the delivery (L4), also when they arrive after it ended. The receipt is evidence for
	// the invariants as the one of a move that saw its action through: the approval, the group, the plain parameters.
	receipted( row, node ) {
		const _approval = row.approval || node.deliveryApproval?.[ row.id ] || null;
		const _data = {
			action: row.action, to: row.target, delivery: row.id, receipt: row.receipt, approval: _approval, cohort: row.cohort || null,
			params: Execution.params( row.params ),
		};
		const _attempt = node.deliveryAttempt?.[ row.id ] ?? null;
		const _facts = [ { kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: _data, attempt: _attempt } ];
		const _move = Object.values( this.runner.catalog.moves ).find( move => move.action === row.action && move.resolves );
		if ( _move ) {
			const _id = row.params?.[ _move.resolves.item ];
			const _item = { item: _id, outcome: _move.resolves.outcome, delivery: row.id, about: _id, value: _move.resolves.outcome };
			_facts.push( { kind: 'item_resolved', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: _item, attempt: _attempt } );
		}
		return _facts;
	}

	// E6: what is still open of an attempt the node no longer needs. The judgment may take back only a move marked
	// reversible (an open question to a person, a wait); the cancellation is a move of its own, with evidence: what was
	// withdrawn, and the facts that made the move unnecessary. A move that is not reversible runs to its end, bounded by
	// its lease; a closing node waits for it at most withinMs (Δ), then leaves it to its lease.
	async cancel( node, because = 'the goal is met', evidence = [], { withinMs = Infinity } = {} ) {
		const _pending = node.plan?.pending;
		if ( !_pending ) { return; }
		const _of = node.plan.steps[ _pending.index ]?.move;
		const _move = this.runner.catalog.get( _of );
		if ( !_move?.reversible ) {
			let _timer;
			const _bound = new Promise( ( resolve ) => { _timer = Number.isFinite( withinMs ) && setTimeout( () => resolve( 'late' ), withinMs ); } );
			const _ended = await Promise.race( [ _pending.promise.then( () => 'ended', () => 'ended' ), _bound ] );
			clearTimeout( _timer );
			if ( _ended === 'late' ) { node.emit( 'move_outlasts_close', { move: _of, leaseBounds: true } ); }
			node.plan.pending = null;
			return;
		}
		const _cancel = this.runner.catalog.get( 'move.cancel' );
		node.emit( 'move_started', { move: 'move.cancel', of: _of, index: _pending.index } );
		node.plan.cancelled = true;
		const _withdrawn = this.runner.executor.board?.withdraw( [ node.id ], { reason: 'cancelled' } ) || [];
		this.runner.executor.runtime?.stop( node.id );
		// A move that ignores its cancellation is waited for 2 s at most, and never longer than what is left of Δ.
		let _timer;
		const _bound = new Promise( ( resolve ) => {
			_timer = setTimeout( resolve, Math.max( 0, Math.min( 2000, withinMs ) ) );
		} );
		await Promise.race( [ _pending.promise, _bound ] );
		clearTimeout( _timer );
		const _data = { move: _of, tickets: _withdrawn.map( item => item.id ), because, evidence };
		node.addFact( { kind: 'cancelled', evidenceClass: 'observation', source: 'system', origin: 'system', data: _data } );
		Pot.book( node, { what: 'move.cancel', ...Pot.price( _cancel ) } );
		node.emit( 'move_ended', { move: 'move.cancel', of: _of, ok: true } );
		node.emit( 'move_cancelled', { move: _of, because, evidence } );
		node.plan.pending = null;
	}

	// The parameters of an action as evidence: plain values (ids, amounts) only, never free text.
	static params( params ) {
		return Object.fromEntries( Object.entries( params || {} ).filter( ( [ , value ] ) => FactCheck.plain( value ) ) );
	}

	// Numbers and ids from a count pass as they are; anything else in a fact from execution is reduced to its keys.
	static plain( data ) {
		const _plain = value => value === undefined || FactCheck.plain( value );
		return Object.fromEntries( Object.entries( data || {} ).map( ( [ key, value ] ) => [ key, _plain( value ) ? value : `${key}` ] ) );
	}

} );
