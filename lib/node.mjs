import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Node bootstrap for the class files. They are plain scripts sharing one global `app`, exactly as in the
// browser, so Node runs them in this context instead of importing them. Node built-ins reach them through
// app.lib( 'node:fs' ).
//
// Overrides: AGENCY_OVERRIDES may name a folder with an overrides.json that maps class names to files in that
// folder, e.g. { "Core.Strategy.TargetCurve": "targetcurve.js" }. That folder can live outside this repository; the
// files it names must lie inside it.

export const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

const nodeRequire = createRequire( import.meta.url );

export function boot( { overrides = process.env.AGENCY_OVERRIDES } = {} ) {
	if ( globalThis.agencyApp ) {
		return globalThis.agencyApp;
	}
	const _appFile = path.join( ROOT, 'lib/app.js' );
	vm.runInThisContext( fs.readFileSync( _appFile, 'utf8' ), { filename: _appFile } );
	const _app = vm.runInThisContext( 'app' );
	_app.root = ROOT;
	_app.lib = name => nodeRequire( name );
	_app.loadScript = ( src, cb ) => {
		const _file = path.isAbsolute( src ) ? src : path.join( ROOT, src );
		if ( !fs.existsSync( _file ) ) {
			cb( new Error( `File not found: ${src}` ) );
			return;
		}
		try {
			vm.runInThisContext( fs.readFileSync( _file, 'utf8' ), { filename: _file } );
			cb();
		} catch ( error ) {
			cb( error );
		}
	};
	if ( overrides ) {
		const _dir = path.resolve( overrides );
		const _map = JSON.parse( fs.readFileSync( path.join( _dir, 'overrides.json' ), 'utf8' ) );
		if ( !_map || typeof _map !== 'object' || Array.isArray( _map ) ) {
			throw new TypeError( 'overrides.json must map class names to file names' );
		}
		for ( const [ name, file ] of Object.entries( _map ) ) {
			if ( typeof file !== 'string' ) {
				throw new TypeError( `overrides.json: the file for ${name} is not a file name` );
			}
			// Only files of that folder: an entry such as "../../core/x.js" or "/etc/x.js" would load code from anywhere.
			const _file = path.resolve( _dir, file );
			if ( !_file.startsWith( `${_dir}${path.sep}` ) ) {
				throw new Error( `overrides.json: the file for ${name} lies outside ${_dir}` );
			}
			_app.override( name, _file );
		}
	}
	globalThis.agencyApp = _app;
	return _app;
}
