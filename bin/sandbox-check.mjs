import { boot } from '../lib/node.mjs';

// Containment check of the sandbox on this host, run by the operator (infra/smoke.sh runs it over ssh). The probes
// are Core.Sandbox.Probes, the same the office runs. Prints one JSON line per probe, exits 1 if any probe escaped,
// and exits 1 as well when the configured runtime is unknown (it is never replaced by another one, 7.1).

const app = boot();
const [ Config, Probes, Runtime ] = await app.use( [ 'Lib.Config', 'Core.Sandbox.Probes', 'Core.Sandbox.Runtime' ] );
const config = Config.load();

try {
	const [ Chosen ] = await app.use( [ Runtime.module( config.sandbox.runtime ) ] );
	const probes = new Probes( new Chosen( { timeoutSeconds: 5, image: config.sandbox.image } ) );
	console.log( JSON.stringify( { runtime: Chosen.NAME, isolated: Chosen.ISOLATED, engine: process.env.SANDBOX_DOCKER_RUNTIME || 'runc' } ) );
	const _done = await probes.run( { each: result => console.log( JSON.stringify( { ...result, stderr: result.saw } ) ) } );
	process.exit( _done.stopped === _done.of ? 0 : 1 );
} catch ( error ) {
	console.log( JSON.stringify( { ok: false, reason: `${error.message}; probes skipped` } ) );
	process.exit( 1 );
}
