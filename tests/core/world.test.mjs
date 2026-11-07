// world/simulation.js: the scripted world a mission is tested against. People answer an invitation to their team (the
// actions world.json names as invitations; none when it names none), responders answer what matches them, and
// {{name}} in a subject or a text is filled from the message. Seen with a survey and an offsite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../office.mjs';

const [ Simulation ] = await app.use( [ 'World.Simulation' ] );
const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) );

// A world over a fake outbox: each target's messages, and what was delivered back.
async function world( spec, sent, { mission = 'offsite' } = {} ) {
	const _delivered = [];
	const _sim = new Simulation( {
		world: spec, outbox: async target => sent.filter( item => item.target === target ), deliver: message => _delivered.push( message ),
		speed: 1000, pollMs: 5, mission,
	} );
	await _sim.look( { answer: false } );
	return { sim: _sim, delivered: _delivered };
}
const person = ( replies, team = 'design' ) => ( { name: 'Mira', team, replies } );

const SURVEY = { invitations: [ 'invite' ], keySubject: 'Re: Follow-up survey [{{round}}]', subject: 'Re: survey' };

test( 'a reply with the key has the world\'s keySubject, one without it the world\'s subject, both filled from the invitation', async () => {
	const _sent = [];
	const _people = [ person( [ { after: 0, key: true, text: 'Workload 2' } ] ), { name: 'Ben', team: 'design', replies: [ { after: 0, text: 'Which survey?' } ] } ];
	const { sim, delivered } = await world( { ...SURVEY, people: _people }, _sent, { mission: 'survey' } );
	_sent.push( { id: 'm1', target: 'design', action: 'invite', params: { round: 'FU-1' } } );
	await sim.look();
	await wait( 30 );
	sim.stop();
	assert.deepEqual( delivered.map( item => [ item.from, item.subject, item.to ] ).sort(),
		[ [ 'Ben', 'Re: survey', 'survey' ], [ 'Mira', 'Re: Follow-up survey [FU-1]', 'survey' ] ] );
} );

test( 'without invitations named, nobody answers anything: no action is an invitation by its name', async () => {
	const _sent = [];
	const { sim, delivered } = await world( { people: [ person( [ { after: 0, key: true, text: 'Workload 2' } ] ) ] }, _sent, { mission: 'survey' } );
	_sent.push( { id: 'm1', target: 'design', action: 'invite', params: { round: 'FU-1' } } );
	await sim.look();
	await wait( 30 );
	sim.stop();
	assert.deepEqual( delivered, [] );
} );

test( 'without a subject anywhere, a reply is "Re: <action>"', async () => {
	const _sent = [];
	const { sim, delivered } = await world( { invitations: [ 'offsite_invite' ], people: [ person( [ { after: 0, text: 'Yes' } ] ) ] }, _sent );
	_sent.push( { id: 'm1', target: 'design', action: 'offsite_invite', params: {} } );
	await sim.look();
	await wait( 30 );
	sim.stop();
	assert.deepEqual( delivered.map( item => item.subject ), [ 'Re: offsite_invite' ] );
} );

test( 'people answer the actions world.json names as invitations, and only those', async () => {
	const _sent = [];
	const _spec = { invitations: [ 'offsite_invite', 'offsite_reminder' ], people: [ person( [ { after: 0, subject: 'Re: Offsite [{{ref}}]', text: 'Yes' } ] ) ] };
	const { sim, delivered } = await world( _spec, _sent );
	_sent.push( { id: 'm1', target: 'design', action: 'offsite_invite', params: { ref: 'OF-7' } } );
	_sent.push( { id: 'm2', target: 'design', action: 'invite', params: { ref: 'OF-8' } } );
	await sim.look();
	await wait( 30 );
	sim.stop();
	assert.deepEqual( delivered.map( item => [ item.subject, item.to, item.text ] ), [ [ 'Re: Offsite [OF-7]', 'offsite', 'Yes' ] ] );
} );

test( 'a person\'s text is filled from the invitation too; a placeholder the message has no value for stays as it is', async () => {
	const _sent = [];
	const _spec = { invitations: [ 'offsite_invite' ], people: [ person( [ { after: 0, subject: 'Re: {{ref}}', text: 'Count me in for {{date}} ({{missing}})' } ] ) ] };
	const { sim, delivered } = await world( _spec, _sent );
	_sent.push( { id: 'm1', target: 'design', action: 'offsite_invite', params: { ref: 'OF-7', date: '12 Dec' } } );
	await sim.look();
	await wait( 30 );
	sim.stop();
	assert.equal( delivered[ 0 ].text, 'Count me in for 12 Dec ({{missing}})' );
} );

test( 'invitations that are no list of names add no invitation: an offsite_invite gets no answer', async () => {
	for ( const invitations of [ 'offsite_invite', { action: 'offsite_invite' }, [ 42, null ] ] ) {
		const _sent = [];
		const { sim, delivered } = await world( { invitations, people: [ person( [ { after: 0, text: 'Yes' } ] ) ] }, _sent );
		_sent.push( { id: 'm1', target: 'design', action: 'offsite_invite', params: {} } );
		await sim.look();
		await wait( 20 );
		sim.stop();
		assert.equal( delivered.length, 0, JSON.stringify( invitations ) );
	}
} );

test( 'what was in the inboxes before the start was answered before: only new invitations are answered', async () => {
	const _sent = [ { id: 'm0', target: 'design', action: 'invite', params: { round: 'FU-0' } } ];
	const { sim, delivered } = await world( { ...SURVEY, people: [ person( [ { after: 0, key: true, text: 'old' } ] ) ] }, _sent, { mission: 'survey' } );
	await sim.look();
	await wait( 20 );
	sim.stop();
	assert.equal( delivered.length, 0 );
} );
