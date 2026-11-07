// Which channel delivers which action, and how the gate talks to one. Without more, everything goes into the local
// outbox. A deployment registers its own channels (mail, bank, ERP) in a file only the gate reads (AGENCY_CHANNELS):
// each names its class, the actions it delivers and its options; the class comes in through AGENCY_OVERRIDES. Nothing
// of the engine is copied or changed for it.

app.define( 'Gate.Channels', [ 'Gate.Channel.Outbox' ], Outbox => class Channels {

	// A channel's name in the registry; default and outbox are the gate's own.
	static NAME = /^[a-z][a-z0-9_-]{0,39}$/;
	static RESERVED = [ 'default', 'outbox' ];

	static create( db ) {
		const _outbox = new Outbox( db );
		return { default: _outbox, outbox: _outbox };
	}

	// The registry file: AGENCY_CHANNELS, relative to the root or absolute; null when the deployment names none.
	static file( value = process.env.AGENCY_CHANNELS ) {
		const _text = String( value ?? '' ).trim();
		return _text ? app.lib( 'node:path' ).resolve( app.root, _text ) : null;
	}

	// Adds the registered channels to channels (the map create() made): { name: { class, actions, options } }. Each class
	// is made once with { db, options, log } and delivers the actions it lists; "*" makes it the channel of every action
	// without one of its own. Anything unclear stops the gate's start (fail closed): a file that is no object, a name or
	// class it cannot use, an object without send(), an action the table does not know, an action two channels claim.
	// Secrets never stand in the file: a channel reads its own from the gate's environment. → the channels added.
	static async load( channels, { file = Channels.file(), db, actions, log = null } = {} ) {
		if ( !file ) { return []; }
		const _registry = JSON.parse( app.lib( 'node:fs' ).readFileSync( file, 'utf8' ).replace( /^\uFEFF/, '' ) );
		if ( !_registry || typeof _registry !== 'object' || Array.isArray( _registry ) ) { throw new TypeError( `${file}: the channels are no JSON object` ); }
		const _claimed = new Map();
		const _added = [];
		for ( const [ name, entry ] of Object.entries( _registry ) ) {
			const _where = `${file}: channel ${name.slice( 0, 40 )}`;
			const _list = Channels._entry( name, entry, _where );
			for ( const action of _list ) {
				if ( action !== '*' && !actions.known( action ) ) { throw new Error( `${_where}: ${String( action ).slice( 0, 60 )} is no action of the table` ); }
				if ( _claimed.has( action ) ) { throw new Error( `${_where}: ${action} is delivered by ${_claimed.get( action )} already` ); }
				_claimed.set( action, name );
			}
			const [ _Class ] = await app.use( [ entry.class ] );
			const _channel = new _Class( { db, options: entry.options ?? {}, log } );
			if ( typeof _channel?.send !== 'function' ) { throw new TypeError( `${_where}: ${entry.class} has no send()` ); }
			for ( const action of _list ) { channels[ action === '*' ? 'default' : action ] = _channel; }
			_added.push( { name, class: entry.class, actions: _list, idempotent: Channels.idempotent( _channel ) } );
		}
		log?.append( 'channels_loaded', { channels: _added } );
		return _added;
	}

	static _entry( name, entry, where ) {
		if ( !Channels.NAME.test( name ) || Channels.RESERVED.includes( name ) ) { throw new Error( `${where}: the name is no channel's name` ); }
		if ( !entry || typeof entry !== 'object' || Array.isArray( entry ) ) { throw new TypeError( `${where}: no object` ); }
		if ( typeof entry.class !== 'string' || !/^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)+$/.test( entry.class ) ) {
			throw new TypeError( `${where}: class must name a class (Acme.Channel.Mail)` );
		}
		if ( !Array.isArray( entry.actions ) || !entry.actions.length || !entry.actions.every( item => typeof item === 'string' && item ) ) {
			throw new TypeError( `${where}: actions must be a list of action names` );
		}
		if ( entry.options !== undefined && ( !entry.options || typeof entry.options !== 'object' || Array.isArray( entry.options ) ) ) {
			throw new TypeError( `${where}: options must be an object` );
		}
		return [ ...new Set( entry.actions ) ];
	}

	// The channel of an action: its own entry of the map, else the default. A name of Object.prototype is no entry,
	// and what cannot send is no channel (A8: then nothing is sent).
	static pick( channels, action ) {
		const _own = name => ( channels && typeof name === 'string' && Object.hasOwn( channels, name ) ? channels[ name ] : null );
		const _channel = _own( action ) || _own( 'default' );
		return _channel && typeof _channel.send === 'function' ? _channel : null;
	}

	// O2: only the channel's class can declare that it keeps the idempotency key; a flag on the object is no guarantee.
	static idempotent( channel ) {
		return channel?.constructor?.IDEMPOTENT === true;
	}

	// A2, A8: one send, bounded in time. → { ok: true, receipt } only for a clear { ok: true }; a timeout, a throw, a
	// rejection or an answer the gate cannot read is a failed attempt with its error, never a crash of the gate.
	static async send( channel, delivery, ms ) {
		const _sent = await Channels.within( () => channel.send( delivery ), ms, { ok: false, error: 'the service did not answer in time' } )
			.catch( error => ( { ok: false, error: error?.message } ) );
		const _readable = Boolean( _sent ) && typeof _sent === 'object';
		if ( _readable && _sent.ok === true ) {
			return { ok: true, receipt: _sent.receipt ?? null };
		}
		return { ok: false, error: String( ( _readable && _sent.error ) || 'the service gave no readable answer' ).slice( 0, 500 ) };
	}

	// O4, A2: what the world says about one operation, within the time of a send; a lookup that is missing, throws,
	// rejects, hangs or answers something unreadable is "not clearly executed" (null).
	static async lookup( channel, delivery, ms ) {
		if ( typeof channel?.lookup !== 'function' ) {
			return null;
		}
		const _found = await Channels.within( () => channel.lookup( delivery ), ms, null ).catch( () => null );
		return _found && typeof _found === 'object' && !Array.isArray( _found ) ? _found : null;
	}

	// work() raced against a timer: → its answer, or fallback when the time is up. A synchronous throw rejects.
	static async within( work, ms, fallback ) {
		let _timer;
		const _late = new Promise( ( resolve ) => {
			_timer = setTimeout( () => resolve( fallback ), ms );
			_timer.unref?.();
		} );
		try {
			return await Promise.race( [ Promise.resolve().then( work ), _late ] );
		} finally {
			clearTimeout( _timer );
		}
	}

} );
