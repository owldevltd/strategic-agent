// Expectations (chapters 8.1, 8.2). A waiting process states from whom, about what, until when, in which form and
// with which keys it expects something. The keys are fixed before anything leaves, so a reply is matched by code
// even when the other side breaks the thread. A timeout is a result, not an error: it ends the strategy attempt.
// The expectation itself stays open until its node closes, and a late answer is still a valid fact (E4, B8).
// Of two facts from the same origin the younger counts and the older is marked superseded (B1, E5).

app.define( 'Core.Inbound.Expectations', [ 'Lib.Hash', 'Lib.Bus' ], ( Hash, Bus ) => class Expectations {

	constructor( db, { now = () => Date.now() } = {} ) {
		this.db = db;
		this.now = now;
		this._bus = new Bus();
		this.db.exec( `
			CREATE TABLE IF NOT EXISTS expectations (
				id TEXT PRIMARY KEY, node TEXT NOT NULL, contract TEXT NOT NULL, origin TEXT NOT NULL, fact TEXT NOT NULL,
				spec TEXT NOT NULL, keys TEXT NOT NULL, need INTEGER NOT NULL, until TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS expectation_facts (
				id INTEGER PRIMARY KEY AUTOINCREMENT, expectation TEXT NOT NULL, origin TEXT NOT NULL, fact TEXT NOT NULL,
				late INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0, time TEXT NOT NULL
			);
		` );
	}

	// A fact for an expectation is a signal of the attempt that created it (L2, L5).
	on( name, fn ) {
		return this._bus.on( name, fn );
	}

	// Created before the action leaves; it becomes open only when the gate executed the action. attempt: the attempt of
	// the strategy whose move sent it, so an answer is a signal of that attempt.
	// carry: fixed fields that travel with the fact; validHours: how long such a fact counts (8.3, B2). need: how many
	// answers (from different origins) meet it, at least one: an expectation met without a single answer is no
	// expectation. keys: a list of texts that each name it; a blank one is kept as given but never matches (key()).
	create( node, spec ) {
		const { from, fact, extract = {}, parser = {}, store = null } = spec;
		const { attempt = null, carry = [], validHours = null, about = null, each = null } = spec;
		const need = Expectations.whole( spec.need ?? 1 );
		const minutes = Number( spec.minutes ?? 60 );
		const keys = spec.keys ?? [];
		if ( !need || need < 1 ) { throw new Error( 'an expectation needs at least one answer (8.2)' ); }
		if ( !Number.isFinite( minutes ) ) { throw new Error( 'the minutes of an expectation are no time' ); }
		if ( !Array.isArray( keys ) || !keys.every( key => typeof key === 'string' ) ) {
			throw new Error( 'the keys of an expectation are a list of texts (8.1)' );
		}
		const _id = Hash.id( 'ex' );
		const _until = new Date( Math.min( this.now() + minutes * 60000, Date.parse( node.contract.deadline ) ) ).toISOString();
		this.db.run( `INSERT INTO expectations ( id, node, contract, origin, fact, spec, keys, need, until, status, createdAt )
			VALUES ( :id, :node, :contract, :origin, :fact, :spec, :keys, :need, :until, 'pending', :at )`, {
			id: _id, node: node.id, contract: node.contract.hash, origin: from, fact, need, until: _until,
			at: new Date( this.now() ).toISOString(),
			spec: JSON.stringify( { extract, parser, store, attempt, carry, validHours, about, each } ), keys: JSON.stringify( keys ),
		} );
		node.emit( 'expectation_created', { id: _id, from, fact, need, until: _until, keys } );
		return this.get( _id );
	}

	activate( id ) {
		this._status( id, 'open', [ 'pending' ] );
	}

	drop( id ) {
		this._status( id, 'dropped', [ 'pending' ] );
	}

	// Expectations of a node that has closed take nothing more (Z5), also those already met; later replies become new
	// cases.
	closeFor( nodeId ) {
		this.db.run( `UPDATE expectations SET status = 'closed' WHERE node = :node AND status IN ( 'pending', 'open', 'timed_out', 'met' )`, { node: nodeId } );
	}

	get( id ) {
		const _row = this.db.get( 'SELECT * FROM expectations WHERE id = :id', { id } );
		return _row ? Expectations._parse( _row ) : null;
	}

	// Open for matching: still waited for, or timed out but its node is not closed yet.
	listening() {
		return this.db.all( 'SELECT * FROM expectations WHERE status IN ( \'open\', \'timed_out\', \'met\' ) ORDER BY createdAt, rowid' ).map( Expectations._parse );
	}

	// An expectation of a closed node whose key is in a message: no longer matched (Z5), but still a signal (L2).
	closedByKey( text ) {
		return this.db.all( 'SELECT * FROM expectations WHERE status = \'closed\'' ).map( Expectations._parse )
			.find( item => Expectations.keyed( item, text ) ) || null;
	}

	// The newest of the node; of two made in the same millisecond the one made later (rowid).
	latest( nodeId ) {
		const _row = this.db.get( `SELECT * FROM expectations WHERE node = :node AND status IN ( 'open', 'timed_out', 'met' )
			ORDER BY createdAt DESC, rowid DESC LIMIT 1`, { node: nodeId } );
		return _row ? Expectations._parse( _row ) : null;
	}

	count( id ) {
		return this.db.get( 'SELECT COUNT(*) AS n FROM expectation_facts WHERE expectation = :id AND superseded = 0', { id } ).n;
	}

	// Records one fact; a fact from an origin that already answered supersedes the older one. An expectation that is
	// closed (its node closed, Z5) or dropped (its action never left) takes nothing: → null, and no attempt hears of it.
	record( id, { origin, fact } ) {
		const _expectation = this.get( id );
		if ( !_expectation ) { throw new Error( `no expectation ${id}` ); }
		if ( [ 'closed', 'dropped' ].includes( _expectation.status ) ) { return null; }
		const _late = Date.parse( _expectation.until ) < this.now();
		const _earlier = this.db.run( 'UPDATE expectation_facts SET superseded = 1 WHERE expectation = :id AND origin = :origin AND superseded = 0',
			{ id, origin } ).changes;
		this.db.run( `INSERT INTO expectation_facts ( expectation, origin, fact, late, time ) VALUES ( :id, :origin, :fact, :late, :at )`, {
			id, origin, fact, late: _late ? 1 : 0, at: new Date( this.now() ).toISOString(),
		} );
		const _count = this.count( id );
		if ( _expectation.status === 'open' && _count >= _expectation.need ) {
			this._status( id, 'met', [ 'open' ] );
		}
		this._bus.emit( 'fact', { id, attempt: _expectation.spec.attempt ?? null } );
		return { late: _late, superseded: _earlier > 0, count: _count, need: _expectation.need };
	}

	// Waits until enough facts arrived, the expectation timed out, or stop() says so. → { status, count, need }
	async wait( id, { until = null, stop = () => false, pollMs = 200 } = {} ) {
		const _expectation = this.get( id );
		// Waiting longer does not move the expectation's own deadline: what arrives after it is still marked late.
		const _until = Date.parse( until || _expectation.until );
		for ( ;; ) {
			const _count = this.count( id );
			if ( _count >= _expectation.need ) {
				this._status( id, 'met', [ 'open', 'timed_out' ] );
				return { status: 'met', count: _count, need: _expectation.need };
			}
			if ( stop() ) {
				return { status: 'stopped', count: _count, need: _expectation.need };
			}
			if ( this.now() >= _until ) {
				this._status( id, 'timed_out', [ 'open' ] );
				return { status: 'timed_out', count: _count, need: _expectation.need };
			}
			await new Promise( ( resolve ) => {
				const _timer = setTimeout( resolve, Math.min( pollMs, Math.max( 1, _until - this.now() ) ) );
				const _off = this._bus.on( 'fact', ( event ) => {
					if ( event.id === id ) {
						clearTimeout( _timer );
						_off();
						resolve();
					}
				} );
				setTimeout( _off, pollMs + 5 );
			} );
		}
	}

	_status( id, status, from ) {
		const _list = from.map( item => `'${item}'` ).join( ', ' );
		this.db.run( `UPDATE expectations SET status = :status WHERE id = :id AND status IN ( ${_list} )`, { id, status } );
	}

	// Whether a key of the expectation is in the text (8.1). A blank key is in every text, so it names nothing.
	static keyed( expectation, text ) {
		return expectation.keys.some( key => key.trim() !== '' && String( text ).includes( key ) );
	}

	// Keys stored before they were checked are read as the list of the texts among them, so no match can throw.
	static _parse( row ) {
		const _keys = JSON.parse( row.keys );
		const _list = Array.isArray( _keys ) ? _keys.filter( key => typeof key === 'string' ) : [];
		return { ...row, spec: JSON.parse( row.spec ), keys: _list };
	}

	// A whole number given as a number or as its digits, else null.
	static whole( value ) {
		const _number = typeof value === 'string' && /^\d{1,9}$/.test( value.trim() ) ? Number( value ) : value;
		return Number.isInteger( _number ) ? _number : null;
	}

} );
