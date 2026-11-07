// Stress tests of the supervisor of running moves (18.6, A1–A7): every move but a child runs under a lease from the
// gate, renewed by heartbeat; when the lease runs out the move is ended, its sandbox stopped, and whatever it still
// returns is fenced off. Attacks: expiry mid-move, refused and lost heartbeats, stale fencing tokens, hostile lease
// lengths and deadlines, a gate that fails.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { Supervisor, Leases, Db, Node, Contract, registry, office, spec, node, kinds, memoryLog, sleep, never } from './kit.mjs';

const SUP = 'core/lease/supervisor.js';
const CODE = { executor: 'code' };
const STEP = { move: 'stress.code' };

// The gate's real lease book behind the interface the core uses; limit plays the root deadline plus Δ (A7).
function leaseGate( { limit = null, beat = null } = {} ) {
	const leases = new Leases( new Db( ':memory:' ) );
	const calls = [];
	return {
		leases, calls,
		lease: async ( request ) => {
			calls.push( [ 'lease', request ] );
			return leases.grant( { ...request, limit } );
		},
		beat: beat || ( async ( id, fence ) => {
			calls.push( [ 'beat', id, fence ] );
			return leases.beat( id, fence );
		} ),
		// A4: the gate ends a lease only with its fencing token.
		release: async ( id, fence ) => {
			calls.push( [ 'release', id ] );
			return leases.release( id, fence );
		},
	};
}

// A supervisor over that gate, a sandbox runtime that records what it stopped, and a node with a log.
function supervised( { beatMs = 15000, hours = 48, gate = leaseGate(), log = memoryLog() } = {} ) {
	const stopped = [];
	const supervisor = new Supervisor( { gate, runtime: { stop: id => stopped.push( id ) }, beatMs } );
	return { supervisor, gate, stopped, log, node: node( { hours, log } ) };
}

const requested = gate => gate.calls.filter( call => call[ 0 ] === 'lease' ).map( call => call[ 1 ] );

attack( SUP, 'a child holds no lease: it is a node of its own with its own deadline', async () => {
	const { supervisor, gate, node: _node } = supervised();
	const _out = await supervisor.hold( _node, { move: 'invoice.child' }, { executor: 'child' }, async lease => ( { lease } ) );
	assert.deepEqual( _out, { lease: null } );
	assert.equal( gate.calls.length, 0 );
} );

attacks( SUP, [
	{ name: 'a code move asks for a lease of 2 minutes (A1)', move: { executor: 'code' }, minutes: 2 },
	{ name: 'a model move asks for a lease of 3 minutes (A1)', move: { executor: 'ai' }, minutes: 3 },
	{ name: 'an outside action asks for a lease of 5 minutes (A1)', move: { executor: 'code', action: 'report' }, minutes: 5 },
	{ name: 'the catalog\'s maximum overrides the default of the kind', move: { executor: 'ai', leaseMaxMin: 1.5 }, minutes: 1.5 },
	{ name: 'a lease maximum of null falls back to the default of the kind', move: { executor: 'code', leaseMaxMin: null }, minutes: 2 },
], async ( item ) => {
	const { supervisor, gate, node: _node } = supervised();
	await supervisor.hold( _node, STEP, item.move, async () => 'done' );
	assert.equal( requested( gate )[ 0 ].minutes, item.minutes );
} );

attack( SUP, 'a person\'s move is leased until the node\'s deadline: a person is no worker with a fixed length', async () => {
	const { supervisor, gate, node: _node } = supervised( { hours: 2 } );
	await supervisor.hold( _node, STEP, { executor: 'human' }, async () => 'answered' );
	assert.ok( Math.abs( requested( gate )[ 0 ].minutes - 120 ) < 0.1, `${requested( gate )[ 0 ].minutes} minutes` );
} );

attack( SUP, 'a person\'s move on a node past its deadline still gets a minimal lease, never a negative one', async () => {
	const { supervisor, gate, node: _node } = supervised( { hours: -1 } );
	await supervisor.hold( _node, STEP, { executor: 'human' }, async () => 'late' );
	assert.equal( requested( gate )[ 0 ].minutes, 0.01 );
} );

attack( SUP, 'a heartbeat renews four beats ahead, never beyond the lease itself', async () => {
	const { supervisor, gate, node: _node } = supervised( { beatMs: 15000 } );
	await supervisor.hold( _node, STEP, CODE, async () => 1 );
	await supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.5 }, async () => 1 );
	assert.deepEqual( requested( gate ).map( item => item.beatMinutes ), [ 1, 0.5 ] );
} );

attack( SUP, 'the lease request names the holder node, the move and the contract it serves', async () => {
	const { supervisor, gate, node: _node } = supervised();
	await supervisor.hold( _node, { move: 'analysis.run' }, CODE, async () => 1 );
	const [ _request ] = requested( gate );
	assert.deepEqual( [ _request.node, _request.move, _request.contract ], [ _node.id, 'analysis.run', _node.contract.hash ] );
} );

attack( SUP, 'a holder other than the node can be named for the lease', async () => {
	const { supervisor, gate, node: _node } = supervised();
	await supervisor.hold( _node, STEP, CODE, async () => 1, { holder: 'worker-7' } );
	assert.equal( requested( gate )[ 0 ].node, 'worker-7' );
} );

attack( SUP, 'the move gets the lease\'s id and fencing token to present at the gate', async () => {
	const { supervisor, node: _node } = supervised();
	const _lease = await supervisor.hold( _node, STEP, CODE, async lease => lease );
	assert.match( _lease.id, /^ls-/ );
	assert.equal( _lease.fence, 1 );
} );

attack( SUP, 'a move that ends in time returns its result and releases its lease once', async () => {
	const { supervisor, gate, node: _node } = supervised();
	assert.equal( await supervisor.hold( _node, STEP, CODE, async () => 'result' ), 'result' );
	await sleep( 5 );
	assert.equal( gate.calls.filter( call => call[ 0 ] === 'release' ).length, 1 );
	assert.equal( gate.leases.valid( requested( gate )[ 0 ].id, 1 ), null );
} );

attack( SUP, 'a move that throws passes its error on and still releases its lease', async () => {
	const { supervisor, gate, node: _node } = supervised();
	await assert.rejects( supervisor.hold( _node, STEP, CODE, async () => {
		throw new Error( 'the sandbox crashed' );
	} ), /the sandbox crashed/ );
	await sleep( 5 );
	assert.equal( gate.calls.filter( call => call[ 0 ] === 'release' ).length, 1 );
} );

attack( SUP, 'a move that outlasts its lease is ended: it counts as aborted, its sandbox is stopped (A3)', async () => {
	const { supervisor, stopped, log, node: _node } = supervised();
	const _out = await within( supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.001 }, never ), 2000 );
	assert.deepEqual( _out, { leaseExpired: true } );
	assert.deepEqual( stopped, [ _node.id ] );
	const [ _event ] = kinds( log, _node, 'lease_expired' );
	assert.equal( _event.why, 'maximum reached' );
} );

attack( SUP, 'what a move returns after its lease ran out is fenced off and never written (A4)', async () => {
	const { supervisor, node: _node } = supervised();
	const _late = async () => {
		await sleep( 150 );
		return { value: 'written too late' };
	};
	assert.deepEqual( await supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.001 }, _late ), { leaseExpired: true } );
} );

attack( SUP, 'a heartbeat the gate refuses ends the move at once', async () => {
	const _gate = leaseGate( { beat: async () => ( { ok: false } ) } );
	const { supervisor, log, node: _node } = supervised( { beatMs: 10, gate: _gate } );
	assert.deepEqual( await within( supervisor.hold( _node, STEP, CODE, never ), 2000 ), { leaseExpired: true } );
	assert.equal( kinds( log, _node, 'lease_expired' )[ 0 ].why, 'heartbeat refused' );
} );

attack( SUP, 'a gate that cannot be reached at the heartbeat ends the move: in doubt closed (A8)', async () => {
	const _gate = leaseGate( { beat: async () => {
		throw new Error( 'ECONNREFUSED' );
	} } );
	const { supervisor, log, node: _node } = supervised( { beatMs: 10, gate: _gate } );
	assert.deepEqual( await within( supervisor.hold( _node, STEP, CODE, never ), 2000 ), { leaseExpired: true } );
	assert.equal( kinds( log, _node, 'lease_expired' )[ 0 ].why, 'gate unreachable' );
} );

attack( SUP, 'heartbeats keep the gate\'s lease valid long past one beat interval (A1)', async () => {
	const { supervisor, gate, node: _node } = supervised( { beatMs: 10 } );
	const _valid = await supervisor.hold( _node, STEP, CODE, async ( lease ) => {
		await sleep( 200 );
		return gate.leases.valid( lease.id, lease.fence ) !== null;
	} );
	assert.equal( _valid, true, 'four beats are 40 ms; the move ran 200 ms on a renewed lease' );
} );

attack( SUP, 'a heartbeat that never comes back lets the gate expire the lease by itself (A4)', async () => {
	const _gate = leaseGate( { beat: never } );
	const { supervisor, node: _node } = supervised( { beatMs: 10, gate: _gate } );
	const _seen = await supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.004 }, async ( lease ) => {
		await sleep( 120 );
		return _gate.leases.valid( lease.id, lease.fence );
	} );
	assert.ok( _seen === null || _seen.leaseExpired, 'without heartbeats the gate holds no valid lease after four beats' );
} );

attack( SUP, 'a second lease for the same node supersedes the first: the old token is stale and its move ends (A6)', async () => {
	const { supervisor, gate, node: _node } = supervised( { beatMs: 10 } );
	const _first = supervisor.hold( _node, STEP, CODE, never );
	await sleep( 5 );
	const _second = supervisor.hold( _node, STEP, CODE, async ( lease ) => {
		await sleep( 60 );
		return lease;
	} );
	assert.deepEqual( await within( _first, 2000 ), { leaseExpired: true } );
	const _lease = await _second;
	assert.equal( _lease.fence, 2 );
	const _old = requested( gate ).length && gate.leases.db.get( 'SELECT * FROM leases WHERE fence = 1' );
	assert.equal( gate.leases.valid( _old.id, 1 ), null, 'the stale token is refused at the gate' );
} );

attack( SUP, 'leases of different nodes never supersede each other', async () => {
	const _gate = leaseGate();
	const _one = supervised( { gate: _gate } );
	const _two = supervised( { gate: _gate } );
	const [ _a, _b ] = await Promise.all( [
		_one.supervisor.hold( _one.node, STEP, CODE, async lease => lease ),
		_two.supervisor.hold( _two.node, STEP, CODE, async lease => lease ),
	] );
	assert.deepEqual( [ _a.fence, _b.fence ], [ 1, 1 ] );
} );

attack( SUP, 'twenty nodes at once each hold their own lease and release it', async () => {
	const _gate = leaseGate();
	const _runs = Array.from( { length: 20 }, () => supervised( { gate: _gate } ) );
	const _out = await Promise.all( _runs.map( item => item.supervisor.hold( item.node, STEP, CODE, async lease => lease.fence ) ) );
	assert.deepEqual( _out, Array( 20 ).fill( 1 ) );
	await sleep( 5 );
	assert.equal( _gate.leases.db.get( 'SELECT COUNT(*) AS n FROM leases WHERE status = \'active\'' ).n, 0 );
} );

attack( SUP, 'five moves of one node started in turn: only the newest keeps running, the others are fenced off', async () => {
	const { supervisor, node: _node } = supervised( { beatMs: 10 } );
	const _holds = [];
	for ( let i = 0; i < 5; i++ ) {
		_holds.push( supervisor.hold( _node, STEP, CODE, async () => {
			await sleep( 100 );
			return `move ${i}`;
		} ) );
		await sleep( 3 );
	}
	const _out = await within( Promise.all( _holds ), 3000 );
	assert.deepEqual( _out.slice( 0, 4 ), Array( 4 ).fill( { leaseExpired: true } ) );
	assert.equal( _out[ 4 ], 'move 4' );
} );

attack( SUP, 'a gate that refuses the lease stops the move before it starts', async () => {
	const _gate = { ...leaseGate(), lease: async () => {
		throw new Error( 'gate: 503' );
	} };
	const { supervisor, node: _node } = supervised( { gate: _gate } );
	let _ran = false;
	await assert.rejects( supervisor.hold( _node, STEP, CODE, async () => {
		_ran = true;
	} ), /503/ );
	assert.equal( _ran, false );
} );

attacks( SUP, [
	{ name: 'a lease with an unreadable end is treated as already over', maxUntil: 'not a date' },
	{ name: 'a lease that ended before it was handed out is treated as over', maxUntil: '2000-01-01T00:00:00Z' },
], async ( item ) => {
	const _gate = { ...leaseGate(), lease: async () => ( { id: 'ls-x', fence: 1, maxUntil: item.maxUntil } ) };
	const { supervisor, node: _node } = supervised( { gate: _gate } );
	assert.deepEqual( await within( supervisor.hold( _node, STEP, CODE, never ), 1000 ), { leaseExpired: true } );
} );

attack( SUP, 'a release the gate refuses never turns a finished move into a failure', async () => {
	const _gate = { ...leaseGate(), release: async () => {
		throw new Error( 'gate gone' );
	} };
	const { supervisor, node: _node } = supervised( { gate: _gate } );
	assert.equal( await supervisor.hold( _node, STEP, CODE, async () => 'kept' ), 'kept' );
	await sleep( 5 );
} );

attack( SUP, 'no heartbeat is sent after the move ended', async () => {
	const { supervisor, gate, node: _node } = supervised( { beatMs: 5 } );
	await supervisor.hold( _node, STEP, CODE, async () => {
		await sleep( 30 );
	} );
	const _beats = gate.calls.filter( call => call[ 0 ] === 'beat' ).length;
	await sleep( 40 );
	assert.equal( gate.calls.filter( call => call[ 0 ] === 'beat' ).length, _beats );
} );

attack( SUP, 'a move that ended in time never reports an expired lease later', async () => {
	const { supervisor, log, stopped, node: _node } = supervised();
	await supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.001 }, async () => 'quick' );
	await sleep( 100 );
	assert.deepEqual( kinds( log, _node, 'lease_expired' ), [] );
	assert.deepEqual( stopped, [] );
} );

attack( SUP, 'a lease that both expires and loses its heartbeat is ended once, with one event', async () => {
	const _gate = leaseGate( { beat: async () => ( { ok: false } ) } );
	const { supervisor, log, stopped, node: _node } = supervised( { beatMs: 1, gate: _gate } );
	await supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 0.0001 }, never );
	await sleep( 30 );
	assert.equal( kinds( log, _node, 'lease_expired' ).length, 1 );
	assert.equal( stopped.length, 1 );
} );

attack( SUP, 'without a sandbox runtime an expired lease still ends the move', async () => {
	const _supervisor = new Supervisor( { gate: leaseGate(), beatMs: 15000 } );
	const _out = await within( _supervisor.hold( node(), STEP, { executor: 'code', leaseMaxMin: 0.001 }, never ), 1000 );
	assert.deepEqual( _out, { leaseExpired: true } );
} );

attack( SUP, 'a move that returns nothing is not mistaken for an expired lease', async () => {
	const { supervisor, node: _node } = supervised();
	assert.equal( await supervisor.hold( _node, STEP, CODE, async () => undefined ), undefined );
} );

attack( SUP, 'a move without a catalog entry is leased for the node\'s remaining time, never without a lease', async () => {
	const { supervisor, gate, node: _node } = supervised( { hours: 1 } );
	await supervisor.hold( _node, STEP, null, async () => 1 );
	assert.ok( requested( gate )[ 0 ].minutes > 59 && requested( gate )[ 0 ].minutes <= 60 );
} );

attack( SUP, 'heartbeats present the lease\'s own id and fencing token', async () => {
	const { supervisor, gate, node: _node } = supervised( { beatMs: 5 } );
	const _lease = await supervisor.hold( _node, STEP, CODE, async ( lease ) => {
		await sleep( 30 );
		return lease;
	} );
	const _beats = gate.calls.filter( call => call[ 0 ] === 'beat' );
	assert.ok( _beats.length >= 2 );
	assert.ok( _beats.every( call => call[ 1 ] === _lease.id && call[ 2 ] === _lease.fence ) );
} );

// --- hostile lease lengths from the catalog ---

attacks( SUP, [
	{ name: 'a lease maximum of 0 minutes ends the move at once', max: 0, expect: 'expired' },
	{ name: 'a negative lease maximum ends the move at once', max: -1, expect: 'expired' },
	{ name: 'a NaN lease maximum is refused before the move starts', max: NaN, expect: 'refused' },
	{ name: 'a non-numeric lease maximum is refused before the move starts', max: 'abc', expect: 'refused' },
	{ name: 'a lease maximum written as a string of 0.002 minutes still ends a longer move', max: '0.002', expect: 'expired' },
	{ name: 'an infinite lease maximum is cut at the root deadline plus the buffer (A7)', max: Infinity, expect: 'bounded' },
	{ name: 'a lease maximum of 1e308 minutes is cut at the root deadline plus the buffer (A7)', max: 1e308, expect: 'bounded' },
], async ( item ) => {
	const _limit = new Date( Date.now() + 3600000 ).toISOString();
	const _gate = leaseGate( { limit: _limit } );
	const { supervisor, node: _node } = supervised( { gate: _gate } );
	let _ran = false;
	const _work = async ( lease ) => {
		_ran = true;
		await sleep( 200 );
		return lease;
	};
	const _held = supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: item.max }, _work );
	if ( item.expect === 'refused' ) {
		await assert.rejects( _held );
		assert.equal( _ran, false );
		return;
	}
	const _out = await within( _held, 2000 );
	if ( item.expect === 'expired' ) {
		assert.deepEqual( _out, { leaseExpired: true } );
		return;
	}
	const _row = _gate.leases.db.get( 'SELECT maxUntil FROM leases WHERE id = :id', { id: _out.id } );
	assert.ok( Date.parse( _row.maxUntil ) <= Date.parse( _limit ) );
} );

// --- hostile deadlines of the node a person's move belongs to ---

attacks( SUP, hostile( 'dates' ).map( item => ( { ...item, name: `a person's move on a node due ${item.label} never runs without a valid lease` } ) ),
	async ( item ) => {
		const _gate = leaseGate();
		const { supervisor } = supervised( { gate: _gate } );
		const _node = node();
		_node.contract.deadline = item.value;
		let _valid = null;
		const _held = supervisor.hold( _node, STEP, { executor: 'human' }, async ( lease ) => {
			_valid = _gate.leases.valid( lease.id, lease.fence ) !== null;
			return 'asked';
		} );
		try {
			await within( _held, 2000 );
		} catch ( error ) {
			assert.equal( _valid, null, `the move ran although the lease failed: ${error.message}` );
			return;
		}
		assert.equal( _valid, true, 'the move started on a lease the gate does not hold valid' );
	} );

// --- leases longer than a timer can count ---

attack( SUP, 'a lease of 40 days is not ended after 24.8 days, when a timer can count no further', async () => {
	mock.timers.enable( { apis: [ 'setTimeout', 'setInterval', 'Date' ], now: Date.parse( '2026-11-04T10:00:00Z' ) } );
	try {
		const _gate = {
			lease: async request => ( { id: 'ls-long', fence: 1, maxUntil: new Date( Date.now() + request.minutes * 60000 ).toISOString() } ),
			beat: async () => ( { ok: true } ), release: async () => {},
		};
		const _supervisor = new Supervisor( { gate: _gate, beatMs: 1e9 } );
		let _out = null;
		_supervisor.hold( node( { hours: 24 * 40 } ), STEP, { executor: 'human' }, never ).then( ( result ) => {
			_out = result;
		} );
		await new Promise( resolve => setImmediate( resolve ) );
		mock.timers.tick( 2 ** 31 );
		await new Promise( resolve => setImmediate( resolve ) );
		assert.equal( _out, null, 'the lease still runs for 15 more days' );
	} finally {
		mock.timers.reset();
	}
} );

// --- through the real gate ---

async function confirmedAtGate() {
	const _office = await office();
	const _contract = new Contract( spec( {}, 2 ), registry );
	await _office.system.gate.propose( _contract );
	_office.egress.confirm( _contract.hash, 'test-person' );
	_office.stop();
	return { office: _office, node: new Node( { contract: _contract, log: memoryLog() } ) };
}

attack( SUP, 'the real gate cuts any lease at the root deadline plus the buffer, however long the catalog allows (A7)', async () => {
	const { office: _office, node: _node } = await confirmedAtGate();
	const _supervisor = new Supervisor( { gate: _office.system.gate, beatMs: 15000 } );
	const _lease = await _supervisor.hold( _node, STEP, { executor: 'code', leaseMaxMin: 1e6 }, async lease => lease );
	const _row = _office.egress.leases.db.get( 'SELECT maxUntil FROM leases WHERE id = :id', { id: _lease.id } );
	assert.ok( Date.parse( _row.maxUntil ) <= Date.parse( _node.contract.deadline ) + 5 * 60000 );
} );

attack( SUP, 'a worker that wakes up with a superseded lease cannot start an outside action at the real gate (A4, A6)', async () => {
	const { office: _office, node: _node } = await confirmedAtGate();
	const _supervisor = new Supervisor( { gate: _office.system.gate, beatMs: 10 } );
	let _stale = null;
	const _first = _supervisor.hold( _node, { move: 'report.send' }, { executor: 'code', action: 'report' }, async ( lease ) => {
		_stale = lease;
		await sleep( 80 );
		return lease;
	} );
	await sleep( 5 );
	await _supervisor.hold( _node, { move: 'report.send' }, { executor: 'code', action: 'report' }, async () => 'newer' );
	await _first;
	const _request = {
		contract: _node.contract.hash, node: _node.id, action: 'report', target: 'hr', params: { body: 'late' }, labels: { body: [ 'own' ] },
		cohort: [ 'r01', 'r02', 'r03', 'r04', 'r05', 'r06' ], lease: _stale.id, fence: _stale.fence,
	};
	const _decision = await _office.system.gate.submit( _request );
	assert.equal( _decision.status, 'refused' );
	assert.deepEqual( _decision.reasons.map( item => item.rule ), [ 'lease' ] );
} );
