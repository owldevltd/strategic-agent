// Stress tests of execution while a node waits (16.1 executing → waiting → judging, E4, chapter 19, E6, O8): moves
// that wait for a person or an answer, events that wake the node, the review (Wiedervorlage) of an open attempt, the
// cancellation of what the goal no longer needs, and operations the gate owns after their move ended.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { Execution, Supervisor, rig, placed, attempt, kinds, sleep, never } from './kit.mjs';

const EXE = 'core/loop/execution.js';
const OUT = { value: { n: 1 }, labels: [ 'own' ], cohort: null, facts: [] };

function deferred() {
	let resolve;
	const promise = new Promise( ( done ) => {
		resolve = done;
	} );
	return { promise, resolve };
}

async function executing( steps, { run = async () => OUT, tSignalH = null, ...options } = {} ) {
	const _rig = rig( { executor: { run, ...( options.executor || {} ) }, ...options } );
	const _node = await placed( _rig, 'executing' );
	attempt( _rig, _node, steps, { tSignalH } );
	return { ..._rig, node: _node, execution: _rig.runner.execution };
}

attack( EXE, 'a move that waits for a person puts only this node into "waiting" (16.1)', async () => {
	const _answer = deferred();
	const { execution, node } = await executing( [ { move: 'stress.human' } ], { run: () => _answer.promise } );
	const _running = execution.run( node );
	await sleep( 5 );
	assert.equal( node.state, 'waiting' );
	assert.deepEqual( node.blockedBy().waitingOn, 'stress.human' );
	_answer.resolve( OUT );
	await within( _running, 1000 );
} );

attack( EXE, 'the awaited answer moves the node to its judgment; the attempt stays open for the moves left (16.1)', async () => {
	const _answer = deferred();
	const _run = step => ( step.move === 'stress.human' ? _answer.promise : OUT );
	const { execution, node, log } = await executing( [ { move: 'stress.human', as: 'choice' }, { move: 'stress.code' } ], { run: _run } );
	const _running = execution.run( node );
	await sleep( 5 );
	_answer.resolve( { ...OUT, value: { choice: 'yes' } } );
	assert.equal( await within( _running, 1000 ), 'waited' );
	assert.equal( node.state, 'judging' );
	assert.equal( node.plan.open, true );
	assert.equal( node.plan.next, 1 );
	assert.deepEqual( node.plan.values.choice.value, { choice: 'yes' } );
	assert.equal( kinds( log, node, 'state_changed' ).at( -1 ).event, 'stress.human' );
} );

attack( EXE, 'an answer to the last move ends the attempt instead of waiting for another judgment', async () => {
	const _answer = deferred();
	const { execution, node } = await executing( [ { move: 'stress.human' } ], { run: () => _answer.promise } );
	const _running = execution.run( node );
	await sleep( 5 );
	_answer.resolve( OUT );
	await within( _running, 1000 );
	assert.equal( node.plan.open, false );
	assert.equal( node.state, 'judging' );
	assert.deepEqual( node.walls.map( wall => wall.cause ), [ 'not_reached' ] );
} );

attack( EXE, 'any event for a waiting node wakes it for a judgment; the move it waits for stays open (E4)', async () => {
	const { execution, node } = await executing( [ { move: 'stress.human' } ], { run: never } );
	const _running = execution.run( node );
	await sleep( 5 );
	node.wake( { kind: 'fact_queued' } );
	assert.equal( await within( _running, 1000 ), null );
	assert.equal( node.state, 'judging' );
	assert.ok( node.plan.pending, 'the open question to the person is still pending' );
	assert.equal( node.plan.open, true );
} );

attack( EXE, 'taken up again after the judgment, a pending move is followed, never started a second time', async () => {
	let _starts = 0;
	const _answer = deferred();
	const { execution, node, log } = await executing( [ { move: 'stress.human' } ], { run: () => {
		_starts++;
		return _answer.promise;
	} } );
	const _first = execution.run( node );
	await sleep( 5 );
	node.wake( { kind: 'fact_queued' } );
	await _first;
	node.move( 'planning' );
	node.move( 'executing' );
	const _second = execution.run( node );
	await sleep( 5 );
	_answer.resolve( OUT );
	await within( _second, 1000 );
	assert.equal( _starts, 1 );
	assert.equal( kinds( log, node, 'move_started' ).length, 1 );
} );

attack( EXE, 'an abort wakes a waiting node at once (Z6) and its next step closes it', async () => {
	const { execution, node, runner } = await executing( [ { move: 'stress.human' } ], { run: never } );
	const _running = execution.run( node );
	await sleep( 5 );
	await runner.abort( node, { reason: 'by the client', status: 'aborted' } );
	assert.equal( await within( _running, 1000 ), null );
	assert.ok( node.stopping );
} );

attack( EXE, 'the review is due t_signal after the start while the node waits for a person: a judgment, no new start (19)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.human' } ], { run: never, tSignalH: 0.00002 } );
	assert.equal( await within( execution.run( node ), 1000 ), null );
	assert.equal( node.plan.reviewDue, true );
	assert.equal( node.state, 'judging' );
	assert.equal( kinds( log, node, 'review_due' )[ 0 ].afterH, 0.00002 );
} );

attack( EXE, 'a review due in 25 days does not fire at once', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.human' } ], { run: never, tSignalH: 600 } );
	const _running = execution.run( node );
	await sleep( 30 );
	assert.deepEqual( kinds( log, node, 'review_due' ), [], 'nothing is due for 25 days' );
	node.wake( { kind: 'test_end' } );
	await within( _running, 1000 );
} );

attack( EXE, 'the review only applies while the node waits for a signal from outside, never to a running code move', async () => {
	const _done = deferred();
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ], { run: () => _done.promise, tSignalH: 0.00001 } );
	const _running = execution.run( node );
	await sleep( 40 );
	assert.deepEqual( kinds( log, node, 'review_due' ), [] );
	_done.resolve( OUT );
	await within( _running, 1000 );
} );

attack( EXE, 'a strategy without t_signal has no review: the node waits for its signal or its deadline', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.wait' } ], { run: never, tSignalH: null } );
	const _running = execution.run( node );
	await sleep( 30 );
	assert.deepEqual( kinds( log, node, 'review_due' ), [] );
	node.wake( { kind: 'test_end' } );
	await within( _running, 1000 );
} );

// --- the cancellation of what the goal no longer needs (E6) ---

attack( EXE, 'nothing pending, nothing to cancel', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	await execution.cancel( node, 'the goal is met' );
	assert.deepEqual( kinds( log, node, 'move_cancelled' ), [] );
} );

attack( EXE, 'a move that cannot be taken back is never cancelled; a closing node waits for it at most Δ (E6, 16.3)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ], { run: never } );
	node.plan.pending = { index: 0, began: Date.now(), promise: never() };
	const _started = Date.now();
	await within( execution.cancel( node, 'the goal is met', [], { withinMs: 50 } ), 1000 );
	assert.ok( Date.now() - _started < 500 );
	assert.deepEqual( kinds( log, node, 'move_outlasts_close' ), [ { move: 'stress.code', leaseBounds: true } ] );
	assert.ok( !node.facts.some( fact => fact.kind === 'cancelled' ) );
	assert.equal( node.plan.pending, null );
} );

attack( EXE, 'a move that cannot be taken back and ends in time is simply awaited', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.plan.pending = { index: 0, began: Date.now(), promise: sleep( 10 ).then( () => ( { out: OUT } ) ) };
	await execution.cancel( node, 'the goal is met', [], { withinMs: 500 } );
	assert.deepEqual( kinds( log, node, 'move_outlasts_close' ), [] );
} );

attack( EXE, 'a reversible move is cancelled by a move of its own, with what made it unnecessary as evidence (E6)', async () => {
	const _answer = deferred();
	const _board = { withdraw: () => {
		_answer.resolve( { out: OUT } );
		return [ { id: 'tk-1' } ];
	}, list: () => [] };
	const _stopped = [];
	const { execution, node, log } = await executing( [ { move: 'stress.human' } ], { board: _board, executor: { runtime: { stop: id => _stopped.push( id ) } } } );
	node.plan.pending = { index: 0, began: Date.now(), promise: _answer.promise };
	await execution.cancel( node, 'the goal is met', [ 'fact-1' ] );
	const _cancelled = node.facts.find( fact => fact.kind === 'cancelled' );
	assert.deepEqual( _cancelled.data, { move: 'stress.human', tickets: [ 'tk-1' ], because: 'the goal is met', evidence: [ 'fact-1' ] } );
	assert.deepEqual( kinds( log, node, 'move_started' ).at( -1 ), { move: 'move.cancel', of: 'stress.human', index: 0 } );
	assert.deepEqual( _stopped, [ node.id ] );
	assert.equal( kinds( log, node, 'cost_booked' ).at( -1 ).what, 'move.cancel' );
	assert.equal( node.plan.pending, null );
} );

attack( EXE, 'a reversible move that ignores its cancellation holds a closing node no longer than Δ allows', async () => {
	const { execution, node } = await executing( [ { move: 'stress.human' } ] );
	node.plan.pending = { index: 0, began: Date.now(), promise: never() };
	const _started = Date.now();
	await within( execution.cancel( node, 'the goal is met', [], { withinMs: 50 } ), 5000 );
	assert.ok( Date.now() - _started < 500, `the cancellation took ${Date.now() - _started} ms of a Δ of 50 ms` );
} );

attack( EXE, 'a cancellation is free and booked as its own move (E6, P5)', async () => {
	const _answer = deferred();
	const _board = { withdraw: () => {
		_answer.resolve( { out: OUT } );
		return [];
	}, list: () => [] };
	const { execution, node } = await executing( [ { move: 'stress.human' } ], { board: _board } );
	node.plan.pending = { index: 0, began: Date.now(), promise: _answer.promise };
	const _spent = node.spent;
	await execution.cancel( node );
	assert.equal( node.spent, _spent );
} );

// --- operations the gate owns after their move ended (O8) ---

attack( EXE, 'an operation that is executed later reaches the node as its receipt, credited to the attempt that started it (O8, L4)', async () => {
	const _rows = { 'dl-7': { id: 'dl-7', action: 'report', target: 'hr', receipt: { id: 'rc' }, params: {}, status: 'executed' } };
	const { execution, node, runner } = await executing( [ { move: 'stress.code' } ], {
		executor: { settle: async () => ( { delivery: 'dl-7', status: 'executed' } ) },
	} );
	Object.assign( runner.gate.deliveries, _rows );
	node.deliveryAttempt = { 'dl-7': 41 };
	execution.follow( node, 'dl-7' );
	await sleep( 10 );
	const _queued = node.inbox.find( fact => fact.kind === 'delivered' );
	assert.equal( _queued.attempt, 41 );
} );

attack( EXE, 'one operation is followed once, however often it is handed over', async () => {
	let _settles = 0;
	const { execution, node } = await executing( [ { move: 'stress.code' } ], {
		executor: { settle: () => {
			_settles++;
			return never();
		} },
	} );
	execution.follow( node, 'dl-8' );
	execution.follow( node, 'dl-8' );
	execution.follow( node, 'dl-8' );
	assert.equal( _settles, 1 );
} );

attack( EXE, 'an operation that ends unclear goes to a person as its own case (O5)', async () => {
	const _asked = [];
	const _board = { ask: async ( of, spec ) => _asked.push( spec ), withdraw: () => [], list: () => [] };
	const { execution, node } = await executing( [ { move: 'stress.code' } ], {
		board: _board, executor: { settle: async () => ( { delivery: 'dl-9', status: 'unclear' } ) },
	} );
	execution.follow( node, 'dl-9' );
	await sleep( 10 );
	assert.deepEqual( node.unclear, [ 'dl-9' ] );
	assert.equal( _asked[ 0 ].kind, 'check' );
} );

attack( EXE, 'following stops once the node is closed (Z5)', async () => {
	let _stop = null;
	const { execution, node } = await executing( [ { move: 'stress.code' } ], {
		executor: { settle: ( decision, { stop } ) => {
			_stop = stop;
			return never();
		} },
	} );
	execution.follow( node, 'dl-10' );
	assert.equal( _stop(), false );
	node.state = 'closed';
	assert.equal( _stop(), true );
} );

attack( EXE, 'an executed operation of a move that settles nothing leaves only its receipt', () => {
	const _execution = new Execution( { catalog: { moves: { 'report.send': { action: 'report' } } } } );
	const _facts = _execution.receipted( { id: 'dl-1', action: 'report', target: 'hr', receipt: {}, params: {} }, {} );
	assert.deepEqual( _facts.map( fact => fact.kind ), [ 'delivered' ] );
	assert.equal( _facts[ 0 ].attempt, null );
} );

// --- what a fact from execution may carry (G3) ---

attacks( EXE, hostile( 'strings' ).filter( ( _item, i ) => [ 0, 3, 11, 16, 20, 24, 30, 33 ].includes( i ) ).map( item => ( {
	...item, name: `a hostile value ${item.label} in a fact is reduced to its key unless it is a plain id`,
} ) ), ( item ) => {
	const _plain = Execution.plain( { field: item.value } );
	assert.ok( _plain.field === 'field' || /^[A-Za-z0-9_.:-]{1,64}$/.test( _plain.field ), JSON.stringify( _plain.field ).slice( 0, 80 ) );
} );

attack( EXE, 'numbers, booleans, null and lists of ids pass G3 as they are', () => {
	const _data = { n: 3, ok: true, none: null, ids: [ 'r01', 'r02' ], ref: 'FU-1A2B' };
	assert.deepEqual( Execution.plain( _data ), _data );
} );

attack( EXE, 'a nested object or a list with text is reduced to its key', () => {
	assert.deepEqual( Execution.plain( { nested: { a: 1 }, list: [ 'ok', 'not ok' ] } ), { nested: 'nested', list: 'list' } );
} );

attack( EXE, 'facts without data pass G3 as an empty record', () => {
	assert.deepEqual( Execution.plain( undefined ), {} );
	assert.deepEqual( Execution.plain( null ), {} );
} );

// --- a move under a real lease ---

attack( EXE, 'a move that outlasts its lease mid-plan ends the attempt; its late value is never written (A3, A4)', async () => {
	const _gate = {
		lease: async request => ( { id: 'ls-1', fence: 1, maxUntil: new Date( Date.now() + request.minutes * 60000 ).toISOString() } ),
		beat: async () => ( { ok: true } ), release: async () => {}, delivery: async () => null, withdraw: async () => ( {} ),
	};
	const _supervisor = new Supervisor( { gate: _gate, beatMs: 15000 } );
	const _slow = { 'stress.slow': { executor: 'code', price: 0.05, reversible: false, leaseMaxMin: 0.001 } };
	const _run = async () => {
		await sleep( 200 );
		return { ...OUT, value: 'too late' };
	};
	const { execution, node, log } = await executing( [ { move: 'stress.slow', as: 'result' }, { move: 'stress.code' } ], {
		run: _run, supervisor: _supervisor, moves: _slow, gate: _gate,
	} );
	await within( execution.run( node ), 2000 );
	assert.equal( node.walls[ 0 ].cause, 'lease_expired' );
	assert.equal( node.plan.values.result, undefined );
	assert.equal( kinds( log, node, 'move_started' ).length, 1, 'no further move starts after the expired one' );
} );
