// The core's only way to the gate. It can propose a contract and submit actions; it cannot confirm a contract,
// approve an action or see the channel keys. Every id is one path segment of its route, so no id can steer a call
// to another route (an operator route, say). A8: an answer the client cannot read is an error, never an empty
// answer, and a redirect is never followed: the gate's URL cannot hand the core's requests to another host. Every call
// carries the core token (GATE_CORE_TOKEN), so only the core may propose, lease and submit; it is not the operator pin.

app.define( 'Core.Outbound.GateClient', [], () => class GateClient {

	// A2: every call has a client timeout, shorter than any lease of an outward action.
	static TIMEOUT_MS = 30000;

	constructor( url, { timeoutMs = GateClient.TIMEOUT_MS, token = '' } = {} ) {
		this.url = url.replace( /\/$/, '' );
		this.timeoutMs = timeoutMs;
		this._headers = { 'Content-Type': 'application/json', ...( typeof token === 'string' && token ? { 'x-core-token': token } : {} ) };
	}

	async propose( contract ) {
		return this._call( 'POST', '/contracts', { spec: contract.canonical(), rules: contract.rules(), hash: contract.hash } );
	}

	async contract( hash ) {
		return this._call( 'GET', `/contracts/${GateClient.segment( hash )}` );
	}

	async submit( request ) {
		return this._call( 'POST', '/deliveries', request );
	}

	async delivery( id ) {
		return this._call( 'GET', `/deliveries/${GateClient.segment( id )}` );
	}

	// O9 at a restart: every delivery of one contract, also one whose record the dying core lost.
	async deliveries( contract ) {
		return this._call( 'GET', `/contracts/${GateClient.segment( contract )}/deliveries` );
	}

	// What actually arrived outside for one recipient; the world's view, used for the demo counters only.
	async outbox( target ) {
		return this._call( 'GET', `/outbox/${GateClient.segment( target )}` );
	}

	async lease( request ) {
		return this._call( 'POST', '/leases', request );
	}

	async beat( id, fence ) {
		return this._call( 'POST', `/leases/${GateClient.segment( id )}/beat`, { fence } );
	}

	// A4: a release carries the fencing token of the lease; without it the gate ends nothing.
	async release( id, fence ) {
		return this._call( 'POST', `/leases/${GateClient.segment( id )}/release`, { fence } );
	}

	async withdraw( id ) {
		return this._call( 'POST', `/deliveries/${GateClient.segment( id )}/withdraw`, {} );
	}

	// The worker presents the token of an approved action under its lease (O1, A6).
	async redeem( { delivery, approval, lease, fence } ) {
		return this._call( 'POST', `/deliveries/${GateClient.segment( delivery )}/redeem`, { approval, lease, fence } );
	}

	async unclear() {
		return this._call( 'GET', '/unclear' );
	}

	// What the agent proposes for the operator to decide at the gate (an action, a master-data value); the core can
	// submit and read, never decide.
	async proposeAt( request ) {
		return this._call( 'POST', '/proposals', request );
	}

	async gateProposal( id ) {
		return this._call( 'GET', `/proposals/${GateClient.segment( id )}` );
	}

	async gateProposals( { status = 'proposed', scope = null } = {} ) {
		const _query = new URLSearchParams( { status: String( status ), ...( scope ? { scope: String( scope ) } : {} ) } );
		return this._call( 'GET', `/proposals?${_query}` );
	}

	async learnedActions() {
		return this._call( 'GET', '/actions/learned' );
	}

	// One id as one path segment: encoded, and never "." or "..", which the URL would resolve to another route.
	static segment( id ) {
		const _text = typeof id === 'number' && Number.isFinite( id ) ? String( id ) : id;
		if ( typeof _text !== 'string' || _text === '' || _text === '.' || _text === '..' ) {
			throw new TypeError( `gate: ${typeof _text === 'string' ? JSON.stringify( _text ) : typeof _text} is no id` );
		}
		return encodeURIComponent( _text );
	}

	async _call( method, path, body ) {
		const _response = await fetch( `${this.url}${path}`, {
			method,
			headers: this._headers,
			body: body === undefined ? undefined : JSON.stringify( body ),
			redirect: 'error',
			signal: AbortSignal.timeout( this.timeoutMs ),
		} );
		const _text = await _response.text();
		let _data;
		let _readable = true;
		try {
			_data = JSON.parse( _text );
		} catch {
			_readable = false;
		}
		if ( _response.status < 200 || _response.status >= 300 ) {
			const _error = _readable && _data && typeof _data === 'object' && typeof _data.error === 'string' ? ` ${_data.error}` : '';
			throw new Error( `gate ${method} ${path}: ${_response.status}${_error}` );
		}
		if ( !_readable ) {
			throw new Error( `gate ${method} ${path}: ${_response.status} with an answer that is not JSON (A8)` );
		}
		return _data;
	}

} );
