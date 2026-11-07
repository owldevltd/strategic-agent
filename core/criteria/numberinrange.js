// zahl_im_bereich (14.1): the measured value lies within the range. Evidence is an observation with the time it was
// measured; the latest measurement counts, latest by the time it was measured, not by the order it arrived in. A
// range must not be empty (K6). A value is a number or numeric text; null, '', false or [] are a failed
// measurement, never a measurement of zero.

app.define( 'Core.Criteria.NumberInRange', [ 'Core.Criteria.Criterion' ], Criterion => class NumberInRange extends Criterion {

	static TYPE = 'number_in_range';
	static KIND = 'outcome';
	static DESCRIBE = 'a measured value lies within the range (zahl_im_bereich)';
	static PARAMS = {
		quantity: { type: 'string', describe: 'what is measured, e.g. answers:design' },
		min: { type: 'number', optional: true, describe: 'lowest allowed value' },
		max: { type: 'number', optional: true, describe: 'highest allowed value' },
	};

	static EVIDENCE = [ 'measured' ];

	validate() {
		const _problems = super.validate();
		// A bound of null or '' is no bound: { min: null, max: null } bounds nothing.
		if ( typeof this.values.min !== 'number' && typeof this.values.max !== 'number' ) { _problems.push( `${this.id}: needs min or max` ); }
		if ( NumberInRange.bound( this.values.min, -Infinity ) > NumberInRange.bound( this.values.max, Infinity ) ) {
			_problems.push( `${this.id}: the range is empty (K6)` );
		}
		return _problems;
	}

	// A bound is a number; null, '' or anything else is no bound at all.
	static bound( value, none ) {
		return typeof value === 'number' ? value : none;
	}

	check( facts, now = Date.now() ) {
		const _measured = Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'measured' && fact.evidenceClass === 'observation'
			&& fact.data?.quantity === this.values.quantity ) );
		if ( !_measured ) { return { met: false, evidence: [], reason: 'not measured' }; }
		const _value = NumberInRange.number( _measured.data.value );
		const _met = _value >= NumberInRange.bound( this.values.min, -Infinity )
			&& _value <= NumberInRange.bound( this.values.max, Infinity );
		return { met: _met, evidence: [ _measured.id ], reason: Number.isNaN( _value ) ? `${this.values.quantity} is no number` : `${this.values.quantity} is ${_value}` };
	}

	// A number, or text that is one in decimal notation; anything else is NaN and meets no range.
	static number( value ) {
		if ( typeof value === 'number' ) { return value; }
		return typeof value === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i.test( value ) ? Number( value ) : NaN;
	}

	// The same quantity, in a range no wider: a higher minimum or a lower maximum is stricter. Another quantity is no
	// tightening at all. other may be a criterion or a spec of the catalog ({ type, values }, K7).
	atLeastAsStrict( other ) {
		const _min = values => NumberInRange.bound( values?.min, -Infinity );
		const _max = values => NumberInRange.bound( values?.max, Infinity );
		const _same = this.type === other?.type && this.values.quantity === other.values?.quantity;
		return _same && _min( this.values ) >= _min( other.values ) && _max( this.values ) <= _max( other.values );
	}

} );
