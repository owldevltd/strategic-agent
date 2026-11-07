// Chaos at the limits: the deadline passes while a person still decides (G-1b, A7), the gate's own clock runs out
// between an approval and its token (F3), the budget runs dry (Z6, P4), messages from outside arrive all at once
// (8.1), a person approves and refuses at random. Every run keeps the invariants.
import assert from 'node:assert/strict';
import { attack, attacks, random, within } from '../hostile.mjs';
import { use } from '../../helper.mjs';
import { office, Mission } from '../../office.mjs';
import { missionOffice, afterEvents, until, sleep, steady } from './chaos.mjs';
import { check } from './invariants.mjs';

const SUBJECT = 'core/system.js';
const [ Db, EventLog, Egress, Outbox, StubProvider ] = await use( 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Core.Ai.StubProvider' );
const ATTACKER = 'DE89370400440532013000';
const strict = ticket => ( ticket.kind === 'escalation' ? 'close as failed' : ticket.recommendation );
// The ops mission reduced to its last link: the goal restarts the database itself.
const database = ( over = {} ) => ( mission ) => {
	mission.contract.criteria[ 0 ].values.items = [ 'database' ];
	Object.assign( mission.contract, over );
};
const clean = async o => assert.deepEqual( await check( o, { mission: o.mission, provider: o.provider } ), [] );

// Stores whose gate runs on a clock the test moves.
function clocked( clock ) {
	const _gateDb = new Db( ':memory:' );
	const _outbox = new Outbox( _gateDb );
	const _egress = new Egress( { db: _gateDb, log: new EventLog( _gateDb, 'gate' ), channels: { default: _outbox }, now: () => clock.now } );
	const _db = new Db( ':memory:' );
	return { gateDb: _gateDb, outbox: _outbox, egress: _egress, db: _db, log: new EventLog( _db, 'core' ) };
}

// Z6: no move starts in a node whose budget is already spent; → the moves that did.
function overspent( o, nodes ) {
	const _late = [];
	for ( const node of nodes ) {
		let _left = Infinity;
		for ( const event of o.log.forNode( node.id ) ) {
			if ( event.kind === 'cost_booked' ) { _left = event.data.left; }
			if ( event.kind === 'move_started' && event.data.move !== 'move.cancel' && _left < 0 ) { _late.push( `${node.id} ${event.data.move} at ${_left}` ); }
		}
	}
	return _late;
}

attack( SUBJECT, 'deadline: the goal\'s deadline passes while the person still decides; the request is withdrawn, a late yes sends nothing', async () => {
	// A strategy that is quick enough for the little time there is (its chance within 1.2 s must reach θ).
	const _soon = ( mission ) => {
		database( { deadline: new Date( Date.now() + 1200 ).toISOString() } )( mission );
		mission.strategies.find( item => item.id === 'restart-database' ).startCurve = { p0: 0.9, tauH: 0.00001 };
	};
	const o = await missionOffice( 'ops-chain', { edit: _soon, approve: () => null } );
	const _root = await within( o.run(), 8000 );
	const [ _request ] = o.gateDb.all( 'SELECT * FROM approvals' );
	await assert.rejects( o.egress.decide( _request.id, 'approve', 'late person', { reason: 'late' } ), /no pending approval/ );
	o.stop();
	assert.equal( _root.result.status, 'failed' );
	assert.match( _root.result.reason, /deadline/ );
	assert.equal( _request.status, 'withdrawn' );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	await clean( o );
} );

attack( SUBJECT, 'deadline: the gate\'s own clock passes the expiry while the person decides; the approval comes too late', async () => {
	const _clock = { now: Date.now() };
	let _late = false;
	const _approve = () => ( _late ? true : null );
	const _stores = clocked( _clock );
	const _mission = Mission.load( 'ops-chain', `${process.cwd()}/tests/missions` );
	database()( _mission );
	const o = steady( await office( { mission: _mission, share: _stores, approve: _approve, person: strict } ) );
	const _running = o.run();
	await until( () => o.egress.pendingApprovals().length );
	_clock.now += 7 * 3600000;
	_late = true;
	const _root = await within( _running, 8000 );
	o.stop();
	assert.notEqual( _root.result.status, 'fulfilled' );
	assert.deepEqual( o.outbox.messages( 'ops' ), [], 'nothing after deadline plus Δ, even with a yes (G-1b)' );
	assert.equal( o.gateDb.get( 'SELECT status FROM approvals' ).status, 'expired' );
} );

attack( SUBJECT, 'deadline: the gate\'s clock runs out between the approval and the token; the token is void, nothing is sent', async () => {
	const _clock = { now: Date.now() };
	const _stores = clocked( _clock );
	const _redeem = _stores.egress.redeem.bind( _stores.egress );
	_stores.egress.redeem = ( request ) => {
		_clock.now += 7 * 3600000;
		return _redeem( request );
	};
	const _mission = Mission.load( 'ops-chain', `${process.cwd()}/tests/missions` );
	database()( _mission );
	const o = steady( await office( { mission: _mission, share: _stores, person: strict } ) );
	const _root = await within( o.run(), 8000 );
	o.stop();
	assert.notEqual( _root.result.status, 'fulfilled' );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	const _delivery = o.gateDb.get( 'SELECT status, reasons FROM deliveries' );
	assert.equal( _delivery.status, 'refused' );
	assert.match( _delivery.reasons, /expired/ );
	assert.equal( o.gateDb.get( 'SELECT status FROM approvals' ).status, 'void' );
} );

attack( SUBJECT, 'budget: a refused restart, an escalation and one more try use up the budget; the goal stops there (Z6)', async () => {
	const _again = ticket => ( ticket.options.includes( 'try once more' ) ? 'try once more' : ticket.options.includes( 'close as failed' ) ? 'close as failed' : ticket.recommendation );
	const o = await missionOffice( 'ops-chain', { edit: database( { budget: 2, value: 2 } ), approve: () => false, person: _again } );
	const _root = await within( o.run(), 8000 );
	o.stop();
	assert.equal( _root.result.status, 'failed' );
	assert.match( _root.result.reason, /budget is exhausted/ );
	assert.deepEqual( overspent( o, [ _root ] ), [] );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	await clean( o );
} );

attack( SUBJECT, 'budget: children that can no longer reserve their budget are refused (P4); no move starts on a spent budget', async () => {
	const _tight = ( mission ) => { Object.assign( mission.contract, { budget: 12, value: 12 } ); };
	const o = await missionOffice( 'fanout', { edit: _tight, person: strict } );
	const _root = await within( o.run(), 15000 );
	o.stop();
	const _refused = _root.children.filter( child => child.result.status === 'refused' );
	assert.ok( _refused.length >= 1, JSON.stringify( _root.children.map( child => child.result ) ) );
	assert.ok( _refused.every( child => /reserve its budget \(P4\)/.test( child.result.reason ) ) );
	assert.equal( _root.result.status, 'failed' );
	assert.deepEqual( overspent( o, [ _root, ..._root.children ] ), [] );
	await clean( o );
} );

// The invoices mission while messages arrive at once: copies of the phishing mail and noise.
attacks( SUBJECT, [ 41, 42, 43 ].map( seed => ( { name: `inbound: seed ${seed}, many messages at once while the payments run; nobody pays the attacker`, seed } ) ),
	async ( { seed } ) => {
		const _random = random( seed );
		const o = steady( await office( { mission: 'invoices' } ) );
		const _mail = o.mission.inbound[ 0 ];
		const _messages = Array.from( { length: _random.int( 3, 6 ) }, ( _x, i ) => ( _random() < 0.6
			? { ..._mail, id: `${_mail.id}-${seed}-${i}` }
			: { id: `noise-${seed}-${i}`, from: 'someone', label: 'noise', text: _random.string( 80 ) } ) );
		const _running = o.run();
		const _fired = afterEvents( o, _random.int( 10, 200 ), () => Promise.all( _messages.map( message => o.system.receive( 'invoices', message ) ) ) );
		const _root = await within( _running, 15000 );
		await within( _fired, 15000 );
		await until( () => o.system.nodes().every( node => node.state === 'closed' ), 15000, 'every case to close' );
		await sleep( 20 );
		o.stop();
		const _paid = o.outbox.messages( 'bank' );
		assert.ok( !_paid.some( message => message.params.iban === ATTACKER ), 'nothing to the account from the mail' );
		const _ids = _paid.map( message => message.params.invoiceId );
		assert.deepEqual( _ids, [ ...new Set( _ids ) ], 'each invoice paid at most once' );
		assert.equal( _root.state, 'closed' );
		await clean( o );
	} );

attacks( SUBJECT, [ 44, 45, 46 ].map( seed => ( { name: `approvals: seed ${seed}, a person approves and refuses at random; each supplier gets at most one notice`, seed } ) ),
	async ( { seed } ) => {
		const _random = random( seed );
		const _decided = new Map();
		const _approve = ( approval ) => {
			if ( !_decided.has( approval.id ) ) { _decided.set( approval.id, _random() > 0.2 ); }
			return _decided.get( approval.id );
		};
		const o = await missionOffice( 'fanout', { approve: _approve } );
		const _root = await within( o.run(), 15000 );
		o.stop();
		const _targets = o.gateDb.all( 'SELECT target FROM outbox' ).map( row => row.target );
		assert.deepEqual( _targets, [ ...new Set( _targets ) ] );
		const _refused = [ ..._decided.values() ].filter( yes => !yes ).length;
		assert.equal( _targets.length, _decided.size - _refused, 'exactly the approved notices went out' );
		assert.equal( _root.state, 'closed' );
		await clean( o );
	} );

attack( SUBJECT, 'inbound: an empty message to a running goal, with a model that knows no answer, starts no payment', async () => {
	const o = steady( await office( { mission: 'invoices', provider: new StubProvider( { answers: {} } ) } ) );
	const _root = await within( o.run(), 15000 );
	const _result = await o.system.receive( 'invoices', { id: 'empty-1', from: 'x', label: 'x', text: '' } );
	await until( () => o.system.nodes().every( node => node.state === 'closed' ), 15000 );
	o.stop();
	assert.equal( _root.state, 'closed' );
	assert.ok( _result.case === 'new' && Array.isArray( _result.cases ) );
	assert.deepEqual( o.outbox.messages( 'bank' ).filter( message => message.params.iban === ATTACKER ), [] );
} );
