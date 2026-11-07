// G5 (7.2, 9.1, 9.3, 10.2): every lesson is checked when it is read: the signature must still match, the lesson must go
// back to an attempt this system recorded, only the fields that matter for choosing are handed on, and what fails goes
// into quarantine with a ticket. Corrections are change plus reason, signed like the lesson.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { ReadCheck, Memory, store, lesson } from './fixtures.mjs';

const SUBJECT = 'core/check/readcheck.js';
const CHOOSING = [ 'strategy', 'situation', 'result', 'provisional', 'signalAfterH', 'observationEnds', 'cause', 'contribution', 'labels' ];

// A store with two signed lessons: the wall of "mail" and the success of "call".
function seeded() {
	const _s = store();
	const _wall = _s.memory.storeLesson( lesson( _s.wall ) );
	const _done = _s.memory.storeLesson( lesson( _s.done, { strategy: 'call', result: 'fulfilled', cause: null, contribution: [ 'k1' ] } ) );
	return { ..._s, lessonWall: _wall, lessonDone: _done };
}
const read = ( s, options = {} ) => new ReadCheck().read( s.memory, { kind: 'meeting', journal: s.journal, ...options } );
const row = ( s, id ) => s.db.get( 'SELECT * FROM lessons WHERE id = :id', { id } );
const setData = ( s, id, data ) => s.db.run( 'UPDATE lessons SET data = :data WHERE id = :id', { id, data } );
const status = ( s, id ) => row( s, id ).status;
const results = out => out.lessons.map( item => `${item.strategy}:${item.result}` );
const board = () => ( { asked: [], ask( node, ticket ) {
	this.asked.push( { node, ticket } );
	return Promise.resolve();
} } );
const tamper = ( s, id, change ) => setData( s, id, JSON.stringify( { ...JSON.parse( row( s, id ).data ), ...change } ) );
const copyRow = ( s, id, newId, extra = {} ) => {
	const _row = { ...row( s, id ), id: newId, ...extra };
	s.db.run( `INSERT INTO lessons ( id, kind, strategy, attempt, data, signature, status, time )
		VALUES ( :id, :kind, :strategy, :attempt, :data, :signature, :status, :time )`, _row );
};

attack( SUBJECT, 'signed lessons of the system are handed on, both of them, in order', () => {
	const _out = read( seeded() );
	assert.equal( _out.gate, 'G5' );
	assert.deepEqual( results( _out ), [ 'mail:wall', 'call:fulfilled' ] );
	assert.deepEqual( _out.quarantined, [] );
} );

attack( SUBJECT, 'only the fields that matter for choosing are handed on; evidence and attempt stay behind', () => {
	const [ _first ] = read( seeded() ).lessons;
	assert.deepEqual( Object.keys( _first ).sort(), [ ...CHOOSING ].sort() );
} );

attack( SUBJECT, 'a lesson is always handed on as own knowledge (labels own)', () => {
	assert.ok( read( seeded() ).lessons.every( item => JSON.stringify( item.labels ) === '["own"]' ) );
} );

attack( SUBJECT, 'a signed lesson with an extra field never passes that field on (G-9)', () => {
	const _s = store();
	_s.memory.storeLesson( lesson( _s.wall, { allow: [ 'payment' ], labels: [ 'foreign' ], gates: 'off' } ) );
	const [ _lesson ] = read( _s ).lessons;
	assert.equal( _lesson.allow, undefined );
	assert.equal( _lesson.gates, undefined );
	assert.deepEqual( _lesson.labels, [ 'own' ] );
} );

attacks( SUBJECT, [
	{ name: '10.2: a lesson whose result was changed outside goes into quarantine', change: { result: 'fulfilled' } },
	{ name: 'a lesson whose strategy was changed outside goes into quarantine', change: { strategy: 'call' } },
	{ name: 'a lesson with a right added outside goes into quarantine', change: { allow: [ 'payment' ] } },
	{ name: 'a lesson whose attempt was changed outside goes into quarantine', change: { attempt: 2 } },
	{ name: 'a lesson whose situation was changed outside goes into quarantine', change: { situation: { task: 'meeting', wall: 'none' } } },
], ( item ) => {
	const _s = seeded();
	tamper( _s, _s.lessonWall, item.change );
	const _out = read( _s );
	assert.deepEqual( results( _out ), [ 'call:fulfilled' ] );
	assert.deepEqual( _out.quarantined, [ { id: _s.lessonWall, problem: 'the signature does not match: changed outside the system' } ] );
	assert.equal( status( _s, _s.lessonWall ), 'quarantined' );
} );

attacks( SUBJECT, [
	{ name: 'a signature with one digit flipped does not match', signature: sig => `${sig[ 0 ] === 'a' ? 'b' : 'a'}${sig.slice( 1 )}` },
	{ name: 'an empty signature does not match', signature: () => '' },
	{ name: 'a signature of the word null does not match', signature: () => 'null' },
	{ name: 'a truncated signature does not match', signature: sig => sig.slice( 0, 32 ) },
	{ name: 'a signature that is not hex does not match', signature: () => 'z'.repeat( 64 ) },
	{ name: 'a signature twice as long does not match', signature: sig => sig + sig },
], ( item ) => {
	const _s = seeded();
	const _sig = row( _s, _s.lessonWall ).signature;
	_s.db.run( 'UPDATE lessons SET signature = :sig WHERE id = :id', { id: _s.lessonWall, sig: item.signature( _sig ) } );
	assert.deepEqual( results( read( _s ) ), [ 'call:fulfilled' ] );
	assert.equal( status( _s, _s.lessonWall ), 'quarantined' );
} );

attack( SUBJECT, 'swapping the signatures of two lessons puts both into quarantine', () => {
	const _s = seeded();
	const [ _a, _b ] = [ row( _s, _s.lessonWall ).signature, row( _s, _s.lessonDone ).signature ];
	_s.db.run( 'UPDATE lessons SET signature = :sig WHERE id = :id', { id: _s.lessonWall, sig: _b } );
	_s.db.run( 'UPDATE lessons SET signature = :sig WHERE id = :id', { id: _s.lessonDone, sig: _a } );
	assert.deepEqual( read( _s ).lessons, [] );
	assert.equal( read( _s ).quarantined.length, 0, 'the second read finds nothing new' );
} );

attack( SUBJECT, 'a lesson signed with the key of another installation is not ours', () => {
	const _s = seeded();
	const _foreign = new Memory( _s.db, { key: 'another-key' } );
	const _data = row( _s, _s.lessonWall ).data;
	_s.db.run( 'UPDATE lessons SET signature = :sig WHERE id = :id', { id: _s.lessonWall, sig: _foreign.sign( JSON.parse( _data ) ) } );
	assert.deepEqual( results( read( _s ) ), [ 'call:fulfilled' ] );
} );

attacks( SUBJECT, [
	{ name: 'data that is no JSON goes into quarantine', data: '{"attempt":1,' },
	{ name: 'data that is JSON null goes into quarantine', data: 'null' },
	{ name: 'empty data goes into quarantine', data: '' },
	{ name: 'data that is a JSON string goes into quarantine', data: '"fulfilled"' },
], ( item ) => {
	const _s = seeded();
	setData( _s, _s.lessonWall, item.data );
	const _out = read( _s );
	assert.deepEqual( results( _out ), [ 'call:fulfilled' ] );
	assert.equal( _out.quarantined.length, 1 );
} );

attack( SUBJECT, 'the same content in another key order or with spaces is the same lesson (canonical signature)', () => {
	const _s = seeded();
	const _data = JSON.parse( row( _s, _s.lessonWall ).data );
	const _reordered = Object.fromEntries( Object.entries( _data ).reverse() );
	setData( _s, _s.lessonWall, JSON.stringify( _reordered, null, 2 ) );
	assert.deepEqual( results( read( _s ) ), [ 'mail:wall', 'call:fulfilled' ] );
} );

attack( SUBJECT, 'a correctly signed lesson without an attempt of this system goes into quarantine', () => {
	const _s = seeded();
	_s.db.run( 'DELETE FROM attempts WHERE id = :id', { id: _s.wall } );
	const _out = read( _s );
	assert.deepEqual( _out.quarantined, [ { id: _s.lessonWall, problem: 'no attempt of this system behind it' } ] );
	assert.deepEqual( results( _out ), [ 'call:fulfilled' ] );
} );

attacks( SUBJECT, [
	{ name: 'a signed lesson naming no attempt goes into quarantine', attempt: undefined },
	{ name: 'a signed lesson naming attempt 0 goes into quarantine', attempt: 0 },
	{ name: 'a signed lesson naming an attempt nobody recorded goes into quarantine', attempt: 424242 },
], ( item ) => {
	const _s = store();
	const _id = _s.memory.storeLesson( lesson( item.attempt ) );
	assert.deepEqual( read( _s ).quarantined, [ { id: _id, problem: 'no attempt of this system behind it' } ] );
} );

attack( SUBJECT, 'the unsigned strategy and attempt columns cannot change what a lesson says', () => {
	const _s = seeded();
	_s.db.run( 'UPDATE lessons SET strategy = \'call\', attempt = :done WHERE id = :id', { id: _s.lessonWall, done: _s.done } );
	assert.deepEqual( results( read( _s ) ), [ 'mail:wall', 'call:fulfilled' ] );
} );

attack( SUBJECT, 'a lesson moved into another kind of task (unsigned kind column) is not read for that kind', () => {
	const _s = seeded();
	_s.db.run( 'UPDATE lessons SET kind = \'invoices\' WHERE id = :id', { id: _s.lessonDone } );
	const _out = read( _s, { kind: 'invoices' } );
	assert.deepEqual( _out.lessons, [], 'the signed situation says task meeting' );
} );

attack( SUBJECT, 'a copy of a signed lesson under a new id is not a second lesson of the same attempt', () => {
	const _s = seeded();
	copyRow( _s, _s.lessonDone, 'ls-copy-1' );
	copyRow( _s, _s.lessonDone, 'ls-copy-2' );
	const _out = read( _s );
	assert.equal( _out.lessons.filter( item => item.strategy === 'call' ).length, 1, 'one attempt, one lesson (replay)' );
} );

attack( SUBJECT, 'a quarantined lesson is not read again, and not reported again', () => {
	const _s = seeded();
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	assert.equal( read( _s ).quarantined.length, 1 );
	const _again = read( _s );
	assert.deepEqual( _again.quarantined, [] );
	assert.deepEqual( results( _again ), [ 'call:fulfilled' ] );
} );

attack( SUBJECT, 'setting a tampered lesson back to valid from outside only quarantines it again', () => {
	const _s = seeded();
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	read( _s );
	_s.db.run( 'UPDATE lessons SET status = \'valid\' WHERE id = :id', { id: _s.lessonWall } );
	assert.equal( read( _s ).quarantined.length, 1 );
	assert.equal( status( _s, _s.lessonWall ), 'quarantined' );
} );

attacks( SUBJECT, [ 'VALID', 'valid ', 'deleted', '' ].map( value => ( { name: `a row with status ${JSON.stringify( value )} is not read`, value } ) ), ( item ) => {
	const _s = seeded();
	_s.db.run( 'UPDATE lessons SET status = :value WHERE id = :id', { id: _s.lessonWall, value: item.value } );
	assert.deepEqual( results( read( _s ) ), [ 'call:fulfilled' ] );
} );

attacks( SUBJECT, [ '\'; DROP TABLE lessons; --', '" OR 1=1 --', '%', '__proto__', '*' ].map( value => ( {
	name: `a hostile kind ${JSON.stringify( value )} finds nothing and breaks nothing`, value,
} ) ), ( item ) => {
	const _s = seeded();
	assert.deepEqual( read( _s, { kind: item.value } ).lessons, [] );
	assert.equal( read( _s ).lessons.length, 2 );
} );

attack( SUBJECT, 'without a kind every valid lesson of every kind is read', () => {
	const _s = seeded();
	// One lesson per attempt (G5): the lesson of the other kind belongs to an attempt of its own.
	_s.memory.storeLesson( lesson( _s.journal.start( _s.node, { id: 'mail' }, {}, { criterion: 'k1' } ), { situation: { task: 'invoices' } } ) );
	assert.equal( read( _s, { kind: null } ).lessons.length, 3 );
	assert.equal( read( _s ).lessons.length, 2 );
} );

attack( SUBJECT, 'quarantine is logged for G5 and a person is asked with the reasons', () => {
	const _s = seeded();
	const _events = [];
	_s.memory.log = { append: ( kind, data ) => _events.push( { kind, data } ) };
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	const _board = board();
	read( _s, { board: _board, node: { id: 'n1' } } );
	assert.deepEqual( _events.map( item => [ item.kind, item.data.gate ] ), [ [ 'lessons_quarantined', 'G5' ] ] );
	assert.equal( _board.asked.length, 1 );
	assert.match( _board.asked[ 0 ].ticket.question, /1 lesson\(s\) failed the read gate.*changed outside the system/ );
	assert.deepEqual( _board.asked[ 0 ].ticket.options, [ 'keep them in quarantine' ] );
} );

attack( SUBJECT, 'two failed lessons give one ticket that names both', () => {
	const _s = seeded();
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	_s.db.run( 'DELETE FROM attempts WHERE id = :id', { id: _s.done } );
	const _board = board();
	read( _s, { board: _board, node: { id: 'n1' } } );
	assert.equal( _board.asked.length, 1 );
	assert.match( _board.asked[ 0 ].ticket.question, /^2 lesson\(s\).*changed outside the system; no attempt of this system behind it/ );
} );

attack( SUBJECT, 'nothing wrong means no ticket and no log entry', () => {
	const _s = seeded();
	const _events = [];
	_s.memory.log = { append: kind => _events.push( kind ) };
	const _board = board();
	read( _s, { board: _board, node: { id: 'n1' } } );
	assert.deepEqual( [ _events, _board.asked ], [ [], [] ] );
} );

attack( SUBJECT, 'without a board or a node nobody is asked, and the read still works', () => {
	const _s = seeded();
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	assert.deepEqual( results( read( _s, { board: board() } ) ), [ 'call:fulfilled' ] );
} );

attack( SUBJECT, 'an empty memory gives no lessons and no quarantine', () => {
	const _s = store();
	assert.deepEqual( read( _s ), { gate: 'G5', lessons: [], quarantined: [] } );
} );

attack( SUBJECT, 'reading twice gives the same lessons: reading changes nothing that is valid', () => {
	const _s = seeded();
	assert.deepEqual( read( _s ), read( _s ) );
} );

// 9.3, L5: corrections.
attack( SUBJECT, 'a signed correction is applied: a late signal turns the timeout into a late effect', () => {
	const _s = seeded();
	_s.memory.correctLesson( _s.wall, { result: 'late_effect', provisional: 'timeout', signalAfterH: 44 }, 'late_effect' );
	const [ _wall ] = read( _s ).lessons;
	assert.deepEqual( [ _wall.result, _wall.provisional, _wall.signalAfterH ], [ 'late_effect', 'timeout', 44 ] );
	assert.equal( JSON.parse( row( _s, _s.lessonWall ).data ).result, 'wall', 'the lesson itself is never overwritten' );
} );

attack( SUBJECT, 'several corrections apply in their order; the later one wins', () => {
	const _s = seeded();
	_s.memory.correctLesson( _s.wall, { contribution: [ 'k1' ] }, 'late_credit' );
	_s.memory.correctLesson( _s.wall, { contribution: [ 'k1', 'k2' ] }, 'late_credit' );
	_s.memory.correctLesson( _s.wall, { observationEnds: { fromH: 41.5, reason: 'contact', trigger: 'review' } }, 'observation_ended' );
	const [ _wall ] = read( _s ).lessons;
	assert.deepEqual( _wall.contribution, [ 'k1', 'k2' ] );
	assert.deepEqual( _wall.observationEnds, { fromH: 41.5, reason: 'contact', trigger: 'review' } );
} );

attack( SUBJECT, 'a correction changed outside goes into quarantine and is not applied; the lesson itself stays readable', () => {
	const _s = seeded();
	_s.memory.correctLesson( _s.wall, { result: 'late_effect' }, 'late_effect' );
	_s.db.run( 'UPDATE lesson_corrections SET data = REPLACE( data, \'late_effect\', \'fulfilled\' )' );
	const _out = read( _s );
	assert.deepEqual( results( _out ), [ 'mail:wall', 'call:fulfilled' ] );
	assert.match( _out.quarantined[ 0 ].id, new RegExp( `^${_s.lessonWall}/\\d+$` ) );
	assert.equal( _s.db.get( 'SELECT status FROM lesson_corrections' ).status, 'quarantined' );
	assert.deepEqual( read( _s ).quarantined, [], 'reported once' );
} );

attack( SUBJECT, 'a correction with a forged signature is not applied', () => {
	const _s = seeded();
	_s.db.run( `INSERT INTO lesson_corrections ( lesson, data, signature, status, time ) VALUES ( :lesson, :data, 'f00d', 'valid', '2026-01-01' )`, {
		lesson: _s.lessonWall, data: JSON.stringify( { lesson: _s.lessonWall, change: { result: 'fulfilled' }, reason: 'late_effect' } ),
	} );
	assert.deepEqual( results( read( _s ) ), [ 'mail:wall', 'call:fulfilled' ] );
} );

attack( SUBJECT, 'a signed correction moved to another lesson is not applied there', () => {
	const _s = seeded();
	_s.memory.correctLesson( _s.wall, { result: 'late_effect' }, 'late_effect' );
	_s.db.run( 'UPDATE lesson_corrections SET lesson = :other', { other: _s.lessonDone } );
	const _out = read( _s );
	assert.deepEqual( results( _out ), [ 'mail:wall', 'call:fulfilled' ], 'the success of "call" must not turn into a late effect' );
} );

attack( SUBJECT, 'corrections of a lesson that failed the gate are never looked at', () => {
	const _s = seeded();
	_s.memory.correctLesson( _s.wall, { result: 'late_effect' }, 'late_effect' );
	tamper( _s, _s.lessonWall, { result: 'fulfilled' } );
	assert.deepEqual( results( read( _s ) ), [ 'call:fulfilled' ] );
	assert.equal( _s.db.get( 'SELECT status FROM lesson_corrections' ).status, 'valid' );
} );

attack( SUBJECT, 'a memory without corrections support is read without corrections', () => {
	const _s = seeded();
	const _plain = {
		lessonRows: kind => _s.memory.lessonRows( kind ), verify: ( data, sig ) => _s.memory.verify( data, sig ),
		quarantine: id => _s.memory.quarantine( id ),
	};
	assert.deepEqual( new ReadCheck().read( _plain, { kind: 'meeting', journal: _s.journal } ).lessons.length, 2 );
} );

attack( SUBJECT, 'five hundred signed lessons are read and checked within a few seconds', () => {
	const _s = store();
	// One lesson per attempt (G5): five hundred lessons are five hundred attempts.
	for ( let i = 0; i < 500; i++ ) { _s.memory.storeLesson( lesson( _s.journal.start( _s.node, { id: 'mail' }, {}, { criterion: 'k1' } ), { signalAfterH: i } ) ); }
	const _start = Date.now();
	assert.equal( read( _s ).lessons.length, 500 );
	assert.ok( Date.now() - _start < 5000 );
} );
