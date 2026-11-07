// F_s(t): the chance that an attempt of strategy s meets its criterion within t hours. This version uses the
// start curve from the catalog, F0(t) = p0 · (1 − e^(−t/τ)). A learned estimator (paper, chapter 20) replaces
// this class under the same name and reads the attempt journal, which is complete from day one.

app.define( 'Core.Strategy.TargetCurve', [], () => class TargetCurve {

	// A chance is always in [0, p0] with p0 in [0, 1]; a curve or a time that is no number gives no chance at all.
	value( strategy, hours ) {
		const { p0 = 0.5, tauH = 24 } = strategy?.startCurve || {};
		// Numbers, or text that is a number (a catalog read from JSON by hand); anything else is no number.
		const _number = item => ( typeof item === 'number' ? item : typeof item === 'string' && item.trim() ? Number( item ) : NaN );
		const [ _p0, _tau, _hours ] = [ p0, tauH, hours ].map( _number );
		if ( !( _p0 >= 0 && _p0 <= 1 ) || !( _tau > 0 ) || Number.isNaN( _hours ) ) { return 0; }
		const _chance = _p0 * ( 1 - Math.exp( -Math.max( 0, _hours ) / _tau ) );
		return Number.isFinite( _chance ) ? Math.min( _p0, Math.max( 0, _chance ) ) : 0;
	}

} );
