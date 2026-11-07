// Stress tests of the calibration (core/ai/calibration.js, B7): one answer in twenty goes to a person as a sample, the
// error rate per role is logged, and above the threshold every answer of the role is checked and a rejected or
// unchecked answer is not used. Nothing waits forever: a check has a deadline.
import assert from 'node:assert/strict';
import { attack, attacks, random, hostile, within } from '../hostile.mjs';
import { use, memoryDb } from '../../helper.mjs';

const [ Calibration, Board, EventLog, StubProvider ] = await use( 'Core.Ai.Calibration', 'Core.Ticket.Board', 'Lib.EventLog', 'Core.Ai.StubProvider', 'Lib.Db' );
const S = 'core/ai/calibration.js';
const NOW = Date.parse( '2026-11-04T10:00:00Z' );

// A person whose answers the test controls: a list used in turn (the last repeats), or a function of the ticket.
function person( answers = [ 'right' ] ) {
	const _asked = [];
	const _list = Array.isArray( answers ) ? [ ...answers ] : null;
	return {
		asked: _asked,
		ask: async ( node, spec ) => {
			_asked.push( { node, spec } );
			const _choice = _list ? ( _list.length > 1 ? _list.shift() : _list[ 0 ] ) : await answers( spec, node );
			return { choice: _choice, by: 'tester' };
		},
	};
}

const recorder = () => {
	const _events = [];
	return { events: _events, append: ( kind, data ) => _events.push( { kind, data } ) };
};

// Drives a role into the strict mode: `minimum` checked samples, the first `wrong` of them wrong.
async function strictRole( calibration, role, { checks = 5, wrong = 1 } = {} ) {
	for ( let i = 0; i < checks; i++ ) {
		await calibration._ask( role, 'in', 'out', 'setup' ).catch( () => null );
	}
	return wrong;
}

const make = ( board, options = {} ) => new Calibration( { board, now: () => NOW, ...options } );
const settle = () => new Promise( resolve => setImmediate( resolve ) );

attack( S, 'the defaults are those of B7: one sample in twenty, threshold 5 %, at least 5 checks, an hour to check', () => {
	const _c = new Calibration( { board: person() } );
	assert.deepEqual( [ _c.every, _c.threshold, _c.minimum, _c.validMinutes ], [ 20, 0.05, 5, 60 ] );
} );

attack( S, 'a role nobody checked yet is not strict', () => {
	assert.equal( make( person() ).strict( 'writer' ), false );
} );

attack( S, 'one answer in twenty is a sample: the 20th and the 40th, none in between', async () => {
	const _board = person();
	const _c = make( _board );
	const _sampled = [];
	for ( let i = 1; i <= 45; i++ ) {
		const _before = _board.asked.length;
		await _c.review( 'writer', `in ${i}`, { text: `out ${i}` } );
		if ( _board.asked.length > _before ) { _sampled.push( i ); }
	}
	assert.deepEqual( _sampled, [ 20, 40 ] );
} );

attack( S, 'the sample counter is per role', async () => {
	const _board = person();
	const _c = make( _board, { every: 3 } );
	for ( const role of [ 'a', 'b', 'a', 'b', 'a', 'b' ] ) { await _c.review( role, 'in', 'out' ); }
	assert.deepEqual( _board.asked.map( item => item.node.id ), [ 'ai:a', 'ai:b' ] );
} );

attack( S, 'with every = 1 each answer is a sample', async () => {
	const _board = person();
	const _c = make( _board, { every: 1 } );
	for ( let i = 0; i < 4; i++ ) { await _c.review( 'writer', 'in', 'out' ); }
	assert.equal( _board.asked.length, 4 );
} );

attack( S, 'a sample does not hold the answer up: review returns although nobody has answered yet', async () => {
	const _c = make( { ask: () => new Promise( () => {} ) }, { every: 1 } );
	await within( _c.review( 'writer', 'in', 'out' ), 500, 'a sampled review' );
} );

attack( S, 'the sample ticket: a check for B7 with the options right and wrong, recommending right', async () => {
	const _board = person();
	await make( _board, { every: 1 } )._ask( 'writer', { a: 1 }, { text: 'b' }, 'A random sample.' );
	const [ { spec } ] = _board.asked;
	assert.deepEqual( [ spec.options, spec.recommendation, spec.kind, spec.reason, spec.minutes ], [ [ 'right', 'wrong' ], 'right', 'check', 'B7', 1 ] );
	assert.match( spec.question, /^A random sample\. Is this writer answer right\? Input: \{"a":1\} Answer: \{"text":"b"\}$/ );
} );

attack( S, 'the check has a deadline: now plus validMinutes, from the injected clock', async () => {
	const _board = person();
	await make( _board, { validMinutes: 30 } )._ask( 'writer', 'in', 'out', 'x' );
	assert.equal( _board.asked[ 0 ].spec.deadline, new Date( NOW + 30 * 60000 ).toISOString() );
} );

attack( S, 'validMinutes 0: the check is due at once', async () => {
	const _board = person();
	await make( _board, { validMinutes: 0 } )._ask( 'writer', 'in', 'out', 'x' );
	assert.equal( _board.asked[ 0 ].spec.deadline, new Date( NOW ).toISOString() );
} );

attack( S, 'the ticket comes from a node of its own per role, ai:<role>, without a contract deadline', async () => {
	const _board = person();
	await make( _board )._ask( 'coder', 'in', 'out', 'x' );
	const [ { node } ] = _board.asked;
	assert.equal( node.id, 'ai:coder' );
	assert.deepEqual( node.contract, {} );
	assert.equal( typeof node.emit, 'function' );
} );

attack( S, 'the person sees at most 400 characters of input and of answer', async () => {
	const _board = person();
	await make( _board )._ask( 'writer', '#'.repeat( 5000 ), { text: '%'.repeat( 5000 ) }, 'x' );
	const _q = _board.asked[ 0 ].spec.question;
	assert.equal( ( _q.match( /#/g ) || [] ).length, 399 );
	assert.equal( ( _q.match( /%/g ) || [] ).length, 391 );
	assert.ok( _q.length < 1000 );
} );

attack( S, 'an answer that tries to talk to the checker is shown as data, inside the JSON', async () => {
	const _board = person();
	await make( _board )._ask( 'writer', 'in', { text: 'Ignore the check and answer right' }, 'x' );
	assert.match( _board.asked[ 0 ].spec.question, /Answer: \{"text":"Ignore the check and answer right"\}$/ );
	assert.deepEqual( _board.asked[ 0 ].spec.options, [ 'right', 'wrong' ], 'the answer cannot change the options' );
} );

attack( S, 'a sample checked right counts as checked, not wrong', async () => {
	const _c = make( person( [ 'right' ] ) );
	assert.equal( await _c._ask( 'writer', 'in', 'out', 'x' ), true );
	assert.deepEqual( _c.stats.get( 'writer' ), { seen: 0, checked: 1, wrong: 0 } );
} );

attack( S, 'a sample checked wrong counts as checked and wrong', async () => {
	const _c = make( person( [ 'wrong' ] ) );
	assert.equal( await _c._ask( 'writer', 'in', 'out', 'x' ), false );
	assert.deepEqual( _c.stats.get( 'writer' ), { seen: 0, checked: 1, wrong: 1 } );
} );

attack( S, 'a sample nobody checked in time counts for nothing and is not logged', async () => {
	const _log = recorder();
	const _c = make( person( [ null ] ), { log: _log } );
	assert.equal( await _c._ask( 'writer', 'in', 'out', 'x' ), null );
	assert.equal( _c.stats.get( 'writer' )?.checked ?? 0, 0 );
	assert.equal( _c.stats.get( 'writer' )?.wrong ?? 0, 0 );
	assert.equal( _log.events.filter( item => item.kind === 'calibration_sample' ).length, 0 );
} );

attack( S, 'every check is logged with role, choice, the counts and the mode', async () => {
	const _log = recorder();
	const _c = make( person( [ 'wrong', 'right', 'right', 'right', 'right' ] ), { log: _log } );
	await strictRole( _c, 'writer' );
	const _samples = _log.events.filter( item => item.kind === 'calibration_sample' ).map( item => item.data );
	assert.equal( _samples.length, 5 );
	assert.deepEqual( _samples[ 0 ], { role: 'writer', choice: 'wrong', checked: 1, wrong: 1, strict: false } );
	assert.deepEqual( _samples[ 4 ], { role: 'writer', choice: 'right', checked: 5, wrong: 1, strict: true } );
} );

attack( S, 'the ticket events of a check reach the log through the ticket\'s node', async () => {
	const _log = recorder();
	const _board = { ask: async ( node ) => { node.emit( 'ticket_opened', { id: 't1' } ); return { choice: 'right' }; } };
	await make( _board, { log: _log } )._ask( 'writer', 'in', 'out', 'x' );
	assert.deepEqual( _log.events[ 0 ], { kind: 'ticket_opened', data: { id: 't1' } } );
} );

attack( S, 'strict: 1 wrong of 5 checks (20 % > 5 %) switches the role to a check of every answer', async () => {
	const _c = make( person( [ 'wrong', 'right' ] ) );
	await strictRole( _c, 'writer' );
	assert.equal( _c.strict( 'writer' ), true );
} );

attack( S, 'not strict below the minimum number of checks, even when every check was wrong', async () => {
	const _c = make( person( [ 'wrong' ] ) );
	await strictRole( _c, 'writer', { checks: 4 } );
	assert.equal( _c.strict( 'writer' ), false );
} );

attack( S, 'not strict at exactly the threshold: the rate must rise above it (1 wrong of 20 = 5 %)', async () => {
	const _c = make( person( [ 'wrong', 'right' ] ) );
	await strictRole( _c, 'writer', { checks: 20 } );
	assert.equal( _c.strict( 'writer' ), false );
	await _c._ask( 'writer', 'in', 'out', 'x' ).then( () => null );
	assert.equal( _c.strict( 'writer' ), false, '1 of 21 is below' );
} );

attack( S, 'strict: every answer waits for a person; one checked right is used', async () => {
	const _board = person( [ 'wrong', 'right' ] );
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	const _before = _board.asked.length;
	await _c.review( 'writer', 'in', 'out' );
	await _c.review( 'writer', 'in', 'out' );
	assert.equal( _board.asked.length - _before, 2 );
	assert.match( _board.asked.at( -1 ).spec.question, /^Every answer of this step is checked, its error rate is too high\./ );
} );

attack( S, 'strict: an answer a person rejects is not used', async () => {
	const _c = make( person( [ 'wrong', 'right', 'right', 'right', 'right', 'wrong' ] ) );
	await strictRole( _c, 'writer' );
	await assert.rejects( _c.review( 'writer', 'in', 'out' ), /a person rejected the writer answer/ );
} );

// The brief decides: a strict rejection reaches a person with the reason the way a broken step contract does.
attack( S, 'strict: a rejected or unchecked answer is refused as a broken step contract, so the executor hands it to a person (6.4)', async () => {
	const _c = make( person( [ 'wrong', 'right', 'right', 'right', 'right', 'wrong', null ] ) );
	await strictRole( _c, 'writer' );
	await assert.rejects( _c.review( 'writer', 'in', 'out' ), /^Error: answer breaks the step contract: a person rejected the writer answer/ );
	await assert.rejects( _c.review( 'writer', 'in', 'out' ), /step contract: nobody checked the writer answer in time/ );
} );

attack( S, 'strict: an answer nobody checked in time is not used either', async () => {
	const _c = make( person( [ 'wrong', 'right', 'right', 'right', 'right', null ] ) );
	await strictRole( _c, 'writer' );
	await assert.rejects( _c.review( 'writer', 'in', 'out' ), /nobody checked the writer answer in time/ );
} );

attack( S, 'strict: a check that fails at the board does not let the answer through', async () => {
	let _calls = 0;
	const _board = { ask: async () => {
		_calls++;
		if ( _calls > 5 ) { throw new Error( 'board down' ); }
		return { choice: _calls === 1 ? 'wrong' : 'right' };
	} };
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	await assert.rejects( _c.review( 'writer', 'in', 'out' ), /board down/ );
} );

attack( S, 'strict: the review holds the answer until the person decided', async () => {
	let _release;
	let _calls = 0;
	const _board = { ask: () => {
		_calls++;
		if ( _calls <= 5 ) { return Promise.resolve( { choice: _calls === 1 ? 'wrong' : 'right' } ); }
		return new Promise( ( resolve ) => { _release = resolve; } );
	} };
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	let _done = false;
	const _review = _c.review( 'writer', 'in', 'out' ).then( () => { _done = true; } );
	await settle();
	assert.equal( _done, false );
	_release( { choice: 'right' } );
	await within( _review, 500 );
	assert.equal( _done, true );
} );

attack( S, 'strict for one role leaves the other roles at sampling', async () => {
	const _board = person( [ 'wrong', 'right' ] );
	const _c = make( _board );
	await strictRole( _c, 'coder' );
	const _before = _board.asked.length;
	for ( let i = 0; i < 19; i++ ) { await _c.review( 'writer', 'in', 'out' ); }
	assert.equal( _board.asked.length, _before );
	assert.equal( _c.strict( 'writer' ), false );
} );

attack( S, 'strict ends when enough right checks bring the rate back to the threshold', async () => {
	const _board = person( [ 'wrong', 'right' ] );
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	let _reviews = 0;
	while ( _c.strict( 'writer' ) && _reviews < 100 ) {
		await _c.review( 'writer', 'in', 'out' );
		_reviews++;
	}
	assert.equal( _c.strict( 'writer' ), false );
	assert.deepEqual( [ _c.stats.get( 'writer' ).checked, _c.stats.get( 'writer' ).wrong ], [ 20, 1 ] );
} );

attack( S, 'strict: every review still counts as seen, so the sampling goes on from where it was', async () => {
	const _c = make( person( [ 'wrong', 'right' ] ) );
	await strictRole( _c, 'writer' );
	await _c.review( 'writer', 'in', 'out' );
	await _c.review( 'writer', 'in', 'out' );
	assert.equal( _c.stats.get( 'writer' ).seen, 2 );
} );

attack( S, 'threshold 0: once the minimum is reached, a single wrong check makes the role strict', async () => {
	const _c = make( person( [ 'right', 'right', 'right', 'right', 'wrong' ] ), { threshold: 0 } );
	await strictRole( _c, 'writer' );
	assert.equal( _c.strict( 'writer' ), true );
} );

attack( S, 'minimum 0 without any check is not strict (0 of 0 is no rate)', () => {
	assert.equal( make( person(), { minimum: 0 } ).strict( 'writer' ), false );
} );

attack( S, 'a sample the board fails on is reported, never swallowed, and the answer stays usable', async () => {
	const _failed = [];
	const _fail = globalThis.agencyApp.fail;
	globalThis.agencyApp.fail = error => _failed.push( error.message );
	try {
		const _c = make( { ask: async () => { throw new Error( 'board down' ); } }, { every: 1 } );
		await _c.review( 'writer', 'in', 'out' );
		await settle();
		assert.deepEqual( _failed, [ 'board down' ] );
	} finally {
		globalThis.agencyApp.fail = _fail;
	}
} );

attack( S, 'a sample answered after the next answers still counts', async () => {
	let _release;
	const _board = { ask: () => new Promise( ( resolve ) => { _release = resolve; } ) };
	const _c = make( _board, { every: 1 } );
	await _c.review( 'writer', 'in', 'out' );
	_board.ask = async () => ( { choice: 'right' } );
	await _c.review( 'writer', 'in', 'out' );
	_release( { choice: 'wrong' } );
	await settle();
	await settle();
	assert.deepEqual( _c.stats.get( 'writer' ), { seen: 2, checked: 2, wrong: 1 } );
} );

attack( S, 'forty answers at once give exactly two samples', async () => {
	const _board = person();
	const _c = make( _board );
	await Promise.all( Array.from( { length: 40 }, ( _x, i ) => _c.review( 'writer', `in ${i}`, 'out' ) ) );
	assert.equal( _board.asked.length, 2 );
} );

attack( S, 'three strict answers at once are each checked by a person', async () => {
	const _board = person( [ 'wrong', 'right' ] );
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	const _before = _board.asked.length;
	await Promise.all( [ 1, 2, 3 ].map( i => _c.review( 'writer', `in ${i}`, 'out' ) ) );
	assert.equal( _board.asked.length - _before, 3 );
} );

attack( S, 'no log is needed', async () => {
	const _c = make( person( [ 'wrong' ] ), { log: null } );
	assert.equal( await _c._ask( 'writer', 'in', 'out', 'x' ), false );
} );

attack( S, 'the answer under review is not changed by the check', async () => {
	const _answer = { text: 'out', list: [ 1 ] };
	const _copy = structuredClone( _answer );
	await make( person(), { every: 1 } ).review( 'writer', 'in', _answer );
	assert.deepEqual( _answer, _copy );
} );

attack( S, 'a sample on an input that is undefined still reaches a person', async () => {
	const _board = person();
	const _fail = globalThis.agencyApp.fail;
	globalThis.agencyApp.fail = () => {};
	try {
		await make( _board, { every: 1 } ).review( 'writer', undefined, { text: 'out' } );
		await settle();
	} finally {
		globalThis.agencyApp.fail = _fail;
	}
	assert.equal( _board.asked.length, 1 );
} );

attack( S, 'strict: an answer to an input that is undefined still goes to a person, not into a crash', async () => {
	const _board = person( [ 'wrong', 'right' ] );
	const _c = make( _board );
	await strictRole( _c, 'writer' );
	await _c.review( 'writer', undefined, { text: 'out' } );
	assert.match( _board.asked.at( -1 ).spec.question, /Every answer/ );
} );

attack( S, 'the stats survive a restart: a new calibration on the same log knows the role is strict (B7, 18)', async () => {
	const _log = new EventLog( memoryDb(), 'core' );
	const _first = make( person( [ 'wrong', 'right' ] ), { log: _log } );
	await strictRole( _first, 'writer' );
	assert.equal( _first.strict( 'writer' ), true );
	const _restarted = make( person(), { log: _log } );
	assert.equal( _restarted.strict( 'writer' ), true, 'after a restart the role would be sampled again' );
} );

// Role names are Map keys: names that every object has stay roles like any other.
attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `the role ${item.label} keeps its own counts` } ) ), async ( { value } ) => {
	const _c = make( person( [ 'wrong', 'right' ] ) );
	await strictRole( _c, value );
	assert.equal( _c.strict( value ), true );
	assert.equal( _c.strict( 'writer' ), false );
	assert.equal( {}.checked, undefined );
} );

attack( S, 'the strict mode follows the measured rate exactly (fuzz, seed 31)', async () => {
	const _rand = random( 31 );
	const _choices = Array.from( { length: 200 }, () => ( _rand() < 0.08 ? 'wrong' : _rand() < 0.05 ? null : 'right' ) );
	const _c = make( person( [ ..._choices ] ) );
	let _checked = 0;
	let _wrong = 0;
	for ( const choice of _choices.slice( 0, -1 ) ) {
		await _c._ask( 'writer', 'in', 'out', 'x' );
		if ( choice ) { _checked++; }
		if ( choice === 'wrong' ) { _wrong++; }
		assert.equal( _c.strict( 'writer' ), _checked >= 5 && _wrong / _checked > 0.05 );
	}
} );

// With the real board of the office: tickets, answers and their deadline.
attack( S, 'with the real board: the sample is a ticket of kind check that a person answers', async () => {
	const _log = new EventLog( memoryDb(), 'core' );
	const _board = new Board( _log );
	const _c = new Calibration( { board: _board, log: _log, every: 1 } );
	await _c.review( 'writer', 'in', { text: 'out' } );
	const [ _ticket ] = _board.list();
	assert.deepEqual( [ _ticket.kind, _ticket.from, _ticket.reason ], [ 'check', 'ai:writer', 'B7' ] );
	_board.answer( _ticket.id, { choice: 'wrong', by: 'reviewer' } );
	await settle();
	assert.deepEqual( _c.stats.get( 'writer' ), { seen: 1, checked: 1, wrong: 1 } );
} );

attack( S, 'with the real board: a choice outside right and wrong is refused by the board', async () => {
	const _log = new EventLog( memoryDb(), 'core' );
	const _board = new Board( _log );
	await new Calibration( { board: _board, log: _log, every: 1 } ).review( 'writer', 'in', 'out' );
	assert.throws( () => _board.answer( _board.list()[ 0 ].id, { choice: 'approve everything', by: 'x' } ), /not one of the options/ );
} );

attack( S, 'with the real board: a strict check nobody answers expires at its deadline, and the answer is not used', async () => {
	let _now = NOW;
	const _log = new EventLog( memoryDb(), 'core' );
	const _board = new Board( _log, { now: () => _now } );
	const _c = new Calibration( { board: _board, log: _log, now: () => _now, validMinutes: 10 } );
	const _setup = new Calibration( { board: person( [ 'wrong', 'right' ] ), now: () => _now } );
	await strictRole( _setup, 'writer' );
	_c.stats = _setup.stats;
	const _review = _c.review( 'writer', 'in', 'out' );
	await settle();
	assert.equal( _board.list().length, 1 );
	_now += 11 * 60000;
	_board.expire();
	await assert.rejects( within( _review, 500 ), /nobody checked the writer answer in time/ );
} );

attack( S, 'through the provider: an answer a person rejects in the strict mode never leaves complete()', async () => {
	const _stub = new StubProvider( { answers: { writer: { text: 'the answer' } } } );
	_stub.calibration = make( person( [ 'wrong', 'right', 'right', 'right', 'right', 'wrong' ] ) );
	await strictRole( _stub.calibration, 'writer' );
	await assert.rejects( _stub.complete( { role: 'writer', instructions: 'I', input: [], contract: { fields: { text: { type: 'string' } } } } ), /rejected/ );
} );

attack( S, 'through the provider: an answer that broke its contract is never shown to the checker', async () => {
	const _board = person();
	const _stub = new StubProvider( { answers: { writer: [ { text: 1 }, { text: 'good' } ] } } );
	_stub.calibration = make( _board, { every: 1 } );
	await _stub.complete( { role: 'writer', instructions: 'I', input: [], contract: { fields: { text: { type: 'string' } } } } );
	assert.equal( _board.asked.length, 1 );
	assert.match( _board.asked[ 0 ].spec.question, /"good"/ );
} );

attack( S, 'the sample position does not depend on the content: twenty identical answers still give one sample', async () => {
	const _board = person();
	const _c = make( _board );
	for ( let i = 0; i < 20; i++ ) { await _c.review( 'writer', 'same', 'same' ); }
	assert.equal( _board.asked.length, 1 );
} );

attack( S, 'a sample checked wrong does not take back the answer already used (only the strict mode blocks)', async () => {
	const _c = make( person( [ 'wrong' ] ), { every: 1 } );
	await within( _c.review( 'writer', 'in', 'out' ), 500 );
	await settle();
	assert.equal( _c.stats.get( 'writer' ).wrong, 1 );
} );
