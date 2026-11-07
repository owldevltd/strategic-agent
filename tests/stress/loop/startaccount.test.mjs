// Stress tests of the start account (R1, 17.1): the root has B tokens; every start of a round, a child, a new case or a
// proposal burns one, atomically with its start event and irrevocably, also across a restart. Attacks: exhaustion,
// throwing and nested starts, rollbacks, two connections to one file, hostile roots and totals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { StartAccount, Db, EventLog } from './kit.mjs';

const R1 = 'core/budget/startaccount.js';

function account( total = 3, root = 'root' ) {
	const _db = new Db( ':memory:' );
	const _account = new StartAccount( _db );
	if ( total !== null ) { _account.open( root, total ); }
	return { account: _account, db: _db };
}

// Burns until the account refuses or the limit is reached; → the number of starts.
function drain( _account, root = 'root', limit = 50 ) {
	let _starts = 0;
	while ( _starts < limit && _account.burn( root, () => 'started' ) ) {
		_starts++;
	}
	return _starts;
}

attack( R1, 'an opened account has exactly B tokens', () => {
	assert.equal( account( 5 ).account.left( 'root' ), 5 );
} );

attack( R1, 'a burn takes one token and returns what the start returned', () => {
	const { account: _account } = account( 2 );
	assert.deepEqual( _account.burn( 'root', () => ( { event: 1 } ) ), { event: 1 } );
	assert.equal( _account.left( 'root' ), 1 );
} );

attack( R1, 'a start that returns nothing still counts as started', () => {
	const { account: _account } = account( 5 );
	for ( const value of [ undefined, null, 0, '', false ] ) {
		assert.equal( _account.burn( 'root', () => value ), true, `start returned ${JSON.stringify( value )}` );
	}
	assert.equal( _account.left( 'root' ), 0 );
} );

attack( R1, 'B tokens allow exactly B starts in the whole tree (17.1)', () => {
	const { account: _account } = account( 7 );
	assert.equal( drain( _account ), 7 );
} );

attack( R1, 'an exhausted account refuses without calling the start: no start event without a token', () => {
	const { account: _account } = account( 1 );
	drain( _account );
	let _called = false;
	assert.equal( _account.burn( 'root', () => {
		_called = true;
	} ), null );
	assert.equal( _called, false );
} );

attack( R1, 'an exhausted account stays at zero, never below, however often it is asked', () => {
	const { account: _account } = account( 2 );
	drain( _account, 'root', 100 );
	assert.equal( _account.left( 'root' ), 0 );
} );

attack( R1, 'opening the account again after a restart neither refills nor resets it', () => {
	const { account: _account, db } = account( 3 );
	drain( _account, 'root', 2 );
	const _restarted = new StartAccount( db );
	_restarted.open( 'root', 3 );
	assert.equal( _restarted.left( 'root' ), 1 );
} );

attack( R1, 'opening the account again with a larger total never adds tokens', () => {
	const { account: _account } = account( 2 );
	drain( _account );
	_account.open( 'root', 1000 );
	assert.equal( _account.left( 'root' ), 0 );
	assert.equal( _account.burn( 'root', () => 1 ), null );
} );

attack( R1, 'an unknown root has no tokens and starts nothing', () => {
	const { account: _account } = account( null );
	let _called = false;
	assert.equal( _account.left( 'nobody' ), 0 );
	assert.equal( _account.burn( 'nobody', () => {
		_called = true;
	} ), null );
	assert.equal( _called, false );
} );

attack( R1, 'a start that throws burns no token and the error reaches the caller', () => {
	const { account: _account } = account( 2 );
	assert.throws( () => _account.burn( 'root', () => {
		throw new Error( 'start failed' );
	} ), /start failed/ );
	assert.equal( _account.left( 'root' ), 2 );
} );

attack( R1, 'the start event and the burn are one transaction: a start that throws after its event leaves neither', () => {
	const { account: _account, db } = account( 2 );
	const _log = new EventLog( db, 'core' );
	assert.throws( () => _account.burn( 'root', () => {
		_log.append( 'plan_accepted', { strategy: 's' } );
		throw new Error( 'crash between event and return' );
	} ) );
	assert.equal( _log.since( 0 ).length, 0, 'no start event without its token' );
	assert.equal( _account.left( 'root' ), 2 );
} );

attack( R1, 'a start event written in the burn is there as soon as the burn returns', () => {
	const { account: _account, db } = account( 1 );
	const _log = new EventLog( db, 'core' );
	_account.burn( 'root', () => _log.append( 'child_started', { child: 'c1' } ) );
	assert.deepEqual( _log.since( 0 ).map( event => event.kind ), [ 'child_started' ] );
	assert.equal( _account.left( 'root' ), 0 );
} );

attack( R1, 'a start nested in another start burns its own token in the same transaction', () => {
	const { account: _account } = account( 3 );
	const _inner = _account.burn( 'root', () => _account.burn( 'root', () => 'inner' ) );
	assert.equal( _inner, 'inner' );
	assert.equal( _account.left( 'root' ), 1 );
} );

attack( R1, 'a nested start finds the token its outer start already took', () => {
	const { account: _account } = account( 1 );
	const _inner = _account.burn( 'root', () => _account.burn( 'root', () => 'inner' ) );
	assert.equal( _inner, true, 'the outer start went ahead, the inner one was refused' );
	assert.equal( _account.left( 'root' ), 0 );
} );

attack( R1, 'an inner start that throws takes the outer burn with it', () => {
	const { account: _account } = account( 3 );
	assert.throws( () => _account.burn( 'root', () => _account.burn( 'root', () => {
		throw new Error( 'inner' );
	} ) ) );
	assert.equal( _account.left( 'root' ), 3 );
} );

attack( R1, 'two connections to one database file never burn more than B tokens between them', () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-r1-' ) );
	try {
		const _file = path.join( _dir, 'core.db' );
		const _one = new StartAccount( new Db( _file ) );
		const _two = new StartAccount( new Db( _file ) );
		_one.open( 'root', 5 );
		_two.open( 'root', 99 );
		let _starts = 0;
		for ( let i = 0; i < 20; i++ ) {
			_starts += ( i % 2 ? _one : _two ).burn( 'root', () => 1 ) ? 1 : 0;
		}
		assert.equal( _starts, 5 );
		assert.equal( _two.left( 'root' ), 0 );
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( R1, 'a file database keeps the burnt tokens across a restart of the core', () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-r1-' ) );
	try {
		const _file = path.join( _dir, 'core.db' );
		const _db = new Db( _file );
		const _before = new StartAccount( _db );
		_before.open( 'root', 4 );
		drain( _before, 'root', 3 );
		_db.close();
		const _after = new StartAccount( new Db( _file ) );
		_after.open( 'root', 4 );
		assert.equal( _after.left( 'root' ), 1 );
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( R1, 'fifty starts at once on ten tokens: exactly ten go ahead', async () => {
	const { account: _account } = account( 10 );
	const _results = await Promise.all( Array.from( { length: 50 }, async ( _item, i ) => {
		await new Promise( resolve => setImmediate( resolve ) );
		return _account.burn( 'root', () => i );
	} ) );
	assert.equal( _results.filter( item => item !== null ).length, 10 );
} );

attack( R1, 'a thousand tokens allow a thousand starts and not one more', () => {
	const { account: _account } = account( 1000 );
	assert.equal( drain( _account, 'root', 2000 ), 1000 );
} );

attack( R1, 'the accounts of two roots are independent', () => {
	const { account: _account } = account( 2, 'a' );
	_account.open( 'b', 3 );
	drain( _account, 'a' );
	assert.equal( _account.left( 'a' ), 0 );
	assert.equal( _account.left( 'b' ), 3 );
} );

attack( R1, 'a start that returns a promise burns its token at once; a later rejection never gives it back', async () => {
	const { account: _account } = account( 1 );
	const _pending = _account.burn( 'root', () => Promise.reject( new Error( 'late failure' ) ) );
	await assert.rejects( _pending, /late failure/ );
	assert.equal( _account.left( 'root' ), 0, 'irrevocable (R1)' );
} );

attack( R1, 'a closed database refuses the burn with an error instead of starting without a token', () => {
	const { account: _account, db } = account( 3 );
	db.close();
	let _called = false;
	assert.throws( () => _account.burn( 'root', () => {
		_called = true;
	} ) );
	assert.equal( _called, false );
} );

attack( R1, 'fuzz: burns on random roots never exceed each root\'s total (seed 5)', () => {
	const _rand = random( 5 );
	const { account: _account } = account( null );
	const _totals = { r0: 3, r1: 0, r2: 7, r3: 1 };
	Object.entries( _totals ).forEach( ( [ root, total ] ) => _account.open( root, total ) );
	const _starts = { r0: 0, r1: 0, r2: 0, r3: 0 };
	for ( let i = 0; i < 300; i++ ) {
		const _root = _rand.pick( Object.keys( _totals ) );
		if ( _account.burn( _root, () => 1 ) ) { _starts[ _root ]++; }
	}
	assert.deepEqual( _starts, _totals );
} );

attacks( R1, [ ...hostile( 'keys' ), ...hostile( 'strings' ).slice( 18, 26 ) ].map( item => ( {
	...item, name: `a hostile root id ${item.label} keeps its own account and touches no other`,
} ) ), ( item ) => {
	const { account: _account, db } = account( 2, 'neighbour' );
	_account.open( item.value, 1 );
	assert.equal( drain( _account, item.value ), 1 );
	assert.equal( _account.left( 'neighbour' ), 2 );
	assert.equal( db.get( 'SELECT COUNT(*) AS n FROM start_accounts' ).n, 2, 'the table is intact' );
} );

attacks( R1, [
	{ name: 'a total of zero allows no start', total: 0, starts: 0 },
	{ name: 'a negative total allows no start', total: -1, starts: 0 },
	{ name: 'a total of -Infinity allows no start', total: -Infinity, starts: 0 },
	{ name: 'a NaN total opens no account and allows no start', total: NaN, starts: 0 },
	{ name: 'a null total opens no account and allows no start', total: null, starts: 0 },
	{ name: 'a numeric string total counts as its number', total: '3', starts: 3 },
	{ name: 'a fractional total of 1.5 allows at most one start', total: 1.5, starts: 1 },
	{ name: 'a non-numeric total allows no start', total: 'abc', starts: 0 },
], ( item ) => {
	const _account = new StartAccount( new Db( ':memory:' ) );
	_account.open( 'root', item.total );
	assert.equal( drain( _account, 'root', 20 ), item.starts );
	assert.ok( !( _account.left( 'root' ) > 0 ), `left ${_account.left( 'root' )} after every start was used` );
} );

attack( R1, 'an undefined total is refused at opening instead of opening an account without tokens', () => {
	const _account = new StartAccount( new Db( ':memory:' ) );
	assert.throws( () => _account.open( 'root', undefined ) );
	assert.equal( _account.left( 'root' ), 0 );
} );

attack( R1, 'left and burn agree: whenever left is above zero a burn succeeds, at zero it fails', () => {
	const { account: _account } = account( 4 );
	while ( _account.left( 'root' ) > 0 ) {
		assert.notEqual( _account.burn( 'root', () => 1 ), null );
	}
	assert.equal( _account.burn( 'root', () => 1 ), null );
} );

attack( R1, 'the table is created once; a second account on the same database shares it', () => {
	const { db } = account( 2 );
	const _second = new StartAccount( db );
	assert.equal( _second.left( 'root' ), 2 );
} );

attack( R1, 'a burn refused for want of tokens leaves the database without an open transaction', () => {
	const { account: _account, db } = account( 0 );
	_account.burn( 'root', () => 1 );
	assert.equal( db._depth, 0 );
	db.exec( 'BEGIN IMMEDIATE' );
	db.exec( 'ROLLBACK' );
} );

attack( R1, 'every burn runs its start exactly once', () => {
	const { account: _account } = account( 3 );
	let _calls = 0;
	drain( { burn: ( root, start ) => _account.burn( root, () => {
		_calls++;
		return start();
	} ) } );
	assert.equal( _calls, 3 );
} );

attack( R1, 'a burn inside a larger transaction that rolls back leaves neither the token used nor the start event', () => {
	const { account: _account, db } = account( 2 );
	const _log = new EventLog( db, 'core' );
	assert.throws( () => db.transaction( () => {
		_account.burn( 'root', () => _log.append( 'child_started', {} ) );
		throw new Error( 'the surrounding step failed' );
	} ) );
	assert.equal( _account.left( 'root' ), 2 );
	assert.equal( _log.since( 0 ).length, 0 );
} );

attack( R1, 'an account whose row is gone starts nothing', () => {
	const { account: _account, db } = account( 5 );
	db.run( 'DELETE FROM start_accounts WHERE root = :root', { root: 'root' } );
	assert.equal( _account.burn( 'root', () => 1 ), null );
	assert.equal( _account.left( 'root' ), 0 );
} );
