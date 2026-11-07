// The office page: one mission at a time in the same pixel office, switched at the top; the person's cards and
// the live log on the right. Core and gate stream their event logs; every line in the log is a real event, and
// the figures move because of exactly these events. The gate takes the operator pin, the core its board pin (Ui.Client).

app.define( 'Ui.Office.Office', [ 'Ui.Office.Stage', 'Ui.Office.Director', 'Ui.Describe', 'Ui.Cards', 'Ui.Client' ], (
	Stage, Director, Describe, Cards, Client,
) => class Office {

	constructor( root ) {
		this.root = root;
		this.el = id => root.querySelector( `#${id}` );
		this.events = [];
		this._timers = {};
	}

	async start() {
		this.config = await ( await fetch( '/api/config' ) ).json();
		this.client = new Client( { gateUrl: this.config.gateUrl, pins: () => ( { gate: this.el( 'pin' ).value, board: this.el( 'board-pin' ).value } ) } );
		this.el( 'board-pin' ).parentElement.hidden = !this.config.boardPin;
		this.missions = await this._missions();
		this.stage = new Stage( this.el( 'stage' ) );
		// The counters change when the office shows the thing arriving outside, not before.
		this.stage.onCount = () => this._soon( '_refreshCounters' );
		this.director = new Director( this.stage, this.missions.map( item => item.id ) );
		this.el( 'system' ).textContent = `model ${this.config.provider} · sandbox ${this.config.runtime}${this.config.isolated ? '' : ' (not isolated)'}`;
		this._tabs();
		this.select( this.missions[ 0 ].id );
		this.stage.start();
		this._since = Date.now() - 1000;
		this.streams = [ this._listen( '/api/events', 'core' ), this._listen( `${this.config.gateUrl}/events`, 'gate' ) ];
		for ( const id of [ 'pin', 'board-pin' ] ) {
			this.el( id ).addEventListener( 'change', () => this._again() );
		}
	}

	// The missions need the board pin when one is set: the page waits until it is entered.
	async _missions() {
		for ( ;; ) {
			try {
				const _missions = await this.client.get( '/api/missions' );
				this.el( 'notice' ).textContent = '';
				return _missions;
			} catch ( error ) {
				if ( error.status !== 403 ) { throw error; }
				this.el( 'notice' ).textContent = 'Enter the board pin to see the missions.';
				await new Promise( resolve => this.el( 'board-pin' ).addEventListener( 'change', resolve, { once: true } ) );
			}
		}
	}

	// A pin was entered: what was refused is asked again.
	_again() {
		this.streams?.forEach( stream => stream.retry() );
		this._soon( '_refreshPerson' );
		this._soon( '_refreshCounters' );
	}

	_tabs() {
		const _box = this.el( 'tabs' );
		for ( const mission of this.missions ) {
			const _tab = Cards.text( 'button', mission.title, 'tab' );
			_tab.dataset.mission = mission.id;
			_tab.addEventListener( 'click', () => this.select( mission.id ) );
			_box.append( _tab );
		}
	}

	select( id ) {
		this.mission = this.missions.find( item => item.id === id );
		this.root.querySelectorAll( '.tab' ).forEach( tab => tab.classList.toggle( 'on', tab.dataset.mission === id ) );
		this.stage.setMission( id, this.mission.office );
		this.director.queue = [];
		this.el( 'task' ).value = this.mission.task;
		const _actions = this.el( 'actions' );
		_actions.replaceChildren();
		const _give = Cards.text( 'button', 'Give the task', 'primary' );
		_give.addEventListener( 'click', () => this._start() );
		const _abort = Cards.text( 'button', 'Abort' );
		_abort.addEventListener( 'click', () => this.client.post( `/api/missions/${id}/abort` ) );
		_actions.append( _give );
		// The demo: canned messages from outside, and anyone may try to break out of the sandbox the agent's code runs in (7.1).
		if ( this.config.demo ) {
			for ( const message of this.mission.inbound ) {
				const _ask = Cards.text( 'button', message.label );
				_ask.addEventListener( 'click', () => this.client.post( `/api/missions/${id}/inbound/${message.id}` ) );
				_actions.append( _ask );
			}
			const _escape = Cards.text( 'button', 'Try to break out of the sandbox' );
			_escape.addEventListener( 'click', () => this._escape() );
			_actions.append( _escape );
		}
		_actions.append( _abort );
		this._renderLog();
		this._soon( '_refreshPerson' );
		this._soon( '_refreshCounters' );
	}

	async _escape() {
		const _response = await this.client.post( `/api/missions/${this.mission.id}/probes` );
		const _body = await _response.json().catch( () => ( {} ) );
		this.el( 'notice' ).textContent = _response.ok ? '' : `Escape test: ${_body.error || _response.status}`;
	}

	async _start() {
		const _response = await this.client.post( `/api/missions/${this.mission.id}/start`, { task: this.el( 'task' ).value } );
		if ( !_response.ok ) {
			const _refused = await _response.json().catch( () => ( {} ) );
			this.el( 'notice' ).textContent = `Goal refused at G1: ${( _refused.problems || [ _refused.error ] ).join( '; ' )}`;
		} else {
			this.el( 'notice' ).textContent = '';
		}
	}

	// Both logs replay their history on connect: it teaches the director and fills the log, but only what happens
	// from now on is played in the office.
	_listen( url, source ) {
		return this.client.stream( url, ( event ) => {
			const _event = { ...event, stream: source };
			this.events.push( _event );
			this.director.learn( _event );
			if ( Date.parse( _event.time ) >= this._since ) {
				// The office follows a goal that was just given, wherever it was started.
				const _mission = _event.kind === 'node_created' && !_event.data.parent && _event.data.mission;
				if ( _mission && _mission !== this.mission.id ) { this.select( _mission ); }
				this.director.show( _event );
			}
			if ( this._mine( _event ) ) { this._line( _event ); }
			if ( Date.parse( _event.time ) < this._since && [ 'executed', 'baseline_sent' ].includes( _event.kind ) ) {
				this._soon( '_refreshCounters' );
			}
			const _person = [ 'ticket_opened', 'ticket_answered', 'ticket_withdrawn', 'ticket_expired', 'contract_proposed', 'contract_confirmed',
				'awaiting_approval', 'approved', 'approval_refused', 'withdrawn', 'unclear', 'settled' ];
			if ( _person.includes( _event.kind ) ) { this._soon( '_refreshPerson' ); }
		}, ( state ) => {
			if ( state === 'refused' ) { this.el( 'notice' ).textContent = `Enter the ${source === 'gate' ? 'operator' : 'board'} pin to follow the ${source}.`; }
			if ( state === 'open' ) { this.el( 'notice' ).textContent = ''; }
		} );
	}

	_mine( event ) {
		const _mission = this.director.mission( event );
		return !_mission || _mission === this.mission.id;
	}

	_renderLog() {
		this.el( 'log' ).replaceChildren();
		this.events.filter( event => this._mine( event ) ).slice( -300 ).forEach( event => this._line( event ) );
	}

	_line( event ) {
		let _described;
		try {
			_described = Describe.event( event );
		} catch {
			_described = { text: event.kind, tone: '' };
		}
		const { tone } = _described;
		const text = _described.text && _described.text.length > 320 ? `${_described.text.slice( 0, 319 )}…` : _described.text;
		if ( !text ) { return; }
		const _li = document.createElement( 'li' );
		_li.dataset.time = event.time;
		const _clock = new Date( event.time ).toLocaleTimeString( [], { hour12: false } );
		_li.append( Cards.text( 'span', _clock, 'time' ), Cards.text( 'span', event.source || event.stream, 'src' ), Cards.text( 'span', text, tone ) );
		const _log = this.el( 'log' );
		const _after = [ ..._log.children ].find( item => item.dataset.time > event.time );
		_log.insertBefore( _li, _after || null );
		while ( _log.children.length > 400 ) { _log.firstChild.remove(); }
		_log.scrollTop = _log.scrollHeight;
	}

	// What waits for a person: goals to confirm, actions to approve and unclear actions to settle at the gate, questions
	// from the core. What a missing pin keeps back is left out until the pin is entered.
	async _refreshPerson() {
		const _box = document.createElement( 'div' );
		const _gate = this.config.gateUrl;
		const _get = url => this.client.get( url ).catch( () => [] );
		const [ _proposed, _approvals, _unclear, _tickets ] = await Promise.all( [
			_get( `${_gate}/contracts?status=proposed` ), _get( `${_gate}/approvals` ), _get( `${_gate}/unclear` ), _get( '/api/tickets' ),
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
		for ( const ticket of _tickets ) {
			_box.append( Cards.ticket( ticket, { onAnswer: option => this._post( `/api/tickets/${ticket.id}`, { choice: option, by: 'operator' } ) } ) );
		}
		if ( !_box.children.length ) {
			_box.append( Cards.text( 'div', 'Nothing waits for you.', 'card soft' ) );
		}
		this.el( 'person' ).replaceChildren( ..._box.children );
	}

	// The demo's counters: our office and the neighbour's without a gate.
	async _refreshCounters() {
		if ( !this.config.demo ) {
			this.stage.counters = null;
			return;
		}
		const _data = await this.client.get( `/api/missions/${this.mission.id}/exposure` ).catch( () => null );
		if ( !_data ) {
			this.stage.counters = { ours: 0, theirs: 0 };
			return;
		}
		const _format = value => ( _data.unit.startsWith( 'euros' ) ? `${Number( value ).toLocaleString( 'en' )} €` : `${value} ${value === 1 ? 'person' : 'people'}` );
		this.stage.counters = { ours: _format( _data.ours ), theirs: _format( _data.neighbour ) };
	}

	async _post( url, body ) {
		const _response = await this.client.post( url, body );
		this._soon( '_refreshPerson' );
		return _response;
	}

	_soon( name ) {
		if ( this._timers[ name ] ) { return; }
		this._timers[ name ] = setTimeout( () => {
			this._timers[ name ] = null;
			this[ name ]().catch( app.fail );
		}, 250 );
	}

} );
