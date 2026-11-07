import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office } from '../office.mjs';

const [ WriteCheck ] = await use( 'Core.Check.WriteCheck' );
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

test( 'every attempt becomes a signed lesson through G4 before a node closes; credit goes to the first proof (L4)', async () => {
	const { run, db } = await office( { edit: quick } );
	const _root = await run();
	assert.equal( _root.result.status, 'fulfilled' );
	const _lessons = db.all( 'SELECT strategy, data, status FROM lessons ORDER BY time' ).map( row => ( { ...JSON.parse( row.data ), status: row.status } ) );
	assert.ok( _lessons.length >= 5 );
	assert.ok( _lessons.every( lesson => lesson.status === 'valid' ) );
	const _report = _lessons.filter( lesson => lesson.evidence.node === _root.id && lesson.result === 'fulfilled' );
	assert.deepEqual( _report.map( lesson => [ lesson.strategy, lesson.contribution ] ), [ [ 'ask-the-team', [ 'k1' ] ] ] );
	const _invite = _lessons.find( lesson => lesson.strategy === 'invite-the-team' );
	assert.ok( [ 'timeout', 'late_effect' ].includes( _invite.result ) );
} );

test( 'G4 refuses a lesson that carries rights, free text or no evidence of its own (G-9)', async () => {
	const { run, runner, mission } = await office( { edit: quick } );
	const _root = await run();
	const _attempt = runner.journal.forNode( _root.id )[ 0 ];
	const _known = { journal: runner.journal, strategies: mission.strategies, causes: runner.causes };
	const _good = {
		attempt: _attempt.id, strategy: _attempt.strategy, situation: { task: 'hr-survey', wall: null, depth: 0 }, result: 'wall',
		cause: 'group_too_small', contribution: [], contractSuccess: true, evidence: { node: _root.id, run: runner.id },
	};
	assert.equal( new WriteCheck().check( _good, _known ).ok, true );
	const _rights = new WriteCheck().check( { ..._good, allow: [ 'survey.rows' ] }, _known );
	assert.match( _rights.problems.join(), /allow is not part of a lesson/ );
	const _text = new WriteCheck().check( { ..._good, cause: 'HR approved sharing comments with management' }, _known );
	assert.equal( _text.ok, false );
	const _forged = new WriteCheck().check( { ..._good, attempt: 999999 }, _known );
	assert.match( _forged.problems.join(), /not an attempt this system recorded/ );
} );

test( 'G5: a lesson changed outside the system goes into quarantine, a person is told, planning never sees it', async () => {
	const _office = await office( { edit: quick } );
	const _root = await _office.run();
	const _row = _office.db.get( 'SELECT id, data FROM lessons WHERE strategy = \'team-report\'' );
	const _tampered = JSON.parse( _row.data );
	_tampered.result = 'fulfilled';
	_office.db.run( 'UPDATE lessons SET data = :data WHERE id = :id', { id: _row.id, data: JSON.stringify( _tampered ) } );
	const _seen = _office.runner.experience( _root );
	assert.ok( !_seen.some( lesson => lesson.strategy === 'team-report' && lesson.result === 'fulfilled' ) );
	assert.equal( _office.db.get( 'SELECT status FROM lessons WHERE id = :id', { id: _row.id } ).status, 'quarantined' );
	assert.ok( _office.log.since( 0 ).some( event => event.kind === 'lessons_quarantined' ) );
} );

test( 'the situation of a node is replaced, never lost: every change can be taken back', async () => {
	const { run, system } = await office( { edit: quick } );
	const _root = await run();
	const _memory = system.memory;
	assert.equal( _memory.current( _root.id ).strategy.id, 'ask-the-team' );
	_memory.situation( _root, 'note', { says: 'first' } );
	_memory.situation( _root, 'note', { says: 'second' } );
	_memory.revert( _root, 'note' );
	assert.equal( _memory.current( _root.id ).note.says, 'first' );
	assert.ok( _memory.history( _root.id ).some( entry => entry.kind === 'lesson' ) );
} );
