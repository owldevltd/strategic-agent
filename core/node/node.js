// One node of the tree: a frozen contract, its state, the facts it gathered, the walls it hit and the strategies
// it tried. Children run the very same route (chapter 17). Memory never holds what the log does not (Z4): every
// change is made together with its event, and taken back when the event cannot be written.

app.define( 'Core.Node.Node', [ 'Core.Node.Machine', 'Lib.Hash', 'Core.Criteria.Criterion' ], ( Machine, Hash, Criterion ) => class Node {

	constructor( { contract, parent = null, log = null, id = null } ) {
		this.id = id || Hash.id( 'node' );
		this.contract = contract;
		this.parent = parent;
		this.depth = parent ? parent.depth + 1 : 0;
		this.state = 'draft';
		this.version = 0;
		this.facts = [];
		this.walls = [];
		this.tried = [];
		this.children = [];
		// Processes of their own that belong to this node (a new case, a proposal, 8.1, 6.1): the abort reaches them too.
		this.processes = [];
		this.spent = 0;
		this.result = null;
		// L4: the credit per criterion id. Without a prototype, so an id like "constructor" is an id like any other.
		this.credited = Object.create( null );
		this.log = log;
	}

	// E1: with expect, the transition is written only if nobody moved the node in between. The event carries both
	// states and the version after the move; the data of the move cannot rewrite them (Z4).
	move( to, data = {}, { expect = null } = {} ) {
		if ( expect !== null && expect !== this.version ) {
			throw new Error( `node ${this.id}: version ${this.version}, expected ${expect}; read again and judge again (E1)` );
		}
		if ( !Machine.allowed( this.state, to ) ) {
			throw new Error( `node ${this.id}: ${this.state} → ${String( to )} is not allowed` );
		}
		const [ _from, _version ] = [ this.state, this.version ];
		const _data = { ...( data && typeof data === 'object' ? data : {} ), from: _from, to };
		this._logged( 'state_changed', _data, () => {
			this.state = to;
			this.version = _version + 1;
		}, () => {
			this.state = _from;
			this.version = _version;
		} );
	}

	// E2: a fact with an id the node already has is dropped. The node stamps the arrival time itself (a time the fact
	// claims is kept apart as claimedTime, so nothing backdates itself before a deadline, B2, L4) and never takes a
	// superseded flag from the caller (E5). at: the time trusted code observed it, e.g. the system's own observation up
	// to a deadline (B5); never a field of the fact. A fact a criterion cannot read is refused before anything is written.
	addFact( fact, { at = null } = {} ) {
		if ( !fact || typeof fact !== 'object' || Array.isArray( fact ) ) { return null; }
		if ( fact.id && this.facts.some( item => item?.id === fact.id ) ) {
			return null;
		}
		// Facts changed by anyone but addFact (a restart, say) may meet a criterion already: then every one is read again.
		const _changed = !this._fresh();
		const _fact = this._stamped( fact, at );
		const _effects = this._contradicts( _fact );
		const _unreadable = this._unreadable( _fact );
		if ( _unreadable ) {
			this.emit( 'fact_rejected', { kind: _fact.kind ?? null, problems: [ `a criterion cannot read it: ${_unreadable.message}` ] } );
			return null;
		}
		this._record( _fact );
		this._effects( _fact, _effects );
		this._credit( _fact, { all: _changed || Boolean( _effects.resolved ) } );
		return _fact;
	}

	_stamped( fact, at ) {
		const _given = { ...fact };
		const [ _time, _earlier ] = [ _given.time, _given.claimedTime ];
		[ 'superseded', 'time', 'claimedTime' ].forEach( key => delete _given[ key ] );
		const _id = fact.id || Hash.id( 'fact' );
		const _trusted = typeof at === 'number' ? at : Criterion.time( at );
		const _at = Number.isFinite( _trusted ) && Math.abs( _trusted ) <= 8.64e15 ? _trusted : Date.now();
		// The origin of a fact includes the attempt it came from, so credit can go to that attempt (L4); an attempt the
		// fact names itself must be an attempt number (L4).
		const _named = _given.attempt !== undefined && _given.attempt !== null;
		const _attempt = _named ? ( Number.isSafeInteger( _given.attempt ) && _given.attempt > 0 ? _given.attempt : null )
			: ( this.plan?.open ? this.plan.attempt ?? null : null );
		// E5: a fact without an origin is an origin of its own; it never supersedes another fact.
		const _origin = typeof _given.origin === 'string' && _given.origin ? _given.origin : `unknown:${_id}`;
		const _fact = { labels: [], ..._given, id: _id, time: new Date( _at ).toISOString(), attempt: _attempt, origin: _origin };
		const _claimed = _time ?? _earlier;
		if ( _claimed !== undefined && _claimed !== _fact.time ) { _fact.claimedTime = _claimed; }
		return _fact;
	}

	// The fact and its event go together (Z4).
	_record( fact ) {
		this._logged( 'fact_delivered', fact, () => {
			const _index = this._index();
			this.facts.push( fact );
			Node._enter( _index, fact );
		}, () => {
			this.facts = this.facts.filter( item => item !== fact );
		} );
	}

	// Indexes over the facts by kind and by the thing they are about (E5), so a new fact is weighed against what concerns
	// it, never against every fact (adding stays cheap). They follow this.facts; when anything else changed that list
	// (a restart, a test), they are built again.
	_fresh() {
		return Boolean( this._indexed ) && this._indexed.list === this.facts && this._indexed.length === this.facts.length;
	}

	_index() {
		if ( this._fresh() ) { return this._indexed; }
		this._indexed = { list: this.facts, length: 0, byKind: new Map(), byThing: new Map(), seq: new WeakMap() };
		this.facts.forEach( fact => Node._enter( this._indexed, fact ) );
		return this._indexed;
	}

	static _enter( index, fact ) {
		index.length += 1;
		if ( !fact || typeof fact !== 'object' ) { return; }
		index.seq.set( fact, index.length );
		Node._put( index.byKind, fact.kind, fact );
		if ( Node._names( fact ) || fact.kind === 'conflict' ) { Node._put( index.byThing, Node._thing( fact ), fact ); }
	}

	static _put( map, key, fact ) {
		const _list = map.get( key );
		if ( _list ) { _list.push( fact ); } else { map.set( key, [ fact ] ); }
	}

	// The facts of these kinds in the order they arrived; null: all of them.
	_ofKinds( kinds ) {
		if ( !kinds ) { return this.facts; }
		const _index = this._index();
		const _lists = kinds.map( kind => _index.byKind.get( kind ) || [] ).filter( list => list.length );
		const _all = _lists.flat();
		return _lists.length > 1 ? _all.sort( ( a, b ) => _index.seq.get( a ) - _index.seq.get( b ) ) : _all;
	}

	// Would a criterion fail to read this fact? → the error, or null. A fact that cannot be read is refused before it is
	// written, so the node never holds a fact it cannot judge with; a criterion that fails without any fact at all is no
	// reason to refuse this one.
	_unreadable( fact ) {
		if ( !Node._counts( fact, Date.now() ) ) { return null; }
		const _read = ( facts ) => {
			try {
				this.contract.check( facts );
				return null;
			} catch ( error ) {
				return error;
			}
		};
		const _error = _read( [ fact ] );
		return _error && !_read( [] ) ? _error : null;
	}

	// L4: a criterion is credited to the attempt whose fact first met its evidence predicate, and only within the
	// criterion's own deadline. It measures the provable immediate contribution, not the causal whole; the contract's
	// success alone counts for no strategy. Evidence an open conflict is about is no proof yet (E5): the credit waits
	// until the conflict ends.
	// A criterion is read again only when the new fact can help meet it (all: every one, e.g. after a conflict ended).
	_credit( fact = null, { all = false } = {} ) {
		const _now = Date.now();
		let _contested = null;
		for ( const criterion of this.contract.outcomes().filter( item => !Object.hasOwn( this.credited, item.id ) ) ) {
			const _kinds = Node._kinds( criterion );
			if ( !all && !Node._concerns( criterion, fact, _kinds ) ) { continue; }
			const _facts = this._ofKinds( _kinds ).filter( item => Node._counts( item, _now ) );
			const _result = Node._verdict( criterion, _facts );
			if ( !_result?.met ) { continue; }
			const _ids = new Set( _result.evidence || [] );
			const _evidence = _facts.filter( item => _ids.has( item.id ) );
			_contested = _contested || new Set( this.conflicts().map( Node._thing ) );
			if ( _evidence.some( item => Node._about( item ) && _contested.has( Node._thing( item ) ) ) ) { continue; }
			const _by = _evidence.includes( fact ) ? fact : _evidence.at( -1 ) || fact;
			// A deadline that cannot be read is never met in time (fail closed).
			const _deadline = Criterion.time( criterion.deadline || this.contract.deadline );
			const _credit = {
				criterion: criterion.id, attempt: _by?.attempt ?? null, fact: _by?.id ?? null, inTime: Date.now() <= _deadline,
			};
			this._logged( 'credited', _credit, () => {
				this.credited[ criterion.id ] = _credit;
			}, () => {
				delete this.credited[ criterion.id ];
			} );
		}
	}

	// E5, planned before anything is written: two facts about the same thing that disagree. From the same origin the
	// younger one counts and the older is marked superseded; when the latest facts of the thing's origins disagree, one
	// conflict fact is recorded for the thing, and while it is open no criterion closes; when they agree again, the
	// conflict ends by itself.
	_contradicts( fact ) {
		const _plan = { supersede: [], conflict: null, resolved: null };
		if ( !Node._about( fact ) ) { return _plan; }
		const _thing = Node._thing( fact );
		const _about = this._index().byThing.get( _thing ) || [];
		const _same = item => item !== fact && !item.superseded && item.kind === fact.kind && Node._about( item );
		const _older = item => _same( item ) && item.origin === fact.origin && Node._value( item ) !== Node._value( fact );
		_plan.supersede = _about.filter( _older );
		const _facts = [ ..._about.filter( item => !_plan.supersede.includes( item ) ), fact ];
		const _disagree = Node._disagreement( _facts, _thing );
		const _open = Node._open( _about );
		if ( _disagree && !_open ) {
			_plan.conflict = { about: fact.data.about, of: _disagree.kind, facts: _disagree.facts.map( item => item.id ) };
		} else if ( !_disagree && _open ) {
			const _agree = _facts.filter( item => item.kind === _open.data.of && !item.superseded && Node._about( item )
				&& Node._thing( item ) === _thing );
			_plan.resolved = { about: fact.data.about, of: _open.data.of, by: 'agreement', conflict: _open.id, facts: _agree.map( item => item.id ) };
		}
		return _plan;
	}

	_effects( fact, { supersede, conflict, resolved } ) {
		for ( const earlier of supersede ) {
			this._supersede( earlier, fact.id );
		}
		if ( conflict ) {
			this._record( Node._system( 'conflict', conflict ) );
			this.emit( 'conflict', conflict );
		}
		if ( resolved ) {
			this._record( Node._system( 'conflict_resolved', resolved ) );
		}
	}

	_supersede( fact, by ) {
		this._logged( 'fact_superseded', { id: fact.id, by }, () => {
			fact.superseded = true;
		}, () => {
			delete fact.superseded;
		} );
	}

	// E5, U4: a person decides an open conflict. Facts about the thing whose value differs from the decided one count for
	// nothing any more; the decision is a fact of its own. → the decision, or null when nothing about it is open.
	resolveConflict( about, value, by ) {
		const _thing = Hash.canonical( about ) ?? '';
		const _about = this._index().byThing.get( _thing ) || [];
		const _open = Node._open( _about );
		if ( !_open ) { return null; }
		const _decided = Hash.canonical( value );
		const _data = { about, of: _open.data.of, value, by, conflict: _open.id };
		const _resolution = { ...Node._system( 'conflict_resolved', _data ), evidenceClass: 'confirmation', source: `person ${by}`, origin: `person:${by}` };
		this._record( _resolution );
		const _other = item => !item.superseded && item.kind === _open.data.of && Node._about( item ) && Node._value( item ) !== _decided;
		_about.filter( _other ).forEach( item => this._supersede( item, _resolution.id ) );
		this._credit( null, { all: true } );
		return _resolution;
	}

	// B2: superseded facts and facts past their validity count for nothing; a validity that cannot be read counts for
	// nothing either, it never makes a fact eternal. No validity at all is no limit.
	valid( now = Date.now() ) {
		return this.facts.filter( fact => Node._counts( fact, now ) );
	}

	// R7: a precondition a child met stays met while its evidence is valid; when the evidence expires it is open again.
	// R8: a precondition without an id is never met.
	preconditionMet( id ) {
		if ( id === undefined || id === null ) { return false; }
		return this.valid().some( fact => fact.kind === 'precondition_met' && fact.data && typeof fact.data === 'object' && fact.data.id === id );
	}

	// The conflict still open in the facts about one thing (in the order they arrived), or null.
	static _open( facts ) {
		let _open = null;
		for ( const fact of facts ) {
			if ( fact.kind === 'conflict' ) { _open = fact; }
			if ( fact.kind === 'conflict_resolved' && Node._names( fact ) ) { _open = null; }
		}
		return _open;
	}

	// The conflicts still open, one per thing: a conflict ends with a conflict_resolved about the same thing after it.
	conflicts() {
		const _open = new Map();
		for ( const fact of this.facts ) {
			if ( fact?.kind === 'conflict' ) {
				_open.set( Node._thing( fact ), fact );
			} else if ( fact?.kind === 'conflict_resolved' && Node._names( fact ) ) {
				_open.delete( Node._thing( fact ) );
			}
		}
		return [ ..._open.values() ];
	}

	// The wall report has a fixed schema (16.4): which criterion, which cause code, an optional precondition with an
	// id, a reason and a suggestion. Walls are compared by codes and ids, never by wording.
	hitWall( cause, detail = [], { precondition = null, suggestion = null, reason = null, decided = null } = {} ) {
		const _wall = {
			criterion: this.openOutcomes()[ 0 ]?.id || null,
			cause,
			precondition,
			reason: reason || Node.reason( detail ),
			suggestion,
			detail,
			// 5.6: the class a person chose for this wall.
			...( typeof decided === 'string' && decided ? { decided } : {} ),
			at: new Date().toISOString(),
		};
		this._logged( 'wall', _wall, () => this.walls.push( _wall ), () => {
			this.walls = this.walls.filter( item => item !== _wall );
		} );
		return _wall;
	}

	static reason( detail ) {
		const _first = Array.isArray( detail ) ? detail[ 0 ] : detail;
		return typeof _first === 'string' ? _first : _first?.reason || _first?.error || '';
	}

	openOutcomes() {
		return this.contract.outcomes().filter( item => !item.verdict( this.valid() ).met );
	}

	ancestors() {
		const _list = [];
		for ( let node = this.parent; node; node = node.parent ) {
			_list.unshift( node.contract );
		}
		return _list;
	}

	emit( kind, data ) {
		this.log?.append( kind, data, { node: this.id, nodeVersion: this.version } );
	}

	// Z4: the change is made, its event written (it carries the state after the change), and the change taken back
	// when the event cannot be written, so a restart finds exactly what this node held.
	_logged( kind, data, apply, undo ) {
		apply();
		try {
			this.emit( kind, data );
		} catch ( error ) {
			undo();
			throw error;
		}
	}

	// The plan left something open (16.1 executing → waiting): only this node waits for it.
	toWaiting( data, waitingOn = null ) {
		if ( this.state !== 'executing' ) { return false; }
		this.move( 'waiting', data );
		this.waitingOn = waitingOn;
		return true;
	}

	// An event for a waiting node wakes it for a judgment (E4); whoever waits for the next event gets it.
	nextEvent() {
		return new Promise( ( resolve ) => {
			this._wake = resolve;
		} );
	}

	wake( event ) {
		const _wake = this._wake;
		this._wake = null;
		_wake?.( event );
	}

	// 4.4: what holds this node back, so the chain up to the root is visible.
	blockedBy() {
		return {
			children: this.children.filter( child => child.state !== 'closed' ).map( child => child.id ),
			waitingOn: this.state === 'waiting' ? this.waitingOn?.move || this.waitingOn?.why || 'an event' : null,
		};
	}

	describe() {
		return {
			id: this.id, parent: this.parent?.id || null, depth: this.depth, state: this.state, version: this.version,
			contract: this.contract.describe(), facts: this.facts.length, walls: this.walls, tried: this.tried,
			children: this.children.map( child => child.id ), result: this.result, blockedBy: this.blockedBy(),
		};
	}

	static _counts( fact, now ) {
		if ( !fact || typeof fact !== 'object' || fact.superseded ) { return false; }
		const _until = fact.validUntil;
		return _until === undefined || _until === null || _until === '' || Criterion.time( _until ) >= now;
	}

	// The kinds of fact a criterion takes as evidence (a person's confirmation too, K4); null when its type names none.
	static _kinds( criterion ) {
		const _list = criterion.constructor?.EVIDENCE;
		if ( !Array.isArray( _list ) || !_list.length ) { return null; }
		return criterion.byPerson ? [ ..._list, 'confirmation' ] : _list;
	}

	// Can this fact help meet the criterion? It must be of a kind the criterion reads; where the criterion reads one kind
	// only, a fact that is no evidence even on its own cannot become any in company. So a fact that concerns no criterion
	// costs nothing, and only what concerns one makes it read its facts again.
	static _concerns( criterion, fact, kinds ) {
		if ( !kinds ) { return true; }
		if ( !kinds.includes( fact?.kind ) ) { return false; }
		if ( criterion.constructor.EVIDENCE.length > 1 || fact.kind === 'confirmation' ) { return true; }
		const _alone = Node._verdict( criterion, [ fact ] );
		return Boolean( _alone?.met ) || ( _alone?.evidence || [] ).includes( fact.id );
	}

	// A criterion that cannot read the facts is not met (fail closed).
	static _verdict( criterion, facts ) {
		try {
			return criterion.verdict( facts );
		} catch {
			return null;
		}
	}

	// E5: a fact about a thing names it (data.about) and has a value; things and values compare by their canonical form,
	// so { amount, currency } equals { currency, amount }.
	static _about( fact ) {
		return Boolean( fact?.data ) && typeof fact.data === 'object' && fact.data.about !== undefined && 'value' in fact.data;
	}

	static _names( fact ) {
		return Boolean( fact?.data ) && typeof fact.data === 'object' && 'about' in fact.data;
	}

	static _thing( fact ) {
		return Node._names( fact ) ? Hash.canonical( fact.data.about ) ?? '' : '';
	}

	static _value( fact ) {
		return Hash.canonical( fact.data.value ) ?? '';
	}

	// The latest fact of each origin per kind about the thing; → the first kind whose origins disagree, or null.
	static _disagreement( facts, thing ) {
		const _kinds = new Map();
		const _about = entry => entry && !entry.superseded && Node._about( entry ) && Node._thing( entry ) === thing;
		for ( const item of facts.filter( _about ) ) {
			const _latest = _kinds.get( item.kind ) || new Map();
			_latest.set( item.origin, item );
			_kinds.set( item.kind, _latest );
		}
		for ( const [ kind, latest ] of _kinds ) {
			const _facts = [ ...latest.values() ];
			if ( new Set( _facts.map( Node._value ) ).size > 1 ) { return { kind, facts: _facts }; }
		}
		return null;
	}

	// A fact the node records about itself.
	static _system( kind, data ) {
		return { kind, evidenceClass: 'observation', source: 'system', origin: 'system', data, id: Hash.id( 'fact' ), time: new Date().toISOString(), labels: [] };
	}

} );
