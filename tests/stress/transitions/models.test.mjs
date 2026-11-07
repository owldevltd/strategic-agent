// A model that never answers, or answers garbage, at the transitions where a model has a part: the judge (16.4), the
// strategist filling a plan's slots or proposing a strategy (19), the writer of a report, the learner and the reviewer
// while closing. Z2: every state but closing and closed has a deadline, and the model's part is cut off by it; closing is
// bounded by Δ. The code's own reading then applies, and an abort still comes first (Z6).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { attack } from '../hostile.mjs';
import { rig, spec, strategy, out } from './rig.mjs';
import { verify } from './check.mjs';
import { path } from './paths.mjs';

const CUT = { planning: 0.001, judging: 0.001 };
const BASE = JSON.parse( fs.readFileSync( join( import.meta.dirname, '../../../catalog/moves.json' ), 'utf8' ) );
// A run cut off at 60 ms ends in a few hundred; a second is a hang.
const HANG = 1000;
const silent = ( ...roles ) => ( { model: 'silent', roles, stateMinutes: CUT } );
const timedOut = ( r, node, state ) => node.facts.some( fact => fact.kind === 'timeout' && fact.data.state === state )
	&& r.events( node, 'deadline_reached' ).some( event => event.data.of === state );

// Runs a goal; a run that hangs is frozen and fails.
async function goal( options, given = {}, ms = 2000, before = null ) {
	const r = await rig( options );
	before?.( r );
	try {
		r.root = await r.run( spec( given ), ms );
	} catch ( error ) {
		r.crash();
		throw error;
	} finally {
		r.stop();
	}
	return r;
}

attack( 'transition judging→planning', 'the judge\'s model never answers: Z2 cuts the judgment off and the code\'s reading sends the node on (U3)', async () => {
	const r = await goal( { ...path( 'other' ), ...silent( 'judge' ) }, {}, HANG );
	verify( r, { status: 'fulfilled' } );
	assert.ok( timedOut( r, r.root, 'judging' ), 'a timeout fact for judging (Z2)' );
} );

attack( 'transition judging→closing', 'the judge\'s model never answers: Z2 cuts it off and U1 closes the proven goal', async () => {
	const r = await goal( { ...path( 'direct' ), ...silent( 'judge' ) }, {}, HANG );
	verify( r, { status: 'fulfilled' } );
} );

attack( 'transition judging→waiting', 'the judge\'s model never answers: Z2 cuts it off and a person is asked (U4)', async () => {
	const r = await goal( { ...path( 'escalate' ), ...silent( 'judge' ) }, {}, HANG );
	verify( r, { status: 'failed' } );
	assert.ok( r.transitions( r.root ).includes( 'judging→waiting' ) );
} );

attack( 'transition judging→closing', 'the client aborts while the judge\'s model thinks: the abort comes first (Z6)', async () => {
	const r = await goal( { ...path( 'direct' ), model: 'silent', roles: [ 'judge' ] }, {}, HANG,
		rr => rr.on( 'executing→judging', () => setTimeout( () => rr.abort( rr.root ), 20 ), { node: 'root' } ) );
	verify( r, { status: 'aborted' } );
} );

attack( 'transition judging→closing', 'the judge\'s model answers garbage: its proposal is dropped and U1 decides', async () => {
	const r = await goal( { ...path( 'direct' ), model: 'garbage', roles: [ 'judge' ] } );
	verify( r, { status: 'fulfilled' } );
	const _verdict = r.events( r.root, 'verdict' ).at( -1 ).data;
	assert.deepEqual( [ _verdict.proposed, _verdict.verdict, _verdict.rule ], [ null, 'done', 'U1' ], 'no proposal, the code decides' );
} );

const SLOTS = strategy( 'alpha', [ { move: 'stress.measure', params: { teams: '{{teams}}' } } ], {
	slots: { teams: { type: 'list', values: [ 'design', 'product' ], describe: 'the teams', default: [ 'design' ] } },
} );
const WITH_SLOTS = { strategies: [ SLOTS ], edit: ( mission ) => {
	mission.moves[ 'stress.measure' ] = { ...mission.moves[ 'stress.measure' ], params: { teams: { type: 'list' } } };
}, script: { 'stress.measure': [ out.fact() ] } };

attack( 'transition planning→executing', 'the strategist never answers while filling the slots: Z2 cuts it off, the declared defaults fill the plan', async () => {
	const r = await goal( { ...WITH_SLOTS, ...silent( 'strategist' ) } );
	verify( r, { status: 'fulfilled' } );
	assert.ok( timedOut( r, r.root, 'planning' ), 'a timeout fact for planning (Z2)' );
	assert.equal( r.called( 'stress.measure' ), 1, 'one move, no second try' );
} );

attack( 'transition planning→executing', 'the strategist answers garbage while filling the slots: the declared defaults fill the plan', async () => {
	const r = await goal( { ...WITH_SLOTS, model: 'garbage', roles: [ 'strategist' ] } );
	verify( r, { status: 'fulfilled' } );
	assert.equal( r.events( r.root, 'plan_accepted' ).length, 1 );
} );

attack( 'transition planning→judging', 'stuck, and the strategist never proposes a new strategy: Z2 cuts it off, the node escalates', async () => {
	const r = await goal( { ...path( 'escalate' ), ...silent( 'strategist' ) } );
	verify( r, { status: 'failed' } );
	assert.ok( r.transitions( r.root ).includes( 'planning→judging' ) );
	assert.ok( timedOut( r, r.root, 'judging' ), 'the proposal was cut off in judging (Z2)' );
} );

attack( 'transition executing→judging', 'the writer of the report never answers: its lease ends the move (A3), the node judges the wall', async () => {
	const _short = ( mission ) => {
		mission.moves[ 'report.draft' ] = { ...BASE[ 'report.draft' ], leaseMaxMin: 0.004 };
	};
	const r = await goal( { ...path( 'report' ), model: 'silent', roles: [ 'writer' ], edit: _short }, { report: true }, 3000 );
	verify( r, { status: 'failed' } );
	assert.equal( r.root.walls[ 0 ].cause, 'lease_expired' );
	assert.equal( r.gateDb.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n, 0, 'nothing reached the gate' );
} );

attack( 'transition closing→closed', 'the learner never answers: closing is bounded by Δ, the code writes the lesson', async () => {
	const r = await goal( { ...path( 'direct' ), model: 'silent', roles: [ 'learner' ] }, {}, 3000, ( rr ) => {
		rr.current().bufferMinutes = 0.005;
	} );
	verify( r, { status: 'fulfilled' } );
	assert.ok( timedOut( r, r.root, 'closing' ), 'the model\'s part of closing was cut off (Δ)' );
	assert.ok( r.events( r.root, 'lesson_written' ).length, 'the lesson by code alone' );
} );

attack( 'transition closing→closed', 'the reviewer of a soft wish never answers: closing is bounded by Δ, the wish decides nothing (14)', async () => {
	const r = await goal( { ...path( 'direct' ), model: 'silent', roles: [ 'reviewer' ] }, {}, 3000, ( rr ) => {
		rr.current().bufferMinutes = 0.005;
		const _start = rr.start.bind( rr );
		rr.start = given => _start( { ...given, soft: [ 'be brief' ] } );
	} );
	verify( r, { status: 'fulfilled' } );
	assert.ok( timedOut( r, r.root, 'closing' ) );
} );

attack( 'transition closing→closed', 'the learner answers garbage: G4 refuses nothing it did not get, the lesson is written by code', async () => {
	const r = await goal( { ...path( 'other' ), model: 'garbage', roles: [ 'learner' ] } );
	verify( r, { status: 'fulfilled' } );
	assert.equal( r.events( r.root, 'lesson_written' ).length, 2, 'one lesson per attempt' );
} );

attack( 'transition waiting→judging', 'the answer the node waited for comes while every model is silent: the judgment goes on by code (Z2)', async () => {
	const r = await goal( { ...path( 'ask' ), ...silent( 'judge', 'learner', 'strategist' ) }, {}, HANG, ( rr ) => {
		rr.current().bufferMinutes = 0.005;
	} );
	verify( r, { status: 'fulfilled' } );
} );
