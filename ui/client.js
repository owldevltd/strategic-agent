// How the pages talk to the core and the gate. Each call carries the secret of the process it goes to, in a header and
// never in a URL: the operator pin to the gate (x-operator-pin), the board pin to the core (x-board-pin). So the core
// never sees the operator pin, and the gate never sees the board pin. The live logs are read with fetch, not with
// EventSource, because an EventSource cannot send a header; a stream that ends is opened again after the last event
// it delivered, so nothing is shown twice.

app.define( 'Ui.Client', [], () => class Client {

	static RETRY_MS = 2000;
	static RETRY_MAX_MS = 30000;

	// gateUrl: where the gate is for the browser; pins: () => ( { gate, board } ), read at every call.
	constructor( { gateUrl, pins } ) {
		this.gateUrl = String( gateUrl || '' ).replace( /\/$/, '' );
		this.pins = pins;
	}

	toGate( url ) {
		return Boolean( this.gateUrl ) && ( url === this.gateUrl || url.startsWith( `${this.gateUrl}/` ) );
	}

	headers( url, extra = {} ) {
		const { gate = '', board = '' } = this.pins?.() || {};
		const _pin = this.toGate( url ) ? { 'x-operator-pin': gate } : { 'x-board-pin': board };
		return { ...extra, ...( Object.values( _pin )[ 0 ] ? _pin : {} ) };
	}

	// → the answer's JSON; an answer that is no success throws with its status and the error it names.
	async get( url ) {
		return Client._read( await fetch( url, { headers: this.headers( url ), cache: 'no-store' } ) );
	}

	// → the response itself, so a card can show a refusal (a missing reason, a wrong pin) where it was given.
	async post( url, body = {} ) {
		return fetch( url, { method: 'POST', headers: this.headers( url, { 'Content-Type': 'application/json' } ), body: JSON.stringify( body ) } );
	}

	// A live log: onEvent( event ) for every event, in order, once; onState( 'open' | 'refused' | 'lost', status )
	// when the stream opens, is refused (a pin is missing or wrong) or breaks. A refused stream waits for retry() (the
	// person entered a pin); one that broke is opened again by itself. → { close, retry }.
	stream( url, onEvent, onState = () => {} ) {
		let _last = 0;
		let _wait = Client.RETRY_MS;
		let _stopped = false;
		let _refused = false;
		const _control = { abort: null };
		const _again = () => {
			if ( _stopped ) { return; }
			setTimeout( _open, _wait );
			_wait = Math.min( _wait * 2, Client.RETRY_MAX_MS );
		};
		const _open = async () => {
			if ( _stopped ) { return; }
			const _abort = new AbortController();
			_control.abort = _abort;
			try {
				const _url = `${url}${url.includes( '?' ) ? '&' : '?'}since=${_last}`;
				const _response = await fetch( _url, { headers: this.headers( url, { Accept: 'text/event-stream' } ), signal: _abort.signal, cache: 'no-store' } );
				if ( !_response.ok ) {
					_refused = [ 401, 403, 429 ].includes( _response.status );
					onState( 'refused', _response.status );
					return _refused ? undefined : _again();
				}
				onState( 'open', _response.status );
				_wait = Client.RETRY_MS;
				await Client._events( _response.body, ( event ) => {
					if ( Number.isFinite( event?.id ) && event.id <= _last ) { return; }
					if ( Number.isFinite( event?.id ) ) { _last = event.id; }
					onEvent( event );
				} );
				onState( 'lost' );
			} catch ( error ) {
				if ( _stopped ) { return undefined; }
				onState( 'lost', error?.message );
			}
			return _again();
		};
		_open();
		return {
			close: () => {
				_stopped = true;
				_control.abort?.abort();
			},
			retry: () => {
				if ( !_refused || _stopped ) { return; }
				_refused = false;
				_open();
			},
		};
	}

	// The "data:" lines of a server-sent event stream, each one JSON event; comments (": ping") and ids are skipped.
	static async _events( body, each ) {
		const _reader = body.getReader();
		const _decoder = new TextDecoder();
		let _buffer = '';
		for ( ;; ) {
			const { done, value } = await _reader.read();
			if ( done ) { return; }
			_buffer += _decoder.decode( value, { stream: true } );
			const _blocks = _buffer.split( /\r?\n\r?\n/ );
			_buffer = _blocks.pop();
			for ( const block of _blocks ) {
				const _data = block.split( /\r?\n/ ).filter( line => line.startsWith( 'data:' ) ).map( line => line.slice( 5 ).trimStart() ).join( '\n' );
				if ( _data ) { each( JSON.parse( _data ) ); }
			}
		}
	}

	static async _read( response ) {
		const _data = await response.json().catch( () => null );
		if ( !response.ok ) {
			throw Object.assign( new Error( _data?.error || `${response.status}` ), { status: response.status } );
		}
		return _data;
	}

} );
