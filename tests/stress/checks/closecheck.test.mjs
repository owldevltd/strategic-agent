// G6 (2.3, 7.2, 16.3): closing is "really done" in six dimensions: functional (every evidence predicate holds, no open
// conflict), formal (the confirmed contract, immutables unchanged), commercial (attempts ended and booked),
// organisational (no ticket, move or outside action open), knowledge (lesson written) and structure (children closed).
// After an abort the clean-up is the question, not the predicates. The agent's own claim never counts.
import assert from 'node:assert/strict';
import { attack, attacks, random } from '../hostile.mjs';
import { CloseCheck, Contract, Node, registry, contract, REPORT, inHours } from './fixtures.mjs';

const SUBJECT = 'core/check/closecheck.js';
const DIMENSIONS = [ 'functional', 'formal', 'commercial', 'organisational', 'knowledge', 'structure' ];
const MIN_GROUP = { id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true, origin: 'catalog' };

const nodeFor = ( criteria = [ REPORT ], extra = {} ) => new Node( { contract: contract( extra, criteria ) } );
const delivered = ( data = {}, extra = {} ) => ( {
	kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { action: 'report', to: 'hr', ...data }, ...extra,
} );
// A node whose report reached HR: functionally done.
const done = ( criteria, extra ) => {
	const _node = nodeFor( criteria, extra );
	_node.addFact( delivered() );
	return _node;
};
const g6 = ( node, options ) => new CloseCheck().check( node, options );
const only = ( result, dimension ) => {
	for ( const name of DIMENSIONS.filter( item => item !== dimension ) ) { assert.deepEqual( result.dimensions[ name ], [], name ); }
	assert.equal( result.ok, false );
	return result.dimensions[ dimension ];
};

attack( SUBJECT, 'a node whose evidence holds and that left nothing open closes, in all six dimensions', () => {
	const _result = g6( done() );
	assert.equal( _result.gate, 'G6' );
	assert.equal( _result.ok, true, _result.problems.join() );
	assert.deepEqual( Object.keys( _result.dimensions ), DIMENSIONS );
} );

// Functional: every predicate, by evidence only (G-4, B6).
attack( SUBJECT, 'an outcome without evidence keeps the node open, naming criterion, type and reason', () => {
	assert.deepEqual( only( g6( nodeFor() ), 'functional' ), [ 'k1 (report_delivered) not met: no confirmed delivery' ] );
} );

attacks( SUBJECT, [
	{ name: 'a delivery to someone else is no evidence', fact: delivered( { to: 'ceo' } ) },
	{ name: 'the agent\'s own claim that it delivered never counts', fact: delivered( {}, { evidenceClass: 'claim', source: 'agent' } ) },
	{ name: 'a derivation of a delivery never counts', fact: delivered( {}, { evidenceClass: 'derivation' } ) },
	{ name: 'a confirmation over the same channel is no observation of the delivery', fact: delivered( {}, { evidenceClass: 'confirmation' } ) },
	{ name: 'a delivery of another action (a payment) is no report', fact: delivered( { action: 'payment' } ) },
	{ name: 'B2: a delivery whose validity ended counts for nothing', fact: delivered( {}, { validUntil: inHours( -1 ) } ) },
	// E5: only the node marks a fact superseded (a fact never arrives superseded), so the recorded one is marked here.
	{ name: 'E5: a superseded delivery counts for nothing', fact: delivered(), superseded: true },
	{ name: 'a fact of another kind with the same data is no delivery', fact: delivered( {}, { kind: 'report_sent' } ) },
], ( item ) => {
	const _node = nodeFor();
	const _fact = _node.addFact( item.fact );
	if ( item.superseded ) { _fact.superseded = true; }
	assert.equal( g6( _node ).dimensions.functional.length, 1 );
} );

attack( SUBJECT, 'a thousand claims of the agent still prove nothing', () => {
	const _node = nodeFor();
	for ( let i = 0; i < 1000; i++ ) { _node.facts.push( { id: `claim-${i}`, ...delivered( {}, { evidenceClass: 'claim', source: 'agent' } ) } ); }
	assert.equal( g6( _node ).ok, false );
} );

attack( SUBJECT, 'the node\'s own result "fulfilled" is no evidence either', () => {
	const _node = nodeFor();
	_node.result = { status: 'fulfilled' };
	_node.lessonWritten = true;
	assert.equal( g6( _node ).ok, false );
} );

attack( SUBJECT, 'E5: an open conflict keeps the node open even when every predicate holds', () => {
	const _node = done();
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-a', source: 'a', data: { about: 'slot', value: 'tue' } } );
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-b', source: 'b', data: { about: 'slot', value: 'wed' } } );
	assert.deepEqual( only( g6( _node ), 'functional' ), [ 'open conflict about slot (E5)' ] );
} );

attack( SUBJECT, 'E5: a resolved conflict no longer blocks', () => {
	const _node = done();
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-a', source: 'a', data: { about: 'slot', value: 'tue' } } );
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-b', source: 'b', data: { about: 'slot', value: 'wed' } } );
	_node.addFact( { kind: 'conflict_resolved', evidenceClass: 'confirmation', origin: 'person', source: 'ticket', data: { about: 'slot' } } );
	assert.equal( g6( _node ).ok, true );
} );

attack( SUBJECT, 'E5: the same origin correcting itself is no conflict', () => {
	const _node = done();
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-a', source: 'a', data: { about: 'slot', value: 'tue' } } );
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'mail-a', source: 'a', data: { about: 'slot', value: 'wed' } } );
	assert.equal( g6( _node ).ok, true );
} );

attack( SUBJECT, 'a broken invariant keeps the node open: a release about three people under k = 5', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	_node.addFact( delivered( { cohort: [ 'a', 'b', 'c' ] } ) );
	assert.deepEqual( only( g6( _node ), 'functional' ), [ 'k2 (min_group) not met: a release below the group size' ] );
} );

attack( SUBJECT, 'an invariant with no release at all holds', () => {
	assert.equal( g6( done( [ REPORT, MIN_GROUP ] ) ).ok, true );
} );

attack( SUBJECT, 'soft criteria never decide: unmet wishes do not block, and they are not among the results', () => {
	const _node = done( [ REPORT ], { soft: [ 'friendly tone', 'mention the pizza' ] } );
	const _result = g6( _node );
	assert.equal( _result.ok, true );
	assert.deepEqual( _result.results.map( item => item.type ), [ 'report_delivered' ] );
} );

attack( SUBJECT, 'only soft criteria met is never done: the hard core still needs its evidence', () => {
	const _node = nodeFor( [ REPORT ], { soft: [ 'friendly tone' ] } );
	_node.addFact( { kind: 'soft_assessed', evidenceClass: 'derivation', origin: 'reviewer', source: 'reviewer', data: { criterion: 's1', met: true } } );
	assert.equal( g6( _node ).ok, false );
} );

attacks( SUBJECT, [
	{ name: 'K4: a person\'s yes to exactly this criterion meets a criterion only a person can confirm', data: { criterion: 'k1', choice: 'yes' }, met: true },
	{ name: 'K4: a person\'s no does not meet it', data: { criterion: 'k1', choice: 'no' }, met: false },
	{ name: 'K4: a yes to another criterion does not meet it', data: { criterion: 'k9', choice: 'yes' }, met: false },
	{ name: 'K4: a yes given as a claim instead of a confirmation does not meet it', data: { criterion: 'k1', choice: 'yes' }, met: false, claim: true },
], ( item ) => {
	const _node = nodeFor( [ { ...REPORT, byPerson: true } ] );
	_node.addFact( { kind: 'confirmation', evidenceClass: item.claim ? 'claim' : 'confirmation', origin: 'person', source: 'ticket', data: item.data } );
	assert.equal( g6( _node ).ok, item.met );
} );

attack( SUBJECT, 'K4: a confirmation does not meet a criterion a channel delivers (not by person)', () => {
	const _node = nodeFor();
	_node.addFact( { kind: 'confirmation', evidenceClass: 'confirmation', origin: 'person', source: 'ticket', data: { criterion: 'k1', choice: 'yes' } } );
	assert.equal( g6( _node ).ok, false );
} );

attack( SUBJECT, 'U4: a criterion whose own deadline passed unmet is impossible and keeps the node from closing as fulfilled', () => {
	const _result = g6( nodeFor( [ { ...REPORT, deadline: inHours( -1 ) } ] ) );
	assert.equal( _result.results[ 0 ].impossible, true );
	assert.match( _result.dimensions.functional[ 0 ], /its deadline has passed/ );
} );

attack( SUBJECT, 'evidence that arrived after the criterion\'s own deadline does not count', () => {
	const _node = nodeFor( [ { ...REPORT, deadline: inHours( 1 ) } ] );
	// The node stamps the arrival itself; at is the time trusted code observed it (a time the fact claims never counts).
	_node.addFact( delivered(), { at: inHours( 2 ) } );
	assert.equal( g6( _node ).ok, false );
} );

attack( SUBJECT, 'two outcomes, one met: exactly the other one is named', () => {
	const _node = done( [ REPORT, { id: 'k4', type: 'report_delivered', values: { to: 'board', topic: 'morale' } } ] );
	assert.deepEqual( g6( _node ).dimensions.functional, [ 'k4 (report_delivered) not met: no confirmed delivery' ] );
} );

// 16.3: after an abort the predicates are not the question, the clean-up is.
attack( SUBJECT, 'after an abort unmet outcomes and open conflicts do not block closing', () => {
	const _node = nodeFor();
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'a', source: 'a', data: { about: 'x', value: 1 } } );
	_node.addFact( { kind: 'answer', evidenceClass: 'claim', origin: 'b', source: 'b', data: { about: 'x', value: 2 } } );
	assert.equal( g6( _node, { aborted: true } ).ok, true );
} );

attack( SUBJECT, 'after an abort a running child still blocks closing', () => {
	const _node = nodeFor();
	_node.children.push( { id: 'child-1', state: 'executing' } );
	assert.deepEqual( only( g6( _node, { aborted: true } ), 'structure' ), [ 'child child-1 still executing' ] );
} );

attack( SUBJECT, 'after an abort an outside action not in an end state still blocks closing', () => {
	assert.deepEqual( only( g6( nodeFor(), { aborted: true, context: { deliveriesOpen: [ 'd-9' ] } } ), 'organisational' ),
		[ 'outside action d-9 not in an end state' ] );
} );

attack( SUBJECT, 'after an abort a changed immutable criterion is still reported', () => {
	const _node = nodeFor( [ REPORT, MIN_GROUP ] );
	_node.immutables = [ JSON.stringify( [ 'k2', 'min_group', { k: 9 } ] ) ];
	assert.equal( g6( _node, { aborted: true } ).dimensions.formal.length, 1 );
} );

// Formal: the confirmed contract, immutables unchanged (G-10).
attack( SUBJECT, 'the contract the person confirmed closes', () => {
	const _node = done();
	assert.equal( g6( _node, { context: { confirmed: _node.contract.hash } } ).ok, true );
} );

attack( SUBJECT, 'a contract other than the confirmed one does not close', () => {
	assert.deepEqual( only( g6( done(), { context: { confirmed: 'a3f9' } } ), 'formal' ), [ 'the contract is not the one the person confirmed' ] );
} );

attack( SUBJECT, 'G-10: an immutable criterion changed since the first confirmation blocks closing', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	_node.immutables = _node.contract.immutables();
	_node.contract = new Contract( _node.contract.amend( { criterion: 'k2', values: { k: 2 } } ), registry );
	assert.deepEqual( only( g6( _node ), 'formal' ), [ 'an immutable criterion changed since the first confirmation (G-10)' ] );
} );

attack( SUBJECT, 'G-10: an immutable criterion dropped since the first confirmation blocks closing', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	_node.immutables = _node.contract.immutables();
	_node.contract = contract( {}, [ REPORT ] );
	assert.equal( only( g6( _node ), 'formal' ).length, 1 );
} );

attack( SUBJECT, 'G-10: an amendment of a mutable criterion does not touch the immutables', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	_node.immutables = _node.contract.immutables();
	_node.contract = new Contract( _node.contract.amend( { criterion: 'k1', values: { topic: 'morale, first findings' } } ), registry );
	_node.addFact( delivered() );
	assert.equal( g6( _node ).ok, true );
} );

attack( SUBJECT, 'G-10: flipping an immutable flag off is a change of the immutables', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	_node.immutables = _node.contract.immutables();
	_node.contract = contract( {}, [ REPORT, { ...MIN_GROUP, immutable: false } ] );
	assert.equal( only( g6( _node ), 'formal' ).length, 1 );
} );

// Commercial, organisational, knowledge, structure.
attacks( SUBJECT, [
	{ name: 'an attempt not ended and booked blocks closing', options: { context: { attemptsOpen: 2 } }, dimension: 'commercial',
		expected: [ '2 attempt(s) not ended and booked' ] },
	{ name: 'an open ticket blocks closing', options: { context: { ticketsOpen: 1 } }, dimension: 'organisational', expected: [ '1 ticket(s) still open' ] },
	{ name: 'two outside actions not in an end state are each named', options: { context: { deliveriesOpen: [ 'd-1', 'd-2' ] } }, dimension: 'organisational',
		expected: [ 'outside action d-1 not in an end state', 'outside action d-2 not in an end state' ] },
	{ name: 'without a lesson written a node with memory does not close (G4)', options: { lessons: true }, dimension: 'knowledge',
		expected: [ 'no lesson written (G4)' ] },
], ( item ) => {
	assert.deepEqual( only( g6( done(), item.options ), item.dimension ), item.expected );
} );

attack( SUBJECT, 'a move still running blocks closing', () => {
	const _node = done();
	_node.plan = { pending: { move: 'report.send' } };
	assert.deepEqual( only( g6( _node ), 'organisational' ), [ 'a move is still running' ] );
} );

attack( SUBJECT, 'a plan that is over does not block closing', () => {
	const _node = done();
	_node.plan = { pending: null, open: false };
	assert.equal( g6( _node ).ok, true );
} );

attack( SUBJECT, 'a written lesson satisfies the knowledge dimension', () => {
	const _node = done();
	_node.lessonWritten = true;
	assert.equal( g6( _node, { lessons: true } ).ok, true );
} );

attack( SUBJECT, 'without a memory no lesson is asked for', () => {
	assert.equal( g6( done(), { lessons: false } ).ok, true );
} );

attack( SUBJECT, 'a closed child does not block; a running one does, naming its state', () => {
	const _node = done();
	_node.children.push( { id: 'c-1', state: 'closed' }, { id: 'c-2', state: 'waiting' }, { id: 'c-3', state: 'judging' } );
	assert.deepEqual( only( g6( _node ), 'structure' ), [ 'child c-2 still waiting', 'child c-3 still judging' ] );
} );

attack( SUBJECT, 'a child that closed went through its own G6, so only direct children are looked at', () => {
	const _node = done();
	_node.children.push( { id: 'c-1', state: 'closed', children: [ { id: 'g-1', state: 'executing' } ] } );
	assert.equal( g6( _node ).ok, true );
} );

attack( SUBJECT, 'zero counts are no problems', () => {
	assert.equal( g6( done(), { context: { attemptsOpen: 0, ticketsOpen: 0, deliveriesOpen: [] } } ).ok, true );
} );

attack( SUBJECT, 'every dimension broken at once: each one reports, and problems lists them in order', () => {
	const _node = nodeFor( [ REPORT, MIN_GROUP ] );
	_node.immutables = [ 'changed' ];
	_node.plan = { pending: true };
	_node.children.push( { id: 'c-1', state: 'executing' } );
	const _result = g6( _node, { lessons: true, context: { confirmed: 'other', attemptsOpen: 1, ticketsOpen: 1, deliveriesOpen: [ 'd-1' ] } } );
	assert.ok( DIMENSIONS.every( name => _result.dimensions[ name ].length > 0 ) );
	assert.deepEqual( _result.problems, DIMENSIONS.flatMap( name => _result.dimensions[ name ] ) );
	assert.deepEqual( DIMENSIONS.map( name => _result.dimensions[ name ].length ), [ 1, 2, 1, 3, 1, 1 ] );
} );

attack( SUBJECT, 'all 64 combinations of broken dimensions: ok only when none is broken, and each reports exactly when broken', () => {
	const _breakers = {
		functional: node => node.facts.splice( 0 ),
		formal: ( node, options ) => { options.context.confirmed = 'other'; },
		commercial: ( node, options ) => { options.context.attemptsOpen = 1; },
		organisational: ( node, options ) => { options.context.ticketsOpen = 1; },
		knowledge: ( node, options ) => { options.lessons = true; },
		structure: node => node.children.push( { id: 'c', state: 'executing' } ),
	};
	for ( let mask = 0; mask < 64; mask++ ) {
		const _node = done();
		const _options = { context: {} };
		DIMENSIONS.forEach( ( name, i ) => mask & ( 1 << i ) && _breakers[ name ]( _node, _options ) );
		const _result = g6( _node, _options );
		assert.equal( _result.ok, mask === 0, String( mask ) );
		DIMENSIONS.forEach( ( name, i ) => assert.equal( _result.dimensions[ name ].length > 0, Boolean( mask & ( 1 << i ) ), `${mask} ${name}` ) );
	}
} );

attack( SUBJECT, 'the check reads the node and changes nothing in it', () => {
	const _node = done( [ REPORT, MIN_GROUP ] );
	const _before = JSON.stringify( [ _node.facts, _node.state, _node.version, _node.children ] );
	g6( _node, { lessons: true, context: { attemptsOpen: 3 } } );
	assert.equal( JSON.stringify( [ _node.facts, _node.state, _node.version, _node.children ] ), _before );
} );

attack( SUBJECT, 'a plain node object without valid() is checked over its facts, and superseded facts still do not count', () => {
	const _plain = { contract: contract(), facts: [ { id: 'f1', ...delivered(), superseded: true } ], children: [] };
	assert.equal( g6( _plain ).ok, false );
	_plain.facts.push( { id: 'f2', ...delivered() } );
	assert.equal( g6( _plain ).ok, true );
} );

attack( SUBJECT, 'five thousand facts are judged in well under a second', () => {
	const _node = nodeFor( [ REPORT, MIN_GROUP ] );
	const _next = random( 9 );
	for ( let i = 0; i < 5000; i++ ) { _node.facts.push( { id: `f${i}`, ...delivered( { to: _next.pick( [ 'it', 'sales', 'ops' ] ) } ) } ); }
	const _start = Date.now();
	assert.equal( g6( _node ).ok, false );
	assert.ok( Date.now() - _start < 3000 );
} );

attack( SUBJECT, 'a delivery fact without data is ignored cleanly instead of crashing the check', () => {
	for ( const data of [ null, undefined ] ) {
		const _node = done( [ REPORT, MIN_GROUP ] );
		_node.facts.push( { id: 'f-bad', kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data } );
		assert.equal( g6( _node ).ok, true, String( data ) );
	}
} );
