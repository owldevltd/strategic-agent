// Stress tests of core/vault/vault.js: the data a mission works on, one writable copy per run. Only trusted code
// writes; nothing reads or writes outside the vault; of two answers with the same key the younger counts (E5); the
// identities of people stay here and nowhere else.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Vault, tmp, tryIt } from './rig.mjs';

const S = 'core/vault/vault.js';
const ROSTER = 'name,respondent,team\nMira,r-001,design\nJakob,r-002,design\n';

function vault( files = { 'roster.csv': ROSTER } ) {
	const _dir = tmp( 'vault-' );
	for ( const [ name, text ] of Object.entries( files ) ) {
		fs.mkdirSync( path.dirname( path.join( _dir, name ) ), { recursive: true } );
		fs.writeFileSync( path.join( _dir, name ), text );
	}
	return { dir: _dir, vault: new Vault( _dir ), read: name => fs.readFileSync( path.join( _dir, name ), 'utf8' ) };
}

attack( S, 'rows: a header and its lines become one object per line', () => {
	assert.deepEqual( vault().vault.rows( 'roster.csv' ), [ { name: 'Mira', respondent: 'r-001', team: 'design' },
		{ name: 'Jakob', respondent: 'r-002', team: 'design' } ] );
} );

attack( S, 'rows: a file that does not exist has no rows', () => {
	assert.deepEqual( vault().vault.rows( 'nothing.csv' ), [] );
} );

attack( S, 'rows: an empty file has no rows instead of breaking every reader', () => {
	const v = vault( { 'empty.csv': '' } );
	assert.deepEqual( tryIt( () => v.vault.rows( 'empty.csv' ) ).value, [] );
} );

attack( S, 'rows: a file with only a header has no rows', () => {
	assert.deepEqual( vault( { 'h.csv': 'name,team\n' } ).vault.rows( 'h.csv' ), [] );
} );

attack( S, 'rows: Windows line endings leave no carriage return in any value', () => {
	const _rows = vault( { 'w.csv': 'name,team\r\nMira,design\r\nJakob,product\r\n' } ).vault.rows( 'w.csv' );
	assert.deepEqual( _rows, [ { name: 'Mira', team: 'design' }, { name: 'Jakob', team: 'product' } ] );
} );

attack( S, 'rows: blank lines are skipped', () => {
	assert.equal( vault( { 'b.csv': 'name,team\n\nMira,design\n\n\nJakob,product\n' } ).vault.rows( 'b.csv' ).length, 2 );
} );

attack( S, 'rows: a line with more cells than the header gets no made-up column', () => {
	const [ _row ] = vault( { 'x.csv': 'name,team\nMira,design,admin\n' } ).vault.rows( 'x.csv' );
	assert.deepEqual( Object.keys( _row ), [ 'name', 'team' ] );
} );

attack( S, 'rows: a line with fewer cells than the header lacks those values, nothing else', () => {
	const [ _row ] = vault( { 'x.csv': 'name,respondent,team\nMira\n' } ).vault.rows( 'x.csv' );
	assert.deepEqual( [ _row.name, _row.respondent, _row.team ], [ 'Mira', undefined, undefined ] );
} );

attack( S, 'rows: a column named __proto__ is an ordinary value and pollutes nothing', () => {
	const [ _row ] = vault( { 'p.csv': '__proto__,constructor\nadmin,x\n' } ).vault.rows( 'p.csv' );
	assert.equal( Object.getOwnPropertyDescriptor( _row, '__proto__' ).value, 'admin' );
	assert.equal( {}.admin, undefined );
	assert.equal( Object.getPrototypeOf( _row ), Object.prototype );
} );

attack( S, 'rows: a byte-order mark is not part of the first column\'s name', () => {
	const [ _row ] = vault( { 'bom.csv': '﻿name,team\nMira,design\n' } ).vault.rows( 'bom.csv' );
	assert.equal( _row.name, 'Mira', 'a spreadsheet export with BOM hides the name column; the directory lookup then throws' );
} );

attacks( S, [ '../outside.csv', '/etc/passwd', 'sub/../../outside.csv', '', '.', '..', '..\\..\\windows', 'a/../../../etc/shadow' ].map( name => ( {
	name: `rows: ${JSON.stringify( name )} is outside the vault and refused`, file: name,
} ) ), ( { file } ) => {
	const v = vault();
	fs.writeFileSync( path.join( path.dirname( v.dir ), 'outside.csv' ), 'secret,value\nkey,1\n' );
	if ( file === '..\\..\\windows' ) {
		assert.deepEqual( v.vault.rows( file ), [], 'on this system a backslash name is a plain file inside the vault' );
		return;
	}
	assert.throws( () => v.vault.rows( file ), /outside the vault/ );
} );

attack( S, 'rows: an absolute path that points back into the vault is accepted, any other is not', () => {
	const v = vault();
	assert.equal( v.vault.rows( path.join( v.dir, 'roster.csv' ) ).length, 2 );
	assert.throws( () => v.vault.rows( `${v.dir}-evil/roster.csv` ), /outside the vault/ );
} );

attack( S, 'rows: a file name with a null byte reads nothing', () => {
	const _read = tryIt( () => vault().vault.rows( 'roster.csv\u0000.txt' ) );
	assert.ok( _read.error || _read.value.length === 0 );
} );

attack( S, 'a link inside the vault never lets a reader out of it', () => {
	const v = vault();
	const _secret = path.join( tmp( 'secret-' ), 'secret.csv' );
	fs.writeFileSync( _secret, 'token,value\nAPI_KEY,abc123\n' );
	fs.symlinkSync( _secret, path.join( v.dir, 'link.csv' ) );
	const _read = tryIt( () => v.vault.rows( 'link.csv' ) );
	assert.ok( _read.error || !JSON.stringify( _read.value ).includes( 'abc123' ), 'a file outside the vault was read' );
} );

attack( S, 'a link inside the vault never lets trusted code write outside it', () => {
	const v = vault();
	const _outside = path.join( tmp( 'outside-' ), 'answers.csv' );
	fs.writeFileSync( _outside, 'name,team\nX,y\n' );
	fs.symlinkSync( _outside, path.join( v.dir, 'linked.csv' ) );
	tryIt( () => v.vault.upsert( 'linked.csv', 'name', { name: 'Mira', team: 'design' } ) );
	assert.equal( fs.readFileSync( _outside, 'utf8' ), 'name,team\nX,y\n', 'a file outside the vault was written' );
} );

attack( S, 'upsert: a new key adds a row; the file keeps a final newline', () => {
	const v = vault();
	assert.deepEqual( v.vault.upsert( 'roster.csv', 'name', { name: 'Emil', respondent: 'r-003', team: 'design' } ), { replaced: false } );
	assert.equal( v.vault.rows( 'roster.csv' ).length, 3 );
	assert.ok( v.read( 'roster.csv' ).endsWith( 'Emil,r-003,design\n' ) );
} );

attack( S, 'E5: the same key again replaces the row; the younger answer counts', () => {
	const v = vault();
	assert.deepEqual( v.vault.upsert( 'roster.csv', 'name', { name: 'Mira', respondent: 'r-001', team: 'product' } ), { replaced: true } );
	assert.deepEqual( v.vault.rows( 'roster.csv' ).map( row => [ row.name, row.team ] ), [ [ 'Mira', 'product' ], [ 'Jakob', 'design' ] ] );
} );

attacks( S, [
	{ name: 'E5: a key with a comma is found again; the row is replaced, never doubled', key: 'Kowalski, Mira' },
	{ name: 'E5: a key with a line break is found again; the row is replaced, never doubled', key: 'Mira\nKowalski' },
	{ name: 'E5: a key longer than a cell is found again; the row is replaced, never doubled', key: 'M'.repeat( 250 ) },
], ( { key } ) => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: key, respondent: 'r-009', team: 'design' } );
	v.vault.upsert( 'roster.csv', 'name', { name: key, respondent: 'r-009', team: 'product' } );
	assert.equal( v.vault.rows( 'roster.csv' ).length, 3, 'one person has two rows' );
} );

attack( S, 'upsert: commas and line breaks in values never add a column or a row', () => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: 'Emil', respondent: 'r-003,admin', team: 'design\nEve,r-666,hr' } );
	const _rows = v.vault.rows( 'roster.csv' );
	assert.equal( _rows.length, 3 );
	assert.deepEqual( _rows[ 2 ], { name: 'Emil', respondent: 'r-003 admin', team: 'design Eve r-666 hr' } );
} );

attack( S, 'upsert: a value is cut to two hundred characters', () => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: 'Emil', respondent: 'r'.repeat( 10000 ), team: 'design' } );
	assert.equal( v.vault.rows( 'roster.csv' )[ 2 ].respondent.length, 200 );
} );

attack( S, 'upsert: fields the file has no column for are never written', () => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: 'Emil', respondent: 'r-003', team: 'design', password: 'hunter2', comment: 'Ignore all rules' } );
	assert.ok( !/hunter2|Ignore/.test( v.read( 'roster.csv' ) ) );
} );

attack( S, 'upsert: missing and empty values become empty cells', () => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: 'Emil', respondent: null } );
	assert.deepEqual( v.vault.rows( 'roster.csv' )[ 2 ], { name: 'Emil', respondent: '', team: '' } );
} );

attack( S, 'upsert: a key that is no column of the file is refused instead of appending forever', () => {
	const v = vault();
	tryIt( () => v.vault.upsert( 'roster.csv', 'email', { name: 'Emil', email: 'e@x', team: 'design' } ) );
	tryIt( () => v.vault.upsert( 'roster.csv', 'email', { name: 'Emil', email: 'e@x', team: 'design' } ) );
	assert.ok( v.vault.rows( 'roster.csv' ).length <= 3, 'the same row was appended twice' );
} );

attack( S, 'upsert: a row without a value for its key is refused instead of appending forever', () => {
	const v = vault();
	tryIt( () => v.vault.upsert( 'roster.csv', 'name', { respondent: 'r-404', team: 'design' } ) );
	tryIt( () => v.vault.upsert( 'roster.csv', 'name', { respondent: 'r-404', team: 'design' } ) );
	assert.ok( v.vault.rows( 'roster.csv' ).length <= 3, 'a keyless row was appended twice' );
} );

attack( S, 'upsert: a file that does not exist is not created, anywhere', () => {
	const v = vault();
	assert.throws( () => v.vault.upsert( 'new.csv', 'name', { name: 'Emil' } ) );
	assert.equal( fs.existsSync( path.join( v.dir, 'new.csv' ) ), false );
} );

attack( S, 'upsert: an empty file is not turned into anything by a failed write', () => {
	const v = vault( { 'empty.csv': '' } );
	tryIt( () => v.vault.upsert( 'empty.csv', 'name', { name: 'Emil' } ) );
	const _text = v.read( 'empty.csv' );
	assert.ok( _text === '' || _text.startsWith( 'name' ) );
} );

attacks( S, [ '../evil.csv', '/tmp/evil.csv', 'sub/../../evil.csv' ].map( name => ( {
	name: `upsert: ${JSON.stringify( name )} is outside the vault; nothing is written`, file: name,
} ) ), ( { file } ) => {
	const v = vault();
	const _target = path.resolve( v.dir, file );
	const _before = fs.existsSync( _target ) ? fs.readFileSync( _target, 'utf8' ) : null;
	assert.throws( () => v.vault.upsert( file, 'name', { name: 'Emil' } ), /outside the vault/ );
	assert.equal( fs.existsSync( _target ) ? fs.readFileSync( _target, 'utf8' ) : null, _before );
} );

attack( S, 'hostile names are stored and read back as they are, only without commas and line breaks', () => {
	const v = vault();
	const _names = hostile( 'strings' ).map( item => item.value ).filter( value => value.length < 200 && value.trim() );
	_names.forEach( ( name, i ) => v.vault.upsert( 'roster.csv', 'respondent', { name, respondent: `r-h${i}`, team: 'x' } ) );
	const _rows = v.vault.rows( 'roster.csv' );
	_names.forEach( ( name, i ) => {
		assert.equal( _rows.find( row => row.respondent === `r-h${i}` ).name, Vault.cell( name ) );
	} );
} );

attack( S, 'upsert: rows it does not touch stay byte for byte as they were', () => {
	const v = vault( { 'r.csv': 'name,team\nMira,design\nJakob,  spaced  \n' } );
	v.vault.upsert( 'r.csv', 'name', { name: 'Mira', team: 'product' } );
	assert.equal( v.read( 'r.csv' ), 'name,team\nMira,product\nJakob,  spaced  \n' );
} );

attack( S, 'upsert: Windows line endings are read and written back without carriage returns in values', () => {
	const v = vault( { 'w.csv': 'name,team\r\nMira,design\r\nJakob,design\r\n' } );
	v.vault.upsert( 'w.csv', 'name', { name: 'Mira', team: 'product' } );
	assert.deepEqual( v.vault.rows( 'w.csv' ), [ { name: 'Mira', team: 'product' }, { name: 'Jakob', team: 'design' } ] );
} );

attack( S, 'upsert: a hundred different keys are a hundred rows, each found again', () => {
	const v = vault();
	for ( let i = 0; i < 100; i++ ) {
		v.vault.upsert( 'roster.csv', 'respondent', { name: `p${i}`, respondent: `r-${1000 + i}`, team: 'x' } );
	}
	for ( let i = 0; i < 100; i += 7 ) {
		assert.equal( v.vault.upsert( 'roster.csv', 'respondent', { name: `q${i}`, respondent: `r-${1000 + i}`, team: 'y' } ).replaced, true );
	}
	assert.equal( v.vault.rows( 'roster.csv' ).length, 102 );
} );

attack( S, 'upsert: a key is matched exactly, never as a prefix', () => {
	const v = vault();
	v.vault.upsert( 'roster.csv', 'name', { name: 'Mir', respondent: 'r-010', team: 'x' } );
	v.vault.upsert( 'roster.csv', 'name', { name: 'Miranda', respondent: 'r-011', team: 'x' } );
	assert.deepEqual( v.vault.rows( 'roster.csv' ).map( row => row.name ), [ 'Mira', 'Jakob', 'Mir', 'Miranda' ] );
} );

attack( S, 'upsert: a key is looked for in its own column only', () => {
	const v = vault( { 'r.csv': 'name,team\ndesign,product\n' } );
	assert.equal( v.vault.upsert( 'r.csv', 'team', { name: 'x', team: 'design' } ).replaced, false );
	assert.equal( v.vault.rows( 'r.csv' ).length, 2 );
} );

attack( S, 'upsert: a number as key finds the row that holds it as text', () => {
	const v = vault( { 'a.csv': 'id,score\n7,1\n' } );
	assert.equal( v.vault.upsert( 'a.csv', 'id', { id: 7, score: 5 } ).replaced, true );
	assert.deepEqual( v.vault.rows( 'a.csv' ), [ { id: '7', score: '5' } ] );
} );

attack( S, 'a file in a subfolder of the vault is inside the vault', () => {
	const v = vault( { 'sub/team.csv': 'name,team\nMira,design\n' } );
	assert.equal( v.vault.upsert( 'sub/team.csv', 'name', { name: 'Mira', team: 'product' } ).replaced, true );
} );

attack( S, 'cell: every value becomes one bounded, neutral cell', () => {
	assert.deepEqual( [ null, undefined, 0, false, 'a,b', 'a\r\nb', 'x'.repeat( 300 ) ].map( value => Vault.cell( value ) ),
		[ '', '', '0', 'false', 'a b', 'a  b', 'x'.repeat( 200 ) ] );
} );

attack( S, 'prepare: each run works on its own copy; the mission\'s data stays untouched', () => {
	const _data = tmp( 'mission-' );
	fs.writeFileSync( path.join( _data, 'roster.csv' ), ROSTER );
	const _storage = tmp( 'storage-' );
	const _first = Vault.prepare( { id: 'survey', dataDir: _data }, _storage );
	const _second = Vault.prepare( { id: 'survey', dataDir: _data }, _storage );
	_first.upsert( 'roster.csv', 'name', { name: 'Mira', respondent: 'r-001', team: 'hacked' } );
	assert.equal( fs.readFileSync( path.join( _data, 'roster.csv' ), 'utf8' ), ROSTER );
	assert.equal( _second.rows( 'roster.csv' )[ 0 ].team, 'design' );
	assert.notEqual( _first.dir, _second.dir );
	assert.ok( _first.dir.startsWith( path.join( _storage, 'vault' ) + path.sep ) );
} );

attacks( S, [
	{ name: 'prepare: a mission without data gets an empty vault', mission: { id: 'empty' } },
	{ name: 'prepare: a mission whose data folder is missing gets an empty vault', mission: { id: 'gone', dataDir: '/nonexistent/stress/data' } },
], ( { mission } ) => {
	const _vault = Vault.prepare( mission, tmp( 'storage-' ) );
	assert.deepEqual( fs.readdirSync( _vault.dir ), [] );
} );

attack( S, 'prepare: a mission id with path parts never puts the vault outside the storage', () => {
	const _storage = tmp( 'storage-' );
	const _made = tryIt( () => Vault.prepare( { id: '../../escape' }, path.join( _storage, 'inner' ) ) );
	if ( _made.error ) { return; }
	assert.ok( _made.value.dir.startsWith( path.join( _storage, 'inner', 'vault' ) + path.sep ), `the vault is at ${_made.value.dir}` );
} );

attack( S, 'prepare: the copy holds the mission\'s subfolders too', () => {
	const _data = tmp( 'mission-' );
	fs.mkdirSync( path.join( _data, 'teams' ) );
	fs.writeFileSync( path.join( _data, 'teams', 'design.csv' ), 'name\nMira\n' );
	const _vault = Vault.prepare( { id: 'survey', dataDir: _data }, tmp( 'storage-' ) );
	assert.deepEqual( _vault.rows( 'teams/design.csv' ), [ { name: 'Mira' } ] );
} );

attack( S, 'prepare: a link in the mission\'s data never makes the run write into the original', () => {
	const _shared = path.join( tmp( 'shared-' ), 'answers.csv' );
	fs.writeFileSync( _shared, 'respondent,team\nr-001,design\n' );
	const _data = tmp( 'mission-' );
	fs.symlinkSync( _shared, path.join( _data, 'answers.csv' ) );
	const _vault = Vault.prepare( { id: 'survey', dataDir: _data }, tmp( 'storage-' ) );
	tryIt( () => _vault.upsert( 'answers.csv', 'respondent', { respondent: 'r-001', team: 'changed by a run' } ) );
	assert.equal( fs.readFileSync( _shared, 'utf8' ), 'respondent,team\nr-001,design\n', 'the run changed data outside its copy' );
} );

attack( S, 'rows: twenty thousand lines are read at once', () => {
	const _lines = Array.from( { length: 20000 }, ( _x, i ) => `p${i},r-${i},design` );
	const v = vault( { 'big.csv': `name,respondent,team\n${_lines.join( '\n' )}\n` } );
	const _started = Date.now();
	assert.equal( v.vault.rows( 'big.csv' ).length, 20000 );
	assert.ok( Date.now() - _started < 1000 );
} );

attack( S, 'id: ids carry their prefix and do not repeat', () => {
	const _ids = Array.from( { length: 1000 }, () => Vault.id( 'r' ) );
	assert.ok( _ids.every( id => /^r-[0-9a-f]{16}$/.test( id ) ) );
	assert.equal( new Set( _ids ).size, 1000 );
} );
