// core/node/node.js under attack, part 2: validity (B2), preconditions (R7, R8), credit (L4), transitions (E1, Z3,
// Z4), walls, waking and what a node shows of itself.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { node, measured, about, recorder, bring, Machine, STATES, HOUR } from './kit.mjs';

const S = 'core/node/node.js';
const k1 = ( extra = {} ) => ( { id: 'k1', type: 'number_in_range', values: { quantity: 'answers', min: 2 }, ...extra } );

attack( S, 'B2: a fact counts up to the instant of its validity and not one millisecond after', () => {
	const _node = node();
	const _until = Date.parse( '2026-11-04T12:00:00Z' );
	_node.addFact( { kind: 'note', origin: 'a', validUntil: new Date( _until ).toISOString() } );
	assert.equal( _node.valid( _until ).length, 1 );
	assert.equal( _node.valid( _until + 1 ).length, 0 );
	assert.equal( _node.valid( _until - 1 ).length, 1 );
} );

attack( S, 'B2: an empty validity is no validity; the fact counts without end', () => {
	const _node = node();
	_node.addFact( { kind: 'note', origin: 'a', validUntil: '' } );
	_node.addFact( { kind: 'note', origin: 'a', validUntil: null } );
	assert.equal( _node.valid( Date.now() + 1000 * 365 * 24 * HOUR ).length, 2 );
} );

attacks( S, [
	{ name: 'B2: a fact valid until "tomorrow" does not count forever', value: 'tomorrow' },
	{ name: 'B2: a fact valid until hour 25 of a day does not count forever', value: '2026-11-04T25:00:00Z' },
	{ name: 'B2: a fact whose validity is a bare number does not count forever', value: Date.parse( '2026-11-04T00:00:00Z' ) },
], ( { value } ) => {
	const _node = node();
	_node.addFact( { kind: 'note', origin: 'a', validUntil: value } );
	assert.equal( _node.valid( Date.parse( '2100-01-01T00:00:00Z' ) ).length, 0, 'evidence whose expiry cannot be read must not count as eternal' );
} );

attack( S, 'B2: validities at the edges of time: year 0 has passed, year 9999 has not', () => {
	const _node = node();
	_node.addFact( { kind: 'note', origin: 'a', validUntil: '0000-01-01T00:00:00Z' } );
	_node.addFact( { kind: 'note', origin: 'b', validUntil: '9999-12-31T23:59:59Z' } );
	assert.deepEqual( _node.valid().map( fact => fact.origin ), [ 'b' ] );
} );

attack( S, 'B2: a criterion met by a fact is open again once that fact expires', () => {
	const _node = node();
	const _fact = _node.addFact( measured( 3, { validUntil: new Date( Date.now() + HOUR ).toISOString() } ) );
	assert.deepEqual( _node.openOutcomes(), [] );
	_fact.validUntil = new Date( Date.now() - 1 ).toISOString();
	assert.deepEqual( _node.openOutcomes().map( item => item.id ), [ 'k1' ] );
} );

attack( S, 'R7: a met precondition stays met while its evidence is valid and is open again when it expires', () => {
	const _node = node();
	const _fact = _node.addFact( { kind: 'precondition_met', origin: 'child', data: { id: 'phone' }, validUntil: new Date( Date.now() + HOUR ).toISOString() } );
	assert.equal( _node.preconditionMet( 'phone' ), true );
	_fact.validUntil = new Date( Date.now() - 1 ).toISOString();
	assert.equal( _node.preconditionMet( 'phone' ), false );
} );

attack( S, 'R7: a precondition met with evidence that has already expired is not met', () => {
	const _node = node();
	_node.addFact( { kind: 'precondition_met', origin: 'child', data: { id: 'phone' }, validUntil: new Date( Date.now() - 1 ).toISOString() } );
	assert.equal( _node.preconditionMet( 'phone' ), false );
} );

attack( S, 'R7: a superseded precondition_met no longer counts', () => {
	const _node = node();
	const _fact = _node.addFact( { kind: 'precondition_met', origin: 'child', data: { id: 'phone' } } );
	_fact.superseded = true;
	assert.equal( _node.preconditionMet( 'phone' ), false );
} );

attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `R8: a precondition with the hostile id ${item.label} is met only by exactly that id` } ) ), ( { value } ) => {
	const _node = node();
	_node.addFact( { kind: 'precondition_met', origin: 'child', data: { id: value } } );
	assert.equal( _node.preconditionMet( value ), true );
	assert.equal( _node.preconditionMet( `${value}x` ), false );
	assert.equal( _node.preconditionMet( undefined ), false );
} );

attack( S, 'R8: no precondition without an id is ever met, even next to a malformed precondition_met fact', () => {
	const _node = node();
	_node.addFact( { kind: 'precondition_met', origin: 'child' } );
	assert.equal( _node.preconditionMet( undefined ), false, 'the chooser asks with wall.precondition?.id, which is undefined for most walls' );
} );

attack( S, 'L4: the attempt whose fact first meets a criterion gets the credit; a later fact does not move it', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 1 };
	_node.addFact( measured( 1 ) );
	_node.plan = { open: true, attempt: 2 };
	_node.addFact( measured( 2 ) );
	_node.plan = { open: true, attempt: 3 };
	_node.addFact( measured( 5 ) );
	assert.equal( _node.credited.k1.attempt, 2 );
	assert.equal( _node.log.of( 'credited' ).length, 1 );
} );

attack( S, 'L4: credit after the contract deadline is recorded as not in time', () => {
	const _node = node( { deadline: new Date( Date.now() - 1000 ).toISOString() } );
	_node.plan = { open: true, attempt: 4 };
	_node.addFact( measured( 3 ) );
	assert.deepEqual( [ _node.credited.k1.attempt, _node.credited.k1.inTime ], [ 4, false ] );
} );

attack( S, 'L4: credit before a criterion deadline is in time, credit after it is none', () => {
	const _early = node( { criteria: [ k1( { deadline: new Date( Date.now() + HOUR ).toISOString() } ) ] } );
	const _late = node( { criteria: [ k1( { deadline: new Date( Date.now() - 1 ).toISOString() } ) ] } );
	_early.addFact( measured( 3, { attempt: 1 } ) );
	_late.addFact( measured( 3, { attempt: 2 } ) );
	assert.equal( _early.credited.k1.inTime, true );
	assert.equal( _late.credited.k1, undefined, 'a fact after the criterion deadline does not meet it' );
} );

attacks( S, [ 'constructor', 'toString', '__proto__', 'hasOwnProperty' ].map( id => ( {
	name: `L4: a criterion with the id ${id} is credited like any other`, id,
} ) ), ( { id } ) => {
	const _node = node( { criteria: [ k1( { id } ) ] } );
	_node.plan = { open: true, attempt: 5 };
	_node.addFact( measured( 3 ) );
	assert.deepEqual( _node.openOutcomes(), [], 'the criterion is met' );
	assert.equal( Object.hasOwn( _node.credited, id ) && _node.credited[ id ].attempt, 5, 'and its attempt is credited (L4)' );
} );

attack( S, 'L4: a fact that brings its own attempt is credited to that attempt, not to the open one', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 9 };
	_node.addFact( measured( 3, { attempt: 4 } ) );
	assert.equal( _node.credited.k1.attempt, 4 );
} );

attack( S, 'L4: a criterion met by an earlier fact is credited to the attempt of its evidence at the next fact', () => {
	const _node = node();
	_node.facts.push( { ...measured( 3 ), id: 'restored', attempt: 6, time: new Date().toISOString(), labels: [] } );
	_node.plan = { open: true, attempt: 8 };
	_node.addFact( { kind: 'note', origin: 'system' } );
	assert.deepEqual( [ _node.credited.k1.attempt, _node.credited.k1.fact ], [ 6, 'restored' ] );
} );

attack( S, 'L4: credit given once stays when its evidence is superseded later (the first fact counts)', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 1 };
	_node.addFact( measured( 3 ) );
	_node.plan = { open: true, attempt: 2 };
	_node.addFact( measured( 0 ) );
	assert.equal( _node.credited.k1.attempt, 1 );
	assert.equal( _node.openOutcomes().length, 1, 'the latest measurement counts for the verdict' );
} );

attack( S, 'E1: a move with a stale version is refused and changes nothing, not even the log', () => {
	const _node = bring( node(), 'planning' );
	const _before = [ _node.state, _node.version, _node.log.events.length ];
	assert.throws( () => _node.move( 'executing', {}, { expect: _node.version - 1 } ), /E1/ );
	assert.throws( () => _node.move( 'executing', {}, { expect: String( _node.version ) } ), /E1/ );
	assert.deepEqual( [ _node.state, _node.version, _node.log.events.length ], _before );
	_node.move( 'executing', {}, { expect: _node.version } );
	assert.equal( _node.state, 'executing' );
} );

attack( S, 'Z3: every transition outside table 16.1 is refused from every state, and nothing is written', () => {
	for ( const from of STATES ) {
		for ( const to of [ ...STATES, 'proposed', 'done' ].filter( state => !Machine.allowed( from, state ) ) ) {
			const _node = bring( node(), from );
			const _events = _node.log.events.length;
			assert.throws( () => _node.move( to ), /not allowed/, `${from} → ${to}` );
			assert.deepEqual( [ _node.state, _node.log.events.length ], [ from, _events ], `${from} → ${to}` );
		}
	}
} );

attack( S, 'Z3: hostile state names are no states', () => {
	for ( const to of [ ...hostile( 'keys' ).map( item => item.value ), 'constructor', 'toString', 'valueOf', null, undefined, 3 ] ) {
		const _node = bring( node(), 'planning' );
		assert.throws( () => _node.move( to ), /not allowed/ );
		assert.equal( _node.state, 'planning' );
	}
} );

attack( S, 'Z4: every move raises the version by one and its event carries the new version and both states', () => {
	const _node = node();
	[ 'confirmed', 'planning', 'executing', 'waiting', 'judging', 'closing', 'closed' ].forEach( ( to, i ) => {
		const _from = _node.state;
		_node.move( to, { step: i } );
		const _event = _node.log.events.at( -1 );
		assert.deepEqual( [ _event.kind, _event.nodeVersion, _event.data.from, _event.data.to, _event.data.step ], [ 'state_changed', i + 1, _from, to, i ] );
	} );
	assert.equal( _node.version, 7 );
} );

attack( S, 'Z5: a closed node takes no transition at all', () => {
	const _node = bring( node(), 'closed' );
	for ( const to of STATES ) {
		assert.throws( () => _node.move( to ) );
	}
	assert.equal( _node.state, 'closed' );
} );

attack( S, 'Z4: a transition whose event cannot be written does not happen', () => {
	const _log = recorder();
	const _node = bring( node( { log: _log } ), 'planning' );
	_log.broken = true;
	assert.throws( () => _node.move( 'executing' ) );
	assert.deepEqual( [ _node.state, _node.version ], [ 'planning', 2 ], 'the state follows from the log (Z4)' );
} );

attack( S, '16.4: a wall names the first open criterion and keeps cause, precondition, reason and suggestion as given', () => {
	const _node = node( { criteria: [ k1(), k1( { id: 'k2' } ) ] } );
	const _pre = { id: 'phone', type: 'state_is' };
	const _wall = _node.hitWall( 'precondition_missing', [ { reason: 'no number' } ], { precondition: _pre, suggestion: 'look it up' } );
	assert.deepEqual( [ _wall.criterion, _wall.cause, _wall.precondition, _wall.reason, _wall.suggestion ], [ 'k1', 'precondition_missing', _pre, 'no number', 'look it up' ] );
	_node.addFact( measured( 3 ) );
	assert.equal( _node.hitWall( 'x' ).criterion, null, 'nothing open: no criterion' );
	assert.equal( _node.log.of( 'wall' ).length, 2 );
} );

attacks( S, hostile( 'strings' ).slice( 0, 16 ).map( item => ( { ...item, name: `16.4: a wall with the cause ${item.label} is kept verbatim, compared by code only` } ) ), ( { value } ) => {
	const _node = node();
	const _wall = _node.hitWall( value, [ value ] );
	assert.equal( _wall.cause, value );
	assert.equal( _node.walls.at( -1 ).cause, value );
	assert.equal( typeof _wall.reason, 'string' );
} );

attack( S, 'E4: the next event goes to whoever waits for it; a wake without a waiter is lost quietly', async () => {
	const _node = node();
	assert.doesNotThrow( () => _node.wake( { kind: 'nobody waits' } ) );
	const _next = _node.nextEvent();
	_node.wake( { kind: 'abort_received', priority: true } );
	assert.deepEqual( await _next, { kind: 'abort_received', priority: true } );
	assert.doesNotThrow( () => _node.wake( { kind: 'again' } ) );
} );

attack( S, '16.1: only an executing node goes to waiting, and it records what it waits for', () => {
	for ( const state of STATES ) {
		const _node = bring( node(), state );
		const _moved = _node.toWaiting( { for: 'x' }, { move: 'followup.wait' } );
		assert.equal( _moved, state === 'executing', state );
		assert.equal( _node.state, state === 'executing' ? 'waiting' : state );
	}
} );

attack( S, '4.4: what holds a node back: open children only, and what it waits for', () => {
	const _parent = bring( node(), 'executing' );
	const _open = node( { parent: _parent } );
	bring( node( { parent: _parent } ), 'closed' );
	_parent.toWaiting( { for: 'a child' }, { why: 'a child' } );
	assert.deepEqual( _parent.blockedBy(), { children: [ _open.id ], waitingOn: 'a child' } );
	_parent.waitingOn = null;
	assert.equal( _parent.blockedBy().waitingOn, 'an event' );
	assert.equal( bring( node(), 'planning' ).blockedBy().waitingOn, null );
} );

attack( S, '17: a chain of five generations knows its depth and its ancestors from the root down', () => {
	let _node = node();
	const _contracts = [ _node.contract ];
	for ( let i = 1; i <= 5; i++ ) {
		_node = node( { parent: _node, id: `level-${i}` } );
		_contracts.push( _node.contract );
	}
	assert.equal( _node.depth, 5 );
	assert.deepEqual( _node.ancestors(), _contracts.slice( 0, 5 ) );
	assert.equal( _node.parent.children[ 0 ], _node );
} );

attack( S, 'describe() is plain JSON with the documented fields, also with hostile facts inside', () => {
	const _node = node( { id: 'n-1' } );
	_node.addFact( { kind: 'x', origin: 'a', data: { about: '__proto__', value: '<script>' } } );
	_node.hitWall( 'no_reaction', [] );
	const _shown = JSON.parse( JSON.stringify( _node.describe() ) );
	assert.deepEqual( Object.keys( _shown ).sort(), [ 'blockedBy', 'children', 'contract', 'depth', 'facts', 'id', 'parent', 'result', 'state', 'tried', 'version', 'walls' ] );
	assert.deepEqual( [ _shown.id, _shown.facts, _shown.contract.hash ], [ 'n-1', 1, _node.contract.hash ] );
} );

attack( S, 'a node keeps a given id and makes one up for an empty one', () => {
	assert.equal( node( { id: 'given' } ).id, 'given' );
	assert.match( node( { id: '' } ).id, /^node-/ );
	assert.notEqual( node().id, node().id );
} );

attack( S, 'a conflict ends by itself once the latest facts of every origin agree again (E5)', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 'open', 'erp' ) );
	_node.addFact( about( 'R-1', 'paid', 'bank' ) );
	assert.equal( _node.conflicts().length, 1 );
	_node.addFact( about( 'R-1', 'paid', 'erp' ) );
	assert.equal( _node.conflicts().length, 0, 'the side that changed its mind agrees now' );
	assert.equal( _node.facts.filter( fact => fact.kind === 'conflict_resolved' ).length, 1, 'the end of the conflict is a fact of its own' );
	assert.deepEqual( _node.valid().filter( fact => fact.kind === 'item_state' ).map( fact => fact.data.value ), [ 'paid', 'paid' ] );
	_node.addFact( about( 'R-1', 'open', 'erp' ) );
	assert.equal( _node.conflicts().length, 1, 'a new disagreement is a new conflict' );
} );

attack( S, 'a person decides a conflict: facts with another value count for nothing, credit follows (E5, U4)', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 3 };
	_node.addFact( measured( 3, { origin: 'bank', data: { quantity: 'answers', value: 3, about: 'answers' } } ) );
	_node.addFact( measured( 1, { origin: 'erp', data: { quantity: 'answers', value: 1, about: 'answers' } } ) );
	assert.equal( _node.credited.k1?.attempt, 3, 'credited before the conflict' );
	const _fresh = node();
	_fresh.addFact( measured( 1, { origin: 'erp', data: { quantity: 'answers', value: 1, about: 'answers' } } ) );
	_fresh.plan = { open: true, attempt: 4 };
	_fresh.addFact( measured( 3, { origin: 'bank', data: { quantity: 'answers', value: 3, about: 'answers' } } ) );
	assert.equal( _fresh.conflicts().length, 1 );
	assert.equal( _fresh.credited.k1, undefined, 'no credit while a conflict is about its evidence' );
	assert.equal( _fresh.resolveConflict( 'nothing', 1, 'hr' ), null, 'nothing open about it' );
	const _decision = _fresh.resolveConflict( 'answers', 3, 'hr' );
	assert.deepEqual( [ _decision.kind, _decision.data.by, _fresh.conflicts().length ], [ 'conflict_resolved', 'hr', 0 ] );
	assert.deepEqual( _fresh.valid().filter( fact => fact.kind === 'measured' ).map( fact => fact.data.value ), [ 3 ] );
	assert.equal( _fresh.credited.k1.attempt, 4 );
} );
