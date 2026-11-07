// Each of these actions needs a person to approve exactly this action, also where its criticality alone would not
// ask for one. The approval becomes a one-time token at the gate; the evidence is the approval on every receipt.

app.define( 'Core.Criteria.HumanApproval', [ 'Core.Criteria.Criterion' ], Criterion => class HumanApproval extends Criterion {

	static TYPE = 'human_approval';
	static KIND = 'invariant';
	static DESCRIBE = 'a person approves each of these actions before it happens';
	static PARAMS = { actions: { type: 'list', values: '@actions', describe: 'actions or classes of actions that need approval' } };

	check( facts, now = Date.now() ) {
		const _actions = app.get( 'Lib.Actions' ).load();
		const _unapproved = Criterion.deliveries( this.evidence( facts, now ), action => _actions.applies( this.values.actions, action ) )
			.filter( fact => !fact.data.approval );
		return { met: _unapproved.length === 0, evidence: _unapproved.map( fact => fact.id ), reason: _unapproved.length ? 'an action went out without approval' : '' };
	}

	gateRules() {
		return [ { rule: 'human_approval', actions: this.values.actions } ];
	}

	// Asking a person for more actions is stricter, for fewer looser; the order of the list does not matter (G1, K7).
	atLeastAsStrict( other ) {
		const _list = item => ( Array.isArray( item?.values?.actions ) ? item.values.actions : [] );
		return this.type === other?.type && _list( other ).length > 0 && _list( other ).every( action => _list( this ).includes( action ) );
	}

} );
