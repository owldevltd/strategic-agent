// Chapter 19 with the diagnosis of 5.6. A strategy is eligible when it serves an open criterion c, its chance to meet
// c within c's own remaining time reaches θ, its cost fits the budget, no attempt of it for c is still open (running,
// or with a provisional timeout whose observation has not ended), G2 has not refused its plan for this node, and it
// answers the current wall: without a wall only the direct way (4.3: decompose only when the direct way fails), with
// a wall only the classes the diagnosis reads into it, the first hypothesis first. "Other" (U3) means another
// strategy than the one that just ended, and never one that answered the current wall and hit it again. Points =
// F_s(remaining time of c) · W − k(s); W is the goal's value, else its budget; the cheaper one wins a tie. A cheap
// probe of a hypothesis goes before the large strategy of its class. The code decides, not a model.

app.define( 'Core.Strategy.Chooser', [ 'Core.Strategy.TargetCurve', 'Core.Strategy.Diagnosis' ], ( TargetCurve, Diagnosis ) => class Chooser {

	static THETA = 0.1;

	constructor( curve = new TargetCurve() ) {
		this.curve = curve;
	}

	// cost(s) is k(s) of chapter 19; exclude: the strategy that just ended (U3 "other").
	choose( node, strategies, options = {} ) {
		const { now = Date.now(), budgetLeft = Infinity, diagnosis = new Diagnosis(), exclude = null, open = [] } = options;
		const { cost = strategy => strategy.price ?? 1 } = options;
		const _wall = Chooser.currentWall( node );
		// 5.6: the class a person chose for the current wall goes first.
		const _decided = Chooser.decided( node );
		const _value = node.contract.value || node.contract.budget || 1;
		// A learned diagnosis holds for the kind of task it was made for (5.6).
		const _kind = node.contract.spec?.kind ?? null;
		const _scored = strategies.map( ( strategy ) => {
			const _criterion = Chooser.serves( node, strategy );
			const _hours = ( Date.parse( _criterion?.deadline || node.contract.deadline ) - now ) / 3600000;
			const _chance = this.curve.value( strategy, _hours );
			const _k = cost( strategy );
			const _rank = _wall ? Chooser.rank( diagnosis, _wall, strategy, _kind ) : 0;
			const _facts = { node, criterion: _criterion, wall: _wall, rank: _rank, chance: _chance, budgetLeft, cost: _k, exclude, open };
			const _reason = this._ineligible( strategy, _facts );
			const _points = _chance * _value - _k;
			const _rounded = { chance: Number( _chance.toFixed( 3 ) ), points: Number( _points.toFixed( 2 ) ) };
			const _first = Boolean( _decided ) && Chooser.classes( strategy ).includes( _decided );
			const _scoredOne = { id: strategy.id, ..._rounded, cost: _k, rank: _rank, probe: Boolean( strategy.probe ), reason: _reason };
			if ( _first ) { _scoredOne.decided = true; }
			// The strategy itself and its exact points travel with its score (not in what is logged): two entries with one id
			// never mix, and the choice compares the points as computed; rounding is for the record only.
			const _exact = { chance: _chance, points: _points };
			Object.defineProperties( _scoredOne, { strategy: { value: strategy }, exact: { value: _exact } } );
			return _scoredOne;
		} );
		const _order = ( a, b ) => Number( Boolean( b.decided ) ) - Number( Boolean( a.decided ) ) || a.rank - b.rank
			|| Number( b.probe ) - Number( a.probe ) || b.exact.points - a.exact.points
			|| a.cost - b.cost;
		const _eligible = _scored.filter( item => !item.reason ).sort( _order );
		const _undiagnosed = Boolean( _wall ) && !diagnosis.of( _wall, _kind );
		const _chosen = _eligible[ 0 ] ? _eligible[ 0 ].strategy : null;
		return { chosen: _chosen, scored: _scored, wall: _wall, undiagnosed: _undiagnosed };
	}

	// A strategy may belong to several classes (declining politely is a direct way and the answer to "the group is too
	// small"); its rank is the best one among them, -1 when the wall leads to none.
	static classes( strategy ) {
		return [].concat( strategy.class || 'direct' );
	}

	static rank( diagnosis, wall, strategy, kind = null ) {
		const _ranks = Chooser.classes( strategy ).map( item => diagnosis.rank( wall, item, kind ) ).filter( rank => rank >= 0 );
		return _ranks.length ? Math.min( ..._ranks ) : -1;
	}

	// The open criterion a strategy would work on (the client's confirmation where a person is the channel, K4).
	static serves( node, strategy ) {
		const _open = node.openOutcomes();
		return strategy.serves === '@byPerson' ? _open.find( item => item.byPerson )
			: _open.find( item => item.type === strategy.serves && Chooser.fits( strategy, item ) );
	}

	// fits: what a strategy can work on, as patterns for the values of its criterion (inviting a team can only raise
	// the answers of a team, "answers:design").
	// A pattern that does not compile fits nothing: the strategy is not eligible, the choice goes on.
	static fits( strategy, criterion ) {
		const _test = ( name, pattern ) => {
			try {
				return new RegExp( pattern ).test( String( criterion.values?.[ name ] ?? '' ) );
			} catch {
				return false;
			}
		};
		return Object.entries( strategy.fits || {} ).every( ( [ name, pattern ] ) => _test( name, pattern ) );
	}

	// The wall the next strategy has to answer. A missing precondition that a child has since met is no longer in the
	// way; the wall before it counts again (the strategy that stopped there may run once more, R7). An interrupted move
	// (restart) is no wall of the strategy either, and neither is a precondition a child has already gone after.
	// 5.6: a person's decision at a wall names the class that answers it. It is learned for this kind of task (signed in
	// the memory, read through G5 the next time) and is the wall's diagnosis now: → the wall that ends the attempt, with
	// the decided class, or null when there is no wall to decide about or no strategy of that class.
	static decide( node, decided, by, { strategies = [], kind = null, memory = null, diagnosis = null } = {} ) {
		const _cause = Chooser.currentWall( node );
		const _mine = item => Chooser.serves( node, item ) && ( !item.kind || item.kind === node.contract.spec?.kind );
		if ( !_cause || !strategies.some( item => _mine( item ) && Chooser.classes( item ).includes( decided ) ) ) { return null; }
		memory?.learnDiagnosis( node, { kind, cause: _cause, class: decided, by } );
		diagnosis?.learned.push( { cause: _cause, class: decided, by, kind } );
		return { cause: _cause, reason: `${by} decided: ${decided}`, decided };
	}

	// The class a person decided for the current wall (5.6), or null.
	static decided( node ) {
		const _walls = Array.isArray( node.walls ) ? node.walls : [];
		const _last = [ ..._walls ].reverse().find( wall => wall.cause !== 'interrupted' );
		return _last && typeof _last.decided === 'string' && _last.cause === Chooser.currentWall( node ) ? _last.decided : null;
	}

	// The wall the next strategy answers. A missing precondition that is met by now, or that a child already tried, is
	// handled; a child that failed is the wall itself (its diagnosis leads on, 5.6) until its precondition is met after
	// all. An interruption is no wall of the way.
	static currentWall( node ) {
		const _tried = node.preconditionsTried || new Set();
		const _met = wall => Boolean( node.preconditionMet?.( wall.precondition?.id ) );
		const _handled = wall => ( wall.cause === 'precondition_missing' && ( _met( wall ) || _tried.has( wall.precondition?.id ) ) )
			|| ( wall.cause === 'child_failed' && _met( wall ) );
		const _open = [ ...node.walls ].reverse().find( wall => wall.cause !== 'interrupted' && !_handled( wall ) );
		return _open?.cause || null;
	}

	_ineligible( strategy, facts ) {
		return Chooser._unfit( strategy, facts ) || Chooser._blocked( strategy, facts );
	}

	// What the strategy is for: an open outcome, this depth, this kind of goal and concern, and the current wall.
	static _unfit( strategy, { node, criterion, wall, rank } ) {
		if ( !criterion ) { return 'serves no open outcome'; }
		if ( strategy.depth !== undefined && strategy.depth !== node.depth ) { return 'meant for another depth'; }
		if ( strategy.kind && strategy.kind !== node.contract.spec.kind ) { return 'meant for another kind of goal'; }
		if ( strategy.intents && !strategy.intents.includes( node.contract.spec.scope?.intent ) ) { return 'meant for another concern'; }
		if ( !wall && !Chooser.classes( strategy ).includes( 'direct' ) ) { return 'not the direct way'; }
		if ( wall && rank < 0 ) { return 'the diagnosis of the wall does not lead to this class'; }
		return null;
	}

	// What stands in its way now: an open attempt, the attempts so far, G2, the chance and the budget.
	static _blocked( strategy, { node, criterion, wall, chance, budgetLeft, cost, exclude, open = [] } ) {
		const _open = node.plan?.open && node.plan.strategy === strategy.id
			|| open.some( item => item.strategy === strategy.id && ( !item.criterion || item.criterion === criterion.id ) );
		if ( _open ) { return 'an attempt of it is still open'; }
		if ( exclude && exclude === strategy.id ) { return 'just tried; another way means another strategy'; }
		if ( node.refused?.has( strategy.id ) ) { return 'G2 refused its plan'; }
		// U3: a strategy chosen to answer this wall that ran into it again is no other way any more; alternating between
		// two of them would spend every start token. A precondition met since (R7), a person's "try once more" or a
		// changed goal clears it: the judgment then forgets those attempts.
		const _hit = item => item?.strategy === strategy.id && item.wall === wall && item.cause === wall;
		if ( wall && ( node.tried || [] ).some( _hit ) ) { return 'it already hit this wall'; }
		// Written so that NaN (an unreadable deadline, a broken curve, an unknown cost) never passes.
		if ( !( chance >= Chooser.THETA ) ) { return 'chance below θ'; }
		if ( !( cost <= budgetLeft ) ) { return 'over budget'; }
		return null;
	}

} );
