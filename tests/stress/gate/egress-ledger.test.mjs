// Attacks on the ledger (Ausgangsbuch, 18.4): attempts with and without the service's guarantee, withdrawal racing
// an attempt (O9), expiry during retries (O2, O7, G-1b), and a crash at every step followed by recover() (O1, O4, O5).
import assert from 'node:assert/strict';
import { attack, attacks, random, within } from '../hostile.mjs';
import { gate, restart, settle, tick, invoiceSpec, reply, pay, people, actionsWith, MINUTE, START, FOREVER, Outbox } from './fixture.mjs';

const S = 'gate/egress.js';
const twelve = people( 12 );

// An approved and redeemed reply whose first attempt is booked but never answers: the gate "crashes" mid-send.
async function inFlight( options = {} ) {
	const g = gate( { sendMs: FOREVER, service: { silent: true }, ...options } );
	const _ok = await g.approved( reply( twelve ) );
	g.redeem( _ok );
	await tick();
	assert.equal( g.attempts( _ok.delivery ).length, 1 );
	return { g, ok: _ok };
}

attack( S, 'G-7a: without the service\'s guarantee a failed send is attempted exactly once and stays unclear', async () => {
	const g = gate( { plain: true, service: { failures: 1 } } );
	const _result = await g.redeem( await g.approved( reply( twelve ) ) );
	await tick( 10 );
	assert.equal( _result.status, 'unclear' );
	assert.equal( g.attempts( _result.delivery ).length, 1 );
	assert.equal( g.channel.sent.length, 1 );
} );

attack( S, 'O7: with the guarantee the gate repeats under the same idempotency key until the service confirms', async () => {
	const g = gate( { service: { failures: 3 } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	const _done = await settle( g, _first.delivery );
	assert.equal( _done.status, 'executed' );
	assert.deepEqual( g.attempts( _first.delivery ).map( item => item.nr ), [ 1, 2, 3, 4 ] );
	assert.ok( g.channel.sent.every( id => id === _first.delivery ), 'every attempt carries the same key' );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'O7: an operation that keeps failing ends unclear when it expires, and no attempt follows', async () => {
	const g = gate( { service: { failures: 1e9 } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	g.clock.now = START + 72 * 60 * MINUTE;
	const _done = await settle( g, _first.delivery );
	assert.equal( _done.status, 'unclear' );
	const _count = g.channel.sent.length;
	await tick( 20 );
	assert.equal( g.channel.sent.length, _count );
} );

attack( S, 'O2: the expiry is shortened to first attempt plus retention minus one hour, measured when the attempt begins', async () => {
	const g = gate( { actions: actionsWith( { reply: { ...actionsWith().table.reply, idempotencyH: 2 } } ), service: { failures: 1 } } );
	g.clock.now = START + 10 * 60 * MINUTE;
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	assert.equal( g.row( _first.delivery ).expiresAt, new Date( START + 11 * 60 * MINUTE ).toISOString() );
} );

attack( S, 'O2: a long retention never lengthens the expiry beyond the deadline plus buffer', async () => {
	const g = gate( { spec: invoiceSpec(), service: { failures: 1 } } );
	const _first = await g.redeem( await g.approved( pay( 'R-1187', 100 ) ) );
	assert.equal( g.row( _first.delivery ).expiresAt, '2026-11-07T17:05:00.000Z' );
} );

attack( S, 'G-1b: retries stop at the root deadline plus buffer, even when the service would keep the key longer', async () => {
	const g = gate( { spec: invoiceSpec(), service: { failures: 1e9 } } );
	const _first = await g.redeem( await g.approved( pay( 'R-1187', 100 ) ) );
	g.clock.now = Date.parse( '2026-11-07T17:05:00.001Z' );
	assert.equal( ( await settle( g, _first.delivery ) ).status, 'unclear' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'G-1b: an action approved before the end cannot be redeemed one millisecond after deadline plus buffer', async () => {
	const g = gate();
	g.clock.now = Date.parse( '2026-11-07T16:55:00Z' );
	const _ok = await g.approved( reply( twelve ) );
	g.clock.now = Date.parse( '2026-11-07T17:05:00.001Z' );
	const _late = await g.redeem( _ok );
	assert.equal( _late.status, 'refused' );
	assert.ok( _late.reasons.some( item => item.rule === 'expires' || /expired/.test( item.reason ) ) );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'O8: content and hash rewritten together between attempts still stop the next attempt (the token keeps the approved hash)', async () => {
	const g = gate( { service: { failures: 1 } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	assert.equal( _first.status, 'open' );
	g.db.run( 'UPDATE deliveries SET params = :p, actionHash = :h WHERE id = :id', {
		id: _first.delivery, p: JSON.stringify( { body: 'other' } ),
		h: g.egress.constructor.actionHash( { ...g.row( _first.delivery ), params: { body: 'other' } } ),
	} );
	assert.equal( ( await settle( g, _first.delivery ) ).status, 'unclear' );
	assert.equal( g.outbox().length, 0 );
	assert.equal( g.events( 'content_changed' ).length, 1 );
} );

attack( S, 'O9: a withdrawal before the first attempt ends the operation as not sent', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	const [ _withdrawn, _redeemed ] = await Promise.all( [ g.egress.withdraw( _ok.delivery ), g.redeem( _ok ) ] );
	assert.equal( _withdrawn.status, 'not_sent' );
	assert.equal( _redeemed.status, 'not_sent' );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'O9: a withdrawal during an attempt that then succeeds leaves the operation executed', async () => {
	const g = gate( { service: { hold: true } } );
	const _ok = await g.approved( reply( twelve ) );
	const _flying = g.redeem( _ok );
	await tick();
	assert.equal( g.egress.withdraw( _ok.delivery ).status, 'open', 'the attempt in flight decides' );
	g.channel.release( true );
	assert.equal( ( await _flying ).status, 'executed' );
	assert.equal( g.row( _ok.delivery ).withdrawn, true );
} );

attack( S, 'O9: a withdrawal during an attempt that then fails ends unclear even with the guarantee, and nothing follows', async () => {
	const g = gate( { service: { hold: true } } );
	const _ok = await g.approved( reply( twelve ) );
	const _flying = g.redeem( _ok );
	await tick();
	g.egress.withdraw( _ok.delivery );
	g.channel.release( false );
	assert.equal( ( await _flying ).status, 'unclear' );
	await tick( 10 );
	assert.equal( g.channel.sent.length, 1 );
} );

attack( S, 'O9: a withdrawal while a retry is scheduled ends unclear and the scheduled retry sends nothing', async () => {
	const g = gate( { retryMs: 10, service: { failures: 1 } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	assert.equal( _first.status, 'open' );
	assert.equal( g.egress.withdraw( _first.delivery ).status, 'unclear' );
	await tick( 25 );
	assert.equal( g.channel.sent.length, 1 );
	assert.equal( g.row( _first.delivery ).status, 'unclear' );
} );

attacks( S, [ 3, 17, 4242 ].map( seed => ( { name: `O9: withdrawal and attempt in a random order (seed ${seed}) never leave an open or doubled operation`, seed } ) ),
	async ( { seed } ) => {
		const _random = random( seed );
		const g = gate( { service: { hold: true } } );
		for ( let round = 0; round < 8; round++ ) {
			const _ok = await g.approved( reply( people( 12, round * 20 + 1 ) ) );
			const _flying = g.redeem( _ok );
			const _order = [ async () => g.egress.withdraw( _ok.delivery ), async () => g.channel.release( _random() < 0.5 ) ];
			if ( _random() < 0.5 ) { _order.reverse(); }
			for ( const step of _order ) {
				await tick( _random.int( 0, 1 ) );
				await step();
			}
			g.channel.release( true );
			await _flying;
			const _row = await settle( g, _ok.delivery );
			assert.ok( [ 'not_sent', 'executed', 'unclear' ].includes( _row.status ), _row.status );
			assert.ok( g.db.get( 'SELECT COUNT(*) AS n FROM outbox WHERE idempotencyKey = :id', { id: _ok.delivery } ).n <= 1 );
		}
	} );

attack( S, 'O9: withdrawing an unknown operation is a clean answer, not a crash', () => {
	const g = gate();
	const _result = g.egress.withdraw( 'dl-does-not-exist' );
	assert.equal( _result.status ?? null, null );
} );

attack( S, 'O9: withdrawing twice books one withdrawal', async () => {
	const g = gate();
	const _asked = await g.submit( reply( twelve ) );
	g.egress.withdraw( _asked.delivery );
	g.egress.withdraw( _asked.delivery );
	assert.equal( g.events( 'withdrawn' ).length, 1 );
	assert.equal( g.row( _asked.delivery ).status, 'not_sent' );
} );

attack( S, 'O1: a crash after the token was consumed but before any attempt: recovery sends exactly once', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	g.db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: _ok.approval } );
	g.db.run( 'UPDATE deliveries SET status = \'open\' WHERE id = :id', { id: _ok.delivery } );
	const _after = restart( g );
	await _after.egress.recover();
	await _after.egress.recover();
	assert.equal( _after.row( _ok.delivery ).status, 'executed' );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'O4, O5: a crash during an attempt without the guarantee: the world has nothing, so unclear and no second send', async () => {
	const { g, ok } = await inFlight( { plain: true } );
	const _after = restart( g, { plain: true } );
	const _unclear = await _after.egress.recover();
	assert.deepEqual( _unclear.map( item => item.id ), [ ok.delivery ] );
	assert.equal( _after.channel.sent.length, 0 );
} );

attack( S, 'O4: a crash after the send without the guarantee: the world has it, so executed and no second send', async () => {
	const { g, ok } = await inFlight( { plain: true } );
	await new Outbox( g.db ).send( g.row( ok.delivery ) );
	const _after = restart( g, { plain: true } );
	await _after.egress.recover();
	assert.equal( _after.row( ok.delivery ).status, 'executed' );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'O7: a crash during an attempt with the guarantee: recovery continues under the same key, one effect', async () => {
	const { g, ok } = await inFlight();
	const _after = restart( g );
	await _after.egress.recover();
	assert.equal( _after.row( ok.delivery ).status, 'executed' );
	assert.deepEqual( g.attempts( ok.delivery ).map( item => item.result ), [ 'failed', 'executed' ] );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'O9, O5: an operation withdrawn while its attempt was in flight is reconciled after a crash, never left open', async () => {
	const { g, ok } = await inFlight( { plain: true } );
	g.egress.withdraw( ok.delivery );
	const _after = restart( g, { plain: true } );
	await _after.egress.recover();
	assert.equal( _after.row( ok.delivery ).status, 'unclear' );
	assert.deepEqual( _after.egress.unclear().map( item => item.id ), [ ok.delivery ] );
} );

attack( S, 'O4: a lookup that throws for one operation does not stop the recovery of the others', async () => {
	const g = gate( { sendMs: FOREVER, plain: true, service: { silent: true } } );
	const _a = await g.approved( reply( twelve ) );
	const _b = await g.approved( reply( people( 12, 40 ) ) );
	g.redeem( _a );
	g.redeem( _b );
	await tick();
	const _after = restart( g, { plain: true, service: { lookup: ( delivery ) => {
		if ( delivery.id === _a.delivery ) { throw new Error( 'mailbox offline' ); }
		return Promise.resolve( null );
	} } } );
	await within( _after.egress.recover(), 300, 'recover()' ).catch( () => null );
	assert.equal( _after.row( _b.delivery ).status, 'unclear', 'the second operation is reconciled' );
	assert.equal( _after.row( _a.delivery ).status, 'unclear', 'a lookup that fails is "not clearly executed"' );
} );

attack( S, 'A2: a lookup that never answers does not hang the recovery', async () => {
	const { g, ok } = await inFlight( { plain: true } );
	const _after = restart( g, { plain: true, service: { lookup: () => new Promise( () => {} ) } } );
	await within( _after.egress.recover(), 300, 'recover()' );
	assert.equal( _after.row( ok.delivery ).status, 'unclear' );
} );

attack( S, 'O4: a lookup that rejects counts as "not found": unclear, never a repetition', async () => {
	const { g, ok } = await inFlight( { plain: true } );
	const _after = restart( g, { plain: true, service: { lookup: () => Promise.reject( new Error( 'down' ) ) } } );
	await _after.egress.recover();
	assert.equal( _after.row( ok.delivery ).status, 'unclear' );
	assert.equal( _after.channel.sent.length, 0 );
} );

attack( S, 'A8: a channel that answers undefined ends the attempt as unclear instead of crashing the redeem', async () => {
	const g = gate( { plain: true, service: { answer: () => undefined } } );
	const _ok = await g.approved( reply( twelve ) );
	const _result = await within( g.redeem( _ok ), 1000, 'redeem()' ).catch( error => ( { error } ) );
	assert.equal( _result.error, undefined, String( _result.error ) );
	assert.equal( g.row( _ok.delivery ).status, 'unclear' );
} );

attack( S, 'A8: a channel whose send throws synchronously is a failed attempt; without the guarantee it is unclear', async () => {
	const g = gate( { plain: true, service: { answer: () => {
		throw new Error( 'socket closed' );
	} } } );
	const _result = await g.redeem( await g.approved( reply( twelve ) ) );
	assert.equal( _result.status, 'unclear' );
	assert.equal( g.attempts( _result.delivery )[ 0 ].result, 'unclear' );
} );

attack( S, 'A2: a silent service with the guarantee is retried after each timeout and ends unclear at expiry, never executed', async () => {
	const g = gate( { sendMs: 3, service: { silent: true } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	assert.equal( _first.status, 'open' );
	await tick( 15 );
	g.clock.now = START + 80 * 60 * MINUTE;
	assert.equal( ( await settle( g, _first.delivery ) ).status, 'unclear' );
	assert.ok( g.attempts( _first.delivery ).length >= 2 );
} );

attack( S, 'G-7a, G-7b: two recoveries at the same time never send twice', async () => {
	const g = gate();
	const _ok = await g.approved( reply( twelve ) );
	g.db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: _ok.approval } );
	g.db.run( 'UPDATE deliveries SET status = \'open\' WHERE id = :id', { id: _ok.delivery } );
	const _after = restart( g );
	await Promise.all( [ _after.egress.recover(), _after.egress.recover() ] );
	assert.equal( _after.row( _ok.delivery ).status, 'executed' );
	assert.equal( g.outbox().length, 1 );
} );

attack( S, 'O1: a crash between booking the request and asking the person leaves no action that nobody can approve', async () => {
	const g = gate( { spec: invoiceSpec() } );
	g.egress._requestApproval = () => {
		throw new Error( 'the gate stopped here' );
	};
	await assert.rejects( g.submit( pay( 'R-1187', 300 ) ) );
	const _after = restart( g );
	await _after.egress.recover();
	const _orphans = g.db.all( `SELECT id FROM deliveries d WHERE status = 'awaiting_approval'
		AND NOT EXISTS ( SELECT 1 FROM approvals a WHERE a.delivery = d.id AND a.status = 'pending' )` );
	assert.deepEqual( _orphans, [], 'every waiting action has a pending approval' );
} );

attack( S, 'F3: an approval nobody decided before it expired no longer blocks the invoice for a new request', async () => {
	const g = gate( { spec: invoiceSpec(), approvalMinutes: 30 } );
	await g.submit( pay( 'R-1187', 300 ) );
	g.clock.now += 31 * MINUTE;
	const _again = await g.submit( pay( 'R-1187', 300 ) );
	assert.equal( _again.status, 'awaiting_approval' );
	assert.equal( g.egress.pendingApprovals().length, 1, 'the expired approval is not shown as pending' );
} );

attack( S, 'ledger ordering: attempts are numbered without gaps and every begun attempt is followed by its result', async () => {
	const g = gate( { service: { failures: 2 } } );
	const _first = await g.redeem( await g.approved( reply( twelve ) ) );
	await settle( g, _first.delivery );
	const _kinds = g.db.all( 'SELECT kind, data FROM events ORDER BY id' ).map( row => [ row.kind, JSON.parse( row.data ) ] )
		.filter( ( [ , data ] ) => data.delivery === _first.delivery && data.nr ).map( ( [ kind, data ] ) => `${kind}:${data.nr}` );
	assert.deepEqual( _kinds, [ 'attempt_begun:1', 'attempt_failed:1', 'attempt_begun:2', 'attempt_failed:2', 'attempt_begun:3', 'executed:3' ] );
} );

attack( S, 'ledger ordering: unclear() lists operations in the order they were requested', async () => {
	const g = gate( { plain: true, service: { failures: 10 } } );
	const _ids = [];
	for ( let i = 0; i < 4; i++ ) {
		g.clock.now = START + ( 4 - i ) * MINUTE;
		_ids.push( ( await g.redeem( await g.approved( reply( people( 12, i * 20 + 1 ) ) ) ) ).delivery );
	}
	assert.deepEqual( g.egress.unclear().map( item => item.id ), [ ..._ids ].reverse() );
} );
