// Nothing new is sent after the deadline plus the buffer, even if the core is down: every permission at the
// gate expires on its own (G-1b). The time is one instant in core and gate alike (ISO 8601 with its zone); one that
// cannot be read has passed (fail closed).

app.define( 'Core.Criteria.Deadline', [ 'Core.Criteria.Criterion' ], Criterion => class Deadline extends Criterion {

	static TYPE = 'deadline';
	static KIND = 'invariant';
	static DESCRIBE = 'set by the system from deadlineHours; never write it yourself';
	static INTERNAL = true;
	static PARAMS = { at: { type: 'datetime' } };

	check( _facts, now = Date.now() ) {
		const _open = now <= Criterion.time( this.values.at );
		return { met: _open, evidence: [], reason: _open ? '' : 'deadline passed' };
	}

	gateRules() {
		return [ { rule: 'expires', actions: [ '*' ], at: this.values.at } ];
	}

	// An earlier deadline is stricter; the same instant in another notation is the same deadline.
	atLeastAsStrict( other ) {
		return this.type === other?.type && Criterion.time( this.values.at ) <= Criterion.time( other.values?.at );
	}

} );
