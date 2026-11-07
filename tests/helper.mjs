import { boot, ROOT } from '../lib/node.mjs';

// Loads classes by name for a test, the same way the processes do.
export async function use( ...names ) {
	const _app = boot( { overrides: '' } );
	return _app.use( names );
}

export function memoryDb() {
	return boot( { overrides: '' } ).make( 'Lib.Db', ':memory:' );
}

export { ROOT };
