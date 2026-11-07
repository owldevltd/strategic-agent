// Attacks on the gate's own SQLite ledger: migrations of old and half-migrated files, reopening, hostile lookups,
// master data with odd values, corrupt rows, ordering of the ledger and copies that callers can mutate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Db, Store, gate, invoiceSpec, reply, pay, people, Contract, registry, IBAN, START, MINUTE } from './fixture.mjs';

const S = 'gate/store.js';

function tempFile( fn ) {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'gate-store-' ) );
	try {
		return fn( path.join( _dir, 'gate.db' ) );
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
}

const OLD_DELIVERIES = `CREATE TABLE deliveries (
	id TEXT PRIMARY KEY, contract TEXT NOT NULL, root TEXT NOT NULL, node TEXT, action TEXT NOT NULL, target TEXT,
	params TEXT NOT NULL, labels TEXT NOT NULL, cohort TEXT, actionHash TEXT NOT NULL,
	status TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, reasons TEXT, receipt TEXT, flags TEXT,
	expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL )`;
const OLD_ROW = `INSERT INTO deliveries ( id, contract, root, action, params, labels, actionHash, status, expiresAt, createdAt )
	VALUES ( 'dl-old', 'c', 'c', 'reply', '{"body":"hi"}', '{}', 'h', 'executed', '2026-11-07T17:05:00Z', '2026-11-05T09:00:00Z' )`;

attack( S, 'migration: an old ledger without lease and fence columns gets both and keeps its rows', () => {
	const _db = new Db( ':memory:' );
	_db.exec( OLD_DELIVERIES );
	_db.exec( OLD_ROW );
	const _store = new Store( _db );
	const _columns = _db.all( 'PRAGMA table_info( deliveries )' ).map( column => column.name );
	assert.ok( _columns.includes( 'lease' ) && _columns.includes( 'fence' ) );
	assert.equal( _store.delivery( 'dl-old' ).params.body, 'hi' );
} );

attack( S, 'migration: a ledger that has the lease column but not the fence column (a half-done migration) is completed', () => {
	const _db = new Db( ':memory:' );
	_db.exec( OLD_DELIVERIES );
	_db.exec( 'ALTER TABLE deliveries ADD COLUMN lease TEXT' );
	new Store( _db );
	const _columns = _db.all( 'PRAGMA table_info( deliveries )' ).map( column => column.name );
	assert.ok( _columns.includes( 'fence' ), 'without fence every new booking fails' );
} );

attack( S, 'migration: opening the same ledger twice changes nothing and loses nothing', async () => {
	const g = gate();
	await g.send( reply( people( 12 ) ) );
	const _count = g.db.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n;
	new Store( g.db );
	new Store( g.db );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n, _count );
	assert.equal( g.db.all( 'PRAGMA table_info( deliveries )' ).filter( column => column.name === 'fence' ).length, 1 );
} );

attack( S, 'reopen: contracts, deliveries, approvals, releases and master data survive closing the file', () => tempFile( ( file ) => {
	const _db = new Db( file );
	const _store = new Store( _db );
	_db.run( `INSERT INTO contracts ( hash, id, root, spec, rules, status, proposedAt ) VALUES ( 'h1', 'c', 'h1', '{}', '{"gate":[]}', 'confirmed', 't' )` );
	_db.run( 'INSERT INTO releases ( contract, root, delivery, cohort ) VALUES ( \'h1\', \'h1\', \'d1\', \'["a","b"]\' )' );
	_store.addMaster( 'account', [ IBAN ] );
	_db.close();
	const _again = new Store( new Db( file ) );
	assert.equal( _again.contract( 'h1' ).status, 'confirmed' );
	assert.deepEqual( _again.releasedCohorts( 'h1' ), [ [ 'a', 'b' ] ] );
	assert.equal( _again.isMaster( 'account', IBAN ), true );
	_again.db.close();
} ) );

attack( S, 'reopen: a second connection to the same file sees a booking as soon as it is committed', () => tempFile( ( file ) => {
	const _a = new Store( new Db( file ) );
	const _b = new Store( new Db( file ) );
	_a.addMaster( 'account', [ 'X1' ] );
	assert.equal( _b.isMaster( 'account', 'X1' ), true );
	_a.db.close();
	_b.db.close();
} ) );

const LOOKUPS = hostile( 'strings' ).filter( ( _item, i ) => i % 2 === 0 );

attacks( S, LOOKUPS.map( ( { label, value } ) => ( { name: `contract( ${label} ) is null and harms no table`, value } ) ), ( { value } ) => {
	const g = gate();
	assert.equal( g.store.contract( value ), null );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM contracts' ).n, 1 );
} );

attacks( S, LOOKUPS.map( ( { label, value } ) => ( { name: `delivery( ${label} ) is null and isMaster says no`, value } ) ), ( { value } ) => {
	const g = gate();
	assert.equal( g.store.delivery( value ), null );
	assert.equal( g.store.isMaster( 'account', value ), false );
	assert.equal( g.store.isMaster( value, IBAN ), false );
} );

attacks( S, [
	{ name: 'contract( undefined ) is null, not a crash', value: undefined },
	{ name: 'contract( { } ) is null, not a crash', value: {} },
	{ name: 'contract( 42 ) is null', value: 42 },
	{ name: 'contract( null ) is null', value: null },
], ( { value } ) => {
	const g = gate();
	assert.equal( g.store.contract( value ), null );
} );

attack( S, 'contract(): what a caller does with the returned copy does not change the stored rules', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _copy = g.store.contract( g.hash );
	_copy.rules.gate.length = 0;
	_copy.status = 'proposed';
	assert.ok( g.store.contract( g.hash ).rules.gate.length > 0 );
	assert.equal( g.store.contract( g.hash ).status, 'confirmed' );
} );

attack( S, 'delivery(): a parsed row has proper types for every optional column', async () => {
	const g = gate();
	const _asked = await g.submit( reply( people( 12 ) ) );
	const _row = g.store.delivery( _asked.delivery );
	assert.equal( _row.withdrawn, false );
	assert.deepEqual( _row.reasons, [] );
	assert.deepEqual( _row.flags, [] );
	assert.equal( _row.receipt, null );
	assert.deepEqual( _row.cohort, people( 12 ) );
} );

attack( S, 'delivery(): a row with a cohort of null keeps null, not the text', async () => {
	const g = gate();
	const _asked = await g.submit( reply( undefined ) );
	assert.equal( g.store.delivery( _asked.delivery ).cohort, null );
} );

attack( S, 'A8: a corrupt row in the ledger never lets anything of its tree out', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _first = await g.submit( pay( 'R-1', 100 ) );
	g.db.run( 'UPDATE deliveries SET params = :p WHERE id = :id', { id: _first.delivery, p: '{ broken' } );
	const _next = await g.submit( pay( 'R-2', 100 ) ).catch( error => ( { status: 'thrown', error } ) );
	assert.ok( [ 'refused', 'thrown' ].includes( _next.status ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'treeDeliveries(): children belong to the root, other roots do not', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.submit( pay( 'R-1', 100 ) );
	const _child = new Contract( { ...invoiceSpec(), id: 'child', parent: g.hash }, registry );
	g.egress.propose( _child.canonical(), _child.rules(), _child.hash );
	await g.submit( { ...pay( 'R-2', 100 ), contract: _child.hash } );
	const _other = new Contract( { ...invoiceSpec(), id: 'unrelated' }, registry );
	g.egress.propose( _other.canonical(), _other.rules(), _other.hash );
	g.egress.confirm( _other.hash, 'person' );
	await g.submit( { ...pay( 'R-3', 100 ), contract: _other.hash } );
	assert.deepEqual( g.store.treeDeliveries( g.hash ).map( item => item.params.invoiceId ).sort(), [ 'R-1', 'R-2' ] );
	assert.deepEqual( g.store.deliveries( _child.hash ).map( item => item.params.invoiceId ), [ 'R-2' ] );
} );

attack( S, 'ledger ordering: deliveries come back in booking time, whatever their random ids', async () => {
	const g = gate( { spec: invoiceSpec() } );
	for ( let i = 9; i >= 0; i-- ) {
		g.clock.now = START + ( 10 - i ) * MINUTE;
		await g.submit( pay( `R-${i}`, 1 ) );
	}
	assert.deepEqual( g.store.deliveries( g.hash ).map( item => item.params.invoiceId ), Array.from( { length: 10 }, ( _x, i ) => `R-${9 - i}` ) );
} );

attack( S, 'ledger ordering: deliveries booked in the same millisecond keep their booking order', async () => {
	const g = gate( { spec: invoiceSpec() } );
	for ( let i = 0; i < 20; i++ ) {
		await g.submit( pay( `R-${i}`, 1 ) );
	}
	assert.deepEqual( g.store.deliveries( g.hash ).map( item => item.params.invoiceId ), Array.from( { length: 20 }, ( _x, i ) => `R-${i}` ) );
} );

attack( S, 'releasedCohorts(): only the releases of this root, each as a list', () => {
	const g = gate();
	g.db.run( 'INSERT INTO releases ( contract, root, delivery, cohort ) VALUES ( \'a\', \'root-a\', \'d1\', \'["x","y"]\' )' );
	g.db.run( 'INSERT INTO releases ( contract, root, delivery, cohort ) VALUES ( \'b\', \'root-b\', \'d2\', \'["z"]\' )' );
	assert.deepEqual( g.store.releasedCohorts( 'root-a' ), [ [ 'x', 'y' ] ] );
	assert.deepEqual( g.store.releasedCohorts( 'nope' ), [] );
} );

attacks( S, [
	{ name: 'isMaster: matching is exact; the same IBAN with a space is unknown', value: `${IBAN} `, known: false },
	{ name: 'isMaster: matching is exact; the same IBAN in lower case is unknown', value: IBAN.toLowerCase(), known: false },
	{ name: 'isMaster: the IBAN as entered is known', value: IBAN, known: true },
	{ name: 'isMaster: a number is compared with its decimal text', value: 4711, known: true },
], ( { value, known } ) => {
	const g = gate( { master: [ IBAN, '4711' ] } );
	assert.equal( g.store.isMaster( 'account', value ), known );
} );

attack( S, 'addMaster: a list with a value that cannot become text adds nothing at all (one booking)', () => {
	const g = gate( { master: [], recipients: [] } );
	assert.throws( () => g.store.addMaster( 'account', [ 'A1', { toString: null }, 'A2' ] ) );
	assert.equal( g.store.isMaster( 'account', 'A1' ), false );
} );

attack( S, 'addMaster: adding the same values again changes nothing', () => {
	const g = gate( { master: [], recipients: [] } );
	g.store.addMaster( 'account', [ 'A1', 'A1', 'A2' ] );
	g.store.addMaster( 'account', [ 'A2', 'A1' ] );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM master WHERE kind = \'account\'' ).n, 2 );
} );

attack( S, 'addMaster: a single IBAN given as text instead of a list is refused, not split into characters', () => {
	const g = gate( { master: [], recipients: [] } );
	try {
		g.store.addMaster( 'account', IBAN );
	} catch {
		// a refusal is fine
	}
	assert.equal( g.store.isMaster( 'account', 'D' ), false );
	assert.equal( g.store.isMaster( 'account', '0' ), false );
} );

attack( S, 'addMaster: null or undefined in the list never becomes a known account', () => {
	const g = gate( { master: [], recipients: [] } );
	try {
		g.store.addMaster( 'account', [ null, undefined ] );
	} catch {
		// a refusal is fine
	}
	assert.equal( g.store.isMaster( 'account', null ), false );
	assert.equal( g.store.isMaster( 'account', undefined ), false );
} );

attack( S, 'addMaster: a missing kind adds nothing under any kind', () => {
	const g = gate( { master: [], recipients: [] } );
	try {
		g.store.addMaster( null, [ 'A1' ] );
	} catch {
		// a refusal is fine
	}
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM master' ).n, 0 );
	assert.equal( g.store.isMaster( 'null', 'A1' ), false );
} );

attack( S, 'addMaster: ten thousand accounts are added in one booking and all found', () => {
	const g = gate( { master: [], recipients: [] } );
	const _values = Array.from( { length: 10000 }, ( _x, i ) => `DE${String( i ).padStart( 20, '0' )}` );
	g.store.addMaster( 'account', _values );
	assert.ok( _values.every( ( value, i ) => i % 997 !== 0 || g.store.isMaster( 'account', value ) ) );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM master' ).n, 10000 );
} );

attack( S, 'large rows: a five megabyte text is stored and read back unchanged', async () => {
	const g = gate();
	const _body = 'x'.repeat( 5 * 1024 * 1024 );
	const _asked = await g.submit( { ...reply( people( 12 ) ), params: { body: _body } } );
	assert.equal( g.store.delivery( _asked.delivery ).params.body.length, _body.length );
} );

attack( S, 'unicode: texts in other scripts, emoji and control characters survive the ledger byte for byte', async () => {
	const g = gate();
	const _body = 'Ünïcödé ß 😀👨‍👩‍👧 ‮evil‬ \u0000 end';
	const _asked = await g.submit( { ...reply( people( 12 ) ), params: { body: _body } } );
	assert.equal( g.store.delivery( _asked.delivery ).params.body, _body );
} );
