// gate/store.js: master data with a scope and a source. A value serves the goals of its mission kind and, when the
// operator gave it for every goal, all of them; what the mission folders bring is replaced at every start, so a value a
// folder dropped is revoked; a person takes values back. An older ledger keeps what it held, for every goal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { Db, Store, startGate, quiet } from './fixture.mjs';

const S = 'gate/store.js';
const MAIN = 'gate/main.js';
const store = () => new Store( new Db( ':memory:' ) );

attacks( S, [
	{ name: 'scope: a value for one mission kind serves its goals', added: 'payments', asked: 'payments', want: true },
	{ name: 'scope: a value for one mission kind serves no other kind', added: 'payments', asked: 'survey', want: false },
	{ name: 'scope: a value for one kind serves no goal without a kind', added: 'payments', asked: undefined, want: false },
	{ name: 'scope: a value for every goal serves every kind', added: undefined, asked: 'survey', want: true },
	{ name: 'scope: a value for every goal serves a goal without a kind', added: undefined, asked: undefined, want: true },
	{ name: 'scope: a kind of blanks is every goal', added: '   ', asked: 'survey', want: true },
	{ name: 'scope: a kind that is no text is every goal, never a kind of its own', added: { kind: 'payments' }, asked: 'survey', want: true },
	{ name: 'scope: asking for "*" is no wildcard for scoped values', added: 'payments', asked: '*', want: false },
], ( { added, asked, want } ) => {
	const _store = store();
	_store.addMaster( 'account', [ 'DE01' ], { scope: added } );
	assert.equal( _store.isMaster( 'account', 'DE01', asked ), want );
} );

attack( S, 'scope: the addresses of a contact are those of its kind and of every goal', () => {
	const _store = store();
	_store.addMaster( 'contact', [ 'C1 a@one.example' ], { scope: 'dunning' } );
	_store.addMaster( 'contact', [ 'C2 b@two.example' ] );
	assert.deepEqual( _store.addresses( 'C1', 'dunning' ), [ 'a@one.example' ] );
	assert.deepEqual( _store.addresses( 'C1', 'survey' ), [] );
	assert.deepEqual( _store.addresses( 'C2', 'survey' ), [ 'b@two.example' ] );
} );

attack( S, 'scope: one address on file for a kind and for every goal is still one address', () => {
	const _store = store();
	_store.addMaster( 'contact', [ 'C1 a@one.example' ], { scope: 'dunning' } );
	_store.addMaster( 'contact', [ 'C1 a@one.example' ] );
	assert.deepEqual( _store.addresses( 'C1', 'dunning' ), [ 'a@one.example' ] );
} );

attack( S, 'revoke: a value taken back serves nobody, and the count says how many were on file', () => {
	const _store = store();
	_store.addMaster( 'account', [ 'DE01', 'DE02' ] );
	assert.equal( _store.revokeMaster( 'account', [ 'DE01', 'DE09' ] ), 1 );
	assert.deepEqual( [ _store.isMaster( 'account', 'DE01' ), _store.isMaster( 'account', 'DE02' ) ], [ false, true ] );
} );

attack( S, 'revoke: taking a value back for every goal leaves the one of a kind', () => {
	const _store = store();
	_store.addMaster( 'account', [ 'DE01' ], { scope: 'payments' } );
	_store.addMaster( 'account', [ 'DE01' ] );
	_store.revokeMaster( 'account', [ 'DE01' ] );
	assert.deepEqual( [ _store.isMaster( 'account', 'DE01', 'payments' ), _store.isMaster( 'account', 'DE01', 'survey' ) ], [ true, false ] );
} );

attacks( S, [
	{ name: 'revoke: values that are no list are refused as a whole', kind: 'account', values: 'DE01' },
	{ name: 'revoke: a value that is no text is refused as a whole', kind: 'account', values: [ 'DE01', null ] },
	{ name: 'revoke: without a kind nothing is revoked', kind: '', values: [ 'DE01' ] },
], ( { kind, values } ) => {
	const _store = store();
	_store.addMaster( 'account', [ 'DE01' ] );
	assert.throws( () => _store.revokeMaster( kind, values ), TypeError );
	assert.equal( _store.isMaster( 'account', 'DE01' ), true );
} );

attack( S, 'load: what the folders bring replaces what they brought; what a person added stays', () => {
	const _store = store();
	_store.loadMaster( [ { scope: 'payments', kind: 'account', values: [ 'DE01', 'DE02' ] } ] );
	_store.addMaster( 'account', [ 'DE77' ] );
	_store.loadMaster( [ { scope: 'payments', kind: 'account', values: [ 'DE02' ] } ] );
	assert.deepEqual( [ 'DE01', 'DE02', 'DE77' ].map( value => _store.isMaster( 'account', value, 'payments' ) ), [ false, true, true ] );
} );

attack( S, 'load: a broken entry loads nothing, and what was there stays', () => {
	const _store = store();
	_store.loadMaster( [ { scope: 'payments', kind: 'account', values: [ 'DE01' ] } ] );
	assert.throws( () => _store.loadMaster( [ { scope: 'payments', kind: 'account', values: [ 'DE02' ] }, { scope: 'x', kind: 'account', values: 'DE03' } ] ) );
	assert.deepEqual( [ _store.isMaster( 'account', 'DE01', 'payments' ), _store.isMaster( 'account', 'DE02', 'payments' ) ], [ true, false ] );
} );

attack( S, 'migration: a ledger from before scopes keeps every value, for every goal, once', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE master ( kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY ( kind, value ) )' );
	_db.run( 'INSERT INTO master ( kind, value ) VALUES ( \'account\', \'DE01\' )' );
	const _store = new Store( _db );
	assert.equal( _store.isMaster( 'account', 'DE01', 'anything' ), true );
	new Store( _db );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM master' ).n, 1, 'a second start migrates nothing again' );
} );

// The gate process reads the master data of the mission folders at its start.
let silence = null;
const dirs = [];
after( () => {
	silence?.restore();
	dirs.forEach( dir => fs.rmSync( dir, { recursive: true, force: true } ) );
} );

// A folder of missions: { id: { mission: {...}, files: { name: value } } }, used as AGENCY_MISSIONS for one gate start.
async function gateWith( missions, dir = null ) {
	silence = silence || quiet();
	const _dir = dir || fs.mkdtempSync( path.join( process.env.TMPDIR || '/tmp', 'missions-' ) );
	if ( !dir ) { dirs.push( _dir ); }
	for ( const [ id, { mission, files = {} } ] of Object.entries( missions ) ) {
		fs.mkdirSync( path.join( _dir, id ), { recursive: true } );
		fs.writeFileSync( path.join( _dir, id, 'mission.json' ), JSON.stringify( { id, ...mission } ) );
		for ( const [ name, value ] of Object.entries( files ) ) {
			fs.writeFileSync( path.join( _dir, id, name ), JSON.stringify( value ) );
		}
	}
	const _before = process.env.AGENCY_MISSIONS;
	process.env.AGENCY_MISSIONS = _dir;
	try {
		return { gate: await startGate(), dir: _dir };
	} finally {
		if ( _before === undefined ) { delete process.env.AGENCY_MISSIONS; } else { process.env.AGENCY_MISSIONS = _before; }
	}
}

attack( MAIN, 'start: the file mission.json names under "master" is read, for the goals of the mission\'s kind', async () => {
	const _files = { 'accounts.json': { account: [ 'DE10' ] } };
	const { gate } = await gateWith( { pay: { mission: { kind: 'acme-pay', master: 'accounts.json' }, files: _files } } );
	try {
		assert.deepEqual( [ gate.main.store.isMaster( 'account', 'DE10', 'acme-pay' ), gate.main.store.isMaster( 'account', 'DE10', 'other' ) ], [ true, false ] );
	} finally {
		await gate.stop();
	}
} );

attack( MAIN, 'start: without a kind the mission\'s id is its kind', async () => {
	const { gate } = await gateWith( { refunds: { mission: {}, files: { 'master.json': { method: [ 'card-1' ] } } } } );
	try {
		assert.equal( gate.main.store.isMaster( 'method', 'card-1', 'refunds' ), true );
	} finally {
		await gate.stop();
	}
} );

attacks( MAIN, [
	{ name: 'start: a master file outside the mission folder is refused', master: '../other/master.json' },
	{ name: 'start: a master file given as an absolute path is refused', master: '/etc/passwd' },
	{ name: 'start: a master file that is no name is refused', master: [ 'master.json' ] },
], async ( { master } ) => {
	await assert.rejects( gateWith( { bad: { mission: { master } } } ), /"master" names a file next to mission\.json/ );
} );

attack( MAIN, 'start: a value the folder no longer holds is revoked at the next start', async () => {
	const _first = await gateWith( { pay: { mission: { kind: 'acme-pay' }, files: { 'master.json': { account: [ 'DE10', 'DE11' ] } } } } );
	await _first.gate.stop( { keep: true } );
	fs.writeFileSync( path.join( _first.dir, 'pay', 'master.json' ), JSON.stringify( { account: [ 'DE11' ] } ) );
	const _process = process.env.AGENCY_MISSIONS;
	process.env.AGENCY_MISSIONS = _first.dir;
	const { Main } = await import( './fixture.mjs' );
	const _second = new Main( { storageDir: _first.gate.dir, gate: { port: 0, host: '127.0.0.1', bufferMinutes: 5 } } );
	try {
		await _second.start();
		assert.deepEqual( [ 'DE10', 'DE11' ].map( value => _second.store.isMaster( 'account', value, 'acme-pay' ) ), [ false, true ] );
	} finally {
		if ( _process === undefined ) { delete process.env.AGENCY_MISSIONS; } else { process.env.AGENCY_MISSIONS = _process; }
		await _second.stop();
		_second.db.close();
		fs.rmSync( _first.gate.dir, { recursive: true, force: true } );
	}
} );
