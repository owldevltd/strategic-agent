// The judgment (chapter 16.4). A model proposes a verdict from codes and evidence classes only; code applies the
// rules U1 to U4 and decides:
//   U1 done      only when every evidence predicate holds, and only through G6
//   U2 deeper    only for the cause precondition_missing with a precondition of catalog types that serves an open
//                criterion and is not already met (R8); it becomes a child
//   U3 other     only when the cause belongs to the strategy and another eligible strategy has positive points
//   U4 escalate  in every other case: a person decides
// A verdict whose condition does not hold is overruled; the code's own reading then applies.

app.define( 'Core.Loop.Judge', [ 'Core.Check.CloseCheck', 'Core.Move.Causes', 'Lib.Hash' ], ( CloseCheck, Causes, Hash ) => class Judge {

	static VERDICTS = [ 'done', 'other', 'deeper', 'escalate' ];
	// A later deadline the model may suggest: at most a year more (3.2); the client decides on it anyway.
	static MAX_EXTENSION_HOURS = 24 * 366;

	// causes: the cause codes of the catalog; whether a cause belongs to the strategy is data, not code.
	constructor( { provider = null, registry, causes = Causes.load() } ) {
		Object.assign( this, { provider, registry, causes } );
	}

	// bound( promise ): what cuts the model off at the deadline of judging (Z2, Runner.within); without an answer in
	// time the code's own reading applies.
	async judge( node, { alternatives = [], bound = promise => promise } = {} ) {
		const _proposal = await bound( this._propose( node, alternatives ) );
		// The wall report carries a suggestion (16.4): the model's, or else the catalog's for this cause.
		const _wall = Judge.wall( node );
		if ( _wall && !_wall.suggestion ) {
			_wall.suggestion = _proposal?.suggestion || this.causes.table[ _wall.cause ]?.suggest || null;
		}
		const _decided = this.decide( node, _proposal, alternatives );
		// With "escalate", the model may suggest a concrete change of the goal; only the client can make it (3.2).
		const _amendment = _decided.verdict === 'escalate' ? Judge.amendment( node, _proposal?.amendment?.[ 0 ] ) : null;
		node.emit( 'verdict', {
			proposed: _proposal?.verdict || null, verdict: _decided.verdict, rule: _decided.rule, overruled: _decided.overruled,
			open: node.openOutcomes().map( item => item.id ), next: _decided.verdict, precondition: _decided.precondition || null,
			suggestion: _wall?.suggestion || null, amendment: _amendment,
		} );
		return _amendment ? { ..._decided, amendment: _amendment } : _decided;
	}

	// The wall the judgment is about: the last one, except the synthetic wall a restart adds for the move it interrupted
	// (as Chooser.currentWall reads it), so a restart never hides the wall that led to a verdict, e.g. the precondition
	// U2 was about to make a child. A precondition that was met or tried meanwhile is no longer what the node stands
	// at; then, as when there is no other wall, the interruption is.
	static wall( node ) {
		const _walls = node.walls || [];
		const _real = _walls.findLastIndex( wall => wall?.cause !== 'interrupted' );
		if ( _real < 0 ) { return _walls.at( -1 ) || null; }
		const _wall = _walls[ _real ];
		const _id = [ 'precondition_missing', 'child_failed' ].includes( _wall.cause ) ? _wall.precondition?.id : null;
		const _settled = _id && ( node.preconditionMet?.( _id ) || node.preconditionsTried?.has?.( _id ) );
		return _settled && _real < _walls.length - 1 ? _walls.at( -1 ) : _wall;
	}

	// A suggested change is a criterion that is not immutable with new values, or a later deadline of finitely many
	// hours (at most MAX_EXTENSION_HOURS) that makes a date; anything else is dropped (G-10).
	static amendment( node, raw ) {
		if ( !raw || typeof raw !== 'object' ) { return null; }
		const _criterion = node.contract.criteria.find( item => item.id === raw.criterion );
		const _values = _criterion && !_criterion.immutable && raw.values && typeof raw.values === 'object' ? raw.values : null;
		const _hours = Number( raw.deadlineHours );
		const _time = _hours > 0 && _hours <= Judge.MAX_EXTENSION_HOURS ? Date.parse( node.contract.deadline ) + _hours * 3600000 : NaN;
		const _deadline = Number.isFinite( _time ) && Math.abs( _time ) <= 8.64e15 ? new Date( _time ).toISOString() : null;
		if ( !_values && !_deadline ) { return null; }
		return {
			...( _values ? { criterion: _criterion.id, values: _values } : {} ),
			...( _deadline ? { deadline: _deadline } : {} ),
		};
	}

	decide( node, proposal, alternatives ) {
		const _wall = Judge.wall( node );
		const _checks = {
			done: () => new CloseCheck().check( node ).ok && { verdict: 'done', rule: 'U1' },
			deeper: () => this._deeper( node, _wall ),
			// U3 counts real eligible strategies only, never the virtual alternative of a new proposal. Without a real one a
			// new proposal is still another way (19): the node plans again, finds nothing eligible, and the model proposes
			// once for this wall before a person is asked.
			other: () => {
				const _open = alternatives.filter( item => !item.reason && item.points > 0 );
				if ( !_wall || !this.causes.ofStrategy( _wall.cause ) ) { return null; }
				if ( _open.some( item => !item.virtual ) ) { return { verdict: 'other', rule: 'U3' }; }
				return _open.some( item => item.virtual ) ? { verdict: 'other', rule: '19 (a new proposal)' } : null;
			},
			// U4 "in every other case": a proposed escalation stands only when neither U2 nor U3 applies.
			escalate: () => !_checks.deeper() && !_checks.other() && { verdict: 'escalate', rule: 'U4' },
		};
		// Facts from different origins that contradict each other, or a criterion no fact can meet any more: a person
		// decides (U4, E5).
		const _impossible = node.contract.check( node.valid ? node.valid() : node.facts ).some( item => item.impossible );
		if ( node.conflicts?.().length || _impossible ) {
			return { verdict: 'escalate', rule: 'U4', overruled: Boolean( proposal?.verdict ) && proposal.verdict !== 'escalate' };
		}
		// U1 comes first: once every predicate holds, the goal is done, whatever was proposed.
		const _done = _checks.done();
		if ( _done ) {
			return { ..._done, overruled: Boolean( proposal?.verdict ) && proposal.verdict !== 'done' };
		}
		// Only one of the four verdicts is a proposal; anything else (a name of the prototype, say) is none.
		const _wanted = Judge.VERDICTS.includes( proposal?.verdict ) ? _checks[ proposal.verdict ]() : null;
		if ( _wanted ) {
			return { ..._wanted, overruled: false };
		}
		// The code's own reading, in the order of the rules.
		const _own = _checks.done() || _checks.deeper() || _checks.other() || _checks.escalate();
		return { ..._own, overruled: Boolean( proposal?.verdict ) };
	}

	// U2: deeper only for the precondition the wall itself names (trusted code or a strategy gate reported it); a
	// precondition the model proposes is no evidence that anything is missing.
	_deeper( node, wall ) {
		const _pre = wall?.precondition || null;
		if ( !wall || wall.cause !== 'precondition_missing' || !_pre?.id || !this.registry.has( _pre.type ) ) {
			return null;
		}
		// R8: no second child for a precondition whose evidence is valid; a wall that names it as missing again
		// contradicts itself, and the verdict is "escalate".
		if ( node.preconditionMet?.( _pre.id ) ) {
			return { verdict: 'escalate', rule: 'R8', reason: `${_pre.id} is named missing again although its evidence is valid` };
		}
		// No way down either for a precondition a child already tried and did not meet (a second child changes nothing),
		// or for one that is an outcome of this goal or a goal above it: G1 would refuse that child as a restatement (R5).
		// The code's reading goes on to another strategy or to a person, instead of a child after child.
		if ( node.preconditionsTried?.has?.( _pre.id ) || Judge.restates( node, _pre ) ) {
			return null;
		}
		const _serves = wall.criterion && node.openOutcomes().some( item => item.id === wall.criterion );
		return _serves ? { verdict: 'deeper', rule: 'U2', precondition: { ..._pre, serves: wall.criterion } } : null;
	}

	// A precondition that is, type and values, an outcome of the node's goal or of a goal above it.
	static restates( node, precondition ) {
		const _contracts = [ node.contract, ...( typeof node.ancestors === 'function' ? node.ancestors() : [] ) ].filter( Boolean );
		const _values = Hash.canonical( precondition.values || {} );
		return _contracts.some( contract => ( typeof contract.outcomes === 'function' ? contract.outcomes() : [] )
			.some( item => item.type === precondition.type && Hash.canonical( item.values || {} ) === _values ) );
	}

	async _propose( node, alternatives ) {
		if ( !this.provider ) {
			return null;
		}
		return this.provider.complete( {
			role: 'judge',
			instructions: 'You judge where a goal stands. Propose done (every criterion is proven), other (another strategy should be tried), '
				+ 'deeper (something the goal depends on is missing and can be made a sub-goal) or escalate (a person must decide). '
				+ 'Use only the cause codes you are given.',
			input: {
				goal: node.contract.goal,
				open: node.openOutcomes().map( item => ( { id: item.id, type: item.type } ) ),
				facts: node.facts.map( fact => ( { kind: fact.kind, evidence: fact.evidenceClass, source: fact.source } ) ),
				// 16.4: codes and evidence classes only; a wall's reason and detail may carry text from outside.
				walls: node.walls.map( ( { criterion, cause, precondition } ) => ( {
					criterion, cause, precondition: precondition ? { id: precondition.id ?? null, type: precondition.type ?? null } : null,
				} ) ),
				tried: node.tried.map( item => item.strategy ),
				alternatives: alternatives.filter( item => !item.reason ).map( item => ( { id: item.id, points: item.points } ) ),
			},
			contract: { fields: {
				verdict: { type: 'enum', values: Judge.VERDICTS },
				causes: { type: 'list', values: this.causes.codes(), required: false },
				reason: { type: 'string' },
				suggestion: { type: 'string', required: false },
				amendment: { type: 'records', required: false, fields: { criterion: 'a criterion id', values: 'its new values', deadlineHours: 'more hours' } },
			} },
			node: node.id,
		} ).catch( () => null );
	}

} );
