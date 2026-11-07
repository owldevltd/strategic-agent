// The move catalog (6.1, 6.2): base moves plus the moves of a mission. A plan may only use moves listed here (G2). Every
// entry carries the fields of 6.2; for an outward action the gate's action table is the one source of criticality,
// sensitive parameters, idempotency and commitments. validate() reports what is broken instead of guessing.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Catalog, Actions, actions, move, catalogs } from './fixtures.mjs';

const SUBJECT = 'core/move/catalog.js';
const validate = moves => new Catalog( moves ).validate();

attacks( SUBJECT, Catalog.FIELDS.map( field => ( { name: `a move without ${field} is reported (6.2)`, field } ) ), ( item ) => {
	const _move = move();
	delete _move[ item.field ];
	assert.ok( validate( { 'x.do': _move } ).includes( `x.do: ${item.field} is missing (6.2)` ) );
} );

// A model step must inherit the labels of its inputs (10.4), so the AI move here says so.
attacks( SUBJECT, Catalog.EXECUTORS.map( name => ( { name: `the base move ${name} is a valid executor`, value: name } ) ), ( item ) => {
	assert.deepEqual( validate( { 'x.do': move( { executor: item.value, ...( item.value === 'ai' ? { inherit: true } : {} ) } ) } ), [] );
} );

attacks( SUBJECT, [
	{ name: '6.2: an outside action is no base move of its own (gate)', value: 'gate' },
	{ name: 'an executor in other case is not a base move', value: 'Code' },
	{ name: 'a model is no executor of its own (llm)', value: 'llm' },
	{ name: 'a missing executor value is not a base move', value: null },
], ( item ) => {
	assert.ok( validate( { 'x.do': move( { executor: item.value } ) } ).includes( `x.do: ${item.value} is not a base move` ) );
} );

attacks( SUBJECT, Catalog.CRITICALITY.map( level => ( { name: `the criticality ${level} is known`, value: level } ) ), ( item ) => {
	assert.deepEqual( validate( { 'x.do': move( { criticality: item.value } ) } ), [] );
} );

attacks( SUBJECT, [ 'dangerous', 'OUTWARD', '' ].map( value => ( { name: `the criticality ${JSON.stringify( value )} is unknown`, value } ) ), ( item ) => {
	assert.ok( validate( { 'x.do': move( { criticality: item.value } ) } ).includes( `x.do: criticality ${item.value} is unknown` ) );
} );

attack( SUBJECT, 'an action the gate does not know is reported', () => {
	assert.ok( validate( { 'x.send': move( { action: 'wire_transfer' } ) } ).includes( 'x.send: the gate knows no action wire_transfer' ) );
} );

attacks( SUBJECT, [ 'constructor', 'toString', '__proto__' ].map( name => ( { name: `an action named ${name} is unknown to the gate`, value: name } ) ), ( item ) => {
	const _moves = JSON.parse( `{"x.send": ${JSON.stringify( move() ).replace( /^\{/, `{"action":"${item.value}",` )}}` );
	assert.ok( validate( _moves ).includes( `x.send: the gate knows no action ${item.value}` ), validate( _moves ).join( '; ' ) );
} );

attack( SUBJECT, 'the gate\'s table decides the criticality of an action move, whatever the move says', () => {
	const _catalog = new Catalog( { 'x.pay': move( { action: 'payment', criticality: 'read' } ) } );
	assert.equal( _catalog.get( 'x.pay' ).criticality, 'money_or_law' );
} );

attack( SUBJECT, 'a move cannot declare away the sensitive parameters of its action', () => {
	assert.deepEqual( new Catalog( { 'x.pay': move( { action: 'payment', sensitive: [] } ) } ).get( 'x.pay' ).sensitive, [ 'iban' ] );
} );

attack( SUBJECT, 'a move cannot declare away the commitment of its action', () => {
	assert.equal( new Catalog( { 'x.pay': move( { action: 'payment', commits: null } ) } ).get( 'x.pay' ).commits, 'payment' );
} );

attack( SUBJECT, 'a move cannot extend the idempotency the service gives', () => {
	assert.equal( new Catalog( { 'x.pay': move( { action: 'payment', idempotencyH: 9999 } ) } ).get( 'x.pay' ).idempotencyH, 168 );
} );

attacks( SUBJECT, Object.keys( actions.table ).map( name => ( { name: `a move of the action ${name} shows the gate's values`, action: name } ) ), ( item ) => {
	const _entry = new Catalog( { 'x.act': move( { action: item.action } ) } ).get( 'x.act' );
	const _table = actions.table[ item.action ];
	assert.deepEqual( [ _entry.criticality, _entry.sensitive, _entry.idempotencyH, _entry.commits ],
		[ _table.criticality, _table.sensitive || [], _table.idempotencyH ?? null, _table.commits || null ] );
} );

attack( SUBJECT, 'G-7a: an action whose service keeps no key has no idempotency (at most one attempt)', () => {
	const _table = new Actions( { sms: { criticality: 'outward', carries: [ 'message' ] } } );
	const _entry = new Catalog( { 'x.sms': move( { action: 'sms' } ) }, _table ).get( 'x.sms' );
	assert.deepEqual( [ _entry.idempotencyH, _entry.sensitive, _entry.commits ], [ null, [], null ] );
} );

attack( SUBJECT, 'a move that is no action keeps its own criticality, without sensitive parameters or idempotency', () => {
	const _entry = new Catalog( { 'x.read': move( { criticality: 'read' } ) } ).get( 'x.read' );
	assert.deepEqual( [ _entry.criticality, _entry.sensitive, _entry.idempotencyH ], [ 'read', [], null ] );
} );

attack( SUBJECT, 'validate follows the gate\'s own copy of the table: an action it dropped is reported', () => {
	const _catalog = new Catalog( { 'x.pay': move( { action: 'payment' } ) } );
	const _without = new Actions( { report: actions.table.report } );
	assert.deepEqual( _catalog.validate( _without ), [ 'x.pay: the gate knows no action payment' ] );
} );

attack( SUBJECT, 'every broken move is reported, not only the first', () => {
	const _problems = validate( { 'a.do': move( { executor: 'gate' } ), 'b.do': move( { criticality: 'loud' } ), 'c.do': move() } );
	assert.deepEqual( _problems, [ 'a.do: gate is not a base move', 'b.do: criticality loud is unknown' ] );
} );

attacks( SUBJECT, [
	{ name: 'a move given as text is reported field by field', value: 'report.send' },
	{ name: 'a move given as a number is reported field by field', value: 42 },
	{ name: 'a move given as an empty object is reported field by field', value: {} },
], ( item ) => {
	const _problems = validate( { 'x.do': item.value } );
	assert.ok( _problems.includes( 'x.do: executor is missing (6.2)' ) );
	assert.ok( _problems.includes( 'x.do: price is missing (6.2)' ) );
} );

attack( SUBJECT, 'a move given as null is reported by validate instead of crashing the catalog', () => {
	assert.ok( validate( { 'x.do': null, 'y.do': move() } ).some( problem => /^x\.do: /.test( problem ) ) );
} );

attacks( SUBJECT, [
	{ name: 'a negative price', price: -5 },
	{ name: 'a price that is text', price: 'free' },
	{ name: 'a price that is NaN', price: NaN },
	{ name: 'a price that is undefined', price: undefined },
].map( item => ( { ...item, name: `${item.name} is reported: G2 adds prices to check the budget` } ) ), ( item ) => {
	assert.ok( validate( { 'x.do': move( { price: item.price } ) } ).some( problem => /price/.test( problem ) ) );
} );

attacks( SUBJECT, [
	{ name: 'parameters given as text', params: 'iban' },
	{ name: 'parameters given as a list', params: [ 'iban' ] },
].map( item => ( { ...item, name: `${item.name} are reported: 6.2 asks for parameter types` } ) ), ( item ) => {
	assert.ok( validate( { 'x.do': move( { params: item.params } ) } ).some( problem => /params/.test( problem ) ) );
} );

attack( SUBJECT, 'an AI move that does not inherit the labels of its inputs is reported (10.4)', () => {
	assert.ok( validate( { 'x.write': move( { executor: 'ai', labels: [] } ) } ).some( problem => /inherit/.test( problem ) ) );
} );

attacks( SUBJECT, [
	{ name: 'a label outside 10.4 on a move is reported', extra: { labels: [ 'trusted' ] } },
	{ name: 'labels given as one text are reported', extra: { labels: 'own' } },
	{ name: 'a field label outside 10.4 is reported', extra: { fieldLabels: { iban: [ 'clean' ] } } },
	{ name: 'field labels given as a list are reported', extra: { fieldLabels: [ 'own' ] } },
], ( item ) => {
	assert.ok( validate( { 'x.do': move( item.extra ) } ).some( problem => /labels/i.test( problem ) ), validate( { 'x.do': move( item.extra ) } ).join( '; ' ) );
} );

attacks( SUBJECT, [ [ 'base', () => Catalog.load() ], [ 'survey', catalogs.survey ], [ 'invoices', catalogs.invoices ] ].map( ( [ name, load ] ) => ( {
	name: `the ${name} catalog as shipped validates without problems`, load,
} ) ), ( item ) => {
	assert.deepEqual( item.load().validate(), [] );
} );

attacks( SUBJECT, [ [ 'survey', catalogs.survey ], [ 'invoices', catalogs.invoices ] ].map( ( [ name, load ] ) => ( {
	name: `every outward move of the ${name} catalog is delivered with a gate receipt and observed until a horizon`, load,
} ) ), ( item ) => {
	const _outward = Object.entries( item.load().moves ).filter( ( [ , entry ] ) => entry.action );
	assert.ok( _outward.length >= 3 );
	for ( const [ name, entry ] of _outward ) {
		assert.ok( entry.evidence.includes( 'delivered' ), name );
		assert.ok( entry.horizonH > 0, name );
		assert.equal( actions.outward( entry.action ), true, name );
	}
} );

attacks( SUBJECT, [ [ 'survey', catalogs.survey ], [ 'invoices', catalogs.invoices ] ].map( ( [ name, load ] ) => ( {
	name: `every price in the ${name} catalog is a number of at least zero`, load,
} ) ), ( item ) => {
	for ( const [ name, entry ] of Object.entries( item.load().moves ) ) {
		assert.ok( typeof entry.price === 'number' && entry.price >= 0, name );
	}
} );

attack( SUBJECT, 'a mission adds its moves to the base moves', () => {
	const _catalog = Catalog.load( { moves: { 'x.do': move() } } );
	assert.ok( _catalog.get( 'x.do' ) && _catalog.get( 'report.send' ) );
} );

attack( SUBJECT, 'without a mission the catalog holds the base moves only: none of a mission, no payment', () => {
	assert.equal( Catalog.load().get( 'survey.rows' ), null );
	assert.equal( Catalog.load().get( 'payment.send' ), null, 'paying is a mission\'s move, not the engine\'s' );
	assert.ok( Catalog.load().get( 'person.decide' ) );
} );

attack( SUBJECT, 'a mission that redefines an outward move cannot lower its criticality below the gate\'s', () => {
	const _catalog = Catalog.load( { moves: { 'payment.send': move( { action: 'payment', criticality: 'read', price: 0 } ) } } );
	assert.equal( _catalog.get( 'payment.send' ).criticality, 'money_or_law' );
} );

attack( SUBJECT, 'a mission move named __proto__ in its JSON is a move like any other', () => {
	const _catalog = Catalog.load( { moves: JSON.parse( `{"__proto__": ${JSON.stringify( move() )}}` ) } );
	assert.equal( _catalog.get( '__proto__' ).executor, 'code' );
	assert.deepEqual( _catalog.validate(), [] );
} );

attack( SUBJECT, 'a known move is found by its exact name only', () => {
	const _catalog = catalogs.invoices();
	assert.equal( _catalog.get( 'payment.send' ).action, 'payment' );
	assert.equal( _catalog.get( 'Payment.send' ), null );
	assert.equal( _catalog.get( 'payment.send ' ), null );
} );

attacks( SUBJECT, [ ...hostile( 'keys' ), { label: 'keys "toString"', value: 'toString' }, { label: 'keys "hasOwnProperty"', value: 'hasOwnProperty' },
	{ label: 'keys "valueOf"', value: 'valueOf' } ].map( item => ( {
	...item, name: `a move named ${item.label} that no catalog lists is not found`,
} ) ), ( item ) => {
	const _catalog = catalogs.invoices();
	assert.equal( _catalog.get( item.value ), null );
} );

attacks( SUBJECT, hostile( 'types' ).filter( item => typeof item.value !== 'symbol' ).map( item => ( {
	...item, name: `a move name of ${item.label} finds nothing and costs the default`,
} ) ), ( item ) => {
	const _catalog = catalogs.invoices();
	assert.equal( _catalog.get( item.value ), null );
	assert.equal( _catalog.cost( item.value ), 1 );
} );

attacks( SUBJECT, [
	{ name: 'the cost of a move is its price', moves: { 'x.do': move( { price: 0.3 } ) }, expected: 0.3 },
	{ name: 'a free move costs nothing, not the default', moves: { 'x.do': move( { price: 0 } ) }, expected: 0 },
	{ name: 'a move without a price costs the default of one unit', moves: { 'x.do': { executor: 'code' } }, expected: 1 },
	{ name: 'a move with price null costs the default of one unit', moves: { 'x.do': move( { price: null } ) }, expected: 1 },
], ( item ) => {
	assert.equal( new Catalog( item.moves ).cost( 'x.do' ), item.expected );
} );

attack( SUBJECT, 'the catalog never changes the definitions it was given', () => {
	const _moves = { 'x.pay': move( { action: 'payment', criticality: 'read' } ) };
	const _copy = structuredClone( _moves );
	new Catalog( _moves ).validate();
	assert.deepEqual( _moves, _copy );
} );

attack( SUBJECT, 'five thousand moves are built and validated quickly', () => {
	const _moves = Object.fromEntries( Array.from( { length: 5000 }, ( _, i ) => [ `m.${i}`, move( i % 2 ? { action: 'report' } : {} ) ] ) );
	const _start = Date.now();
	assert.deepEqual( validate( _moves ), [] );
	assert.ok( Date.now() - _start < 2000 );
} );
