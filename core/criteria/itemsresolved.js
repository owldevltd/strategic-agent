// Outcome: every item of a collection ends in one of the allowed outcomes, for example every invoice either
// paid or handed to a person with evidence. Evidence per item comes from gate receipts (observation) or answered
// tickets (confirmation); nothing else resolves an item: not the agent's claim, not an AI's derivation (B3, B4), not a
// fact without any class. A fact without data resolves nothing and stops nothing.

app.define( 'Core.Criteria.ItemsResolved', [ 'Core.Criteria.Criterion' ], Criterion => class ItemsResolved extends Criterion {

	static TYPE = 'items_resolved';
	static KIND = 'outcome';
	static DESCRIBE = 'every item of a collection ends in one of the allowed outcomes';
	static EVIDENCE = [ 'item_resolved' ];
	static CLASSES = [ 'observation', 'confirmation' ];

	static PARAMS = {
		collection: { type: 'string', describe: 'what the items are, e.g. orders, tickets or invoices' },
		items: { type: 'list', describe: 'the ids of the items' },
		outcomes: { type: 'list', describe: 'allowed outcomes, e.g. done, refunded, handed to a person' },
	};

	// A move that settles an item with one of the allowed outcomes (its "resolves": paying it, a refund, a signed order)
	// makes the very commitment the goal asks for, whatever the mission calls it: the goal admits it. Any other move's
	// commitment is not admitted here.
	admits( commitment, move = null ) {
		const _outcome = move?.resolves?.outcome;
		return typeof commitment === 'string' && Boolean( commitment ) && typeof _outcome === 'string'
			&& Array.isArray( this.values.outcomes ) && this.values.outcomes.includes( _outcome );
	}

	check( facts, now = Date.now() ) {
		// A collection without items is no collection whose items all ended well (fail closed; G1 refuses it anyway).
		if ( !Array.isArray( this.values.items ) || !this.values.items.length ) { return { met: false, evidence: [], reason: 'no items to resolve' }; }
		const _evidence = [];
		const _outcomes = Array.isArray( this.values.outcomes ) ? this.values.outcomes : [];
		const _facts = this.evidence( facts, now ).filter( fact => fact.kind === 'item_resolved' && ItemsResolved.CLASSES.includes( fact.evidenceClass )
			&& fact.data && typeof fact.data === 'object' && _outcomes.includes( fact.data.outcome ) );
		const _open = this.values.items.filter( ( item ) => {
			const _fact = _facts.find( fact => fact.data.item === item );
			if ( _fact ) { _evidence.push( _fact.id ); }
			return !_fact;
		} );
		return { met: _open.length === 0, evidence: _evidence, reason: _open.length ? `open: ${_open.join( ', ' )}` : '' };
	}

} );
