// One secret that guards some routes of a process: the gate's operator pin, the core token between core and gate, the
// core's board pin for what a person decides there, the token of the inbound channel. Compared in constant time;
// after TRIES wrong answers in a row from one client every answer of that client is refused for a while, longer each
// time, so a secret cannot be found by trying, and nobody can lock everybody else out by guessing wrong on purpose.
// Without a secret the routes stay open: that is for development only; a deployment sets every one.
// A request names its secret in a header (x-<name>), or for the operator's endpoints of old also in the JSON body.

app.define( 'Lib.Access', [], () => class Access {

	// A pin of four characters is enough: five wrong answers lock that client for a minute, then two, four, up to an hour.
	static MIN = 4;
	// Clients remembered at most; the oldest is forgotten first.
	static CLIENTS = 10000;
	static TRIES = 5;
	static LOCK_MS = 60000;
	static LOCK_MAX_MS = 3600000;

	// name: the setting (GATE_OPERATOR_PIN), header: where a request carries it (x-operator-pin), missing: what a refused
	// request is told, min: the shortest secret taken.
	constructor( { secret = '', name, header, missing = `${header} required`, min = Access.MIN, log = null, now = () => Date.now() } ) {
		const _secret = typeof secret === 'string' ? secret : '';
		if ( _secret && _secret.length < min ) { throw new Error( `${name} needs at least ${min} characters` ); }
		Object.assign( this, { secret: _secret, name, header, missing, log, now } );
		this._clients = new Map();
	}

	// Who is asking: the address of the connection; behind the proxy on the same host (Caddy, which sets the header to
	// the address it saw) the last address of X-Forwarded-For. A client far away cannot name itself anew with the header.
	static client( req ) {
		const _socket = String( req?.socket?.remoteAddress || '' );
		const _forwarded = req?.headers?.[ 'x-forwarded-for' ];
		const _local = /^(?:127\.|::1$|::ffff:127\.)/.test( _socket );
		return _local && typeof _forwarded === 'string' && _forwarded.trim() ? _forwarded.split( ',' ).at( -1 ).trim() : _socket;
	}

	_guesses( client ) {
		const _key = String( client ?? '' );
		let _entry = this._clients.get( _key );
		if ( !_entry ) {
			if ( this._clients.size >= Access.CLIENTS ) { this._clients.delete( this._clients.keys().next().value ); }
			_entry = { failed: 0, round: 0, until: 0 };
			this._clients.set( _key, _entry );
		}
		return _entry;
	}

	get on() {
		return Boolean( this.secret );
	}

	// The secret a request carries: its header, else (fallback) a field of its JSON body.
	given( req, body = null, field = null ) {
		const _header = req?.headers?.[ this.header ];
		if ( typeof _header === 'string' && _header ) { return _header; }
		const _field = field && body && typeof body === 'object' && !Array.isArray( body ) && Object.hasOwn( body, field ) ? body[ field ] : undefined;
		return typeof _field === 'string' ? _field : '';
	}

	// → 'ok', 'missing', 'wrong' or 'locked'; 'ok' for every request while no secret is set. client: who asks
	// (Access.client); the wrong answers of one client never lock another.
	check( given, client = '' ) {
		if ( !this.on ) { return 'ok'; }
		if ( typeof given !== 'string' || !given ) { return 'missing'; }
		const _now = this.now();
		const _guesses = this._guesses( client );
		if ( _now < _guesses.until ) { return 'locked'; }
		if ( Access.same( given, this.secret ) ) {
			Object.assign( _guesses, { failed: 0, round: 0, until: 0 } );
			return 'ok';
		}
		_guesses.failed += 1;
		if ( _guesses.failed >= Access.TRIES ) {
			_guesses.until = _now + Math.min( Access.LOCK_MS * 2 ** _guesses.round, Access.LOCK_MAX_MS );
			_guesses.round += 1;
			_guesses.failed = 0;
			this.log?.append( 'access_locked', { secret: this.name, until: new Date( _guesses.until ).toISOString() } );
		}
		return 'wrong';
	}

	// The HTTP answer for a check that is not 'ok': 429 while locked, else 403, saying what is needed.
	refusal( result ) {
		return result === 'locked' ? [ 429, { error: 'too many wrong answers; try again later' } ] : [ 403, { error: this.missing } ];
	}

	// The same text, compared in constant time: both sides hashed to the same length first, so not even the length of
	// the secret shows.
	static same( given, secret ) {
		const _crypto = app.lib( 'node:crypto' );
		const _hash = text => _crypto.createHash( 'sha256' ).update( String( text ), 'utf8' ).digest();
		return _crypto.timingSafeEqual( _hash( given ), _hash( secret ) );
	}

} );
