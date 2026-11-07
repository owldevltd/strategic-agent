// G4, the write gate of the memory (chapters 7.2, 9.3, 20). A lesson has the fixed schema of 20.1: the attempt, its
// strategy, the situation, the result (and what it was provisionally), the hours to the first signal, the end of the
// observation, the contribution and the contract's success, and the evidence. It has no field for rights,
// gates, rules or the catalog, so a lesson can never change what is allowed (G-9); no free text, so it cannot
// carry instructions. A lesson must point at an attempt the system itself recorded. Anything else is not stored.

app.define( 'Core.Check.WriteCheck', [ 'Core.Check.FactCheck' ], FactCheck => class WriteCheck {

	static GATE = 'G4';
	static FIELDS = [ 'attempt', 'strategy', 'situation', 'result', 'provisional', 'signalAfterH', 'observationEnds', 'cause', 'hypothesis',
		'contribution', 'contractSuccess', 'evidence' ];

	// What the model may add to a lesson (4.1 step 6); everything else is observed by code.
	static PROPOSED = [ 'attempt', 'hypothesis' ];

	static SITUATION = [ 'task', 'contact', 'weekday', 'month', 'wall', 'depth' ];
	static RESULTS = [ 'fulfilled', 'wall', 'timeout', 'late_effect' ];
	static OBSERVATION = [ 'fromH', 'reason', 'trigger' ];
	static EVIDENCE = [ 'node', 'run' ];

	// What the journal observes after the fact, and so all a correction may change (9.3): never the strategy, the
	// situation or the evidence.
	static CORRECTABLE = [ 'result', 'provisional', 'signalAfterH', 'observationEnds', 'contribution' ];

	check( lesson, { journal = null, strategies = [], causes = [], diagnosis = null } = {} ) {
		if ( !WriteCheck.object( lesson ) ) {
			return { gate: WriteCheck.GATE, ok: false, problems: [ 'a lesson is an object in the schema of 20.1' ] };
		}
		const _problems = [ ...WriteCheck.schema( lesson ), ...WriteCheck.codes( lesson, { strategies, causes, diagnosis } ) ];
		const _flat = { ...lesson, situation: undefined, evidence: undefined, observationEnds: undefined };
		const _values = { ..._flat, ...( lesson.situation || {} ), ...( lesson.observationEnds || {} ) };
		for ( const [ name, value ] of Object.entries( _values ) ) {
			if ( value !== undefined && !FactCheck.plain( value ) ) { _problems.push( `${name} carries free text` ); }
		}
		// The evidence names the node and the run by their ids, nothing more.
		for ( const [ name, value ] of Object.entries( WriteCheck.object( lesson.evidence ) ? lesson.evidence : {} ) ) {
			if ( value !== undefined && !( typeof value === 'string' && FactCheck.ID.test( value ) ) ) { _problems.push( `evidence.${name} carries free text` ); }
		}
		// An attempt id is a whole number the journal gave; a list or a text the journal would coerce is none.
		const _attempt = WriteCheck.attempt( lesson.attempt ) ? journal?.get( lesson.attempt ) : null;
		if ( !_attempt || _attempt.strategy !== lesson.strategy || _attempt.node !== lesson.evidence?.node ) {
			_problems.push( 'the evidence is not an attempt this system recorded for that strategy' );
		}
		return { gate: WriteCheck.GATE, ok: _problems.length === 0, problems: _problems };
	}

	// A proposal of the model for a lesson: the hypothesis of the attempt's wall, nothing else (G-9), and only for the
	// attempt of this lesson.
	proposal( proposal, lesson, known ) {
		if ( !WriteCheck.object( proposal ) ) {
			return { gate: WriteCheck.GATE, ok: false, problems: [ 'a proposal is an object of the fields the model may propose' ], lesson: null };
		}
		const _say = name => ( WriteCheck.FIELDS.includes( name ) ? `${name} is observed by code, not proposed`
			: `${name} is not part of a lesson; a lesson never carries rights, gates, rules or goals` );
		const _problems = Object.keys( proposal ).filter( name => !WriteCheck.PROPOSED.includes( name ) ).map( _say );
		if ( proposal.attempt !== undefined && WriteCheck.attemptOf( proposal.attempt ) !== lesson?.attempt ) {
			_problems.push( `the proposal is for attempt ${String( proposal.attempt ).slice( 0, 20 )}, not for this lesson` );
		}
		const _lesson = { ...lesson, hypothesis: proposal.hypothesis };
		const _check = _problems.length ? { problems: [] } : this.check( _lesson, known );
		const _all = [ ..._problems, ..._check.problems ];
		return { gate: WriteCheck.GATE, ok: !_all.length, problems: _all, lesson: _all.length ? null : _lesson };
	}

	// G4 for a correction of a lesson (9.3): only fields the journal observes later, each with a value a lesson may
	// hold. → problems
	static change( change ) {
		if ( !WriteCheck.object( change ) || !Object.keys( change ).length ) { return [ 'a correction is an object of observed fields' ]; }
		const _problems = Object.keys( change ).filter( name => !WriteCheck.CORRECTABLE.includes( name ) )
			.map( name => `${name} cannot be corrected; only what the journal observes later` );
		const _has = name => Object.hasOwn( change, name ) && change[ name ] !== undefined;
		const { result, provisional, signalAfterH, observationEnds, contribution } = change;
		if ( _has( 'result' ) && !WriteCheck.RESULTS.includes( result ) ) { _problems.push( `result must be one of ${WriteCheck.RESULTS.join( ', ' )}` ); }
		if ( _has( 'provisional' ) && provisional !== null && provisional !== 'timeout' ) { _problems.push( 'only a timeout is provisional (B8)' ); }
		if ( _has( 'signalAfterH' ) && signalAfterH !== null && !( Number.isFinite( signalAfterH ) && signalAfterH >= 0 ) ) {
			_problems.push( 'signalAfterH is no number of hours' );
		}
		if ( _has( 'observationEnds' ) && observationEnds !== null ) {
			const _end = Object.entries( WriteCheck.object( observationEnds ) ? observationEnds : { value: observationEnds } );
			const _plain = value => !Array.isArray( value ) && FactCheck.plain( value );
			const _wrong = _end.filter( ( [ name, value ] ) => !WriteCheck.OBSERVATION.includes( name ) || !_plain( value ) );
			_problems.push( ..._wrong.map( ( [ name ] ) => `observationEnds.${name} is not part of a lesson, or carries free text` ) );
		}
		if ( _has( 'contribution' ) && !( Array.isArray( contribution ) && FactCheck.plain( contribution ) ) ) {
			_problems.push( 'contribution carries free text' );
		}
		return _problems;
	}

	static object( value ) {
		return Boolean( value ) && typeof value === 'object' && !Array.isArray( value );
	}

	static attempt( value ) {
		return Number.isInteger( value ) && value > 0;
	}

	// The attempt a proposal names: a whole number, also when the model wrote it as text; anything else names none.
	static attemptOf( value ) {
		if ( WriteCheck.attempt( value ) ) { return value; }
		return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test( value ) ? Number( value ) : null;
	}

	// Every code in a lesson is one the system knows: result, cause, the hypothesis of that cause, the strategy.
	static codes( lesson, { strategies, causes, diagnosis } ) {
		const _problems = [];
		// Only a known cause is looked up in the diagnosis, so no name of the object prototype ever reaches it.
		const _known = typeof lesson.cause === 'string' && ( causes.codes?.() || causes ).includes( lesson.cause );
		const _of = _known && lesson.hypothesis !== undefined ? diagnosis?.of( lesson.cause ) : null;
		const _hypotheses = ( Array.isArray( _of ) ? _of : [] ).map( item => item?.hypothesis );
		if ( lesson.hypothesis !== undefined && !_hypotheses.includes( lesson.hypothesis ) ) {
			_problems.push( `${lesson.hypothesis} is not a hypothesis of the wall ${lesson.cause}` );
		}
		if ( !WriteCheck.RESULTS.includes( lesson.result ) ) {
			_problems.push( `result must be one of ${WriteCheck.RESULTS.join( ', ' )}` );
		}
		if ( lesson.provisional && lesson.provisional !== 'timeout' ) { _problems.push( 'only a timeout is provisional (B8)' ); }
		if ( lesson.cause && !_known ) {
			_problems.push( `unknown cause ${lesson.cause}` );
		}
		if ( !strategies.some( item => item.id === lesson.strategy ) && !/^proposed-\d+$/.test( lesson.strategy ) ) {
			_problems.push( `unknown strategy ${lesson.strategy}` );
		}
		return _problems;
	}

	// Only the fields of the schema: a lesson never carries rights, gates, rules or the catalog (G-9).
	static schema( lesson ) {
		const _problems = Object.keys( lesson ).filter( name => !WriteCheck.FIELDS.includes( name ) )
			.map( name => `${name} is not part of a lesson; a lesson never carries rights, gates, rules or the catalog` );
		const _inner = [ [ 'situation', WriteCheck.SITUATION ], [ 'observationEnds', WriteCheck.OBSERVATION ], [ 'evidence', WriteCheck.EVIDENCE ] ];
		for ( const [ part, allowed ] of _inner ) {
			const _extra = Object.keys( lesson[ part ] || {} ).filter( name => !allowed.includes( name ) );
			_problems.push( ..._extra.map( name => `${part}.${name} is not part of a lesson` ) );
		}
		return _problems;
	}

} );
