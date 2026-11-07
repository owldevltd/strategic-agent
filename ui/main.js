// The control room: start missions, confirm goals, approve actions and settle unclear ones at the gate, answer the
// core's questions, and follow both event logs live. The browser talks to the gate directly for anything a person
// decides there, with the operator pin; the core never sees that pin. The core's board takes its own pin.

app.define( 'Ui.Main', [ 'Ui.Describe', 'Ui.Cards', 'Ui.Client' ], ( Describe, Cards, Client ) => class Main {

	constructor( root ) {
		this.root = root;
		this.el = id => root.querySelector( `#${id}` );
		this._timers = {};
		this.streams = [];
	}

	// Replaying the history fires hundreds of events at once; each area refreshes at most once per 300 ms.
	_soon( name ) {
		if ( this._timers[ name ] ) { return; }
		this._timers[ name ] = setTimeout( () => {
			this._timers[ name ] = null;
			this[ name ]().catch( error => this._notice( error ) );
		}, 300 );
	}

	async start() {
		this.config = await ( await fetch( '/api/config' ) ).json();
		this.client = new Client( { gateUrl: this.config.gateUrl, pins: () => ( { gate: this.el( 'pin' ).value, board: this.el( 'board-pin' ).value } ) } );
		this.el( 'board-pin' ).parentElement.hidden = !this.config.boardPin;
		this.el( 'counters' ).hidden = !this.config.demo;
		this.el( 'system' ).replaceChildren( Main.text( 'span', `sandbox: ${this.config.runtime}` ), ' · ',
			Main.text( 'span', this.config.isolated ? 'isolated' : 'NOT isolated (development)', this.config.isolated ? '' : 'warn' ),
			' · ', Main.text( 'span', `model: ${this.config.provider}` ) );
		for ( const id of [ 'pin', 'board-pin' ] ) {
			this.el( id ).addEventListener( 'change', () => this._again() );
		}
		this.streams = [ this._listen( '/api/events', 'core' ), this._listen( `${this.config.gateUrl}/events`, 'gate' ) ];
		await this._load();
	}

	// A pin was entered: what was refused is asked again.
	_again() {
		this.streams.forEach( stream => stream.retry() );
		if ( !this.missions ) { this._load().catch( error => this._notice( error ) ); }
		[ '_refreshGate', '_refreshTickets', '_refreshCounters' ].forEach( name => this._soon( name ) );
	}

	async _load() {
		this.missions = await this.client.get( '/api/missions' ).catch( ( error ) => {
			this._notice( error );
			return null;
		} );
		if ( !this.missions ) { return; }
		this._notice( null );
		this._missions( this.missions );
		[ '_refreshGate', '_refreshTickets', '_refreshCounters' ].forEach( name => this._soon( name ) );
	}

	// A refusal for a missing pin says what to enter; nothing else is hidden.
	_notice( error ) {
		const _text = !error ? '' : error.status === 403 ? `${error.message}: enter it above.` : `Refused: ${error.message}`;
		this.el( 'notice' ).textContent = _text;
	}

	_missions( missions ) {
		const _box = this.el( 'missions' );
		_box.replaceChildren( this._freeTask() );
		for ( const mission of missions ) {
			const _card = Main.text( 'div', '', 'card' );
			const _task = document.createElement( 'textarea' );
			_task.value = mission.task;
			_task.rows = 3;
			const _button = Main.text( 'button', `Give the task (${mission.title})`, 'primary' );
			_button.addEventListener( 'click', async () => {
				this.mission = mission.id;
				const _response = await this.client.post( `/api/missions/${mission.id}/start`, { task: _task.value } );
				if ( !_response.ok ) {
					const _refused = await _response.json().catch( () => ( {} ) );
					_card.append( Main.text( 'pre', `Refused:\n${( _refused.problems || [ _refused.error ] ).join( '\n' )}`, 'rules' ) );
				}
			} );
			const _abort = Main.text( 'button', 'Abort the goal' );
			_abort.addEventListener( 'click', () => this.client.post( `/api/missions/${mission.id}/abort` ) );
			_card.append( Main.text( 'div', mission.title, 'title' ), _task, _button, ' ', _abort );
			// The demo's canned messages from outside reach both offices.
			if ( this.config.demo ) {
				const _inbound = Main.text( 'div', '', 'inbound' );
				for ( const message of mission.inbound ) {
					const _ask = Main.text( 'button', message.label );
					_ask.addEventListener( 'click', () => this.client.post( `/api/missions/${mission.id}/inbound/${message.id}` ) );
					_inbound.append( _ask );
				}
				_card.append( _inbound );
			}
			_box.append( _card );
		}
	}

	// A task without a mission: its kind (what the agent learns stays with it) and the text. The agent sets up the rest;
	// a person confirms each part where it is asked.
	_freeTask() {
		const _card = Main.text( 'div', '', 'card' );
		const _task = document.createElement( 'textarea' );
		_task.rows = 3;
		_task.placeholder = 'A task in your own words';
		const _kind = document.createElement( 'input' );
		_kind.placeholder = 'kind of task, e.g. hr-summaries (general when empty)';
		const _button = Main.text( 'button', 'Give the task', 'primary' );
		_button.addEventListener( 'click', async () => {
			const _response = await this.client.post( '/api/tasks', { task: _task.value, kind: _kind.value } );
			if ( _response.ok ) {
				this.mission = ( await _response.json().catch( () => ( {} ) ) ).mission || _kind.value || 'general';
				return;
			}
			const _refused = await _response.json().catch( () => ( {} ) );
			_card.append( Main.text( 'pre', `Refused:\n${( _refused.problems || [ _refused.error ] ).join( '\n' )}`, 'rules' ) );
		} );
		const _kinds = Main.text( 'div', '', 'inbound' );
		_card.append( Main.text( 'div', 'A task without a mission', 'title' ), _task, _kind, _button, _kinds );
		this._kinds( _kinds ).catch( () => null );
		return _card;
	}

	// The kinds of tasks the agent set up, each to be saved as a mission folder once it proved itself: the bundle is
	// downloaded, bin/promote.mjs writes and checks the folder, the operator reviews and commits it.
	async _kinds( box ) {
		for ( const item of await this.client.get( '/api/tasks' ) ) {
			const _save = Main.text( 'button', `Save "${item.kind}" as a mission (${item.strategies} strategies)` );
			_save.addEventListener( 'click', async () => {
				const _bundle = await this.client.get( `/api/tasks/${item.kind}/mission` );
				const _link = document.createElement( 'a' );
				_link.href = URL.createObjectURL( new Blob( [ JSON.stringify( _bundle, null, 2 ) ], { type: 'application/json' } ) );
				_link.download = `${item.kind}.mission.json`;
				_link.click();
				box.append( Main.text( 'pre', `node bin/promote.mjs --bundle ${item.kind}.mission.json --to missions`, 'rules' ) );
			} );
			box.append( _save );
		}
	}

	_listen( url, source ) {
		const _gate = [ 'contract_proposed', 'contract_confirmed', 'awaiting_approval', 'approved', 'approval_refused', 'withdrawn', 'unclear', 'settled',
			'proposal_received', 'proposal_approved', 'proposal_rejected', 'proposal_revoked' ];
		const _tickets = [ 'ticket_opened', 'ticket_answered', 'ticket_withdrawn', 'ticket_expired' ];
		return this.client.stream( url, ( event ) => {
			this._line( event, source );
			if ( [ 'executed', 'baseline_sent' ].includes( event.kind ) ) { this._soon( '_refreshCounters' ); }
			if ( _tickets.includes( event.kind ) ) { this._soon( '_refreshTickets' ); }
			if ( source === 'gate' && _gate.includes( event.kind ) ) { this._soon( '_refreshGate' ); }
		}, ( state, status ) => {
			if ( state === 'refused' ) { this._notice( { status, message: source === 'gate' ? 'operator pin required' : 'board pin required' } ); }
		} );
	}

	// Counts over all started missions (the demo only); a mission that has not been started yet counts zero.
	async _refreshCounters() {
		if ( !this.config.demo ) { return; }
		const _all = await Promise.all( ( this.missions || [] ).map( mission => this.client.get( `/api/missions/${mission.id}/exposure` )
			.then( data => ( { ...data, mission: mission.id } ) ).catch( () => null ) ) );
		const _started = _all.filter( Boolean );
		const _current = _started.find( item => item.mission === this.mission ) || _started.at( -1 );
		if ( !_current ) { return; }
		const _format = value => ( _current.unit.startsWith( 'euros' ) ? `${value.toLocaleString()} €` : value );
		this.el( 'ours' ).textContent = _format( _current.ours );
		this.el( 'theirs' ).textContent = _format( _current.neighbour );
		this.root.querySelectorAll( '.counter small' ).forEach( ( el ) => {
			el.textContent = _current.unit;
		} );
	}

	_line( event, source ) {
		const { text, tone } = Describe.event( event );
		if ( !text ) { return; }
		const _li = document.createElement( 'li' );
		_li.dataset.time = event.time;
		const _clock = new Date( event.time ).toLocaleTimeString( [], { hour12: false } );
		_li.append( Main.text( 'span', _clock, 'time' ), Main.text( 'span', event.source || source, 'src' ), Main.text( 'span', text, tone ) );
		// Two streams replay their history on connect, so lines are placed by time, not by arrival.
		const _log = this.el( 'log' );
		const _after = [ ..._log.children ].find( item => item.dataset.time > event.time );
		_log.insertBefore( _li, _after || null );
		_log.scrollTop = _log.scrollHeight;
	}

	async _refreshTickets() {
		const _tickets = await this.client.get( '/api/tickets' );
		const _box = document.createElement( 'div' );
		for ( const ticket of _tickets ) {
			_box.append( Cards.ticket( ticket, { onAnswer: async ( option ) => {
				const _response = await this.client.post( `/api/tickets/${ticket.id}`, { choice: option, by: 'operator' } );
				this._soon( '_refreshTickets' );
				return _response;
			} } ) );
		}
		if ( !_tickets.length ) {
			_box.append( Main.text( 'div', 'No open questions.', 'card' ) );
		}
		this.el( 'tickets' ).replaceChildren( ..._box.children );
	}

	// What waits for a person at the gate: goals to confirm, actions to approve, unclear actions to settle.
	async _refreshGate() {
		const _gate = this.config.gateUrl;
		const _box = document.createElement( 'div' );
		const [ _proposed, _approvals, _unclear, _proposals ] = await Promise.all( [
			this.client.get( `${_gate}/contracts?status=proposed` ), this.client.get( `${_gate}/approvals` ), this.client.get( `${_gate}/unclear` ),
			this.client.get( `${_gate}/proposals` ).catch( () => [] ),
		] );
		for ( const contract of _proposed ) {
			_box.append( Cards.contract( contract, { onConfirm: () => this._post( `${_gate}/contracts/${contract.hash}/confirm`, { by: 'operator' } ) } ) );
		}
		for ( const approval of _approvals ) {
			const _url = `${_gate}/approvals/${approval.id}`;
			_box.append( Cards.approval( approval, { onDecide: ( decision, extra ) => this._post( _url, { decision, by: 'operator', ...extra } ) } ) );
		}
		for ( const delivery of _unclear ) {
			const _url = `${_gate}/unclear/${delivery.id}`;
			_box.append( Cards.unclear( delivery, { onSettle: ( result, reason ) => this._post( _url, { result, reason, by: 'operator' } ) } ) );
		}
		for ( const proposal of _proposals ) {
			const _url = `${_gate}/proposals/${proposal.id}`;
			_box.append( Cards.gateProposal( proposal, { onDecide: ( decision, reason ) => this._post( _url, { decision, reason, by: 'operator' } ) } ) );
		}
		if ( !_box.children.length ) {
			_box.append( Main.text( 'div', 'Nothing waits for a person.', 'card' ) );
		}
		this.el( 'gate' ).replaceChildren( ..._box.children );
	}

	async _post( url, body ) {
		const _response = await this.client.post( url, body );
		this._soon( '_refreshGate' );
		return _response;
	}

	static text( tag, text, className = '' ) {
		const _el = document.createElement( tag );
		_el.textContent = text;
		if ( className ) { _el.className = className; }
		return _el;
	}

} );
