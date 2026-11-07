// Calibration instead of self-assessment (B7). What a model says about its own certainty does not count. A person
// checks a sample of every AI step (one answer in twenty); the measured error rate is logged per role. When it
// rises above the threshold, the step switches to a person's check of every single answer, and an answer the
// person rejects is not used: it counts as an answer that broke its step contract, so the executor hands it to a
// person with the reason (6.4). Nothing waits forever: a check has a deadline (validMinutes); a sample nobody checked
// in time counts for nothing, and in the strict mode an answer nobody checked in time is not used either. The counts
// live in the core's log (calibration_sample), so a role that needs every answer checked stays strict after a
// restart (18).

app.define( 'Core.Ai.Calibration', [], () => class Calibration {

	constructor( { board, log = null, every = 20, threshold = 0.05, minimum = 5, validMinutes = 60, now = () => Date.now() } ) {
		Object.assign( this, { board, log, every, threshold, minimum, validMinutes, now } );
		this.stats = Calibration.restore( log );
	}

	// The counts per role as the last sample of each role in the log left them; seen starts again at 0.
	static restore( log ) {
		const _stats = new Map();
		const _rows = typeof log?.db?.all === 'function'
			? log.db.all( 'SELECT data FROM events WHERE kind = :kind AND source = :source ORDER BY id', { kind: 'calibration_sample', source: log.source } )
			: [];
		for ( const row of _rows ) {
			let _data;
			try {
				_data = JSON.parse( row.data );
			} catch {
				continue;
			}
			const { role, checked, wrong } = _data || {};
			if ( typeof role === 'string' && Number.isInteger( checked ) && Number.isInteger( wrong ) && wrong >= 0 && wrong <= checked ) {
				_stats.set( role, { seen: 0, checked, wrong } );
			}
		}
		return _stats;
	}

	_of( role ) {
		if ( !this.stats.has( role ) ) { this.stats.set( role, { seen: 0, checked: 0, wrong: 0 } ); }
		return this.stats.get( role );
	}

	strict( role ) {
		const _s = this._of( role );
		return _s.checked >= this.minimum && _s.wrong / _s.checked > this.threshold;
	}

	// Called with every answer that kept its step contract.
	async review( role, input, answer ) {
		const _s = this._of( role );
		_s.seen++;
		if ( this.strict( role ) ) {
			const _right = await this._ask( role, input, answer, 'Every answer of this step is checked, its error rate is too high.' );
			if ( _right !== true ) {
				const _why = _right === false ? `a person rejected the ${role} answer` : `nobody checked the ${role} answer in time`;
				throw new Error( `answer breaks the step contract: ${_why} (B7)` );
			}
			return;
		}
		if ( _s.seen % this.every === 0 ) {
			this._ask( role, input, answer, 'A random sample.' ).catch( app.fail );
		}
	}

	async _ask( role, input, answer, why ) {
		const _node = { id: `ai:${role}`, contract: {}, emit: ( kind, data ) => this.log?.append( kind, data ) };
		const _answer = await this.board.ask( _node, {
			question: `${why} Is this ${role} answer right? Input: ${Calibration.show( input )} Answer: ${Calibration.show( answer )}`,
			options: [ 'right', 'wrong' ], recommendation: 'right', minutes: 1, kind: 'check', reason: 'B7',
			deadline: new Date( this.now() + this.validMinutes * 60000 ).toISOString(),
		} );
		if ( !_answer.choice ) { return null; }
		const _s = this._of( role );
		_s.checked++;
		if ( _answer.choice === 'wrong' ) { _s.wrong++; }
		this.log?.append( 'calibration_sample', { role, choice: _answer.choice, checked: _s.checked, wrong: _s.wrong, strict: this.strict( role ) } );
		return _answer.choice === 'right';
	}

	// What the person sees of a value, short; a value JSON cannot show (undefined, a BigInt) is shown as text.
	static show( value ) {
		let _text;
		try {
			_text = JSON.stringify( value );
		} catch {
			_text = undefined;
		}
		return ( _text ?? String( value ) ).slice( 0, 400 );
	}

} );
