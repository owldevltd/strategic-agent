// A mission is data only: a goal (contract), the data in the vault, mission-specific moves and strategies, and
// parameters. Core and gate never know a mission by name.

app.define( 'Core.Mission.Mission', [ 'Lib.Missions' ], Missions => class Mission {

	// Every mission of the deployment's mission folders (AGENCY_MISSIONS, see Lib.Missions).
	static list() {
		return Missions.all().map( ( { id, dir } ) => Mission.load( id, dir ) ).sort( ( a, b ) => ( a.order ?? 99 ) - ( b.order ?? 99 ) );
	}

	// Strategies every kind of process has, e.g. asking the client to confirm what no channel can prove (K4).
	static base() {
		const _file = app.lib( 'node:path' ).join( app.root, 'catalog', 'strategies.json' );
		return app.lib( 'node:fs' ).existsSync( _file ) ? JSON.parse( app.lib( 'node:fs' ).readFileSync( _file, 'utf8' ) ) : [];
	}

	// dir: the folder that holds missions; by default the one of the deployment's mission folders that has it.
	// A mission is a folder of its own: the id is a plain name, and every file it names lies inside that folder.
	static ID = Missions.ID;

	static load( id, dir = null ) {
		const _path = app.lib( 'node:path' );
		if ( typeof id !== 'string' || !Mission.ID.test( id ) ) { throw new Error( `no mission ${String( id ).slice( 0, 80 )}` ); }
		dir = dir ?? Missions.home( id ) ?? Missions.dirs()[ 0 ];
		const _dir = _path.join( dir, id );
		// A file name is always read inside the folder (an absolute name too); one that climbs out is refused.
		const _inside = ( file ) => {
			if ( typeof file !== 'string' || !file ) { throw new TypeError( `mission ${id}: a file name must be text` ); }
			const _file = _path.resolve( _path.join( _dir, file ) );
			if ( !_file.startsWith( `${_path.resolve( _dir )}${_path.sep}` ) ) {
				throw new Error( `mission ${id}: ${file.slice( 0, 80 )} lies outside the mission folder` );
			}
			return _file;
		};
		const _read = file => JSON.parse( app.lib( 'node:fs' ).readFileSync( _inside( file ), 'utf8' ).replace( /^\uFEFF/, '' ) );
		const _meta = _read( 'mission.json' );
		if ( !_meta || typeof _meta !== 'object' || Array.isArray( _meta ) ) { throw new TypeError( `mission ${id}: mission.json is no object` ); }
		// A file mission.json may name: read when it does, else the default.
		const _optional = ( name, fallback ) => ( _meta[ name ] ? _read( _meta[ name ] ) : fallback );
		return new Mission( {
			...meta( _meta ),
			dir: _dir,
			contract: _read( _meta.contract ),
			moves: _optional( 'moves', {} ),
			// The mission's strategies are for its kind of goal; a new case from outside has its own (8.1); the base
			// strategies of the catalog say for which kind they are, or serve any.
			strategies: [
				..._optional( 'strategies', [] ).map( item => ( { kind: _meta.kind || _meta.id, ...item } ) ),
				..._optional( 'requests', [] ),
				...Mission.base(),
			],
			inbound: _optional( 'inbound', [] ),
			stub: _optional( 'stub', {} ),
			world: _optional( 'world', null ),
			diagnosis: _optional( 'diagnosis', {} ),
			gates: _optional( 'gates', [] ),
			// The labels of the mission's knowledge (9.1); own unless the mission says otherwise.
			knowledgeLabels: _meta.knowledge?.labels || [ 'own' ],
			roster: _meta.roster ? _inside( _meta.roster ) : null,
			masterData: _optional( 'master', {} ),
			baselineRole: _meta.baseline || 'You are a helpful assistant with full access to the company data below. Do what the message asks.',
			kind: _meta.kind || _meta.id,
			order: _meta.order ?? null,
			// R1: the root's start budget for this kind of task; the system uses 20 when it names none.
			startTokens: _meta.startTokens ?? null,
			task: _meta.task || '',
			invariants: _meta.invariants || [],
			defaults: _meta.defaults || {},
			context: _meta.context || {},
			office: _meta.office || {},
			directory: _meta.directory || null,
		} );

		// The data folder is checked like a file: a vault copy of anything outside the mission folder is refused.
		function meta( raw ) {
			const _data = raw.data && _inside( raw.data ) && raw.data;
			return { id: raw.id, title: raw.title, params: raw.params || {}, master: raw.master || {}, data: _data };
		}
	}

	constructor( spec ) {
		Object.assign( this, spec );
		this.dataDir = spec.data ? app.lib( 'node:path' ).join( spec.dir, spec.data ) : null;
		// Two strategies with one id would make the choice ambiguous: a mission that has them is refused.
		const _ids = ( spec.strategies || [] ).map( item => item?.id );
		const _twice = _ids.filter( ( item, index ) => _ids.indexOf( item ) !== index );
		if ( _twice.length ) { throw new Error( `mission ${spec.id}: the strategy id ${_twice[ 0 ]} is used twice` ); }
	}

	// Deadlines in mission files are relative ({{in:48h}}), so a demo always starts with a goal in the future. The kind
	// is the mission's: a contract file cannot move its goal to the strategies, gates and lessons of another kind.
	contractSpec( now = Date.now() ) {
		const _text = JSON.stringify( this.contract ).replace( /\{\{in:(\d+)h\}\}/g, ( _all, hours ) => new Date( now + hours * 3600000 ).toISOString() );
		return { ...JSON.parse( _text ), kind: this.kind, id: `${this.contract.id}-${now.toString( 36 )}` };
	}

	describe() {
		const _inbound = this.inbound.map( ( { id, label, from } ) => ( { id, label, from } ) );
		const office = Object.fromEntries( Object.entries( this.office ).filter( ( [ key ] ) => key !== 'counter' ) );
		return { id: this.id, title: this.title, kind: this.kind, task: this.task, goal: this.contract.goal, inbound: _inbound, office };
	}

	// A kind of task, written down as a mission folder: what people approved for it, one file each, as a company keeps
	// its missions (reviewed, versioned, taken along). given: { kind, task, goal (the spec of the last goal a person
	// confirmed, with the hours it had), strategies, moves (approved proposals: { body, version, approvedBy }), gates (the
	// strategy gates in force), actions and master (the gate's approved proposals of this kind) }. → { name: content }
	static bundle( { kind, task = '', goal = null, strategies = [], moves = [], gates = [], actions = [], master = [] } ) {
		if ( typeof kind !== 'string' || !Mission.ID.test( kind ) ) { throw new Error( `no kind of task ${String( kind ).slice( 0, 80 )}` ); }
		const _files = {};
		const _meta = { id: kind, title: `Tasks: ${kind}`, kind, task, contract: 'contract.json' };
		_files[ 'contract.json' ] = Mission.template( kind, goal );
		const _provenance = item => ( { version: item.version, by: item.approvedBy } );
		const _strip = ( { kind: _kind, proposed: _proposed, approved: _approved, ...rest } ) => rest;
		if ( strategies.length ) {
			_meta.strategies = 'strategies.json';
			_files[ 'strategies.json' ] = strategies.map( item => ( { ..._strip( item.body ), approved: _provenance( item ) } ) );
		}
		const _moves = Object.fromEntries( moves.map( item => [ item.body.id, Mission.move( item.body, _provenance( item ) ) ] ) );
		for ( const { body } of actions ) {
			_moves[ `${body.name}.send` ] = _moves[ `${body.name}.send` ] || app.get( 'Core.Move.Catalog' ).sendMove( body.name, body.entry );
		}
		if ( Object.keys( _moves ).length ) {
			_meta.moves = 'moves.json';
			_files[ 'moves.json' ] = _moves;
		}
		if ( gates.length ) {
			_meta.gates = 'gates.json';
			_files[ 'gates.json' ] = gates.map( ( { id: _id, scope: _scope, expires: _expires, by: _by, ...rule } ) => rule );
		}
		if ( actions.length ) { _files[ 'actions.json' ] = Object.fromEntries( actions.map( item => [ item.body.name, item.body.entry ] ) ); }
		if ( master.length ) {
			_meta.master = 'master.json';
			_files[ 'master.json' ] = master.reduce( ( all, item ) => ( { ...all, [ item.body.kind ]: [ ...( all[ item.body.kind ] || [] ), item.body.value ] } ), {} );
		}
		_files[ 'mission.json' ] = _meta;
		return _files;
	}

	// The goal a mission starts from: the last one a person confirmed for this kind, its deadline relative again; the
	// frame of a kind when none was confirmed yet.
	static template( kind, goal ) {
		if ( !goal?.spec ) { return { id: kind, goal: `A task of the kind ${kind}`, deadline: '{{in:48h}}', budget: 20, criteria: [] }; }
		const { goal: _text, budget, value, criteria, soft } = goal.spec;
		const _hours = Math.max( 1, Math.round( Number( goal.hours ) || 48 ) );
		return { id: kind, goal: _text, deadline: `{{in:${_hours}h}}`, budget, value, criteria, ...( soft?.length ? { soft } : {} ) };
	}

	// An approved move as a mission's move: what registration fixed for it (it inherits its labels; its criticality is
	// that of its executor) stays fixed in the file.
	static move( body, approved ) {
		return { ...body, inherit: true, criticality: body.executor === 'wait' ? 'read' : 'internal', approved };
	}

} );
