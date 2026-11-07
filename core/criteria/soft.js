// weich (14, 14.1): a soft criterion in free text, e.g. "friendly and factual". An AI reviewer with fresh context
// gives its assessment when the node closes; it is a derivation and never closes a goal on its own. Only the
// verdict true is a yes: "no", "false" or an object are no verdict. The assessment made last counts.

app.define( 'Core.Criteria.Soft', [ 'Core.Criteria.Criterion' ], Criterion => class Soft extends Criterion {

	static TYPE = 'soft';
	static KIND = 'soft';
	static DESCRIBE = 'a soft criterion in free text, assessed by a reviewer, never decisive alone (weich)';
	static PARAMS = { text: { type: 'string', describe: 'what should be true, in words' } };

	static EVIDENCE = [ 'soft_assessed' ];

	check( facts, now = Date.now() ) {
		const _assessed = Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'soft_assessed' && fact.data?.criterion === this.id ) );
		return { met: _assessed?.data.met === true, evidence: _assessed ? [ _assessed.id ] : [], reason: _assessed ? '' : 'not assessed yet' };
	}

} );
