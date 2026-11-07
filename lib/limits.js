// Limits for a public demo: how many requests one caller may make in a window, and how many in total. A refused
// request gets 429; nothing is queued. Whatever cannot be counted (a limit or a clock that is no number) refuses,
// and memory stays bounded: only callers with calls in the window are kept, at most total of them.

app.define( 'Lib.Limits', [], () => class Limits {

	// Addresses of a proxy on the same machine (Caddy in front of the core); only these may name the caller.
	static PROXIES = [ '127.0.0.1', '::1', '::ffff:127.0.0.1' ];

	constructor( { perCaller = 30, total = 300, windowMs = 600000, now = () => Date.now() } = {} ) {
		Object.assign( this, { perCaller, total, windowMs, now } );
		this.calls = new Map();
		// Every call that passed, oldest first: { time, caller }.
		this.all = [];
	}

	// → true when the call may go ahead (and counts it).
	take( caller ) {
		const _now = this.now();
		const _since = _now - this.windowMs;
		if ( !Number.isFinite( _now ) || Number.isNaN( _since ) ) { return false; }
		const _gone = new Set();
		this.all = this.all.filter( call => call.time > _since || !_gone.add( call.caller ) );
		for ( const name of _gone ) {
			this._keep( name, ( this.calls.get( name ) || [] ).filter( time => time > _since ) );
		}
		const _mine = ( this.calls.get( caller ) || [] ).filter( time => time > _since );
		// Written so that a limit that is NaN refuses: every comparison with NaN is false.
		if ( !( _mine.length < this.perCaller && this.all.length < this.total ) ) {
			this._keep( caller, _mine );
			return false;
		}
		_mine.push( _now );
		this.all.push( { time: _now, caller } );
		this.calls.set( caller, _mine );
		return true;
	}

	// A caller without calls in the window is forgotten.
	_keep( caller, times ) {
		if ( times.length ) {
			this.calls.set( caller, times );
		} else {
			this.calls.delete( caller );
		}
	}

	// The caller: the first address of X-Forwarded-For when the request comes through the proxy on this machine,
	// otherwise the address of the connection; anyone else could name any address in that header. An IPv6 caller
	// counts by its /64 network, which one machine usually has whole.
	static caller( req ) {
		const _socket = req?.socket?.remoteAddress;
		const _forwarded = req?.headers?.[ 'x-forwarded-for' ];
		// Behind the proxy only the last address is the one the proxy saw; the ones before it come from the client and
		// can be anything.
		if ( Limits.PROXIES.includes( _socket ) && _forwarded !== undefined && String( _forwarded ) !== '' ) {
			return Limits.network( String( _forwarded ).split( ',' ).map( item => item.trim() ).filter( Boolean ).at( -1 ) || 'unknown' );
		}
		return typeof _socket === 'string' && _socket ? Limits.network( _socket ) : 'unknown';
	}

	// An IPv4 address as it is ("::ffff:" in front dropped); an IPv6 address as its /64 ("2001:db8:0:1::/64").
	static network( address ) {
		const _plain = address.replace( /^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '' );
		const _address = _plain.replace( /%.*$/, '' );
		if ( !app.lib( 'node:net' ).isIPv6( _address ) ) { return _plain; }
		const [ _head, _tail ] = _address.split( '::' );
		const _groups = _head ? _head.split( ':' ) : [];
		if ( _tail !== undefined ) {
			const _rest = _tail ? _tail.split( ':' ) : [];
			const _size = _rest.reduce( ( sum, group ) => sum + ( group.includes( '.' ) ? 2 : 1 ), 0 );
			_groups.push( ...Array( 8 - _groups.length - _size ).fill( '0' ), ..._rest );
		}
		return `${_groups.slice( 0, 4 ).map( group => parseInt( group, 16 ).toString( 16 ) ).join( ':' )}::/64`;
	}

} );
