// Nothing about fewer than k people leaves. Individual records are confidential (10.4); this goal allows them to
// leave only as a group the gate can count, and the gate refuses any group below k. The evidence is the gate's own
// receipts: no release it executed was about fewer than k people. A group is counted as the gate counts it: distinct
// ids, so one person listed k times, or padded with empty entries, is no group of k; an entry that is no id refuses
// the whole release (fail closed). An empty group [] is a release about nobody, below every k.

app.define( 'Core.Criteria.MinGroup', [ 'Core.Criteria.Criterion' ], Criterion => class MinGroup extends Criterion {

	static TYPE = 'min_group';
	static KIND = 'invariant';
	static DESCRIBE = 'nothing about fewer than k people may leave';
	static PARAMS = { k: { type: 'integer', min: 2, describe: 'smallest group size' } };

	check( facts, now = Date.now() ) {
		const _breaches = [];
		const _reasons = new Set();
		for ( const fact of Criterion.releases( this.evidence( facts, now ) ) ) {
			const _people = Criterion.people( fact.data.cohort );
			const _reason = !_people ? 'a release whose group names someone who is no id' : _people.size < this.values.k ? 'a release below the group size' : '';
			if ( _reason ) {
				_breaches.push( fact.id );
				_reasons.add( _reason );
			}
		}
		return { met: _breaches.length === 0, evidence: _breaches, reason: [ ..._reasons ].join( '; ' ) };
	}

	allows() {
		return [ { label: 'confidential', actions: [ 'carries:data' ], as: 'group' } ];
	}

	atLeastAsStrict( other ) {
		return this.type === other?.type && this.values.k >= other.values?.k;
	}

	gateRules() {
		return [ { rule: 'min_group', actions: [ 'carries:data' ], k: this.values.k } ];
	}

} );
