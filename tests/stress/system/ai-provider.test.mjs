// Stress tests of the step contract (core/ai/provider.js): Provider.validate with hostile answers and contracts, and
// complete() with its one repair (6.4), the ai_answered events and the calibration hook (B7).
import assert from 'node:assert/strict';
import { attack, attacks, random, hostile, within } from '../hostile.mjs';
import { use, memoryDb } from '../../helper.mjs';

const [ Provider, EventLog ] = await use( 'Core.Ai.Provider', 'Lib.EventLog', 'Lib.Db' );
const S = 'core/ai/provider.js';
const TEXT = { fields: { text: { type: 'string' } } };
const OPTIONAL = { fields: { note: { type: 'string', required: false } } };

// A provider that answers from a script: values in turn, a function of the request, or an Error to throw.
class Scripted extends Provider {

	static NAME = 'scripted';

	constructor( script = [], options = {} ) {
		super( options );
		this.script = [ ...script ];
		this.requests = [];
	}

	async _complete( request ) {
		this.requests.push( request );
		const _next = this.script.length > 1 ? this.script.shift() : this.script[ 0 ];
		if ( _next instanceof Error ) { throw _next; }
		return typeof _next === 'function' ? _next( request ) : structuredClone( _next );
	}

}

const recorder = () => {
	const _events = [];
	return { events: _events, append: ( kind, data, options ) => _events.push( { kind, data, options } ) };
};
const ask = ( provider, extra = {} ) => provider.complete( { role: 'writer', instructions: 'Write.', input: [ 'x' ], contract: TEXT, ...extra } );

// Provider.validate, one value per type: { name, field, value, ok }.
const VALUES = [
	{ name: 'a string is a string', field: { type: 'string' }, value: 'x', ok: true },
	{ name: 'an empty string is still a string', field: { type: 'string' }, value: '', ok: true },
	{ name: 'a number is not a string', field: { type: 'string' }, value: 1, ok: false },
	{ name: 'a list is not a string', field: { type: 'string' }, value: [ 'x' ], ok: false },
	{ name: 'an object is not a string', field: { type: 'string' }, value: { text: 'x' }, ok: false },
	{ name: 'a boolean is not a string', field: { type: 'string' }, value: true, ok: false },
	{ name: 'zero is a number', field: { type: 'number' }, value: 0, ok: true },
	{ name: 'a negative fraction is a number', field: { type: 'number' }, value: -1.5, ok: true },
	{ name: 'a numeric string is not a number', field: { type: 'number' }, value: '1', ok: false },
	{ name: 'NaN is not a number a step can use', field: { type: 'number' }, value: NaN, ok: false },
	{ name: 'Infinity is not a number a step can use', field: { type: 'number' }, value: Infinity, ok: false },
	{ name: '-Infinity is not a number a step can use', field: { type: 'number' }, value: -Infinity, ok: false },
	{ name: 'a boolean is not a number', field: { type: 'number' }, value: false, ok: false },
	{ name: 'an enum value from the list passes', field: { type: 'enum', values: [ 'a', 'b' ] }, value: 'b', ok: true },
	{ name: 'an enum value outside the list is refused', field: { type: 'enum', values: [ 'a', 'b' ] }, value: 'c', ok: false },
	{ name: 'an enum without values allows nothing', field: { type: 'enum' }, value: 'a', ok: false },
	{ name: 'an enum never matches a number for its string', field: { type: 'enum', values: [ '1' ] }, value: 1, ok: false },
	{ name: 'an enum is not fooled by a prototype key', field: { type: 'enum', values: [ 'a' ] }, value: 'constructor', ok: false },
	{ name: 'an empty list is a list', field: { type: 'list' }, value: [], ok: true },
	{ name: 'a list of strings is a list', field: { type: 'list' }, value: [ 'a', 'b' ], ok: true },
	{ name: 'a list with a value outside its values is refused', field: { type: 'list', values: [ 'a' ] }, value: [ 'a', 'z' ], ok: false },
	{ name: 'a string is not a list', field: { type: 'list' }, value: 'a', ok: false },
	{ name: 'an array-like object is not a list', field: { type: 'list' }, value: { length: 1, 0: 'a' }, ok: false },
	{ name: 'a list of objects is not "a list of strings"', field: { type: 'list' }, value: [ { a: 1 }, 2, null ], ok: false },
	{ name: 'an empty records list passes', field: { type: 'records' }, value: [], ok: true },
	{ name: 'records of objects pass', field: { type: 'records' }, value: [ { a: 1 } ], ok: true },
	{ name: 'a null record is refused', field: { type: 'records' }, value: [ null ], ok: false },
	{ name: 'a record that is a list is refused', field: { type: 'records' }, value: [ [] ], ok: false },
	{ name: 'a record that is a string is refused', field: { type: 'records' }, value: [ 'x' ], ok: false },
	{ name: 'a single object is not a records list', field: { type: 'records' }, value: { a: 1 }, ok: false },
	{ name: 'a record with a field its contract does not name is refused', field: { type: 'records', fields: { intent: 'text' } },
		value: [ { intent: 'x', secret: 'Anna' } ], ok: false },
	{ name: 'a record may leave out fields its contract declares (the strategy gates, planned steps, amendments do)',
		field: { type: 'records', fields: { intent: 'text', teams: 'a list' } }, value: [ { intent: 'x' }, {} ], ok: true },
	{ name: 'a record field whose spec says required must be there', field: { type: 'records', fields: { intent: { type: 'text', required: true } } },
		value: [ { intent: 'x' }, {} ], ok: false },
	{ name: 'records marked open let other keys through to the caller\'s own gate (the learner\'s G4)',
		field: { type: 'records', open: true, fields: { attempt: 'a number', hypothesis: 'a code' } }, value: [ { attempt: 1, accept: 'KW 48' } ], ok: true },
	{ name: 'records are closed unless marked open: true (a truthy word is not enough)',
		field: { type: 'records', open: 'yes', fields: { attempt: 'a number' } }, value: [ { attempt: 1, accept: 'KW 48' } ], ok: false },
	{ name: 'an unknown field type never passes', field: { type: 'blob' }, value: 'x', ok: false },
];

attacks( S, VALUES.map( item => ( { ...item, name: `validate: ${item.name}` } ) ), ( { field, value, ok } ) => {
	const _problems = Provider.validate( { v: value }, { fields: { v: field } } );
	assert.equal( _problems.length === 0, ok, JSON.stringify( _problems ) );
	if ( !ok ) { assert.match( _problems.join( ';' ), /^v / ); }
} );

// A key the contract does not name is refused, also one that exists on every object's prototype.
const KEYS = hostile( 'keys' ).map( ( { label, value } ) => ( { name: `validate: the extra key ${label} is refused`, key: value } ) );

attacks( S, KEYS, ( { key } ) => {
	const _answer = JSON.parse( `{ "text": "x", ${JSON.stringify( key )}: "smuggled" }` );
	assert.ok( Object.keys( _answer ).includes( key ) );
	const _problems = Provider.validate( _answer, TEXT );
	assert.ok( _problems.some( problem => problem.endsWith( 'is not part of the contract' ) ), `${JSON.stringify( key )} passed` );
} );

attack( S, 'validate: the keys every object inherits (toString, hasOwnProperty, valueOf, isPrototypeOf) are no contract fields', () => {
	for ( const key of [ 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf' ] ) {
		assert.ok( Provider.validate( { text: 'x', [ key ]: 'smuggled' }, TEXT ).length > 0, `${key} passed` );
	}
} );

attack( S, 'validate: a contract field named like a prototype key still demands its own value', () => {
	const _contract = { fields: { constructor: { type: 'string' } } };
	assert.deepEqual( Provider.validate( {}, _contract ), [ 'constructor is missing' ] );
	assert.deepEqual( Provider.validate( { constructor: 'x' }, _contract ), [] );
} );

attacks( S, hostile( 'types' ).map( item => ( { ...item, name: `validate: the answer ${item.label} never passes a contract with a required field` } ) ), ( { value } ) => {
	assert.ok( Provider.validate( value, TEXT ).length > 0 );
} );

attack( S, 'validate: an array is not the one JSON object a step must answer with', () => {
	assert.ok( Provider.validate( [], OPTIONAL ).length > 0 );
	assert.ok( Provider.validate( [ { note: 'x' } ], OPTIONAL ).length > 0 );
} );

attack( S, 'validate: an optional field may be missing or null, but not of the wrong type', () => {
	assert.deepEqual( Provider.validate( {}, OPTIONAL ), [] );
	assert.deepEqual( Provider.validate( { note: null }, OPTIONAL ), [] );
	assert.deepEqual( Provider.validate( { note: 3 }, OPTIONAL ), [ 'note is not a valid string' ] );
} );

attack( S, 'validate: a required field that is null or undefined is missing', () => {
	assert.deepEqual( Provider.validate( { text: null }, TEXT ), [ 'text is missing' ] );
	assert.deepEqual( Provider.validate( { text: undefined }, TEXT ), [ 'text is missing' ] );
} );

attack( S, 'validate: the problems name keys only, never the values of the answer', () => {
	const _problems = Provider.validate( { text: 41526, verdict: 'IBAN DE89370400440532013000' }, { fields: { text: { type: 'string' }, verdict: { type: 'enum', values: [ 'done' ] } } } );
	assert.equal( _problems.length, 2 );
	assert.ok( _problems.every( problem => !/41526|DE89/.test( problem ) ), _problems.join( '; ' ) );
} );

attack( S, 'validate: every problem of a broken answer is listed, not only the first', () => {
	const _contract = { fields: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'list' } } };
	const _problems = Provider.validate( { b: 'x', c: 'y', d: 1 }, _contract );
	assert.deepEqual( _problems, [ 'a is missing', 'b is not a valid number', 'c is not a valid list', 'd is not part of the contract' ] );
} );

attack( S, 'validate (fuzz, seed 7): never throws, and an answer built from its own contract always passes', () => {
	const _rand = random( 7 );
	const _types = [ 'string', 'number', 'enum', 'list', 'records' ];
	for ( let round = 0; round < 300; round++ ) {
		const _fields = Object.fromEntries( Array.from( { length: _rand.int( 1, 5 ) }, ( _x, i ) => {
			const _type = _rand.pick( _types );
			return [ `f${i}_${_rand.string( 4, 'abc' )}`, { type: _type, values: [ 'a', 'b' ], required: _rand() < 0.7 } ];
		} ) );
		const _good = Object.fromEntries( Object.entries( _fields ).map( ( [ name, field ] ) => [ name,
			{ string: 'x', number: _rand.int( -9, 9 ), enum: 'a', list: [ 'b' ], records: [ { k: 1 } ] }[ field.type ] ] ) );
		assert.deepEqual( Provider.validate( _good, { fields: _fields } ), [], JSON.stringify( _fields ) );
		const _noise = Object.fromEntries( Object.keys( _fields ).map( name => [ name, _rand.pick( hostile( 'strings', 'numbers', 'types' ) ).value ] ) );
		assert.ok( Array.isArray( Provider.validate( _noise, { fields: _fields } ) ) );
	}
} );

// complete(): the one repair, the log, the calibration hook.
attack( S, 'complete: a valid first answer is returned at once, with one ai_answered event (attempt 1, ok)', async () => {
	const _log = recorder();
	const _p = new Scripted( [ { text: 'fine' } ], { log: _log } );
	assert.deepEqual( await ask( _p, { node: 'node-1' } ), { text: 'fine' } );
	assert.equal( _p.requests.length, 1 );
	assert.equal( _log.events.length, 1 );
	const [ { kind, data, options } ] = _log.events;
	assert.equal( kind, 'ai_answered' );
	assert.deepEqual( [ data.role, data.provider, data.attempt, data.ok, data.problems ], [ 'writer', 'scripted', 1, true, [] ] );
	assert.deepEqual( options, { node: 'node-1' } );
	assert.ok( Number.isFinite( data.ms ) && data.ms >= 0 );
} );

attack( S, 'complete: the first call carries no repair note', async () => {
	const _p = new Scripted( [ { text: 'fine' } ] );
	await ask( _p );
	assert.equal( _p.requests[ 0 ].repair, null );
} );

attack( S, 'complete: a broken first answer gets exactly one repair, which hears its problems', async () => {
	const _p = new Scripted( [ { text: 3, extra: 1 }, { text: 'repaired' } ] );
	assert.deepEqual( await ask( _p ), { text: 'repaired' } );
	assert.equal( _p.requests.length, 2 );
	assert.deepEqual( _p.requests[ 1 ].repair, [ 'text is not a valid string', 'extra is not part of the contract' ] );
} );

attack( S, 'complete: a second broken answer is refused for good; there is never a third call', async () => {
	const _p = new Scripted( [ { wrong: 1 }, { still: 2 }, { text: 'too late' } ] );
	await assert.rejects( ask( _p ), /answer breaks the step contract: text is missing; still is not part of the contract/ );
	assert.equal( _p.requests.length, 2 );
} );

attack( S, 'complete: the refusal says "step contract", so the executor can hand it to a person (6.4)', async () => {
	const _p = new Scripted( [ null ] );
	const _error = await ask( _p ).catch( error => error );
	assert.match( _error.message, /step contract/ );
	assert.match( _error.message, /answer is not an object/ );
} );

attack( S, 'complete: a broken answer never leaks out, neither as a value nor inside the error', async () => {
	const _p = new Scripted( [ { text: 'x', name: 'Anna Example wrote it' } ] );
	const _error = await ask( _p ).catch( error => error );
	assert.ok( _error instanceof Error );
	assert.doesNotMatch( _error.message, /Anna Example/ );
} );

attack( S, 'complete: both attempts are logged, the broken one with its problems', async () => {
	const _log = recorder();
	const _p = new Scripted( [ { text: 1 }, { text: 'ok' } ], { log: _log } );
	await ask( _p );
	assert.deepEqual( _log.events.map( item => [ item.data.attempt, item.data.ok, item.data.problems ] ),
		[ [ 1, false, [ 'text is not a valid string' ] ], [ 2, true, [] ] ] );
} );

attack( S, 'complete: an error of the model call is no broken answer; it is not repaired and not logged as an answer', async () => {
	const _log = recorder();
	const _p = new Scripted( [ new Error( 'connection reset' ), { text: 'never asked' } ], { log: _log } );
	await assert.rejects( ask( _p ), /connection reset/ );
	assert.equal( _p.requests.length, 1 );
	assert.equal( _log.events.length, 0 );
} );

attack( S, 'complete: an error in the repair call ends the step with that error', async () => {
	const _p = new Scripted( [ { bad: 1 }, new Error( 'HTTP 503' ) ] );
	await assert.rejects( ask( _p ), /HTTP 503/ );
	assert.equal( _p.requests.length, 2 );
} );

attack( S, 'complete: the calibration reviews only answers that kept the contract, with role, input and answer', async () => {
	const _seen = [];
	const _p = new Scripted( [ { text: 5 }, { text: 'ok' } ] );
	_p.calibration = { review: async ( ...args ) => _seen.push( args ) };
	await ask( _p, { input: [ 'in' ] } );
	assert.deepEqual( _seen, [ [ 'writer', [ 'in' ], { text: 'ok' } ] ] );
} );

attack( S, 'complete: an answer the calibration rejects is not returned (B7)', async () => {
	const _p = new Scripted( [ { text: 'ok' } ] );
	_p.calibration = { review: async () => { throw new Error( 'a person rejected the writer answer' ); } };
	await assert.rejects( ask( _p ), /a person rejected/ );
} );

attack( S, 'complete: the answer waits for a strict calibration check before it is returned', async () => {
	let _release;
	const _p = new Scripted( [ { text: 'ok' } ] );
	_p.calibration = { review: () => new Promise( ( resolve ) => { _release = resolve; } ) };
	let _done = false;
	const _pending = ask( _p ).then( ( value ) => { _done = true; return value; } );
	await new Promise( resolve => setTimeout( resolve, 5 ) );
	assert.equal( _done, false, 'returned before the person checked it' );
	_release();
	assert.deepEqual( await within( _pending, 1000 ), { text: 'ok' } );
} );

attack( S, 'complete: no log and no calibration are needed', async () => {
	const _p = new Scripted( [ { text: 'ok' } ] );
	assert.equal( _p.log, null );
	assert.deepEqual( await ask( _p ), { text: 'ok' } );
} );

attack( S, 'complete: the base class has no model and says so', async () => {
	const _p = new Provider();
	await assert.rejects( _p.complete( { role: 'r', input: [], contract: TEXT } ), /must be implemented/ );
	assert.equal( _p.name(), 'none' );
	assert.equal( Provider.NAME, 'none' );
} );

attack( S, 'complete: two steps at once keep their repairs apart', async () => {
	const _p = new Scripted( [ request => ( request.repair ? { text: `fixed ${request.role}` } : { wrong: request.role } ) ] );
	const [ _a, _b ] = await Promise.all( [ ask( _p, { role: 'a' } ), ask( _p, { role: 'b' } ) ] );
	assert.deepEqual( [ _a.text, _b.text ], [ 'fixed a', 'fixed b' ] );
	assert.equal( _p.requests.length, 4 );
	assert.ok( _p.requests.filter( item => item.repair ).every( item => item.repair.join( '; ' ) === 'text is missing; wrong is not part of the contract' ) );
} );

attack( S, 'complete: the model gets exactly role, instructions, input, contract and the repair, nothing else', async () => {
	const _p = new Scripted( [ { text: 'ok' } ] );
	await _p.complete( { role: 'writer', instructions: 'I', input: { a: 1 }, contract: TEXT, node: 'node-secret-id' } );
	assert.deepEqual( Object.keys( _p.requests[ 0 ] ).sort(), [ 'contract', 'input', 'instructions', 'repair', 'role' ] );
	assert.ok( !JSON.stringify( _p.requests[ 0 ] ).includes( 'node-secret-id' ), 'the node id stays in the core' );
} );

attack( S, 'complete: the ai_answered events of a real event log land on the node that asked', async () => {
	const _log = new EventLog( memoryDb(), 'core' );
	const _p = new Scripted( [ { x: 1 }, { text: 'ok' } ], { log: _log } );
	await ask( _p, { node: 'node-7' } );
	const _events = _log.forNode( 'node-7' );
	assert.deepEqual( _events.map( event => [ event.kind, event.data.attempt ] ), [ [ 'ai_answered', 1 ], [ 'ai_answered', 2 ] ] );
} );

attack( S, 'complete: the answer returned is the one that passed, not an earlier broken one', async () => {
	const _p = new Scripted( [ { text: 'a', extra: true }, { text: 'b' } ] );
	const _answer = await ask( _p );
	assert.deepEqual( _answer, { text: 'b' } );
	assert.ok( !( 'extra' in _answer ) );
} );

attack( S, 'complete: an answer that is a string or a number is refused, then repaired', async () => {
	const _p = new Scripted( [ '{"text":"looks like json"}', { text: 'real' } ] );
	assert.deepEqual( await ask( _p ), { text: 'real' } );
	assert.deepEqual( _p.requests[ 1 ].repair, [ 'answer is not an object' ] );
} );

attack( S, 'complete: a slow model is not cut off by the provider itself; the caller bounds it', async () => {
	const _p = new Scripted( [ () => new Promise( resolve => setTimeout( () => resolve( { text: 'late' } ), 20 ) ) ] );
	assert.deepEqual( await within( ask( _p ), 1000 ), { text: 'late' } );
} );

// Use cases: a model wrote "paragraph": "" for "I cannot name one"; the whole reading was refused and four quotes
// stayed unread. An optional field that is empty is absent, unless it is text; nothing else is let through.
attacks( S, [
	{ name: 'an optional number given as "" is absent', field: { type: 'number', required: false }, value: '', ok: true },
	{ name: 'an optional enum given as "" is absent', field: { type: 'enum', values: [ 'yes', 'no' ], required: false }, value: '', ok: true },
	{ name: 'an optional list given as "" is absent', field: { type: 'list', required: false }, value: '', ok: true },
	{ name: 'a required number given as "" is missing', field: { type: 'number' }, value: '', ok: false },
	{ name: 'an optional number given as " " is no number', field: { type: 'number', required: false }, value: ' ', ok: false },
	{ name: 'an optional number given as "0" is no number', field: { type: 'number', required: false }, value: '0', ok: false },
	{ name: 'an optional text given as "" is an empty text, and valid', field: { type: 'string', required: false }, value: '', ok: true },
], ( { field, value, ok } ) => {
	assert.equal( Provider.validate( { x: value }, { fields: { x: field } } ).length === 0, ok );
} );
