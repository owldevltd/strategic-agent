import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office, app } from '../office.mjs';

const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

// The world of these tests: one person answers with a reading the parser contradicts, then the same message again.
const disputed = ( mission ) => {
	quick( mission );
	mission.strategies.find( item => item.id === 'wait-longer' ).steps[ 0 ].params.minutes = 0.01;
	mission.world.people = [
		{ name: 'Mira', team: 'design', replies: [ { after: 1, key: true, text: 'Workload: 2 of 5. Two people for four product lines, nobody plans with us.' } ] },
	];
};

test( 'B4: when the parser and the model read a fixed field differently, a person decides which reading holds', async () => {
	const _asked = [];
	const _person = ( ticket ) => {
		if ( /Two readings/.test( ticket.question ) ) { _asked.push( ticket.question ); return 'the parser'; }
		return ticket.recommendation;
	};
	// The model reads a 4 where the text says 2.
	const _o = await office( { edit: disputed, person: _person, answers: { extractor: { workload: 4, manager: 3, theme: 'workload' } } } );
	await _o.run();
	assert.match( _asked[ 0 ], /workload: the parser read 2/ );
	assert.ok( _o.log.since( 0 ).some( event => event.kind === 'reading_disputed' ) );
} );

test( 'B4: a reading becomes a claim only when the parser read every fixed field; one it cannot read leaves a derivation', async () => {
	const _o = await office( { edit: ( mission ) => {
		disputed( mission );
		// The manager score is now a fixed field, and no parser reads it.
		delete mission.moves[ 'followup.invite' ].creates.expectation.extract.manager.fixed;
	}, answers: { extractor: { workload: 2, manager: 3, theme: 'workload' } } } );
	await _o.run();
	const _read = _o.log.since( 0 ).filter( event => event.kind === 'inbound_read' );
	assert.ok( _read.length );
	assert.ok( _read.every( event => event.data.evidenceClass === 'derivation' ) );
	const [ Intake ] = await app.use( [ 'Core.Inbound.Intake' ] );
	const _extract = { amount: { type: 'number' }, date: { type: 'date' }, note: { type: 'string' } };
	assert.equal( Intake.covered( _extract, { amount: 12 } ), false );
	assert.equal( Intake.covered( _extract, { amount: 12, date: '2026-11-04' } ), true, 'a field that is no fixed field needs no parser' );
	assert.equal( Intake.covered( { note: { type: 'string' } }, {} ), false, 'without a fixed field the reading stays a derivation' );
} );

test( '10.4: a critical field is read twice, independently; two different readings go to a person', async () => {
	const _asked = [];
	const _person = ( ticket ) => {
		if ( /Two readings/.test( ticket.question ) ) { _asked.push( ticket.question ); return 'neither, discard it'; }
		return ticket.recommendation;
	};
	const _o = await office( {
		edit: ( mission ) => {
			disputed( mission );
			delete mission.moves[ 'followup.invite' ].creates.expectation.parser;
		},
		person: _person,
		answers: { extractor: [ { workload: 2, manager: 3, theme: 'workload' }, { workload: 3, manager: 3, theme: 'workload' } ] },
	} );
	await _o.run();
	assert.match( _asked[ 0 ], /workload: a second reading gave 3/ );
} );

test( 'E2 and 8.3: the same message twice is processed once; a fact carries where it came from', async () => {
	const _o = await office( { edit: quick } );
	const _root = await _o.run();
	const _message = { id: 'in-same', from: 'Emil', subject: 'Re: survey', text: 'Workload 2. Mostly tooling, the design system is broken.' };
	await _o.system.receive( 'survey', _message );
	assert.equal( ( await _o.system.receive( 'survey', _message ) ).case, 'duplicate' );
	const _child = _root.children[ 0 ];
	const _fact = _child.facts.find( fact => fact.kind === 'survey_response' );
	assert.ok( _fact.provenance.inbound );
	assert.equal( _fact.provenance.label, 'foreign' );
	assert.equal( _fact.parserMatch, 'equal' );
} );

test( 'B3: what a child proves reaches its parent no stronger than the child\'s weakest evidence', async () => {
	const _o = await office( { edit: quick } );
	const _root = await _o.run();
	const _met = _root.facts.find( fact => fact.kind === 'precondition_met' );
	assert.equal( _met.evidenceClass, 'observation', 'the child counted the answers itself' );
} );

test( 'soft criteria (14): a reviewer assesses them when the node closes; they never decide', async () => {
	const _o = await office( { edit: quick, answers: { reviewer: { met: 'no', reason: 'the report is dry' } } } );
	const _spec = _o.mission.contractSpec();
	_spec.soft = [ 'friendly and factual' ];
	const _root = await _o.run( _spec );
	assert.equal( _root.result.status, 'fulfilled', 'a soft criterion never decides on its own' );
	assert.deepEqual( _root.result.soft.map( item => [ item.text, item.met ] ), [ [ 'friendly and factual', false ] ] );
} );

test( '6.4: an answer that breaks its step contract goes to a person with the reason', async () => {
	const _asked = [];
	const _o = await office( {
		strategies: [ 'team-report', 'widen-group' ],
		answers: { writer: { wrong: 'field' } },
		person: ( ticket ) => {
			if ( /broke its step contract/.test( ticket.question ) ) { _asked.push( ticket.question ); return 'stop this step'; }
			return ticket.recommendation;
		},
	} );
	const _root = await _o.run();
	assert.match( _asked[ 0 ], /report.draft broke its step contract/ );
	assert.ok( _root.walls.some( wall => wall.cause === 'move_failed' ) );
} );
