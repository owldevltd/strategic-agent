// New cases (8.1): a message that matches nothing that waits starts its own process on the same route. The
// extraction reads it into concerns in a fixed schema (22: the message and the schema, nothing else); a message with
// several concerns makes several cases. Each case is a goal built by code: a reply to the sender has arrived, under
// every rule of the confirmed goal of the mission (its invariants), so the gate confirms it by derivation. The
// strategies for cases are ordinary catalog entries of their own kind, chosen, checked and judged like any other.
// Starting a case burns a start token (R1).

app.define( 'Core.Inbound.Cases', [ 'Core.Contract.Contract', 'Core.Ticket.Board' ], ( Contract, Board ) => class Cases {

	static TEXT = 2000;

	constructor( runner ) {
		this.runner = runner;
	}

	// wait: false answers as soon as the cases are started; they run on (a case may wait for a person's approval).
	async start( message, { wait = true } = {} ) {
		const r = this.runner;
		const _root = r.root;
		// 16.5: while the goal is being aborted nothing new starts under it; the message is recorded only.
		if ( _root?.stopping && _root.state !== 'closed' ) {
			_root.emit( 'case_not_started', { message: message.id, reason: 'the goal is being aborted' } );
			return [];
		}
		const _cases = [];
		const _read = await this.read( message );
		for ( const [ i, concern ] of ( _read.length ? _read : this._unread( message ) ).entries() ) {
			const _budget = r.mission?.defaults?.caseBudget;
			const _spec = Cases.spec( _root, message, concern, { index: i, bufferMinutes: r.bufferMinutes, budget: _budget } );
			const _case = await r.start( new Contract( _spec, r.registry ), null, { owner: _root } );
			// The case may hand the message to a writer as an input labelled foreign; no waiting process sees it (G-8).
			_case.seed = { message: { value: message.text, labels: [ 'foreign' ], cohort: null } };
			const _event = { message: message.id, from: message.from, concern, labels: [ 'foreign' ], evidenceClass: 'claim' };
			if ( !r.burn( () => _case.emit( 'inbound_case', _event ) ) ) {
				r.refuse( _case, { status: 'refused', reason: 'no start tokens left (R1)' } );
				continue;
			}
			_cases.push( _case );
		}
		_root.emit( 'cases_started', { message: message.id, cases: _cases.map( item => item.id ) } );
		const _running = Promise.all( _cases.map( item => r.run( item ) ) );
		if ( wait ) { await _running; } else { _running.catch( app.fail ); }
		return _cases;
	}

	// The extraction: what does not fit the schema of a concern is dropped. It reads the message cut to 2000
	// characters, like the intake.
	async read( message ) {
		const r = this.runner;
		const _move = r.catalog.get( 'request.read' );
		// A mission without a reader of requests reads nothing from a message; it is "unread" (a person is told).
		if ( !_move ) {
			r.root.emit( 'concerns_read', { message: message.id, concerns: 0, dropped: 0, reader: false } );
			return [];
		}
		const _text = typeof message.text === 'string' ? message.text.slice( 0, Cases.TEXT ) : String( message.text ?? '' ).slice( 0, Cases.TEXT );
		const _ctx = { node: r.root, mission: r.mission, values: { message: { value: _text, labels: [ 'foreign' ], cohort: null } } };
		const _step = { move: 'request.read', from: [ 'message' ], as: 'reading' };
		const _work = lease => r.executor.run( _step, { ..._ctx, lease } );
		const _holder = { holder: `${r.root.id}:in:${message.id}` };
		const _out = await ( r.supervisor ? r.supervisor.hold( r.root, _step, _move, _work, _holder ) : _work( null ) );
		const _schema = _move.concern || {};
		const _fits = concern => Object.entries( _schema ).every( ( [ name, field ] ) => ( concern[ name ] === undefined
			? field.required === false : Cases.fits( concern[ name ], field ) ) );
		const _given = ( _out.value?.concerns || [] ).filter( item => item && typeof item === 'object' );
		const _concerns = _given.filter( _fits );
		r.root.emit( 'concerns_read', { message: message.id, concerns: _concerns.length, dropped: _given.length - _concerns.length } );
		const _known = item => Object.keys( _schema ).filter( name => item[ name ] !== undefined );
		return Cases.merge( _concerns.map( item => Object.fromEntries( _known( item ).map( name => [ name, item[ name ] ] ) ) ) );
	}

	// A value of a concern in the type its schema field names: one of the values, a list of texts, or a text.
	static fits( value, field ) {
		if ( field.type === 'enum' ) { return ( field.values || [] ).includes( value ); }
		if ( field.type === 'list' ) { return Array.isArray( value ) && value.every( item => typeof item === 'string' ); }
		if ( field.type === 'string' ) { return typeof value === 'string'; }
		return false;
	}

	// 8.1, 6.4: a message nothing could be read from does not vanish. It becomes a case on "something else", whose
	// strategies answer the sender, when the schema knows that intent; otherwise a person is told.
	_unread( message ) {
		const r = this.runner;
		const _other = Cases.other( r.catalog.get( 'request.read' )?.concern || {} );
		r.root.emit( 'concerns_unread', { message: message.id, fallback: _other ? 'other' : 'person' } );
		if ( _other ) { return [ _other ]; }
		// 8.4: a gap comes with its reason and only the context needed: the message itself, cut short, so the person sees
		// what it asks (a supplier who wants prepayment to a new account, say) without looking it up.
		r.executor?.board?.ask( r.root, {
			question: `Nothing could be read from the message ${String( message.id ).slice( 0, 80 )}; no case answers its sender.`,
			options: [ 'noted' ], recommendation: 'noted', minutes: 2, kind: 'help', reason: 'no concern could be read (8.1)',
			excerpt: Board.message( message ),
		} ).catch( app.fail );
		return [];
	}

	// The concern "something else": intent other, and an empty list for every other list the schema needs.
	static other( schema ) {
		if ( schema.intent?.type !== 'enum' || !schema.intent.values?.includes( 'other' ) ) { return null; }
		const _concern = { intent: 'other' };
		for ( const [ name, field ] of Object.entries( schema ) ) {
			if ( name === 'intent' || field.required === false ) { continue; }
			if ( field.type !== 'list' ) { return null; }
			_concern[ name ] = [];
		}
		return _concern;
	}

	// Two concerns of the same kind are one concern: their lists are joined, the first value of a field counts. A single
	// value where the other concern has a list is one item of it, never spread into its characters.
	static merge( concerns ) {
		const _by = new Map();
		const _list = value => ( Array.isArray( value ) ? value : value === undefined || value === null ? [] : [ value ] );
		for ( const concern of concerns ) {
			const _have = _by.get( concern.intent );
			if ( !_have ) {
				_by.set( concern.intent, { ...concern } );
				continue;
			}
			for ( const [ name, value ] of Object.entries( concern ) ) {
				const _lists = Array.isArray( value ) || Array.isArray( _have[ name ] );
				_have[ name ] = _lists ? [ ...new Set( [ ..._list( _have[ name ] ), ..._list( value ) ] ) ] : ( _have[ name ] ?? value );
			}
		}
		return [ ..._by.values() ];
	}

	// R1: the start budget of this kind of task; a mission may set its own for cases (defaults.caseBudget), up to MAX.
	static BUDGET = 6;
	static MAX_BUDGET = 60;
	static budget( given ) {
		return Number.isFinite( given ) && given > 0 ? Math.min( given, Cases.MAX_BUDGET ) : Cases.BUDGET;
	}

	static spec( root, message, concern, { index, bufferMinutes, budget = undefined } ) {
		const _budget = Cases.budget( budget );
		return {
			id: `${root.contract.id}/in-${message.id}${index ? `-${index + 1}` : ''}`,
			goal: `Answer ${message.from} on ${String( concern.intent ).replace( /_/g, ' ' )}`,
			deadline: Contract.before( root.contract.deadline, bufferMinutes ), budget: _budget, value: _budget, kind: 'request', parent: root.contract.hash,
			// The concern comes first: a field of it named message or from never replaces what the case records.
			scope: { ...concern, message: message.id, from: message.from },
			criteria: [
				{ id: 'k1', type: 'report_delivered', values: { to: message.from, topic: String( concern.intent ), action: 'reply' }, origin: 'client' },
				...root.contract.invariants().map( Contract.inherited ),
			],
		};
	}

} );
