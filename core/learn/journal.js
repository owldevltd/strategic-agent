// Every attempt of a strategy, from day one (paper, chapter 20, L2): strategy, situation, start, the criterion it
// aims at and what led to it, its result with time (success after L4, final failure, or still open), the end of its
// observation with reason and trigger, its contribution and the contract's success. A timeout is a provisional result
// (B8): the attempt stays open, and a late signal corrects it to "late_effect" (L5). The observation runs until the
// horizon H of the attempt's moves, also after its node has closed. The three levels of L3 are kept apart: the result
// (what the attempt itself triggered), the contribution (criteria a fact from its origin met first, in time) and the
// contract's success. The learned estimator later reads exactly this; nothing has to be collected again.

app.define( 'Core.Learn.Journal', [], () => class Journal {

	static HORIZON_H = 168;
	static COLUMNS = {
		contribution: 'TEXT', criterion: 'TEXT', trigger: 'TEXT', provisional: 'TEXT', signalAt: 'TEXT', observationEnd: 'TEXT',
		horizonUntil: 'TEXT', contacts: 'TEXT', contractSuccess: 'INTEGER',
	};

	constructor( db, { now = () => Date.now() } = {} ) {
		this.db = db;
		this.now = now;
		this._listeners = [];
		this.db.exec( `CREATE TABLE IF NOT EXISTS attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, contract TEXT NOT NULL, strategy TEXT NOT NULL,
			situation TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, outcome TEXT, cause TEXT, cost REAL
		)` );
		const _have = new Set( this.db.all( 'PRAGMA table_info( attempts )' ).map( column => column.name ) );
		for ( const [ name, type ] of Object.entries( Journal.COLUMNS ).filter( ( [ column ] ) => !_have.has( column ) ) ) {
			this.db.exec( `ALTER TABLE attempts ADD COLUMN ${name} ${type}` );
		}
	}

	// A change to an attempt after the fact is told to whoever keeps lessons (9.3), with its reason as a code:
	// late_effect (L5), first_signal, late_credit (L4), observation_ended (L2).
	listen( fn ) {
		this._listeners.push( fn );
	}

	// An attempt is named by its number, also as plain decimal text; nothing else is a number here (true, [1], " 1 ",
	// "1e0" and "0x1" name no attempt, L4: a forged attempt field of a fact must not reach attempt 1).
	static id( value ) {
		const _number = typeof value === 'string' && /^[1-9][0-9]*$/.test( value ) ? Number( value ) : value;
		return Number.isSafeInteger( _number ) && _number > 0 ? _number : null;
	}

	get( id ) {
		const _id = Journal.id( id );
		return _id === null ? null : this.db.get( 'SELECT * FROM attempts WHERE id = :id', { id: _id } ) || null;
	}

	forNode( node ) {
		return this.db.all( 'SELECT * FROM attempts WHERE node = :node ORDER BY id', { node } );
	}

	// criterion: the one the strategy aims at; trigger: what led to its choice (the start, a wall, a review).
	start( node, strategy, situation = {}, { criterion = null, trigger = 'start', horizonH = Journal.HORIZON_H } = {} ) {
		const _now = this.now();
		const _result = this.db.run( `INSERT INTO attempts ( node, contract, strategy, situation, startedAt, criterion, trigger, horizonUntil,
			contribution, contacts ) VALUES ( :node, :contract, :strategy, :situation, :at, :criterion, :trigger, :horizon, '[]', '[]' )`, {
			node: node.id, contract: node.contract.hash, strategy: strategy.id, situation: JSON.stringify( situation ),
			at: new Date( _now ).toISOString(), criterion, trigger, horizon: new Date( _now + horizonH * 3600000 ).toISOString(),
		} );
		return Number( _result.lastInsertRowid );
	}

	// The result of the attempt: done, wall (a final failure) or timeout (provisional, the attempt stays open).
	end( id, { outcome, cause = null, cost = 0 } ) {
		this.db.run( 'UPDATE attempts SET endedAt = :at, outcome = :outcome, cause = :cause, cost = :cost WHERE id = :id AND endedAt IS NULL', {
			id: Journal.id( id ), outcome, cause, cost, at: new Date( this.now() ).toISOString(),
		} );
	}

	// L4: a criterion met first by a fact from this attempt's origin, within the criterion's deadline.
	credit( id, criterion ) {
		const _row = this.get( id );
		// A credit names the criterion it is for; without one it is no credit at all.
		if ( !_row || typeof criterion !== 'string' || !criterion ) { return; }
		const _list = JSON.parse( _row.contribution || '[]' );
		if ( _list.includes( criterion ) ) { return; }
		this.db.run( 'UPDATE attempts SET contribution = :list WHERE id = :id', { id: _row.id, list: JSON.stringify( [ ..._list, criterion ] ) } );
		this._tell( _row, { contribution: [ ..._list, criterion ] }, 'late_credit' );
	}

	// A signal of the attempt's own origin (an answer to what it sent). The first one is kept with its time; any signal
	// after a timeout corrects the result to "late_effect" (L5). After the horizon nothing is recorded any more.
	signal( id ) {
		const _row = this.get( id );
		const _late = _row?.outcome === 'timeout';
		if ( !_row || ( _row.signalAt && !_late ) || this._beyond( _row ) ) { return null; }
		const _at = _row.signalAt || new Date( this.now() ).toISOString();
		this.db.run( `UPDATE attempts SET signalAt = :at, outcome = CASE WHEN outcome = 'timeout' THEN 'late_effect' ELSE outcome END,
			provisional = CASE WHEN outcome = 'timeout' THEN 'timeout' ELSE provisional END WHERE id = :id`, { id: _row.id, at: _at } );
		const _change = { signalAfterH: Journal.hours( _row.startedAt, _at ), ...( _late ? { result: 'late_effect', provisional: 'timeout' } : {} ) };
		this._tell( _row, _change, _late ? 'late_effect' : 'first_signal' );
		return _change;
	}

	// The other side was contacted again by another attempt: the observation of the earlier ones ends there, with the
	// reason and what triggered the new contact (L2). A new contact changes what the other side does for every attempt
	// that reached it, so this holds across nodes. The contacting attempt never ends its own observation, whatever form
	// its number comes in.
	contact( node, target, { by, trigger } ) {
		if ( !target ) { return; }
		const _by = Journal.id( by );
		for ( const row of this.db.all( 'SELECT id, contacts FROM attempts WHERE observationEnd IS NULL ORDER BY id' ) ) {
			if ( row.id !== _by && Journal.list( row.contacts ).includes( target ) ) {
				this.endObservation( row.id, { reason: 'contact', trigger } );
			}
		}
		const _own = this.get( _by );
		const _contacts = Journal.list( _own?.contacts );
		if ( _own && !_contacts.includes( target ) ) {
			this.db.run( 'UPDATE attempts SET contacts = :list WHERE id = :id', { id: _own.id, list: JSON.stringify( [ ..._contacts, target ] ) } );
		}
	}

	endObservation( id, { reason, trigger = null } ) {
		const _row = this.get( id );
		if ( !_row || _row.observationEnd ) { return; }
		const _end = { fromH: Journal.hours( _row.startedAt, new Date( this.now() ).toISOString() ), reason, trigger };
		this.db.run( 'UPDATE attempts SET observationEnd = :end WHERE id = :id', { id: _row.id, end: JSON.stringify( _end ) } );
		this._tell( _row, { observationEnds: _end }, 'observation_ended' );
	}

	// The horizon H of an attempt passed: its observation ends (also after the node closed). Horizons are compared as
	// times, as _beyond() does: as text, a year past 9999 ("+013434-…") would sort before today.
	sweep() {
		for ( const row of this.db.all( 'SELECT id, horizonUntil FROM attempts WHERE observationEnd IS NULL ORDER BY id' ) ) {
			if ( this._beyond( row ) ) {
				this.endObservation( row.id, { reason: 'horizon', trigger: 'horizon' } );
			}
		}
	}

	contractSuccess( node, success ) {
		this.db.run( 'UPDATE attempts SET contractSuccess = :ok WHERE node = :node', { node: node.id, ok: success ? 1 : 0 } );
	}

	// Attempts still open for the choice (19): running, or with a provisional timeout whose observation has not ended.
	open( nodeId ) {
		return this.db.all( `SELECT strategy, criterion FROM attempts WHERE node = :node AND observationEnd IS NULL
			AND ( endedAt IS NULL OR outcome = 'timeout' )`, { node: nodeId } );
	}

	all() {
		return this.db.all( 'SELECT * FROM attempts ORDER BY id' );
	}

	_beyond( row ) {
		return row.horizonUntil && Date.parse( row.horizonUntil ) < this.now();
	}

	// A listener's failure is its own: the journal has already written the change, and every other listener still hears
	// of it (a failing lesson store must not stop the sweep, nor the choice that runs it).
	_tell( row, change, reason ) {
		for ( const fn of this._listeners ) {
			try {
				fn( row.id, change, reason );
			} catch ( error ) {
				app.fail( error );
			}
		}
	}

	static list( text ) {
		try {
			const _list = JSON.parse( text || '[]' );
			return Array.isArray( _list ) ? _list : [];
		} catch {
			return [];
		}
	}

	static hours( from, to ) {
		return Math.round( ( Date.parse( to ) - Date.parse( from ) ) / 36000 ) / 100;
	}

} );
