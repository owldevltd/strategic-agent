// Turns the real event stream of core and gate into what the office shows. Every event that matters becomes a
// beat: a figure walks, a thing flies, a wall rises, a person stamps. Beats play one after another so a person
// can follow them; when they pile up, the stage plays faster. Nothing here decides anything: it only shows what
// the log says happened.

app.define( 'Ui.Office.Director', [ 'Ui.Office.Sprites', 'Ui.Office.Stage' ], ( Sprites, Stage ) => class Director {

	static THINGS = { report: 'REPORT', reply: 'LETTER', invite: 'LETTER_KEY', payment: 'COIN' };

	constructor( stage, missions = [] ) {
		this.stage = stage;
		this.missions = missions;
		this.queue = [];
		this.nodes = new Map();
		this.deliveries = new Map();
		this._busy = false;
	}

	// Every event teaches the director who is who, even when it is not shown (the history at connect).
	learn( event ) {
		const _d = event.data || {};
		if ( event.kind === 'node_created' ) {
			const _parent = this.nodes.get( _d.parent );
			const _mission = _d.mission || _parent?.mission;
			// A new case from outside (8.1) or a proposal for the catalog (6.1) is a process of its own; on the stage it
			// stands beside the goal of its mission like a child.
			const _own = [ 'request', 'meta' ].includes( _d.spec?.kind ) && !_d.parent;
			const _goal = ( [ , info ] ) => !info.depth && info.mission === _mission && !info.own;
			const _root = _own ? [ ...this.nodes.entries() ].find( _goal )?.[ 0 ] : null;
			const _place = _own ? { depth: 1, parent: _root || null } : { depth: _d.depth, parent: _d.parent };
			this.nodes.set( event.node, { ..._place, mission: _mission, contract: _d.contract?.hash, own: _own } );
		}
		if ( [ 'request_accepted', 'refused' ].includes( event.kind ) && _d.delivery ) {
			this.deliveries.set( _d.delivery, { node: _d.node, action: _d.action, target: _d.target } );
		}
	}

	// The mission an event belongs to, or null when it cannot be told.
	mission( event ) {
		const _d = event.data || {};
		if ( _d.mission ) { return _d.mission; }
		const _node = event.node || _d.node || this.deliveries.get( _d.delivery )?.node;
		if ( this.nodes.has( _node ) ) { return this.nodes.get( _node ).mission; }
		const _id = _d.id || _d.contract?.id || '';
		return this.missions.find( name => String( _id ).startsWith( `${name}-` ) ) || null;
	}

	show( event ) {
		const _mission = this.mission( event );
		if ( _mission && _mission !== this.stage.mission ) { return; }
		const _beat = this._beat( event );
		if ( _beat ) {
			this.queue.push( _beat );
			this._play();
		}
	}

	async _play() {
		if ( this._busy ) { return; }
		this._busy = true;
		while ( this.queue.length ) {
			this.stage.speed = this.queue.length > 14 ? 4 : this.queue.length > 6 ? 2 : 1;
			try {
				await this.queue.shift()();
			} catch ( error ) {
				app.fail( error );
			}
		}
		this.stage.speed = 1;
		this._busy = false;
	}

	// The figure of the node an event is about.
	_agent( event ) {
		const _node = event.node || event.data?.node || this.deliveries.get( event.data?.delivery )?.node;
		const _info = this.nodes.get( _node ) || { depth: 0 };
		return _node ? this.stage.agent( _node, _info ) : this.stage.agent( 'root' );
	}

	_outside( name ) {
		const _team = this.stage.scene.teams[ name ];
		return this.stage.street.get( _team ? _team[ 0 ] : name ) || this.stage.street.get( 'ceo' ) || [ ...this.stage.street.values() ][ 0 ];
	}

	_beat( event ) {
		const _method = `_on${event.kind.replace( /(^|_)([a-z])/g, ( _all, _sep, char ) => char.toUpperCase() )}`;
		return this[ _method ] ? () => this[ _method ]( event, event.data || {} ) : null;
	}

	// --- the goal ---------------------------------------------------------------------------------------------

	async _onTaskReceived( event, d ) {
		const s = this.stage;
		s.say( s.person, `Task: ${d.task}`, 'wait', 2600 );
		await s.wait( 1400 );
	}

	async _onNodeCreated( event, d ) {
		const s = this.stage;
		const _info = this.nodes.get( event.node ) || { depth: d.depth, parent: d.parent };
		const _agent = s.agent( event.node, { depth: _info.depth, parent: _info.parent } );
		if ( _info.depth ) {
			s.puff( { x: _agent.x, y: _agent.y } );
			s.say( _agent, `${_info.own ? 'own process' : 'child'}: ${d.contract.goal}`, 'plain', 2200 );
			await s.walk( _agent, s.homeOf( _agent ) );
		} else {
			s.say( _agent, `goal: ${d.contract.goal}`, 'plain', 2400 );
			await s.wait( 1000 );
		}
	}

	async _onContractProposed() {
		const s = this.stage;
		s.say( s.person, 'Confirm this goal and its rules?', 'wait', 3000 );
		await s.wait( 900 );
	}

	async _onContractConfirmed() {
		this.stage.mark( this.stage.person, true );
		this.stage.say( this.stage.person, 'Goal confirmed. Rules frozen.', 'ok', 1800 );
		await this.stage.wait( 700 );
	}

	async _onContractDerived( event, d ) {
		this.stage.say( this.stage.guard, `child goal keeps every rule of ${Stage.short( d.parent, 16 )}`, 'ok', 1800 );
		await this.stage.wait( 500 );
	}

	async _onStateChanged( event, d ) {
		const s = this.stage;
		const _agent = this._agent( event );
		if ( d.to === 'executing' && d.strategy ) {
			s.say( _agent, `strategy: ${d.strategy}`, 'plain', 1800 );
			await s.wait( 700 );
		} else if ( d.to === 'closed' ) {
			const _ok = d.result?.status === 'fulfilled';
			s.mark( _agent, _ok );
			s.say( _agent, _ok ? 'done, with evidence' : `${d.result?.status || 'closed'}`, _ok ? 'ok' : 'no', 2200 );
			await s.wait( 900 );
			if ( _agent.depth ) {
				const _parent = this.nodes.get( event.node )?.parent;
				const _home = _parent ? s.agents.get( _parent ) : null;
				if ( _home ) { await s.walk( _agent, { x: _home.x + 0.5, y: _home.y } ); }
				_agent.alpha = 0;
				s.agents.delete( event.node );
			} else {
				await s.walk( _agent, 'home' );
			}
		}
	}

	async _onVerdict( event, d ) {
		// An open attempt simply goes on (19); that is no moment to show.
		if ( d.verdict === 'continue' ) { return; }
		const _text = d.overruled ? `model said ${d.proposed} → OVERRULED: ${d.rule} ${d.verdict}` : `${d.rule}: ${d.verdict}`;
		this.stage.say( this._agent( event ), _text, d.overruled ? 'no' : 'plain', 2400 );
		await this.stage.wait( d.overruled ? 1300 : 700 );
	}

	async _onCheck( event, d ) {
		if ( d.ok || d.gate !== 'G2' ) { return; }
		const _agent = this._agent( event );
		await this.stage.wall( { x: _agent.x + 1, y: _agent.y }, `G2: ${( d.problems || [] )[ 0 ] || 'plan refused'}` );
	}

	async _onWall( event, d ) {
		if ( [ 'group_too_small', 'difference_too_small', 'label_blocked', 'already_done', 'unknown_account', 'budget_cap', 'plan_refused' ].includes( d.cause ) ) {
			return;
		}
		const _agent = this._agent( event );
		await this.stage.wall( { x: _agent.x + 1, y: _agent.y }, `${d.cause}: ${d.reason || ''}` );
	}

	async _onValue( event, d ) {
		const _agent = this._agent( event );
		_agent.labels = ( d.labels || [] ).filter( label => Sprites.LABELS[ label ] ).slice( 0, 3 );
		if ( d.groupSize !== null && d.groupSize !== undefined ) {
			this.stage.say( _agent, `group of ${d.groupSize}`, 'plain', 1500 );
		}
		await this.stage.wait( 300 );
	}

	async _onAiAnswered( event, d ) {
		if ( ![ 'writer', 'replier', 'contract', 'extractor', 'correlator' ].includes( d.role ) || !event.node ) { return; }
		this.stage.say( this._agent( event ), `model (${d.role})${d.ok ? '' : ': broke its contract'}`, d.ok ? 'plain' : 'no', 1200 );
		await this.stage.wait( 350 );
	}

	// --- the sandbox --------------------------------------------------------------------------------------------

	async _onSandboxStarted( event ) {
		const s = this.stage;
		const _agent = this._agent( event );
		await s.walk( _agent, _agent.depth ? { x: 6.6 + Math.random() * 0.5, y: 4.1 } : 'sandbox' );
		s.state.sandbox = true;
		s.say( _agent, 'code runs in the sandbox', 'plain', 1200 );
		await s.wait( 500 );
	}

	async _onSandboxDestroyed() {
		const s = this.stage;
		s.state.sandbox = false;
		s.puff( { x: 5.4, y: 2.4 } );
		await s.wait( 250 );
	}

	async _onCodeRepair( event, d ) {
		const _says = ( d.broken || [] ).map( item => item.says ).join( ' ' );
		this.stage.say( this._agent( event ), `code failed: ${_says.replace( /^Your code raised /, '' )} → rewrite once`, 'no', 2200 );
		await this.stage.wait( 1000 );
	}

	// The escape test: attacker code runs in the same sandbox as the agent's code, one try after the other.
	async _onSandboxProbesStarted() {
		const s = this.stage;
		const _agent = this._main();
		await s.walk( _agent, 'sandbox' );
		s.state.sandbox = true;
		s.say( _agent, 'escape test: attacker code in the sandbox', 'wait', 2000 );
		await s.wait( 900 );
	}

	async _onSandboxProbe( event, d ) {
		const s = this.stage;
		s.mark( 'sandbox', d.ok );
		s.say( this._main(), `${d.probe}: ${d.ok ? 'stopped' : 'ESCAPED'}`, d.ok ? 'ok' : 'no', 1600 );
		await s.wait( 1000 );
	}

	async _onSandboxProbesEnded( event, d ) {
		const s = this.stage;
		s.state.sandbox = false;
		s.puff( 'sandbox' );
		s.say( this._main(), `${d.stopped} of ${d.of} stopped`, d.stopped === d.of ? 'ok' : 'no', 2200 );
		await s.wait( 900 );
		await s.walk( this._main(), 'home' );
	}

	// The figure of the mission's goal, if one is on the stage.
	_main() {
		const _mine = ( [ id, info ] ) => !info.depth && !info.own && info.mission === this.stage.mission && this.stage.agents.has( id );
		const _root = [ ...this.nodes.entries() ].reverse().find( _mine );
		return _root ? this.stage.agents.get( _root[ 0 ] ) : this.stage.agent( 'root' );
	}

	// --- the gate ---------------------------------------------------------------------------------------------

	async _onRequestAccepted( event, d ) {
		const s = this.stage;
		const _agent = this._agent( event );
		_agent.carry = Sprites[ Director.THINGS[ d.action ] || 'LETTER' ];
		await s.walk( _agent, _agent.depth ? { x: 11.6 + Math.random() * 0.5, y: 6.3 } : 'gate' );
		s.say( s.guard, `${d.action} → ${d.target}: rules hold`, 'ok', 1500 );
		await s.wait( 600 );
	}

	async _onRefused( event, d ) {
		const s = this.stage;
		const _agent = this._agent( event );
		_agent.carry = Sprites[ Director.THINGS[ d.action ] || 'LETTER' ];
		await s.walk( _agent, _agent.depth ? { x: 11.6, y: 6.3 } : 'gate' );
		const _reason = ( d.reasons || [] ).map( item => item.reason ).join( '; ' );
		s.say( s.guard, 'no.', 'no', 2600 );
		await s.wall( { x: 12.5, y: 7.3 }, `BLOCKED ${_reason}`, { ms: 4200 } );
		_agent.carry = null;
		await s.walk( _agent, s.homeOf( _agent ) );
	}

	async _onAwaitingApproval( event, d ) {
		const s = this.stage;
		const _thing = Sprites[ Director.THINGS[ d.summary.action ] || 'LETTER' ];
		await s.fly( _thing, 'gate', { x: 10.5, y: 3.4 }, { ms: 700 } );
		const _what = d.summary.action === 'payment' ? `pay ${d.summary.params.amount} € to ${d.summary.params.iban?.slice( -4 )}?` : `send this ${d.summary.action} to ${d.summary.target}?`;
		s.say( s.person, `Approve: ${_what}`, 'wait', 6000 );
		await s.wait( 900 );
	}

	async _onApproved( event, d ) {
		this.stage.mark( this.stage.person, true );
		this.stage.say( this.stage.person, `approved by ${d.by}`, 'ok', 1400 );
		await this.stage.wait( 500 );
	}

	async _onApprovalRefused( event, d ) {
		this.stage.mark( this.stage.person, false );
		this.stage.say( this.stage.person, d.expired ? 'too late, expired' : 'rejected', 'no', 1600 );
		await this.stage.wait( 600 );
	}

	async _onExecuted( event, d ) {
		const s = this.stage;
		const _delivery = this.deliveries.get( d.delivery ) || {};
		const _target = this._outside( _delivery.target );
		const _agent = _delivery.node && s.agents.get( _delivery.node );
		if ( _agent ) { _agent.carry = null; }
		await s.fly( Sprites[ Director.THINGS[ _delivery.action ] || 'LETTER' ], 'door', { x: _target.x, y: _target.y - 0.4 }, { ms: 900, arc: 0.6 } );
		s.say( _target, _delivery.action === 'payment' ? 'paid' : 'received', 'ok', 1500 );
		s.onCount?.();
		if ( _agent ) { s.walk( _agent, s.homeOf( _agent ) ); }
		await s.wait( 500 );
	}

	async _onWithdrawn() {
		this.stage.say( this.stage.guard, 'withdrawn, never sent', 'no', 1600 );
		await this.stage.wait( 500 );
	}

	async _onLeaseExpired( event, d ) {
		this.stage.say( this._agent( event ), `lease over: ${d.move} ended`, 'no', 1800 );
		await this.stage.wait( 600 );
	}

	async _onAbortReceived( event, d ) {
		this.stage.say( this._agent( event ), `ABORT: ${d.reason}`, 'no', 2200 );
		await this.stage.wait( 600 );
	}

	// --- people, tickets ------------------------------------------------------------------------------------------

	async _onTicketOpened( event, d ) {
		const s = this.stage;
		const _agent = event.node && this.nodes.has( event.node ) ? this._agent( event ) : null;
		if ( _agent ) { await s.walk( _agent, _agent.depth ? { x: 9.6, y: 4.6 } : 'desk' ); }
		s.say( s.person, `? ${d.question}`, 'wait', 6000 );
		await s.wait( 900 );
	}

	async _onTicketAnswered( event, d ) {
		const s = this.stage;
		s.mark( s.person, true );
		s.say( s.person, d.choice, 'ok', 1800 );
		const _agent = event.node && this.nodes.has( event.node ) ? this._agent( event ) : null;
		if ( _agent ) { s.walk( _agent, s.homeOf( _agent ) ); }
		await s.wait( 700 );
	}

	// --- expectations and the world ---------------------------------------------------------------------------

	async _onExpectationCreated( event, d ) {
		this.stage.say( this._agent( event ), `expects ${d.need} answers · key ${d.keys[ 0 ]}`, 'wait', 2400 );
		await this.stage.wait( 800 );
	}

	async _onWaitingFor( event, d ) {
		const _agent = this._agent( event );
		await this.stage.walk( _agent, this.stage.homeOf( _agent ) );
		this.stage.say( _agent, `waiting for ${d.need} answers…`, 'wait', 60000 );
	}

	async _onWaitEnded( event, d ) {
		const _met = d.status === 'met';
		this.stage.say( this._agent( event ), _met ? `${d.count} of ${d.need}: enough` : `${d.status}: ${d.count} of ${d.need}`, _met ? 'ok' : 'no', 2200 );
		await this.stage.wait( 800 );
	}

	async _onWorldReceived( event, d ) {
		for ( const name of this.stage.scene.teams[ d.team ] || [] ) {
			this.stage.say( this.stage.street.get( name ), 'an invitation!', 'plain', 1500 );
		}
		await this.stage.wait( 400 );
	}

	async _onWorldReplied( event, d ) {
		const s = this.stage;
		const _person = s.street.get( d.from ) || this._outside( d.from );
		const _keyed = d.subject.includes( '[' );
		s.say( _person, _keyed ? `reply ${d.subject.match( /\[(.*)\]/ )?.[ 1 ] || ''}` : 'reply (no reference)', 'plain', 1600 );
		await s.fly( _keyed ? Sprites.LETTER_KEY : Sprites.LETTER, { x: _person.x, y: _person.y - 0.6 }, 'slot', { ms: 800 } );
	}

	async _onInboundReceived() {
		this.stage.state.inbox++;
		await this.stage.wait( 200 );
	}

	// A message that matches nothing waiting: the desk takes it as a new case (its letter is shown there).
	async _onInboundNewCase() {
		this.stage.state.inbox = Math.max( 0, this.stage.state.inbox - 1 );
		await this.stage.wait( 100 );
	}

	async _onInboundMatchedByModel( event, d ) {
		this.stage.say( this.stage.guard, d.expectation ? 'no key: model matched it' : 'matches nothing: a new case', 'plain', 1800 );
		await this.stage.wait( 600 );
	}

	async _onFactQueued( event, d ) {
		const s = this.stage;
		const _agent = this._agent( event );
		s.state.inbox = Math.max( 0, s.state.inbox - 1 );
		await s.fly( Sprites.STAMP, 'inbox', { x: _agent.x, y: _agent.y - 0.6 }, { ms: 600, arc: 0.4 } );
		s.say( _agent, d.late ? 'a LATE answer: still valid' : 'a fact, never the text', d.late ? 'wait' : 'ok', 1500 );
		await s.wait( 400 );
	}

	// 8.1: a message that matches nothing waiting is a case of its own; its figure fetches the letter, labelled foreign.
	async _onInboundCase( event, d ) {
		const s = this.stage;
		const _from = this._outside( d.from );
		s.say( _from, String( d.concern?.intent || 'a request' ).replace( /_/g, ' ' ), 'plain', 2600 );
		await s.fly( Sprites.LETTER, { x: _from.x, y: _from.y - 0.6 }, 'slot', { ms: 900 } );
		const _agent = this._agent( event );
		await s.walk( _agent, 'inbox' );
		s.state.inbox = Math.max( 0, s.state.inbox - 1 );
		_agent.labels = [ 'foreign' ];
		s.say( _agent, 'a case of its own', 'plain', 1600 );
		await s.walk( _agent, s.homeOf( _agent ) );
	}

	// 19: the review after t_signal; without a signal another way is tried.
	async _onReviewDue( event ) {
		this.stage.say( this._agent( event ), 'review: any signal yet?', 'wait', 1800 );
		await this.stage.wait( 600 );
	}

	// 6.1: a new strategy is no shortcut; it runs as its own process, and a person decides.
	async _onProcessStarted( event, d ) {
		this.stage.say( this._agent( event ), `new ${d.kind}: its own process`, 'wait', 2000 );
		await this.stage.wait( 700 );
	}

	// O1, A6: the token counts only under a valid lease.
	async _onTokenConsumed() {
		this.stage.say( this.stage.guard, 'token checked: lease, hash, expiry', 'ok', 1600 );
		await this.stage.wait( 500 );
	}

	async _onRedeemRefused( event, d ) {
		this.stage.say( this.stage.guard, `token refused: ${Stage.short( d.reasons?.[ 0 ]?.reason || '', 36 )}`, 'no', 2000 );
		await this.stage.wait( 700 );
	}

	// 3.2: only the client changes the goal, by ticket.
	async _onContractAmended( event, d ) {
		this.stage.say( this.stage.person, `goal changed by ${d.by}`, 'ok', 2000 );
		await this.stage.wait( 700 );
	}

	// --- the neighbour --------------------------------------------------------------------------------------------

	async _onBaselineSent( event, d ) {
		const s = this.stage;
		const _target = this._outside( d.target );
		s.say( s.neighbour, `"${d.body}"`, 'no', 4200 );
		await s.walk( s.neighbour, 'neighbourDoor' );
		await s.fly( d.payments?.length ? Sprites.COIN : Sprites.LETTER, 'neighbourDoor', { x: _target.x, y: _target.y - 0.4 }, { ms: 900 } );
		s.say( _target, d.payments?.length ? 'paid!' : 'now I know', 'no', 1800 );
		s.onCount?.();
		await s.walk( s.neighbour, 'neighbour' );
	}

} );
