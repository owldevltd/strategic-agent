// Append-only event log. Nothing is ever changed or deleted; state is derived from events. Subscribers get every
// new event once it is committed (the live log in the browser reads them over SSE), in id order, with the data as
// the log keeps it: what a subscriber sees is what a replay will show.

app.define( 'Lib.EventLog', [ 'Lib.Bus' ], Bus => class EventLog {

	static PAGE = 1000;

	constructor( db, source ) {
		this.db = db;
		this.source = source;
		this._bus = new Bus();
		this._queue = [];
		this._delivering = false;
		this.db.exec( `CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source TEXT NOT NULL,
			kind TEXT NOT NULL,
			node TEXT,
			nodeVersion INTEGER,
			data TEXT NOT NULL,
			time TEXT NOT NULL
		)` );
	}

	// → the event as stored. Inside a transaction, subscribers hear of it after the outermost COMMIT, and never if it
	// rolls back (its id may then be given again).
	append( kind, data = {}, { node = null, nodeVersion = null, source = this.source } = {} ) {
		EventLog._check( { kind, source }, 'string' );
		EventLog._check( { node }, 'string', true );
		EventLog._check( { nodeVersion }, 'number', true );
		const _data = JSON.stringify( data );
		if ( typeof _data !== 'string' ) {
			throw new TypeError( `The data of ${kind} has no JSON form` );
		}
		// SQLite has no NaN; the text keeps it apart from "no version" (E1 compares versions).
		const _version = Number.isNaN( nodeVersion ) ? 'NaN' : nodeVersion;
		const _row = { source, kind, node, nodeVersion: _version, data: _data, time: new Date().toISOString() };
		const _result = this.db.run(
			'INSERT INTO events ( source, kind, node, nodeVersion, data, time ) VALUES ( :source, :kind, :node, :nodeVersion, :data, :time )',
			_row,
		);
		const _stored = () => EventLog._row( { id: Number( _result.lastInsertRowid ), ..._row } );
		this.db.afterCommit( () => this._deliver( _stored() ) );
		return _stored();
	}

	// Where a live log starts: after `since`, or, for a client that has seen nothing yet and asks for a tail, the last
	// `tail` events (at most a page), so a visitor sees what happens now and not the first page of the server's life.
	start( query ) {
		const _since = Number( query?.get?.( 'since' ) || 0 );
		const _tail = Number( query?.get?.( 'tail' ) || 0 );
		if ( _since > 0 || !( _tail > 0 ) ) { return Number.isFinite( _since ) && _since > 0 ? _since : 0; }
		const _last = this.db.get( 'SELECT MAX( id ) AS id FROM events' )?.id || 0;
		return Math.max( 0, _last - Math.min( Math.floor( _tail ), EventLog.PAGE ) );
	}

	// A limit that is no positive number means the default page.
	since( id = 0, limit = EventLog.PAGE ) {
		const _id = Number.isNaN( Number( id ) ) ? 0 : Number( id );
		const _limit = Number.isFinite( limit ) && limit > 0 ? Math.ceil( limit ) : EventLog.PAGE;
		return this.db.all( 'SELECT * FROM events WHERE id > :id ORDER BY id LIMIT :limit', { id: _id, limit: _limit } ).map( EventLog._row );
	}

	forNode( node ) {
		if ( typeof node !== 'string' ) { return []; }
		return this.db.all( 'SELECT * FROM events WHERE node = :node ORDER BY id', { node } ).map( EventLog._row );
	}

	subscribe( cb ) {
		return this._bus.on( 'event', cb );
	}

	// An event appended by a subscriber waits until every subscriber has the one before it, so all of them see the
	// events in id order.
	_deliver( event ) {
		this._queue.push( event );
		if ( this._delivering ) { return; }
		this._delivering = true;
		try {
			while ( this._queue.length ) {
				this._bus.emit( 'event', this._queue.shift() );
			}
		} finally {
			this._delivering = false;
		}
	}

	static _check( fields, type, empty = false ) {
		for ( const [ name, value ] of Object.entries( fields ) ) {
			if ( !( typeof value === type || ( empty && value === null ) ) ) {
				throw new TypeError( `The ${name} of an event must be a ${type}${empty ? ' or null' : ''}` );
			}
		}
	}

	// A row whose data is no JSON (the file was changed from outside) is read as damaged, with empty data: whoever reads
	// it decides what that means (a restart leaves the goal it belongs to where it is), and the rest of the log stays
	// readable.
	static _row( row ) {
		const _version = row.nodeVersion === 'NaN' ? NaN : row.nodeVersion;
		try {
			return { ...row, nodeVersion: _version, data: JSON.parse( row.data ) };
		} catch {
			return { ...row, nodeVersion: _version, data: {}, damaged: true };
		}
	}

} );
