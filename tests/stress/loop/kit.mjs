// The rig of the loop stress tests: the real classes of the loop and its budgets, assembled around small fakes (a
// gate, an executor, a provider), so that one attack runs in milliseconds. Whole offices run only where a path needs
// the real gate and a person.
import { office, registry, Contract, Mission, app } from '../../office.mjs';

export { office, registry, Contract, Mission, app };

export const [
	Node, Pot, Capacity, StartAccount, Supervisor, Executor, Execution, Judgment, Judge, Closing, Runner, Journal, EventLog, Db,
	Catalog, Board, StubProvider, Leases, SoftCheck, Expectations,
] = await app.use( [
	'Core.Node.Node', 'Core.Budget.Pot', 'Core.Budget.Capacity', 'Core.Budget.StartAccount', 'Core.Lease.Supervisor',
	'Core.Move.Executor', 'Core.Loop.Execution', 'Core.Loop.Judgment', 'Core.Loop.Judge', 'Core.Loop.Closing', 'Core.Loop.Runner',
	'Core.Learn.Journal', 'Lib.EventLog', 'Lib.Db', 'Core.Move.Catalog', 'Core.Ticket.Board', 'Core.Ai.StubProvider', 'Gate.Leases',
	'Core.Check.SoftCheck', 'Core.Inbound.Expectations',
] );

export const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) );

// The follow-up survey waits 0.6 s instead of a minute, as in the house tests.
export const quick = ( mission ) => {
	mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
};

// The survey goal, due in `hours`; fields of over replace those of the mission.
export function spec( over = {}, hours = 48 ) {
	const _spec = Mission.load( 'survey' ).contractSpec();
	return { ..._spec, deadline: new Date( Date.now() + hours * 3600000 ).toISOString(), ...over };
}

export function memoryLog() {
	return new EventLog( new Db( ':memory:' ), 'core' );
}

export function node( { over = {}, parent = null, log = memoryLog(), hours = 48 } = {} ) {
	return new Node( { contract: new Contract( spec( over, hours ), registry ), parent, log } );
}

// What a node wrote of one kind into the log.
export function kinds( log, of, kind ) {
	return log.forNode( of.id ).filter( event => event.kind === kind ).map( event => event.data );
}

// A plain node for the pot: budget, spent, reserved and the events it emitted.
export function purse( budget, { spent = 0, reserved = 0 } = {} ) {
	const _events = [];
	return { contract: { budget }, spent, reserved, events: _events, emit: ( kind, data ) => _events.push( { kind, ...data } ) };
}

// The receipt of the gate a move left behind; the report the survey sends.
export const RECEIPT = { kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { action: 'report', to: 'hr' } };

// A gate that confirms every goal at once and records what the core asked of it.
export function fakeGate( { deliveries = {}, confirm = true, lease = null } = {} ) {
	const calls = [];
	let _fence = 0;
	return {
		calls, deliveries,
		propose: async ( contract ) => {
			calls.push( [ 'propose', contract.hash ] );
		},
		contract: async hash => ( confirm ? { status: 'confirmed', confirmedBy: 'test-person', hash } : { status: 'proposed', hash } ),
		delivery: async id => deliveries[ id ] || null,
		withdraw: async ( id ) => {
			calls.push( [ 'withdraw', id ] );
			return { status: 'not_sent' };
		},
		submit: async ( request ) => {
			calls.push( [ 'submit', request ] );
			return { delivery: `dl-${calls.length}`, status: 'executed', receipt: { id: 'rc-1' } };
		},
		lease: lease || ( async ( request ) => {
			calls.push( [ 'lease', request ] );
			_fence++;
			return { id: `ls-${_fence}`, fence: _fence, maxUntil: new Date( Date.now() + request.minutes * 60000 ).toISOString() };
		} ),
		beat: async () => ( { ok: true } ),
		release: async ( id ) => {
			calls.push( [ 'release', id ] );
		},
	};
}

// Moves of the stress tests, one per base executor; reversible where 18.3 E6 allows a cancellation.
export const MOVES = {
	'stress.code': { executor: 'code', price: 0.05, criticality: 'read', params: {}, evidence: [], reversible: false, leaseMaxMin: 2 },
	'stress.ai': { executor: 'ai', price: 0.3, criticality: 'internal', params: {}, evidence: [], reversible: false, leaseMaxMin: 3 },
	'stress.human': { executor: 'human', price: 0, humanMinutes: 2, criticality: 'internal', params: {}, evidence: [], reversible: true },
	'stress.wait': { executor: 'wait', price: 0.05, criticality: 'internal', params: {}, evidence: [], reversible: true },
	'stress.child': { executor: 'child', price: 1, criticality: 'internal', params: {}, evidence: [], reversible: false },
};

// A bare runner of the survey mission: real journal, log, catalog, judgment and closing; a fake gate and executor.
// executor: the methods to replace; moves: further catalog entries.
export function rig( { mission = Mission.load( 'survey' ), gate = fakeGate(), executor = {}, board = null, moves = {}, ...options } = {} ) {
	const db = new Db( ':memory:' );
	const log = new EventLog( db, 'core' );
	const catalog = Catalog.load( mission );
	Object.assign( catalog.moves, MOVES, moves );
	const _executor = {
		catalog, board, runtime: null,
		run: async () => ( { value: {}, labels: [ 'own' ], cohort: null, facts: [] } ),
		conclude: async decision => decision,
		settle: async decision => decision,
		...executor,
	};
	const journal = new Journal( db );
	const runner = new Runner( { gate, executor: _executor, catalog, journal, log, mission, registry, pollMs: 5, ...options } );
	return { runner, db, log, catalog, journal, gate, mission, executor: _executor };
}

const PATHS = {
	draft: [], confirmed: [ 'confirmed' ], planning: [ 'confirmed', 'planning' ], executing: [ 'confirmed', 'planning', 'executing' ],
	waiting: [ 'confirmed', 'planning', 'executing', 'waiting' ], judging: [ 'confirmed', 'planning', 'judging' ],
	closing: [ 'confirmed', 'planning', 'judging', 'closing' ],
};

// A node of the rig's runner, moved along table 16.1 into the given state.
export async function placed( r, state, { over = {}, hours = 48, parent = null } = {} ) {
	const _node = await r.runner.start( new Contract( spec( over, hours ), registry ), parent );
	_node.confirmed = _node.contract.hash;
	PATHS[ state ].forEach( to => _node.move( to ) );
	return _node;
}

// An open attempt of the node with these steps, as Runner._begin leaves it.
export function attempt( r, of, steps, { strategy = 'stress', tSignalH = null } = {} ) {
	const _attempt = r.journal.start( of, { id: strategy } );
	of.plan = {
		strategy, steps, next: 0, values: {}, open: true, attempt: _attempt, spentBefore: of.spent, startedAt: Date.now(), tSignalH,
		review: tSignalH && Date.now() + tSignalH * 3600000,
	};
	return of.plan;
}

// A provider that answers like the stub, except where a role is given a function of its own.
export function provider( roles = {}, answers = {} ) {
	const _stub = new StubProvider( { answers } );
	const asked = [];
	return {
		asked, stub: _stub,
		complete: ( request ) => {
			asked.push( request );
			return roles[ request.role ] ? roles[ request.role ]( request, _stub ) : _stub.complete( request );
		},
	};
}

export const never = () => new Promise( () => {} );
