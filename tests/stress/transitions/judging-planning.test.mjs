// judging → planning (table 16.1: on, another way or deeper). The real ways: U3 another strategy after a wall, the
// open attempt goes on after the awaited answer (19), the review finds no signal and another strategy follows (19,
// 5.5), U2 the parent goes deeper, R7 the child met the precondition, and a person says "try once more" (U4).
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, ALPHA } from './paths.mjs';
import { attack, within } from '../hostile.mjs';
import { rig, spec, out } from './rig.mjs';
import { verify } from './check.mjs';

const T = 'judging→planning';

// The judgment that sent the node on was logged first, and planning followed it at once.
const decided = ( verdict, data ) => ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	if ( data ) { assert.match( JSON.stringify( hit[ 0 ].event.data ), data ); }
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _verdict = _events.slice( 0, _at ).reverse().find( event => event.kind === 'verdict' );
	if ( verdict ) { assert.equal( _verdict?.data.verdict, verdict, 'the verdict that led to planning (16.4)' ); }
	return _node;
};

matrix( T, [
	{
		name: 'U3: another strategy after a wall of the strategy', options: path( 'other' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			decided( 'other' )( state );
			assert.equal( state.last.events( state.root, 'verdict' )[ 0 ].data.rule, 'U3' );
		},
	},
	{
		name: 'the open attempt goes on after the awaited answer (19)', options: path( 'ask' ), status: 'fulfilled',
		check: ( state ) => {
			decided( 'continue', /"continue":"alpha"/ )( state );
			if ( state.id === 'tokens' ) { assert.equal( state.last.events( state.root, 'plan_accepted' ).length, 1, 'no new token for it (R1)' ); }
		},
	},
	{
		name: 'the review finds no signal, another strategy follows (19, 5.5)', options: path( 'review' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			decided( 'other', /"review":"alpha"/ )( state );
			const _first = state.r.system.journal.forNode( state.root.id )[ 0 ];
			assert.deepEqual( [ _first.outcome, _first.cause ], [ 'timeout', 'no_reaction' ], 'no signal is a provisional result (B8)' );
		},
	},
	{
		name: 'U2: the parent goes deeper for a missing precondition', options: path( 'deeper' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			decided( 'deeper', /"deeper":"p1"/ )( state );
			assert.equal( state.last.events( state.root, 'verdict' )[ 0 ].data.rule, 'U2' );
		},
	},
	{
		name: 'R7: the child met the precondition, the strategy may run again', nth: 2, options: path( 'deeper' ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( state ) => {
			const _node = decided( null )( state );
			assert.ok( _node.preconditionMet( 'p1' ), 'the parent holds the child\'s evidence as a fact (R7)' );
			assert.equal( _node.facts.find( fact => fact.kind === 'precondition_met' ).evidenceClass, 'observation', 'never stronger than the child\'s (B3)' );
		},
	},
	{
		name: 'a person says "try once more" after the escalation (U4)', nth: 2, options: path( 'retry' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			decided( 'escalate', /try once more/ )( state );
			assert.ok( state.last.events( state.root, 'ticket_answered' ).some( event => event.data.choice === 'try once more' ) );
		},
	},
] );

const S = `transition ${T}`;
const FOREVER = path( 'retry', { script: { 'stress.measure': [ out.wall( 'not_reached' ) ] } } );
const offers = ( r, node ) => r.events( node, 'ticket_opened' ).map( event => event.data.options.includes( 'try once more' ) );
const change = ticket => ( ticket.options.includes( 'change the goal as suggested' ) ? 'change the goal as suggested' : ticket.recommendation );
const AMEND = {
	strategies: [ ALPHA ], planner: false, person: change, script: { 'stress.measure': [ out.wall( 'not_reached' ), out.fact( 0 ) ] },
	answers: { judge: { verdict: 'escalate', reason: 'the bar is too high', amendment: [ { criterion: 'k1', values: { min: 0 } } ] } },
};

// Runs a goal until fn( r, node ) has crashed the core inside a hook, then restarts it to its end.
async function crashed( options, hook ) {
	const r = await rig( options );
	const _crash = new Promise( ( resolve ) => {
		hook( r, () => {
			r.crash();
			resolve();
		} );
	} );
	r.root = await r.start( spec() );
	r.current().run( r.root );
	await within( _crash, 3000, 'the crash' );
	const _next = await r.restart();
	_next.stop();
	return { r, next: _next };
}

attack( S, '"try once more" is offered a single time (U4)', async () => {
	const r = await rig( FOREVER );
	const _root = await r.run();
	r.stop();
	verify( r, { status: 'failed' } );
	assert.deepEqual( offers( r, _root ), [ true, false ], 'the second escalation only offers to close' );
	const _list = r.transitions( _root );
	assert.deepEqual( _list.slice( _list.lastIndexOf( 'judging→waiting' ) ), [ 'judging→waiting', 'waiting→judging', 'judging→closing', 'closing→closed' ],
		'after the second escalation the goal closes; it does not plan again' );
} );

attack( S, '"try once more" is offered a single time, also when the core restarts after it (18)', async () => {
	const { next } = await crashed( FOREVER, ( r, crash ) => r.on( 'judging→planning', crash, { node: 'root', when: event => /try once more/.test( event.data.reason || '' ) } ) );
	verify( next, { status: 'failed' } );
	assert.ok( !offers( next, next.root ).slice( 1 ).some( Boolean ), JSON.stringify( offers( next, next.root ) ) );
} );

attack( S, 'the person changes the goal as suggested (3.2): G1 and the gate confirm the new contract, then the node plans', async () => {
	const r = await rig( AMEND );
	const _root = await r.run();
	r.stop();
	verify( r, { status: 'fulfilled' } );
	const [ _amended ] = r.events( _root, 'contract_amended' );
	assert.equal( _amended.data.to, _root.contract.hash );
	assert.equal( r.gateDb.get( 'SELECT status FROM contracts WHERE hash = :hash', { hash: _root.contract.hash } ).status, 'confirmed' );
	const _changes = r.events( _root, 'state_changed' );
	const _at = _changes.findIndex( event => /changed the goal/.test( event.data.reason || '' ) );
	assert.equal( `${_changes[ _at ].data.from}→${_changes[ _at ].data.to}`, T );
	assert.ok( _changes[ _at ].id > _amended.id, 'planning follows the confirmed amendment' );
} );

attack( S, 'the amended contract survives a restart; the person is not asked again (3.2, 18)', async () => {
	const { r, next } = await crashed( AMEND, ( rr, crash ) => rr.onEvent( 'contract_amended', crash, { node: 'root' } ) );
	verify( next, { status: 'fulfilled' } );
	const [ _amended ] = r.events( next.root, 'contract_amended' );
	assert.equal( next.root.contract.hash, _amended.data.to );
	assert.equal( next.events( next.root, 'ticket_opened' ).length, 1, 'one decision of the client, not two' );
} );

attack( S, 'a signal of the attempt before its review: the attempt goes on, a signal confirms nothing (5.5)', async () => {
	const r = await rig( path( 'review' ) );
	r.onEvent( 'plan_accepted', ( node, event ) => r.system.journal.signal( event.data.attempt ), { node: 'root' } );
	r.on( 'judging→planning', () => r.open( 'never' ), { node: 'root', when: event => Boolean( event.data.continue ) } );
	const _root = await r.run();
	r.stop();
	verify( r, { status: 'fulfilled' } );
	const _verdict = r.events( _root, 'verdict' ).find( event => event.data.verdict === 'continue' );
	assert.match( _verdict.data.rule, /a signal does not confirm/ );
	assert.deepEqual( r.events( _root, 'plan_accepted' ).map( event => event.data.strategy ), [ 'alpha' ], 'the same attempt went on' );
} );
