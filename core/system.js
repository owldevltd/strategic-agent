// Assembles the loop for one mission: catalog, sandbox runtime, model provider, gate client, journal, runner.
// The choices come from the configuration: Docker or the development process runtime, Vultr inference or the
// stub when no key is set.

app.define( 'Core.System', [ 'Core.Criteria.Registry', 'Core.Move.Catalog', 'Core.Move.Executor', 'Core.Loop.Runner', 'Core.Learn.Journal',
	'Core.Mission.Mission', 'Core.Move.Causes' ],
( ...deps ) => {
	const [ Registry, Catalog, Executor, Runner, Journal, Mission, Causes ] = deps;
	return class System {

		static async create( { config, db, log } ) {
			const _system = new System( { config, db, log } );
			_system.registry = await Registry.load();
			_system.runtime = await System._runtime( config, log );
			const [ GateClient ] = await app.use( [ 'Core.Outbound.GateClient' ] );
			_system.gate = new GateClient( config.gate.url, { token: process.env.GATE_CORE_TOKEN || '' } );
			return _system;
		}

		constructor( { config, db, log } ) {
			Object.assign( this, { config, db, log } );
			this.journal = new Journal( db );
			this.runners = [];
		}

		// One board for everyone: the promise is kept, not the board, so the resume after a restart and a person who looks
		// at the tickets at the same moment get the same one (18).
		board() {
			this._board = this._board || app.use( [ 'Core.Ticket.Board', 'Core.Budget.Capacity' ] )
				.then( ( [ Board, Capacity ] ) => new Board( this.log, { capacity: Capacity.load() } ) );
			return this._board;
		}

		// A task in words becomes a drafted, checked contract (G1 steps 1–4); then the loop takes over and the gate waits
		// for a person to confirm it (step 5). A refused draft never reaches the gate, and neither does a drafter answer
		// that broke its step contract after its one repair (6.4): that draft is refused like any other.
		async start( mission, task = mission.task ) {
			const _provider = await System._provider( this.config, this.log, mission );
			const [ Drafter ] = await app.use( [ 'Core.Contract.Drafter' ] );
			const _draft = await new Drafter( { provider: _provider, registry: this.registry, log: this.log } ).draft( mission, task )
				.catch( ( error ) => {
					if ( !/step contract/.test( error.message ) ) { throw error; }
					return { ok: false, problems: [ error.message ] };
				} );
			if ( !_draft.ok ) {
				this.log.append( 'draft_refused', { mission: mission.id, task, problems: _draft.problems } );
				return { refused: true, problems: _draft.problems };
			}
			const _runner = await this.assemble( mission, { provider: _provider } );
			// 7.3: the agent sets strategy gates for this kind of task; the store refuses anything looser (21).
			const _known = { scope: mission.kind, by: 'agent', registry: this.registry, catalog: _runner.catalog, strategies: mission.strategies };
			( _draft.gates || [] ).forEach( gate => this.gates.propose( gate, _known ) );
			_runner.root = await _runner.start( _draft.contract );
			_runner.run( _runner.root ).catch( app.fail );
			return _runner.root;
		}

		// The actions the gate's operator approved, learned by this process; one that cannot be (its name is now in the
		// operator's files) is left out and logged.
		async _learnActions( catalog ) {
			const Actions = app.get( 'Lib.Actions' );
			const _learned = await this.gate.learnedActions?.().catch( () => ( {} ) ) || {};
			for ( const [ name, entry ] of Object.entries( _learned ) ) {
				try {
					Actions.learn( { [ name ]: entry } );
				} catch ( error ) {
					this.log.append( 'action_not_learned', { action: name, reason: String( error.message ).slice( 0, 200 ) } );
				}
			}
			return Catalog.derive( catalog );
		}

		// A task without a mission folder: its kind (a plain name, "general" when the caller names none) becomes a
		// mission of its own below the storage (tasks/<kind>), holding nothing but its kind. Everything else the agent sets
		// up itself and a person confirms: the goal from the task (3.2), the strategies, moves and criteria it proposes
		// (6.1, 19), the strategy gates for the kind (7.3); what was approved stays with the kind for the next task. The
		// operator's part (actions, channels, master data, data, trusted tools) is never the agent's; without more, a
		// task works with the catalog's moves and actions. → the mission
		taskMission( kind = 'general' ) {
			const _kind = typeof kind === 'string' && kind.trim() ? kind.trim() : 'general';
			if ( !Mission.ID.test( _kind ) ) { throw System.refusal( 400, 'a kind of task is a plain name: lower case letters, digits, - and _' ); }
			if ( Mission.list().some( item => item.id === _kind || item.kind === _kind ) ) {
				throw System.refusal( 409, `${_kind} is a mission of its own; start that mission instead` );
			}
			const _fs = app.lib( 'node:fs' );
			const _path = app.lib( 'node:path' );
			const _dir = this.tasksDir();
			const _folder = _path.join( _dir, _kind );
			if ( !_fs.existsSync( _path.join( _folder, 'mission.json' ) ) ) {
				_fs.mkdirSync( _folder, { recursive: true } );
				const _contract = { id: _kind, goal: `A task of the kind ${_kind}`, deadline: '{{in:48h}}', budget: 20, criteria: [] };
				_fs.writeFileSync( _path.join( _folder, 'contract.json' ), `${JSON.stringify( _contract, null, 2 )}\n` );
				const _meta = { id: _kind, title: `Tasks: ${_kind}`, kind: _kind, task: '', contract: 'contract.json', adhoc: true };
				_fs.writeFileSync( _path.join( _folder, 'mission.json' ), `${JSON.stringify( _meta, null, 2 )}\n` );
				this.log.append( 'task_kind_created', { kind: _kind } );
			}
			return Mission.load( _kind, _dir );
		}

		// Where the kinds of tasks without a mission folder live: below the core's storage, else in a temporary folder.
		tasksDir() {
			const _path = app.lib( 'node:path' );
			const _base = this.config.storageDir ? _path.resolve( this.config.storageDir ) : app.lib( 'node:os' ).tmpdir();
			return _path.join( _base, this.config.storageDir ? 'tasks' : 'agency-tasks' );
		}

		// A mission by its id: from the mission folders, else one of the kinds of tasks without a folder (after a restart).
		mission( id ) {
			const _dir = this.tasksDir();
			const _file = Mission.ID.test( String( id ) ) && app.lib( 'node:path' ).join( _dir, id, 'mission.json' );
			const _adhoc = Boolean( _file ) && app.lib( 'node:fs' ).existsSync( _file );
			return !Mission.list().some( item => item.id === id ) && _adhoc ? Mission.load( id, _dir ) : Mission.load( id );
		}

		// The kinds of tasks without a mission folder, each with how much was approved for it.
		taskKinds() {
			const _fs = app.lib( 'node:fs' );
			const _dir = this.tasksDir();
			const _names = _fs.existsSync( _dir ) ? _fs.readdirSync( _dir ).filter( name => Mission.ID.test( name ) ) : [];
			const _meta = this.meta || new ( app.get( 'Core.Meta.Proposals' ) )( this.db, { log: this.log } );
			const _count = ( kind, what ) => _meta.approvedFor( kind, what ).length;
			return _names.map( kind => ( { kind, strategies: _count( kind, 'strategy' ), moves: _count( kind, 'move' ) } ) );
		}

		// A kind of task written down as a mission folder (Mission.bundle): what people approved for it in the core's
		// ledger and, at the gate, the actions and master data its operator approved for it. Only a kind without a mission
		// folder; the folder is written by the operator (bin/promote.mjs), never by the core. → { kind, files }
		async missionBundle( kind ) {
			if ( !Mission.ID.test( String( kind ) ) ) { throw System.refusal( 400, 'a kind of task is a plain name' ); }
			if ( Mission.list().some( item => item.id === kind ) ) { throw System.refusal( 409, `${kind} is a mission already` ); }
			const _running = this.runners.filter( runner => runner.mission.id === kind ).at( -1 )?.mission;
			const _known = _running || app.lib( 'node:fs' ).existsSync( app.lib( 'node:path' ).join( this.tasksDir(), kind, 'mission.json' ) );
			if ( !_known ) { throw System.refusal( 404, `no kind of task ${kind}` ); }
			const _mission = _running || this.mission( kind );
			const [ Proposals, StrategyGates ] = await app.use( [ 'Core.Meta.Proposals', 'Core.Gates.StrategyGates' ] );
			const _meta = this.meta || new Proposals( this.db, { log: this.log } );
			const _gates = this.gates || new StrategyGates( this.db, { log: this.log } );
			const _approved = await this.gate.gateProposals?.( { status: 'approved', scope: kind } ).catch( () => [] ) || [];
			const _events = this.log.since( 0, 1e9 );
			const _task = _events.filter( event => event.kind === 'task_received' && event.data?.mission === kind ).at( -1 )?.data?.task || '';
			const _confirmed = new Set( _events.filter( event => event.kind === 'contract_confirmed' ).map( event => event.node ) );
			// The last goal of this kind a person confirmed: neither a proposal's own process (meta) nor a case from outside.
			const _root = _events.filter( event => event.kind === 'node_created' && !event.data?.parent && event.data?.mission === kind
				&& event.data?.spec?.kind === _mission.kind && _confirmed.has( event.node ) ).at( -1 );
			const _hours = _root && ( Date.parse( _root.data.spec.deadline ) - Date.parse( _root.time ) ) / 3600000;
			const _goal = _root && { spec: _root.data.spec, hours: _hours };
			const _files = Mission.bundle( {
				kind: _mission.kind, task: _task, goal: _goal, strategies: _meta.approvedFor( kind, 'strategy' ), moves: _meta.approvedFor( kind, 'move' ),
				gates: _gates.active( kind ).filter( gate => gate.scope === kind ), actions: _approved.filter( item => item.kind === 'action' ),
				master: _approved.filter( item => item.kind === 'master' ),
			} );
			return { kind, files: _files };
		}

		// A task without a mission (taskMission), drafted and started like any other. → the root, or { refused, problems }
		async startTask( task, { kind = 'general' } = {} ) {
			return this.start( this.taskMission( kind ), task );
		}

		// Everything one mission runs on, wired the same way for the processes and for the tests.
		async assemble( mission, { provider = null, pollMs = 500, vault = null, run = null } = {} ) {
			// AGENCY_PROPOSALS: the actions an operator approved at the gate, each with the send move trusted code derives.
			const _catalog = this.config.proposals === true ? await this._learnActions( Catalog.load( mission ) ) : Catalog.load( mission );
			const _provider = provider || await System._provider( this.config, this.log, mission );
			const _board = await this.board();
			_provider.calibration = _provider.calibration || await this._calibration( _board );
			const [ Planner, Judge, SoftCheck, Agent, Expectations, Vault, Intake, Learner ] = await app.use( [
				'Core.Plan.Planner', 'Core.Loop.Judge', 'Core.Check.SoftCheck', 'Baseline.Agent',
				'Core.Inbound.Expectations', 'Core.Vault.Vault', 'Core.Inbound.Intake', 'Core.Learn.Learner',
			] );
			if ( !vault ) { await this._prune( Vault ); }
			const { vault: _vault, mission: _mission } = this._vault( Vault, mission, vault );
			const _expectations = this.expectations = this.expectations || new Expectations( this.db );
			const [ Supervisor, Memory ] = await app.use( [ 'Core.Lease.Supervisor', 'Core.Memory.Memory' ] );
			this.memory = this.memory || new Memory( this.db, { key: Memory.key( this.config.storageDir ), log: this.log } );
			this._observe( _expectations );
			this._history( _board );
			const [ Proposals, StrategyGates, StartAccount ] = await app.use( [ 'Core.Meta.Proposals', 'Core.Gates.StrategyGates', 'Core.Budget.StartAccount' ] );
			this.account = this.account || new StartAccount( this.db );
			const [ Index ] = await app.use( [ 'Core.Knowledge.Index' ] );
			const _signing = { sign: value => this.memory.sign( value ), verify: ( text, sig ) => this.memory.verify( text, sig ) };
			Object.assign( _signing, { log: this.log } );
			this.knowledge = this.knowledge || new Index( this.db, _signing );
			this.knowledge.index( app.lib( 'node:path' ).join( mission.dir, 'knowledge' ), { scope: mission.id, labels: mission.knowledgeLabels } );
			this.meta = this.meta || new Proposals( this.db, { log: this.log } );
			this.gates = this.gates || new StrategyGates( this.db, { log: this.log } );
			// 7.3: the strategy gates the agent set for this kind of task earlier come with the mission; they only ever add.
			if ( !this.gates.has( mission.kind ) ) {
				const _seed = { scope: mission.kind, by: 'agent', registry: this.registry, catalog: _catalog, strategies: mission.strategies };
				( mission.gates || [] ).forEach( gate => this.gates.propose( gate, _seed ) );
			}
			const _supervisor = new Supervisor( { gate: this.gate, runtime: this.runtime, beatMs: this.config.beatMs || 15000 } );
			const _executor = new Executor( {
				catalog: _catalog, runtime: this.runtime, provider: _provider, gate: this.gate, log: this.log, board: _board,
				soft: SoftCheck.load(), expectations: _expectations,
			} );
			const _runner = new Runner( {
				gate: this.gate, executor: _executor, catalog: _catalog, journal: this.journal, log: this.log, mission: _mission,
				registry: this.registry, startTokens: System.startTokens( mission ),
				planner: new Planner( { provider: _provider, catalog: _catalog, board: _board, log: this.log } ),
				judge: new Judge( { provider: _provider, registry: this.registry, causes: System.causes() } ),
				bufferMinutes: this.config.gate.bufferMinutes, maxDepth: this.config.maxDepth, pollMs, expectations: _expectations,
				supervisor: _supervisor, memory: this.memory, causes: System.causes(), id: run, meta: this.meta,
				learner: new Learner( { provider: _provider } ), gates: this.gates, account: this.account, knowledge: this.knowledge,
				proposals: this.config.proposals === true,
			} );
			this.meta.applyApproved( _runner );
			if ( !run ) {
				this.log.append( 'run_started', { run: _runner.id, mission: mission.id, vault: _vault.dir } );
			}
			_runner.vault = _vault;
			if ( mission.world && this.config.world !== false ) {
				const [ Simulation ] = await app.use( [ 'World.Simulation' ] );
				_runner.world = new Simulation( {
					world: mission.world, outbox: target => this.gate.outbox( target ),
					deliver: message => this._receive( _runner, message ),
					speed: this.config.worldSpeed || 1, pollMs: Math.max( pollMs, 20 ), log: this.log, mission: mission.id,
				} ).start();
			}
			_runner.intake = new Intake( {
				expectations: _expectations, provider: _provider, board: _board, vault: _vault, runner: _runner, log: this.log,
				directory: mission.directory,
			} );
			// The demo's neighbour office: the same model, the same messages, no gate (AGENCY_DEMO=1 only).
			_runner.baseline = this.config.demo
				? new Agent( { provider: _provider, mission: _mission, db: this.db, log: this.log } ) : null;
			this.runners.push( _runner );
			return _runner;
		}

		// B7: one calibration for every run, so the error rate of a role is measured over all of them.
		async _calibration( board ) {
			const [ Calibration ] = await app.use( [ 'Core.Ai.Calibration' ] );
			this.calibration = this.calibration || new Calibration( { board, log: this.log } );
			return this.calibration;
		}

		// Each run works on its own copy of the mission data; only trusted code of the core writes to it. The mission
		// itself stays as it was loaded: a later run of it copies the mission's data, never an earlier run's vault. The
		// run sees the mission with its vault as its data, by an absolute path (a sandbox mounts only such paths).
		_vault( Vault, mission, dir ) {
			const _path = app.lib( 'node:path' );
			const _storage = this.config.storageDir ? _path.resolve( this.config.storageDir ) : null;
			const _vault = dir ? new Vault( _path.resolve( dir ) ) : Vault.prepare( mission, _storage );
			const _run = Object.assign( Object.create( Object.getPrototypeOf( mission ) ), mission, { dataDir: _vault.dir } );
			return { vault: _vault, mission: _run };
		}

		// Retention (VAULT_RETENTION_DAYS): before a new run copies its data, the copies of finished runs that nobody
		// changed for that long go; the runs still open (in this process, or waiting in the log to resume) keep theirs.
		async _prune( Vault ) {
			const [ Restore ] = await app.use( [ 'Core.Loop.Restore' ] );
			const _keep = [ ...this.runners.map( runner => runner.vault?.dir ), ...Restore.unfinished( this.log ).map( run => run.vault ) ];
			const _days = this.config.vaultRetentionDays ?? Vault.RETENTION_DAYS;
			const _removed = Vault.prune( this.config.storageDir, { days: _days, keep: _keep } );
			if ( _removed.length ) { this.log.append( 'vault_pruned', { count: _removed.length } ); }
		}

		// L2: an answer to what an attempt sent is a signal of that attempt; what the journal learns after a lesson was
		// written becomes a correction of that lesson (9.3, L5).
		_observe( expectations ) {
			if ( this._observing ) { return; }
			this._observing = true;
			expectations.on( 'fact', event => event.attempt && this.journal.signal( event.attempt ) );
			this.journal.listen( ( attempt, change, reason ) => this.memory.correctLesson( attempt, change, reason ) );
		}

		// 8.4: every answer to a ticket, with its receipt, becomes part of the history of the node that asked.
		_history( board ) {
			if ( this._recording ) { return; }
			this._recording = true;
			board.listen( ( { ticket, answer } ) => {
				const _known = this.runners.map( runner => runner.nodes.get( ticket.node ) ).find( Boolean );
				const _node = _known || { id: ticket.node, emit: () => {} };
				this.memory.record( _node, 'ticket', {
					kind: ticket.kind, question: String( ticket.question ).slice( 0, 200 ), choice: answer.choice ?? null, by: answer.by,
					receipt: answer.receipt?.id || null, withdrawn: Boolean( answer.withdrawn ), expired: Boolean( answer.expired ),
				} );
			} );
		}

		// After a restart: every goal that had not closed continues from its events (Core.Loop.Restore). A core resumes
		// once: a second call gets the same goals, never a second runner for the same nodes (18). A run that cannot be
		// rebuilt (its log was changed, its mission is gone) stays where it is and is logged; the runs after it resume.
		resume( options = {} ) {
			this._resumed = this._resumed || this._resume( options );
			return this._resumed;
		}

		async _resume( { load = id => this.mission( id ), provider = null, pollMs = 500 } = {} ) {
			const [ Restore ] = await app.use( [ 'Core.Loop.Restore' ] );
			const _roots = [];
			const _damaged = this.log.since( 0, 1e9 ).filter( event => event.damaged ).map( event => event.id );
			if ( _damaged.length ) { this.log.append( 'log_damaged', { events: _damaged.slice( 0, 50 ), count: _damaged.length } ); }
			for ( const run of Restore.unfinished( this.log ) ) {
				let _runner = null;
				try {
					_runner = await this.assemble( load( run.mission ), { vault: run.vault, run: run.run, provider, pollMs } );
					const _restore = new Restore( _runner );
					const _rebuilt = _restore.rebuild();
					await _restore.unclear();
					for ( const root of _rebuilt ) {
						_runner.root = root;
						this.log.append( 'run_resumed', { run: run.run, mission: run.mission, root: root.id, state: root.state } );
						_roots.push( _restore.resume( root ) );
					}
				} catch ( error ) {
					this._drop( _runner );
					this.log.append( 'run_not_resumed', { run: run.run, mission: run.mission, reason: String( error.message ).slice( 0, 300 ) } );
					app.fail( error );
				}
			}
			return Promise.all( _roots );
		}

		// A runner that could not be rebuilt drives nothing and is no mission's latest run.
		_drop( runner ) {
			if ( !runner || runner.root ) { return; }
			runner.world?.stop?.();
			this.runners = this.runners.filter( item => item !== runner );
		}

		// The demo: one of the mission's canned messages from outside reaches both offices, ours as its own process, the
		// neighbour's directly (when there is one).
		async inbound( mission, messageId ) {
			const _runner = this._latest( mission );
			const _message = _runner.mission.inbound.find( item => item.id === messageId );
			if ( !_message ) {
				throw System.refusal( 404, `unknown message ${String( messageId ).slice( 0, 80 )}` );
			}
			const _neighbour = _runner.baseline?.handle( _message ) ?? null;
			const [ _ours, _theirs ] = await Promise.all( [ this.receive( mission, _message ), _neighbour ] );
			return { ours: _ours, neighbour: _theirs };
		}

		// Every message from outside starts its own process (8.1): matched to an expectation, or a new case.
		async receive( missionId, message ) {
			return this._receive( this._latest( missionId ), message );
		}

		async _receive( _runner, message ) {
			const _intake = await _runner.intake.handle( message );
			if ( _intake.case !== 'new' && !_intake.alsoAsks ) {
				return _intake;
			}
			const _cases = await _runner.newCase( message, { wait: false } );
			const _new = _cases.map( node => ( { node: node.id, goal: node.contract.goal, state: node.state } ) );
			return _intake.alsoAsks ? { ..._intake, cases: _new } : { case: 'new', cases: _new };
		}

		// 16.5 as a command of the client: the latest goal of the mission and everything below it.
		// A run assembled without a goal yet has nothing to abort.
		async abort( missionId ) {
			const _runner = this._latest( missionId );
			if ( !_runner.root ) { return { aborted: false, root: null }; }
			const _done = await _runner.abort( _runner.root, { reason: 'aborted by the client', status: 'aborted' } );
			return { aborted: _done, root: _runner.root.id };
		}

		// Is a goal of this mission still open?
		running( missionId ) {
			const _runner = this.runners.filter( item => item.mission.id === missionId ).at( -1 );
			return Boolean( _runner?.root ) && _runner.cascade.constructor.tree( _runner.root ).some( node => node.state !== 'closed' );
		}

		latest( missionId ) {
			return this._latest( missionId );
		}

		_latest( missionId ) {
			const _runner = this.runners.filter( item => item.mission.id === missionId ).at( -1 );
			if ( !_runner ) {
				throw System.refusal( 409, `mission ${String( missionId ).slice( 0, 80 )} has not been started` );
			}
			return _runner;
		}

		nodes() {
			return this.runners.flatMap( runner => [ ...runner.nodes.values() ] );
		}

		describe() {
			const _live = this.config.llm.apiKey && this.config.llm.model;
			return { runtime: this.runtime.constructor.NAME, isolated: this.runtime.constructor.ISOLATED, provider: _live ? this.config.llm.model : 'stub' };
		}

		static causes() {
			return Causes.load();
		}

		// A mistake of the caller, not of the core: the API answers it with this status (4xx) and the message.
		static refusal( status, message ) {
			return Object.assign( new Error( message ), { status } );
		}

		// R1: the root's start budget is the mission's (mission.json startTokens), 20 tokens if it names none.
		static startTokens( mission ) {
			return Number.isInteger( mission.startTokens ) && mission.startTokens >= 0 ? mission.startTokens : 20;
		}

		// 7.1: only a runtime the configuration names exactly; anything else is refused, never replaced by the one
		// without isolation.
		static async _runtime( config, log ) {
			const [ Sandbox ] = await app.use( [ 'Core.Sandbox.Runtime' ] );
			const [ Runtime ] = await app.use( [ Sandbox.module( config.sandbox.runtime ) ] );
			return new Runtime( { timeoutSeconds: config.sandbox.timeoutSeconds, image: config.sandbox.image, log } );
		}

		static async _provider( config, log, mission ) {
			if ( config.llm.apiKey && config.llm.model ) {
				const [ OpenAiProvider ] = await app.use( [ 'Core.Ai.OpenAiProvider' ] );
				return new OpenAiProvider( { ...config.llm, log } );
			}
			const [ StubProvider ] = await app.use( [ 'Core.Ai.StubProvider' ] );
			return new StubProvider( { answers: mission.stub, log } );
		}

	};
} );
