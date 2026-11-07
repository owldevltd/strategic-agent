// A task without a mission (6.1, 19, 3.2): only a kind and the text. The agent drafts the goal, finds no strategy for
// this new kind, proposes one as its own process, a person approves it, and the goal is reached through the gate. The
// next task of the same kind, after a restart, uses what was approved and proposes nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { office, app } from '../office.mjs';

const [ System, Db, EventLog ] = await app.use( [ 'Core.System', 'Lib.Db', 'Lib.EventLog' ] );
const DIR = fs.mkdtempSync( path.join( os.tmpdir(), 'adhoc-' ) );
after( () => fs.rmSync( DIR, { recursive: true, force: true } ) );

const KIND = 'hr-summaries';
const TASK = 'Send HR a short summary of our onboarding checklist.';
const DRAFT = {
	goal: 'HR has a short summary of the onboarding checklist', deadlineHours: 24,
	outcomes: [ { type: 'report_delivered', values: { to: 'hr', topic: 'onboarding' } } ], rules: [],
	backTranslation: 'You want HR to receive a short summary of the onboarding checklist.', notCovered: [], soft: [],
	coverage: [ { sentence: 'HR has a short summary of the onboarding checklist', criteria: [ 'k1' ] } ],
};
const PROPOSAL = {
	when: '"moves"',
	answer: {
		rationale: 'draft the summary, then send it to HR as a report',
		steps: [
			{ move: 'report.draft', params: {}, from: [], as: 'report', target: '' },
			{ move: 'report.send', params: {}, from: [ 'report' ], as: '', target: 'hr' },
		],
	},
};
const WRITER = { text: 'Onboarding: accounts, laptop, safety briefing; all three are done in the first week.' };

// The kind as a system with storage creates it: a folder holding nothing but its kind. The model of the test answers
// through the stub the core builds for the kind (stub), as it would for a mission.
function kindMission( stub = {} ) {
	const _db = new Db( ':memory:' );
	return Object.assign( new System( { config: { storageDir: DIR }, db: _db, log: new EventLog( _db, 'core' ) } ).taskMission( KIND ), { stub } );
}
const yes = ticket => ( ticket.options.includes( 'yes' ) ? 'yes' : ticket.recommendation );
const closed = async ( root, ms = 20000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end && root.state !== 'closed'; ) { await new Promise( resolve => setTimeout( resolve, 10 ) ); }
	return root;
};

test( 'a task of a new kind: the agent drafts the goal, proposes its way, a person approves it, and the goal is reached', async () => {
	const _mission = kindMission( { contract: DRAFT, strategist: [ PROPOSAL ], writer: WRITER } );
	assert.deepEqual( _mission.strategies.filter( item => item.kind === KIND ), [], 'nothing is prepared for this kind' );
	const o = await office( { mission: _mission, person: yes, by: 'hr-lead' } );
	try {
		const _root = await closed( await o.system.start( _mission, TASK ) );
		assert.equal( _root.result?.status, 'fulfilled', JSON.stringify( _root.result ) );
		const _events = o.log.forNode( _root.id ).map( event => event.kind );
		assert.ok( _events.includes( 'strategy_proposed' ), 'the agent proposed the way itself' );
		assert.ok( _events.includes( 'process_started' ), 'as its own process (6.1)' );
		const _row = o.db.get( 'SELECT status, approvedBy, mission FROM proposals' );
		assert.deepEqual( [ _row.status, _row.mission ], [ 'approved', KIND ] );
		assert.equal( o.outbox.messages( 'hr' ).length, 1, 'the report went out once, through the gate, after its approval' );
		assert.equal( o.egress.store.contract( _root.contract.hash ).spec.kind, KIND );
		// Only the kind is on disk; what was learned lives in the core's ledger.
		assert.deepEqual( fs.readdirSync( path.join( DIR, 'tasks', KIND ) ).sort(), [ 'contract.json', 'mission.json' ] );

		// A restart: a new core on the same databases, the kind loaded again from its folder.
		const _again = kindMission( { contract: { ...DRAFT, goal: 'HR has a short summary of the offboarding checklist',
			coverage: [ { sentence: 'HR has a short summary of the offboarding checklist', criteria: [ 'k1' ] } ] }, writer: WRITER } );
		const o2 = await office( { mission: _again, share: o, person: yes, by: 'hr-lead' } );
		try {
			const _next = await closed( await o2.system.start( o2.mission, 'Send HR a short summary of our offboarding checklist.' ) );
			assert.equal( _next.result?.status, 'fulfilled', JSON.stringify( _next.result ) );
			assert.ok( !o2.log.forNode( _next.id ).some( event => event.kind === 'strategy_proposed' ), 'nothing proposed: the kind learned its way' );
			assert.ok( _next.tried.some( item => item.strategy === 'proposed-1' ) );
			assert.equal( o2.outbox.messages( 'hr' ).length, 2 );
		} finally {
			o2.stop();
		}
	} finally {
		o.stop();
	}
} );

test( 'a person who declines the proposed way: nothing enters the catalog and the task fails, the kind stays unlearned', async () => {
	const _db = new Db( ':memory:' );
	const _system = new System( { config: { storageDir: DIR }, db: _db, log: new EventLog( _db, 'core' ) } );
	const _mission = Object.assign( _system.taskMission( 'declined-kind' ), { stub: { contract: DRAFT, strategist: [ PROPOSAL ], writer: WRITER } } );
	const _no = ticket => ( ticket.options.includes( 'no' ) ? 'no' : ticket.recommendation );
	const o = await office( { mission: _mission, person: _no } );
	try {
		const _root = await closed( await o.system.start( _mission, TASK ) );
		assert.notEqual( _root.result?.status, 'fulfilled' );
		assert.equal( o.db.get( 'SELECT status FROM proposals' ).status, 'proposed' );
		assert.deepEqual( o.outbox.messages( 'hr' ), [] );
	} finally {
		o.stop();
	}
} );

test( 'the kind of a task is a plain name of its own, never a mission folder\'s', () => {
	const _db = new Db( ':memory:' );
	const _system = new System( { config: { storageDir: DIR }, db: _db, log: new EventLog( _db, 'core' ) } );
	assert.throws( () => _system.taskMission( '../escape' ), error => error.status === 400 );
	assert.throws( () => _system.taskMission( 'Upper' ), error => error.status === 400 );
	assert.throws( () => _system.taskMission( 'survey' ), error => error.status === 409 );
	assert.throws( () => _system.taskMission( 'hr-survey' ), error => error.status === 409, 'nor the kind of one' );
	assert.equal( _system.taskMission().id, 'general' );
	assert.equal( _system.mission( 'general' ).kind, 'general', 'after a restart the kind is found again' );
	assert.equal( _system.mission( 'survey' ).id, 'survey', 'a mission folder still wins' );
} );
