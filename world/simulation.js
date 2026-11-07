// The world outside, simulated for the demo and for testing a mission: people who only see what actually arrived in
// their inbox at the gate, and who answer like people do (at once, late, twice, without the reference, or never), and
// responders (a monitoring system, a supplier, a customer) that answer a given action to a given recipient. Their
// replies enter the core like any other message from outside, as their own processes. Nothing in the core knows them.
//
// world.json: { people: [ { name, team, replies: [ { after, key, subject, text } ] } ], invitations: [ actions ],
//   subject, keySubject, responders: [ { on: { action, target, params? }, replies: [ { after, from, subject, text } ] } ] }
// people answer an invitation to their team (the actions named in invitations; none when it names none); a responder
// answers every message that matches its on (the params named there must be equal). after is in seconds of world
// time; {{name}} in subject and text is filled from the message (its target, or one of its params). A person's reply
// without a subject of its own has the world's keySubject when it carries the key, else the world's subject, else
// "Re: <action>".

app.define( 'World.Simulation', [ 'Lib.Hash' ], Hash => class Simulation {

	constructor( { world, outbox, deliver, speed = 1, pollMs = 500, log = null, mission = null } ) {
		Object.assign( this, { world, outbox, deliver, speed, pollMs, log, mission } );
		this._seen = new Set();
		this._timers = [];
		this._teams = [ ...new Set( ( world.people || [] ).map( person => person.team ) ) ];
		this._invitations = new Set( Array.isArray( world.invitations ) ? world.invitations.filter( item => typeof item === 'string' ) : [] );
		this._responders = ( Array.isArray( world.responders ) ? world.responders : [] )
			.filter( item => item?.on && Array.isArray( item.replies ) );
		this._targets = [ ...new Set( [ ...this._teams, ...this._responders.map( item => item.on.target ) ] ) ]
			.filter( item => typeof item === 'string' );
	}

	// What was already in the inboxes before the start has been answered before; people answer new mail only.
	start() {
		this._ready = this.look( { answer: false } ).catch( app.fail );
		this._poll = setInterval( () => this._ready.then( () => this.look() ).catch( app.fail ), this.pollMs );
		this._poll.unref?.();
		return this;
	}

	stop() {
		clearInterval( this._poll );
		this._timers.forEach( timer => clearTimeout( timer ) );
	}

	// Looks into the inboxes; every new invitation gets the scripted replies of its team's people, every new message the
	// replies of the responders it matches.
	async look( { answer = true } = {} ) {
		for ( const target of this._targets ) {
			for ( const message of await this.outbox( target ) ) {
				if ( this._seen.has( message.id ) ) { continue; }
				this._seen.add( message.id );
				if ( !answer ) { continue; }
				this.log?.append( 'world_received', { team: target, message: message.id, mission: this.mission }, { source: 'world' } );
				if ( this._invitations.has( message.action ) && this._teams.includes( target ) ) { this._answer( target, message ); }
				this._responders.filter( item => Simulation.matches( item.on, target, message ) )
					.forEach( item => item.replies.forEach( reply => this._later( reply, Simulation.fill( reply, target, message ) ) ) );
			}
		}
	}

	static matches( on, target, message ) {
		const _params = message.params && typeof message.params === 'object' ? message.params : {};
		const _same = ( [ name, value ] ) => Object.hasOwn( _params, name ) && _params[ name ] === value;
		return on.target === target && ( !on.action || on.action === message.action ) && Object.entries( on.params || {} ).every( _same );
	}

	// {{name}}: the message's target, or one of its params that is text or a number; anything else stays as it is.
	static fill( reply, target, message ) {
		const _values = { target, ...( message.params && typeof message.params === 'object' ? message.params : {} ) };
		const _text = template => String( template ?? '' ).replace( /\{\{(\w+)\}\}/g, ( all, name ) => (
			Object.hasOwn( _values, name ) && [ 'string', 'number' ].includes( typeof _values[ name ] ) ? String( _values[ name ] ) : all ) );
		return { from: reply.from || target, subject: _text( reply.subject || `Re: ${message.action}` ), text: _text( reply.text ) };
	}

	_later( reply, message ) {
		const _timer = setTimeout( () => {
			const _message = { id: Hash.id( 'in' ), to: this.mission, ...message };
			this.log?.append( 'world_replied', { from: _message.from, subject: _message.subject, mission: this.mission }, { source: 'world' } );
			Promise.resolve( this.deliver( _message ) ).catch( app.fail );
		}, ( ( Number( reply.after ) || 0 ) * 1000 ) / this.speed );
		_timer.unref?.();
		this._timers.push( _timer );
	}

	_answer( team, invitation ) {
		const _text = value => ( typeof value === 'string' && value ? value : null );
		for ( const person of this.world.people.filter( item => item.team === team ) ) {
			for ( const reply of person.replies ) {
				const _timer = setTimeout( () => {
					const _subject = _text( reply.subject ) || _text( reply.key ? this.world.keySubject : this.world.subject ) || `Re: ${invitation.action}`;
					const _filled = Simulation.fill( { ...reply, subject: _subject }, team, invitation );
					const _message = { id: Hash.id( 'in' ), from: person.name, to: this.mission, subject: _filled.subject, text: _filled.text };
					this.log?.append( 'world_replied', { from: person.name, subject: _message.subject, mission: this.mission }, { source: 'world' } );
					Promise.resolve( this.deliver( _message ) ).catch( app.fail );
				}, ( reply.after * 1000 ) / this.speed );
				_timer.unref?.();
				this._timers.push( _timer );
			}
		}
	}

} );
