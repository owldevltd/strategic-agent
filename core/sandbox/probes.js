// Containment probes (7.1): code an attacker would like to run, run in the same sandbox as the agent's own code. A
// probe counts as stopped only if Python really ran in the sandbox and was stopped there, not if the container never
// started: the harmless first probe must show that Python runs (else the whole test is unusable and nothing counts),
// and no later probe counts when its run shows that Python never started. The operator runs them on the host
// (bin/sandbox-check.mjs, infra/smoke.sh); in the office a visitor starts them and watches each one being stopped.
// They run only in an isolated runtime: the development runtime isolates nothing, and the probes would run on the
// machine itself.

app.define( 'Core.Sandbox.Probes', [], () => class Probes {

	static LIST = [
		{ name: 'runs code and returns its result', code: 'print(6 * 7)', stopped: run => run.exitCode === 0 && run.stdout.trim() === '42' },
		{ name: 'network: send data out', code: 'import urllib.request\nurllib.request.urlopen("https://example.com", timeout=3)',
			stopped: run => Probes.failed( run ) && /URLError|unreachable|resolution|Errno/.test( run.stderr ) },
		{ name: 'secrets: read keys from the environment',
			code: 'import os\nprint(sorted(k for k in os.environ if any(s in k.upper() for s in ("KEY", "TOKEN", "SECRET", "PIN", "PASS"))))',
			stopped: run => run.exitCode === 0 && run.stdout.trim() === '[]' },
		{ name: 'host: write into the system', code: 'open("/usr/local/pwned", "w").write("x")',
			stopped: run => Probes.failed( run ) && /Read-only|PermissionError/.test( run.stderr ) },
		{ name: 'time: endless loop', code: 'while True:\n    pass', stopped: run => Probes.failed( run ) },
		{ name: 'memory: take 1 GB', code: 'x = bytearray(1024 * 1024 * 1024)\nprint("got 1 GB")',
			stopped: run => Probes.failed( run ) && !run.stdout.includes( 'got 1 GB' ) },
		{ name: 'processes: fork bomb', code: 'import os, time\nfor i in range(500):\n    if os.fork() == 0:\n        time.sleep(3)\n        os._exit(0)\nprint("500 processes")',
			stopped: run => Probes.failed( run ) && !run.stdout.includes( '500 processes' ) },
	];

	// Exit codes that say the probe never reached Python: the process or container never started or was ended from
	// outside (-1), docker or timeout failed themselves (125), python could not be started (126) or found (127).
	static NOT_RUN = [ -1, 125, 126, 127 ];

	// One escape test may take this long altogether; a runtime that never answers does not hold it for ever.
	static DEADLINE_MS = 4 * 60000;

	constructor( runtime, { deadlineMs = Probes.DEADLINE_MS } = {} ) {
		this.runtime = runtime;
		this.deadlineMs = deadlineMs;
	}

	get isolated() {
		return Boolean( this.runtime.constructor.ISOLATED );
	}

	// Python ran the probe and failed there: not a container that never started, not a script it could not open.
	static failed( run ) {
		return run.exitCode !== 0 && Number.isInteger( run.exitCode ) && !Probes.NOT_RUN.includes( run.exitCode )
			&& !/can't open file/.test( String( run.stderr || '' ) );
	}

	// each( result ) is told after every probe. → { stopped, of, results }; refuses on a runtime that is not isolated.
	async run( { each = () => {} } = {} ) {
		if ( !this.isolated ) {
			throw new Error( 'the sandbox runtime is not isolated (SANDBOX_RUNTIME=docker in production); the probes would run on this machine' );
		}
		const _end = Date.now() + this.deadlineMs;
		const _results = [];
		for ( const probe of Probes.LIST ) {
			// Without the harmless probe's 42 nobody knows that Python runs here at all: what follows proves nothing.
			const _usable = probe === Probes.LIST[ 0 ] || _results[ 0 ].ok;
			const _result = _usable ? await this._probe( probe, _end )
				: { probe: probe.name, ok: false, exit: null, ms: 0, saw: 'not run: the harmless probe showed no Python running in this sandbox' };
			_results.push( _result );
			each( _result );
		}
		return { stopped: _results.filter( item => item.ok ).length, of: _results.length, results: _results };
	}

	async _probe( probe, end ) {
		const _started = Date.now();
		let _timer = null;
		const _late = new Promise( ( _resolve, reject ) => {
			_timer = setTimeout( () => reject( new Error( `the escape test did not end within ${Math.round( this.deadlineMs / 1000 )} s` ) ),
				Math.max( 0, end - _started ) );
			_timer.unref?.();
		} );
		try {
			const _run = await Promise.race( [ this.runtime.run( { script: probe.code, input: {} } ), _late ] );
			return {
				probe: probe.name, ok: probe.stopped( _run ), exit: _run.exitCode, ms: Date.now() - _started,
				saw: Probes.last( _run.stderr ) || Probes.last( _run.stdout ),
			};
		} finally {
			clearTimeout( _timer );
		}
	}

	// The last line the attacker's code printed, short, as the log shows it.
	static last( text ) {
		return String( text || '' ).trim().split( '\n' ).at( -1 ).slice( 0, 120 );
	}

} );
