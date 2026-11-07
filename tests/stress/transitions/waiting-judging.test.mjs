// waiting → judging (table 16.1: an event is delivered or a deadline reached, G3; E4: a late fact moves only a waiting
// node, into its judgment). The real ways: a person answers, the approval is decided at the gate, the child ends, the
// review of the attempt is due (19), the escalation is answered, a late fact wakes the node, an answer from outside.
import assert from 'node:assert/strict';
import { matrix, LATE } from './matrix.mjs';
import { path } from './paths.mjs';
import { out, strategy, rig, spec } from './rig.mjs';
import { attack, within } from '../hostile.mjs';
import { verify } from './check.mjs';

const T = 'waiting→judging';

// The node judges once per event, never executes straight from waiting, and was woken by what it waited for.
const judged = what => ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	if ( what ) { assert.match( JSON.stringify( hit[ 0 ].event.data ), what ); }
	const _events = last.events( _node, 'state_changed' );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	assert.equal( _events[ _at - 1 ].data.to, 'waiting' );
	const _next = _events[ _at + 1 ];
	assert.ok( !_next || [ 'planning', 'closing', 'waiting' ].includes( _next.data.to ), `after the judgment: ${_next?.data.to}` );
	return _node;
};
const WAKE = path( 'ask', { script: { 'stress.ask': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] } } );

matrix( T, [
	{ name: 'a person answers the question the attempt waits for', options: path( 'ask' ), status: 'fulfilled', check: judged( /stress\.ask/ ) },
	{
		name: 'the approval is decided at the gate', options: path( 'report' ), given: { report: true }, status: 'fulfilled', skip: [ 'garbage' ],
		check: ( state ) => {
			judged()( state );
			if ( state.id === 'none' ) { assert.equal( state.last.gateDb.get( 'SELECT status FROM approvals' ).status, 'consumed', 'its token was used (A6)' ); }
		},
	},
	{
		name: 'the child for the precondition ends', options: path( 'deeper' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			judged( /child_ended/ )( state );
			const [ _child ] = state.root.children;
			assert.equal( _child.state, 'closed', 'the parent judges only once its child is closed (structure)' );
		},
	},
	{
		name: 'the review of the attempt is due without a signal (19)', options: path( 'review' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			judged( /review_due/ )( state );
			if ( state.id === 'none' ) {
				assert.equal( state.root.walls[ 0 ].cause, 'no_reaction' );
				assert.ok( state.last.events( state.root, 'move_cancelled' ).length, 'the open question was taken back (E6)' );
			}
		},
	},
	{
		// The person's "close as failed" is a result decided before closing: an abort that arrives once the node closes
		// (right after the answer) only cleans up, the decision stands.
		name: 'the person answers the escalation', options: path( 'escalate' ), status: 'failed', expect: { late: 'failed', twice: 'failed', abortSoon: 'failed' },
		check: state => judged( /answered/ )( state ),
	},
	{
		name: 'a late fact wakes the waiting node (E4)', options: WAKE, status: 'fulfilled', ms: 1500, skip: [ 'late', 'lateSoon', 'twice', 'lateCrash' ],
		prepare: r => r.on( 'executing→waiting', node => setTimeout( () => r.deliver( node, LATE ), 10 ) ),
		check: ( state ) => {
			judged( /measured/ )( state );
			if ( state.id === 'none' ) {
				assert.ok( state.last.events( state.root, 'verdict' ).some( event => event.data.rule === 'U1' ), 'the open attempt already proved it (U1)' );
				assert.ok( state.last.events( state.root, 'move_cancelled' ).length, 'what it no longer needs is taken back (E6)' );
			}
		},
	},
	{
		name: 'an answer from outside arrives for a wait', status: 'fulfilled',
		options: path( 'wait', { strategies: [ strategy( 'alpha', [ 'stress.wait', 'stress.probe', 'stress.measure' ] ) ], script: {
			'stress.wait': [ out.after( 5, out.none() ) ], 'stress.probe': [ out.none() ], 'stress.measure': [ out.fact() ],
		} } ),
		check: judged( /stress\.wait/ ),
	},
] );

// core/main.js resumes the open goals and serves the board at once; a person who looks at the tickets during the restart
// must see the escalation the resumed node puts, and answer it.
attack( `transition ${T}`, 'after a restart the escalation reaches the person who looks at the board while the core resumes', async () => {
	const r = await rig( path( 'escalate' ) );
	const _crashed = new Promise( ( resolve ) => {
		r.on( 'judging→waiting', () => {
			r.crash();
			resolve();
		}, { node: 'root' } );
	} );
	r.root = await r.start( spec() );
	r.current().run( r.root );
	await within( _crashed, 3000, 'the crash' );
	const _next = await r.restart( { boardFirst: false }, 1000 ).catch( ( error ) => {
		r.state.next?.crash();
		throw error;
	} );
	_next.stop();
	assert.equal( _next.current().executor.board, await _next.system.board(), 'one board for the core and the person' );
	verify( _next, { status: 'failed' } );
} );
