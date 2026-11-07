// The agent proposes, the operator decides at the gate: what the gate checks against and a task without a mission may
// lack (6.1, with the gate as the place of trust, A6). Two kinds, and only when the deployment switches them on
// (AGENCY_PROPOSALS=1): an action the action table lacks, and a master-data value for the goals of one kind of task.
// A proposal changes nothing until a person with the operator pin approved exactly it; it is logged, and taken back
// the same way. The hard rules are checked here, by the gate's own code, never by the core:
//   an action: a new name, at least outward, money only as money_or_law, a text that says what it does (Lib.Actions);
//   a master-data value: never an account (nor a kind an account rule of the goal checks against), never one the core
//   labels foreign or not at all, never for a case that came from outside, and only a value the goal itself names,
//   whose root a person confirmed at this gate. So a value from a supplier's mail can never be laundered into the
//   master data through a proposal; the person is asked to check it through a channel they trust and enter it.

app.define( 'Gate.Proposals', [ 'Lib.Hash', 'Lib.Actions', 'Gate.Rules' ], ( Hash, Actions, Rules ) => class Proposals {

	static KINDS = [ 'action', 'master' ];
	static MONEY_KINDS = [ 'account' ];
	static MAX_VALUE = 200;

	constructor( egress, { on = false } = {} ) {
		Object.assign( this, { egress, on: on === true } );
		egress.db.exec( `CREATE TABLE IF NOT EXISTS gate_proposals (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, scope TEXT NOT NULL, contract TEXT NOT NULL,
			node TEXT, status TEXT NOT NULL, proposedAt TEXT NOT NULL, decidedAt TEXT, decidedBy TEXT, reason TEXT
		)` );
	}

	get db() { return this.egress.db; }

	get store() { return this.egress.store; }

	// { contract, node, kind: 'action', body: { name, entry } } or { contract, node, kind: 'master', body: { kind, value },
	// labels }. → the proposal as booked; the same open proposal again is the one already booked.
	submit( request ) {
		if ( !this.on ) { throw Rules.refusal( 'proposals are off at this gate (AGENCY_PROPOSALS)', 404 ); }
		const { contract, node = null, kind, body, labels } = Rules.object( request ) ? request : {};
		const _contract = this.store.contract( contract );
		if ( !_contract ) { throw Rules.refusal( 'a proposal names a goal the gate knows', 404 ); }
		if ( _contract.status !== 'confirmed' ) { throw Rules.refusal( 'a proposal comes from a confirmed goal', 409 ); }
		const _root = this.store.contract( _contract.root ) || _contract;
		const _scope = _root.spec?.kind;
		if ( typeof _scope !== 'string' || !_scope ) { throw Rules.refusal( 'a goal without a kind of task proposes nothing' ); }
		if ( !Proposals.KINDS.includes( kind ) || !Rules.object( body ) ) { throw Rules.refusal( `a proposal is of kind ${Proposals.KINDS.join( ' or ' )}, with a body` ); }
		const _problems = kind === 'action' ? this._action( body ) : this._master( body, labels, { contract: _contract, root: _root, scope: _scope } );
		if ( _problems.length ) { throw Rules.refusal( _problems.join( '; ' ) ); }
		const _name = kind === 'action' ? body.name : `${body.kind}:${body.value}`;
		const _body = kind === 'action' ? { name: body.name, entry: body.entry } : { kind: body.kind, value: body.value };
		const _open = this.db.get( 'SELECT id FROM gate_proposals WHERE kind = :kind AND name = :name AND scope = :scope AND status = \'proposed\'',
			{ kind, name: _name, scope: _scope } );
		if ( _open ) { return this.get( _open.id ); }
		const _id = Hash.id( 'gp' );
		this.db.run( `INSERT INTO gate_proposals ( id, kind, name, body, scope, contract, node, status, proposedAt )
			VALUES ( :id, :kind, :name, :body, :scope, :contract, :node, 'proposed', :at )`, {
			id: _id, kind, name: _name, body: JSON.stringify( _body ), scope: _scope, contract: _contract.hash,
			node: typeof node === 'string' ? node.slice( 0, 200 ) : null, at: this.egress._iso(),
		} );
		this.egress.log.append( 'proposal_received', { proposal: _id, kind, name: _name, scope: _scope } );
		return this.get( _id );
	}

	_action( body ) {
		return Actions.proposable( body.name, body.entry, this.egress.rules.actions );
	}

	// The hard rules of a master-data value (see the head of this file).
	_master( body, labels, { contract, root, scope } ) {
		const { kind, value } = body;
		if ( typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test( kind ) ) { return [ 'the kind of master data is a plain name' ]; }
		if ( typeof value !== 'string' || !value.trim() || value.length > Proposals.MAX_VALUE ) {
			return [ `the value is a text of at most ${Proposals.MAX_VALUE} characters` ];
		}
		const _rules = this.store.lineage( contract.hash ).flatMap( hash => this.store.contract( hash )?.rules?.gate || [] );
		const _accounts = [ ...Proposals.MONEY_KINDS, ..._rules.filter( rule => rule?.rule === 'known_account' ).map( rule => rule.kind || 'account' ) ];
		if ( _accounts.includes( kind ) ) { return [ `${kind} decides where money goes: only the operator enters it, after checking it` ]; }
		const _labels = Array.isArray( labels ) ? labels : [];
		if ( !_labels.includes( 'own' ) || _labels.includes( 'foreign' ) ) {
			return [ 'a value from outside, or of unknown origin, is never proposed: a person checks it through a channel they trust and enters it' ];
		}
		if ( contract.spec?.kind === 'request' || root.spec?.kind === 'request' ) { return [ 'a case that came from outside proposes no master data' ]; }
		if ( !Proposals.named( root.spec, value ) ) { return [ 'only a value the confirmed goal itself names may be proposed' ]; }
		if ( this.store.isMaster( kind, value, scope ) ) { return [ `${kind} ${value.slice( 0, 60 )} is on file already` ]; }
		return [];
	}

	// Does the goal a person confirmed name the value: as one of its criteria's values, or, for a contact pair
	// "<ref> <address>", both of its parts?
	static named( spec, value ) {
		const _texts = new Set();
		const _walk = ( item, depth = 0 ) => {
			if ( depth > 8 ) { return; }
			if ( typeof item === 'string' ) { _texts.add( item.trim() ); }
			if ( item && typeof item === 'object' ) { Object.values( item ).forEach( inner => _walk( inner, depth + 1 ) ); }
		};
		_walk( ( spec?.criteria || [] ).map( item => item?.values ) );
		return value.split( /\s+/ ).filter( Boolean ).every( part => _texts.has( part ) );
	}

	get( id ) {
		const _row = typeof id === 'string' ? this.db.get( 'SELECT * FROM gate_proposals WHERE id = :id', { id } ) : null;
		return _row ? { ..._row, body: JSON.parse( _row.body ) } : null;
	}

	// The proposals of one status ('proposed': they wait for the operator), of one kind of task when a scope is named.
	list( status = 'proposed', scope = null ) {
		const _scoped = typeof scope === 'string' && scope !== '';
		const _rows = this.db.all( `SELECT id FROM gate_proposals WHERE status = :status${_scoped ? ' AND scope = :scope' : ''} ORDER BY proposedAt`,
			{ status: String( status ), ...( _scoped ? { scope } : {} ) } );
		return _rows.map( row => this.get( row.id ) );
	}

	// A person decides: approve takes effect at once (the action into the table, the value into the master data of the
	// kind), reject changes nothing. Only an open proposal, only once.
	decide( id, decision, by = 'operator', reason = '' ) {
		const _proposal = this.get( id );
		if ( !_proposal ) { throw Rules.refusal( 'no such proposal', 404 ); }
		if ( ![ 'approve', 'reject' ].includes( decision ) ) { throw Rules.refusal( 'a proposal is approved or rejected' ); }
		if ( _proposal.status !== 'proposed' ) { throw Rules.refusal( `only an open proposal is decided; this one is ${_proposal.status}`, 409 ); }
		// What was approved must still hold when it is approved: the table or the master data may have grown since.
		const _still = _proposal.kind === 'action' ? this._action( _proposal.body ) : [];
		if ( _still.length ) { throw Rules.refusal( _still.join( '; ' ), 409 ); }
		const _status = decision === 'approve' ? 'approved' : 'rejected';
		this.db.transaction( () => {
			this.db.run( `UPDATE gate_proposals SET status = :status, decidedAt = :at, decidedBy = :by, reason = :reason
				WHERE id = :id AND status = 'proposed'`, { id, status: _status, at: this.egress._iso(), by: Proposals.text( by, 100 ) || 'operator',
				reason: Proposals.text( reason, 500 ) } );
			if ( _status === 'approved' ) { this._apply( _proposal ); }
		} );
		this.egress.log.append( `proposal_${_status}`, { proposal: id, kind: _proposal.kind, name: _proposal.name, scope: _proposal.scope, by } );
		return this.get( id );
	}

	// A person takes an approved proposal back: the action leaves the table (a request for it is then refused as unknown),
	// the value leaves the master data of the kind.
	revoke( id, by = 'operator', reason = '' ) {
		const _proposal = this.get( id );
		if ( !_proposal ) { throw Rules.refusal( 'no such proposal', 404 ); }
		if ( _proposal.status !== 'approved' ) { throw Rules.refusal( `only an approved proposal is revoked; this one is ${_proposal.status}`, 409 ); }
		this.db.transaction( () => {
			this.db.run( `UPDATE gate_proposals SET status = 'revoked', decidedAt = :at, decidedBy = :by, reason = :reason WHERE id = :id`,
				{ id, at: this.egress._iso(), by: Proposals.text( by, 100 ) || 'operator', reason: Proposals.text( reason, 500 ) } );
			if ( _proposal.kind === 'action' ) {
				delete this.egress.rules.actions.table[ _proposal.body.name ];
				Actions.forget( _proposal.body.name );
			} else {
				this.store.revokeMaster( _proposal.body.kind, [ _proposal.body.value ], { scope: _proposal.scope } );
			}
		} );
		this.egress.log.append( 'proposal_revoked', { proposal: id, kind: _proposal.kind, name: _proposal.name, by } );
		return this.get( id );
	}

	_apply( proposal ) {
		if ( proposal.kind === 'master' ) {
			this.store.addMaster( proposal.body.kind, [ proposal.body.value ], { scope: proposal.scope, source: 'proposal' } );
			return;
		}
		const { name, entry } = proposal.body;
		this.egress.rules.actions.table[ name ] = structuredClone( entry );
		if ( !Actions.learned()[ name ] ) { Actions.learn( { [ name ]: entry } ); }
	}

	// The actions an operator approved, for the core (which learns them) and for the gate's own start.
	learned() {
		return Object.fromEntries( this.list( 'approved' ).filter( item => item.kind === 'action' ).map( item => [ item.body.name, item.body.entry ] ) );
	}

	// At the start: the approved actions go into the table again. One whose name the operator's files have meanwhile is
	// left out and logged; the files win.
	load() {
		for ( const proposal of this.list( 'approved' ).filter( item => item.kind === 'action' ) ) {
			if ( this.egress.rules.actions.entry( proposal.body.name ) ) {
				this.egress.log.append( 'proposal_shadowed', { proposal: proposal.id, name: proposal.body.name } );
				continue;
			}
			this._apply( proposal );
		}
	}

	static text( value, max ) {
		return typeof value === 'string' ? value.trim().slice( 0, max ) : '';
	}

} );
