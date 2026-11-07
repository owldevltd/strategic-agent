// Runs one script in a throwaway environment and returns what it printed. The script gets its input as JSON on
// stdin and the mission data read-only. Implementations: ProcessRuntime (development only, not isolated) and
// DockerRuntime (no network, read-only, limits, destroyed after the run). gVisor or microVMs fit behind the
// same run().

app.define( 'Core.Sandbox.Runtime', [], () => class Runtime {

	static NAME = 'none';
	static ISOLATED = false;
	// 7.1: what a script may print before its run fails; the core never holds more of it.
	static OUTPUT_BYTES = 8 * 1024 * 1024;
	// Of stderr only the end is kept: it says why a script failed.
	static ERROR_BYTES = 64 * 1024;
	// The runtimes SANDBOX_RUNTIME may name. Anything else is refused, never replaced by the one without isolation (7.1).
	static MODULES = { docker: 'Core.Sandbox.DockerRuntime', process: 'Core.Sandbox.ProcessRuntime' };

	static module( name ) {
		if ( typeof name !== 'string' || !Object.hasOwn( Runtime.MODULES, name ) ) {
			throw new Error( `unknown sandbox runtime ${JSON.stringify( String( name ).slice( 0, 40 ) )}: SANDBOX_RUNTIME is docker or process; `
				+ 'it is never replaced by a runtime that is not isolated (7.1)' );
		}
		return Runtime.MODULES[ name ];
	}

	constructor( { timeoutSeconds = 10, log = null } = {} ) {
		this.timeoutSeconds = timeoutSeconds;
		this.log = log;
		this._running = new Map();
	}

	// The limit handed to `timeout`. GNU timeout reads 0 as "no limit" (7.1): a limit of 0, or one that rounds down to it,
	// becomes 1 s. A negative limit or one that is no number stays as it is: timeout refuses it and nothing runs.
	get limit() {
		const _seconds = this.timeoutSeconds;
		return _seconds >= 0 && _seconds < 0.01 ? 1 : _seconds;
	}

	// The abort cascade and the supervisor end what still runs for a node (16.5, A3).
	stop( node ) {
		for ( const stop of this._running.get( node ) || [] ) {
			stop();
		}
		this._running.delete( node );
	}

	_track( node, stop ) {
		if ( !node ) { return () => {}; }
		const _set = this._running.get( node ) || new Set();
		_set.add( stop );
		this._running.set( node, _set );
		return () => _set.delete( stop );
	}

	async run( { script, input = {}, dataDir = null, node = null } ) {
		const _fs = app.lib( 'node:fs' );
		const _work = _fs.mkdtempSync( app.lib( 'node:path' ).join( app.lib( 'node:os' ).tmpdir(), 'sandbox-' ) );
		const _started = Date.now();
		this.log?.append( 'sandbox_started', { runtime: this.constructor.NAME, isolated: this.constructor.ISOLATED }, { node } );
		// 7.1: the folder is destroyed after every run, also after one whose script could not even be written.
		try {
			_fs.writeFileSync( app.lib( 'node:path' ).join( _work, 'main.py' ), script );
			const _track = stop => this._track( node, stop );
			const _result = await this._exec( { work: _work, input: JSON.stringify( input ), dataDir, track: _track } );
			this.log?.append( 'sandbox_finished', { runtime: this.constructor.NAME, exitCode: _result.exitCode, ms: Date.now() - _started }, { node } );
			return _result;
		} finally {
			_fs.rmSync( _work, { recursive: true, force: true } );
			this.log?.append( 'sandbox_destroyed', { runtime: this.constructor.NAME }, { node } );
		}
	}

	_exec() {
		throw new Error( 'Runtime._exec must be implemented' );
	}

	// The one place a sandbox process starts. group: the process leads a process group of its own, and every kill ends the
	// whole group, so nothing it started (python below `timeout`) lives on without its limit (16.5).
	static spawn( command, args, { input, env, timeoutSeconds, track = null, cwd = undefined, group = false } ) {
		return new Promise( ( resolve ) => {
			const _child = app.lib( 'node:child_process' ).spawn( command, args, { env, cwd, detached: group, stdio: [ 'pipe', 'pipe', 'pipe' ] } );
			const _kill = () => Runtime._kill( _child, group );
			const _untrack = track ? track( _kill ) : () => {};
			const _out = { chunks: [], bytes: 0, over: false };
			const _err = { chunks: [], bytes: 0 };
			const _timer = setTimeout( _kill, ( timeoutSeconds + 5 ) * 1000 );
			let _settled = false;
			const _settle = ( result ) => {
				if ( _settled ) { return; }
				_settled = true;
				clearTimeout( _timer );
				_untrack();
				resolve( result );
			};
			// 7.1: output beyond the limit is not held; the run is stopped and fails.
			_child.stdout.on( 'data', ( chunk ) => {
				if ( _out.over ) { return; }
				_out.bytes += chunk.length;
				if ( _out.bytes > Runtime.OUTPUT_BYTES ) {
					_out.over = true;
					_kill();
					return;
				}
				_out.chunks.push( chunk );
			} );
			_child.stderr.on( 'data', ( chunk ) => {
				_err.chunks.push( chunk );
				_err.bytes += chunk.length;
				while ( _err.chunks.length > 1 && _err.bytes - _err.chunks[ 0 ].length >= Runtime.ERROR_BYTES ) {
					_err.bytes -= _err.chunks.shift().length;
				}
			} );
			// 18.6: a script that ends without reading its input closes the pipe; that EPIPE is the script's business, not a
			// crash of the core.
			_child.stdin.on( 'error', () => {} );
			_child.on( 'error', error => _settle( { exitCode: -1, stdout: '', stderr: error.message } ) );
			_child.on( 'close', ( code ) => {
				// 16.5: when the run ends, so does everything it started. A process the code put in the background, with its
				// output elsewhere, would otherwise live on after a normal end, outside every limit.
				if ( group ) { Runtime._end( _child ); }
				const _stderr = Buffer.concat( _err.chunks ).toString( 'utf8' );
				const _over = _out.over ? `\nthe output exceeded ${Runtime.OUTPUT_BYTES} bytes; the run was stopped (7.1)` : '';
				_settle( {
					exitCode: _out.over ? -1 : code ?? -1,
					stdout: Buffer.concat( _out.chunks ).toString( 'utf8' ),
					stderr: `${_stderr}${_over}`.slice( -2000 ),
				} );
			} );
			_child.stdin.end( input );
		} );
	}

	// The rest of a group whose leader has ended; nothing left is no error.
	static _end( child ) {
		try {
			if ( child.pid ) { process.kill( -child.pid, 'SIGKILL' ); }
		} catch {
			// The group is gone already.
		}
	}

	static _kill( child, group ) {
		if ( group && child.pid ) {
			try {
				process.kill( -child.pid, 'SIGKILL' );
				return;
			} catch {
				// The group is gone already; the process itself may still be there.
			}
		}
		child.kill( 'SIGKILL' );
	}

} );
