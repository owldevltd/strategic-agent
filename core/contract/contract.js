// The frozen goal of a node: what must be true in the world (outcome criteria) and what must hold all the time
// (invariants), with deadline, budget and value. Its hash binds the rules the gate stores on confirmation.

app.define( 'Core.Contract.Contract', [ 'Lib.Hash' ], Hash => class Contract {

	constructor( spec, registry ) {
		this.spec = spec;
		this.id = spec.id;
		this.goal = spec.goal;
		this.deadline = spec.deadline;
		this.budget = spec.budget ?? 0;
		this.value = spec.value ?? 0;
		this.serves = spec.serves || null;
		this.parent = spec.parent || null;
		this.understood = spec.understood || null;
		// Soft criteria are free text (3.1, "weich"); they are part of what the person confirms, but never of the hard core.
		const _list = value => ( Array.isArray( value ) ? value : [] );
		const _soft = _list( spec.soft ).map( ( text, i ) => ( { id: `s${i + 1}`, type: 'soft', values: { text }, origin: 'client' } ) );
		// What is no criterion (null, a number, a text) is reported as unknown; G1 refuses the goal, nothing throws here.
		const _specs = [ ..._list( spec.criteria ), ..._soft ];
		const _usable = item => item && typeof item === 'object' && registry.has( item.type );
		this.unknown = _specs.filter( item => !_usable( item ) ).map( item => ( item && typeof item === 'object' ? item.type : item ) );
		if ( spec.criteria !== undefined && !Array.isArray( spec.criteria ) ) { this.unknown.push( 'criteria is no list' ); }
		this.criteria = _specs.filter( _usable ).map( item => registry.create( item ) ).filter( Boolean );
	}

	get hash() {
		return Hash.sha256( this.canonical() );
	}

	// What the person confirms: the goal, the criteria, and how the system understood the task (back-translation and
	// the list of what is not covered, chapter 3.2). All of it is bound by the hash.
	canonical() {
		const { id, goal, deadline, budget, value, serves, parent, criteria, understood, soft, kind, scope, amends } = this.spec;
		return { id, goal, deadline, budget, value, serves, parent, criteria, understood, soft, kind, scope, amends };
	}

	// 3.2: after confirmation only the client changes the contract, by ticket. A change names one criterion and its new
	// values, or a new deadline; the result is a new contract that points at the one it amends, and G1 checks it again.
	// A change that names a criterion this contract does not have is refused: the person would confirm a change that
	// changes nothing they asked for.
	amend( change ) {
		const _list = Array.isArray( this.spec.criteria ) ? this.spec.criteria : [];
		const _named = change?.criterion ?? null;
		if ( _named !== null && !_list.some( item => item?.id === _named ) ) {
			throw new RangeError( `the amendment names ${typeof _named === 'string' ? _named.slice( 0, 40 ) : typeof _named}, which is no criterion of this contract` );
		}
		const _changed = item => ( _named !== null && item?.id === _named
			? { ...item, values: { ...item.values, ...change.values } } : item );
		return { ...this.spec, criteria: _list.map( _changed ), deadline: change?.deadline || this.spec.deadline, amends: this.hash };
	}

	// G-10: what may never change once confirmed.
	immutables() {
		const _entry = item => [ item.id ?? null, item.type ?? null, item.values ?? {} ];
		return this.criteria.filter( item => item.immutable ).map( item => Hash.canonical( _entry( item ) ) ).sort();
	}

	outcomes() {
		return this.criteria.filter( item => item.kind === 'outcome' );
	}

	invariants() {
		return this.criteria.filter( item => item.kind === 'invariant' );
	}

	// A child's goal: its own criteria plus every invariant of the parent goal, inherited by construction (checked at
	// G1); it ends before the parent (before), keeps the parent's kind and scope unless it names its own, and is worth
	// half of the parent unless it says what. parent: the parent's contract.
	static child( parent, spec, bufferMinutes = 5 ) {
		const { id, goal, criteria, serves, budget, value = null, kind = parent.spec.kind, scope = parent.spec.scope } = spec;
		return {
			id: `${parent.id}/${id}`, goal, deadline: Contract.before( parent.deadline, bufferMinutes ), budget,
			value: value ?? Math.max( 1, parent.value / 2 ), kind, scope, parent: parent.hash, serves,
			criteria: [ ...criteria, ...parent.invariants().map( Contract.inherited ) ],
		};
	}

	// A child ends twice the buffer, at least ten minutes, before its parent: its outcome can still reach the parent.
	static before( deadline, bufferMinutes = 5 ) {
		return new Date( Date.parse( deadline ) - Math.max( 10, bufferMinutes * 2 ) * 60000 ).toISOString();
	}

	// An invariant as a child inherits it: its spec without the kind, which the type decides anyway.
	static inherited( criterion ) {
		return ( ( { kind: _kind, ...rest } ) => rest )( criterion.describe() );
	}

	softs() {
		return this.criteria.filter( item => item.kind === 'soft' );
	}

	// The rules that follow from the goal. The deadline always yields an expiry rule, so nothing new leaves the
	// gate after the end even when the goal names no deadline criterion.
	rules() {
		const _tag = item => rule => ( { ...rule, criterion: item.id } );
		const _gate = this.criteria.flatMap( item => item.gateRules().map( _tag( item ) ) );
		if ( !_gate.some( rule => rule.rule === 'expires' ) ) {
			_gate.push( { rule: 'expires', actions: [ '*' ], at: this.deadline, criterion: 'contract' } );
		}
		return {
			flow: this.criteria.flatMap( item => item.flowRules().map( _tag( item ) ) ),
			gate: _gate,
			allow: this.criteria.flatMap( item => item.allows().map( _tag( item ) ) ),
		};
	}

	// The hard core only; soft criteria are assessed separately and never decide (14).
	check( facts, now = Date.now() ) {
		return this.criteria.filter( item => item.kind !== 'soft' ).map( item => ( { id: item.id, type: item.type, kind: item.kind, ...item.verdict( facts, now ) } ) );
	}

	describe() {
		return { ...this.canonical(), hash: this.hash, criteria: this.criteria.map( item => item.describe() ) };
	}

} );
