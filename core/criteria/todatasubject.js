// A person's own data goes to that person, and only there (a data subject's copy, GDPR art. 15): a release about
// exactly one person, to the address the operator's master data holds for that person (kind "contact", values
// "<id> <address>"). The goal allows confidential data to leave this way and no other; the gate checks the pair
// against its own master data, so neither a model nor a message can name another address. The evidence is the gate's
// receipts: every release it executed was about one person.

app.define( 'Core.Criteria.ToDataSubject', [ 'Core.Criteria.Criterion' ], Criterion => class ToDataSubject extends Criterion {

	static TYPE = 'to_data_subject';
	static KIND = 'invariant';
	static DESCRIBE = 'data about a person leaves only to that person, at the address our master data holds for them';
	static PARAMS = {};

	check( facts, now = Date.now() ) {
		const _breaches = [];
		for ( const fact of Criterion.releases( this.evidence( facts, now ) ) ) {
			const _people = Criterion.people( fact.data.cohort );
			if ( !_people || _people.size !== 1 ) { _breaches.push( fact.id ); }
		}
		return { met: _breaches.length === 0, evidence: _breaches, reason: _breaches.length ? 'a release that was not about exactly one person' : '' };
	}

	allows() {
		return [ { label: 'confidential', actions: [ 'carries:data' ], as: 'subject' } ];
	}

	atLeastAsStrict( other ) {
		return this.type === other?.type;
	}

	gateRules() {
		return [ { rule: 'data_subject', actions: [ 'carries:data' ] } ];
	}

} );
