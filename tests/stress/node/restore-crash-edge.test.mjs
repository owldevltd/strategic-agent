// core/loop/restore.js under attack, part 6: the edges of a restart. The core dies between deciding to go deeper and
// creating the child, stays down past the goal's deadline, is started twice, dies while the gate still takes its last
// call, or finds a tampered run next to a sound one (18.4, 18.6, G-1c, O9).
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { office, app, registry, Contract } from '../../office.mjs';
import { after } from './rig.mjs';
import { sound, restart } from './crash.mjs';
import { tick, Db } from './kit.mjs';

const S = 'core/loop/restore.js';
const [ System ] = await app.use( [ 'Core.System' ] );
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

attack( S, '18.6: dead between "go deeper" and the child\'s creation: the goal still ends, and a person is asked rather than nothing done', async () => {
	const _result = await restart( after( 'state_changed', { depth: 0, where: event => Boolean( event.data.child ) } ) );
	sound( _result, { fulfilled: false } );
	const _asked = _result.events.some( event => event.kind === 'ticket_opened' && event.data.kind === 'escalation' );
	assert.ok( _asked || _result.root === 'fulfilled', `the root ended ${_result.root} without asking anyone` );
}, { timeout: 40000 } );

attack( S, 'G-1c: a goal whose deadline passed while the core was down is ended at once after the restart, as failed', async () => {
	const _deadline = spec => ( { ...spec, deadline: new Date( Date.now() + 1500 ).toISOString() } );
	const _result = await restart( after( 'contract_confirmed', { depth: 0 } ), { contract: _deadline, pauseMs: 1600, waitMs: 10000 } );
	assert.equal( _result.resumed, true, 'overdue deadlines are handled within the restart buffer Δw' );
	assert.equal( _result.root, 'failed' );
	assert.match( _result.reason, /deadline/ );
	assert.deepEqual( [ _result.open, _result.reports, _result.deliveriesOpen ], [ [], 0, [] ] );
}, { timeout: 40000 } );

attack( S, '18: a core told to resume twice drives every open goal once; nothing goes out twice', async () => {
	const _result = await restart( after( 'plan_accepted', { depth: 0 } ), { resumes: 2 } );
	assert.equal( _result.reports, 1, `the report went out ${_result.reports} times` );
	assert.equal( _result.runners, 1, 'one runner per run' );
}, { timeout: 40000 } );

attack( S, 'O9: an action the dying core asked for, whose record it lost, is withdrawn after the restart', async () => {
	const _result = await restart( after( 'plan_accepted', { depth: 1 } ), { gateLag: 40 } );
	assert.deepEqual( _result.deliveriesOpen, [], 'the gate still holds a request no node knows' );
	sound( _result );
}, { timeout: 40000 } );

attack( S, '18: while the core resumes, every caller of the ticket board gets the same board', async () => {
	const _system = new System( { config: { gate: { bufferMinutes: 5 }, llm: {} }, db: new Db( ':memory:' ), log: null } );
	const [ _a, _b ] = await Promise.all( [ _system.board(), _system.board() ] );
	assert.equal( _a, _b, 'tickets of the resumed nodes would sit on a board no person looks at' );
}, { timeout: 40000 } );

attack( S, '18.6: a tampered run does not keep a sound run from resuming', async () => {
	const _first = await office( { edit: quick } );
	_first.stop();
	const _bad = await _first.runner.start( new Contract( _first.mission.contractSpec(), registry ) );
	const _second = await office( { edit: quick, share: _first } );
	_second.stop();
	const _good = await _second.runner.start( new Contract( _second.mission.contractSpec( Date.now() + 1 ), registry ) );
	_first.db.run( 'UPDATE events SET data = REPLACE( data, \'"k":5\', \'"k":4\' ) WHERE kind = \'node_created\' AND node = :node', { node: _bad.id } );
	const _third = await office( { edit: quick, share: _first, resume: true } );
	await _third.resumed.catch( () => {} );
	await tick( 50 );
	_third.stop();
	_third.system.runners.forEach( runner => runner.nodes.forEach( ( item ) => {
		item.state = 'closed';
	} ) );
	const _resumed = _first.log.since( 0, 1e9 ).filter( event => event.kind === 'run_resumed' ).map( event => event.data.root );
	assert.ok( _resumed.includes( _good.id ), 'the sound run must be resumed' );
}, { timeout: 40000 } );

attack( S, '18: resuming a log whose goals all closed starts nothing', async () => {
	const _o = await office( { edit: quick } );
	await _o.run();
	_o.stop();
	const _again = await office( { edit: quick, share: _o, resume: true } );
	const _roots = await within( _again.resumed, 10000 );
	_again.stop();
	assert.deepEqual( _roots, [] );
	assert.equal( _again.system.runners.length, 0 );
}, { timeout: 30000 } );
