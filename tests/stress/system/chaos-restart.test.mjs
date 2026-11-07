// The restart defects the chaos runs found, each at one exact crash point, so they replay every time (chapter 18).
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { use, memoryDb } from '../../helper.mjs';
import { office } from '../../office.mjs';
import { missionOffice, restarted, freeze, until, load } from './chaos.mjs';
import { check } from './invariants.mjs';

const SUBJECT = 'core/loop/restore.js';
const [ System, EventLog ] = await use( 'Core.System', 'Lib.EventLog' );

// Freezes the core right after the first event for which when( event ) holds; → a promise that it happened.
function crashWhen( o, when ) {
	return new Promise( ( resolve ) => {
		const _off = o.log.subscribe( ( event ) => {
			if ( !when( event ) ) { return; }
			_off();
			setImmediate( () => {
				freeze( o );
				resolve( event );
			} );
		} );
	} );
}

attack( SUBJECT, 'restart after a child closed: the parent takes what the child proved and starts no second child for that item', async () => {
	const o = await missionOffice( 'fanout' );
	o.run().catch( () => null );
	await within( crashWhen( o, event => event.kind === 'child_ended' ), 10000, 'the first child' );
	const _second = await restarted( o, 'fanout' );
	const [ _root ] = await within( _second.resumed, 15000, 'the resumed goal' );
	_second.stop();
	const _items = _root.children.map( child => child.contract.criteria[ 0 ].values.items[ 0 ] );
	assert.deepEqual( await check( _second, { mission: _second.mission, provider: _second.provider } ), [], 'the invariants hold either way' );
	assert.deepEqual( _items, [ ...new Set( _items ) ], 'no supplier gets a second child goal' );
	assert.equal( _root.result.status, 'fulfilled' );
} );

attack( SUBJECT, 'restart after the parent began its next attempt behind a met precondition: that attempt ends, the goal is met', async () => {
	const o = await missionOffice( 'ops-chain' );
	o.run().catch( () => null );
	// The ledger child ended; its parent took the precondition and began its next attempt: the core stops there.
	const _seen = new Set();
	await within( crashWhen( o, ( event ) => {
		if ( event.kind === 'child_ended' ) { _seen.add( event.node ); }
		return event.kind === 'plan_accepted' && _seen.has( event.node );
	} ), 10000, 'the parent\'s next attempt' );
	const _second = await restarted( o, 'ops-chain' );
	const [ _root ] = await within( _second.resumed, 15000, 'the resumed goal' );
	_second.stop();
	assert.deepEqual( _second.db.all( 'SELECT id, strategy FROM attempts WHERE endedAt IS NULL' ), [], 'every attempt ended (L2, G6)' );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
} );

attack( SUBJECT, 'restart: two first calls of the ticket board at the same time get the same board', async () => {
	const _db = memoryDb();
	const _system = new System( { config: { gate: {}, llm: {}, sandbox: {} }, db: _db, log: new EventLog( _db, 'core' ) } );
	const [ _a, _b ] = await Promise.all( [ _system.board(), _system.board() ] );
	assert.equal( _a, _b, 'one board: the resume and the API must see the same tickets' );
} );

attack( SUBJECT, 'restart: a resumed goal that must ask a person is answered by whoever watches the board', async () => {
	// The ops chain with a refused restart: after the restart the resumed nodes escalate, i.e. they ask a person.
	const _refuse = approval => approval.summary.params.service !== 'ledger';
	const _strict = ticket => ( ticket.kind === 'escalation' ? 'close as failed' : ticket.recommendation );
	const o = await missionOffice( 'ops-chain', { approve: _refuse, person: _strict } );
	o.run().catch( () => null );
	await within( crashWhen( o, event => event.kind === 'approval_refused' || ( event.kind === 'wall' && event.data.cause === 'rejected_by_person' ) ), 10000 );
	// The harness's own restart: office( { resume: true } ) asks for the board while the resume is assembling.
	const _second = await office( { mission: load( 'ops-chain' ), share: o, resume: true, approve: _refuse, person: _strict } );
	const _done = await within( _second.resumed.then( () => true ), 4000, 'the resumed goal' ).catch( () => false );
	_second.stop();
	const _open = _second.system.nodes().filter( node => node.state !== 'closed' ).length;
	assert.equal( _done && _open === 0, true, `the resumed goal closes (${_open} nodes still open, waiting for an answer on a board nobody watches)` );
} );

attack( SUBJECT, 'restart: a crash before the goal was confirmed resumes from the draft, and the person confirms it once', async () => {
	const o = await missionOffice( 'coding' );
	o.stop();
	o.run().catch( () => null );
	await until( () => o.log.since( 0, 1e9 ).some( event => event.kind === 'contract_proposed' ) );
	freeze( o );
	const _second = await restarted( o, 'coding' );
	const [ _root ] = await within( _second.resumed, 10000 );
	_second.stop();
	assert.equal( _root.result.status, 'fulfilled' );
	assert.equal( _second.gateDb.all( 'SELECT hash FROM contracts' ).length, 1, 'the same contract, proposed once, confirmed once' );
	assert.deepEqual( await check( _second, { mission: _second.mission, provider: _second.provider } ), [] );
} );

attack( SUBJECT, 'restart: a crash while a restart waits for its approval withdraws that request; the new core asks again, once', async () => {
	const o = await missionOffice( 'ops-chain', { approve: () => null } );
	o.run().catch( () => null );
	const _pending = await until( () => o.egress.pendingApprovals()[ 0 ] );
	freeze( o );
	const _second = await restarted( o, 'ops-chain' );
	const [ _root ] = await within( _second.resumed, 15000 );
	_second.stop();
	assert.equal( _root.result.status, 'fulfilled' );
	assert.equal( _second.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'the dead core\'s request was withdrawn (O9)' );
	assert.equal( _second.outbox.messages( 'ops' ).length, 4, 'each service restarted exactly once' );
	assert.deepEqual( await check( _second, { mission: _second.mission, provider: _second.provider } ), [] );
} );
