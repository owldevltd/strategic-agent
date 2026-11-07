// One secret that guards some routes of a process: the gate's operator pin, the core token between core and gate, the
// core's board pin for what a person decides there, the token of the inbound channel. Compared in constant time;
// after TRIES wrong answers in a row every answer is refused for a while, longer each time, so a secret cannot be
// found by trying. Without a secret the routes stay open: that is for development only; a deployment sets every one.
// A request names its secret in a header (x-<name>), or for the operator's endpoints of old also in the JSON body.

app.define( 'Lib.Access', [], () => class Access {

	static MIN = 6;
	static TRIES = 5;
	static LOCK_MS = 60000;
	static LOCK_MAX_MS = 3600000;

	// name: the setting (GATE_OPERATOR_PIN), header: where a request carries it (x-operator-pin), missing: what a refused
	// request is told, min: the shortest secret taken.
	constructor( { secret = '', name, header, missing = `${header} required`, min = Access.MIN, log = null, now = () => Date.now() } ) {
		const _secret = typeof secret === 'string' ? secret : '';
		if ( _secret && _secret.length < min ) { throw new Error( `${name} needs at least ${min} characters` ); }
		Object.assign( this, { secret: _secret, name, header, missing, log, now } );
		this._guesses = { failed: 0, round: 0, until: 0 };
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

	// → 'ok', 'missing', 'wrong' or 'locked'; 'ok' for every request while no secret is set.
	check( given ) {
		if ( !this.on ) { return 'ok'; }
		if ( typeof given !== 'string' || !given ) { return 'missing'; }
		const _now = this.now();
		if ( _now < this._guesses.until ) { return 'locked'; }
		if ( Access.same( given, this.secret ) ) {
			this._guesses = { failed: 0, round: 0, until: 0 };
			return 'ok';
		}
		this._guesses.failed += 1;
		if ( this._guesses.failed >= Access.TRIES ) {
			this._guesses.until = _now + Math.min( Access.LOCK_MS * 2 ** this._guesses.round, Access.LOCK_MAX_MS );
			this._guesses.round += 1;
			this._guesses.failed = 0;
			this.log?.append( 'access_locked', { secret: this.name, until: new Date( this._guesses.until ).toISOString() } );
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
