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
		// The runs of each mission the logs have shown (the root node and whether it is still open); the buttons follow them.
		this.runs = {};
		this.pinOk = false;
		// What the run of the shown mission is doing now, from its last event; and whether a card waits for the person.
		this.activity = null;
		this.waitsForYou = false;
	}

	async start() {
		this.config = await ( await fetch( '/api/config' ) ).json();
		this.client = new Client( { gateUrl: this.config.gateUrl, pins: () => ( { gate: this.el( 'pin' ).value, board: this.el( 'board-pin' ).value } ) } );
		this.el( 'board-pin' ).parentElement.hidden = !this.config.boardPin;
		this.missions = await this._missions();
		// A page that opens late still knows each mission's task run (the live log shows only the last events).
		for ( const mission of this.missions ) {
			if ( mission.run ) { this.runs[ mission.id ] = { ...mission.run }; }
		}
		this._help();
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
		// The operator pin is checked at the gate as it is typed, once it is long enough to be one.
		let _typing = null;
		this.el( 'pin' ).addEventListener( 'input', () => {
			clearTimeout( _typing );
			_typing = setTimeout( () => this._checkPin(), 450 );
		} );
		// A link may carry the demo's pin after the # (it never reaches a server, so the core never sees it).
		const _given = new URLSearchParams( location.hash.slice( 1 ) ).get( 'pin' );
		if ( _given ) { this.el( 'pin' ).value = _given; }
		await this._checkPin();
		setInterval( () => this._status(), 1000 );
	}

	// The help: what the visitor sees, what to press and what to expect. Opens by itself on the first visit.
	_help() {
		const _box = this.el( 'help' );
		const _close = () => {
			_box.hidden = true;
			try { localStorage.setItem( 'agency-help-seen', '1' ); } catch { /* a browser without storage shows it again */ }
		};
		this.el( 'help-open' ).addEventListener( 'click', () => { _box.hidden = false; } );
		this.el( 'help-close' ).addEventListener( 'click', _close );
		this.el( 'help-start' ).addEventListener( 'click', _close );
		_box.addEventListener( 'click', ( event ) => { if ( event.target === _box ) { _close(); } } );
		document.addEventListener( 'keydown', ( event ) => { if ( event.key === 'Escape' && !_box.hidden ) { _close(); } } );
		_box.hidden = Office.seen();
	}

	// Whether this browser closed the help before; a browser without storage has not.
	static seen() {
		try {
			return localStorage.getItem( 'agency-help-seen' ) === '1';
		} catch {
			return false;
		}
	}

	// Some steps take a while (a model thinks, the sandbox starts, colleagues answer): the line under the buttons says
	// what the run is doing and for how long, or that it waits for the person.
	_status() {
		const _run = this.mission && this.runs[ this.mission.id ];
		const _busy = this.pinOk && ( this._starting || Boolean( _run?.open ) );
		const _el = this.el( 'status' );
		_el.hidden = !_busy;
		if ( !_busy ) { return; }
		_el.classList.toggle( 'you', this.waitsForYou );
		const _since = this.activity ? Math.max( 0, Math.round( ( Date.now() - this.activity.at ) / 1000 ) ) : 0;
		const _text = this.waitsForYou ? 'Waits for you on the right →'
			: `${this.activity?.text || 'Drafting the goal with the model'}${_since >= 3 ? ` · ${_since} s` : ''}`;
		this.el( 'status-text' ).textContent = _text;
	}

	// The step an event of the run stands for, in a few words; null when it says nothing new about what runs now.
	static phase( event ) {
		const _d = event.data || {};
		const _states = { planning: 'Planning: the model chooses a strategy', executing: 'Executing the plan', judging: 'Judging what happened',
			waiting: 'Waiting for the world to answer', closing: 'Closing: checking the evidence' };
		switch ( event.kind ) {
			case 'task_received': case 'run_started': case 'node_created': return 'Drafting the goal with the model';
			case 'state_changed': return _states[ _d.to ] || null;
			case 'move_started': return `Running ${_d.move}`;
			case 'sandbox_started': return 'Code runs in the sandbox';
			case 'child_started': return 'A sub-goal starts';
			case 'waiting_for': return `Waiting for ${_d.need || 'answers'}`;
			case 'ai_answered': return 'The model answered';
			default: return null;
		}
	}

	// Nothing can be pressed before the gate took the operator pin: a person decides there, so the demo starts there.
	async _checkPin() {
		const _value = this.el( 'pin' ).value.trim();
		let _ok = false;
		let _why = 'Enter the operator pin on the right to start.';
		if ( !_value || _value.length >= 4 ) {
			try {
				await this.client.get( `${this.config.gateUrl}/approvals` );
				_ok = true;
			} catch ( error ) {
				if ( _value ) { _why = error.status === 429 ? 'Too many wrong pins from here: wait a minute.' : 'That is not the operator pin.'; }
			}
		}
		const _was = this.pinOk;
		this.pinOk = _ok;
		this.el( 'notice' ).textContent = _ok ? '' : _why;
		this.el( 'pin' ).classList.toggle( 'want', !_ok );
		if ( _ok && !_was ) { this._again(); }
		this._buttons();
	}

	// What can be pressed now: a task while the mission has no open run; the messages from outside once a task ran,
	// also after it closed (they ask about what it did), but not after an abort; abort while a run is open; the escape
	// test at any time. Everything needs the pin first.
	_buttons() {
		const _run = this.mission && this.runs[ this.mission.id ];
		const _asked = Boolean( _run ) && _run.status !== 'aborted';
		const _may = { give: !_run?.open && !this._starting, inbound: _asked, abort: Boolean( _run?.open ), escape: true };
		for ( const button of this.el( 'actions' )?.querySelectorAll( 'button' ) || [] ) {
			button.disabled = !this.pinOk || !_may[ button.dataset.role ];
		}
	}

	// A run of a mission begins with the root node of the task and ends when that node closes (fulfilled, failed or
	// aborted). A message from outside opens a case of its own and the agent's own proposals a process of their own:
	// their contracts name a goal above them (or are meta), and they are no run of the task.
	_track( event ) {
		const _contract = event.data?.contract || {};
		const _task = !event.data?.parent && !_contract.parent && _contract.kind !== 'meta';
		if ( event.kind === 'node_created' && _task && event.data?.mission ) {
			this.runs[ event.data.mission ] = { node: event.node, open: true };
			this._buttons();
		}
		if ( event.kind === 'node_closed' ) {
			const _run = Object.values( this.runs ).find( run => run.node === event.node );
			if ( _run ) {
				_run.open = false;
				_run.status = event.data?.result?.status || null;
				this._buttons();
			}
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
		_give.dataset.role = 'give';
		_give.addEventListener( 'click', () => this._start() );
		const _abort = Cards.text( 'button', 'Abort' );
		_abort.dataset.role = 'abort';
		_abort.addEventListener( 'click', () => this.client.post( `/api/missions/${id}/abort` ) );
		_actions.append( _give );
		// The demo: canned messages from outside, and anyone may try to break out of the sandbox the agent's code runs in (7.1).
		if ( this.config.demo ) {
			for ( const message of this.mission.inbound ) {
				const _ask = Cards.text( 'button', message.label );
				_ask.dataset.role = 'inbound';
				_ask.addEventListener( 'click', () => this.client.post( `/api/missions/${id}/inbound/${message.id}` ) );
				_actions.append( _ask );
			}
			const _escape = Cards.text( 'button', 'Try to break out of the sandbox' );
			_escape.dataset.role = 'escape';
			_escape.addEventListener( 'click', () => this._escape() );
			_actions.append( _escape );
		}
		_actions.append( _abort );
		this._buttons();
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
		// One press, one run: the button stays off until the log shows the run (or the start was refused).
		this._starting = true;
		this.activity = { text: 'Drafting the goal with the model', at: Date.now() };
		this._buttons();
		this._status();
		// Every visitor starts from the same office: the agent forgets what earlier runs of this mission taught it.
		await this.client.post( `/api/missions/${this.mission.id}/forget` ).catch( () => null );
		const _response = await this.client.post( `/api/missions/${this.mission.id}/start`, { task: this.el( 'task' ).value } ).finally( () => {
			this._starting = false;
		} );
		this._buttons();
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
			this._track( _event );
			this.director.learn( _event );
			if ( Date.parse( _event.time ) >= this._since ) {
				// The office follows a goal that was just given, wherever it was started.
				const _mission = _event.kind === 'node_created' && !_event.data.parent && _event.data.mission;
				if ( _mission && _mission !== this.mission.id ) { this.select( _mission ); }
				this.director.show( _event );
			}
			if ( this._mine( _event ) ) {
				this._line( _event );
				const _phase = Date.parse( _event.time ) >= this._since ? Office.phase( _event ) : null;
				if ( _phase ) { this.activity = { text: _phase, at: Date.now() }; }
			}
			if ( Date.parse( _event.time ) < this._since && [ 'executed', 'baseline_sent' ].includes( _event.kind ) ) {
				this._soon( '_refreshCounters' );
			}
			const _person = [ 'ticket_opened', 'ticket_answered', 'ticket_withdrawn', 'ticket_expired', 'contract_proposed', 'contract_confirmed', 'contract_withdrawn',
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
		this.waitsForYou = _box.children.length > 0;
		this._status();
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
