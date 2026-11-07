// bestaetigt_durch (14.1, 3.4): the role said yes to exactly this question. Evidence is an acknowledged ticket of
// that role. Where no channel can deliver the evidence a criterion needs, G1 adds this one and the person becomes
// the channel (K4). The role's latest answer to the question counts: a later "no" takes back an earlier "yes".

app.define( 'Core.Criteria.ConfirmedBy', [ 'Core.Criteria.Criterion', 'Lib.Hash' ], ( Criterion, Hash ) => class ConfirmedBy extends Criterion {

	static TYPE = 'confirmed_by';
	static KIND = 'outcome';
	static DESCRIBE = 'a person in the role said yes to exactly this question (bestaetigt_durch)';
	static PARAMS = {
		role: { type: 'string', describe: 'e.g. client' },
		question: { type: 'string', describe: 'the question the person answers' },
	};

	static EVIDENCE = [ 'confirmation' ];

	// Facts carry no free text: the question is known to a fact only by its hash.
	static key( question ) {
		return Hash.sha256( String( question ) ).slice( 0, 16 );
	}

	check( facts, now = Date.now() ) {
		const _key = ConfirmedBy.key( this.values.question );
		const _answer = Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'confirmation' && fact.evidenceClass === 'confirmation'
			&& fact.data?.role === this.values.role && fact.data.question === _key ) );
		const _yes = _answer?.data.choice === 'yes' ? _answer : null;
		return { met: Boolean( _yes ), evidence: _yes ? [ _yes.id ] : [], reason: _yes ? '' : `not confirmed by ${this.values.role}` };
	}

} );
