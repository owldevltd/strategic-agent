// Money only goes to accounts from our own master data. The account must be the system's own value (10.4): one
// read from a document is foreign and never fills the parameter (G2); the gate checks its own copy of the master
// data as well. The evidence is the gate's receipts: every payment it executed passed that check. The parameter it
// names is read as a field of the request, so a name of Object.prototype (__proto__, constructor) is refused.

app.define( 'Core.Criteria.AccountFromMaster', [ 'Core.Criteria.Criterion' ], Criterion => class AccountFromMaster extends Criterion {

	static TYPE = 'account_from_master';
	static KIND = 'invariant';
	static DESCRIBE = 'money only goes to accounts in our own master data';
	static PARAMS = {
		param: { type: 'string', describe: 'the parameter of the money action that names the account, e.g. iban' },
		kind: { type: 'string', optional: true, describe: 'the kind of master data that lists the accounts; account when none is named' },
	};

	// The parameter the goal names; none is no parameter (validate refuses the criterion, and no rule checks a guess).
	get param() {
		return typeof this.values.param === 'string' ? this.values.param : '';
	}

	validate() {
		const _problems = super.validate();
		if ( typeof this.values.param === 'string' && this.values.param in Object.prototype ) {
			_problems.push( `${this.id}: param must name a field of its own, not ${this.values.param}` );
		}
		if ( typeof this.values.param === 'string' && !this.values.param.trim() ) {
			_problems.push( `${this.id}: param must name the parameter that holds the account` );
		}
		return _problems;
	}

	check( facts, now = Date.now() ) {
		const _actions = app.get( 'Lib.Actions' ).load();
		const _paid = Criterion.deliveries( this.evidence( facts, now ), action => _actions.matches( 'carries:money', action ) );
		const _without = _paid.filter( fact => fact.source !== 'gate' );
		return { met: _without.length === 0, evidence: _paid.map( fact => fact.id ), reason: _without.length ? 'a payment without the gate\'s check' : '' };
	}

	flowRules() {
		return [ { actions: [ 'carries:money' ], param: this.param, mustHave: [ 'own' ] } ];
	}

	gateRules() {
		return [ { rule: 'known_account', actions: [ 'carries:money' ], param: this.param, kind: this.values.kind || 'account' } ];
	}

	// The same rule is the same parameter checked against the same master data, however its values are written. other
	// may be a criterion or a spec of the catalog ({ type, values }, K7).
	atLeastAsStrict( other ) {
		const _rule = values => `${values?.param ?? ''} ${values?.kind || 'account'}`;
		return this.type === other?.type && _rule( this.values ) === _rule( other.values );
	}

} );
