// core/node/machine.js: the states and the only allowed transitions of table 16.1 (Z3), checked through the table and
// through a real node with an event log (Z4): every disallowed pair is refused and leaves no trace, every allowed one is
// one event with from, to and the version after it, every state is reachable, closed is final (Z5), and a node rebuilt
// from its log has the state and version it had (18).
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { app, Machine, Node, Contract, Restore, registry, QUANTITY } from './rig.mjs';

const S = 'core/node/machine.js';
const STATES = [ 'draft', 'confirmed', 'planning', 'executing', 'waiting', 'judging', 'closing', 'closed' ];
const ALLOWED = Object.entries( Machine.TRANSITIONS ).flatMap( ( [ from, list ] ) => list.map( to => [ from, to ] ) );
const [ Db, EventLog, Journal ] = await app.use( [ 'Lib.Db', 'Lib.EventLog', 'Core.Learn.Journal' ] );
const SPEC = { id: 'm1', goal: 'g', kind: 'hr-survey', deadline: new Date( Date.now() + 3600000 ).toISOString(), budget: 9,
	criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: QUANTITY, min: 1 } } ] };

// A node with its own log, as the runner creates it.
function fresh() {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'core' );
	const _contract = new Contract( SPEC, registry );
	const _node = new Node( { contract: _contract, log: _log } );
	_node.emit( 'node_created', { contract: _contract.describe(), spec: _contract.canonical(), parent: null, depth: 0, run: 'run-1', mission: 'm', owner: null } );
	return { node: _node, log: _log, db: _db };
}
// The shortest way through the table from draft to a state.
function way( to ) {
	const _seen = new Map( [ [ 'draft', [] ] ] );
	const _queue = [ 'draft' ];
	while ( _queue.length ) {
		const _at = _queue.shift();
		for ( const next of Machine.TRANSITIONS[ _at ] ) {
			if ( !_seen.has( next ) ) {
				_seen.set( next, [ ..._seen.get( _at ), next ] );
				_queue.push( next );
			}
		}
	}
	return _seen.get( to ) || null;
}
function at( state ) {
	const _made = fresh();
	way( state ).forEach( step => _made.node.move( step ) );
	return _made;
}
const changes = log => log.since( 0, 1e6 ).filter( event => event.kind === 'state_changed' );

// Z3: every pair outside the table is refused; the node keeps its state and version and nothing is logged.
const _illegal = STATES.flatMap( from => STATES.filter( to => !Machine.allowed( from, to ) ).map( to => ( {
	name: `${from} → ${to} is refused and leaves no trace (Z3)`, from, to,
} ) ) );
attacks( S, _illegal, ( { from, to } ) => {
	const { node, log } = at( from );
	const _before = { state: node.state, version: node.version, events: log.since( 0, 1e6 ).length };
	assert.throws( () => node.move( to, { reason: 'test' } ), /is not allowed/ );
	assert.deepEqual( { state: node.state, version: node.version, events: log.since( 0, 1e6 ).length }, _before );
} );

attack( S, 'the states are exactly those of table 16.1, in their order', () => {
	assert.deepEqual( Object.keys( Machine.TRANSITIONS ), STATES );
} );
attack( S, 'the table has exactly the 17 transitions of 16.1', () => {
	assert.equal( ALLOWED.length, 17 );
	assert.equal( new Set( ALLOWED.map( pair => pair.join( '>' ) ) ).size, 17, 'no transition twice' );
} );
attack( S, 'closed has no way out (Z5)', () => assert.deepEqual( Machine.TRANSITIONS.closed, [] ) );
attack( S, 'every state is reachable from draft', () => STATES.forEach( state => assert.ok( way( state ), state ) ) );
attack( S, 'closed is reachable from every state: no node can be stuck in the table (G-1c)', () => {
	for ( const state of STATES ) {
		const _seen = new Set( [ state ] );
		const _queue = [ state ];
		while ( _queue.length ) {
			const _next = Machine.TRANSITIONS[ _queue.shift() ].filter( next => !_seen.has( next ) );
			_next.forEach( next => _seen.add( next ) && _queue.push( next ) );
		}
		assert.ok( _seen.has( 'closed' ), state );
	}
} );
attack( S, 'every state but closing and closed may go to closing: deadline, budget and abort from anywhere (16.1, 16.5)', () => {
	STATES.filter( state => ![ 'closing', 'closed' ].includes( state ) ).forEach( state => assert.ok( Machine.allowed( state, 'closing' ), state ) );
} );
attack( S, 'only closing reaches closed', () => {
	assert.deepEqual( STATES.filter( state => Machine.allowed( state, 'closed' ) ), [ 'closing' ] );
} );
attack( S, 'after waiting comes the judgment, never executing (16.1)', () => {
	assert.deepEqual( Machine.TRANSITIONS.waiting, [ 'judging', 'closing' ] );
} );
attack( S, 'no state goes to itself', () => STATES.forEach( state => assert.equal( Machine.allowed( state, state ), false, state ) ) );
attack( S, 'closing goes back only to judging (G6 after "done")', () => assert.deepEqual( Machine.TRANSITIONS.closing, [ 'closed', 'judging' ] ) );
attack( S, 'nothing goes back to draft or confirmed', () => {
	assert.deepEqual( ALLOWED.filter( ( [ , to ] ) => [ 'draft', 'confirmed' ].includes( to ) ).map( pair => pair.join( '>' ) ), [ 'draft>confirmed' ] );
} );

// States that do not exist are never allowed, from either side.
attacks( S, [ 'proposed', 'CLOSED', ' draft', 'draft ', 'done', '' ].map( value => ( { name: `the unknown state ${JSON.stringify( value )} is no transition`, value } ) ),
	( { value } ) => {
		assert.equal( Machine.allowed( value, 'closing' ), false );
		assert.equal( Machine.allowed( 'draft', value ), false );
	} );
attacks( S, hostile( 'types' ).map( item => ( { name: `a hostile target state: ${item.label}`, value: item.value } ) ), ( { value } ) => {
	const { node, log } = at( 'planning' );
	assert.throws( () => node.move( value ) );
	assert.equal( node.state, 'planning' );
	assert.equal( changes( log ).length, 2 );
} );
// A state named like a property of every object is no state either; the table must answer "no", not throw.
attacks( S, [ '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf' ].map( value => ( {
	name: `a source state named like an object property (${value}) is no transition`, value,
} ) ), ( { value } ) => {
	assert.equal( Machine.allowed( value, 'closing' ), false );
} );

// The node: E1, the log of each move, and what it does outside executing.
attack( S, 'E1: a transition with the current version goes through', () => {
	const { node } = at( 'planning' );
	node.move( 'executing', {}, { expect: node.version } );
	assert.equal( node.state, 'executing' );
} );
attack( S, 'E1: a transition with a stale version is refused and leaves no trace', () => {
	const { node, log } = at( 'planning' );
	const _stale = node.version - 1;
	assert.throws( () => node.move( 'executing', {}, { expect: _stale } ), /E1/ );
	assert.equal( node.state, 'planning' );
	assert.equal( changes( log ).length, 2 );
} );
attack( S, 'the version counts the transitions; each event carries the version after it (Z4, 18.1)', () => {
	const { node, log } = at( 'closed' );
	assert.equal( node.version, changes( log ).length );
	assert.deepEqual( changes( log ).map( event => event.nodeVersion ), changes( log ).map( ( _e, i ) => i + 1 ) );
} );
attack( S, 'the data of a transition cannot rewrite its from and to in the log (Z4)', () => {
	const { node, log } = at( 'planning' );
	node.move( 'executing', { from: 'closed', to: 'draft', strategy: 'alpha' } );
	const _last = changes( log ).at( -1 ).data;
	assert.deepEqual( [ _last.from, _last.to ], [ 'planning', 'executing' ] );
} );
attack( S, 'a node without a log moves along the table without failing', () => {
	const _node = new Node( { contract: new Contract( SPEC, registry ) } );
	way( 'closed' ).forEach( step => _node.move( step ) );
	assert.equal( _node.state, 'closed' );
} );
attacks( S, STATES.filter( state => state !== 'executing' ).map( state => ( { name: `toWaiting from ${state} does nothing (only executing waits)`, state } ) ),
	( { state } ) => {
		const { node, log } = at( state );
		const _count = changes( log ).length;
		assert.equal( node.toWaiting( { for: 'a test' } ), false );
		assert.equal( node.state, state );
		assert.equal( changes( log ).length, _count );
	} );
attack( S, 'a wake for a node that waits for nothing changes nothing', () => {
	const { node } = at( 'judging' );
	node.wake( { kind: 'late' } );
	assert.equal( node.state, 'judging' );
} );
attack( S, 'a node rebuilt from its log has the state and the version it had (18, Z4, E1)', () => {
	const { node, log, db } = at( 'closed' );
	const _copy = { id: 'run-1', registry, log, nodes: new Map(), journal: new Journal( db ) };
	new Restore( _copy ).rebuild();
	const _again = _copy.nodes.get( node.id );
	assert.deepEqual( [ _again.state, _again.version ], [ node.state, node.version ] );
} );

// Each allowed transition on a real node: one event with from, to, its data and the version after it.
for ( const [ from, to ] of ALLOWED ) {
	attack( `transition ${from}→${to}`, 'on a node: one event with from, to, the data and the version after it (Z4, E1)', () => {
		const { node, log } = at( from );
		const _version = node.version;
		node.move( to, { reason: 'unit' }, { expect: _version } );
		const _event = changes( log ).at( -1 );
		assert.deepEqual( _event.data, { from, to, reason: 'unit' } );
		assert.equal( _event.nodeVersion, _version + 1 );
		assert.equal( node.state, to );
		assert.equal( node.version, _version + 1 );
	} );
}
