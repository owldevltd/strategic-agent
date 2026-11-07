// core/system.js and core/main.js: the public demo's fresh start. Before a visitor gives a task, the office has the
// agent forget what earlier runs taught it about the mission's kind of task (lessons, diagnoses, its strategy gates,
// the strategies proposed for the mission). Nothing is deleted, another kind keeps what it learned, a running goal is
// never pulled from under, and only the demo has the route.
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { deployment, json, until } from './processes.mjs';

const SUBJECT = 'core/system.js';
const AT = '2026-11-07T12:00:00.000Z';

async function withDeployment( options, fn ) {
	const d = await deployment( options );
	try {
		return await fn( d );
	} finally {
		await d.stop();
	}
}

// A run of the survey that is started and aborted again: the stores exist afterwards, nothing runs.
async function ranOnce( d ) {
	await d.call( 'POST', '/api/missions/survey/start', {} );
	await d.call( 'POST', '/api/missions/survey/abort' );
	await until( () => !d.main.system.running( 'survey' ) );
}

// What an earlier visitor's runs left behind, for the survey's kind and for another one.
function learned( db ) {
	for ( const [ kind, mission ] of [ [ 'hr-survey', 'survey' ], [ 'supplier-payments', 'invoices' ] ] ) {
		db.run( 'INSERT INTO lessons ( id, kind, strategy, data, signature, status, time ) VALUES ( :id, :kind, \'s\', \'{}\', \'x\', \'valid\', :at )',
			{ id: `ls-${kind}`, kind, at: AT } );
		db.run( 'INSERT INTO diagnoses ( kind, data, signature, status, time ) VALUES ( :kind, \'{}\', \'x\', \'valid\', :at )', { kind, at: AT } );
		db.run( `INSERT INTO strategy_gates ( id, rule, key, data, scope, expires, by, status, time )
			VALUES ( :id, 'order', 'a|b', '{}', :kind, '2099-01-01T00:00:00Z', 'agent', 'active', :at )`, { id: `sg-${kind}`, kind, at: AT } );
		db.run( 'INSERT INTO proposals ( version, kind, mission, body, by, status, time ) VALUES ( :id, \'strategy\', :mission, \'{}\', \'agent\', \'approved\', :at )',
			{ id: `pv-${kind}`, mission, at: AT } );
	}
}
const statuses = ( db, kind, mission ) => [
	db.get( 'SELECT status FROM lessons WHERE kind = :kind', { kind } ).status,
	db.get( 'SELECT status FROM diagnoses WHERE kind = :kind', { kind } ).status,
	db.get( 'SELECT status FROM strategy_gates WHERE scope = :kind AND id = :id', { kind, id: `sg-${kind}` } ).status,
	db.get( 'SELECT status FROM proposals WHERE mission = :mission', { mission } ).status,
];

attack( SUBJECT, 'forget: what the survey\'s kind learned is set aside, not deleted; the invoices keep theirs', () => withDeployment( {}, async ( d ) => {
	await ranOnce( d );
	const { db } = d.main.system;
	learned( db );
	const _answer = await json( await d.call( 'POST', '/api/missions/survey/forget' ) );
	assert.equal( _answer.status, 200 );
	assert.deepEqual( [ _answer.body.lessons, _answer.body.diagnoses, _answer.body.proposals ], [ 1, 1, 1 ] );
	assert.ok( _answer.body.gates >= 1 );
	assert.deepEqual( statuses( db, 'hr-survey', 'survey' ), [ 'forgotten', 'forgotten', 'forgotten', 'forgotten' ] );
	assert.deepEqual( statuses( db, 'supplier-payments', 'invoices' ), [ 'valid', 'valid', 'active', 'approved' ] );
	assert.deepEqual( d.main.system.gates.active( 'hr-survey' ), [], 'no gate of the kind is in force any more' );
	assert.ok( d.main.log.since( 0, 1e9 ).some( event => event.kind === 'knowledge_forgotten' && event.data.kind === 'hr-survey' ) );
	assert.equal( ( await json( await d.call( 'POST', '/api/missions/survey/forget' ) ) ).body.lessons, 0, 'forgetting twice finds nothing more' );
} ) );

attack( SUBJECT, 'forget: never while a run of the mission is going (409); the run keeps what it has', () => withDeployment( {}, async ( d ) => {
	await d.call( 'POST', '/api/missions/survey/start', {} );
	await until( () => d.main.system.running( 'survey' ) );
	const _answer = await json( await d.call( 'POST', '/api/missions/survey/forget' ) );
	assert.equal( _answer.status, 409 );
	assert.match( _answer.body.error, /abort it first/ );
	await d.call( 'POST', '/api/missions/survey/abort' );
	await until( () => !d.main.system.running( 'survey' ) );
} ) );

attack( SUBJECT, 'forget: a fresh server has learned nothing yet, and an unknown mission is 404', () => withDeployment( {}, async ( d ) => {
	const _fresh = await json( await d.call( 'POST', '/api/missions/survey/forget' ) );
	assert.deepEqual( [ _fresh.status, _fresh.body.lessons, _fresh.body.gates ], [ 200, 0, 0 ] );
	assert.equal( ( await d.call( 'POST', '/api/missions/no-such/forget' ) ).status, 404 );
	assert.equal( ( await d.call( 'POST', '/api/missions/..%2Fsurvey/forget' ) ).status, 404 );
} ) );

attack( SUBJECT, 'forget: only the demo has it; outside the demo the agent keeps what it learned (404)', () => withDeployment( { core: { demo: false } }, async ( d ) => {
	assert.equal( ( await d.call( 'POST', '/api/missions/survey/forget' ) ).status, 404 );
} ) );

attack( SUBJECT, 'forget: with a board pin set it needs the pin, like giving a task', () => withDeployment( { env: { CORE_BOARD_PIN: 'board-pin-2468' } }, async ( d ) => {
	assert.equal( ( await d.call( 'POST', '/api/missions/survey/forget' ) ).status, 403 );
	assert.equal( ( await d.call( 'POST', '/api/missions/survey/forget', undefined, { 'x-board-pin': 'board-pin-2468' } ) ).status, 200 );
} ) );
