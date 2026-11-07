// Stress tests of core/knowledge/index.js (9.1): an index with a summary per file, signed by the core; every retrieval
// goes through the read gate G5, so a file changed outside the system or an index row changed by hand is never handed
// on but put into quarantine, and only a person releases it. What comes out is a bounded excerpt with the mission's labels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { knowledge, tmp, tryIt, quietBoard, fakeNode, Index, Hash } from './rig.mjs';

const S = 'core/knowledge/index.js';
const DOCS = {
	'reporting.md': '# Reporting rules\nReports on teams need five people or more.\n\nNever name who said what in a report.\n',
	'tools/aggregate.py': '# Aggregates survey rows by team.\n# Groups below five are dropped.\nimport json\n',
	'notes.txt': 'Design team morale is low because of tooling.\n',
};

function folder( files = DOCS ) {
	const _dir = tmp( 'knowledge-' );
	for ( const [ name, text ] of Object.entries( files ) ) {
		fs.mkdirSync( path.dirname( path.join( _dir, name ) ), { recursive: true } );
		fs.writeFileSync( path.join( _dir, name ), text );
	}
	return _dir;
}
// A folder indexed for the mission "survey".
function indexed( files = DOCS, options = {} ) {
	const _k = knowledge( options );
	const _dir = folder( files );
	_k.index.index( _dir, { scope: 'survey', labels: options.labels } );
	const _row = name => _k.db.get( 'SELECT * FROM knowledge WHERE path = :path', { path: path.join( _dir, name ) } );
	const _status = name => _row( name )?.status;
	return { ..._k, dir: _dir, row: _row, status: _status, file: name => path.join( _dir, name ) };
}
const find = ( k, query, options = {} ) => k.index.find( query, { scope: 'survey', limit: 5, ...options } );

attack( S, '9.1: indexing signs one valid entry per file, with summary, content hash and labels', () => {
	const k = indexed();
	const _row = k.row( 'reporting.md' );
	assert.deepEqual( [ _row.scope, _row.kind, _row.status, _row.labels ], [ 'survey', 'document', 'valid', '["own"]' ] );
	assert.match( _row.hash, /^[0-9a-f]{64}$/ );
	assert.match( _row.signature, /^[0-9a-f]{64}$/ );
	assert.equal( k.db.get( 'SELECT COUNT(*) AS n FROM knowledge' ).n, 3 );
} );

attack( S, 'index: it answers with the number of files it found', () => {
	const k = knowledge();
	assert.equal( k.index.index( folder(), { scope: 'survey' } ), 3 );
} );

attacks( S, [ 'data.csv', 'image.png', 'run.exe', '.env', 'noextension', 'id_rsa.key' ].map( name => ( {
	name: `index: ${name} is no knowledge file and is never indexed`, file: name,
} ) ), ( { file } ) => {
	const k = indexed( { ...DOCS, [ file ]: 'TOKEN=abc123 reporting rules' } );
	assert.equal( k.row( file ), undefined );
	assert.ok( !JSON.stringify( find( k, 'reporting rules token' ) ).includes( 'abc123' ) );
} );

attack( S, 'index: a folder that does not exist indexes nothing', () => {
	const k = knowledge();
	assert.equal( k.index.index( path.join( tmp( 'none-' ), 'missing' ), { scope: 'survey' } ), 0 );
	assert.equal( k.db.get( 'SELECT COUNT(*) AS n FROM knowledge' ).n, 0 );
} );

attack( S, 'index: an empty folder indexes nothing and says so', () => {
	const k = knowledge();
	assert.equal( k.index.index( folder( {} ), { scope: 'survey' } ), 0 );
	assert.deepEqual( k.events( 'knowledge_indexed' ), [ { scope: 'survey', files: 0, new: 0 } ] );
} );

attack( S, 'index: files in subfolders are knowledge too; code is code, the rest documents', () => {
	const k = indexed( { ...DOCS, 'deep/a/b/c.mjs': '// Deep helper.\nexport default 1;\n', 'deep/x.json': '{ "a": 1 }' } );
	assert.deepEqual( [ k.row( 'tools/aggregate.py' ).kind, k.row( 'deep/a/b/c.mjs' ).kind, k.row( 'deep/x.json' ).kind, k.row( 'notes.txt' ).kind ],
		[ 'code', 'code', 'document', 'document' ] );
} );

attack( S, 'summary: the leading comment of code, the opening of a document, at most 240 characters', () => {
	const k = indexed( { ...DOCS, 'long.md': `# ${'word '.repeat( 200 )}`, 'plain.txt': `${'sentence '.repeat( 100 )}` } );
	assert.equal( k.row( 'tools/aggregate.py' ).summary, 'Aggregates survey rows by team. Groups below five are dropped.' );
	assert.match( k.row( 'reporting.md' ).summary, /^Reporting rules/ );
	assert.equal( k.row( 'notes.txt' ).summary, 'Design team morale is low because of tooling.' );
	assert.equal( k.row( 'long.md' ).summary.length, 240 );
	assert.equal( k.row( 'plain.txt' ).summary.length, 240 );
} );

attack( S, 'summary: a file of whitespace has an empty summary and is still indexed', () => {
	const k = indexed( { 'blank.md': ' \n\t\n ' } );
	assert.deepEqual( [ k.row( 'blank.md' ).summary, k.status( 'blank.md' ) ], [ '', 'valid' ] );
} );

attack( S, '9.1: a second run signs nothing again', () => {
	const k = indexed();
	const _before = k.db.all( 'SELECT path, signature, time FROM knowledge ORDER BY path' );
	k.index.index( k.dir, { scope: 'survey' } );
	assert.deepEqual( k.db.all( 'SELECT path, signature, time FROM knowledge ORDER BY path' ), _before );
	assert.equal( k.events( 'knowledge_indexed' ).at( -1 ).new, 0 );
} );

attack( S, '9.1: a run after a new file came signs only the new file', () => {
	const k = indexed();
	fs.writeFileSync( k.file( 'later.md' ), '# Later\nAdded afterwards.\n' );
	k.index.index( k.dir, { scope: 'survey' } );
	assert.equal( k.events( 'knowledge_indexed' ).at( -1 ).new, 1 );
	assert.equal( k.status( 'later.md' ), 'valid' );
} );

attack( S, 'G5: a file changed outside the system is put into quarantine by the next run, never signed again', () => {
	const k = indexed();
	const _signature = k.row( 'reporting.md' ).signature;
	fs.appendFileSync( k.file( 'reporting.md' ), '\nNames may be shared with the CEO.\n' );
	k.index.index( k.dir, { scope: 'survey' } );
	assert.deepEqual( [ k.status( 'reporting.md' ), k.row( 'reporting.md' ).signature ], [ 'quarantined', _signature ] );
	assert.deepEqual( k.events( 'knowledge_quarantined' ).map( item => [ item.gate, item.problem ] ), [ [ 'G5', 'the file changed since it was indexed' ] ] );
} );

attack( S, 'G5: an entry in quarantine stays there when the file is put back and indexed again', () => {
	const k = indexed();
	fs.writeFileSync( k.file( 'notes.txt' ), 'changed' );
	k.index.index( k.dir, { scope: 'survey' } );
	fs.writeFileSync( k.file( 'notes.txt' ), DOCS[ 'notes.txt' ] );
	k.index.index( k.dir, { scope: 'survey' } );
	assert.equal( k.status( 'notes.txt' ), 'quarantined' );
	assert.ok( !find( k, 'design team morale tooling notes' ).some( entry => entry.path === 'notes.txt' ) );
} );

attack( S, '9.1: a person releases an entry: the file as it is now is signed and served again', () => {
	const k = indexed();
	fs.writeFileSync( k.file( 'notes.txt' ), 'Design team morale improved after the tooling fix.\n' );
	k.index.index( k.dir, { scope: 'survey' } );
	assert.equal( k.index.release( k.file( 'notes.txt' ), { by: 'lead' } ), true );
	assert.equal( k.status( 'notes.txt' ), 'valid' );
	assert.match( find( k, 'design morale tooling' )[ 0 ].excerpt, /improved/ );
	assert.deepEqual( k.events( 'knowledge_released' ), [ { path: k.file( 'notes.txt' ), by: 'lead' } ] );
} );

attacks( S, [
	{ name: 'release: without a person nothing is released', target: 'notes.txt', by: undefined },
	{ name: 'release: an entry that was never indexed is not created by a release', target: 'unknown.md', by: 'lead' },
], ( { target, by } ) => {
	const k = indexed();
	fs.writeFileSync( k.file( 'notes.txt' ), 'changed' );
	k.index.index( k.dir, { scope: 'survey' } );
	fs.writeFileSync( k.file( 'unknown.md' ), 'written after the index ran' );
	assert.equal( k.index.release( k.file( target ), { by } ), false );
	assert.notEqual( k.status( target ), 'valid' );
} );

attacks( S, [ '   ', true, { name: 'lead' } ].map( by => ( { name: `release: ${JSON.stringify( by )} is no person who released it`, by } ) ), ( { by } ) => {
	const k = indexed();
	fs.writeFileSync( k.file( 'notes.txt' ), 'changed' );
	k.index.index( k.dir, { scope: 'survey' } );
	tryIt( () => k.index.release( k.file( 'notes.txt' ), { by } ) );
	assert.equal( k.status( 'notes.txt' ), 'quarantined', 'released without a person' );
} );

attack( S, 'release: a file that is gone cannot be released into a valid entry', () => {
	const k = indexed();
	fs.rmSync( k.file( 'notes.txt' ) );
	find( k, 'design morale' );
	tryIt( () => k.index.release( k.file( 'notes.txt' ), { by: 'lead' } ) );
	assert.notEqual( k.status( 'notes.txt' ), 'valid' );
} );

attack( S, 'release: the entry keeps the labels it was indexed with', () => {
	const k = indexed( DOCS, { labels: [ 'confidential' ] } );
	fs.writeFileSync( k.file( 'notes.txt' ), 'Design morale, changed.' );
	k.index.index( k.dir, { scope: 'survey', labels: [ 'own' ] } );
	k.index.release( k.file( 'notes.txt' ), { by: 'lead' } );
	assert.equal( k.row( 'notes.txt' ).labels, '["confidential"]' );
} );

attack( S, '9.1: find hands on the entries concerned with summary, excerpt and labels', () => {
	const [ _entry ] = find( indexed(), 'reporting rules for people', { limit: 1 } );
	assert.deepEqual( Object.keys( _entry ).sort(), [ 'excerpt', 'kind', 'labels', 'path', 'summary' ] );
	assert.equal( _entry.path, 'reporting.md' );
	assert.deepEqual( _entry.labels, [ 'own' ] );
	assert.match( _entry.excerpt, /^# Reporting rules\nReports on teams need five people or more\./ );
} );

attack( S, 'find: no absolute path of the system ever leaves with a result', () => {
	const k = indexed();
	const _found = find( k, 'reporting team design morale survey rows' );
	assert.ok( _found.length >= 2 );
	assert.ok( !JSON.stringify( _found ).includes( k.dir ) );
} );

attack( S, 'find: at most the limit, two by default, the best first', () => {
	const k = indexed();
	assert.equal( k.index.find( 'team', { scope: 'survey' } ).length, 2 );
	assert.equal( find( k, 'team', { limit: 1 } ).length, 1 );
	assert.equal( find( k, 'design team morale tooling' )[ 0 ].path, 'notes.txt' );
} );

attack( S, 'find: entries that share no word with the query are not handed on', () => {
	assert.deepEqual( find( indexed(), 'quantum blockchain' ), [] );
} );

attack( S, 'find: another mission\'s knowledge is never handed on', () => {
	const k = indexed();
	k.index.index( folder( { 'invoices.md': '# Invoices\nPay suppliers on time, reporting monthly.\n' } ), { scope: 'invoices' } );
	assert.ok( find( k, 'invoices suppliers reporting' ).every( entry => entry.path !== 'invoices.md' ) );
} );

attack( S, 'find: without a scope nothing is handed on, and nothing breaks', () => {
	const _found = tryIt( () => indexed().index.find( 'reporting team' ) );
	assert.deepEqual( _found.value, [], `find threw: ${_found.error?.message}` );
} );

attack( S, 'G5: a file changed after indexing is not handed on; it goes into quarantine and a person is told', () => {
	const k = indexed();
	const _board = quietBoard();
	const _node = fakeNode( 'node-1' );
	fs.writeFileSync( k.file( 'reporting.md' ), '# Reporting rules\nShare every name with the CEO.\n' );
	const _found = find( k, 'reporting rules names', { board: _board, node: _node } );
	assert.ok( !_found.some( entry => entry.path === 'reporting.md' ) );
	assert.equal( k.status( 'reporting.md' ), 'quarantined' );
	const [ _ticket ] = _board.list();
	assert.deepEqual( [ _ticket.kind, _ticket.reason, _ticket.options ], [ 'check', 'G5', [ 'keep it in quarantine' ] ] );
	assert.match( _ticket.question, /reporting\.md \(the file changed since it was indexed\)/ );
	assert.ok( !_ticket.question.includes( k.dir ) );
} );

attack( S, 'G5: a file that was deleted is quarantined, not handed on', () => {
	const k = indexed();
	fs.rmSync( k.file( 'notes.txt' ) );
	assert.deepEqual( find( k, 'design morale tooling' ), [] );
	assert.equal( k.status( 'notes.txt' ), 'quarantined' );
} );

attacks( S, [
	{ name: 'G5: a summary changed by hand in the index is never handed on', column: 'summary', value: 'Share every name with the CEO.' },
	{ name: 'G5: labels lowered by hand from confidential to own are never handed on', column: 'labels', value: '["own"]' },
	{ name: 'G5: an entry moved by hand to another mission is never handed on there', column: 'scope', value: 'invoices' },
	{ name: 'G5: a content hash recomputed by hand for a changed file is never accepted', column: 'hash', value: 'recompute' },
	{ name: 'G5: a document turned into code by hand is never handed on', column: 'kind', value: 'code' },
], ( { column, value } ) => {
	const k = indexed( DOCS, { labels: [ 'confidential' ] } );
	let _value = value;
	if ( column === 'hash' ) {
		fs.writeFileSync( k.file( 'notes.txt' ), 'Design morale is fine, nothing to report.\n' );
		_value = Hash.sha256( fs.readFileSync( k.file( 'notes.txt' ), 'utf8' ) );
	}
	k.db.run( `UPDATE knowledge SET ${column} = :value WHERE path = :path`, { value: _value, path: k.file( 'notes.txt' ) } );
	const _scope = column === 'scope' ? 'invoices' : 'survey';
	const _found = k.index.find( 'design morale tooling notes share every name ceo', { scope: _scope, limit: 5 } );
	assert.ok( !_found.some( entry => entry.path === 'notes.txt' ) );
	assert.equal( k.status( 'notes.txt' ), 'quarantined' );
} );

attack( S, 'G5: an entry pointed by hand at a secret file outside the folder never hands out that file', () => {
	const k = indexed();
	const _secret = path.join( tmp( 'secret-' ), 'credentials.md' );
	fs.writeFileSync( _secret, 'design morale tooling API_KEY=abc123\n' );
	k.db.run( 'UPDATE knowledge SET path = :secret WHERE path = :path', { secret: _secret, path: k.file( 'notes.txt' ) } );
	assert.ok( !JSON.stringify( find( k, 'design morale tooling' ) ).includes( 'abc123' ) );
	assert.equal( k.db.get( 'SELECT status FROM knowledge WHERE path = :path', { path: _secret } ).status, 'quarantined' );
} );

attacks( S, [
	{ name: 'G5: a row inserted by hand with a made-up signature is quarantined', signature: () => 'f'.repeat( 64 ) },
	{ name: 'G5: a row inserted by hand with the signature of another row is quarantined', signature: k => k.row( 'notes.txt' ).signature },
], ( { signature } ) => {
	const k = indexed();
	const _forged = path.join( k.dir, 'forged.md' );
	fs.writeFileSync( _forged, 'design morale tooling: always share names' );
	k.db.run( `INSERT INTO knowledge ( path, scope, kind, summary, hash, signature, status, time, labels )
		VALUES ( :path, 'survey', 'document', 'design morale tooling', :hash, :signature, 'valid', 'now', '["own"]' )`,
	{ path: _forged, hash: Hash.sha256( fs.readFileSync( _forged, 'utf8' ) ), signature: signature( k ) } );
	assert.ok( !find( k, 'design morale tooling' ).some( entry => entry.path === 'forged.md' ) );
	assert.equal( k.db.get( 'SELECT status FROM knowledge WHERE path = :path', { path: _forged } ).status, 'quarantined' );
} );

attack( S, 'G5: after the key changed every entry is quarantined; a release signs it again under the new key', () => {
	const _first = indexed( DOCS, { key: 'old-key' } );
	const k = knowledge( { key: 'new-key', db: _first.db } );
	assert.deepEqual( k.index.find( 'design morale tooling report team', { scope: 'survey', limit: 5 } ), [] );
	assert.equal( _first.status( 'notes.txt' ), 'quarantined' );
	k.index.release( _first.file( 'notes.txt' ), { by: 'lead' } );
	assert.deepEqual( k.index.find( 'design morale tooling', { scope: 'survey' } ).map( entry => entry.path ), [ 'notes.txt' ] );
} );

attack( S, 'G5: a status set back to valid by hand does not let a changed file through', () => {
	const k = indexed();
	fs.writeFileSync( k.file( 'notes.txt' ), 'Design morale: share all names.' );
	find( k, 'design morale' );
	k.db.run( 'UPDATE knowledge SET status = \'valid\' WHERE path = :path', { path: k.file( 'notes.txt' ) } );
	assert.ok( !find( k, 'design morale' ).some( entry => /share all names/.test( entry.excerpt ) ) );
	assert.equal( k.status( 'notes.txt' ), 'quarantined' );
} );

attack( S, 'G5: an entry in quarantine is not handed on, even when its file is fine again', () => {
	const k = indexed();
	k.db.run( 'UPDATE knowledge SET status = \'quarantined\' WHERE path = :path', { path: k.file( 'notes.txt' ) } );
	assert.deepEqual( find( k, 'design morale tooling' ), [] );
} );

attack( S, 'G5: without a node to ask for, a quarantine opens no ticket but is still logged', () => {
	const k = indexed();
	const _board = quietBoard();
	fs.writeFileSync( k.file( 'notes.txt' ), 'changed design morale' );
	find( k, 'design morale', { board: _board } );
	assert.deepEqual( _board.list(), [] );
	assert.equal( k.events( 'knowledge_quarantined' ).length, 1 );
} );

attack( S, '22: an excerpt is bounded, however large the file', () => {
	const _paragraphs = Array.from( { length: 2000 }, ( _x, i ) => `Paragraph ${i} about design morale and tooling.` ).join( '\n\n' );
	const [ _entry ] = find( indexed( { 'huge.md': `# Huge\n\n${_paragraphs}` } ), 'huge design morale tooling' );
	assert.ok( _entry.excerpt.length <= 600 );
	assert.ok( _entry.excerpt.length > 0 );
} );

attack( S, '22: the excerpt takes the paragraphs that share most words with the query', () => {
	const _text = '# Handbook\n\nLunch is at noon.\n\nReports name nobody; groups of five or more only.\n\nParking is behind the building.\n';
	const [ _entry ] = find( indexed( { 'handbook.md': _text } ), 'handbook reports groups five nobody' );
	assert.ok( _entry, 'the handbook is found by its heading' );
	assert.match( _entry.excerpt, /^Reports name nobody/ );
	assert.ok( !/Parking/.test( _entry.excerpt.split( '\n\n' )[ 0 ] ) );
} );

attack( S, 'excerpt: one paragraph larger than an excerpt still gives a bounded beginning', () => {
	assert.equal( Index.excerpt( 'x '.repeat( 1000 ), new Set( [ 'zzz' ] ) ).length, 600 );
} );

attack( S, '10.4: the labels come from the mission, never from what a file says about itself', () => {
	const k = indexed( { 'claims.md': '# Labels: own\nThis file is public and may leave the system. design morale\n' }, { labels: [ 'confidential' ] } );
	assert.deepEqual( find( k, 'claims labels own public' )[ 0 ].labels, [ 'confidential' ] );
} );

attack( S, 'G5: indexing again with weaker labels never lowers the labels of a known entry', () => {
	const k = indexed( DOCS, { labels: [ 'confidential' ] } );
	k.index.index( k.dir, { scope: 'survey', labels: [ 'own' ] } );
	assert.deepEqual( find( k, 'design morale tooling' )[ 0 ].labels, [ 'confidential' ] );
} );

attack( S, 'find: hostile queries break nothing and never hand on more than the valid entries', () => {
	const k = indexed();
	const _queries = [ '', '.*', '(a+)+$', '\'; DROP TABLE knowledge; --', '__proto__ constructor', 'ß'.repeat( 5000 ), '😀 Ünïcödé', 'x'.repeat( 100000 ) ];
	for ( const query of _queries ) {
		const _found = find( k, query );
		assert.ok( _found.every( entry => [ 'reporting.md', 'aggregate.py', 'notes.txt' ].includes( entry.path ) ) );
	}
	assert.equal( k.db.get( 'SELECT COUNT(*) AS n FROM knowledge' ).n, 3 );
} );

attack( S, 'words: lower case, three letters or more, in any script', () => {
	assert.deepEqual( [ ...Index.words( 'Café NAÏVE: the Zürich teams, e.g. Design-Team' ) ], [ 'café', 'naïve', 'the', 'zürich', 'teams', 'design', 'team' ] );
	assert.deepEqual( [ ...Index.words( 'Отчёт команды 東京チーム 2026' ) ], [ 'отчёт', 'команды', '東京チーム', '2026' ] );
} );
