// The two processes of a deployment, in one test process: a real gate (Gate.Main) and a real core (Core.Main), each
// with its own temporary storage, both on 127.0.0.1 port 0, talking over HTTP exactly as in production. No .env is
// ever read: the configuration is built here, never by Config.load().
import { afterEach } from 'node:test';
import fs from 'node:fs';
import { limits } from '../hostile.mjs';
import os from 'node:os';
import path from 'node:path';
import { use } from '../../helper.mjs';

const [ CoreMain, GateMain ] = await use( 'Core.Main', 'Gate.Main' );
export { CoreMain, GateMain };

const ENV = [
	'PUBLIC_DEMO', 'GATE_PUBLIC_URL', 'GATE_OPERATOR_PIN', 'GATE_CORE_TOKEN', 'CORE_BOARD_PIN', 'INBOUND_TOKEN', 'SANDBOX_DOCKER_RUNTIME', 'MEMORY_KEY',
];

// Runs fn with the given environment variables (undefined removes one) and restores them afterwards.
export async function withEnv( values, fn ) {
	const _saved = Object.fromEntries( ENV.map( name => [ name, process.env[ name ] ] ) );
	for ( const name of ENV ) {
		const _value = name in values ? values[ name ] : undefined;
		if ( _value === undefined ) { delete process.env[ name ]; } else { process.env[ name ] = _value; }
	}
	try {
		return await fn();
	} finally {
		for ( const [ name, value ] of Object.entries( _saved ) ) {
			if ( value === undefined ) { delete process.env[ name ]; } else { process.env[ name ] = value; }
		}
	}
}

export function configFor( root, { gateUrl = 'http://127.0.0.1:9', runtime = 'process', apiKey = '', model = '', demo = true } = {} ) {
	return {
		root, storageDir: root,
		core: { host: '127.0.0.1', port: 0 },
		gate: { host: '127.0.0.1', port: 0, url: gateUrl, bufferMinutes: 5 },
		llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey, model, timeoutSeconds: 3 },
		sandbox: { runtime, image: 'agency-sandbox-test', timeoutSeconds: 5 },
		maxDepth: 5, worldSpeed: 100, beatMs: 50, demo,
	};
}

export const tempRoot = prefix => fs.mkdtempSync( path.join( os.tmpdir(), prefix ) );

// Two real processes start in seconds on a loaded machine; a hang still fails, only later.
limits.timeout = 30000;

// A check that fails before it stops its deployment would leave a gate and a core listening, and the test file would
// never end. Whatever a test left open is stopped after it.
const OPEN = new Set();
afterEach( async () => {
	for ( const item of [ ...OPEN ] ) { await item.stop().catch( () => null ); }
} );

// A gate and a core. Every goal the core started is aborted at the end, so no loop outlives the test.
export async function deployment( { env = {}, gate = true, core = {}, pollMs = 20 } = {} ) {
	return withEnv( env, async () => {
		const _gateRoot = tempRoot( 'stress-gate-' );
		const _coreRoot = tempRoot( 'stress-core-' );
		const _gate = gate ? new GateMain( configFor( _gateRoot ) ) : null;
		const _gatePort = _gate ? await _gate.start() : 9;
		const _main = new CoreMain( configFor( _coreRoot, { gateUrl: `http://127.0.0.1:${_gatePort}`, ...core } ) );
		const _port = await _main.start();
		// The demo polls every 500 ms; the tests poll faster, everything else is the production wiring.
		const _assemble = _main.system.assemble.bind( _main.system );
		_main.system.assemble = ( mission, options = {} ) => _assemble( mission, { ...options, pollMs } );
		const _base = `http://127.0.0.1:${_port}`;
		const _deployment = {
			main: _main, gate: _gate, port: _port, base: _base, gateBase: `http://127.0.0.1:${_gatePort}`,
			call: ( method, url, body, headers = {} ) => fetch( `${_base}${url}`, {
				method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify( body ),
			} ),
			gateCall: ( method, url, body, headers = {} ) => fetch( `http://127.0.0.1:${_gatePort}${url}`, {
				method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify( body ),
			} ),
			async stop() {
				if ( !OPEN.delete( _deployment ) ) { return; }
				for ( const runner of _main.system?.runners || [] ) {
					runner.world?.stop();
					if ( runner.root ) { await runner.abort( runner.root, { reason: 'test ends', status: 'aborted' } ).catch( () => null ); }
				}
				// Keep-alive connections of the test's own fetch calls would hold close() for seconds.
				_main.http.server?.closeAllConnections();
				await _main.stop();
				_gate?.http.server?.closeAllConnections();
				await _gate?.stop();
				for ( const dir of [ _gateRoot, _coreRoot ] ) { fs.rmSync( dir, { recursive: true, force: true } ); }
			},
		};
		OPEN.add( _deployment );
		return _deployment;
	} );
}

export const json = async response => ( { status: response.status, body: await response.json().catch( () => null ) } );

export const until = async ( check, ms = 20000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end; await new Promise( resolve => setTimeout( resolve, 5 ) ) ) {
		const _value = await check();
		if ( _value ) { return _value; }
	}
	throw new Error( 'timed out waiting' );
};
