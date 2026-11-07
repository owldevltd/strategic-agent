// A small router over node:http: routes with :params, JSON in and out, server-sent events and static files.
// No framework on purpose; the processes only need a handful of endpoints.
//
// A bad request is the client's fault and gets a 4xx with its reason; a handler may throw Http.refusal( status,
// reason ), or any error with a 4xx status, for the same. Anything else that fails is a 500 with a generic message
// (no paths, no SQL) and goes to app.fail.

app.define( 'Lib.Http', [], () => class Http {

	static TYPES = {
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.png': 'image/png',
		'.svg': 'image/svg+xml',
	};

	// The default largest body; a server or a single route may allow more (the gate takes 7 MiB). A larger body is
	// refused with 413 and never buffered.
	static MAX_BODY = 1024 * 1024;

	// What a client may still send beyond the limit before the connection is cut instead of drained.
	static MAX_DRAIN = 64 * 1024 * 1024;

	// Marks a response that is an event stream: close() ends those itself, as they never end by themselves.
	static STREAM = Symbol( 'event stream' );

	// The headers a page of an allowed origin may send: JSON, and the secrets of Lib.Access.
	static CORS_HEADERS = 'Content-Type, x-operator-pin, x-board-pin, x-core-token';

	// cors: the origins whose pages may call this server from another origin (a list), or nothing.
	constructor( { cors = false, maxBody = Http.MAX_BODY } = {} ) {
		this._routes = [];
		this._statics = [];
		this._cors = cors;
		this._maxBody = Http._limit( maxBody );
		this._open = new Set();
		this.server = null;
	}

	// An error a handler throws to answer the client with status (4xx) and its reason; any error that carries a 4xx
	// status is answered so. Its message goes to the client, so it must name no path, no SQL, no secret.
	static refusal( status, reason ) {
		return Object.assign( new Error( reason ), { status } );
	}

	// options.maxBody: the largest body this route takes, instead of the server's.
	route( method, pattern, handler, { maxBody } = {} ) {
		const _names = [];
		// Only :name is special; every other character matches itself ("." is a dot, not any character).
		const _source = pattern.split( /(:[a-zA-Z]+)/ ).map( ( part, i ) => {
			if ( i % 2 === 0 ) { return part.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ); }
			_names.push( part.slice( 1 ) );
			return '([^/]+)';
		} ).join( '' );
		const _maxBody = maxBody === undefined ? undefined : Http._limit( maxBody );
		this._routes.push( { method, regex: new RegExp( `^${_source}$` ), names: _names, handler, maxBody: _maxBody } );
		return this;
	}

	// Serves files below dir under the URL prefix; only plain names, no way out of dir.
	serve( prefix, dir ) {
		this._statics.push( { prefix, dir } );
		return this;
	}

	// Timeouts for receiving a request, so a client that sends slowly cannot hold a connection open for long.
	listen( port, host ) {
		this.server = app.lib( 'node:http' ).createServer( { headersTimeout: 10000, requestTimeout: 30000 }, ( req, res ) => {
			this._open.add( res );
			res.on( 'close', () => this._open.delete( res ) );
			this._handle( req, res ).catch( error => Http._failed( res, error ) );
		} );
		return new Promise( resolve => this.server.listen( port, host, () => resolve( this.server.address().port ) ) );
	}

	// Waits for the requests in progress; open event streams are ended (a browser reconnects to whoever serves next).
	close() {
		if ( !this.server ) { return Promise.resolve(); }
		return new Promise( ( resolve ) => {
			this.server.close( () => resolve() );
			for ( const res of this._open ) {
				if ( res[ Http.STREAM ] ) { res.destroy(); }
			}
		} );
	}

	static _failed( res, error ) {
		const _refused = Number.isInteger( error?.status ) && error.status >= 400 && error.status < 500;
		if ( !_refused ) {
			app.fail( error );
		}
		if ( !res.headersSent ) {
			Http.json( res, _refused ? error.status : 500, { error: _refused ? error.message : 'internal error' } );
		} else {
			// The head went out: what follows can no longer say 500. Cutting the connection (once the written part
			// has left) tells the client that the answer is incomplete instead of letting it wait.
			setImmediate( () => res.destroy() );
		}
	}

	async _handle( req, res ) {
		const _url = Http._target( req.url );
		// CORS for the pages of the origins named (the operator's page of the core, in development on another port): only
		// they may read answers or send the headers that carry a secret. Any other origin gets no CORS header, so a
		// browser keeps another site from reading or sending (a page cannot read the operator's approvals, say).
		if ( this._cors ) {
			const _origin = req.headers.origin;
			const _allowed = typeof _origin === 'string' && Array.isArray( this._cors ) && this._cors.includes( _origin );
			if ( _allowed ) {
				res.setHeader( 'Access-Control-Allow-Origin', _origin );
				res.setHeader( 'Vary', 'Origin' );
				res.setHeader( 'Access-Control-Allow-Headers', Http.CORS_HEADERS );
				res.setHeader( 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS' );
			}
			if ( req.method === 'OPTIONS' ) {
				res.writeHead( _allowed ? 204 : 403 );
				res.end();
				return;
			}
		}
		for ( const route of this._routes ) {
			const _match = route.method === req.method && _url.pathname.match( route.regex );
			if ( _match ) {
				const _params = Object.fromEntries( route.names.map( ( name, i ) => [ name, Http._decode( _match[ i + 1 ] ) ] ) );
				const _body = [ 'POST', 'PUT' ].includes( req.method ) ? await Http.body( req, route.maxBody ?? this._maxBody ) : {};
				await route.handler( { req, res, params: _params, query: _url.searchParams, body: _body } );
				return;
			}
		}
		if ( req.method === 'GET' && this._serveStatic( _url.pathname, res ) ) {
			return;
		}
		Http.json( res, 404, { error: 'not found' } );
	}

	// The request target as a URL. A target starting with "//" is a path, not a host: new URL( "//x/y", base )
	// would drop "//x" and route "/y".
	static _target( target ) {
		try {
			return target.startsWith( '/' ) ? new URL( `http://localhost${target}` ) : new URL( target );
		} catch {
			throw Http.refusal( 400, 'malformed request target' );
		}
	}

	static _decode( text ) {
		try {
			return decodeURIComponent( text );
		} catch {
			throw Http.refusal( 400, 'malformed percent-encoding' );
		}
	}

	_serveStatic( pathname, res ) {
		const fs = app.lib( 'node:fs' );
		const path = app.lib( 'node:path' );
		for ( const { prefix, dir } of this._statics ) {
			if ( !pathname.startsWith( prefix ) ) { continue; }
			const _rel = Http._decode( pathname.slice( prefix.length ) );
			if ( _rel.includes( '\0' ) ) { continue; }
			// A folder serves its index.html.
			const _dir = path.resolve( dir );
			const _file = path.resolve( _dir, !_rel || _rel.endsWith( '/' ) ? `${_rel}index.html` : _rel );
			// Inside dir means below dir plus a separator: "/srv/pub-secret" starts with "/srv/pub" as well.
			if ( !_file.startsWith( `${_dir}${path.sep}` ) || !Http._isFile( fs, _file ) ) { continue; }
			Http._send( fs, _file, res, Http.TYPES[ path.extname( _file ) ] || 'application/octet-stream' );
			return true;
		}
		return false;
	}

	static _isFile( fs, file ) {
		try {
			return Boolean( fs.statSync( file, { throwIfNoEntry: false } )?.isFile() );
		} catch {
			return false;
		}
	}

	// The head goes out only once the file is open; a file that cannot be read (no permission, removed after the
	// check) is an answer, never an uncaught error that ends the process.
	static _send( fs, file, res, type ) {
		const _stream = fs.createReadStream( file );
		_stream.on( 'error', ( error ) => {
			if ( res.headersSent ) {
				res.destroy();
				return;
			}
			if ( error.code === 'ENOENT' ) {
				Http.json( res, 404, { error: 'not found' } );
				return;
			}
			Http._failed( res, error );
		} );
		_stream.on( 'open', () => {
			res.writeHead( 200, { 'Content-Type': type } );
			_stream.pipe( res );
		} );
		res.on( 'close', () => _stream.destroy() );
	}

	static _limit( bytes ) {
		if ( !Number.isSafeInteger( bytes ) || bytes < 0 ) {
			throw new RangeError( 'maxBody must be a number of bytes' );
		}
		return bytes;
	}

	// The JSON object of a POST or PUT; nothing is the empty object. Text that is not UTF-8 or not JSON, JSON that
	// is no object, and a body above maxBody are refused with 400 or 413. Beyond the limit nothing is kept: the rest
	// is read and dropped, so the client gets the 413 instead of a reset connection (requestTimeout bounds how long),
	// and a client that sends more than MAX_DRAIN on top is cut off.
	static body( req, maxBody = Http.MAX_BODY ) {
		return new Promise( ( resolve, reject ) => {
			let _chunks = [];
			let _size = 0;
			const _tooLarge = () => Http.refusal( 413, `the body is larger than ${maxBody} bytes` );
			req.on( 'data', ( chunk ) => {
				_size += chunk.length;
				if ( _size <= maxBody ) {
					_chunks.push( chunk );
				} else if ( _size > maxBody + Http.MAX_DRAIN ) {
					req.destroy();
					reject( _tooLarge() );
				} else {
					_chunks = [];
				}
			} );
			req.on( 'end', () => {
				if ( _size > maxBody ) {
					reject( _tooLarge() );
					return;
				}
				try {
					resolve( Http._object( Buffer.concat( _chunks ) ) );
				} catch ( error ) {
					reject( error );
				}
			} );
			req.on( 'error', reject );
		} );
	}

	static _object( bytes ) {
		let _value;
		try {
			const _text = new TextDecoder( 'utf-8', { fatal: true } ).decode( bytes );
			_value = _text.trim() ? JSON.parse( _text ) : {};
		} catch {
			throw Http.refusal( 400, 'the body is not JSON' );
		}
		if ( !_value || typeof _value !== 'object' || Array.isArray( _value ) ) {
			throw Http.refusal( 400, 'the body must be a JSON object' );
		}
		return _value;
	}

	// The text is made before the head goes out, so data that has no JSON form (a BigInt, a cycle) throws while a
	// 500 can still be sent.
	static json( res, status, data ) {
		const _text = JSON.stringify( data );
		res.writeHead( status, { 'Content-Type': Http.TYPES[ '.json' ], 'Cache-Control': 'no-store' } );
		res.end( _text );
	}

	// Server-sent events: returns send( data ) and closed, which resolves once the client is gone. The response's
	// own close counts too: the request's close may have fired already (after a body was read).
	static events( req, res ) {
		res.writeHead( 200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } );
		res.write( ':\n\n' );
		res[ Http.STREAM ] = true;
		const _ping = setInterval( () => res.write( ':\n\n' ), 15000 );
		let _done = false;
		const _closed = new Promise( ( resolve ) => {
			const _end = () => {
				_done = true;
				resolve();
			};
			req.once( 'close', _end );
			res.once( 'close', _end );
			if ( res.destroyed || res.writableEnded ) { _end(); }
		} );
		_closed.then( () => clearInterval( _ping ) );
		return {
			send: ( data ) => {
				const _text = `${Http._eventId( data?.id )}data: ${JSON.stringify( data )}\n\n`;
				if ( !_done ) { res.write( _text ); }
			},
			closed: _closed,
		};
	}

	// One id line, or none when the event has no id. A line break in the id would start new fields or events, so
	// it is percent-encoded (as is NUL, which makes a browser drop the id).
	static _eventId( id ) {
		if ( id === undefined || id === null ) { return ''; }
		return `id: ${String( id ).replace( /[\r\n\0]/g, char => encodeURIComponent( char ) )}\n`;
	}

	// A2: every call has a client timeout, shorter than any lease (2 minutes for code). Redirects are not followed
	// (the gate's address is the only one the core may reach), credentials in the URL are refused without quoting
	// them, and a 2xx answer must be JSON (an empty one only for 204): a cut or broken answer never reads as {}.
	static async request( method, url, body, { timeoutMs = 30000 } = {} ) {
		if ( !( Number.isFinite( timeoutMs ) && timeoutMs > 0 && timeoutMs <= 2147483647 ) ) {
			throw new RangeError( 'timeoutMs must be a number of milliseconds above 0' );
		}
		const _url = new URL( url );
		if ( ![ 'http:', 'https:' ].includes( _url.protocol ) ) {
			throw new TypeError( `Only http and https can be requested, not ${_url.protocol}` );
		}
		if ( _url.username || _url.password ) {
			throw new TypeError( `A URL with credentials is refused (${_url.host})` );
		}
		const _response = await fetch( _url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify( body ),
			signal: AbortSignal.timeout( timeoutMs ),
			redirect: 'error',
		} );
		const _text = await _response.text();
		if ( _text === '' ) {
			if ( _response.ok && _response.status !== 204 ) {
				throw new Error( `${method} ${_url.host}${_url.pathname}: ${_response.status} without a body` );
			}
			return { status: _response.status, data: {} };
		}
		try {
			return { status: _response.status, data: JSON.parse( _text ) };
		} catch {
			if ( _response.ok ) {
				throw new Error( `${method} ${_url.host}${_url.pathname}: ${_response.status} with a body that is not JSON` );
			}
			return { status: _response.status, data: {} };
		}
	}

} );
