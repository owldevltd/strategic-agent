// The sum of all payments under this contract stays at or below max. Amounts are summed as the gate sums them: in
// whole cents (0.10 + 0.20 is 0.30, not a float above it), and an amount that is no amount of at least 0 (negative,
// unreadable, missing) is a breach of its own: a "payment" of -500 never buys room for 500 really paid.

app.define( 'Core.Criteria.SumMax', [ 'Core.Criteria.Criterion' ], Criterion => class SumMax extends Criterion {

	static TYPE = 'sum_max';
	static KIND = 'invariant';
	static DESCRIBE = 'the total of all payments stays at or below max';
	static PARAMS = { max: { type: 'number', min: 0, describe: 'the maximum total amount' }, param: { type: 'string', optional: true, internal: true } };

	get param() {
		return this.values.param || 'amount';
	}

	// A cap on money admits every commitment that moves money, as the action table says: the move's own action carries
	// money, or an action that carries money commits to it (a payment, a refund, a purchase). A mission's own money
	// actions need no change here.
	admits( commitment, move = null ) {
		if ( typeof commitment !== 'string' || !commitment ) { return false; }
		const _actions = app.get( 'Lib.Actions' ).load();
		if ( typeof move?.action === 'string' && _actions.matches( 'carries:money', move.action ) ) { return true; }
		return Object.entries( _actions.table ).some( ( [ name, entry ] ) => entry?.commits === commitment && _actions.matches( 'carries:money', name ) );
	}

	check( facts, now = Date.now() ) {
		const _actions = app.get( 'Lib.Actions' ).load();
		const _paid = Criterion.deliveries( this.evidence( facts, now ), action => _actions.matches( 'carries:money', action ) );
		let _cents = 0;
		let _unreadable = 0;
		for ( const fact of _paid ) {
			const _amount = Criterion.cents( Criterion.param( fact.data, this.param ) );
			if ( _amount === null ) {
				_unreadable += 1;
			} else {
				_cents += _amount;
			}
		}
		// A limit that is no number (NaN) holds nothing: every sum breaks it.
		const _over = !( _cents <= Math.round( this.values.max * 100 ) );
		const _reason = [ _over ? `paid ${_cents / 100} > ${this.values.max}` : '', _unreadable ? `a payment without a readable ${this.param.slice( 0, 40 )}` : '' ];
		return { met: !_over && !_unreadable, evidence: _paid.map( fact => fact.id ), reason: _reason.filter( Boolean ).join( '; ' ) };
	}

	// A lower limit on the same parameter is stricter; a limit on another parameter does not limit this one at all.
	// other may be a criterion or a spec of the catalog ({ type, values }, K7).
	atLeastAsStrict( other ) {
		return this.type === other?.type && this.param === ( other.values?.param || 'amount' ) && this.values.max <= other.values?.max;
	}

	gateRules() {
		return [ { rule: 'sum_max', actions: [ 'carries:money' ], param: this.param, max: this.values.max } ];
	}

} );
