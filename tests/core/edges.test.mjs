// The edges of the loop: what happens to running work when a lease, a deadline, a contradiction, an error or an abort
// cuts in. Each case is small; the whole goals run in the other files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office, app } from '../office.mjs';

const [ Cascade, Judgment, Closing, Execution ] = await app.use( [ 'Core.Loop.Cascade', 'Core.Loop.Judgment', 'Core.Loop.Closing', 'Core.Loop.Execution' ] );
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

test( 'A3, O8: when a lease runs out, the move\'s unused tokens are revoked; an operation the gate opened runs on and is followed', async () => {
	const _rows = { a: { status: 'awaiting_approval' }, b: { status: 'approved' }, c: { status: 'open' }, d: { status: 'executed' } };
	const _withdrawn = [];
	const _followed = [];
	const _runner = {
		gate: { delivery: async id => _rows[ id ], withdraw: async ( id ) => { _withdrawn.push( id ); return { status: 'not_sent' }; } },
		execution: { follow: ( node, id ) => _followed.push( id ) },
	};
	await new Cascade( _runner ).revoke( { deliveries: [ 'a', 'b', 'c', 'd' ] } );
	assert.deepEqual( _withdrawn, [ 'a', 'b' ] );
	assert.deepEqual( _followed, [ 'c' ] );
} );

test( 'Z6: deadline, budget and abort hold a node before a start token burns and before each move', async () => {
	const _o = await office( { edit: quick } );
	const _node = { contract: { deadline: new Date( Date.now() + 60000 ).toISOString(), budget: 10 }, spent: 0, reserved: 0 };
	assert.equal( _o.runner.due( _node ), false );
	assert.equal( _o.runner.due( { ..._node, stopping: { reason: 'abort' } } ), true );
	const _past = { ..._node.contract, deadline: new Date( Date.now() - 1 ).toISOString() };
	assert.equal( _o.runner.due( { ..._node, contract: _past } ), true );
	assert.equal( _o.runner.due( { ..._node, spent: 11 } ), true );
	_o.stop();
} );

test( 'U4, E5: a contradiction while an attempt is open ends the attempt (what it left open is taken back) and a person decides', async () => {
	const _calls = [];
	const _runner = { execution: { cancel: async ( node, because ) => _calls.push( [ 'cancel', because ] ), close: ( node, outcome, cause ) => _calls.push( [ 'close', outcome, cause ] ) } };
	const _walls = [];
	const _node = {
		plan: { open: true }, stopping: null, conflicts: () => [ { data: { about: 'R-1185' } } ], valid: () => [],
		contract: { check: () => [] }, hitWall: cause => _walls.push( cause ),
	};
	await new Judgment( _runner )._contested( _node );
	assert.deepEqual( _calls.map( item => item[ 0 ] ), [ 'cancel', 'close' ] );
	assert.deepEqual( _calls[ 1 ], [ 'close', 'wall', 'conflict' ] );
	assert.deepEqual( _walls, [ 'conflict' ] );
	const _quiet = { ..._node, conflicts: () => [] };
	_calls.length = 0;
	await new Judgment( _runner )._contested( _quiet );
	assert.deepEqual( _calls, [], 'without a contradiction the open attempt goes on' );
} );

test( '16.3: closing is bounded by Δ; what G6 still finds is named in the result', () => {
	const _check = { ok: false, problems: [ 'outside action dl-1 not in an end state' ] };
	assert.deepEqual( Closing.result( { stopping: { status: 'aborted', reason: 'by the client' }, unclear: [ 'dl-1' ] }, _check ), {
		status: 'aborted', reason: 'by the client', unclear: [ 'dl-1' ], problems: _check.problems,
	} );
	assert.deepEqual( Closing.result( {}, { ok: true, problems: [] } ), { status: 'fulfilled' } );
} );

test( '18.6: an error in the core is treated like a system gate: the node is aborted with everything below it, and a person is alarmed', async () => {
	const _o = await office( { edit: quick } );
	const _judge = _o.runner.judgment.judge.bind( _o.runner.judgment );
	_o.runner.judgment.judge = async ( node ) => {
		if ( !node.parent && node.walls.length ) { throw new Error( 'a broken judgment' ); }
		return _judge( node );
	};
	const _root = await _o.run();
	assert.equal( _root.result.status, 'failed' );
	assert.match( _root.result.reason, /a broken judgment/ );
	assert.ok( _o.events( _root, 'abort_received' ).length, 'the cascade ran before the node closed' );
	assert.ok( _o.events( _root, 'alarm' ).length );
	assert.ok( _o.events( _root, 'ticket_opened' ).some( ticket => ticket.kind === 'escalation' && ticket.reason === 'alarm' ), 'a person is told' );
	_o.stop();
	assert.ok( _root.children.every( child => child.state === 'closed' ) );
} );

test( '16.5: processes of their own belong to the node that started them; the abort reaches them', () => {
	const _case = { children: [], processes: [] };
	const _child = { children: [], processes: [] };
	const _root = { children: [ _child ], processes: [ _case ] };
	assert.deepEqual( Cascade.tree( _root ), [ _root, _child, _case ] );
} );

test( '16.1: a plan G2 refuses keeps the node in planning with the next strategy; it goes to judging only when none is eligible', async () => {
	const _raw = {
		id: 'read-raw', kind: 'hr-survey', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.99, tauH: 1 },
		steps: [
			{ move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' },
			{ move: 'report.draft', from: [ 'rows' ], as: 'report' },
			{ move: 'report.send', from: 'report', target: 'hr' },
		],
	};
	const _o = await office( { edit: ( mission ) => {
		quick( mission );
		mission.strategies.unshift( _raw );
	} } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	assert.equal( _root.tried[ 0 ].cause, 'plan_refused' );
	const _states = _o.events( _root, 'state_changed' ).map( item => `${item.from}>${item.to}` );
	assert.equal( _states[ _states.indexOf( 'confirmed>planning' ) + 1 ], 'planning>executing', 'the refused plan never went to judging' );
} );

test( 'L4: what a followed operation brings is credited to the attempt that started it, not to the one open when it arrives', () => {
	const _catalog = { moves: { 'payment.send': { action: 'payment', resolves: { item: 'invoiceId', outcome: 'paid' } } } };
	const _execution = new Execution( { catalog: _catalog } );
	const _node = { deliveryAttempt: { 'dl-1': 3 }, plan: { open: true, attempt: 7 } };
	const _facts = _execution.receipted( { id: 'dl-1', action: 'payment', target: 'bank', receipt: { id: 'r1' }, params: { invoiceId: 'R-1186' } }, _node );
	assert.deepEqual( _facts.map( fact => [ fact.kind, fact.attempt ] ), [ [ 'delivered', 3 ], [ 'item_resolved', 3 ] ] );
	assert.deepEqual( [ _facts[ 1 ].data.about, _facts[ 1 ].data.value ], [ 'R-1186', 'paid' ], 'E5: what it is about, and its value' );
} );

test( 'G-1c, Z6: a child that waits past its own deadline is aborted by its own timer, not only by the root\'s', async () => {
	const _o = await office( { edit: quick } );
	const _aborted = [];
	_o.runner.abort = async ( node, options ) => _aborted.push( options );
	const _events = [];
	const _child = {
		parent: { id: 'root' }, state: 'waiting', stopping: null, emit: ( kind, data ) => _events.push( [ kind, data.of ] ),
		contract: { criteria: [], deadline: new Date( Date.now() + 20 ).toISOString() },
	};
	const _timers = _o.runner._deadlines( _child );
	await new Promise( resolve => setTimeout( resolve, 60 ) );
	_timers.forEach( timer => clearTimeout( timer ) );
	assert.deepEqual( _events, [ [ 'deadline_reached', 'node' ] ] );
	assert.deepEqual( _aborted.map( item => item.status ), [ 'failed' ] );
	_o.stop();
} );
