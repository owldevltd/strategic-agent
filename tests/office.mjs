// A whole office for a test: the core assembled exactly as in production (Core.System), the gate in the same
// process, and a person who confirms goals, approves actions and answers tickets. Each test gets its own
// in-memory databases; a second office can share them to play a restarted core.
import { boot } from '../lib/node.mjs';

const app = boot( { overrides: '' } );
const [ Registry, Contract, Db, EventLog, Egress, Outbox, Local, System, Mission, StubProvider, ProcessRuntime ] = await app.use( [
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Gate.Local',
	'Core.System', 'Core.Mission.Mission', 'Core.Ai.StubProvider', 'Core.Sandbox.ProcessRuntime',
] );
export const registry = await Registry.load();
export { app, Contract, Mission };

// A heartbeat every 250 ms keeps a lease for one second: long enough that a loaded machine does not end a move, short
// enough that a test which waits for an expired lease waits only a second.
const CONFIG = {
	gate: { bufferMinutes: 5 }, maxDepth: 5, llm: {}, sandbox: { runtime: 'process', timeoutSeconds: 10 }, worldSpeed: 100, beatMs: 250, demo: true,
};

function missionFor( mission, strategies, edit ) {
	const _mission = typeof mission === 'string' ? Mission.load( mission ) : mission;
	if ( strategies ) {
		// The base strategies of the catalog (the client as the channel, a proposal for the catalog) are always there.
		const _base = new Set( Mission.base().map( item => item.id ) );
		_mission.strategies = typeof strategies[ 0 ] === 'string'
			? _mission.strategies.filter( item => strategies.includes( item.id ) || _base.has( item.id ) || item.kind === 'request' ) : strategies;
	}
	edit?.( _mission );
	return _mission;
}

// share: the databases and the gate of another office, as after a restart.
function stores( share, mission, proposals = false ) {
	if ( share ) {
		return { gateDb: share.gateDb, outbox: share.outbox, egress: share.egress, db: share.db, log: share.log };
	}
	const _gateDb = new Db( ':memory:' );
	const _outbox = new Outbox( _gateDb );
	const _egress = new Egress( { db: _gateDb, log: new EventLog( _gateDb, 'gate' ), channels: { default: _outbox }, proposals } );
	for ( const [ kind, values ] of Object.entries( mission.masterData || {} ) ) { _egress.store.addMaster( kind, values ); }
	const _db = new Db( ':memory:' );
	return { gateDb: _gateDb, outbox: _outbox, egress: _egress, db: _db, log: new EventLog( _db, 'core' ) };
}

// After crash() every call of this core to the gate hangs, as if its process were gone.
function crashable( egress ) {
	const _state = { crashed: false };
	const _gate = new Proxy( new Local( egress ), {
		get: ( target, name ) => ( typeof target[ name ] === 'function'
			? ( ...args ) => ( _state.crashed ? new Promise( () => {} ) : target[ name ]( ...args ) ) : target[ name ] ),
	} );
	return { gate: _gate, state: _state };
}

// The person: confirms every proposed goal, decides approvals and answers tickets, and at the gate what the agent
// proposed there (decide(proposal) → 'approve', 'reject' or null for not yet).
function operator( { gateDb, egress, board, approve, person, decide, by } ) {
	const _busy = new Set();
	const _decide = async ( approval, yes ) => {
		_busy.add( approval.id );
		try {
			await egress.decide( approval.id, yes ? 'approve' : 'reject', by, { reason: 'checked', explicit: true } );
		} finally {
			_busy.delete( approval.id );
		}
	};
	const _timer = setInterval( () => {
		gateDb.all( 'SELECT hash FROM contracts WHERE status = \'proposed\'' ).forEach( row => egress.confirm( row.hash, by ) );
		for ( const approval of egress.pendingApprovals().filter( item => !_busy.has( item.id ) ) ) {
			const _yes = approve( approval );
			if ( _yes !== null ) { _decide( approval, _yes ); }
		}
		for ( const proposal of egress.proposals.list() ) {
			const _decision = decide( proposal );
			if ( _decision ) { egress.proposals.decide( proposal.id, _decision, by, 'checked at the gate' ); }
		}
		for ( const ticket of board.list() ) {
			const _choice = person( ticket );
			if ( _choice !== null && ticket.options.includes( _choice ) ) { board.answer( ticket.id, { choice: _choice, by } ); }
		}
	}, 5 );
	_timer.unref();
	return _timer;
}

// approve(approval) → true, false or null (not yet); person(ticket) → a choice or null (not yet).
export async function office( {
	mission = 'survey', answers = {}, strategies = null, edit = null, provider = null, share = null, resume = false,
	approve = () => true, person = ticket => ticket.recommendation, by = 'test-person', proposals = false, decide = () => 'approve',
} = {} ) {
	const _mission = missionFor( mission, strategies, edit );
	const _stores = stores( share, _mission, proposals );
	const _system = new System( { config: { ...CONFIG, proposals }, db: _stores.db, log: _stores.log } );
	const _crash = crashable( _stores.egress );
	Object.assign( _system, { registry, runtime: new ProcessRuntime( { log: _stores.log } ), gate: _crash.gate } );
	const _provider = provider || new StubProvider( { answers: { ..._mission.stub, ...answers }, log: _stores.log } );
	const _resumed = resume ? _system.resume( { load: () => _mission, provider: _provider, pollMs: 5 } ) : null;
	const _runner = resume ? null : await _system.assemble( _mission, { provider: _provider, pollMs: 5 } );
	const _board = await _system.board();
	const _operator = operator( { ..._stores, board: _board, approve, person, decide, by } );
	// What keeps this office's runs alive; a crash or a stop lets the process go.
	const _alive = new Set();
	const _release = () => {
		_alive.forEach( timer => clearInterval( timer ) );
		_alive.clear();
	};
	return {
		..._stores, mission: _mission, system: _system, runner: _runner, board: _board, resumed: _resumed,
		executor: _runner?.executor, baseline: _runner?.baseline, catalog: _runner?.catalog,
		stop: () => {
			clearInterval( _operator );
			_release();
		},
		crash() {
			_crash.state.crashed = true;
			clearInterval( _operator );
			_release();
			for ( const runner of _system.runners ) {
				runner.world?.stop();
				runner.nodes.forEach( ( node ) => {
					node.log = null;
				} );
			}
		},
		// In production the HTTP server keeps the process alive while a goal waits for its person; here the run does.
		async run( spec = _mission.contractSpec() ) {
			const _timer = setInterval( () => {}, 1000 );
			_alive.add( _timer );
			try {
				const _root = await _runner.start( new Contract( spec, registry ) );
				_runner.root = _root;
				await _runner.run( _root );
				return _root;
			} finally {
				clearInterval( _timer );
				_alive.delete( _timer );
			}
		},
		events: ( node, kind ) => _stores.log.forNode( node.id ).filter( event => event.kind === kind ).map( event => event.data ),
	};
}
