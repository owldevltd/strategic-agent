// Strategy adaptation by diagnosis (5.6): wall → cause as a hypothesis → class of strategies → concrete moves. The
// catalog and the mission say which hypotheses a cause stands for, in order; a person's decisions about walls the
// system cannot read yet are learned (signed in the memory, read through G5) and used the next time. A lesson of this
// kind only narrows the choice among allowed strategies, it never allows anything (G-9).

app.define( 'Core.Strategy.Diagnosis', [], () => class Diagnosis {

	static DECIDED = 'decided_by_person';

	static load( mission ) {
		const _path = app.lib( 'node:path' ).join( app.root, 'catalog', 'diagnosis.json' );
		const _base = JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) ).causes;
		return new Diagnosis( { ..._base, ...( mission?.diagnosis || {} ) } );
	}

	constructor( causes = {}, learned = [] ) {
		this.causes = causes;
		this.learned = learned;
	}

	// → the hypotheses for a cause, in order, or null when the system cannot read this wall yet. kind: the kind of task
	// asking; a decision learned for another kind is not used there (an entry without a kind was not learned).
	of( cause, kind = undefined ) {
		// Only the table's own entries, each a list of hypotheses; never a name of Object.prototype, never a text.
		const _entry = Object.hasOwn( this.causes, cause ) ? this.causes[ cause ] : null;
		const _known = Array.isArray( _entry ) ? _entry.filter( item => item && typeof item === 'object' ) : [];
		const _mine = item => item?.cause === cause && ( kind === undefined || item.kind === undefined || item.kind === kind );
		// A code, as every hypothesis (G4 takes no free text into a lesson); who decided stays with the learned entry.
		const _learned = this.learned.filter( _mine ).map( item => ( { hypothesis: Diagnosis.DECIDED, class: item.class } ) );
		const _all = [ ..._known, ..._learned ];
		return _all.length ? _all : null;
	}

	// The position of a strategy's class among the hypotheses (lower is earlier), or -1 when the wall does not lead to it.
	rank( cause, strategyClass, kind = undefined ) {
		const _hypotheses = this.of( cause, kind ) || [];
		const _exact = _hypotheses.findIndex( item => item.class === strategyClass );
		if ( _exact >= 0 ) { return _exact; }
		const _any = _hypotheses.findIndex( item => item.class === '*' );
		return _any >= 0 && strategyClass !== 'direct' ? _any : ( _any >= 0 ? _any + 0.5 : -1 );
	}

} );
