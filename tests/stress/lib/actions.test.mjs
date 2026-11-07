// lib/actions.js under attack: the table of outgoing actions (5.3 criticality, 6.2 sensitive parameters, 10.4).
// The gate decides with it whether a person must approve, so an unknown or hostile name must never look harmless
// by accident, and the table must not change once the gate has read it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { agency, distinct, tempDir, ROOT } from './tools.mjs';

const [ Actions ] = await agency.use( [ 'Lib.Actions' ] );
const S = 'lib/actions.js';

const TABLE = {
	look: { criticality: 'read', carries: [], sensitive: [] },
	note: { criticality: 'internal', carries: [ 'data' ], sensitive: [] },
	mail: { criticality: 'outward', carries: [ 'message', 'data' ], sensitive: [] },
	erase: { criticality: 'irreversible', carries: [ 'data' ], sensitive: [] },
	pay: { criticality: 'money_or_law', carries: [ 'money' ], sensitive: [ 'iban' ] },
};
const table = () => new Actions( structuredClone( TABLE ) );

attack( S, 'the five levels of 5.3 in their order, from read to money or law', () => {
	assert.deepEqual( Actions.LEVELS, [ 'read', 'internal', 'outward', 'irreversible', 'money_or_law' ] );
} );

// 5.3: read and internal run automatically; outward needs a person with a token; irreversible explicitly; money or law
// with a reason.
const LEVEL_CASES = [
	{ action: 'look', outward: false, reason: false, explicit: false },
	{ action: 'note', outward: false, reason: false, explicit: false },
	{ action: 'mail', outward: true, reason: false, explicit: false },
	{ action: 'erase', outward: true, reason: false, explicit: true },
	{ action: 'pay', outward: true, reason: true, explicit: false },
];
attacks( S, LEVEL_CASES.map( item => ( { ...item, name: `level ${TABLE[ item.action ].criticality}: approval as in table 5.3` } ) ), ( item ) => {
	const _actions = table();
	assert.equal( _actions.known( item.action ), true );
	assert.equal( _actions.criticality( item.action ), TABLE[ item.action ].criticality );
	assert.equal( _actions.outward( item.action ), item.outward );
	assert.equal( _actions.needsPerson( item.action ), item.outward );
	assert.deepEqual( _actions.requires( item.action ), { reason: item.reason, explicit: item.explicit } );
	assert.equal( _actions.matches( 'outward', item.action ), item.outward );
} );

attack( S, 'an action missing from the table is unknown, has no criticality and nothing sensitive', () => {
	const _actions = table();
	assert.equal( _actions.known( 'wire' ), false );
	assert.equal( _actions.criticality( 'wire' ), null );
	assert.deepEqual( _actions.sensitive( 'wire' ), [] );
	assert.deepEqual( _actions.requires( 'wire' ), { reason: false, explicit: false } );
} );

attack( S, 'a criticality in the wrong case, misspelt or of the wrong type makes the action unknown', () => {
	const _actions = new Actions( {
		a: { criticality: 'Outward' }, b: { criticality: 'outwards' }, c: { criticality: [ 'outward' ] }, d: { criticality: 2 },
		e: { criticality: null }, f: {}, g: null, h: 'outward',
	} );
	for ( const name of [ 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' ] ) {
		assert.equal( _actions.known( name ), false, name );
		assert.equal( _actions.criticality( name ), null, name );
	}
} );

attack( S, 'an action named like an Object.prototype member is unknown in a normal table', () => {
	const _actions = table();
	for ( const name of [ '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__' ] ) {
		assert.equal( _actions.known( name ), false, name );
		assert.equal( _actions.criticality( name ), null, name );
		assert.deepEqual( _actions.sensitive( name ), [], name );
		assert.equal( _actions.matches( 'carries:money', name ), false, name );
	}
} );

attack( S, 'a table read from JSON with an own "__proto__" entry treats it as an ordinary action', () => {
	const _actions = new Actions( JSON.parse( '{"__proto__":{"criticality":"money_or_law","carries":["money"],"sensitive":["iban"]}}' ) );
	assert.equal( _actions.criticality( '__proto__' ), 'money_or_law' );
	assert.deepEqual( _actions.sensitive( '__proto__' ), [ 'iban' ] );
	assert.equal( {}.criticality, undefined );
	assert.deepEqual( _actions.expand( '*' ), [ '__proto__' ] );
} );

attack( S, 'matches("*") covers every action, also unknown ones (a rule for everything applies to everything)', () => {
	const _actions = table();
	for ( const name of [ 'look', 'pay', 'unknown', '', '__proto__' ] ) { assert.equal( _actions.matches( '*', name ), true ); }
} );

attack( S, 'matches by exact name only: no prefix, case or whitespace tricks', () => {
	const _actions = table();
	assert.equal( _actions.matches( 'pay', 'pay' ), true );
	for ( const selector of [ 'pa', 'Pay', 'pay ', ' pay', 'pay*', 'p.y' ] ) { assert.equal( _actions.matches( selector, 'pay' ), false, selector ); }
} );

attack( S, 'matches("carries:x") follows the carries list of the table', () => {
	const _actions = table();
	assert.deepEqual( Object.keys( TABLE ).filter( name => _actions.matches( 'carries:money', name ) ), [ 'pay' ] );
	assert.deepEqual( Object.keys( TABLE ).filter( name => _actions.matches( 'carries:data', name ) ), [ 'note', 'mail', 'erase' ] );
	assert.equal( _actions.matches( 'carries:', 'pay' ), false );
	assert.equal( _actions.matches( 'carries:mon', 'pay' ), false );
} );

attack( S, 'a selector of another kind ("kind:x", "carries") matches nothing', () => {
	const _actions = table();
	for ( const selector of [ 'kind:money', 'carries', 'money', ':money', 'outward:', 'CARRIES:money' ] ) {
		assert.equal( _actions.matches( selector, 'pay' ), false, selector );
	}
} );

attack( S, 'matches() with selectors that are not strings never throws', () => {
	const _actions = table();
	for ( const { value } of hostile( 'types', 'numbers' ) ) {
		assert.doesNotThrow( () => _actions.matches( value, 'pay' ) );
		assert.equal( _actions.matches( value, 'pay' ), false );
	}
} );

attack( S, 'applies(): no list means every action; an empty list means none', () => {
	const _actions = table();
	assert.equal( _actions.applies( undefined, 'pay' ), true );
	assert.equal( _actions.applies( null, 'pay' ), true );
	assert.equal( _actions.applies( [], 'pay' ), false );
	assert.equal( _actions.applies( [ 'mail', 'carries:money' ], 'pay' ), true );
	assert.equal( _actions.applies( [ 'mail' ], 'pay' ), false );
} );

attack( S, 'applies() with a single selector given as a string answers instead of throwing a TypeError', () => {
	const _actions = table();
	assert.doesNotThrow( () => _actions.applies( 'pay', 'pay' ) );
	assert.equal( _actions.applies( 'pay', 'pay' ), true );
} );

attack( S, 'applies() with an object instead of a list is refused cleanly, not with a TypeError from inside', () => {
	const _actions = table();
	try {
		_actions.applies( { 0: 'pay', length: 1 }, 'pay' );
	} catch ( error ) {
		assert.ok( !( error instanceof TypeError ), `crashed: ${error.message}` );
	}
} );

attack( S, 'expand() lists exactly the actions a selector stands for', () => {
	const _actions = table();
	assert.deepEqual( _actions.expand( '*' ), Object.keys( TABLE ) );
	assert.deepEqual( _actions.expand( 'outward' ), [ 'mail', 'erase', 'pay' ] );
	assert.deepEqual( _actions.expand( 'carries:money' ), [ 'pay' ] );
	assert.deepEqual( _actions.expand( 'pay' ), [ 'pay' ] );
	assert.deepEqual( _actions.expand( 'nothing' ), [] );
} );

attack( S, 'expand() never lists inherited names, even with a polluted-looking table', () => {
	const _actions = new Actions( Object.create( { inherited: { criticality: 'read' } } ) );
	assert.deepEqual( _actions.expand( '*' ), [] );
	assert.deepEqual( _actions.expand( 'constructor' ), [] );
} );

attack( S, 'sensitive() lists the parameters of 6.2 for an action and nothing for others', () => {
	const _actions = table();
	assert.deepEqual( _actions.sensitive( 'pay' ), [ 'iban' ] );
	assert.deepEqual( _actions.sensitive( 'mail' ), [] );
} );

attack( S, 'the table cannot be changed through what sensitive() returns', () => {
	const _actions = table();
	const _list = _actions.sensitive( 'pay' );
	try {
		_list.length = 0;
	} catch {
		// a frozen list refusing the change is fine
	}
	assert.deepEqual( _actions.sensitive( 'pay' ), [ 'iban' ], 'the gate must keep checking where an IBAN flows' );
} );

attack( S, 'the unknown-action fallback of sensitive() is a fresh list each time', () => {
	const _actions = table();
	_actions.sensitive( 'unknown' ).push( 'x' );
	assert.deepEqual( _actions.sensitive( 'unknown' ), [] );
} );

attack( S, 'an action whose carries is missing or not a list matches no carries selector and does not throw', () => {
	const _actions = new Actions( { a: { criticality: 'outward' }, b: { criticality: 'outward', carries: null } } );
	assert.equal( _actions.matches( 'carries:money', 'a' ), false );
	assert.equal( _actions.matches( 'carries:money', 'b' ), false );
} );

attack( S, 'an empty table knows nothing and expands nothing', () => {
	const _actions = new Actions();
	assert.equal( _actions.known( 'pay' ), false );
	assert.deepEqual( _actions.expand( '*' ), [] );
	assert.equal( _actions.applies( undefined, 'pay' ), true );
} );

attack( S, 'the real catalog: every action has a known criticality, lists for carries and sensitive, and a retention', () => {
	const _actions = Actions.load();
	const _names = Object.keys( _actions.table );
	assert.ok( _names.length > 0 );
	for ( const name of _names ) {
		const _entry = _actions.table[ name ];
		assert.equal( _actions.known( name ), true, name );
		assert.ok( Array.isArray( _entry.carries ), name );
		assert.ok( Array.isArray( _entry.sensitive ), name );
		assert.ok( _entry.idempotencyH === null || ( Number.isFinite( _entry.idempotencyH ) && _entry.idempotencyH >= 0 ), name );
	}
} );

attack( S, 'the real catalog: whatever carries money is classed money_or_law and needs a reason', () => {
	const _actions = Actions.load();
	for ( const name of _actions.expand( 'carries:money' ) ) {
		assert.equal( _actions.criticality( name ), 'money_or_law', name );
		assert.equal( _actions.requires( name ).reason, true, name );
	}
} );

attack( S, 'the real catalog: two loads give equal but separate tables (the gate keeps its own copy)', () => {
	const _a = Actions.load();
	const _b = Actions.load();
	assert.deepEqual( _a.table, _b.table );
	assert.notEqual( _a.table, _b.table );
	Object.values( _a.table )[ 0 ].criticality = 'read';
	assert.notEqual( Object.values( _b.table )[ 0 ].criticality, 'read' );
} );

attack( S, 'load() of a missing file throws and reveals only the path', () => {
	assert.throws( () => Actions.load( 'catalog/does-not-exist.json' ), ( error ) => {
		assert.equal( error.code, 'ENOENT' );
		return true;
	} );
} );

attack( S, 'load() of a file that is not JSON throws a SyntaxError (no half table)', () => {
	const _dir = tempDir( 'actions' );
	fs.writeFileSync( path.join( _dir, 'broken.json' ), '{"pay": {"criticality": "money_or_law"' );
	assert.throws( () => Actions.load( path.relative( ROOT, path.join( _dir, 'broken.json' ) ) ), SyntaxError );
} );

attack( S, 'load() of an absolute path stays below the project root (it is joined, not followed)', () => {
	assert.throws( () => Actions.load( '/etc/hostname' ), ( error ) => {
		assert.equal( error.code, 'ENOENT' );
		assert.ok( error.path.startsWith( ROOT ) );
		return true;
	} );
} );

attack( S, 'a table of 10000 actions answers 100000 questions quickly', () => {
	const _big = Object.fromEntries( Array.from( { length: 10000 }, ( _, i ) => [ `a${i}`, { criticality: Actions.LEVELS[ i % 5 ], carries: [ `c${i % 7}` ], sensitive: [] } ] ) );
	const _actions = new Actions( _big );
	const _start = performance.now();
	let _outward = 0;
	for ( let i = 0; i < 100000; i++ ) {
		if ( _actions.applies( [ 'carries:c3', 'outward' ], `a${i % 10000}` ) ) { _outward += 1; }
	}
	assert.ok( performance.now() - _start < 3000 );
	assert.ok( _outward > 0 );
} );

// Hostile action names: never known by accident, never on a prototype, never in an expansion.
const NAMES = distinct( hostile( 'strings', 'keys' ) );
attacks( S, NAMES.map( item => ( { ...item, name: `action name ${item.label} is unknown to a normal table and harmless` } ) ), ( { value } ) => {
	const _actions = table();
	const _before = Object.getOwnPropertyNames( Object.prototype ).join();
	assert.equal( _actions.known( value ), false );
	assert.equal( _actions.criticality( value ), null );
	assert.deepEqual( _actions.sensitive( value ), [] );
	assert.deepEqual( _actions.requires( value ), { reason: false, explicit: false } );
	assert.equal( _actions.matches( 'carries:money', value ), false );
	assert.equal( _actions.applies( [ 'outward' ], value ), false );
	assert.ok( !_actions.expand( value ).length || _actions.expand( value ).every( name => name === value ) );
	assert.equal( Object.getOwnPropertyNames( Object.prototype ).join(), _before );
} );

// 7.3: which actions carry a message out of the company (soft rules for messages to the outside hold for them).
attacks( S, [
	{ name: 'outside(): a reply carries a message and the table does not keep it inside', action: 'reply', want: true },
	{ name: 'outside(): a report to HR carries a message that stays inside', action: 'report', want: false },
	{ name: 'outside(): an invitation to a team stays inside', action: 'invite', want: false },
	{ name: 'outside(): a payment carries money, no message', action: 'payment', want: false },
	{ name: 'outside(): an action the table does not know carries nothing', action: 'mail', want: false },
	{ name: 'outside(): a name of Object.prototype is no action', action: '__proto__', want: false },
	{ name: 'outside(): no name is no action', action: undefined, want: false },
], ( { action, want } ) => {
	assert.equal( Actions.load().outside( action ), want );
} );

attacks( S, [
	{ name: 'outside(): inside: true keeps a message inside', entry: { carries: [ 'message' ], inside: true }, want: false },
	{ name: 'outside(): inside: "true" (a text) is not true: the message goes outside', entry: { carries: [ 'message' ], inside: 'true' }, want: true },
	{ name: 'outside(): inside: 1 is not true either', entry: { carries: [ 'message' ], inside: 1 }, want: true },
	{ name: 'outside(): without inside a message goes outside (the stricter rules hold)', entry: { carries: [ 'message' ] }, want: true },
	{ name: 'outside(): carries as a text is no list: no message', entry: { carries: 'message' }, want: false },
	{ name: 'outside(): inside without a message is nothing that goes anywhere', entry: { carries: [ 'money' ], inside: false }, want: false },
], ( { entry, want } ) => {
	assert.equal( new Actions( { mine: { criticality: 'outward', ...entry } } ).outside( 'mine' ), want );
} );

// 6.2: the recipient type of an action: the gate knows "contact"; any other value would check nothing (fail closed).
attacks( S, [ 'contacts', 'Contact', '', null, 1, [ 'contact' ], { type: 'contact' } ].map( value => ( {
	name: `merged(): the recipient type ${JSON.stringify( value )} is unknown to the gate: the mission is refused`, value,
} ) ), ( { value } ) => {
	assert.throws( () => Actions.merged( {}, [ { id: 'dunning', value: { notice: { criticality: 'outward', carries: [ 'message' ], recipient: value } } } ] ),
		/names the recipient type .*which the gate does not know/ );
} );

attack( S, 'merged(): the recipient type contact is taken, and toContact() says so', () => {
	const _table = Actions.merged( {}, [ { id: 'dunning', value: { notice: { criticality: 'outward', carries: [ 'message' ], recipient: 'contact' } } } ] );
	const _actions = new Actions( _table );
	assert.deepEqual( [ _actions.toContact( 'notice' ), _actions.toContact( 'reply' ), _actions.toContact( '__proto__' ) ], [ true, false, false ] );
} );
