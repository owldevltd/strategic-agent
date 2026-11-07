// Stress tests of core/knowledge/index.js against what a folder on disk can hold: directories named like files,
// unreadable files, links out of the folder and in circles, binary content, renamed files, and an index table from an
// older version. Knowledge is checked like everything else (9.1); nothing from outside the folder may come in as "own".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack } from '../hostile.mjs';
import { knowledge, tmp, tryIt, memoryDb, Index, Hash } from './rig.mjs';

const S = 'core/knowledge/index.js';

function folder( files ) {
	const _dir = tmp( 'kfiles-' );
	for ( const [ name, text ] of Object.entries( files ) ) {
		fs.mkdirSync( path.dirname( path.join( _dir, name ) ), { recursive: true } );
		fs.writeFileSync( path.join( _dir, name ), text );
	}
	return _dir;
}
const count = k => k.db.get( 'SELECT COUNT(*) AS n FROM knowledge' ).n;
const status = ( k, file ) => k.db.get( 'SELECT status FROM knowledge WHERE path = :path', { path: file } )?.status;

attack( S, 'a directory named like a knowledge file never stops the other files from being indexed', () => {
	const k = knowledge();
	const _dir = folder( { 'a.md': '# Alpha\n', 'z.md': '# Zulu\n' } );
	fs.mkdirSync( path.join( _dir, 'm.md' ) );
	const _run = tryIt( () => k.index.index( _dir, { scope: 'survey' } ) );
	assert.ok( !_run.error, `indexing stopped: ${_run.error?.message}` );
	assert.equal( count( k ), 2 );
} );

attack( S, 'an unreadable file never stops the other files from being indexed', ( t ) => {
	if ( process.getuid?.() === 0 ) {
		t.skip( 'root reads every file' );
		return;
	}
	const k = knowledge();
	const _dir = folder( { 'a.md': '# Alpha\n', 'locked.md': '# Locked\n', 'z.md': '# Zulu\n' } );
	fs.chmodSync( path.join( _dir, 'locked.md' ), 0o000 );
	try {
		const _run = tryIt( () => k.index.index( _dir, { scope: 'survey' } ) );
		assert.ok( !_run.error, `indexing stopped: ${_run.error?.message}` );
		assert.ok( count( k ) >= 2 );
	} finally {
		fs.chmodSync( path.join( _dir, 'locked.md' ), 0o600 );
	}
} );

attack( S, '10.4: a link out of the knowledge folder never brings a foreign file in as own knowledge', () => {
	const k = knowledge();
	const _secret = path.join( tmp( 'secret-' ), 'credentials.txt' );
	fs.writeFileSync( _secret, 'reporting secret API_KEY=abc123\n' );
	const _dir = folder( { 'a.md': '# Alpha\n' } );
	fs.symlinkSync( _secret, path.join( _dir, 'reporting.md' ) );
	k.index.index( _dir, { scope: 'survey' } );
	const _found = k.index.find( 'reporting secret', { scope: 'survey' } );
	assert.ok( !JSON.stringify( _found ).includes( 'abc123' ), 'a file outside the folder was handed on labelled own' );
} );

attack( S, 'a folder that links to itself is indexed once, not once per round through the circle', () => {
	const k = knowledge();
	const _dir = folder( { 'a.md': '# Alpha\n' } );
	fs.mkdirSync( path.join( _dir, 'sub' ) );
	fs.symlinkSync( _dir, path.join( _dir, 'sub', 'back' ) );
	const _started = Date.now();
	k.index.index( _dir, { scope: 'survey' } );
	assert.ok( Date.now() - _started < 2000 );
	assert.equal( count( k ), 1, `${count( k )} entries for one file` );
} );

attack( S, 'a binary file under a knowledge name is indexed without breaking anything, its summary bounded', () => {
	const k = knowledge();
	const _dir = folder( { 'a.md': '# Alpha\n' } );
	fs.writeFileSync( path.join( _dir, 'blob.md' ), Buffer.from( Array.from( { length: 5000 }, ( _x, i ) => ( i * 37 ) % 256 ) ) );
	k.index.index( _dir, { scope: 'survey' } );
	const _row = k.db.get( 'SELECT summary, status FROM knowledge WHERE path = :path', { path: path.join( _dir, 'blob.md' ) } );
	assert.ok( _row.summary.length <= 240 );
	assert.equal( _row.status, 'valid' );
	assert.ok( Array.isArray( k.index.find( 'blob alpha', { scope: 'survey' } ) ) );
} );

attack( S, 'G5: a changed byte is noticed even where the file is not valid text', () => {
	const k = knowledge();
	const _dir = folder( { 'blob.md': '# Blob\n' } );
	const _file = path.join( _dir, 'blob.md' );
	fs.writeFileSync( _file, Buffer.from( [ 0x23, 0x20, 0x42, 0x6c, 0x6f, 0x62, 0x0a, 0xff, 0x41 ] ) );
	k.index.index( _dir, { scope: 'survey' } );
	fs.writeFileSync( _file, Buffer.from( [ 0x23, 0x20, 0x42, 0x6c, 0x6f, 0x62, 0x0a, 0xfe, 0x41 ] ) );
	k.index.find( 'blob', { scope: 'survey' } );
	assert.equal( status( k, _file ), 'quarantined', 'the file changed and G5 handed it on' );
} );

attack( S, 'G5: a change far behind the summary and the excerpt is still noticed', () => {
	const k = knowledge();
	const _body = `# Rules\n\n${'filler paragraph.\n\n'.repeat( 3000 )}last line: groups of five.\n`;
	const _dir = folder( { 'rules.md': _body } );
	k.index.index( _dir, { scope: 'survey' } );
	fs.writeFileSync( path.join( _dir, 'rules.md' ), _body.replace( 'groups of five', 'groups of one' ) );
	assert.deepEqual( k.index.find( 'rules', { scope: 'survey' } ), [] );
	assert.equal( status( k, path.join( _dir, 'rules.md' ) ), 'quarantined' );
} );

attack( S, 'G5: a file emptied after indexing is quarantined', () => {
	const k = knowledge();
	const _dir = folder( { 'rules.md': '# Rules\nGroups of five.\n' } );
	k.index.index( _dir, { scope: 'survey' } );
	fs.writeFileSync( path.join( _dir, 'rules.md' ), '' );
	assert.deepEqual( k.index.find( 'rules', { scope: 'survey' } ), [] );
	assert.equal( status( k, path.join( _dir, 'rules.md' ) ), 'quarantined' );
} );

attack( S, 'a renamed file is a new entry; the old one is quarantined when asked for', () => {
	const k = knowledge();
	const _dir = folder( { 'rules.md': '# Rules\nGroups of five.\n' } );
	k.index.index( _dir, { scope: 'survey' } );
	fs.renameSync( path.join( _dir, 'rules.md' ), path.join( _dir, 'policy.md' ) );
	k.index.index( _dir, { scope: 'survey' } );
	assert.deepEqual( k.index.find( 'rules policy', { scope: 'survey', limit: 5 } ).map( entry => entry.path ), [ 'policy.md' ] );
	assert.equal( status( k, path.join( _dir, 'rules.md' ) ), 'quarantined' );
} );

attack( S, 'file names with spaces, unicode and quotes are indexed and found by their own name', () => {
	const k = knowledge();
	const _names = [ 'with space.md', 'Ünïcödé ß.txt', 'quote\'s "file".md', '😀 emoji.json' ];
	const _dir = folder( Object.fromEntries( _names.map( name => [ name, `# ${name}\nreporting\n` ] ) ) );
	assert.equal( k.index.index( _dir, { scope: 'survey' } ), 4 );
	const _found = k.index.find( 'with space ünïcödé quote file emoji json', { scope: 'survey', limit: 10 } ).map( entry => entry.path ).sort();
	assert.deepEqual( _found, [ ..._names ].sort() );
} );

attack( S, 'restart: a second index on the same store keeps every entry and every quarantine', () => {
	const k = knowledge( { key: 'one-key' } );
	const _dir = folder( { 'a.md': '# Alpha\n', 'b.md': '# Bravo\n' } );
	k.index.index( _dir, { scope: 'survey' } );
	fs.writeFileSync( path.join( _dir, 'b.md' ), '# Bravo changed\n' );
	k.index.find( 'bravo', { scope: 'survey' } );
	const _again = knowledge( { key: 'one-key', db: k.db } );
	_again.index.index( _dir, { scope: 'survey' } );
	assert.deepEqual( [ status( k, path.join( _dir, 'a.md' ) ), status( k, path.join( _dir, 'b.md' ) ) ], [ 'valid', 'quarantined' ] );
	assert.deepEqual( _again.index.find( 'alpha bravo', { scope: 'survey' } ).map( entry => entry.path ), [ 'a.md' ] );
} );

attack( S, 'G5: an index table from before labels gets the column, and its old entries pass G5 only after a release', () => {
	const _db = memoryDb();
	const k = knowledge( { key: 'legacy', db: _db } );
	_db.exec( 'DROP TABLE knowledge' );
	_db.exec( `CREATE TABLE knowledge ( path TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
		hash TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, time TEXT NOT NULL )` );
	const _dir = folder( { 'old.md': '# Old rules\n' } );
	const _file = path.join( _dir, 'old.md' );
	const _entry = { path: _file, scope: 'survey', kind: 'document', summary: 'Old rules', hash: Hash.sha256( '# Old rules\n' ) };
	_db.run( `INSERT INTO knowledge ( path, scope, kind, summary, hash, signature, status, time )
		VALUES ( :path, :scope, :kind, :summary, :hash, :signature, 'valid', 'then' )`, { ..._entry, signature: k.memory.sign( _entry ) } );
	const _index = new Index( _db, { sign: value => k.memory.sign( value ), verify: ( text, sig ) => k.memory.verify( text, sig ) } );
	assert.ok( _db.all( 'PRAGMA table_info( knowledge )' ).some( column => column.name === 'labels' ) );
	assert.deepEqual( _index.find( 'old rules', { scope: 'survey' } ), [], 'labels it was never signed with are not trusted' );
	_index.release( _file, { by: 'lead' } );
	assert.deepEqual( _index.find( 'old rules', { scope: 'survey' } ).map( entry => entry.labels ), [ [ 'own' ] ] );
} );

attack( S, 'index: a second index object never adds the labels column twice', () => {
	const _db = memoryDb();
	knowledge( { db: _db } );
	knowledge( { db: _db } );
	assert.equal( _db.all( 'PRAGMA table_info( knowledge )' ).filter( column => column.name === 'labels' ).length, 1 );
} );
