// Development only: runs the script as a local process with an empty environment and a time limit. It is NOT
// isolated (network and files are reachable); every run says so in the log. Production uses DockerRuntime.

app.define( 'Core.Sandbox.ProcessRuntime', [ 'Core.Sandbox.Runtime' ], Runtime => class ProcessRuntime extends Runtime {

	static NAME = 'process';
	static ISOLATED = false;

	// -I ignores every PYTHON* variable, so bytecode writing is switched off by -B (a user-writable Python on the host
	// would get __pycache__ next to its modules). The script starts in its own folder, never in the core's (the repository
	// with its .env), and leads a process group of its own, so stop( node ) ends python too, not only timeout (16.5). The
	// data dir the core names is meant from the core's folder, so the script gets it as an absolute path.
	_exec( { work, input, dataDir, track } ) {
		const _path = app.lib( 'node:path' ).join( work, 'main.py' );
		const _env = { PATH: process.env.PATH, AGENCY_DATA: dataDir ? app.lib( 'node:path' ).resolve( dataDir ) : '', PYTHONDONTWRITEBYTECODE: '1' };
		return Runtime.spawn( 'timeout', [ '-k', '2', String( this.limit ), 'python3', '-I', '-B', _path ], {
			input, env: _env, timeoutSeconds: this.limit, track, cwd: work, group: true,
		} );
	}

} );
