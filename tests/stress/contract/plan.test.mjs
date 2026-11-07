// core/loop/plan.js: turns a strategy into a concrete plan by filling {{placeholders}} from the mission parameters,
// the criteria and the slots. A value is inserted exactly once and literally: a value that looks like a placeholder,
// a replacement pattern or a piece of JSON must never be read again, and no value may change which move a step runs.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Plan, Node, Contract, registry, nodeOf, goalSpec, survey } from './fixtures.mjs';

const SUBJECT = 'core/loop/plan.js';
const MISSION = { params: { focus: [ 'design' ], department: [ 'design', 'product' ] } };
const items = list => ( { id: 'per-item', steps: [ { move: 'invoice.child', forEach: '{{items}}', params: { invoice: '{{item}}' }, target: '{{item}}' } ], list } );
const resolveItems = list => Plan.resolve( items( list ), nodeOf(), { params: { items: list } } );

attack( SUBJECT, 'mission parameters and criterion values are what a placeholder may name', () => {
	const _slots = Plan.slots( nodeOf(), MISSION );
	assert.deepEqual( [ _slots.focus, _slots.department, _slots.to, _slots.topic ], [ [ 'design' ], [ 'design', 'product' ], 'hr', 'design team morale' ] );
} );

attack( SUBJECT, 'a criterion value its type does not declare fills no slot, even in a contract G1 never saw', () => {
	const _values = JSON.parse( '{ "to": "hr", "topic": "x", "focus": [ "ceo" ], "item": "R-9", "__proto__": { "department": [ "board" ] } }' );
	const _slots = Plan.slots( nodeOf( {}, [ { id: 'k1', type: 'report_delivered', values: _values } ] ), MISSION );
	assert.deepEqual( [ _slots.focus, _slots.item, _slots.department, _slots.to ], [ [ 'design' ], undefined, [ 'design', 'product' ], 'hr' ] );
	assert.equal( Object.getPrototypeOf( _slots ), Object.prototype );
} );

attack( SUBJECT, 'a child names the precondition it serves as {{item}}', () => {
	const _child = nodeOf( { serves: { criterion: 'k1', precondition: 'answers-design' } } );
	assert.equal( Plan.slots( _child, MISSION ).item, 'answers-design' );
	assert.equal( Plan.slots( nodeOf(), MISSION ).item, undefined );
} );

attack( SUBJECT, 'the scope of a new case comes after mission and criteria, extra values last', () => {
	const _node = nodeOf( { scope: { focus: [ 'product' ], sender: 'a@b' } } );
	assert.deepEqual( Plan.slots( _node, MISSION ).focus, [ 'product' ] );
	assert.deepEqual( Plan.slots( _node, MISSION, { focus: [ 'sales' ] } ).focus, [ 'sales' ] );
} );

attack( SUBJECT, 'the question for the person names the criterion, its values and the goal', () => {
	const _node = nodeOf( {}, [ { id: 'k1', type: 'event_occurred', values: { event: 'kick-off' }, byPerson: true } ] );
	const _slots = Plan.slots( _node, MISSION );
	assert.equal( _slots.byPerson, 'k1' );
	assert.equal( _slots.byPersonQuestion, 'Is this fulfilled: event_occurred {"event":"kick-off"}? (goal: Find out why the design team is unhappy)' );
} );

attack( SUBJECT, 'the slots are a fresh object; changing them changes neither the mission nor the criteria', () => {
	const _node = nodeOf();
	const _slots = Plan.slots( _node, MISSION );
	_slots.focus = [ 'ceo' ];
	_slots.to = 'everyone';
	assert.deepEqual( [ MISSION.params.focus, _node.contract.criteria[ 0 ].values.to ], [ [ 'design' ], 'hr' ] );
} );

attacks( SUBJECT, [
	{ name: '|subject takes what follows the first colon', expression: 'quantity|subject', slots: { quantity: 'answers:design' }, expected: 'design' },
	{ name: '|subject keeps further colons', expression: 'quantity|subject', slots: { quantity: 'a:b:c' }, expected: 'b:c' },
	{ name: '|subject of a value without a colon is empty', expression: 'quantity|subject', slots: { quantity: 'answers' }, expected: '' },
	{ name: '|subject of a missing value is empty', expression: 'nothing|subject', slots: {}, expected: '' },
	{ name: '|first takes the first of a list', expression: 'focus|first', slots: { focus: [ 'design', 'product' ] }, expected: 'design' },
	{ name: '|first of a single value is that value', expression: 'focus|first', slots: { focus: 'design' }, expected: 'design' },
	{ name: 'an unknown filter leaves the value as it is', expression: 'focus|upper', slots: { focus: 'design' }, expected: 'design' },
], ( { expression, slots, expected } ) => {
	assert.deepEqual( Plan.value( slots, expression ), expected );
} );

attack( SUBJECT, 'a whole placeholder keeps the type of its value', () => {
	const _slots = { list: [ 1, 2 ], number: 5, object: { a: 1 }, flag: false };
	assert.deepEqual( [ '{{list}}', '{{number}}', '{{object}}', '{{flag}}' ].map( text => Plan.fill( text, _slots ) ), [ [ 1, 2 ], 5, { a: 1 }, false ] );
} );

attack( SUBJECT, 'a placeholder inside text becomes text; a list is joined with commas', () => {
	assert.equal( Plan.fill( 'teams: {{department}}!', MISSION.params ), 'teams: design,product!' );
} );

attack( SUBJECT, 'a missing placeholder is undefined on its own and empty inside text', () => {
	assert.deepEqual( [ Plan.fill( '{{nothing}}', {} ), Plan.fill( 'a{{nothing}}b', {} ) ], [ undefined, 'ab' ] );
} );

attack( SUBJECT, 'objects and lists are filled all the way down; other values stay as they are', () => {
	const _filled = Plan.fill( { a: [ '{{x}}', { b: 'y {{x}}' } ], n: 3, t: true, z: null }, { x: 'X' } );
	assert.deepEqual( _filled, { a: [ 'X', { b: 'y X' } ], n: 3, t: true, z: null } );
} );

attacks( SUBJECT, [ '{{ teams }}', '{{teams}', '{teams}}', '{{te-ams}}', '{{in:48h}}', '{{}}', '{{teams.0}}' ]
	.map( text => ( { name: `${text} is no placeholder and stays as it is`, text } ) ), ( { text } ) => {
	assert.equal( Plan.fill( text, { teams: [ 'x' ], te: 'y', ams: 'z' } ), text );
} );

attack( SUBJECT, 'three braces keep the outer ones', () => {
	assert.equal( Plan.fill( '{{{to}}}', { to: 'hr' } ), '{hr}' );
} );

attack( SUBJECT, 'a value that looks like a placeholder is not filled again', () => {
	const _slots = { a: '{{b}}', b: 'secret' };
	assert.deepEqual( [ Plan.fill( '{{a}}', _slots ), Plan.fill( 'x {{a}} y', _slots ) ], [ '{{b}}', 'x {{b}} y' ] );
} );

attack( SUBJECT, 'replacement patterns in a value are inserted literally', () => {
	for ( const value of [ '$&', '$\'', '$`', '$1', '$$' ] ) {
		assert.equal( Plan.fill( 'a {{v}} b', { v: value } ), `a ${value} b` );
	}
} );

attack( SUBJECT, '{{__proto__}} names nothing', () => {
	assert.equal( Plan.fill( '{{__proto__}}', {} ), undefined );
} );

attack( SUBJECT, '{{constructor}} inside text names nothing', () => {
	assert.equal( Plan.fill( 'to {{constructor}}', {} ), 'to ' );
} );

attacks( SUBJECT, hostile( 'strings' ).map( item => ( { ...item, name: `the hostile value ${item.label} is inserted literally` } ) ), ( { value } ) => {
	assert.equal( Plan.fill( '<{{v}}>', { v: value } ), `<${value}>` );
	assert.equal( Plan.fill( '{{v}}', { v: value } ), value );
} );

// From a strategy to a plan.

attack( SUBJECT, 'a strategy becomes a plan bound to the hash of the node\'s contract', () => {
	const _node = nodeOf();
	const _plan = Plan.resolve( survey.strategies.find( item => item.id === 'team-report' ), _node, survey );
	assert.deepEqual( [ _plan.strategy, _plan.contract ], [ 'team-report', _node.contract.hash ] );
	assert.deepEqual( _plan.steps.map( step => step.move ), [ 'analysis.write', 'analysis.run', 'report.draft', 'report.send' ] );
	assert.deepEqual( [ _plan.steps[ 1 ].params, _plan.steps[ 3 ].target ], [ { teams: [ 'design', 'product' ] }, 'hr' ] );
} );

attack( SUBJECT, 'empty and missing parameters are left out; null, 0 and false are kept', () => {
	const _plan = Plan.resolve( { id: 's', steps: [ { move: 'm', params: { a: '', b: '{{nothing}}', c: null, d: 0, e: false, f: 'x' } } ] }, nodeOf(), MISSION );
	assert.deepEqual( _plan.steps[ 0 ].params, { c: null, d: 0, e: false, f: 'x' } );
} );

attack( SUBJECT, 'a step without parameters gets empty parameters; a missing target stays undefined', () => {
	const _plan = Plan.resolve( { id: 's', steps: [ { move: 'm' }, { move: 'n', target: '{{nobody}}' } ] }, nodeOf(), MISSION );
	assert.deepEqual( _plan.steps.map( step => [ step.params, step.target ] ), [ [ {}, undefined ], [ {}, undefined ] ] );
} );

attack( SUBJECT, 'the slots the model filled are used', () => {
	const _plan = Plan.resolve( survey.strategies.find( item => item.id === 'team-report' ), nodeOf(), survey, { teams: [ 'design' ] } );
	assert.deepEqual( _plan.steps[ 1 ].params, { teams: [ 'design' ] } );
} );

attack( SUBJECT, 'a slot value that looks like a placeholder is not filled again in the plan', () => {
	const _plan = Plan.resolve( survey.strategies.find( item => item.id === 'team-report' ), nodeOf(), survey, { teams: '{{department}}' } );
	assert.equal( _plan.steps[ 1 ].params.teams, '{{department}}' );
} );

attack( SUBJECT, 'no slot value can add a step or change a move', () => {
	const _strategy = survey.strategies.find( item => item.id === 'team-report' );
	const _plan = Plan.resolve( _strategy, nodeOf(), survey, { move: 'payment.send', steps: [ { move: 'payment.send' } ], target: 'bank' } );
	assert.deepEqual( _plan.steps.map( step => step.move ), _strategy.steps.map( step => step.move ) );
	assert.equal( _plan.steps[ 3 ].target, 'hr' );
} );

attack( SUBJECT, 'forEach makes one step per item, {{item}} naming each', () => {
	const _plan = resolveItems( [ 'R-1', 'R-2', 'R-3' ] );
	assert.deepEqual( _plan.steps.map( step => [ step.move, step.item, step.params.invoice, step.target ] ), [
		[ 'invoice.child', 'R-1', 'R-1', 'R-1' ], [ 'invoice.child', 'R-2', 'R-2', 'R-2' ], [ 'invoice.child', 'R-3', 'R-3', 'R-3' ],
	] );
	assert.equal( 'forEach' in _plan.steps[ 0 ], false );
} );

attack( SUBJECT, 'forEach over an empty or missing list makes no step', () => {
	assert.deepEqual( resolveItems( [] ).steps, [] );
	assert.deepEqual( Plan.resolve( items( null ), nodeOf(), { params: {} } ).steps, [] );
} );

attack( SUBJECT, 'the invoice strategy makes one child per invoice of the contract', () => {
	const _invoices = new Node( { contract: new Contract( { ...goalSpec(), criteria: [ { id: 'k1', type: 'items_resolved',
		values: { collection: 'invoices', items: [ 'R-1184', 'R-1185' ], outcomes: [ 'paid' ] } } ] }, registry ) } );
	const _plan = Plan.resolve( { id: 'one-child-per-invoice', steps: [ { move: 'invoice.child', forEach: '{{items}}' } ] }, _invoices, {} );
	assert.deepEqual( _plan.steps.map( step => step.item ), [ 'R-1184', 'R-1185' ] );
} );

attack( SUBJECT, 'forEach over a single text is one step, not a crash', () => {
	assert.deepEqual( Plan.resolve( items(), nodeOf(), { params: { items: 'R-1' } } ).steps.map( step => step.item ), [ 'R-1' ] );
} );

attack( SUBJECT, 'an item with quotes or a backslash is inserted as it is', () => {
	const _plan = resolveItems( [ 'R-"1"', 'C:\\bank' ] );
	assert.deepEqual( _plan.steps.map( step => step.params.invoice ), [ 'R-"1"', 'C:\\bank' ] );
} );

attack( SUBJECT, 'an item can never change the move or the target of its step', () => {
	const _strategy = { id: 'per-item', steps: [ { move: 'invoice.child', forEach: '{{items}}', params: { invoice: '{{item}}' } } ] };
	const _item = 'R-1"},"move":"payment.send","target":"bank","x":{"y":"';
	const _plan = Plan.resolve( _strategy, nodeOf(), { params: { items: [ _item ] } } );
	assert.deepEqual( _plan.steps.map( step => [ step.move, step.target, step.params.invoice ] ), [ [ 'invoice.child', undefined, _item ] ] );
} );

attack( SUBJECT, 'an item with replacement patterns is inserted as it is', () => {
	assert.deepEqual( resolveItems( [ 'a$&b', '$\'' ] ).steps.map( step => step.params.invoice ), [ 'a$&b', '$\'' ] );
} );

attack( SUBJECT, 'an item that is no text is inserted as its text form', () => {
	assert.deepEqual( resolveItems( [ 7, true ] ).steps.map( step => step.params.invoice ), [ '7', 'true' ] );
} );

attack( SUBJECT, 'resolving leaves the strategy as it was', () => {
	const _strategy = structuredClone( survey.strategies.find( item => item.id === 'team-report' ) );
	const _before = JSON.stringify( _strategy );
	Plan.resolve( _strategy, nodeOf(), survey, { teams: [ 'design' ] } );
	const _each = items( [ 'R-1' ] );
	const _eachBefore = JSON.stringify( _each );
	Plan.resolve( _each, nodeOf(), { params: { items: [ 'R-1' ] } } );
	assert.deepEqual( [ JSON.stringify( _strategy ), JSON.stringify( _each ) ], [ _before, _eachBefore ] );
} );

attack( SUBJECT, 'the defaults of every slot come from the mission and the goal', () => {
	const _widen = survey.strategies.find( item => item.id === 'widen-group' );
	assert.deepEqual( Plan.defaults( _widen, nodeOf(), survey ), { teams: [ 'design', 'product' ] } );
	assert.deepEqual( Plan.defaults( { id: 'plain', steps: [] }, nodeOf(), survey ), {} );
} );

attack( SUBJECT, 'compact keeps every value except undefined and empty text', () => {
	assert.deepEqual( Plan.compact( { a: undefined, b: '', c: ' ', d: [], e: {}, f: Number.NaN } ), { c: ' ', d: [], e: {}, f: Number.NaN } );
} );
