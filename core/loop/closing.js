// Closing a node (2.3, 4.4, 16.1, 16.3): what the goal no longer needs is cancelled, soft criteria are assessed, the
// lesson is written through G4, and G6 checks all six dimensions of "really done". A goal judged done that does not
// pass G6 goes back to its judgment; a goal that failed or was aborted closes once the clean-up holds. Closing is
// bounded by the buffer Δ, from the node's first entry into closing on (a return to its judgment does not renew it).
// The closed node reports to its parent (closing runs bottom-up).

app.define( 'Core.Loop.Closing', [ 'Core.Check.CloseCheck', 'Core.Check.WriteCheck', 'Core.Check.ReadCheck', 'Core.Budget.Pot' ], ( CloseCheck, WriteCheck, ReadCheck, Pot ) => class Closing {

	static ALARM_MINUTES = 1;
	static SUGGESTION_MINUTES = 1;

	constructor( runner ) {
		this.runner = runner;
	}

	async close( node ) {
		const r = this.runner;
		// Closing is bounded by the buffer Δ: what is not cleaned up by then is named in the result.
		node.closingUntil = node.closingUntil ?? Date.now() + r.bufferMinutes * 60000;
		const _left = () => Math.max( 0, node.closingUntil - Date.now() );
		r.drain( node );
		if ( node.plan?.open ) {
			// E6: the judgment takes back what the proven goal no longer needs; the proving facts are the evidence.
			const _proof = node.contract.check( node.valid() ).flatMap( item => item.evidence || [] );
			await r.execution.cancel( node, node.stopping ? 'the goal is aborted' : 'the goal is met', _proof, { withinMs: _left() } );
			r.execution.close( node, node.stopping ? 'wall' : 'done', node.stopping ? 'aborted' : null );
		}
		r.executor.board?.withdraw( [ node.id ], { reason: 'cancelled' } );
		r.expectations?.closeFor( node.id );
		// Z5: only what the reviewer answered within Δ counts; a later answer changes nothing.
		const _soft = { answers: [], open: true };
		await r.within( node, 'closing', this.soft( node, _soft ), null, _left() );
		_soft.open = false;
		// A closing that was given up meanwhile (an error forced the node closed) changes nothing more (Z5).
		if ( node.state !== 'closing' ) { return; }
		Closing.assess( node, _soft.answers );
		await this.learn( node, _left() );
		const _aborted = Boolean( node.stopping ) || ( node.result && node.result.status !== 'fulfilled' );
		const _check = await this._check( node, _aborted, _left );
		if ( node.state !== 'closing' ) { return; }
		// Judged done, but G6 finds an unmet predicate: back to the judgment (16.1), never in the abort cascade.
		if ( !_aborted && !_check.ok && _check.dimensions.functional.length && _left() > 0 ) {
			node.lessonWritten = false;
			node.move( 'judging', { g6: _check.dimensions.functional } );
			return;
		}
		node.result = Closing.result( node, _check );
		// The person's minutes for the refused proposals of the model are booked before the books close (P5).
		if ( node.refusedProposals?.length && r.executor.board ) {
			Pot.book( node, { what: 'suggestion ticket', humanMinutes: Closing.SUGGESTION_MINUTES } );
		}
		node.move( 'closed', { result: node.result, costs: node.costs || null, spent: node.spent } );
		node.emit( 'node_closed', { result: node.result, dimensions: _check.dimensions } );
		// The report upwards (2.3, "Meldung nach oben").
		node.parent?.emit( 'child_ended', { child: node.id, result: node.result.status, precondition: node.contract.serves?.precondition || null } );
		if ( node.stopping ) {
			r.cascade.handOver( node );
		}
		this._suggest( node );
	}

	// 7.2 G4: the refused proposals of the model go to a person as one suggestion per node, after the node closed, so
	// it holds nothing up. The answer becomes part of the node's history (8.4).
	_suggest( node ) {
		const _items = node.refusedProposals || [];
		node.refusedProposals = [];
		if ( !_items.length ) { return; }
		const _parts = _items.map( item => `a lesson for attempt ${item.attempt} that G4 refused (${item.problems.join( '; ' )}): `
			+ `${String( JSON.stringify( item.proposal ) ).slice( 0, 300 )}` );
		this.runner.executor.board?.ask( node, {
			question: `The model proposed ${_parts.join( '; and ' )}. None of it was written.`,
			options: [ 'discard it', 'keep it as a note' ], recommendation: 'discard it', minutes: Closing.SUGGESTION_MINUTES, kind: 'suggestion',
			reason: 'G4',
		} ).catch( app.fail );
	}

	// 18.6: an error in the core is treated like a system gate: abort and alarm. The cascade ends what runs below the node
	// and withdraws its open outside actions; then the node closes as any aborted node does (16.3: books, lesson and
	// budget in all cases), bounded by Δ, and only if that fails too it is forced closed. A person is told.
	async failed( node, error ) {
		const r = this.runner;
		if ( node.state === 'closed' ) { return; }
		node.result = { status: 'failed', reason: error.message };
		await r.abort( node, { reason: `an error in the core: ${error.message}`, status: 'failed' } ).catch( app.fail );
		node.emit( 'alarm', { reason: error.message } );
		const _board = r.executor.board;
		if ( _board ) { Pot.book( node, { what: 'alarm ticket', humanMinutes: Closing.ALARM_MINUTES } ); }
		try {
			if ( node.state !== 'closing' ) { node.move( 'closing', { reason: node.result.reason, result: node.result } ); }
			await this._closeWithin( node );
		} catch ( failure ) {
			node.emit( 'error', { message: failure.message, closing: true } );
			if ( node.state !== 'closed' ) { Closing.force( node ); }
		}
		// Asked after the node closed, so closing does not withdraw it with the node's other tickets.
		_board?.ask( node, {
			question: `Alarm: the core failed on this goal (${error.message}). It was aborted; what ran below it was ended.`,
			options: [ 'noted' ], recommendation: 'noted', minutes: Closing.ALARM_MINUTES, kind: 'escalation', reason: 'alarm',
		} ).catch( app.fail );
	}

	// Closing within Δ and a second of grace; a closing that does not end by then has failed as well.
	async _closeWithin( node ) {
		const _until = node.closingUntil ?? Date.now() + this.runner.bufferMinutes * 60000;
		const _closing = this.close( node );
		_closing.catch( () => {} );
		await Closing.bounded( _closing, _until - Date.now() + 1000 );
		if ( node.state !== 'closed' ) { throw new Error( `closing ended in ${node.state}` ); }
	}

	// After an error the node still closes along table 16.1 (Z3), every transition an event in the log (Z4).
	static force( node ) {
		if ( node.state !== 'closing' ) {
			node.move( 'closing', { reason: node.result?.reason || 'error', result: node.result } );
		}
		node.move( 'closed', { result: node.result } );
	}

	// The result names what G6 still found when Δ ran out, and the assessment of the soft criteria. A result decided
	// before the node closed (a person's answer, a refusal, no start tokens) stands; an abort that reaches the closing
	// node only makes sure everything is cleaned up, and its unclear actions are named.
	static result( node, check ) {
		const _stopped = node.stopping && { status: node.stopping.status, reason: node.stopping.reason, unclear: node.unclear || [] };
		const _decided = node.result && { ...node.result, ...( _stopped ? { unclear: node.unclear || [] } : {} ) };
		const _result = _decided || _stopped || { status: check.ok ? 'fulfilled' : 'failed' };
		const _soft = node.softAssessed?.length ? { soft: node.softAssessed } : {};
		return { ..._result, ...( check.ok ? {} : { problems: check.problems } ), ..._soft };
	}

	// G6. What only time clears (an outside action still running, a child still closing, a ticket being withdrawn) is
	// checked again until Δ runs out; a predicate that is not met is not waited for.
	async _check( node, aborted, left ) {
		const r = this.runner;
		for ( ;; ) {
			const _context = await this._context( node, left );
			const _check = new CloseCheck().check( node, { aborted, lessons: Boolean( r.memory ), context: _context } );
			const { functional, formal, knowledge } = _check.dimensions;
			const _waitable = !_check.ok && !functional.length && !formal.length && !knowledge.length;
			if ( !_waitable || left() <= 0 ) {
				node.emit( 'check', _check );
				return _check;
			}
			await new Promise( resolve => setTimeout( resolve, Math.min( r.pollMs, left() ) ) );
		}
	}

	// What G6 needs that only the runner knows. A8: in doubt an outside action is open; an action whose state the gate
	// could not tell within what is left of Δ (an error, no answer) never counts as finished.
	async _context( node, left = () => 0 ) {
		const r = this.runner;
		const _open = [];
		for ( const id of node.deliveries || [] ) {
			const _row = await Closing.bounded( r.gate.delivery( id ), left() ).catch( () => Closing.UNKNOWN );
			if ( _row === Closing.UNKNOWN || [ 'open', 'awaiting_approval', 'approved' ].includes( _row?.status ) ) { _open.push( id ); }
		}
		return {
			confirmed: node.confirmed || null,
			attemptsOpen: r.journal.forNode( node.id ).filter( attempt => !attempt.endedAt ).length,
			ticketsOpen: ( r.executor.board?.list() || [] ).filter( ticket => ticket.node === node.id ).length,
			deliveriesOpen: _open.filter( id => !( node.unclear || [] ).includes( id ) ),
		};
	}

	// A promise that settles within ms, or else rejects.
	static bounded( promise, ms ) {
		let _timer;
		const _late = new Promise( ( _resolve, reject ) => {
			_timer = setTimeout( () => reject( new Error( 'no answer within the buffer' ) ), Math.max( 0, ms ) );
			_timer.unref?.();
		} );
		return Promise.race( [ Promise.resolve( promise ), _late ] ).finally( () => clearTimeout( _timer ) );
	}

	static UNKNOWN = Symbol( 'unknown' );

	// Soft criteria (14): a reviewer with fresh context assesses each against what the node sent out. The answers are
	// collected while into.open; closing applies those that came in time (Closing.assess).
	async soft( node, into = { answers: [], open: true } ) {
		const _provider = this.runner.judge?.provider;
		if ( node.stopping || !_provider || !node.contract.softs().length ) { return; }
		for ( const item of node.contract.softs() ) {
			const _answer = await _provider.complete( {
				role: 'reviewer',
				instructions: 'You review, with no other context, whether what was sent meets this wish. Answer yes or no, with a short reason.',
				input: { wish: item.values.text, sent: Closing.sent( node ) },
				contract: { fields: { met: { type: 'enum', values: [ 'yes', 'no' ] }, reason: { type: 'string' } } },
				node: node.id,
			} ).catch( () => null );
			if ( !into.open ) { return; }
			if ( _answer ) { into.answers.push( { item, answer: _answer } ); }
		}
	}

	// The assessment is a derivation; it is shown with the result and never closes or blocks a goal on its own.
	static assess( node, answers ) {
		if ( !answers.length ) { return; }
		node.softAssessed = [];
		for ( const { item, answer } of answers ) {
			const _data = { criterion: item.id, met: answer.met === 'yes' };
			node.addFact( { kind: 'soft_assessed', evidenceClass: 'derivation', source: 'reviewer', origin: 'reviewer', data: _data } );
			node.softAssessed.push( { id: item.id, text: item.values.text, met: answer.met === 'yes', reason: answer.reason } );
		}
	}

	static sent( node ) {
		return ( node.outputs || [] ).map( output => output.text ).filter( Boolean ).slice( -5 );
	}

	// Every attempt of the node becomes a lesson through G4, written by code with a proposal of the model (4.1 step 6),
	// before the node may close (G6). What the journal learns about it later (a late signal, the end of its
	// observation) is added as a correction (9.3, L5).
	async learn( node, withinMs ) {
		const r = this.runner;
		if ( !r.memory || node.lessonWritten ) { return; }
		const _success = !node.stopping && new CloseCheck().check( node ).ok;
		r.journal.contractSuccess( node, _success );
		const _known = { journal: r.journal, strategies: r.mission.strategies, causes: r.causes, diagnosis: r.diagnosis };
		const _lessons = r.journal.forNode( node.id ).filter( attempt => !r.memory.hasLesson( attempt.id ) )
			.map( attempt => Closing.lesson( attempt, { kind: r.mission.kind, node, run: r.id, success: _success } ) );
		const _asked = r.learner ? r.learner.propose( node, _lessons, r.diagnosis ) : Promise.resolve( [] );
		const _proposals = await r.within( node, 'closing', _asked, [], withinMs ) || [];
		node.refusedProposals = _proposals.filter( item => !_lessons.some( lesson => lesson.attempt === item.attempt ) )
			.map( item => ( { ...item, problems: [ 'no attempt of this node' ] } ) );
		for ( const code of _lessons ) {
			let _lesson = code;
			for ( const { proposal } of _proposals.filter( item => item.attempt === code.attempt ) ) {
				const _proposed = new WriteCheck().proposal( proposal, code, _known );
				node.emit( 'check', { gate: _proposed.gate, ok: _proposed.ok, problems: _proposed.problems, attempt: code.attempt, proposal: true } );
				if ( _proposed.ok ) {
					_lesson = _proposed.lesson;
				} else {
					node.refusedProposals.push( { attempt: code.attempt, proposal, problems: _proposed.problems } );
				}
			}
			const _check = new WriteCheck().check( _lesson, _known );
			node.emit( 'check', { ..._check, attempt: _lesson.attempt } );
			if ( _check.ok ) {
				r.memory.storeLesson( _lesson );
				r.memory.record( node, 'lesson', _lesson );
				node.emit( 'lesson_written', { strategy: _lesson.strategy, result: _lesson.result, attempt: _lesson.attempt } );
			}
		}
		node.lessonWritten = true;
	}

	// The counterparty of an attempt as a lesson keeps it: a plain id as it is (hr, design), anything else (an e-mail
	// address) as a pseudonym that is the same for the same contact, so a lesson holds no text and still matches.
	static contact( value ) {
		if ( value === undefined || value === null || value === '' ) { return null; }
		const _digest = () => app.lib( 'node:crypto' ).createHash( 'sha256' ).update( String( value ) ).digest( 'hex' ).slice( 0, 12 );
		return /^[A-Za-z0-9_.:-]{1,64}$/.test( String( value ) ) ? String( value ) : `c-${_digest()}`;
	}

	// The schema of 20.1: attempt, strategy, situation, result (provisional before), signal after h, end of the
	// observation, contribution, the contract's success, evidence. Codes, ids and numbers only.
	static lesson( attempt, { kind, node, run, success } ) {
		const _start = new Date( attempt.startedAt );
		const _situation = {
			task: kind, contact: Closing.contact( JSON.parse( attempt.contacts || '[]' )[ 0 ] ),
			weekday: [ 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat' ][ _start.getUTCDay() ], month: _start.getUTCMonth() + 1,
			wall: JSON.parse( attempt.situation ).wall || null, depth: node.depth,
		};
		const _result = [ 'timeout', 'late_effect' ].includes( attempt.outcome ) ? attempt.outcome : attempt.outcome === 'done' ? 'fulfilled' : 'wall';
		return {
			attempt: attempt.id, strategy: attempt.strategy, situation: _situation, result: _result,
			provisional: attempt.provisional || null,
			signalAfterH: attempt.signalAt ? Math.round( ( Date.parse( attempt.signalAt ) - _start ) / 36000 ) / 100 : null,
			observationEnds: attempt.observationEnd ? JSON.parse( attempt.observationEnd ) : null, cause: attempt.cause || null,
			contribution: JSON.parse( attempt.contribution || '[]' ), contractSuccess: success, evidence: { node: node.id, run },
		};
	}

	// What the system learned about this kind of goal, read through G5; it only informs the choice of slots (L1).
	experience( node ) {
		const r = this.runner;
		if ( !r.memory ) { return []; }
		const _read = new ReadCheck().read( r.memory, { kind: r.mission.kind, journal: r.journal, board: r.executor.board, node } );
		const _short = lesson => ( {
			strategy: lesson.strategy, wall: lesson.situation?.wall || null, result: lesson.result, cause: lesson.cause,
		} );
		return _read.lessons.map( _short ).slice( -10 );
	}

} );
