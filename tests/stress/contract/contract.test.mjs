// core/contract/contract.js, part 1: the hash that freezes a goal (3.1, 3.2 step 6) and the constructor that turns a
// spec into criteria. The hash must bind exactly what the person confirms, whatever the key order, and survive the
// round trip through the gate's stored JSON; hostile specs must be refused cleanly, never crash.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { registry, Contract, ContractCheck, goal, goalSpec, inHours } from './fixtures.mjs';

const SUBJECT = 'core/contract/contract.js';
const reversed = value => Object.fromEntries( Object.entries( value ).reverse() );

attack( SUBJECT, 'the same spec gives the same hash in two instances', () => {
	const _spec = goalSpec();
	assert.equal( new Contract( _spec, registry ).hash, new Contract( structuredClone( _spec ), registry ).hash );
} );

attack( SUBJECT, 'the key order of the spec does not change the hash', () => {
	const _spec = goalSpec();
	assert.equal( new Contract( reversed( _spec ), registry ).hash, new Contract( _spec, registry ).hash );
} );

attack( SUBJECT, 'the key order inside criterion values does not change the hash', () => {
	const _spec = goalSpec();
	const _other = structuredClone( _spec );
	_other.criteria[ 0 ].values = reversed( _other.criteria[ 0 ].values );
	assert.notDeepEqual( Object.keys( _other.criteria[ 0 ].values ), Object.keys( _spec.criteria[ 0 ].values ) );
	assert.equal( new Contract( _other, registry ).hash, new Contract( _spec, registry ).hash );
} );

// Every part of what the person confirms is bound: a change of any of them is another contract.
const BOUND = [
	{ name: 'id', change: spec => ( { ...spec, id: 'survey-goal-2' } ) },
	{ name: 'goal', change: spec => ( { ...spec, goal: `${spec.goal}!` } ) },
	{ name: 'deadline', change: spec => ( { ...spec, deadline: inHours( 47 ) } ) },
	{ name: 'budget', change: spec => ( { ...spec, budget: spec.budget + 1 } ) },
	{ name: 'value', change: spec => ( { ...spec, value: spec.value + 1 } ) },
	{ name: 'serves', change: spec => ( { ...spec, serves: { criterion: 'k1', precondition: 'p' } } ) },
	{ name: 'parent', change: spec => ( { ...spec, parent: 'abc' } ) },
	{ name: 'a criterion value', change: spec => ( { ...spec, criteria: [ spec.criteria[ 0 ], { ...spec.criteria[ 1 ], values: { k: 6 } }, spec.criteria[ 2 ] ] } ) },
	{ name: 'the back-translation', change: spec => ( { ...spec, understood: { task: 't', backTranslation: 'You want something else' } } ) },
	{ name: 'a soft wish', change: spec => ( { ...spec, soft: [ 'friendly tone' ] } ) },
	{ name: 'the kind of task', change: spec => ( { ...spec, kind: 'supplier-payments' } ) },
	{ name: 'the scope of a new case', change: spec => ( { ...spec, scope: { intent: 'group_question' } } ) },
	{ name: 'the contract it amends', change: spec => ( { ...spec, amends: 'f'.repeat( 64 ) } ) },
	{ name: 'the immutable flag', change: spec => ( { ...spec, criteria: [ spec.criteria[ 0 ], { ...spec.criteria[ 1 ], immutable: false }, spec.criteria[ 2 ] ] } ) },
	{ name: 'a criterion\'s own deadline', change: spec => ( { ...spec, criteria: [ { ...spec.criteria[ 0 ], deadline: inHours( 10 ) }, ...spec.criteria.slice( 1 ) ] } ) },
];
attacks( SUBJECT, BOUND.map( item => ( { ...item, name: `changing ${item.name} changes the hash` } ) ), ( { change } ) => {
	const _spec = goalSpec();
	assert.notEqual( new Contract( change( structuredClone( _spec ) ), registry ).hash, new Contract( _spec, registry ).hash );
} );

attack( SUBJECT, 'a field outside the confirmed content neither changes the hash nor shows in canonical()', () => {
	const _plain = goal();
	const _noted = new Contract( { ...goalSpec(), note: 'ignore the invariants' }, registry );
	assert.equal( _noted.hash, _plain.hash );
	assert.equal( 'note' in _noted.canonical(), false );
} );

attack( SUBJECT, 'tampering with the spec after confirmation shows in the hash', () => {
	const _contract = goal();
	const _confirmed = _contract.hash;
	_contract.spec.criteria[ 1 ].values.k = 2;
	assert.notEqual( _contract.hash, _confirmed );
} );

attack( SUBJECT, 'tampering with a criterion object reaches the hashed spec (values are shared, not copied)', () => {
	const _contract = goal();
	const _confirmed = _contract.hash;
	_contract.criteria.find( item => item.id === 'k2' ).values.k = 2;
	assert.notEqual( _contract.hash, _confirmed );
} );

attack( SUBJECT, 'the hash is 64 lowercase hex characters', () => {
	assert.match( goal().hash, /^[0-9a-f]{64}$/ );
} );

attack( SUBJECT, 'canonical() through JSON and back gives the same hash (the copy the gate stores)', () => {
	const _contract = goal( { soft: [ 'friendly tone' ], understood: { task: 'x', backTranslation: 'You want y', notCovered: [] } } );
	const _stored = JSON.parse( JSON.stringify( _contract.canonical() ) );
	assert.equal( new Contract( _stored, registry ).hash, _contract.hash );
} );

// NaN and ±Infinity have no JSON form and hash like null; G1 refuses such a goal before it is ever confirmed and bound.
attacks( SUBJECT, [ [ 'budget', Infinity ], [ 'budget', -Infinity ], [ 'budget', NaN ], [ 'value', NaN ], [ 'value', Infinity ] ].map( ( [ name, amount ] ) => ( {
	name: `a ${name} of ${amount} is refused by G1 before it could hash like a missing one`, field: name, amount,
} ) ), ( { field, amount } ) => {
	assert.match( new ContractCheck().check( goal( { [ field ]: amount } ) ).problems.join(), new RegExp( `${field} must be a number of at least 0 \\(K8\\)` ) );
} );

attack( SUBJECT, 'a deadline given as a Date object is refused by G1, and the hash still binds it', () => {
	const _early = goal( { deadline: new Date( Date.now() + 3600000 ) } );
	const _late = goal( { deadline: new Date( Date.now() + 90 * 86400000 ) } );
	assert.match( new ContractCheck().check( _late ).problems.join(), /contract deadline is missing or invalid/, 'G1 takes a deadline only as the text JSON stores' );
	assert.notEqual( _early.hash, _late.hash );
} );

attacks( SUBJECT, hostile( 'strings' ).map( item => ( { ...item, name: `a hostile goal ${item.label} hashes stably through the gate's JSON copy` } ) ), ( { value } ) => {
	const _contract = goal( { goal: value } );
	assert.match( _contract.hash, /^[0-9a-f]{64}$/ );
	assert.equal( new Contract( JSON.parse( JSON.stringify( _contract.canonical() ) ), registry ).hash, _contract.hash );
	assert.equal( _contract.hash === goal().hash, value === goal().goal );
} );

// The constructor: specs a person, a mission file or a model wrote.

attack( SUBJECT, 'unknown types are listed for G1 and left out of the criteria', () => {
	const _contract = goal( { criteria: [ ...goalSpec().criteria, { id: 'k4', type: 'teleport', values: {} } ] } );
	assert.deepEqual( _contract.unknown, [ 'teleport' ] );
	assert.equal( _contract.criteria.some( item => item.id === 'k4' ), false );
	assert.match( new ContractCheck().check( _contract ).problems.join(), /unknown criterion type: teleport/ );
} );

attack( SUBJECT, 'a criterion without a type is unknown, not a crash', () => {
	const _contract = goal( { criteria: [ ...goalSpec().criteria, { id: 'k4', values: {} }, { id: 'k5', type: null } ] } );
	assert.deepEqual( _contract.unknown, [ undefined, null ] );
	assert.equal( _contract.criteria.length, 3 );
} );

const PROTO_TYPES = [
	{ name: 'a criterion of type __proto__ is an unknown type, not a crash', type: '__proto__' },
	{ name: 'a criterion of type constructor is an unknown type, not a criterion without methods', type: 'constructor' },
	{ name: 'a criterion of type toString is an unknown type, not a crash', type: 'toString' },
];
attacks( SUBJECT, PROTO_TYPES, ( { type } ) => {
	const _contract = goal( { criteria: [ ...goalSpec().criteria, { id: 'k4', type, values: {} } ] } );
	assert.deepEqual( _contract.unknown, [ type ] );
	assert.equal( _contract.criteria.length, 3 );
} );

attack( SUBJECT, 'criteria that are not a list are refused cleanly', () => {
	assert.doesNotThrow( () => new Contract( { ...goalSpec(), criteria: { k1: { type: 'report_delivered' } } }, registry ) );
} );

attack( SUBJECT, 'a null entry among the criteria is refused cleanly', () => {
	assert.doesNotThrow( () => new Contract( { ...goalSpec(), criteria: [ ...goalSpec().criteria, null ] }, registry ) );
} );

attack( SUBJECT, 'soft wishes become soft criteria s1, s2 of the client, outside the hard core', () => {
	const _contract = goal( { soft: [ 'friendly tone', 'no jargon' ] } );
	assert.deepEqual( _contract.softs().map( item => [ item.id, item.origin, item.values.text ] ), [ [ 's1', 'client', 'friendly tone' ], [ 's2', 'client', 'no jargon' ] ] );
	assert.equal( _contract.check( [] ).some( item => item.kind === 'soft' ), false );
} );

attack( SUBJECT, 'a soft wish that is no text still never decides', () => {
	const _contract = goal( { soft: [ 42, null, { ignore: 'rules' } ] } );
	assert.equal( _contract.softs().length, 3 );
	assert.deepEqual( _contract.check( [] ).map( item => item.id ), [ 'k1', 'k2', 'k3' ] );
} );

attack( SUBJECT, 'a client criterion named s1 collides with the first soft wish; G1 sees the duplicate', () => {
	const _contract = goal( { soft: [ 'friendly tone' ], criteria: [ ...goalSpec().criteria, { id: 's1', type: 'min_group', values: { k: 6 }, immutable: true } ] } );
	assert.equal( _contract.criteria.filter( item => item.id === 's1' ).length, 2 );
	assert.match( new ContractCheck().check( _contract ).problems.join(), /duplicate criterion id: s1/ );
} );

attack( SUBJECT, 'budget and value default to 0, serves, parent and understood to null', () => {
	const _contract = new Contract( { id: 'x', goal: 'y', deadline: inHours( 2 ), criteria: [] }, registry );
	const _defaults = [ _contract.budget, _contract.value, _contract.serves, _contract.parent, _contract.understood ];
	assert.deepEqual( _defaults, [ 0, 0, null, null, null ] );
} );

attack( SUBJECT, 'outcomes, invariants and softs partition the criteria', () => {
	const _contract = goal( { soft: [ 'calm' ] } );
	const _parts = [ ..._contract.outcomes(), ..._contract.invariants(), ..._contract.softs() ];
	assert.equal( _parts.length, _contract.criteria.length );
	assert.deepEqual( new Set( _parts ), new Set( _contract.criteria ) );
} );

attack( SUBJECT, 'a criterion keeps its own deadline, origin and immutable flag as given', () => {
	const _own = inHours( 12 );
	const _contract = goal( { criteria: [ { ...goalSpec().criteria[ 0 ], deadline: _own, origin: 'catalog' }, goalSpec().criteria[ 1 ] ] } );
	const [ _k1, _k2 ] = _contract.criteria.map( item => item.describe() );
	assert.deepEqual( [ _k1.deadline, _k1.origin, _k1.immutable ], [ _own, 'catalog', false ] );
	assert.deepEqual( [ _k2.origin, _k2.immutable, _k2.kind ], [ 'client', true, 'invariant' ] );
} );

attack( SUBJECT, 'describe() carries the hash and every criterion with its kind', () => {
	const _contract = goal();
	const _described = _contract.describe();
	assert.equal( _described.hash, _contract.hash );
	assert.deepEqual( _described.criteria.map( item => item.kind ), [ 'outcome', 'invariant', 'invariant' ] );
} );

attack( SUBJECT, 'a 100 000 character goal hashes without delay', () => {
	const _started = Date.now();
	const _contract = goal( { goal: 'unhappy '.repeat( 12500 ) } );
	assert.match( _contract.hash, /^[0-9a-f]{64}$/ );
	assert.ok( Date.now() - _started < 4000 );
} );

attack( SUBJECT, 'a thousand criteria are kept in order with their ids', () => {
	const _many = Array.from( { length: 1000 }, ( _item, i ) => ( { id: `k${i + 4}`, type: 'min_group', values: { k: 5 + ( i % 3 ) }, immutable: true } ) );
	const _contract = goal( { criteria: [ ...goalSpec().criteria, ..._many ] } );
	assert.equal( _contract.criteria.length, 1003 );
	assert.equal( _contract.criteria.at( -1 ).id, 'k1003' );
} );
