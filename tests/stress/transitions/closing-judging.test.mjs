// closing → judging (table 16.1: G6 finds an unmet predicate, only after "done", never in the abort cascade). The real
// ways: a newer measurement that arrived while the judge's model was thinking refutes the proof (E3: it waited in the
// queue until closing), the same with a person who says "try once more", a fact from another origin contradicts the
// proof (E5), the proof's validity ends before G6 (B2), and a child's proof is refuted before its own G6.
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path, retry, P1, ALPHA } from './paths.mjs';
import { out, measured, QUANTITY } from './rig.mjs';

const T = 'closing→judging';
// While the judge's model thinks about the proof, a fact arrives; it waits in the queue (E3) and closing takes it.
const during = ( fact, which = 'root' ) => ( r ) => {
	const _complete = r.provider._complete.bind( r.provider );
	let _sent = false;
	r.provider._complete = async ( request ) => {
		const _proven = node => ( which === 'root' ) === !node.parent && node.state === 'judging' && node.facts.some( item => item.kind === 'measured' );
		const _node = request.role === 'judge' && !_sent ? r.nodes().find( _proven ) : null;
		if ( _node ) {
			_sent = true;
			r.deliver( _node, fact );
		}
		return _complete( request );
	};
};
const ZERO = measured( 0, { id: 'newer-zero', source: 'sandbox stress.measure' } );
const ABOUT = ( value, origin ) => measured( value, { origin, data: { quantity: QUANTITY, value, about: QUANTITY } } );
const proofWithAbout = () => ( { value: { n: 1 }, labels: [ 'own' ], cohort: null, facts: [ ABOUT( 1, 'system' ) ] } );
// A proof valid for 400 ms: the judgment sees it valid; G6 comes after the lesson, and the learner's model answers only
// once the proof has expired.
const SHORT = () => ( {
	value: { n: 1 }, labels: [ 'own' ], cohort: null, facts: [ measured( 1, { validUntil: new Date( Date.now() + 400 ).toISOString() } ) ],
} );
const expiring = ( r ) => {
	const _complete = r.provider._complete.bind( r.provider );
	r.provider._complete = async ( request ) => {
		const _until = Math.max( 0, ...r.nodes().flatMap( node => node.facts ).map( fact => Date.parse( fact.validUntil || 0 ) ) );
		if ( request.role === 'learner' ) { await new Promise( resolve => setTimeout( resolve, Math.max( 0, _until - Date.now() ) + 10 ) ); }
		return _complete( request );
	};
};
// After G6 sent it back, the late fact from outside proves the goal again at the next judgment.
const proven = { late: 'fulfilled', lateSoon: 'fulfilled', twice: 'fulfilled' };
const aborted = Object.fromEntries( [ 'abort', 'abortSoon', 'abortTwice', 'abortCrash' ].map( id => [ id, 'aborted' ] ) );

// Back to the judgment only from a goal judged done, never in the cascade; G6 named the unmet predicate.
const back = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.ok( hit[ 0 ].event.data.g6?.length, 'G6 names what is not met' );
	assert.equal( hit[ 0 ].stopping, false, 'never in the abort cascade (16.1)' );
	const _verdicts = last.events( _node, 'verdict' ).filter( event => event.id < hit[ 0 ].event.id );
	assert.equal( _verdicts.at( -1 )?.data.verdict, 'done', 'only after "done"' );
	return _node;
};

matrix( T, [
	{
		name: 'a newer measurement refutes the proof before G6', options: path( 'direct', { strategies: [ ALPHA ] } ), status: 'failed',
		expect: proven, prepare: during( ZERO ), check: back,
	},
	{
		name: 'a newer measurement refutes the proof, the person says "try once more"', status: 'fulfilled', expect: { ...proven, tokens: 'failed' },
		options: path( 'direct', { strategies: [ ALPHA ], person: retry, script: { 'stress.measure': [ out.fact(), out.fact() ] } } ),
		prepare: during( ZERO ), check: back,
	},
	{
		name: 'a fact from another origin contradicts the proof (E5)', status: 'failed',
		options: path( 'direct', { strategies: [ ALPHA ], script: { 'stress.measure': [ proofWithAbout ] } } ),
		prepare: during( ABOUT( 0, 'other' ) ),
		check: ( state ) => {
			back( state );
			assert.match( state.hit[ 0 ].event.data.g6.join(), /open conflict/ );
		},
	},
	{
		name: 'the proof\'s validity ends before G6 (B2)', status: 'failed', expect: proven,
		options: path( 'direct', { strategies: [ ALPHA ], script: { 'stress.measure': [ SHORT ] } } ), prepare: expiring,
		skip: [ 'failed', 'abortTwice', 'lateSoon' ],
		check: ( state ) => {
			back( state );
			assert.match( state.hit[ 0 ].event.data.g6.join(), /k1/ );
		},
	},
	{
		name: 'a child\'s proof is refuted before its own G6', node: 'child', status: 'failed',
		options: { strategies: [ ALPHA ], script: { 'stress.measure@0': [ out.wall( 'precondition_missing', P1 ), out.fact() ], 'stress.measure@1': [ out.fact() ] } },
		prepare: during( measured( 0, { id: 'child-zero' }, 'stress:p' ), 'child' ),
		check: ( state ) => {
			const _child = back( state );
			assert.ok( [ 'failed', 'aborted' ].includes( _child.result.status ), 'a refuted child never reports fulfilled (R7)' );
		},
	},
].map( trigger => ( { ...trigger, expect: { ...aborted, ...trigger.expect } } ) ), Object.keys( INTERFERENCES ) );
