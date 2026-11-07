// Where missions live. A deployment names its mission folders in AGENCY_MISSIONS (relative to the root, separated by
// commas; "missions" when it is not set), so a company keeps its own missions next to or instead of the demo's without
// changing a file of the engine. Core and gate read the same folders: the core for goals, moves and strategies, the
// gate for what only the operator may say (master data, the action table), each from its own start.

app.define( 'Lib.Missions', [], () => class Missions {

	static DEFAULT = 'missions';
	// A mission is a folder of its own with a plain name.
	static ID = /^[\p{Ll}\p{N}][\p{Ll}\p{N}_-]{0,63}$/u;

	// The folders that hold missions, as absolute paths, each once, in the order given.
	static dirs( value = process.env.AGENCY_MISSIONS ) {
		const _path = app.lib( 'node:path' );
		const _names = String( value ?? '' ).split( ',' ).map( item => item.trim() ).filter( Boolean );
		return [ ...new Set( ( _names.length ? _names : [ Missions.DEFAULT ] ).map( name => _path.resolve( app.root, name ) ) ) ];
	}

	// The user's base setup (catalog/base.json, or the file AGENCY_BASE names, relative to the root or absolute): its soft
	// rules, the daily capacity of people and the time zone their days are counted in. → the file's content, {} when
	// there is none; a file that is no JSON object stops the start.
	static base( value = process.env.AGENCY_BASE ) {
		const _fs = app.lib( 'node:fs' );
		const _file = app.lib( 'node:path' ).resolve( app.root, String( value ?? '' ).trim() || Missions.BASE );
		if ( !_fs.existsSync( _file ) ) { return {}; }
		const _base = JSON.parse( _fs.readFileSync( _file, 'utf8' ).replace( /^\uFEFF/, '' ) );
		if ( !_base || typeof _base !== 'object' || Array.isArray( _base ) ) { throw new TypeError( `${_file}: the base setup is no JSON object` ); }
		return _base;
	}

	static BASE = 'catalog/base.json';

	// Every mission of those folders: [ { id, dir } ], where dir is the folder that holds it. An id in two folders is
	// refused (fail closed): which of the two a goal meant could not be told apart.
	static all( dirs = Missions.dirs() ) {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		const _found = new Map();
		for ( const dir of dirs ) {
			const _names = _fs.existsSync( dir ) ? _fs.readdirSync( dir ) : [];
			for ( const id of _names.filter( name => Missions.ID.test( name ) && _fs.existsSync( _path.join( dir, name, 'mission.json' ) ) ) ) {
				if ( _found.has( id ) ) { throw new Error( `mission ${id} is in ${_found.get( id )} and in ${dir}` ); }
				_found.set( id, dir );
			}
		}
		return [ ..._found ].map( ( [ id, dir ] ) => ( { id, dir } ) );
	}

	// The folder that holds mission id; null when no folder has it.
	static home( id, dirs = Missions.dirs() ) {
		return Missions.all( dirs ).find( item => item.id === id )?.dir ?? null;
	}

	// A JSON file every mission may bring (master.json, actions.json): → [ { id, file, value } ] for those that have it.
	static files( name, dirs = Missions.dirs() ) {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		return Missions.all( dirs ).map( ( { id, dir } ) => ( { id, file: _path.join( dir, id, name ) } ) )
			.filter( item => _fs.existsSync( item.file ) )
			.map( item => ( { ...item, value: JSON.parse( _fs.readFileSync( item.file, 'utf8' ).replace( /^\uFEFF/, '' ) ) } ) );
	}

} );
