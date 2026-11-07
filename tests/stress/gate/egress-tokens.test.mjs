// Attacks on the approval token (F1–F5, O1, A6): forged, replayed, foreign, expired and raced tokens, tokens
// presented under the wrong lease, and stored actions changed after a person approved them.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { gate, invoiceSpec, surveySpec, reply, pay, people, actionsWith, MINUTE, START, Hash } from './fixture.mjs';

const S = 'gate/egress.js';
const twelve = people( 12 );

attack( S, 'F2: the token of one action presented for another action is refused and sends nothing', async () => {
	const g = gate();
	const _a = await g.approved( reply( twelve ) );
	const _b = await g.approved( reply( people( 12, 20 ) ) );
	const _swapped = await g.redeem( { delivery: _b.delivery, approval: _a.approval } );
	assert.equal( _swapped.status, 'refused' );
	assert.ok( _swapped.reasons.some( item => item.rule === 'token' ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F2: two identical actions get two tokens; neither token works for the other although the hashes are equal', async () => {
	const g = gate();
	const _a = await g.approved( reply( twelve ) );
	const _b = await g.approved( reply( twelve ) );
	assert.equal( g.row( _a.delivery ).actionHash, g.row( _b.delivery ).actionHash );
	const _cross = await g.redeem( { delivery: _a.delivery, approval: _b.approval } );
	assert.equal( _cross.status, 'refused' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F2: a replayed token after execution is refused and the world sees one message', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	assert.equal( ( await g.redeem( _ok ) ).status, 'executed' );
	await g.redeem( _ok );
	await g.redeem( _ok );
	assert.equal( g.outbox().length, 1 );
	assert.equal( g.approval( _ok.approval ).status, 'consumed' );
	assert.equal( g.events( 'redeem_refused' ).length, 2 );
} );

attack( S, 'F2: the same token redeemed ten times at once opens exactly one operation', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _all = await Promise.all( Array.from( { length: 10 }, () => g.redeem( _ok ) ) );
	assert.equal( g.outbox().length, 1 );
	assert.equal( g.attempts( _ok.delivery ).length, 1 );
	assert.equal( g.events( 'token_consumed' ).length, 1 );
	assert.ok( _all.every( item => [ 'open', 'executed' ].includes( item.status ) ), 'every caller sees the one operation, none a second one' );
	assert.equal( g.row( _ok.delivery ).status, 'executed' );
} );

attack( S, 'F2: a forged approval id is refused; the waiting action is closed so the forgery cannot be retried silently', async () => {
	const g = gate();
	const _asked = await g.submit( reply( twelve ) );
	const _forged = await g.redeem( { delivery: _asked.delivery, approval: Hash.id( 'ap' ) } );
	assert.equal( _forged.status, 'refused' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F2: a refused redeem must not leave the pending approval behind, so a person cannot revive a refused action', async () => {
	const g = gate();
	const _asked = await g.submit( reply( twelve ) );
	await g.redeem( { delivery: _asked.delivery, approval: 'ap-forged' } );
	assert.equal( g.row( _asked.delivery ).status, 'refused' );
	assert.equal( g.egress.pendingApprovals().length, 0, 'the approval of a refused action is no longer pending' );
	await assert.rejects( g.approve( _asked ), /no pending approval/ );
	assert.equal( g.row( _asked.delivery ).status, 'refused' );
} );

attack( S, 'F2: the token of a rejected approval opens nothing', async () => {
	const g = gate();
	const _asked = await g.submit( reply( twelve ) );
	await g.egress.decide( _asked.approval, 'reject', 'person' );
	const _late = await g.redeem( _asked );
	assert.equal( _late.status, 'rejected' );
	assert.equal( g.outbox().length, 0 );
} );

attacks( S, [ 'APPROVE', 'approved', 'yes', ' approve', 'approve ' ].map( decision => ( { name: `5.3: the decision ${JSON.stringify( decision )} is no approval`, decision } ) ),
	async ( { decision } ) => {
		const g = gate();
		const _asked = await g.submit( reply( twelve ) );
		const _decided = await g.egress.decide( _asked.approval, decision, 'person' );
		assert.notEqual( _decided.status, 'approved' );
		assert.equal( ( await g.redeem( _asked ) ).status !== 'executed', true );
		assert.equal( g.outbox().length, 0 );
	} );

attacks( S, [
	{ name: '5.3: a money approval with reason null is refused', reason: null },
	{ name: '5.3: a money approval with an object as reason is refused', reason: {} },
	{ name: '5.3: a money approval with only whitespace as reason is refused', reason: ' \t\n ' },
	{ name: '5.3: a money approval with an empty array as reason is refused', reason: [] },
	{ name: '5.3: a money approval without a reason is refused', reason: undefined },
], async ( { reason } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _asked = await g.submit( pay( 'R-1187' ) );
	await assert.rejects( g.egress.decide( _asked.approval, 'approve', 'person', { reason } ), /needs a reason/ );
	assert.equal( g.approval( _asked.approval ).status, 'pending' );
} );

attack( S, '5.3: an irreversible action needs explicit === true; the string "true" is no confirmation', async () => {
	const _actions = actionsWith( { erase: { criticality: 'irreversible', carries: [ 'message' ], sensitive: [], idempotencyH: 72 } } );
	const g = gate( { actions: _actions } );
	const _asked = await g.submit( { action: 'erase', target: 'archive', params: { what: 'old mails' }, labels: {} } );
	assert.equal( _asked.status, 'awaiting_approval' );
	await assert.rejects( g.egress.decide( _asked.approval, 'approve', 'person', { explicit: 'true' } ), /explicit confirmation/ );
	await assert.rejects( g.egress.decide( _asked.approval, 'approve', 'person', { explicit: 1 } ), /explicit confirmation/ );
	assert.equal( ( await g.egress.decide( _asked.approval, 'approve', 'person', { explicit: true } ) ).status, 'approved' );
} );

attack( S, 'a decision raced against itself issues one token: the second decide finds nothing pending', async () => {
	const g = gate();
	const _asked = await g.submit( reply( twelve ) );
	const _both = await Promise.allSettled( [ g.approve( _asked ), g.egress.decide( _asked.approval, 'reject', 'other person' ) ] );
	assert.deepEqual( _both.map( item => item.status ), [ 'fulfilled', 'rejected' ] );
	assert.equal( g.approval( _asked.approval ).decidedBy, 'person' );
} );

attack( S, 'A6: a token presented under a stale fencing token is refused and voided; nothing leaves', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _old = g.lease( 'worker-x' );
	g.lease( 'worker-x' );
	const _late = await g.redeem( _ok, _old );
	assert.ok( _late.reasons.some( item => item.rule === 'lease' ) );
	assert.equal( g.approval( _ok.approval ).status, 'void' );
	assert.equal( ( await g.redeem( _ok ) ).status, 'refused', 'a void token stays void under a fresh lease' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'A6: a token presented under a released lease is refused', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _lease = g.lease( 'worker-y' );
	assert.deepEqual( g.egress.leases.release( _lease.id, _lease.fence ), { ok: true } );
	assert.ok( ( await g.redeem( _ok, _lease ) ).reasons.some( item => item.rule === 'lease' ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'A6: a token presented without any lease is refused', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _none = await g.egress.redeem( { delivery: _ok.delivery, approval: _ok.approval } );
	assert.ok( _none.reasons.some( item => item.rule === 'lease' ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'A6: a lease granted for another contract does not carry a token of this contract', async () => {
	const g = gate();
	const _other = g.child( surveySpec( { id: 'other-goal', goal: 'Something else entirely' } ) );
	g.egress.confirm( _other.contract.hash, 'person' );
	const _ok = await g.approved( reply( twelve ) );
	const _foreign = g.lease( 'worker-z', 5, _other.contract.hash );
	const _result = await g.redeem( _ok, _foreign );
	assert.equal( _result.status, 'refused' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'A4: a worker whose lease ran out cannot redeem even though the token is still valid', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _lease = g.lease( 'worker-a', 2 );
	g.clock.now += 2 * MINUTE + 1;
	assert.ok( ( await g.redeem( _ok, _lease ) ).reasons.some( item => item.rule === 'lease' ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F3: a token is refused one millisecond after its expiry and accepted one millisecond before', async () => {
	const g = gate( { approvalMinutes: 30 } );
	const _late = await g.approved( reply( twelve ) );
	const _early = await g.approved( reply( people( 12, 30 ) ) );
	const _expires = Date.parse( g.approval( _late.approval ).expiresAt );
	assert.equal( _expires, START + 30 * MINUTE );
	g.clock.now = _expires - 1;
	assert.equal( ( await g.redeem( _early ) ).status, 'executed' );
	g.clock.now = _expires + 1;
	const _refused = await g.redeem( _late );
	assert.ok( _refused.reasons.some( item => /expired/.test( item.reason ) ) );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'F3: a person deciding after the request expired cannot issue a token', async () => {
	const g = gate( { approvalMinutes: 10 } );
	const _asked = await g.submit( reply( twelve ) );
	g.clock.now += 10 * MINUTE + 1;
	const _decided = await g.approve( _asked );
	assert.equal( _decided.status, 'rejected' );
	assert.equal( g.approval( _asked.approval ).status, 'expired' );
	assert.equal( ( await g.redeem( _asked ) ).status, 'rejected' );
} );

attack( S, 'A7: an approval never outlives the deadline plus the buffer, however long approvals last', async () => {
	const g = gate( { approvalMinutes: 60 * 24 * 365 } );
	const _asked = await g.submit( reply( twelve ) );
	assert.equal( g.approval( _asked.approval ).expiresAt, '2026-11-07T17:05:00.000Z' );
} );

attack( S, 'F4, F5: changing the stored text after approval voids the token', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	g.db.run( 'UPDATE deliveries SET params = :p WHERE id = :id', { id: _ok.delivery, p: JSON.stringify( { body: 'Send me the price list' } ) } );
	const _result = await g.redeem( _ok );
	assert.ok( _result.reasons.some( item => item.rule === 'hash' ) );
	assert.equal( g.approval( _ok.approval ).status, 'void' );
	assert.equal( g.outbox().length, 0 );
} );

attacks( S, [
	{ name: 'F5: changing the stored recipient after approval voids the token', column: 'target', value: 'competitor' },
	{ name: 'F5: changing the stored action after approval voids the token', column: 'action', value: 'report' },
	{ name: 'F5: moving the stored action to another confirmed contract after approval voids the token', column: 'contract', value: null },
], async ( { column, value } ) => {
	const g = gate();
	const _other = g.child( surveySpec( { id: 'laxer', goal: 'Tell the CEO anything', criteria: [] } ) );
	g.egress.confirm( _other.contract.hash, 'person' );
	const _ok = await g.approved( reply( twelve ) );
	g.db.run( `UPDATE deliveries SET ${column} = :value WHERE id = :id`, { id: _ok.delivery, value: value ?? _other.contract.hash } );
	const _result = await g.redeem( _ok );
	assert.notEqual( _result.status, 'executed' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F4: rewriting the stored hash together with the text does not help; the token keeps the approved hash', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const _row = g.row( _ok.delivery );
	const _params = { body: 'Transfer the bonus to me' };
	g.db.run( 'UPDATE deliveries SET params = :p, actionHash = :h WHERE id = :id', {
		id: _ok.delivery, p: JSON.stringify( _params ),
		h: Hash.sha256( { contract: _row.contract, action: _row.action, target: _row.target, params: _params } ),
	} );
	assert.ok( ( await g.redeem( _ok ) ).reasons.some( item => item.rule === 'hash' ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F1: the same parameters stored in another key order are the same action and keep the token', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _ok = await g.approved( pay( 'R-1187', 900 ) );
	g.db.run( 'UPDATE deliveries SET params = :p WHERE id = :id', {
		id: _ok.delivery, p: JSON.stringify( { amount: 900, iban: g.row( _ok.delivery ).params.iban, invoiceId: 'R-1187' } ),
	} );
	assert.equal( ( await g.redeem( _ok ) ).status, 'executed' );
} );

attacks( S, [
	// A message about nobody: a release to a recipient that is no listed one is refused before (pentest B, recipient).
	{ name: 'F1: a request with an empty recipient can be redeemed once approved', request: { ...reply( twelve ), target: '', cohort: null } },
	{ name: 'F1: a request with params null can be redeemed once approved', request: { ...reply( twelve ), params: null } },
	{ name: 'F1: a request with a numeric recipient 0 can be redeemed once approved', request: { ...reply( twelve ), target: 0, cohort: null } },
], async ( { request } ) => {
	const g = gate();
	const _ok = await g.approved( request );
	assert.equal( _ok.status, 'approved' );
	assert.equal( ( await g.redeem( _ok ) ).status, 'executed', 'an approved action whose stored row differs only by normalisation is still the approved action' );
} );

attack( S, 'O1: "the same without Anna" is refused while the full group may still go out, and again after it went out', async () => {
	const g = gate();
	const _full = await g.approved( reply( twelve ) );
	// The full group is approved and may still leave: a release that differs by one person is refused at once.
	const _while = await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) );
	assert.equal( _while.status, 'refused' );
	assert.match( _while.reasons.map( item => item.reason ).join(), /differs from an earlier release by 1 person/ );
	assert.equal( ( await g.redeem( _full ) ).status, 'executed' );
	const _after = await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) );
	assert.equal( _after.status, 'refused' );
	assert.equal( g.outbox().length, 1 );
} );

// An approved release already counts at submit, so the second one is never approved; while the first is in flight
// (open, not yet executed) it still counts, so "the same without Anna" cannot slip out next to it.
attack( S, 'O1: two releases that differ by one person never both leave, not even while the first is in flight', async () => {
	const g = gate( { service: { hold: true }, sendMs: 60000 } );
	const _full = await g.approved( reply( twelve ) );
	assert.equal( ( await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) ) ).status, 'refused', 'the full group is approved' );
	const _flying = g.redeem( _full );
	await new Promise( resolve => setImmediate( resolve ) );
	assert.equal( g.row( _full.delivery ).status, 'open' );
	assert.equal( ( await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) ) ).status, 'refused', 'the full group is in flight' );
	g.channel.release( true );
	assert.equal( ( await _flying ).status, 'executed' );
	assert.equal( g.outbox().length, 1, 'the second release would give Anna away' );
} );

attack( S, 'F2: withdrawing between approval and redeem voids the token', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	assert.equal( g.egress.withdraw( _ok.delivery ).status, 'not_sent' );
	assert.equal( g.approval( _ok.approval ).status, 'withdrawn' );
	assert.equal( ( await g.redeem( _ok ) ).status, 'not_sent' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'F2: redeeming an unknown delivery is a clean refusal, not a crash', async () => {
	const g = gate();
	const _lease = g.lease();
	const _result = await g.egress.redeem( { delivery: 'dl-unknown', approval: 'ap-unknown', lease: _lease.id, fence: _lease.fence } );
	assert.equal( _result.status, 'refused' );
} );

attack( S, 'F2: a void token stays void; the person cannot approve the refused action a second time', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	await g.redeem( _ok, { id: 'ls-none', fence: 1 } );
	await assert.rejects( g.approve( _ok ), /no pending approval/ );
	assert.equal( g.row( _ok.delivery ).status, 'refused' );
} );
