// Knows every criterion type by name (catalog/criteria.json maps type → class). An unknown type is not an
// error here; the contract check (G1) reports it, so a goal with an unknown rule is refused, not guessed.

app.define( 'Core.Criteria.Registry', [ 'Core.Criteria.Criterion', 'Lib.Missions' ], ( Criterion, Missions ) => class Registry {

	static FILE = 'catalog/criteria.json';

	// The catalog's types, plus the types the missions bring (criteria.json in a mission's folder: type → class name, the
	// class from the deployment's overrides, AGENCY_OVERRIDES). A mission adds types; it never replaces one (fail closed).
	static async load( file = Registry.FILE ) {
		const _path = app.lib( 'node:path' ).join( app.root, file );
		const _map = JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) );
		for ( const { id, value } of file === Registry.FILE ? Missions.files( 'criteria.json' ) : [] ) {
			for ( const [ type, name ] of Object.entries( value && typeof value === 'object' ? value : {} ) ) {
				if ( !/^[a-z][a-z0-9_]{0,63}$/.test( type ) || type in Object.prototype || typeof name !== 'string' ) {
					throw new Error( `mission ${id}: criteria.json maps a type to a class name` );
				}
				if ( Object.hasOwn( _map, type ) ) { throw new Error( `mission ${id}: the criterion type ${type} is defined already` ); }
				_map[ type ] = name;
			}
		}
		const _classes = await app.use( Object.values( _map ) );
		return new Registry( Object.fromEntries( Object.keys( _map ).map( ( type, i ) => [ type, _classes[ i ] ] ) ) );
	}

	constructor( types ) {
		this.types = types;
	}

	// Only the registry's own types: never a name of Object.prototype (__proto__, constructor, toString).
	has( type ) {
		return typeof type === 'string' && Object.hasOwn( this.types, type ) && typeof this.types[ type ] === 'function';
	}

	create( spec ) {
		return this.has( spec?.type ) ? new this.types[ spec.type ]( spec ) : null;
	}

	// What may be combined into a goal: type, kind, meaning and the parameters a person or model fills in. Types and
	// parameters the system sets itself are left out.
	list() {
		return Object.entries( this.types ).filter( ( [ , Type ] ) => !Type.INTERNAL ).map( ( [ type, Type ] ) => ( {
			type,
			kind: Type.KIND,
			means: Type.DESCRIBE,
			params: Object.fromEntries( Object.entries( Type.PARAMS ).filter( ( [ , param ] ) => !param.internal )
				.map( ( [ name, param ] ) => [ name, Registry._param( param ) ] ) ),
		} ) );
	}

	static _param( param ) {
		const _values = Criterion.values( param );
		return [ param.type, _values ? `one of ${_values.join( '|' )}` : '', param.describe || '' ].filter( Boolean ).join( ', ' );
	}

} );
