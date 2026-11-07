// The rig of the transition stress tests: a whole core assembled as in production (Core.System) with the gate in
// the same process, a test mission whose moves are scripted per call, hooks that fire inside a given transition of
// the node's state machine (so an abort, a deadline, a crash or a late fact lands exactly there), and a crash with a
// restart on the same log, journal and gate. Built like tests/office.mjs; each rig has its own in-memory databases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../../../lib/node.mjs';
import { within } from '../hostile.mjs';

const app = boot( { overrides: '' } );
const [ Registry, Contract, Db, EventLog, Egress, Outbox, Local, System, Mission, StubProvider, ProcessRuntime ] = await app.use( [
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Gate.Local',
	'Core.System', 'Core.Mission.Mission', 'Core.Ai.StubProvider', 'Core.Sandbox.ProcessRuntime',
] );
const [ Machine, Node, Restore, Pot, Runner, Judgment, Execution ] = await app.use( [
	'Core.Node.Machine', 'Core.Node.Node', 'Core.Loop.Restore', 'Core.Budget.Pot', 'Core.Loop.Runner', 'Core.Loop.Judgment', 'Core.Loop.Execution',
] );
export const registry = await Registry.load();
export { app, Contract, Machine, Node, Restore, Pot, Runner, Judgment, Execution, StubProvider };

// One vault folder for the whole test file: the test mission keeps no data of its own.
const VAULT = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-transitions-' ) );
process.on( 'exit', () => fs.rmSync( VAULT, { recursive: true, force: true } ) );

// Δ is 3 s here, so a closing that cannot clean up ends quickly instead of after 5 minutes.
const CONFIG = { gate: { bufferMinutes: 0.05 }, maxDepth: 5, llm: {}, sandbox: { runtime: 'process', timeoutSeconds: 10 }, beatMs: 50, world: false };
export const KIND = 'hr-survey';
export const QUANTITY = 'stress:q';

const MOVE = { criticality: 'read', params: {}, evidence: [], tSignalH: null, horizonH: null, leaseMaxMin: 1, reversible: false, commits: null };
// The moves of the test mission. Their executor decides how the node behaves (human and wait put it into waiting);
// what they return is scripted per call, nothing runs in a sandbox.
export const MOVES = {
	'stress.measure': { ...MOVE, executor: 'code', tool: 'tests/fixtures/sleep.py', price: 1, evidence: [ 'measured' ] },
	'stress.probe': { ...MOVE, executor: 'code', tool: 'tests/fixtures/sleep.py', price: 0.5 },
	'stress.slow': { ...MOVE, executor: 'code', tool: 'tests/fixtures/sleep.py', price: 1, leaseMaxMin: 0.004 },
	'stress.ask': { ...MOVE, executor: 'human', price: 0.5, reversible: true, criticality: 'internal' },
	'stress.hold': { ...MOVE, executor: 'human', price: 0.5, reversible: false, criticality: 'internal', leaseMaxMin: 0.004 },
	'stress.wait': { ...MOVE, executor: 'wait', price: 0.5, reversible: true },
};

// A strategy of the test mission; steps are move names or step objects.
export function strategy( id, steps, extra = {} ) {
	const _steps = steps.map( step => ( typeof step === 'string' ? { move: step } : step ) );
	// τ is short, so a strategy keeps its chance also when the deadline is only milliseconds away.
	const _curve = { p0: 0.9, tauH: 0.00001 };
	return { id, kind: KIND, serves: 'number_in_range', class: 'direct', price: 1, startCurve: _curve, tSignalH: null, steps: _steps, ...extra };
}

// The usual pair: a direct way, and another way the diagnosis of not_reached ('*') leads to.
export const PAIR = [ strategy( 'alpha', [ 'stress.measure' ] ), strategy( 'beta', [ 'stress.measure' ], { class: 'widen', price: 2 } ) ];
// A report through the gate: drafted by the model, sent with a person's approval (the token), proven by the receipt.
export const REPORT = strategy( 'report', [ { move: 'report.draft', as: 'report' }, { move: 'report.send', from: 'report', target: 'hr' } ], {
	serves: 'report_delivered', price: 1,
} );

export function spec( { deadlineMs = 3600000, budget = 30, value = 40, report = false, criteria = null, id = null } = {} ) {
	const _criteria = criteria || [
		report ? { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'stress' } }
			: { id: 'k1', type: 'number_in_range', values: { quantity: QUANTITY, min: 1 } },
	];
	return {
		id: id || `stress-${Math.random().toString( 36 ).slice( 2, 10 )}`, goal: 'Measure the stress quantity', kind: KIND,
		deadline: new Date( Date.now() + deadlineMs ).toISOString(), budget, value, criteria: _criteria,
	};
}

export const measured = ( value = 1, extra = {}, quantity = QUANTITY ) => ( {
	kind: 'measured', evidenceClass: 'observation', source: 'sandbox stress.measure', origin: 'system', data: { quantity, value }, ...extra,
} );
// The quantity a node measures: that of its first number criterion (a child measures its precondition).
const quantityOf = node => node.contract.criteria.find( item => item.type === 'number_in_range' )?.values.quantity || QUANTITY;
const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) );

// What a person's ticket gives when the judgment takes the move back (E6) or the cascade withdraws it (16.5). In a
// core that crashed nothing ends any more.
async function withdrawn( ctx, owner ) {
	while ( !ctx.node.plan?.cancelled && !ctx.node.stopping && ctx.node.state !== 'closed' ) {
		if ( owner.state.crashed ) { return new Promise( () => {} ); }
		await sleep( 5 );
	}
	const _value = { value: { choice: null, reason: ctx.node.plan?.cancelled ? 'cancelled' : 'aborted' }, labels: [ 'own' ], cohort: null, facts: [] };
	return ctx.node.plan?.cancelled ? _value : { ..._value, wall: { cause: 'no_reaction', reason: 'the ticket was withdrawn' } };
}

// What a scripted move returns; each is a function ( ctx, owner rig ) → output or a promise of it.
export const out = {
	fact: ( value = 1 ) => ctx => ( { value: { n: value }, labels: [ 'own' ], cohort: null, facts: [ measured( value, {}, quantityOf( ctx.node ) ) ] } ),
	none: () => () => ( { value: {}, labels: [ 'own' ], cohort: null, facts: [] } ),
	wall: ( cause, precondition = null ) => () => ( {
		value: null, labels: [ 'own' ], cohort: null, facts: [], wall: { cause, reason: `scripted ${cause}`, precondition },
	} ),
	fail: message => () => {
		throw new Error( message );
	},
	after: ( ms, then ) => ( ctx, owner ) => sleep( ms ).then( () => then( ctx, owner ) ),
	// Until the test releases it; when the move is cancelled or its node stopped first, it ends as a withdrawn ticket would.
	gated: ( name, then ) => ( ctx, owner ) => Promise.race( [
		owner.gate( name ).then( () => then( ctx, owner ) ), withdrawn( ctx, owner ),
	] ),
	hang: () => () => new Promise( () => {} ),
};

// The person at the gate and at the board, as in tests/office.mjs, with a say on confirmations too.
function operator( { gateDb, egress, board, approve, person, confirm, by } ) {
	const _busy = new Set();
	const _timer = setInterval( () => {
		for ( const row of gateDb.all( 'SELECT hash, id FROM contracts WHERE status = \'proposed\'' ) ) {
			if ( confirm( row ) ) { egress.confirm( row.hash, by ); }
		}
		for ( const approval of egress.pendingApprovals().filter( item => !_busy.has( item.id ) ) ) {
			const _yes = approve( approval );
			if ( _yes === null ) { continue; }
			_busy.add( approval.id );
			egress.decide( approval.id, _yes ? 'approve' : 'reject', by, { reason: 'checked', explicit: true } ).catch( () => {} )
				.finally( () => _busy.delete( approval.id ) );
		}
		for ( const ticket of board.list() ) {
			const _choice = person( ticket );
			if ( _choice !== null && ticket.options.includes( _choice ) ) { board.answer( ticket.id, { choice: _choice, by } ); }
		}
	}, 5 );
	_timer.unref();
	return _timer;
}

function stores( share ) {
	if ( share ) {
		const { gateDb, outbox, egress, db, log, taken, calls } = share;
		return { gateDb, outbox, egress, db, log, taken, calls };
	}
	const _gateDb = new Db( ':memory:' );
	const _outbox = new Outbox( _gateDb );
	const _egress = new Egress( { db: _gateDb, log: new EventLog( _gateDb, 'gate' ), channels: { default: _outbox }, bufferMinutes: CONFIG.gate.bufferMinutes } );
	const _db = new Db( ':memory:' );
	// taken: the start tokens a test took away per run, so R1 can still be counted; calls: how often the scripted world
	// was asked per move, which a restart of the core does not reset.
	return { gateDb: _gateDb, outbox: _outbox, egress: _egress, db: _db, log: new EventLog( _db, 'core' ), taken: {}, calls: {} };
}

function missionOf( { strategies, edit } ) {
	const _mission = Mission.load( 'survey' );
	Object.assign( _mission, { world: null, invariants: [], gates: [], data: null, dataDir: null } );
	_mission.moves = { ..._mission.moves, ...MOVES };
	_mission.strategies = strategies;
	edit?.( _mission );
	return _mission;
}

// A rig: options are those of office() plus script (move → list of outputs, the last one repeats), confirm (row →
// whether the person confirms the goal now), stateMinutes, provider, and resume (a crashed rig to restart from).
export async function rig( options = {} ) {
	const { strategies = PAIR, edit = null, script = {}, answers = {}, provider = null, share = null, stateMinutes = null } = options;
	const { planner = true, board = true } = options;
	const { approve = () => true, person = ticket => ticket.recommendation, confirm = () => true, by = 'test-person' } = options;
	const _mission = missionOf( { strategies, edit } );
	const _stores = stores( share );
	const _system = new System( { config: CONFIG, db: _stores.db, log: _stores.log } );
	const _state = { crashed: false, gates: new Map(), calls: _stores.calls, hooks: [], errors: [] };
	const _gate = new Proxy( new Local( _stores.egress ), {
		get: ( target, name ) => ( typeof target[ name ] === 'function'
			? ( ...args ) => ( _state.crashed ? new Promise( () => {} ) : target[ name ]( ...args ) ) : target[ name ] ),
	} );
	Object.assign( _system, { registry, runtime: new ProcessRuntime( { log: _stores.log } ), gate: _gate } );
	const _provider = provider || new StubProvider( { answers: { ..._mission.stub, ...answers }, log: _stores.log } );
	// model: 'garbage' answers outside every step contract, 'silent' never answers (only for the roles named in roles).
	if ( options.model ) {
		const _complete = _provider._complete.bind( _provider );
		const _hit = request => !options.roles || options.roles.includes( request.role );
		const _answer = { garbage: () => ( { verdict: 'certainly', nonsense: [ 1, 2 ] } ), silent: () => new Promise( () => {} ) }[ options.model ];
		_provider._complete = async request => ( _hit( request ) ? _answer() : _complete( request ) );
	}
	// slow: { role: ms } – that model takes its time, so something can arrive while it thinks.
	if ( options.slow ) {
		const _complete = _provider._complete.bind( _provider );
		_provider._complete = async request => sleep( options.slow[ request.role ] || 0 ).then( () => _complete( request ) );
	}
	const self = { ..._stores, mission: _mission, system: _system, provider: _provider, state: _state, script: { ...script } };
	// Every runner this system assembles plays the script instead of running the scripted moves.
	const _assemble = _system.assemble.bind( _system );
	_system.assemble = async ( mission, assembled ) => {
		const _runner = await _assemble( mission, { ...assembled, vault: assembled.vault || VAULT } );
		if ( stateMinutes ) { _runner.stateMinutes = { ..._runner.stateMinutes, ...stateMinutes }; }
		if ( !planner ) { _runner.planner = null; }
		if ( !board ) { _runner.executor.board = null; }
		const _real = _runner.executor.run.bind( _runner.executor );
		_runner.executor.run = ( step, ctx ) => ( self.script[ step.move ] || self.script[ `${step.move}@${ctx.node.depth}` ]
			? self.play( step, ctx ) : _real( step, ctx ) );
		return _runner;
	};
	_stores.log.subscribe( event => self.hear?.( event ) );
	// The board first: System.board() called twice at once makes two boards (a defect test shows it with boardFirst: false,
	// the order of core/main.js, where the restart runs while a person may already look at the board).
	const _first = options.boardFirst === false ? null : await _system.board();
	const _resumed = share && options.resume ? _system.resume( { load: () => _mission, provider: _provider, pollMs: 5 } ) : null;
	const _board = _first || await _system.board();
	const _runner = _resumed ? null : await _system.assemble( _mission, { provider: _provider, pollMs: 5 } );
	const _operator = operator( { ..._stores, board: _board, approve, person, confirm, by } );
	return Object.assign( self, {
		runner: _runner, board: _board, resumed: _resumed,
		// The runner of this rig: the one it assembled, or the first one its restart rebuilt.
		current: () => _runner || _system.runners[ 0 ],
		// A script for "move@depth" plays for the nodes of that depth, the one for the move for all others.
		play( step, ctx ) {
			const _key = self.script[ `${step.move}@${ctx.node.depth}` ] ? `${step.move}@${ctx.node.depth}` : step.move;
			const _list = [].concat( self.script[ _key ] );
			const _n = _state.calls[ _key ] = ( _state.calls[ _key ] || 0 ) + 1;
			const _entry = _list[ Math.min( _n, _list.length ) - 1 ];
			const _result = Promise.resolve().then( () => _entry( ctx, self ) );
			// A dead core's moves never come back.
			return _result.then( value => ( _state.crashed ? new Promise( () => {} ) : value ) );
		},
		called: move => _state.calls[ move ] || 0,
		// A promise the test releases with open( name ); it also ends when its node stops.
		gate( name ) {
			if ( !_state.gates.has( name ) ) {
				let _open;
				const _promise = new Promise( ( resolve ) => {
					_open = resolve;
				} );
				_state.gates.set( name, { promise: _promise, open: _open } );
			}
			return _state.gates.get( name ).promise;
		},
		open( name ) {
			self.gate( name );
			_state.gates.get( name ).open();
		},
		// fn( node, event ) runs inside the nth transition from → to of a node (root, child or any) for which when( event )
		// holds, at most once.
		on( transition, fn, { nth = 1, node = 'any', when = () => true } = {} ) {
			const [ _from, _to ] = transition.split( '→' );
			_state.hooks.push( { from: _from, to: _to, fn, nth, node, when, seen: 0, done: false } );
		},
		// fn( node, event ) runs inside the nth event of a kind for a node.
		onEvent( kind, fn, { node = 'any', nth = 1, when = () => true } = {} ) {
			_state.hooks.push( { kind, fn, nth, node, when, seen: 0, done: false } );
		},
		hear( event ) {
			for ( const hook of _state.hooks.filter( item => !item.done ) ) {
				const _match = hook.kind ? event.kind === hook.kind
					: event.kind === 'state_changed' && event.data.from === hook.from && event.data.to === hook.to;
				const _node = self.node( event.node );
				const _which = hook.node === 'any' || ( hook.node === 'root' ) === !_node?.parent;
				if ( !_match || !_node || !_which || !hook.when( event ) ) { continue; }
				hook.seen += 1;
				if ( hook.seen !== hook.nth ) { continue; }
				hook.done = true;
				try {
					hook.fn( _node, event );
				} catch ( error ) {
					_state.errors.push( error );
				}
			}
		},
		node: id => _system.runners.map( runner => runner.nodes.get( id ) ).find( Boolean ) || null,
		nodes: () => _system.runners.flatMap( runner => [ ...runner.nodes.values() ] ),
		async start( given = spec() ) {
			const _root = await _runner.start( new Contract( given, registry ) );
			_runner.root = _root;
			return _root;
		},
		// Runs a goal to its end; a hang is an error, never a pass.
		async run( given = spec(), ms = 6000 ) {
			const _root = await self.start( given );
			self.root = _root;
			await within( _runner.run( _root ), ms, 'the run' );
			return _root;
		},
		abort( node, status = 'aborted' ) {
			return self.current().abort( node, { reason: 'test abort', status } ).catch( error => _state.errors.push( error ) );
		},
		// The clock passes the node's deadline (the contract is frozen; only the time the runner compares with moves).
		expire( node ) {
			node.contract.deadline = new Date( Date.now() - 1 ).toISOString();
		},
		// A cost is booked that exhausts the node's budget.
		exhaust( node, over = 1 ) {
			Pot.book( node, { what: 'test cost', units: Pot.left( node ) + over } );
		},
		// No start token is left in the tree of this run (R1).
		noTokens( runner = self.current() ) {
			_stores.taken[ runner.id ] = ( _stores.taken[ runner.id ] || 0 ) + runner.tokensLeft();
			_stores.db.run( 'UPDATE start_accounts SET used = total WHERE root = :root', { root: runner.id } );
		},
		tokensUsed( runner = self.current() ) {
			return _stores.db.get( 'SELECT used FROM start_accounts WHERE root = :root', { root: runner.id } )?.used ?? 0;
		},
		deliver( node, fact = measured() ) {
			return self.current().deliver( node, fact );
		},
		events( node, kind ) {
			return _stores.log.forNode( node.id ).filter( event => !kind || event.kind === kind );
		},
		transitions( node ) {
			return self.events( node, 'state_changed' ).map( event => `${event.data.from}→${event.data.to}` );
		},
		stop() {
			clearInterval( _operator );
		},
		// The core goes down at this instant: its gate calls hang, its moves never return, its loops make no further step,
		// and whatever of it still runs reaches neither the log nor the journal, the start account or the memory.
		crash() {
			_state.crashed = true;
			clearInterval( _operator );
			const _dead = new Proxy( {}, { get: () => () => {
				throw new Error( 'the core is down' );
			} } );
			for ( const runner of _system.runners ) {
				runner._step = () => new Promise( () => {} );
				Object.assign( runner, { log: null, journal: _dead, account: _dead, memory: _dead, expectations: _dead, meta: _dead } );
				Object.assign( runner.executor, { log: null, expectations: _dead } );
				runner.nodes.forEach( ( node ) => {
					node.log = null;
				} );
			}
		},
		// A new core on the same log, journal and gate; → its rig and the roots it resumed, each run to its end.
		async restart( more = {}, ms = 6000 ) {
			const _next = await rig( { ...options, ...more, share: self, resume: true } );
			_state.next = _next;
			const _roots = await within( _next.resumed, ms, 'the restart' );
			_next.root = _roots[ 0 ] || null;
			return _next;
		},
	} );
}
