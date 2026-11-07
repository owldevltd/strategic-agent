// G5, the read gate (chapters 7.2, 9.1, 10.2). All knowledge is checked when it is read, even the system's own
// lessons: the signature must still match (someone may have changed the store from outside), the lesson must go
// back to an attempt this system recorded, and only the fields that matter for choosing are handed on. A lesson
// that fails goes into quarantine and a person is told; it never reaches planning. The columns a row is found by
// (its kind, the lesson a correction belongs to) are not signed, so they must say what the signed data says, and a
// signed row copied under a new id is no second lesson: an attempt has one lesson.

app.define( 'Core.Check.ReadCheck', [ 'Core.Check.WriteCheck' ], WriteCheck => class ReadCheck {

	static GATE = 'G5';

	read( memory, { kind = null, journal, board = null, node = null } = {} ) {
		const _valid = [];
		const _quarantined = [];
		const _attempts = new Set();
		for ( const row of memory.lessonRows( kind ) ) {
			if ( row.status !== 'valid' ) { continue; }
			const _lesson = ReadCheck._parse( row.data );
			const _problem = ReadCheck._problem( memory, row, _lesson, { journal, attempts: _attempts } );
			if ( _problem ) {
				memory.quarantine( row.id );
				_quarantined.push( { id: row.id, problem: _problem } );
				continue;
			}
			_attempts.add( WriteCheck.attemptOf( _lesson.attempt ) );
			const _corrected = { ..._lesson, ...ReadCheck._corrections( memory, row, _quarantined ) };
			const { strategy, situation, result, provisional, signalAfterH, observationEnds, cause, contribution } = _corrected;
			_valid.push( { strategy, situation, result, provisional, signalAfterH, observationEnds, cause, contribution, labels: [ 'own' ] } );
		}
		if ( _quarantined.length ) {
			memory.log?.append( 'lessons_quarantined', { gate: ReadCheck.GATE, lessons: _quarantined } );
			if ( board && node ) {
				board.ask( node, {
					question: `${_quarantined.length} lesson(s) failed the read gate and were put into quarantine: ${_quarantined.map( item => item.problem ).join( '; ' )}.`,
					options: [ 'keep them in quarantine' ], recommendation: 'keep them in quarantine', minutes: 2,
				} ).catch( app.fail );
			}
		}
		return { gate: ReadCheck.GATE, lessons: _valid, quarantined: _quarantined };
	}

	// Why a lesson row may not be read, or null.
	static _problem( memory, row, lesson, { journal, attempts } ) {
		if ( !memory.verify( row.data, row.signature ) ) { return 'the signature does not match: changed outside the system'; }
		// An attempt is a whole number; anything else is looked up nowhere.
		const _attempt = WriteCheck.attemptOf( lesson?.attempt );
		if ( !_attempt || !journal.get( _attempt ) ) { return 'no attempt of this system behind it'; }
		if ( row.kind !== lesson.situation?.task ) { return 'the lesson was moved to another kind of task outside the system'; }
		if ( attempts.has( _attempt ) ) { return 'a second lesson of the same attempt: a copy of a signed row'; }
		return null;
	}

	// The corrections of a lesson (9.3), in order; one whose signature fails, that was signed for another lesson, or
	// whose change G4 would not store goes into quarantine and is not applied.
	static _corrections( memory, row, quarantined ) {
		const _change = {};
		for ( const correction of memory.corrections?.( row.id ) || [] ) {
			const _data = memory.verify( correction.data, correction.signature ) ? ReadCheck._parse( correction.data ) : null;
			const _problem = !_data ? 'a correction does not match its signature: changed outside the system'
				: _data.lesson !== row.id ? 'a correction was moved to another lesson outside the system'
					: WriteCheck.change( _data.change ).length ? 'a correction changes what a lesson may not hold (G4)' : null;
			if ( _problem ) {
				memory.quarantineCorrection( correction.id );
				quarantined.push( { id: `${row.id}/${correction.id}`, problem: _problem } );
				continue;
			}
			Object.assign( _change, _data.change );
		}
		return _change;
	}

	static _parse( text ) {
		try {
			return JSON.parse( text );
		} catch {
			return null;
		}
	}

} );
