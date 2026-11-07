// zustand (14.1): the object has the value at the time of the check. Evidence is an observation read from the
// leading system, no older than its validity (B2). The latest reading is the one read last (its own time), not the
// one that arrived last.

app.define( 'Core.Criteria.StateIs', [ 'Core.Criteria.Criterion' ], Criterion => class StateIs extends Criterion {

	static TYPE = 'state_is';
	static KIND = 'outcome';
	static DESCRIBE = 'the object has the value when checked (zustand)';
	static PARAMS = {
		object: { type: 'string', describe: 'e.g. calendar' },
		field: { type: 'string', describe: 'e.g. slot:2026-11-11T10:00' },
		value: { type: 'string', describe: 'e.g. free' },
	};

	static EVIDENCE = [ 'state_read' ];

	check( facts, now = Date.now() ) {
		const _read = Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'state_read' && fact.evidenceClass === 'observation'
			&& fact.data?.object === this.values.object && fact.data.field === this.values.field ) );
		const _met = _read?.data.value === this.values.value;
		return { met: _met, evidence: _met ? [ _read.id ] : [], reason: _read ? `reads ${_read.data.value}` : 'not read' };
	}

} );
