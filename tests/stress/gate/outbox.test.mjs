// Attacks on the outbox channel, the service that keeps the idempotency key (O2, G-7b): the same key sent again, at
// once, from a restarted gate, with other content; hostile keys and recipients; lost answers; lookups that must
// never invent a message.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Db, Outbox, gate, restart, settle, reply, people } from './fixture.mjs';

const S = 'gate/channel/outbox.js';

const box = () => new Outbox( new Db( ':memory:' ) );
const delivery = ( id = 'dl-1', extra = {} ) => ( { id, action: 'reply', target: 'ceo', params: { body: 'hello' }, ...extra } );
const rows = outbox => outbox.db.all( 'SELECT * FROM outbox ORDER BY rowid' );

// A service that takes the message and then loses its answer, the first n times.
class LostAnswers extends Outbox {

	static IDEMPOTENT = true;

	constructor( db, lost ) {
		super( db );
		this.lost = lost;
	}

	async send( item ) {
		const _receipt = await super.send( item );
		return this.lost-- > 0 ? { ok: false, error: 'the answer was lost on the way back' } : _receipt;
	}

}

attack( S, 'O2: the outbox declares that it keeps the idempotency key', () => {
	assert.equal( Outbox.IDEMPOTENT, true );
} );

attack( S, 'O2: a second send with the same key creates no second message and repeats the first receipt', async () => {
	const _box = box();
	const _first = await _box.send( delivery() );
	const _second = await _box.send( delivery() );
	assert.equal( rows( _box ).length, 1 );
	assert.equal( _second.receipt.id, _first.receipt.id );
	assert.equal( _second.receipt.time, _first.receipt.time );
	assert.equal( _second.receipt.repeated, true );
	assert.equal( _first.receipt.repeated, undefined );
} );

attack( S, 'O2: ten sends with the same key at the same moment create one message', async () => {
	const _box = box();
	const _all = await Promise.all( Array.from( { length: 10 }, () => _box.send( delivery() ) ) );
	assert.equal( rows( _box ).length, 1 );
	assert.equal( new Set( _all.map( item => item.receipt.id ) ).size, 1 );
} );

attack( S, 'O2: the same key with other content keeps the first message; nothing is overwritten', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1', { params: { body: 'approved text' } } ) );
	await _box.send( delivery( 'dl-1', { params: { body: 'changed text' }, target: 'press' } ) );
	assert.deepEqual( _box.messages( 'ceo' ).map( item => item.params.body ), [ 'approved text' ] );
	assert.deepEqual( _box.messages( 'press' ), [] );
} );

attack( S, 'O2: the same content under two keys is two messages', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1' ) );
	await _box.send( delivery( 'dl-2' ) );
	assert.equal( _box.messages( 'ceo' ).length, 2 );
} );

attacks( S, [
	{ name: 'O2: keys are compared exactly; another case is another key', a: 'dl-abc', b: 'DL-ABC' },
	{ name: 'O2: keys are compared exactly; a trailing space is another key', a: 'dl-abc', b: 'dl-abc ' },
	{ name: 'O2: keys are compared exactly; composed and decomposed umlauts are two keys', a: 'dl-ü', b: 'dl-ü' },
	{ name: 'O2: keys are compared exactly; a Cyrillic lookalike is another key', a: 'dl-a', b: 'dl-а' },
], async ( { a, b } ) => {
	const _box = box();
	await _box.send( delivery( a ) );
	await _box.send( delivery( b ) );
	assert.equal( rows( _box ).length, 2 );
	assert.ok( await _box.lookup( { id: a } ) );
	assert.ok( await _box.lookup( { id: b } ) );
} );

attack( S, 'O2: the database itself refuses a second row with the same key, whatever the code above it does', async () => {
	const _box = box();
	await _box.send( delivery() );
	assert.throws( () => _box.db.run( `INSERT INTO outbox ( id, idempotencyKey, action, target, params, time )
		VALUES ( 'msg-x', 'dl-1', 'reply', 'ceo', '{}', 't' )` ), /UNIQUE/ );
} );

attack( S, 'O2: two outboxes on the same ledger (a restarted gate) share the keys', async () => {
	const _db = new Db( ':memory:' );
	await new Outbox( _db ).send( delivery() );
	const _again = await new Outbox( _db ).send( delivery() );
	assert.equal( _again.receipt.repeated, true );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM outbox' ).n, 1 );
} );

attack( S, 'G-7b: a key sent before the gate stopped is still known after the file was reopened', async () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'gate-outbox-' ) );
	try {
		const _first = new Db( path.join( _dir, 'gate.db' ) );
		await new Outbox( _first ).send( delivery() );
		_first.close();
		const _second = new Db( path.join( _dir, 'gate.db' ) );
		const _box = new Outbox( _second );
		assert.equal( ( await _box.send( delivery() ) ).receipt.repeated, true );
		assert.equal( rows( _box ).length, 1 );
		_second.close();
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( S, 'O4: lookup finds a sent message by its key and marks the answer as reconciled', async () => {
	const _box = box();
	assert.equal( await _box.lookup( delivery() ), null );
	const _sent = await _box.send( delivery() );
	const _found = await _box.lookup( delivery() );
	assert.equal( _found.receipt.id, _sent.receipt.id );
	assert.equal( _found.receipt.reconciled, true );
} );

attack( S, 'O4: lookup never creates a message, and an unknown key stays unknown', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1' ) );
	assert.equal( await _box.lookup( delivery( 'dl-2' ) ), null );
	assert.equal( await _box.lookup( delivery( 'dl-2' ) ), null );
	assert.equal( rows( _box ).length, 1 );
} );

attack( S, 'O4: lookup of something without a key is never "found"', async () => {
	const _box = box();
	await _box.send( delivery() );
	const _found = await _box.lookup( {} ).catch( () => null );
	assert.equal( _found, null );
} );

attack( S, 'G-7b: answers lost after the message arrived lead to retries under the same key and still one message', async () => {
	const g = gate( { channel: null, service: {} } );
	const _lossy = new LostAnswers( g.db, 2 );
	const _with = restart( g, { channel: _lossy } );
	const _ok = await g.approved( reply( people( 12 ) ) );
	const _lease = _with.egress.lease( { node: 'w', move: 'm', contract: g.hash, minutes: 5 } );
	const _first = await _with.egress.redeem( { delivery: _ok.delivery, approval: _ok.approval, lease: _lease.id, fence: _lease.fence } );
	const _done = await settle( _with, _first.delivery );
	assert.equal( _done.status, 'executed' );
	assert.equal( _done.receipt.repeated, true );
	assert.equal( rows( _lossy ).length, 1 );
} );

attack( S, 'O4: after a crash with a lost answer the lookup confirms the one message instead of sending again', async () => {
	const g = gate( { plain: true, service: { answer: async ( item ) => {
		await new Outbox( g.db ).send( item );
		return new Promise( () => {} );
	} }, sendMs: 2 ** 31 - 1 } );
	const _ok = await g.approved( reply( people( 12 ) ) );
	g.redeem( _ok );
	await new Promise( resolve => setTimeout( resolve, 5 ) );
	const _after = restart( g, { plain: true } );
	await _after.egress.recover();
	assert.equal( _after.row( _ok.delivery ).status, 'executed' );
	assert.equal( _after.row( _ok.delivery ).receipt.reconciled, true );
	assert.equal( rows( _after.channel ).length, 1 );
} );

attack( S, 'messages(): only the messages of that recipient, with their params parsed', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1' ) );
	await _box.send( delivery( 'dl-2', { target: 'hr', params: { n: [ 1, { deep: true } ] } } ) );
	assert.deepEqual( _box.messages( 'hr' ).map( item => item.params ), [ { n: [ 1, { deep: true } ] } ] );
	assert.equal( _box.messages( 'ceo' ).length, 1 );
} );

attack( S, 'messages(): a message without recipient is filed under the empty recipient', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1', { target: undefined } ) );
	await _box.send( delivery( 'dl-2', { target: null } ) );
	assert.equal( _box.messages( '' ).length, 2 );
} );

attack( S, 'messages(): asking for no recipient at all is an empty answer, not a crash', async () => {
	const _box = box();
	await _box.send( delivery() );
	assert.deepEqual( _box.messages( undefined ), [] );
} );

attack( S, 'messages(): a thousand messages to one recipient come back complete and in the order they were sent', async () => {
	const _box = box();
	for ( let i = 0; i < 1000; i++ ) {
		await _box.send( delivery( `dl-${i}`, { params: { i } } ) );
	}
	const _all = _box.messages( 'ceo' );
	assert.equal( _all.length, 1000 );
	assert.deepEqual( _all.map( item => item.params.i ), Array.from( { length: 1000 }, ( _x, i ) => i ) );
} );

attack( S, 'receipts: message ids do not repeat over two thousand sends', async () => {
	const _box = box();
	const _ids = new Set();
	for ( let i = 0; i < 2000; i++ ) {
		_ids.add( ( await _box.send( delivery( `dl-${i}` ) ) ).receipt.id );
	}
	assert.equal( _ids.size, 2000 );
} );

attack( S, 'receipts: the time of a receipt is an ISO time', async () => {
	const _box = box();
	const { receipt } = await _box.send( delivery() );
	assert.equal( new Date( receipt.time ).toISOString(), receipt.time );
} );

attack( S, 'a send that cannot be stored (BigInt in params) stores nothing and does not block the next send', async () => {
	const _box = box();
	await assert.rejects( _box.send( delivery( 'dl-1', { params: { amount: 10n } } ) ) );
	assert.equal( rows( _box ).length, 0 );
	assert.equal( ( await _box.send( delivery( 'dl-1' ) ) ).ok, true );
	assert.equal( rows( _box ).length, 1 );
} );

attack( S, 'a send without a key is refused and stores nothing', async () => {
	const _box = box();
	await assert.rejects( _box.send( { action: 'reply', target: 'ceo', params: {} } ) );
	assert.equal( rows( _box ).length, 0 );
} );

attack( S, 'params with a __proto__ key stay data and pollute nothing', async () => {
	const _box = box();
	await _box.send( delivery( 'dl-1', { params: JSON.parse( '{ "__proto__": { "polluted": true }, "body": "x" }' ) } ) );
	const [ _message ] = _box.messages( 'ceo' );
	assert.equal( ( {} ).polluted, undefined );
	assert.equal( Object.hasOwn( _message.params, '__proto__' ), true );
} );

attack( S, 'params survive the outbox unchanged: unicode, nesting, big and tiny numbers', async () => {
	const _box = box();
	const _params = { text: 'Ünïcödé 😀 ‮x', list: [ [ [ 1 ] ], {}, null ], big: Number.MAX_SAFE_INTEGER, tiny: 5e-324, neg: -0.5 };
	await _box.send( delivery( 'dl-1', { params: _params } ) );
	assert.deepEqual( _box.messages( 'ceo' )[ 0 ].params, _params );
} );

attack( S, 'a hundred different keys sent at once give a hundred messages', async () => {
	const _box = box();
	await Promise.all( Array.from( { length: 100 }, ( _x, i ) => _box.send( delivery( `dl-${i}` ) ) ) );
	assert.equal( rows( _box ).length, 100 );
} );

const KEYS = hostile( 'strings' ).filter( ( _item, i ) => i % 2 === 1 );

attacks( S, KEYS.map( ( { label, value } ) => ( { name: `the key ${label} is stored once, found by lookup and repeated on a second send`, value } ) ),
	async ( { value } ) => {
		const _box = box();
		await _box.send( delivery( value ) );
		assert.equal( ( await _box.send( delivery( value ) ) ).receipt.repeated, true );
		assert.ok( await _box.lookup( { id: value } ) );
		assert.equal( _box.db.get( 'SELECT COUNT(*) AS n FROM outbox WHERE idempotencyKey = :k', { k: value } ).n, 1 );
	} );

attacks( S, hostile( 'strings' ).filter( ( _item, i ) => i % 4 === 0 ).map( ( { label, value } ) => ( { name: `the recipient ${label} gets exactly its own message`, value } ) ),
	async ( { value } ) => {
		const _box = box();
		await _box.send( delivery( 'dl-other', { target: 'someone else' } ) );
		await _box.send( delivery( 'dl-1', { target: value } ) );
		assert.equal( _box.messages( value ).filter( item => item.idempotencyKey === 'dl-1' ).length, 1 );
		assert.equal( _box.messages( 'someone else' ).length, value === 'someone else' ? 2 : 1 );
	} );
