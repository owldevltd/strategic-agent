// A task without a mission that needs what only the gate's operator may grant (AGENCY_PROPOSALS): an action the table
// lacks. The agent proposes the action with its strategy; the operator decides at the gate; trusted code derives its
// send move; a person approves the strategy; the message goes out once, through the gate, after its own approval.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { office, app } from '../office.mjs';

const [ System, Db, EventLog, Actions ] = await app.use( [ 'Core.System', 'Lib.Db', 'Lib.EventLog', 'Lib.Actions' ] );
const DIR = fs.mkdtempSync( path.join( os.tmpdir(), 'adhoc-gate-' ) );
after( () => {
	Actions.forget( 'notice' );
	fs.rmSync( DIR, { recursive: true, force: true } );
} );

const DRAFT = {
	goal: 'Customer C104 has a notice about the late delivery', deadlineHours: 24,
	outcomes: [ { type: 'report_delivered', values: { to: 'C104', topic: 'late delivery', action: 'carries:message' } } ], rules: [],
	backTranslation: 'You want customer C104 to receive a notice about the late delivery.', notCovered: [], soft: [],
	coverage: [ { sentence: 'Customer C104 has a notice about the late delivery', criteria: [ 'k1' ] } ],
};
const NOTICE = { name: 'notice', criticality: 'outward', carries: [ 'message' ], says: 'a short notice to a customer about their order' };
const PROPOSAL = {
	when: '"moves"',
	answer: {
		rationale: 'write the notice, then send it with a new notice action',
		steps: [ { move: 'report.draft', params: {}, from: [], as: 'note', target: '' }, { move: 'notice.send', params: {}, from: [ 'note' ], as: '', target: 'C104' } ],
		actions: [ NOTICE ],
	},
};
const WRITER = { text: 'Dear customer, your delivery will arrive two days later than planned. Kind regards, the logistics team.' };

function kind( name ) {
	const _db = new Db( ':memory:' );
	return Object.assign( new System( { config: { storageDir: DIR }, db: _db, log: new EventLog( _db, 'core' ) } ).taskMission( name ),
		{ stub: { contract: DRAFT, strategist: [ PROPOSAL ], writer: WRITER } } );
}
const yes = ticket => ( ticket.options.includes( 'yes' ) ? 'yes' : ticket.recommendation );
const closed = async ( root, ms = 20000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end && root.state !== 'closed'; ) { await new Promise( resolve => setTimeout( resolve, 10 ) ); }
	return root;
};

test( 'the agent proposes the action its plan needs; the operator approves it at the gate; the notice goes out once', async () => {
	const _decided = [];
	const o = await office( { mission: kind( 'customer-notices' ), person: yes, by: 'ops-lead', proposals: true, decide: ( proposal ) => {
		_decided.push( proposal.kind );
		return 'approve';
	} } );
	try {
		const _root = await closed( await o.system.start( o.mission, 'Tell customer C104 that the delivery is two days late.' ) );
		assert.equal( _root.result?.status, 'fulfilled', JSON.stringify( _root.result ) );
		assert.deepEqual( _decided, [ 'action' ], 'the operator decided the action at the gate' );
		assert.equal( o.egress.proposals.list( 'approved' )[ 0 ].body.name, 'notice' );
		assert.ok( o.egress.rules.actions.known( 'notice' ), 'the gate knows the action from then on' );
		const _events = o.log.forNode( _root.id ).map( event => event.kind );
		assert.ok( _events.indexOf( 'gate_proposal_decided' ) < _events.indexOf( 'process_started' ), 'the gate first, then the strategy' );
		assert.equal( o.outbox.messages( 'C104' ).length, 1 );
		assert.equal( o.outbox.messages( 'C104' )[ 0 ].action, 'notice' );
		assert.ok( o.egress.store.allDeliveries().some( row => row.action === 'notice' && row.status === 'executed' ), 'after its own approval' );
	} finally {
		o.stop();
	}
} );

test( 'the operator rejects the action: nothing is learned, no strategy is proposed for approval, nothing goes out', async () => {
	Actions.forget( 'notice' );
	const o = await office( { mission: kind( 'customer-notices-2' ), person: yes, proposals: true, decide: () => 'reject' } );
	try {
		const _root = await closed( await o.system.start( o.mission, 'Tell customer C104 that the delivery is two days late.' ) );
		assert.notEqual( _root.result?.status, 'fulfilled' );
		assert.equal( o.egress.proposals.list( 'rejected' ).length, 1 );
		assert.equal( o.egress.rules.actions.known( 'notice' ), false );
		assert.equal( o.db.get( 'SELECT COUNT(*) AS n FROM proposals' ).n, 0, 'the strategy never went to the person' );
		assert.deepEqual( o.outbox.messages( 'C104' ), [] );
	} finally {
		o.stop();
	}
} );

test( 'without AGENCY_PROPOSALS the gate takes no proposal: the plan that needs one is not proposed', async () => {
	Actions.forget( 'notice' );
	const o = await office( { mission: kind( 'customer-notices-3' ), person: yes } );
	try {
		const _root = await closed( await o.system.start( o.mission, 'Tell customer C104 that the delivery is two days late.' ) );
		assert.notEqual( _root.result?.status, 'fulfilled' );
		assert.deepEqual( o.egress.proposals.list(), [] );
		assert.deepEqual( o.outbox.messages( 'C104' ), [] );
	} finally {
		o.stop();
	}
} );

test( 'a kind that proved itself is written down as a mission folder: checked, loadable, with what people approved', async () => {
	Actions.forget( 'notice' );
	const o = await office( { mission: kind( 'customer-notices-p' ), person: yes, by: 'ops-lead', proposals: true } );
	const _to = fs.mkdtempSync( path.join( os.tmpdir(), 'promoted-' ) );
	try {
		const _root = await closed( await o.system.start( o.mission, 'Tell customer C104 that the delivery is two days late.' ) );
		assert.equal( _root.result?.status, 'fulfilled', JSON.stringify( _root.result ) );
		const _bundle = await o.system.missionBundle( 'customer-notices-p' );
		const _file = path.join( _to, 'bundle.json' );
		fs.writeFileSync( _file, JSON.stringify( _bundle ) );
		const { spawnSync } = await import( 'node:child_process' );
		const _run = spawnSync( process.execPath, [ 'bin/promote.mjs', '--bundle', _file, '--to', _to ], { encoding: 'utf8', env: { ...process.env, AGENCY_MISSIONS: '' } } );
		assert.equal( _run.status, 0, `${_run.stdout}\n${_run.stderr}` );
		const _folder = path.join( _to, 'customer-notices-p' );
		assert.deepEqual( fs.readdirSync( _folder ).sort(), [ 'actions.json', 'contract.json', 'mission.json', 'moves.json', 'strategies.json' ] );
		const _actions = JSON.parse( fs.readFileSync( path.join( _folder, 'actions.json' ), 'utf8' ) );
		assert.equal( _actions.notice.criticality, 'outward', 'the action the operator approved, now the operator\'s file' );
		const _contract = JSON.parse( fs.readFileSync( path.join( _folder, 'contract.json' ), 'utf8' ) );
		assert.equal( _contract.goal, 'Customer C104 has a notice about the late delivery', 'the goal a person confirmed is the template' );
		assert.match( _contract.deadline, /^\{\{in:\d+h\}\}$/ );
		const _mission = app.get( 'Core.Mission.Mission' ).load( 'customer-notices-p', _to );
		assert.ok( _mission.strategies.some( item => item.id === 'proposed-1' && item.approved?.by ), 'with who approved it' );
		assert.equal( _mission.moves[ 'notice.send' ].action, 'notice' );
		assert.equal( _mission.kind, 'customer-notices-p' );
		const _again = spawnSync( process.execPath, [ 'bin/promote.mjs', '--bundle', _file, '--to', _to ], { encoding: 'utf8' } );
		assert.equal( _again.status, 1 );
		assert.match( _again.stderr, /exists already; nothing is written over/ );
	} finally {
		o.stop();
		fs.rmSync( _to, { recursive: true, force: true } );
	}
} );
