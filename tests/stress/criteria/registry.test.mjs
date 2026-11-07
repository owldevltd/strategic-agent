// core/criteria/registry.js: the map type → class from catalog/criteria.json. Unknown types are never an error here
// (G1 reports them), but nothing that is not a type may pass as one: no prototype keys, no coerced keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../helper.mjs';
import { Contract, Criterion, Registry, assert, attack, attacks, registry, within } from './kit.mjs';

const S = 'core/criteria/registry.js';
const CATALOG = JSON.parse( fs.readFileSync( path.join( ROOT, 'catalog/criteria.json' ), 'utf8' ) );
const KINDS = [ 'outcome', 'invariant', 'soft' ];

// A catalog file outside the repository, named relative to the root as load() expects.
function catalog( text ) {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'criteria-' ) );
	const _file = path.join( _dir, 'criteria.json' );
	fs.writeFileSync( _file, text );
	return { file: path.relative( ROOT, _file ), done: () => fs.rmSync( _dir, { recursive: true, force: true } ) };
}

async function loaded( text ) {
	const _catalog = catalog( text );
	try {
		return await within( Registry.load( _catalog.file ), 3000, 'Registry.load' );
	} finally {
		_catalog.done();
	}
}

attacks( S, Object.entries( CATALOG ).map( ( [ type, name ] ) => ( { name: `catalog type ${type}: a criterion class (${name}) with that TYPE, a known kind and checked params`, type } ) ), ( { type } ) => {
	const _Type = registry.types[ type ];
	assert.ok( _Type.prototype instanceof Criterion );
	assert.equal( _Type.TYPE, type );
	assert.ok( KINDS.includes( _Type.KIND ) );
	assert.ok( Object.values( _Type.PARAMS ).every( param => Criterion.CHECKS[ param.type ] ) );
	const _item = registry.create( { id: 'x', type, values: {} } );
	assert.ok( _item instanceof _Type );
	assert.equal( _item.kind, _Type.KIND );
} );

attacks( S, [
	{ name: 'has: a catalog type is known', type: 'min_group', want: true },
	{ name: 'has: an unknown type is not', type: 'max_group', want: false },
	{ name: 'has: the empty type is not', type: '', want: false },
	{ name: 'has: undefined is not', type: undefined, want: false },
	{ name: 'has: another case is another type', type: 'Min_Group', want: false },
	{ name: 'has: a leading space is another type', type: ' soft', want: false },
	{ name: 'has: the German name of 14.1 is not the code', type: 'zusage_erhalten', want: false },
], ( { type, want } ) => {
	assert.equal( registry.has( type ), want );
} );

attacks( S, [ 'constructor', '__proto__', 'toString', 'hasOwnProperty' ].map( type => ( {
	name: `has: the prototype key "${type}" is no criterion type`, type,
} ) ), ( { type } ) => {
	assert.equal( registry.has( type ), false );
} );

attack( S, 'create: "constructor" gives no criterion, never the spec itself as an object without methods', () => {
	const _spec = { id: 'x', type: 'constructor', values: {} };
	const _item = registry.create( _spec );
	assert.ok( _item === null || _item instanceof Criterion );
} );

attacks( S, [ '__proto__', 'toString', 'valueOf' ].map( type => ( {
	name: `create: the prototype key "${type}" returns null like any unknown type, not a TypeError`, type,
} ) ), ( { type } ) => {
	assert.equal( registry.create( { id: 'x', type, values: {} } ), null );
} );

attack( S, 'a contract with a prototype-key type lists it as unknown, so G1 refuses it instead of crashing later', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: '2026-11-06T12:00:00Z', criteria: [ { id: 'k1', type: 'constructor', values: {} } ] }, registry );
	assert.deepEqual( _contract.unknown, [ 'constructor' ] );
	assert.doesNotThrow( () => _contract.rules() );
} );

attacks( S, [
	{ name: 'create: a spec null is refused with null, not a TypeError', spec: null },
	{ name: 'create: no spec at all is refused with null, not a TypeError', spec: undefined },
], ( { spec } ) => {
	assert.equal( registry.create( spec ), null );
} );

attack( S, 'create: a spec without a type is unknown', () => {
	assert.equal( registry.create( {} ), null );
	assert.equal( registry.create( { id: 'x', values: { text: 'a' } } ), null );
} );

attacks( S, [
	{ name: 'create: a type given as a list ["soft"] is no type, not coerced to "soft"', type: [ 'soft' ] },
	{ name: 'create: an object whose toString says "soft" is no type', type: { toString: () => 'soft' } },
	{ name: 'has: a type given as a list ["min_group"] is not known', type: [ 'min_group' ], has: true },
], ( { type, has } ) => {
	if ( has ) {
		assert.equal( registry.has( type ), false );
	} else {
		assert.equal( registry.create( { id: 'x', type, values: { text: 'a' } } ), null );
	}
} );

attack( S, 'create: a number as type is unknown', () => {
	assert.equal( registry.create( { id: 'x', type: 0 } ), null );
	assert.equal( registry.has( 1 ), false );
} );

attack( S, 'create passes the whole spec through: id, deadline, origin, serves, immutable, the person as channel', () => {
	const _item = registry.create( { id: 'a7', type: 'test_green', values: { test: 't', commit: 'c' }, deadline: '2026-11-06T12:00:00Z',
		origin: 'agent', serves: 'k1', immutable: true, byPerson: true } );
	assert.deepEqual( [ _item.id, _item.deadline, _item.origin, _item.serves, _item.immutable, _item.byPerson ],
		[ 'a7', '2026-11-06T12:00:00Z', 'agent', 'k1', true, true ] );
} );

attack( S, 'create returns a new instance each time; one criterion\'s state is not another\'s', () => {
	const _a = registry.create( { id: 'a', type: 'soft', values: { text: 'x' } } );
	const _b = registry.create( { id: 'a', type: 'soft', values: { text: 'x' } } );
	assert.notEqual( _a, _b );
	_a.byPerson = true;
	assert.equal( _b.byPerson, false );
} );

attack( S, 'list: the system-set deadline type is never offered to the drafter', () => {
	assert.ok( registry.has( 'deadline' ) );
	assert.ok( !registry.list().some( entry => entry.type === 'deadline' ) );
} );

attack( S, 'list: every other catalog type is offered, in catalog order', () => {
	const _offered = registry.list().map( entry => entry.type );
	assert.deepEqual( _offered, Object.keys( CATALOG ).filter( type => type !== 'deadline' ) );
} );

attack( S, 'list: internal parameters (sum_max.param) are never offered; account_from_master offers its parameter and kind', () => {
	const _by = type => registry.list().find( entry => entry.type === type );
	assert.deepEqual( Object.keys( _by( 'sum_max' ).params ), [ 'max' ] );
	assert.deepEqual( Object.keys( _by( 'account_from_master' ).params ), [ 'param', 'kind' ] );
} );

attack( S, 'list: every entry says what it means, its kind and its parameters as text', () => {
	for ( const entry of registry.list() ) {
		assert.deepEqual( Object.keys( entry ), [ 'type', 'kind', 'means', 'params' ] );
		assert.ok( entry.means.length > 10, entry.type );
		assert.ok( KINDS.includes( entry.kind ) );
		assert.ok( Object.values( entry.params ).every( text => typeof text === 'string' && text.length > 0 ) );
	}
} );

attack( S, 'list: an "@actions" parameter shows the actions it may name, never the raw "@actions"', () => {
	const _text = registry.list().find( entry => entry.type === 'exactly_once' ).params.action;
	assert.match( _text, /^string, one of .*payment.*carries:money.*outward/ );
	assert.doesNotMatch( JSON.stringify( registry.list() ), /@actions/ );
} );

attack( S, 'list: a parameter without a description shows no dangling separator', () => {
	assert.equal( Registry._param( { type: 'string' } ), 'string' );
	assert.equal( Registry._param( { type: 'list', values: [ 'a', 'b' ] } ), 'list, one of a|b' );
} );

attack( S, 'an empty registry knows nothing and offers nothing', () => {
	const _empty = new Registry( {} );
	assert.equal( _empty.has( 'soft' ), false );
	assert.equal( _empty.create( { id: 'x', type: 'soft' } ), null );
	assert.deepEqual( _empty.list(), [] );
} );

attack( S, 'a registry entry that is null is no type', () => {
	const _holes = new Registry( { soft: null } );
	assert.equal( _holes.has( 'soft' ), false );
	assert.equal( _holes.create( { id: 'x', type: 'soft' } ), null );
} );

attack( S, 'load: a catalog with two entries knows exactly those two', async () => {
	const _small = await loaded( '{ "soft": "Core.Criteria.Soft", "min_group": "Core.Criteria.MinGroup" }' );
	assert.deepEqual( Object.keys( _small.types ), [ 'soft', 'min_group' ] );
	assert.equal( _small.has( 'sum_max' ), false );
} );

attack( S, 'load: a catalog naming a class that does not exist is refused, never a hang', async () => {
	await assert.rejects( loaded( JSON.stringify( { ghost: 'Core.Criteria.Ghost' } ) ) );
} );

attack( S, 'load: a catalog naming a class outside every namespace is refused', async () => {
	await assert.rejects( loaded( JSON.stringify( { ghost: 'Nowhere.Ghost' } ) ), /Unknown class name/ );
} );

attack( S, 'load: a catalog that is not JSON is refused', async () => {
	await assert.rejects( loaded( '{ "soft": "Core.Criteria.Soft", }' ), SyntaxError );
} );

attack( S, 'load: a missing catalog file is refused', async () => {
	await assert.rejects( within( Registry.load( 'catalog/does-not-exist.json' ), 3000 ), /ENOENT/ );
} );

attack( S, 'load: an empty catalog gives an empty registry', async () => {
	const _empty = await loaded( '{}' );
	assert.deepEqual( _empty.list(), [] );
} );

attack( S, 'load: two type names for one class are two types of the same class', async () => {
	const _twice = await loaded( JSON.stringify( { soft: 'Core.Criteria.Soft', weich: 'Core.Criteria.Soft' } ) );
	assert.equal( _twice.types.soft, _twice.types.weich );
	assert.equal( _twice.create( { id: 'x', type: 'weich', values: { text: 't' } } ).kind, 'soft' );
} );

attack( S, 'two loaded registries do not share their map: a type added to one is unknown to the other', async () => {
	const _a = await Registry.load();
	const _b = await Registry.load();
	_a.types.extra = registry.types.soft;
	assert.equal( _a.has( 'extra' ), true );
	assert.equal( _b.has( 'extra' ), false );
	assert.equal( registry.has( 'extra' ), false );
} );

attack( S, 'loading in parallel gives the same classes', async () => {
	const [ _a, _b ] = await within( Promise.all( [ Registry.load(), Registry.load() ] ), 3000 );
	assert.deepEqual( Object.keys( _a.types ), Object.keys( _b.types ) );
	assert.ok( Object.keys( _a.types ).every( type => _a.types[ type ] === _b.types[ type ] ) );
} );

attack( S, 'a type registered at runtime (as an approved proposal does) is known, created and offered', async () => {
	const _own = await Registry.load();
	class Extra extends registry.types.soft {

		static TYPE = 'extra_soft';

	}
	_own.types[ 'extra_soft' ] = Extra;
	assert.ok( _own.has( 'extra_soft' ) );
	assert.ok( _own.create( { id: 'x', type: 'extra_soft', values: { text: 't' } } ) instanceof Extra );
	assert.ok( _own.list().some( entry => entry.type === 'extra_soft' ) );
} );
