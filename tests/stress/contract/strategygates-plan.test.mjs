// core/gates/strategygates.js, part 2: lifting (only a person), expiry and scope of the instances in force, and the
// checks themselves: restrict and order on a resolved plan at G2, precondition before a move runs (7.3, 16.4, 21).
// A bound must hold for every value a plan can carry; hostile scopes and values must never break the store.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { registry, StrategyGates, memoryDb, nodeOf, catalogOf, survey } from './fixtures.mjs';

const SUBJECT = 'core/gates/strategygates.js';
const NOW = Date.parse( '2026-11-04T12:00:00Z' );
const DAY = 86400000;
const at = days => new Date( NOW + days * DAY ).toISOString();
const clock = { now: NOW };
const store = () => new StrategyGates( memoryDb(), { now: () => clock.now } );
const RESTRICT = { rule: 'restrict', move: 'analysis.run', param: 'teams', allowed: [ 'design', 'product' ], expires: at( 30 ) };
const PRECONDITION = { rule: 'precondition', move: 'report.send', criterion: { type: 'number_in_range', values: { quantity: 'answers:{{target}}', min: 5 } } };
const scope = { scope: 'hr-survey', registry };
const plan = ( ...steps ) => ( { steps } );
const gate = extra => ( { id: 'sg-1', rule: 'restrict', move: 'm', param: 'n', ...extra } );
const measured = value => ( { kind: 'measured', evidenceClass: 'observation', source: 'count', data: { quantity: 'answers:hr', value } } );

attack( SUBJECT, 'the agent never lifts an instance, nor does anyone unnamed', () => {
	const _store = store();
	const { id } = _store.propose( RESTRICT, scope );
	for ( const by of [ 'agent', '', undefined, null ] ) {
		assert.equal( _store.lift( id, { by } ), false, String( by ) );
	}
	assert.equal( _store.active( 'hr-survey' ).length, 1 );
} );

attack( SUBJECT, 'a person lifts an instance once; lifting again or an unknown id does nothing', () => {
	const _store = store();
	const { id } = _store.propose( RESTRICT, scope );
	assert.deepEqual( [ _store.lift( id, { by: 'hr-lead' } ), _store.lift( id, { by: 'hr-lead' } ), _store.lift( 'sg-none', { by: 'hr-lead' } ) ], [ true, false, false ] );
	assert.deepEqual( _store.active( 'hr-survey' ), [] );
} );

attack( SUBJECT, 'a lifted instance cannot be lifted back into force by tightening it', () => {
	const _store = store();
	const { id } = _store.propose( RESTRICT, scope );
	_store.lift( id, { by: 'hr-lead' } );
	assert.equal( _store.db.get( 'SELECT status FROM strategy_gates WHERE id = :id', { id } ).status, 'lifted' );
	assert.equal( _store.propose( { ...RESTRICT, allowed: [ 'design' ] }, scope ).ok, true );
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.allowed ), [ [ 'design' ] ] );
} );

attack( SUBJECT, 'an instance that has expired is no longer in force', () => {
	const _store = store();
	_store.propose( { ...RESTRICT, expires: at( 2 ) }, scope );
	assert.equal( _store.has( 'hr-survey' ), true );
	clock.now = NOW + 3 * DAY;
	try {
		assert.equal( _store.has( 'hr-survey' ), false );
	} finally {
		clock.now = NOW;
	}
} );

attack( SUBJECT, 'an instance for "*" is in force for every kind', () => {
	const _store = store();
	_store.propose( RESTRICT, { ...scope, scope: '*' } );
	assert.deepEqual( [ 'hr-survey', 'supplier-payments', 'meta' ].map( kind => _store.active( kind ).length ), [ 1, 1, 1 ] );
} );

attack( SUBJECT, 'instances come back in the order they were set', () => {
	const _store = store();
	_store.propose( RESTRICT, scope );
	clock.now = NOW + 1000;
	try {
		_store.propose( { rule: 'order', before: 'analysis.write', after: 'analysis.run', expires: at( 30 ) }, scope );
	} finally {
		clock.now = NOW;
	}
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.rule ), [ 'restrict', 'order' ] );
} );

attacks( SUBJECT, hostile( 'keys' ).map( item => ( { ...item, name: `the scope ${item.label} holds its instances apart from every other scope` } ) ), ( { value } ) => {
	const _store = store();
	assert.deepEqual( _store.active( value ), [] );
	assert.equal( _store.propose( RESTRICT, { ...scope, scope: value } ).ok, true );
	assert.equal( _store.active( value ).length, 1 );
	assert.deepEqual( _store.active( 'hr-survey' ), [] );
} );

attack( SUBJECT, 'a scope written as SQL stays a name', () => {
	const _store = store();
	_store.propose( RESTRICT, { ...scope, scope: '\' OR 1=1; DROP TABLE strategy_gates; --' } );
	assert.deepEqual( _store.active( 'hr-survey' ), [] );
	assert.equal( _store.db.get( 'SELECT COUNT(*) AS n FROM strategy_gates' ).n, 1 );
} );

attack( SUBJECT, 'allowed values with quotes, markup and emoji come back exactly', () => {
	const _store = store();
	const _allowed = [ 'd\'e"s', '<script>', '😀👨‍👩‍👧', '\u0000' ];
	_store.propose( { ...RESTRICT, allowed: _allowed }, scope );
	assert.deepEqual( _store.active( 'hr-survey' )[ 0 ].allowed, _allowed );
} );

// G2: restrict and order on a resolved plan.

attacks( SUBJECT, [
	{ name: 'a value outside the allowed ones is refused', params: { n: 'sales' }, extra: { allowed: [ 'design' ] }, refused: true },
	{ name: 'a list with one value outside the allowed ones is refused', params: { n: [ 'design', 'sales' ] }, extra: { allowed: [ 'design' ] }, refused: true },
	{ name: 'a list of allowed values passes', params: { n: [ 'design' ] }, extra: { allowed: [ 'design', 'product' ] }, refused: false },
	{ name: 'a value above the upper bound is refused', params: { n: 6 }, extra: { max: 5 }, refused: true },
	{ name: 'a value at the upper bound passes', params: { n: 5 }, extra: { max: 5 }, refused: false },
	{ name: 'a value below the lower bound is refused', params: { n: 2 }, extra: { min: 3 }, refused: true },
	{ name: 'a number written as text is compared as a number', params: { n: '7' }, extra: { max: 5 }, refused: true },
	{ name: 'a value that is no number cannot stay within an upper bound', params: { n: 'lots' }, extra: { max: 5 }, refused: true },
	{ name: 'a list of numbers cannot slip past an upper bound', params: { n: [ 1, 100 ] }, extra: { max: 5 }, refused: true },
	{ name: 'a value that is no number cannot stay within a lower bound', params: { n: {} }, extra: { min: 3 }, refused: true },
], ( { params, extra, refused } ) => {
	const _problems = StrategyGates.plan( plan( { move: 'm', params } ), [ gate( extra ) ] );
	assert.equal( _problems.length > 0, refused, _problems.join( '; ' ) );
	if ( refused ) { assert.deepEqual( _problems, [ 'm: n is outside what the strategy gate allows (gate sg-1)' ] ); }
} );

attack( SUBJECT, 'a restrict instance for another move or parameter does not touch the plan', () => {
	assert.deepEqual( StrategyGates.plan( plan( { move: 'm', params: { n: 'x', other: 'y' } } ), [ gate( { move: 'other', allowed: [] } ), gate( { param: 'other', allowed: [ 'y' ] } ) ] ), [] );
} );

attacks( SUBJECT, [
	{ name: 'a step that leaves out a parameter with allowed values is outside the gate', extra: { allowed: [ 'design' ] }, step: { move: 'm', params: { other: 'y' } } },
	{ name: 'a step without any parameters is outside a bound', extra: { max: 5 }, step: { move: 'm' } },
	{ name: 'a parameter left undefined is outside a lower bound', extra: { min: 1 }, step: { move: 'm', params: { n: undefined } } },
	{ name: 'a parameter named like an Object.prototype member is never read from the prototype', extra: { param: 'constructor', allowed: [ 'x' ] }, step: { move: 'm', params: {} } },
], ( { extra, step } ) => {
	const _gate = gate( extra );
	assert.deepEqual( StrategyGates.plan( plan( step ), [ _gate ] ), [ `m: ${_gate.param} is outside what the strategy gate allows (gate sg-1)` ] );
} );

attack( SUBJECT, 'neither "Agent" nor any name that starts with agent lifts an instance; a person does', () => {
	const _store = store();
	const { id } = _store.propose( RESTRICT, scope );
	for ( const by of [ 'Agent', 'AGENT', ' agent ', 'agent-2', 'agent: on behalf of hr-lead', '   ', 7, {}, [ 'hr-lead' ] ] ) {
		assert.equal( _store.lift( id, { by } ), false, JSON.stringify( by ) );
	}
	assert.equal( _store.lift( id, { by: 'hr-lead' } ), true );
} );

attack( SUBJECT, 'a later move without the move that must come first is refused', () => {
	const _order = { id: 'sg-2', rule: 'order', before: 'survey.coverage', after: 'report.send' };
	assert.deepEqual( StrategyGates.plan( plan( { move: 'report.draft' }, { move: 'report.send' } ), [ _order ] ),
		[ 'report.send may only run after survey.coverage (gate sg-2)' ] );
} );

attack( SUBJECT, 'the move that must come first, placed after the later one, does not count', () => {
	const _order = { id: 'sg-2', rule: 'order', before: 'survey.coverage', after: 'report.send' };
	assert.equal( StrategyGates.plan( plan( { move: 'report.send' }, { move: 'survey.coverage' } ), [ _order ] ).length, 1 );
	assert.deepEqual( StrategyGates.plan( plan( { move: 'survey.coverage' }, { move: 'report.send' } ), [ _order ] ), [] );
} );

attack( SUBJECT, 'every occurrence of the later move is checked', () => {
	const _order = { id: 'sg-2', rule: 'order', before: 'b', after: 'a' };
	assert.equal( StrategyGates.plan( plan( { move: 'a' }, { move: 'b' }, { move: 'a' } ), [ _order ] ).length, 1 );
	assert.equal( StrategyGates.plan( plan( { move: 'a' }, { move: 'a' } ), [ _order ] ).length, 2 );
} );

attack( SUBJECT, 'all problems of a plan are reported, each naming its instance', () => {
	const _gates = [ gate( { id: 'sg-a', allowed: [ 'x' ] } ), gate( { id: 'sg-b', max: 1 } ), { id: 'sg-c', rule: 'order', before: 'z', after: 'm' } ];
	const _problems = StrategyGates.plan( plan( { move: 'm', params: { n: 5 } } ), _gates );
	assert.deepEqual( _problems.map( text => text.match( /gate (sg-\w)/ )[ 1 ] ), [ 'sg-a', 'sg-b', 'sg-c' ] );
} );

attack( SUBJECT, 'an empty plan and a plan without instances have no problems', () => {
	assert.deepEqual( StrategyGates.plan( plan(), [ gate( { allowed: [] } ) ] ), [] );
	assert.deepEqual( StrategyGates.plan( plan( { move: 'm', params: { n: 1 } } ), [] ), [] );
} );

// Preconditions before a move runs (16.4, R7).

attack( SUBJECT, 'a precondition the facts do not meet blocks the move and names itself', () => {
	const _store = store();
	const { id } = _store.propose( PRECONDITION, scope );
	const _block = _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, nodeOf(), 'hr-survey', registry );
	assert.deepEqual( [ _block.gate.id, _block.precondition ], [ id, { id: `gate-${id}`, type: 'number_in_range', values: { quantity: 'answers:hr', min: 5 } } ] );
} );

attack( SUBJECT, 'a precondition the facts meet lets the move run', () => {
	const _store = store();
	_store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	_node.addFact( measured( 6 ) );
	assert.equal( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ), null );
} );

attack( SUBJECT, 'too few answers still block', () => {
	const _store = store();
	_store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	_node.addFact( measured( 4 ) );
	assert.ok( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ) );
} );

attack( SUBJECT, 'a precondition a child has met lets the move run', () => {
	const _store = store();
	const { id } = _store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child', data: { id: `gate-${id}` } } );
	assert.equal( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ), null );
} );

attack( SUBJECT, 'what a child that met its goal measured counts for the parent\'s precondition', () => {
	const _store = store();
	_store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	const _child = nodeOf();
	_child.addFact( measured( 5 ) );
	_child.result = { status: 'fulfilled' };
	_node.children.push( _child );
	assert.equal( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ), null );
} );

attack( SUBJECT, 'a child that did not meet its goal, or measured too little, does not open the gate', () => {
	for ( const [ status, value ] of [ [ 'failed', 9 ], [ 'refused', 9 ], [ undefined, 9 ], [ 'fulfilled', 4 ] ] ) {
		const _store = store();
		_store.propose( PRECONDITION, scope );
		const _node = nodeOf();
		const _child = nodeOf();
		_child.addFact( measured( value ) );
		if ( status ) { _child.result = { status }; }
		_node.children.push( _child );
		assert.ok( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ), `${status} ${value}` );
	}
} );

attack( SUBJECT, 'a child\'s fact for another precondition does not count', () => {
	const _store = store();
	_store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child', data: { id: 'gate-sg-other' } } );
	assert.ok( _store.blocking( { move: 'report.send', params: {}, target: 'hr' }, _node, 'hr-survey', registry ) );
} );

attack( SUBJECT, 'the placeholders of a precondition are filled from the step, so another target needs its own answers', () => {
	const _store = store();
	_store.propose( PRECONDITION, scope );
	const _node = nodeOf();
	_node.addFact( measured( 9 ) );
	assert.equal( _store.blocking( { move: 'report.send', params: {}, target: 'ceo' }, _node, 'hr-survey', registry ).precondition.values.quantity, 'answers:ceo' );
} );

attack( SUBJECT, 'a precondition blocks only its own move, its own kind, and only while in force', () => {
	const _store = store();
	const { id } = _store.propose( PRECONDITION, scope );
	const _step = { move: 'report.send', params: {}, target: 'hr' };
	assert.equal( _store.blocking( { ..._step, move: 'report.draft' }, nodeOf(), 'hr-survey', registry ), null );
	assert.equal( _store.blocking( _step, nodeOf(), 'supplier-payments', registry ), null );
	_store.lift( id, { by: 'hr-lead' } );
	assert.equal( _store.blocking( _step, nodeOf(), 'hr-survey', registry ), null );
} );

attack( SUBJECT, 'a restriction of the recipient ("to") means the target of the action; a plan to hr passes, one to anyone else is refused', () => {
	const _store = new StrategyGates( memoryDb(), { now: () => Date.parse( '2026-11-04T08:00:00Z' ) } );
	const _known = { scope: 'hr-survey', registry, catalog: catalogOf( survey ), strategies: null };
	const _added = _store.propose( { rule: 'restrict', move: 'report.send', param: 'to', allowed: [ 'hr' ], expires: '2026-11-20T00:00:00Z' }, _known );
	assert.equal( _added.ok, true, _added.problems?.join() );
	const [ _gate ] = _store.active( 'hr-survey' );
	assert.equal( _gate.param, 'target' );
	const _plan = target => ( { steps: [ { move: 'report.send', target, params: {} } ] } );
	assert.deepEqual( StrategyGates.plan( _plan( 'hr' ), [ _gate ] ), [] );
	assert.match( StrategyGates.plan( _plan( 'ceo' ), [ _gate ] ).join(), /target is outside what the strategy gate allows/ );
	assert.match( StrategyGates.plan( _plan( undefined ), [ _gate ] ).join(), /outside/, 'no recipient is outside as well (fail closed)' );
} );
