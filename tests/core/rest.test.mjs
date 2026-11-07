import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, registry, Contract, Mission } from '../office.mjs';

const [ WaitGraph, Node, Judge, Calibration, Board, Db, EventLog, Egress ] = await use(
	'Core.Loop.WaitGraph', 'Core.Node.Node', 'Core.Loop.Judge', 'Core.Ai.Calibration', 'Core.Ticket.Board', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress',
);
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
const node = () => new Node( { contract: new Contract( Mission.load( 'survey' ).contractSpec(), registry ) } );

test( 'R4: a node that would wait for a node that waits for it is refused', () => {
	const _graph = new WaitGraph();
	_graph.add( 'a', 'b' );
	_graph.add( 'b', 'c' );
	assert.equal( _graph.wouldClose( 'c', 'a' ), true );
	assert.throws( () => _graph.add( 'c', 'a' ), /cycle/ );
	_graph.remove( 'b', 'c' );
	assert.equal( _graph.wouldClose( 'c', 'a' ), false );
} );

test( 'R4 at G2: a plan that waits for its own parent never runs', async () => {
	const _o = await office( { edit: quick } );
	const _root = await _o.runner.start( new Contract( _o.mission.contractSpec(), registry ) );
	const [ PlanCheck ] = await use( 'Core.Check.PlanCheck' );
	_o.runner.waits.add( _root.id, 'child-1' );
	const _plan = { strategy: 'x', steps: [ { move: 'followup.wait', params: { node: _root.id } } ] };
	const _check = new PlanCheck().check( _plan, { catalog: _o.catalog, contract: _root.contract, waits: { graph: _o.runner.waits, node: 'child-1' } } );
	assert.equal( _check.ok, false );
	assert.match( _check.problems.join(), /would close a cycle in the wait graph \(R4\)/ );
} );

test( 'E5: the younger fact of the same origin counts; facts of different origins that disagree are a conflict a person decides', () => {
	const _node = node();
	_node.addFact( { kind: 'date_agreed', evidenceClass: 'claim', source: 'mail 1', origin: 'supplier', data: { about: 'meeting', value: 'Tue' } } );
	_node.addFact( { kind: 'date_agreed', evidenceClass: 'claim', source: 'mail 2', origin: 'supplier', data: { about: 'meeting', value: 'Wed' } } );
	assert.deepEqual( _node.valid().filter( fact => fact.kind === 'date_agreed' ).map( fact => fact.data.value ), [ 'Wed' ] );
	assert.equal( _node.conflicts().length, 0 );
	_node.addFact( { kind: 'date_agreed', evidenceClass: 'claim', source: 'call', origin: 'assistant', data: { about: 'meeting', value: 'Thu' } } );
	assert.equal( _node.conflicts().length, 1 );
	assert.equal( new Judge( { registry } ).decide( _node, { verdict: 'done' }, [] ).verdict, 'escalate' );
} );

test( 'E4, E6: a late fact wakes the node; its judgment takes back the open question, as a move of its own with evidence', async () => {
	const _ask = [ {
		id: 'ask-hr', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.9, tauH: 1 },
		steps: [ { move: 'person.decide', params: { question: 'Was the report delivered?', options: [ 'yes', 'no' ] } } ],
	} ];
	const _o = await office( { strategies: _ask, person: () => null } );
	const _run = _o.run();
	const _root = await new Promise( ( resolve ) => {
		const _timer = setInterval( () => {
			const _waiting = [ ..._o.runner.nodes.values() ].find( item => item.waitingOn );
			if ( _waiting ) { clearInterval( _timer ); resolve( _waiting ); }
		}, 5 );
	} );
	_o.runner.deliver( _root, { kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { action: 'report', to: 'hr' } } );
	await _run;
	assert.equal( _root.result.status, 'fulfilled' );
	const _proof = _root.facts.find( fact => fact.kind === 'delivered' );
	const _cancelled = _root.facts.find( fact => fact.kind === 'cancelled' );
	assert.equal( _cancelled.data.move, 'person.decide' );
	assert.equal( _cancelled.data.tickets.length, 1, 'what was withdrawn is part of the evidence' );
	assert.ok( _cancelled.data.evidence.includes( _proof.id ), 'and the fact that made it unnecessary' );
	assert.ok( _o.events( _root, 'move_started' ).some( data => data.move === 'move.cancel' && data.of === 'person.decide' ) );
	const _states = _o.events( _root, 'state_changed' ).map( data => `${data.from}>${data.to}` );
	assert.ok( _states.includes( 'waiting>judging' ) && _states.indexOf( 'judging>closing' ) > _states.indexOf( 'waiting>judging' ), 'the judgment decides, not the arrival' );
} );

test( 'B7: a sample of model answers goes to a person; above five percent errors every answer of that step is checked', async () => {
	const _db = new Db( ':memory:' );
	const _board = new Board( new EventLog( _db, 'core' ) );
	let _verdict = 'wrong';
	setInterval( () => _board.list().forEach( ticket => _board.answer( ticket.id, { choice: _verdict, by: 'reviewer' } ) ), 2 ).unref();
	const _calibration = new Calibration( { board: _board, every: 2, minimum: 2 } );
	for ( let i = 0; i < 4; i++ ) {
		await _calibration.review( 'extractor', { text: 'x' }, { workload: 2 } );
		await new Promise( resolve => setTimeout( resolve, 10 ) );
	}
	assert.equal( _calibration.strict( 'extractor' ), true );
	await assert.rejects( _calibration.review( 'extractor', {}, {} ), /a person rejected/ );
	_verdict = 'right';
	await _calibration.review( 'extractor', {}, {} );
} );

test( 'B7: a check has a deadline; in the strict mode an answer nobody checked in time is not used', async () => {
	const _clock = { now: Date.now() };
	const _board = new Board( new EventLog( new Db( ':memory:' ), 'core' ), { now: () => _clock.now, sweepMs: 2 } );
	const _calibration = new Calibration( { board: _board, every: 1, minimum: 1, validMinutes: 5, now: () => _clock.now } );
	_calibration.stats.set( 'extractor', { seen: 1, checked: 1, wrong: 1 } );
	const _pending = _calibration.review( 'extractor', {}, {} );
	await new Promise( resolve => setTimeout( resolve, 10 ) );
	const [ _ticket ] = _board.list();
	assert.equal( Date.parse( _ticket.deadline ), _clock.now + 5 * 60000 );
	_clock.now += 6 * 60000;
	await assert.rejects( _pending, /nobody checked the extractor answer in time/ );
	clearInterval( _board._sweep );
} );

test( 'O7: an idempotent channel is tried again with the same key until it confirms; a plain channel gets one attempt (G-7a)', async () => {
	class Flaky {
		static IDEMPOTENT = true;
		constructor() { this.calls = 0; }
		async send() { this.calls++; return this.calls < 3 ? { ok: false, error: 'timeout' } : { ok: true, receipt: { id: 'm1' } }; }
	}
	class Plain extends Flaky {
		static IDEMPOTENT = false;
	}
	const _setup = async ( Channel ) => {
		const _db = new Db( ':memory:' );
		const _channel = new Channel();
		const _egress = new Egress( { db: _db, log: new EventLog( _db, 'gate' ), channels: { default: _channel }, retryMs: 5 } );
		const _spec = { id: 's', goal: 'g', deadline: new Date( Date.now() + 3600000 ).toISOString(), criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 't' } } ] };
		const _contract = new Contract( _spec, registry );
		_egress.propose( _contract.canonical(), _contract.rules(), _contract.hash );
		_egress.confirm( _contract.hash, 'lead' );
		const _lease = _egress.lease( { node: 'n', move: 'report.send', contract: _contract.hash, minutes: 5 } );
		const _waiting = await _egress.submit( { contract: _contract.hash, action: 'report', target: 'hr', params: { body: 'hi' }, labels: {}, lease: _lease.id, fence: _lease.fence } );
		await _egress.decide( _waiting.approval, 'approve', 'lead' );
		const _worker = _egress.lease( { node: 'n', move: 'report.send', contract: _contract.hash, minutes: 5 } );
		await _egress.redeem( { delivery: _waiting.delivery, approval: _waiting.approval, lease: _worker.id, fence: _worker.fence } );
		await new Promise( resolve => setTimeout( resolve, 100 ) );
		return { egress: _egress, delivery: _waiting.delivery, channel: _channel, db: _db };
	};
	const _flaky = await _setup( Flaky );
	assert.equal( _flaky.egress.store.delivery( _flaky.delivery ).status, 'executed' );
	assert.equal( _flaky.db.get( 'SELECT COUNT(*) AS n FROM attempts' ).n, 3 );
	const _plain = await _setup( Plain );
	assert.equal( _plain.egress.store.delivery( _plain.delivery ).status, 'unclear' );
	assert.equal( _plain.channel.calls, 1 );
} );

test( 'a child that is stuck escalates to its parent, and the parent answers its old wall with another strategy', async () => {
	const _never = ( mission ) => {
		quick( mission );
		mission.strategies.find( item => item.id === 'wait-longer' ).steps[ 0 ].params.minutes = 0.01;
		mission.world = { people: [] };
	};
	const _o = await office( { edit: _never } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	const [ _child ] = _root.children;
	assert.equal( _child.result.reason, 'escalated to the parent node' );
	assert.deepEqual( _root.tried.map( item => item.strategy ), [ 'team-report', 'ask-the-team', 'widen-group' ] );
	// 8.4: the escalation is a ticket to the parent, answered by the parent node with a receipt, in the history.
	const [ _up ] = _o.events( _child, 'ticket_opened' ).filter( ticket => ticket.to === 'parent' );
	assert.equal( _up.kind, 'escalation' );
	const _answered = _o.events( _child, 'ticket_answered' ).find( item => item.id === _up.id );
	assert.deepEqual( [ _answered.choice, _answered.by ], [ 'stop', `node ${_root.id}` ] );
	assert.ok( _answered.receipt?.id );
} );

test( '8.4: a ticket has the schema of 8.4, reaches people bundled, counts only with its receipt and becomes history', async () => {
	const _o = await office( { person: () => null } );
	const _node = { id: 'node-a', contract: { deadline: new Date( Date.now() + 3600000 ).toISOString() }, emit: () => {} };
	const _other = { ..._node, id: 'node-b' };
	const _first = _o.board.ask( _node, { question: 'Which supplier?', options: [ 'a', 'b' ], recommendation: 'a', kind: 'escalation', reason: 'counter offer' } );
	_o.board.ask( _other, { question: 'Go on?', options: [ 'yes', 'no' ], to: 'parent' } );
	const [ _ticket ] = _o.board.list().filter( item => item.from === 'node-a' );
	assert.deepEqual( Object.keys( _ticket ).filter( key => [ 'from', 'to', 'kind', 'reason', 'excerpt', 'options', 'recommendation', 'blocks', 'deadline', 'status', 'answer', 'receipt' ].includes( key ) ).length, 12 );
	assert.deepEqual( _o.board.bundles().map( bundle => [ bundle.to, bundle.tickets.length ] ), [ [ 'client', 1 ], [ 'parent', 1 ] ] );
	_o.board.answer( _ticket.id, { choice: 'b', by: 'lead' } );
	const _answer = await _first;
	assert.ok( _answer.receipt?.id, 'the answer comes with its receipt' );
	const _history = _o.system.memory.history( 'node-a' ).filter( entry => entry.kind === 'ticket' );
	assert.deepEqual( [ _history[ 0 ].data.kind, _history[ 0 ].data.choice, _history[ 0 ].data.receipt ], [ 'escalation', 'b', _answer.receipt.id ] );
	_o.stop();
} );
