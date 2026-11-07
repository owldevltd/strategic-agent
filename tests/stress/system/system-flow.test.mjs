// Core.System in motion: a task in words through G1 to a running goal (3.2), restart from the log (18), messages
// from outside (8.1), the abort of the client (16.5), and the history every ticket answer leaves (8.4).
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { office, Mission, Contract } from '../../office.mjs';
import { coding, codingOffice, Recording, COMMIT } from './coding.mjs';

const SUBJECT = 'core/system.js';
const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) );
const until = async ( check, ms = 5000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end; await sleep( 3 ) ) {
		const _value = check();
		if ( _value ) { return _value; }
	}
	throw new Error( 'timed out waiting' );
};
const goal = coding().stub.contract.goal;
const draft = ( over = {} ) => ( { ...coding().stub.contract, ...over } );
const missionWith = ( answers ) => {
	const _mission = coding();
	Object.assign( _mission.stub, answers );
	return _mission;
};
const contracts = o => o.gateDb.all( 'SELECT hash, status FROM contracts' );

attack( SUBJECT, 'start: a task in words is drafted, confirmed at the gate by a person and runs to its end in the background', async () => {
	const o = await office( { mission: coding() } );
	const _root = await o.system.start( missionWith( {} ) );
	assert.equal( _root.parent, null );
	await until( () => !o.system.running( 'coding' ) );
	o.stop();
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	assert.equal( o.system.latest( 'coding' ).root, _root );
	assert.equal( contracts( o ).find( row => row.hash === _root.contract.hash ).status, 'confirmed' );
	assert.deepEqual( _root.contract.criteria[ 0 ].values, { test: 'iban_acceptance', commit: COMMIT } );
} );

attack( SUBJECT, 'start: the task the client typed reaches the drafter, not the mission\'s default text', async () => {
	const o = await office( { mission: coding() } );
	const _root = await o.system.start( missionWith( {} ), 'Make our IBAN cleaner pass its tests by tonight.' );
	await until( () => !o.system.running( 'coding' ) );
	o.stop();
	const _task = o.log.since( 0, 1e9 ).find( event => event.kind === 'task_received' );
	assert.equal( _task.data.task, 'Make our IBAN cleaner pass its tests by tonight.' );
	assert.equal( _root.contract.understood.task, 'Make our IBAN cleaner pass its tests by tonight.' );
} );

attack( SUBJECT, 'start: a draft without any outcome is refused at G1; nothing reaches the gate, no run starts', async () => {
	const o = await office( { mission: coding() } );
	const _runners = o.system.runners.length;
	const _result = await o.system.start( missionWith( { contract: draft( { outcomes: [] } ) } ) );
	o.stop();
	assert.equal( _result.refused, true );
	assert.ok( _result.problems.some( text => /no outcome criterion/.test( text ) ) );
	assert.equal( o.system.runners.length, _runners );
	assert.deepEqual( contracts( o ), [] );
	assert.ok( o.log.since( 0, 1e9 ).some( event => event.kind === 'draft_refused' ) );
} );

attack( SUBJECT, 'start: a drafter that swaps the tests for a person\'s word is refused: no strategy of this kind can achieve it', async () => {
	const o = await office( { mission: coding() } );
	const _confirm = draft( { outcomes: [ { type: 'confirmed_by', values: { role: 'client', question: 'Is the code fine?' } } ] } );
	const _result = await o.system.start( missionWith( { contract: _confirm } ) );
	o.stop();
	assert.equal( _result.refused, true, JSON.stringify( _result ) );
	assert.ok( _result.problems.some( text => /no strategy can achieve confirmed_by/.test( text ) ), _result.problems.join( '; ' ) );
	assert.deepEqual( contracts( o ), [] );
} );

attack( SUBJECT, 'start: a drafter that invents a criterion type is refused after its one repair', async () => {
	const o = await office( { mission: coding() } );
	const _invented = draft( { outcomes: [ { type: 'tests_look_fine', values: {} } ] } );
	const _result = await o.system.start( missionWith( { contract: _invented } ) );
	o.stop();
	assert.equal( _result.refused, true );
	assert.ok( _result.problems.includes( 'unknown criterion type: tests_look_fine' ) );
	assert.equal( o.log.since( 0, 1e9 ).filter( event => event.kind === 'draft_checked' ).length, 2, 'one draft and one repair' );
} );

attack( SUBJECT, 'start: a broken draft repaired in the second round starts the goal', async () => {
	const o = await office( { mission: coding() } );
	const _root = await o.system.start( missionWith( { contract: [ draft( { outcomes: [] } ), draft() ] } ) );
	await until( () => !o.system.running( 'coding' ) );
	o.stop();
	assert.equal( _root.result.status, 'fulfilled' );
	const _checks = o.log.since( 0, 1e9 ).filter( event => event.kind === 'draft_checked' ).map( event => event.data.ok );
	assert.deepEqual( _checks, [ false, true ] );
} );

attack( SUBJECT, 'start: a drafter answer that breaks its step contract twice is refused like any broken draft, it does not throw (6.4)', async () => {
	const o = await office( { mission: coding() } );
	const _broken = { goal, outcomes: 'all of them', backTranslation: 'x', notCovered: [], deadlineHours: 24 };
	const _result = await o.system.start( missionWith( { contract: _broken } ) ).catch( error => ( { thrown: error.message } ) );
	o.stop();
	assert.equal( _result.thrown, undefined, `start threw: ${_result.thrown}` );
	assert.equal( _result.refused, true );
} );

attack( SUBJECT, 'start: strategy gates the drafter proposes for this kind of task go to the gate store, by the agent', async () => {
	const o = await office( { mission: coding() } );
	const _gate = { rule: 'order', before: 'code.write', after: 'code.test' };
	await o.system.start( missionWith( { contract: draft( { strategyGates: [ _gate ] } ) } ) );
	await until( () => !o.system.running( 'coding' ) );
	o.stop();
	const _active = o.system.gates.active( 'code-change' );
	assert.equal( _active.length, 1 );
	assert.equal( _active[ 0 ].by, 'agent' );
} );

attack( SUBJECT, 'resume: with nothing unfinished in the log, nothing is assembled', async () => {
	const o = await office( { mission: coding() } );
	const _runners = o.system.runners.length;
	assert.deepEqual( await o.system.resume( { load: () => coding(), pollMs: 5 } ), [] );
	assert.equal( o.system.runners.length, _runners );
	o.stop();
} );

attack( SUBJECT, 'resume: a goal closed before the restart is not resumed', async () => {
	const o = await codingOffice();
	await o.run();
	o.crash();
	const _second = await office( { mission: coding(), share: o, resume: true } );
	assert.deepEqual( await within( _second.resumed, 5000 ), [] );
	_second.stop();
} );

attack( SUBJECT, 'resume: a crash while the model writes the code; the new core ends the attempt as interrupted and the goal is met', async () => {
	let _release;
	const _held = new Promise( ( resolve ) => { _release = resolve; } );
	class Slow extends Recording {
		async _complete( request ) {
			if ( request.role === 'coder' && this.of( 'coder' ).length === 0 ) { await _held; }
			return super._complete( request );
		}
	}
	const _mission = coding();
	const o = await office( { mission: _mission, provider: new Slow( { answers: _mission.stub } ) } );
	o.run().catch( () => {} );
	await until( () => o.log.since( 0, 1e9 ).some( event => event.kind === 'move_started' && event.data.move === 'code.write' ) );
	o.crash();
	const _second = await office( { mission: coding(), share: o, resume: true, provider: new Recording( { answers: _mission.stub } ) } );
	const [ _root ] = await within( _second.resumed, 10000 );
	_release();
	_second.stop();
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	assert.equal( _root.walls[ 0 ].cause, 'interrupted' );
	assert.deepEqual( _second.db.all( 'SELECT id FROM attempts WHERE endedAt IS NULL' ), [] );
	assert.equal( _root.contract.spec.kind, 'code-change' );
} );

attack( SUBJECT, 'resume: the mission of each unfinished run is loaded by the id the log names', async () => {
	const o = await codingOffice();
	await o.runner.start( new Contract( o.mission.contractSpec(), o.system.registry ) );
	o.crash();
	const _asked = [];
	const _second = await office( { mission: coding(), share: o } );
	const _load = ( id ) => {
		_asked.push( id );
		return coding();
	};
	const [ _root ] = await within( _second.system.resume( { load: _load, pollMs: 5 } ), 10000 );
	_second.stop();
	assert.deepEqual( _asked, [ 'coding' ] );
	assert.equal( _root.result.status, 'fulfilled', 'the goal that was only drafted before the crash runs from its start' );
} );

attack( SUBJECT, 'inbound: an unknown message id is refused', async () => {
	const o = await office( { mission: 'invoices' } );
	await assert.rejects( o.system.inbound( 'invoices', 'no-such-mail' ), /unknown message no-such-mail/ );
	o.stop();
} );

attack( SUBJECT, 'inbound and receive: a mission that was never started has no runner to hand a message to', async () => {
	const o = await office( { mission: coding() } );
	await assert.rejects( o.system.inbound( 'invoices', 'supplier-mail' ), /has not been started/ );
	await assert.rejects( o.system.receive( 'invoices', { id: 'm', from: 'x', text: 'hello' } ), /has not been started/ );
	o.stop();
} );

attack( SUBJECT, 'inbound: the phishing mail reaches both offices; ours pays nobody, the neighbour pays the attacker', async () => {
	const o = await office( { mission: 'invoices' } );
	await within( o.run(), 15000 );
	const _both = await within( o.system.inbound( 'invoices', 'supplier-mail' ), 15000 );
	assert.ok( _both.ours && _both.neighbour );
	await until( () => o.system.nodes().every( node => node.state === 'closed' ), 15000 );
	o.stop();
	const _paid = o.outbox.messages( 'bank' );
	assert.ok( !_paid.some( message => message.params.iban === 'DE89370400440532013000' ), 'nothing to the attacker\'s account' );
	assert.ok( JSON.stringify( _both.neighbour ).includes( 'DE89370400440532013000' ) );
} );

attack( SUBJECT, 'receive: a message that matches nothing waiting becomes a case of its own (8.1)', async () => {
	const o = await office( { mission: 'invoices' } );
	await within( o.run(), 15000 );
	const _result = await within( o.system.receive( 'invoices', o.mission.inbound[ 0 ] ), 15000 );
	assert.equal( _result.case, 'new' );
	assert.equal( _result.cases.length, 1 );
	assert.ok( _result.cases[ 0 ].node && _result.cases[ 0 ].goal );
	await until( () => o.system.nodes().every( node => node.state === 'closed' ), 15000 );
	o.stop();
} );

attack( SUBJECT, 'abort: the client stops the latest goal with everything below it; a second abort finds nothing to stop', async () => {
	const _loop = { code: 'while True:\n    pass\n' };
	const o = await codingOffice( { answers: { coder: _loop }, edit: mission => mission.strategies[ 0 ].steps[ 1 ].params.seconds = 1 } );
	const _running = o.run();
	await until( () => o.log.since( 0, 1e9 ).some( event => event.kind === 'sandbox_started' ) );
	const _first = await o.system.abort( 'coding' );
	const _root = await within( _running, 10000 );
	const _second = await o.system.abort( 'coding' );
	o.stop();
	assert.deepEqual( _first, { aborted: true, root: _root.id } );
	assert.deepEqual( _second, { aborted: false, root: _root.id } );
	assert.equal( _root.result.status, 'aborted' );
	assert.equal( _root.result.reason, 'aborted by the client' );
} );

attack( SUBJECT, 'abort: a mission that was never started cannot be aborted', async () => {
	const o = await office( { mission: coding() } );
	await assert.rejects( o.system.abort( 'invoices' ), /has not been started/ );
	o.stop();
} );

attack( SUBJECT, 'abort: a mission assembled but without a goal yet answers cleanly instead of crashing', async () => {
	const o = await office( { mission: coding() } );
	const _result = await o.system.abort( 'coding' ).catch( error => ( { thrown: error.message } ) );
	o.stop();
	assert.equal( _result.thrown, undefined, `abort threw: ${_result.thrown}` );
	assert.equal( _result.aborted, false );
} );

attack( SUBJECT, 'abort: stopping one mission leaves another mission running', async () => {
	const _loop = { code: 'while True:\n    pass\n' };
	const o = await codingOffice( { answers: { coder: _loop }, edit: mission => mission.strategies[ 0 ].steps[ 1 ].params.seconds = 0.5 } );
	const _codingRun = o.run();
	const _other = await o.system.assemble( Mission.load( 'invoices' ), { pollMs: 5 } );
	await until( () => o.log.since( 0, 1e9 ).some( event => event.kind === 'sandbox_started' ) );
	await o.system.abort( 'coding' );
	await within( _codingRun, 10000 );
	assert.equal( _other.root, undefined );
	assert.equal( o.system.latest( 'invoices' ), _other, 'the other mission\'s runner is untouched' );
	assert.equal( o.system.latest( 'coding' ).root.result.status, 'aborted' );
	o.stop();
} );

attack( SUBJECT, 'history: every answered ticket becomes part of the history of the node that asked (8.4)', async () => {
	const o = await codingOffice( { answers: { coder: { code: 'def normalise_iban(t):\n    return t\n' } } } );
	const _root = await within( o.run(), 15000 );
	o.stop();
	const _history = o.system.memory.history( _root.id ).filter( item => item.kind === 'ticket' );
	assert.ok( _history.length >= 1 );
	assert.ok( _history.every( item => item.data.by && item.data.receipt ), JSON.stringify( _history ) );
	assert.ok( _history.some( item => item.data.kind === 'escalation' && item.data.choice === 'close as failed' ) );
} );

attack( SUBJECT, 'history: a ticket of a node no runner knows is still recorded, under its id', async () => {
	const o = await office( { mission: coding() } );
	const _board = await o.system.board();
	const _asked = _board.ask( { id: 'node-elsewhere', contract: {}, emit: () => {} }, { question: 'Fine?', options: [ 'yes' ], minutes: 1 } );
	const [ _ticket ] = _board.list();
	_board.answer( _ticket.id, { choice: 'yes', by: 'tester' } );
	await _asked;
	o.stop();
	const [ _entry ] = o.system.memory.history( 'node-elsewhere' );
	assert.equal( _entry.kind, 'ticket' );
	assert.deepEqual( [ _entry.data.choice, _entry.data.by ], [ 'yes', 'tester' ] );
} );

attack( SUBJECT, 'observe: an answer to what an attempt sent is a signal of that attempt in the journal (L2)', async () => {
	const o = await office( { mission: coding() } );
	const _node = { id: 'node-x', contract: { hash: 'h' } };
	const _attempt = o.system.journal.start( _node, { id: 's' }, {}, {} );
	o.system.expectations._bus.emit( 'fact', { id: 'e-1', attempt: _attempt } );
	o.stop();
	assert.ok( o.system.journal.get( _attempt ).signalAt );
} );

attack( SUBJECT, 'observe: a fact without an attempt changes no journal entry', async () => {
	const o = await office( { mission: coding() } );
	const _node = { id: 'node-y', contract: { hash: 'h' } };
	const _attempt = o.system.journal.start( _node, { id: 's' }, {}, {} );
	o.system.expectations._bus.emit( 'fact', { id: 'e-2', attempt: null } );
	o.stop();
	assert.equal( o.system.journal.get( _attempt ).signalAt, null );
} );
