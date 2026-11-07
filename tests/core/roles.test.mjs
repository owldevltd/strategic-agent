import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, Mission, registry } from '../office.mjs';

const [ StubProvider, Drafter ] = await use( 'Core.Ai.StubProvider', 'Core.Contract.Drafter' );

// Records what each model role was given.
class Recording extends StubProvider {

	constructor( options ) {
		super( options );
		this.calls = [];
	}

	async _complete( request ) {
		this.calls.push( request );
		return super._complete( request );
	}

}

test( '22: every model role gets only what its row allows; the extraction sees one message and its schema, never other processes', async () => {
	const _mission = Mission.load( 'survey' );
	const _provider = new Recording( { answers: _mission.stub } );
	const _o = await office( { provider: _provider, edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	await _o.run();
	const _inputs = role => _provider.calls.filter( call => call.role === role ).map( call => call.input );
	const _world = _mission.world.people.flatMap( person => person.replies.map( reply => reply.text ) );
	assert.ok( _inputs( 'extractor' ).length > 0 );
	assert.ok( _inputs( 'extractor' ).every( input => JSON.stringify( Object.keys( input ) ) === '["text"]' ), 'one message, nothing else' );
	for ( const role of [ 'judge', 'strategist', 'learner' ] ) {
		const _text = JSON.stringify( _inputs( role ) );
		assert.ok( !_world.some( reply => _text.includes( reply.slice( 0, 30 ) ) ), `${role} never sees text from the world` );
	}
	const _filled = _inputs( 'strategist' ).filter( item => item.chosen );
	assert.ok( _filled.length > 0 );
	for ( const input of _filled ) {
		assert.deepEqual( Object.keys( input ).sort(), [ 'chosen', 'experience', 'facts', 'goal', 'lastWall', 'open' ] );
		assert.ok( input.facts.every( fact => Object.keys( fact ).join() === 'kind,evidence' ) );
	}
	const _draft = new Recording( { answers: _mission.stub } );
	await new Drafter( { provider: _draft, registry } ).draft( _mission, _mission.task );
	assert.deepEqual( Object.keys( _draft.calls[ 0 ].input ).sort(), [ 'addedAutomatically', 'catalog', 'moves', 'task' ], 'the task and the catalog' );
} );
