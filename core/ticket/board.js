// Tickets (chapter 8.4): the only way the system asks a person, in the schema of 8.4: from which node, to whom, of
// which kind, the reason and only the excerpt needed, options and a recommendation, which node it blocks (only the
// one that asked), a deadline no later than its node's (R3), the answer and its receipt. The answer is a
// confirmation by a person, recorded with who gave it; it never arrives as text the model could be steered by, and
// only its receipt makes it count. Tickets reach people bundled; before one does, its minutes are counted against the
// daily capacity (P6). Nothing waits forever: an expired ticket resolves without a choice, and so does a ticket
// withdrawn by the abort cascade (16.5). Every answer becomes part of the node's history.

app.define( 'Core.Ticket.Board', [ 'Lib.Hash' ], Hash => class Board {

	static KINDS = [ 'question', 'escalation', 'help', 'suggestion', 'check' ];
	// Names the system gives itself; an answer by one of them, or by nobody, is no confirmation by a person (8.4).
	static RESERVED = [ 'system', 'deadline', 'agent' ];
	// R3 for a ticket whose node has no deadline either (a check of a model's answer): nothing waits forever.
	static DEFAULT_HOURS = 24;
	// 8.4: "only the context needed": an excerpt is cut to this many characters per text.
	static EXCERPT = 600;

	// 8.4: the excerpt of a message from outside a ticket shows: who sent it and its text, cut short, labelled foreign.
	static message( message ) {
		const _text = typeof message?.text === 'string' ? message.text : String( message?.text ?? '' );
		return { from: String( message?.from ?? '' ).slice( 0, 120 ), text: _text.slice( 0, Board.EXCERPT ), labels: [ 'foreign' ] };
	}

	// 8.4: the excerpt of a step's inputs a ticket shows: each named, as text cut short, with its labels. Confidential
	// values are not shown (the person sees that something was withheld, never what): a ticket is no way around a
	// group the goal allows, nor around the person a value is about.
	static inputs( names, values ) {
		return names.map( ( name, i ) => {
			const _labels = Array.isArray( values[ i ]?.labels ) ? values[ i ].labels : [];
			if ( _labels.includes( 'confidential' ) ) { return { name, labels: _labels, withheld: true }; }
			const _value = values[ i ]?.value;
			const _text = typeof _value === 'string' ? _value : JSON.stringify( _value ) ?? '';
			return { name, labels: _labels, text: _text.slice( 0, Board.EXCERPT ) };
		} );
	}

	constructor( log, { capacity = null, now = () => Date.now(), sweepMs = 1000 } = {} ) {
		Object.assign( this, { log, capacity, now } );
		this.open = new Map();
		this._listeners = [];
		this._sweep = setInterval( () => this.expire(), sweepMs );
		this._sweep.unref?.();
	}

	// Whoever keeps the history hears every answer (8.4: answers become history).
	listen( fn ) {
		this._listeners.push( fn );
	}

	// to: client (a person) or parent; kind: one of KINDS; reason and excerpt: why, and only the context needed. A
	// ticket nobody could answer (no options, a recommendation that is none of them, an unknown kind, minutes that are
	// no time) is refused before it is shown.
	ask( node, spec ) {
		const { question, recommendation = null, deadline = null, minutes = 2 } = spec;
		const { kind = 'question', to = 'client', reason = null, excerpt = null } = spec;
		// One option given as text is a list of that one option, never a text whose every part would be a choice.
		const options = typeof spec.options === 'string' ? [ spec.options ] : spec.options;
		const _problem = Board.problem( { options, recommendation, kind, minutes } );
		if ( _problem ) { throw new Error( `the ticket is refused: ${_problem} (8.4)` ); }
		const _id = Hash.id( 'tk' );
		const _deadline = this._deadline( deadline, node.contract?.deadline );
		// P6: a person's time is a capacity, whoever the person is; only a ticket to a parent node takes none. A ticket
		// longer than a whole day fits no day: it goes out marked instead of being moved.
		const _whole = minutes > ( this.capacity?.dailyMinutes ?? Infinity );
		const _capacity = this.capacity && to !== 'parent' ? this.capacity.take( minutes, _whole ? null : _deadline ) : { ok: true };
		return new Promise( ( resolve ) => {
			const _shown = {
				id: _id, from: node.id, to, kind, question, reason, excerpt, options: [ ...options ], recommendation, blocks: node.id,
				deadline: _deadline, minutes, status: 'open', answer: null, receipt: null, notBefore: _capacity.notBefore || null,
				overCapacity: Boolean( _capacity.marked ),
			};
			const _opened = new Date( this.now() ).toISOString();
			this.open.set( _id, { ..._shown, options: [ ...options ], node: node.id, opened: _opened, resolve } );
			node.emit( 'ticket_opened', _shown );
		} );
	}

	// R3: the earlier of the ticket's own deadline and its node's; without either a day from now. A deadline already
	// past counts from now, unless the node's own deadline is past too: never later than the node's.
	_deadline( given, ofNode ) {
		const _now = new Date( this.now() ).toISOString();
		const _deadline = Board.earliest( given, ofNode ) || new Date( this.now() + Board.DEFAULT_HOURS * 3600000 ).toISOString();
		const _floor = Board.earliest( _now, ofNode );
		return Date.parse( _deadline ) < Date.parse( _floor ) ? _floor : _deadline;
	}

	// Why a ticket cannot be asked, or null.
	static problem( { options, recommendation, kind, minutes } ) {
		if ( !Board.KINDS.includes( kind ) ) { return `${String( kind ).slice( 0, 40 )} is no kind of ticket`; }
		const _choice = item => ( typeof item === 'string' && item.trim() !== '' ) || Number.isFinite( item );
		if ( !Array.isArray( options ) || !options.length || !options.every( _choice ) ) { return 'the options are no list of choices'; }
		if ( recommendation !== null && !options.includes( recommendation ) ) { return 'the recommendation is none of the options'; }
		if ( !Number.isFinite( minutes ) || minutes < 0 ) { return 'the minutes are no time'; }
		return null;
	}

	// The answer of a person: one of the options, by someone named, before the deadline (R3). Only its receipt makes it
	// count (8.4).
	answer( id, { choice, by } = {} ) {
		const _ticket = this.open.get( id );
		if ( !_ticket ) {
			throw new Error( `no open ticket ${id}` );
		}
		if ( this._overdue( _ticket ) ) {
			this._close( _ticket, { choice: null, by: 'deadline', expired: true }, 'ticket_expired', { force: true } );
			throw new Error( `the ticket ${id} expired at ${_ticket.deadline}` );
		}
		if ( !_ticket.options.includes( choice ) ) {
			throw new Error( `${choice} is not one of the options` );
		}
		if ( !Board.person( by ) ) {
			throw new Error( 'an answer is a confirmation by a person, and names who gave it' );
		}
		// The receipt: from now on the answer counts (8.4).
		const _at = new Date( this.now() ).toISOString();
		return this._close( _ticket, { choice, by, at: _at, receipt: { id: Hash.id( 'rc' ), at: _at, by } }, 'ticket_answered' );
	}

	static person( by ) {
		return typeof by === 'string' && by.trim() !== '' && !Board.RESERVED.includes( by.trim().toLowerCase() );
	}

	// What a person sees: the open tickets bundled by whom they go to, each bundle with its minutes (8.4, P6).
	bundles() {
		const _by = new Map();
		for ( const ticket of this.list() ) {
			const _bundle = _by.get( ticket.to ) || { to: ticket.to, tickets: [], minutes: 0 };
			_bundle.tickets.push( ticket );
			_bundle.minutes += ticket.minutes || 0;
			_by.set( ticket.to, _bundle );
		}
		return [ ..._by.values() ];
	}

	// The abort cascade withdraws the open tickets of the nodes it stops.
	withdraw( nodeIds, { reason = 'aborted' } = {} ) {
		const _ids = new Set( nodeIds );
		return [ ...this.open.values() ].filter( ticket => _ids.has( ticket.node ) )
			.map( ticket => this._close( ticket, { choice: null, by: 'system', withdrawn: true, reason }, 'ticket_withdrawn', { force: true } ) );
	}

	// The sweep: one ticket that cannot be closed never stops the others, nor the timer.
	expire() {
		for ( const ticket of [ ...this.open.values() ] ) {
			if ( !this._overdue( ticket ) ) { continue; }
			try {
				this._close( ticket, { choice: null, by: 'deadline', expired: true }, 'ticket_expired', { force: true } );
			} catch ( error ) {
				app.fail( error );
			}
		}
	}

	// What a person sees now: tickets postponed by the daily capacity appear on their day, and a ticket past its
	// deadline is no longer there, even before the sweep closed it. Each is a copy: changing it changes no ticket.
	list() {
		const _shown = ticket => ( !ticket.notBefore || Date.parse( ticket.notBefore ) <= this.now() ) && !this._overdue( ticket );
		return [ ...this.open.values() ].filter( _shown )
			.map( ( { resolve: _r, ...ticket } ) => ( { ...ticket, options: [ ...ticket.options ] } ) );
	}

	_overdue( ticket ) {
		return Boolean( ticket.deadline ) && this.now() > Date.parse( ticket.deadline );
	}

	// The answer is recorded before it counts: an answer the log cannot take leaves the ticket open. What the system
	// closes itself (deadline, withdrawal) closes even then, so nobody waits forever. The asker hears first; a history
	// listener that fails never keeps it waiting.
	_close( ticket, answer, kind, { force = false } = {} ) {
		const _logged = { id: ticket.id, choice: answer.choice, by: answer.by, receipt: answer.receipt || null, kind: ticket.kind };
		try {
			this.log.append( kind, _logged, { node: ticket.node } );
		} catch ( error ) {
			if ( !force ) { throw error; }
			app.fail( error );
		}
		this.open.delete( ticket.id );
		ticket.resolve( answer );
		const _ticket = { id: ticket.id, node: ticket.node, kind: ticket.kind, question: ticket.question };
		for ( const fn of this._listeners ) {
			try {
				fn( { ticket: _ticket, answer } );
			} catch ( error ) {
				app.fail( error );
			}
		}
		return { id: ticket.id, ...answer };
	}

	static earliest( ...times ) {
		const _valid = times.filter( Boolean ).map( time => Date.parse( time ) ).filter( time => !Number.isNaN( time ) );
		return _valid.length ? new Date( Math.min( ..._valid ) ).toISOString() : null;
	}

} );
