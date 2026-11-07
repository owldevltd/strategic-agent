// The only global. Every class file registers itself with app.define(); app.use() loads a class and its
// dependencies on first use. The same file runs in the browser (script tags) and in Node (lib/node.mjs swaps
// loadScript for a file reader). app.override() points a class name at another file, so a different
// implementation can replace a building block without touching the code that uses it.
//
// The registries are plain objects, read only through their own keys: a name such as "constructor" or "__proto__"
// is no class just because Object.prototype has a member of that name.

const app = {
	config: {
		root: '',
		language: 'en',
	},
	namespaces: {
		Lib: 'lib/',
		Core: 'core/',
		Gate: 'gate/',
		World: 'world/',
		Baseline: 'baseline/',
		Ui: 'ui/',
	},
	classes: {},
	_definitions: {},
	_loading: {},
	_overrides: {},
	// Which classes each class that is still loading waits for; a cycle in it would wait forever.
	_waits: {},
};

app._own = ( map, name ) => ( typeof name === 'string' && Object.hasOwn( map, name ) ? map[ name ] : undefined );

app._set = ( map, name, value ) => {
	Object.defineProperty( map, name, { value, enumerable: true, configurable: true, writable: true } );
};

app.namespace = ( name, path ) => {
	app._set( app.namespaces, name, path );
};

app.override = ( name, file ) => {
	app._set( app._overrides, name, file );
};

app.path = ( name ) => {
	if ( app._own( app._overrides, name ) ) {
		return app._overrides[ name ];
	}
	const _parts = name.split( '.' );
	const _root = app._own( app.namespaces, _parts.shift() );
	if ( typeof _root === 'undefined' || _parts.length === 0 ) {
		throw new Error( `Unknown class name: ${name}` );
	}
	return `${app.config.root}${_root}${_parts.join( '/' ).toLowerCase()}.js`;
};

app.define = ( name, requires, factory ) => {
	if ( app._own( app._definitions, name ) ) {
		throw new Error( `Class defined twice: ${name}` );
	}
	app._set( app._definitions, name, { requires, factory } );
};

app.require = ( name, _chain = [] ) => {
	if ( typeof name !== 'string' ) {
		return Promise.reject( new TypeError( `A class name is text, not ${typeof name}` ) );
	}
	if ( _chain.includes( name ) ) {
		return Promise.reject( new Error( `Circular dependency: ${[ ..._chain, name ].join( ' → ' )}` ) );
	}
	if ( !app._own( app._loading, name ) ) {
		app._set( app._loading, name, app._fetch( name ).then( ( definition ) => {
			if ( !Array.isArray( definition.requires ) ) {
				throw new TypeError( `${name} requires no list of class names` );
			}
			const _path = [ ..._chain, name ];
			app._set( app._waits, name, definition.requires );
			const _wait = dep => ( !_path.includes( dep ) && app._cycle( name, dep ) ) || app.require( dep, _path );
			const _deps = definition.requires.map( _wait );
			return Promise.all( _deps ).then( ( classes ) => {
				app._set( app.classes, name, definition.factory( ...classes ) );
				return app.classes[ name ];
			} ).finally( () => delete app._waits[ name ] );
		} ) );
	}
	return app._loading[ name ];
};

// A dependency that already waits, directly or not, for the class that wants it: two use() calls at once, or two
// siblings, would each wait for the other's promise forever. → a rejected promise naming the cycle, or null.
app._cycle = ( name, dep ) => {
	const _seen = new Set();
	const _walk = ( current, path ) => {
		if ( current === name ) { return path; }
		if ( _seen.has( current ) ) { return null; }
		_seen.add( current );
		for ( const next of app._own( app._waits, current ) || [] ) {
			const _found = _walk( next, [ ...path, next ] );
			if ( _found ) { return _found; }
		}
		return null;
	};
	const _path = _walk( dep, [ name, dep ] );
	return _path ? Promise.reject( new Error( `Circular dependency: ${_path.join( ' → ' )}` ) ) : null;
};

app._fetch = name => new Promise( ( resolve, reject ) => {
	if ( app._own( app._definitions, name ) ) {
		resolve( app._definitions[ name ] );
		return;
	}
	app.loadScript( app.path( name ), ( error ) => {
		if ( error ) {
			reject( error );
		} else if ( !app._own( app._definitions, name ) ) {
			reject( new Error( `${app.path( name )} does not define ${name}` ) );
		} else {
			resolve( app._definitions[ name ] );
		}
	} );
} );

app.use = ( names, cb ) => {
	const _list = Array.isArray( names ) ? names : [ names ];
	const _promise = Promise.all( _list.map( name => app.require( name ) ) );
	if ( !cb ) { return _promise; }
	_promise.then( classes => cb( ...classes ) ).catch( app.fail );
};

app.get = ( name ) => {
	if ( typeof name !== 'string' || !Object.hasOwn( app.classes, name ) ) {
		throw new Error( `Class not loaded: ${String( name )} (call app.use() first)` );
	}
	return app.classes[ name ];
};

app.make = ( name, ...args ) => {
	const _Class = app.get( name );
	return new _Class( ...args );
};

app.loadScript = ( src, cb ) => {
	const _script = document.createElement( 'script' );
	_script.src = src;
	_script.async = true;
	_script.onload = () => cb();
	_script.onerror = () => cb( new Error( `File not found: ${src}` ) );
	document.head.append( _script );
};

app.fail = ( error ) => {
	console.error( error );
	if ( app.event ) {
		app.event.emit( 'app:error', error );
	}
};

if ( typeof window !== 'undefined' ) {
	window.addEventListener( 'unhandledrejection', e => app.fail( e.reason ) );
}
