// Each item (an invoice, say) gets the action at most once. The gate's ledger refuses a second one; the evidence is
// its receipts, one per item at most. Items are told apart as the gate tells them apart: the key as normalised text,
// so the invoice 4711 and '4711' are one invoice. A receipt without a readable key is a breach of its own, never one
// shared item (the gate refuses such an action, so its receipt cannot be clean). The same receipt delivered twice
// (same id) is one payment, not two (B1).

app.define( 'Core.Criteria.ExactlyOnce', [ 'Core.Criteria.Criterion' ], Criterion => class ExactlyOnce extends Criterion {

	static TYPE = 'exactly_once';
	static KIND = 'invariant';
	static DESCRIBE = 'each item gets the action at most once';
	static PARAMS = {
		key: { type: 'string', describe: 'the field that identifies an item, e.g. orderId or invoiceId' },
		action: { type: 'string', values: '@actions', describe: 'the action or class of actions, e.g. carries:money' },
	};

	check( facts, now = Date.now() ) {
		const _actions = app.get( 'Lib.Actions' ).load();
		const _seen = new Map();
		const _keyless = [];
		const _receipts = Criterion.deliveries( this.evidence( facts, now ), action => _actions.matches( this.values.action, action ) );
		for ( const fact of _receipts ) {
			const _item = Criterion.key( Criterion.param( fact.data, this.values.key ) );
			if ( !_item ) {
				_keyless.push( fact.id );
			} else if ( _seen.has( _item ) ) {
				_seen.get( _item ).push( fact.id );
			} else {
				_seen.set( _item, [ fact.id ] );
			}
		}
		const _twice = [ ..._seen.values() ].filter( ids => ids.length > 1 ).flat();
		const _reason = [ _twice.length ? 'an item got the action twice' : '', _keyless.length ? `an action without its ${String( this.values.key ).slice( 0, 40 )}` : '' ];
		return { met: !_twice.length && !_keyless.length, evidence: [ ..._twice, ..._keyless ], reason: _reason.filter( Boolean ).join( '; ' ) };
	}

	gateRules() {
		return [ { rule: 'exactly_once', actions: [ this.values.action ], key: this.values.key } ];
	}

} );
