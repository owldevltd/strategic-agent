// A fresh container per run: no network, read-only root, a small tmpfs without exec, memory, CPU and process limits,
// no capabilities, the core's own unprivileged user (never root), and a hard timeout inside the container. The script
// and the mission data are mounted read-only; no secret ever enters. --rm destroys the container afterwards.
// SANDBOX_DOCKER_RUNTIME=runsc switches to gVisor where it is installed.

app.define( 'Core.Sandbox.DockerRuntime', [ 'Core.Sandbox.Runtime', 'Lib.Hash' ], ( Runtime, Hash ) => class DockerRuntime extends Runtime {

	static NAME = 'docker';
	static ISOLATED = true;
	// A plain image reference: [host[:port]/]name[/name…][:tag][@algorithm:hex]. Nothing that docker could read as an
	// option (a leading "-") or as more than one argument.
	static IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::\w[\w.-]{0,127})?(?:@[A-Za-z][A-Za-z0-9]*:[0-9a-fA-F]+)?$/;

	constructor( options = {} ) {
		super( options );
		this.image = DockerRuntime.image( options.image || 'python:3.12-slim' );
		this.engine = process.env.SANDBOX_DOCKER_RUNTIME || '';
	}

	static image( name ) {
		if ( typeof name !== 'string' || name.length > 255 || !DockerRuntime.IMAGE.test( name ) ) {
			throw new Error( `the sandbox image ${JSON.stringify( String( name ).slice( 0, 80 ) )} is no plain image reference (SANDBOX_IMAGE, 7.1)` );
		}
		return name;
	}

	async _exec( { work, input, dataDir, track } ) {
		const _name = Hash.id( 'sbx' );
		const _mounts = [ DockerRuntime.mount( work, '/work' ), ...( dataDir ? [ DockerRuntime.mount( dataDir, '/data' ) ] : [] ) ];
		const _args = [
			'run', '--rm', '-i', '--name', _name,
			'--network', 'none',
			'--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
			'--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '64',
			'--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
			'--user', DockerRuntime.user(), '-e', 'HOME=/tmp', '-e', 'AGENCY_DATA=/data', '-w', '/tmp',
			..._mounts.flatMap( mount => [ '--mount', mount ] ),
		];
		if ( this.engine ) {
			_args.push( '--runtime', this.engine );
		}
		_args.push( this.image, 'timeout', '-k', '2', String( this.limit ), 'python', '-I', '/work/main.py' );
		const _untrack = track( () => Runtime.spawn( 'docker', [ 'kill', _name ], { input: '', env: process.env, timeoutSeconds: 5 } ) );
		const _result = await Runtime.spawn( 'docker', _args, { input, env: process.env, timeoutSeconds: this.limit + 20 } );
		_untrack();
		if ( _result.exitCode !== 0 ) {
			await Runtime.spawn( 'docker', [ 'kill', _name ], { input: '', env: process.env, timeoutSeconds: 5 } );
		}
		return _result;
	}

	// --mount, not -v: its fields are named, so a colon in a path cannot change the target or the mode. docker reads it as
	// one CSV line, so a field with a comma or a quote is quoted. A relative path is refused: docker would read it as the
	// name of a volume (created on demand, shared by every run), not as the folder.
	static mount( source, target ) {
		if ( typeof source !== 'string' || !app.lib( 'node:path' ).isAbsolute( source ) || [ ...source ].some( char => char < ' ' ) ) {
			throw new Error( `the sandbox mounts only an absolute path of plain characters, not ${JSON.stringify( String( source ).slice( 0, 80 ) )} (7.1)` );
		}
		const _src = `src=${source}`;
		return `type=bind,${/[",]/.test( _src ) ? `"${_src.replace( /"/g, '""' )}"` : _src},dst=${target},readonly`;
	}

	// The container runs as the core's own user and group: the work folder and the vault the core made for this run stay
	// private on the host (0700) and are still readable inside, read-only. A core without a uid (another platform), or
	// one that runs as root, gets nobody (65534): root never runs agent code, and nobody can read nothing private.
	static user() {
		const _uid = typeof process.getuid === 'function' ? process.getuid() : 0;
		const _gid = typeof process.getgid === 'function' ? process.getgid() : 0;
		return _uid > 0 ? `${_uid}:${_gid > 0 ? _gid : 65534}` : '65534:65534';
	}

} );
