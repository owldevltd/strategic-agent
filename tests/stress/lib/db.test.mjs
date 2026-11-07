// lib/db.js under attack, part 1: files, transactions and their nesting, rollback, persistence after reopen, and
// several connections on one file. The gate's bookings (O1, O8, O9) and the start account (R1) rely on these.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, random } from '../hostile.mjs';
import { agency, tempDir, childAsync, quiet } from './tools.mjs';

const [ Db ] = await agency.use( [ 'Lib.Db' ] );
const S = 'lib/db.js';

const memory = () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	return _db;
};
const count = db => db.get( 'SELECT COUNT(*) AS n FROM t' ).n;
const file = ( name = 'test.db' ) => path.join( tempDir( 'db' ), name );

attack( S, 'a file in folders that do not exist yet: the folders are made', () => {
	const _file = path.join( tempDir( 'db' ), 'a', 'b', 'c', 'deep.db' );
	const _db = new Db( _file );
	_db.close();
	assert.ok( fs.existsSync( _file ) );
} );

attack( S, 'a file database runs in WAL mode with foreign keys on and a busy timeout', () => {
	const _db = new Db( file() );
	assert.equal( _db.get( 'PRAGMA journal_mode' ).journal_mode, 'wal' );
	assert.equal( _db.get( 'PRAGMA foreign_keys' ).foreign_keys, 1 );
	assert.equal( _db.get( 'PRAGMA busy_timeout' ).timeout, 5000 );
	_db.close();
} );

attack( S, 'foreign keys are enforced: a row pointing nowhere is refused', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE p ( id TEXT PRIMARY KEY ); CREATE TABLE c ( p TEXT REFERENCES p( id ) )' );
	assert.throws( () => _db.run( 'INSERT INTO c ( p ) VALUES ( :p )', { p: 'nobody' } ), /FOREIGN KEY/ );
} );

attack( S, 'an in-memory database leaves no file behind', () => {
	const _dir = tempDir( 'db' );
	const _cwd = process.cwd();
	process.chdir( _dir );
	try {
		new Db( ':memory:' ).close();
		assert.deepEqual( fs.readdirSync( _dir ), [] );
	} finally {
		process.chdir( _cwd );
	}
} );

attack( S, 'a path whose parent is a file is refused with an error', () => {
	const _dir = tempDir( 'db' );
	fs.writeFileSync( path.join( _dir, 'plain' ), 'x' );
	assert.throws( () => new Db( path.join( _dir, 'plain', 'x.db' ) ), /ENOTDIR|EEXIST|not a directory/ );
} );

attack( S, 'a path that is a folder is refused with an error', () => {
	assert.throws( () => new Db( tempDir( 'db' ) ), Error );
} );

attack( S, 'a file that is not a database is refused when first used', () => {
	const _file = file();
	fs.writeFileSync( _file, 'this is not sqlite '.repeat( 100 ) );
	assert.throws( () => new Db( _file ), /not a database|file is not/ );
} );

attack( S, 'no file name at all is refused with a TypeError, not a database somewhere', () => {
	assert.throws( () => new Db( undefined ), TypeError );
	assert.throws( () => new Db( null ), TypeError );
} );

attack( S, 'committed rows survive close and reopen', () => {
	const _file = file();
	const _db = new Db( _file );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	_db.transaction( () => { for ( let i = 0; i < 100; i++ ) { _db.run( 'INSERT INTO t ( x ) VALUES ( :i )', { i } ); } } );
	_db.close();
	const _again = new Db( _file );
	assert.equal( count( _again ), 100 );
	assert.equal( _again.get( 'SELECT SUM( x ) AS s FROM t' ).s, 4950 );
	_again.close();
} );

attack( S, 'a rolled-back transaction leaves no trace after reopen', () => {
	const _file = file();
	const _db = new Db( _file );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	assert.throws( () => _db.transaction( () => {
		_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
		throw new Error( 'stop' );
	} ), /stop/ );
	_db.close();
	const _again = new Db( _file );
	assert.equal( count( _again ), 0 );
	_again.close();
} );

attack( S, 'rows written without a transaction survive a reopen too (autocommit)', () => {
	const _file = file();
	const _db = new Db( _file );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	_db.run( 'INSERT INTO t ( x ) VALUES ( 7 )' );
	_db.close();
	const _again = new Db( _file );
	assert.equal( _again.get( 'SELECT x FROM t' ).x, 7 );
	_again.close();
} );

attack( S, 'transaction() returns what fn returns', () => {
	const _db = memory();
	assert.deepEqual( _db.transaction( () => ( { ok: 1 } ) ), { ok: 1 } );
	assert.equal( _db.transaction( () => undefined ), undefined );
	assert.equal( _db.transaction( () => _db.transaction( () => 42 ) ), 42 );
} );

attack( S, 'transaction() rethrows the very same error object', () => {
	const _db = memory();
	const _error = new RangeError( 'original' );
	try {
		_db.transaction( () => { throw _error; } );
		assert.fail( 'no throw' );
	} catch ( error ) {
		assert.equal( error, _error );
	}
} );

attack( S, 'transaction() rethrows thrown non-errors unchanged and still rolls back', () => {
	const _db = memory();
	for ( const thrown of [ 'text', 0, null, undefined, { code: 1 } ] ) {
		let _caught = Symbol( 'none' );
		try {
			_db.transaction( () => {
				_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
				throw thrown;
			} );
		} catch ( error ) {
			_caught = error;
		}
		assert.equal( _caught, thrown );
	}
	assert.equal( count( _db ), 0 );
} );

attack( S, 'after a failed transaction no transaction is left open and the next one commits', () => {
	const _db = memory();
	assert.throws( () => _db.transaction( () => { throw new Error( 'x' ); } ) );
	assert.equal( _db.raw.isTransaction, false );
	_db.transaction( () => _db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' ) );
	assert.equal( count( _db ), 1 );
	assert.equal( _db._depth, 0 );
} );

attack( S, 'nested transactions join the outer one: an outer failure undoes the inner writes', () => {
	const _db = memory();
	assert.throws( () => _db.transaction( () => {
		_db.transaction( () => _db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' ) );
		_db.transaction( () => _db.transaction( () => _db.run( 'INSERT INTO t ( x ) VALUES ( 2 )' ) ) );
		throw new Error( 'outer' );
	} ), /outer/ );
	assert.equal( count( _db ), 0 );
} );

attack( S, 'nesting 1000 levels deep is one transaction and commits once', () => {
	const _db = memory();
	const _nest = ( n ) => {
		_db.run( 'INSERT INTO t ( x ) VALUES ( :n )', { n } );
		if ( n > 0 ) { _db.transaction( () => _nest( n - 1 ) ); }
	};
	_db.transaction( () => _nest( 999 ) );
	assert.equal( count( _db ), 1000 );
	assert.equal( _db._depth, 0 );
	assert.equal( _db.raw.isTransaction, false );
} );

attack( S, 'a transaction with something that is not a function fails cleanly and leaves nothing open', () => {
	const _db = memory();
	for ( const fn of [ null, undefined, 5, 'sql', {} ] ) {
		assert.throws( () => _db.transaction( fn ), TypeError );
		assert.equal( _db.raw.isTransaction, false );
		assert.equal( _db._depth, 0 );
	}
} );

attack( S, 'an async fn is refused or kept atomic: a rejection after an await rolls its writes back', async () => {
	const _db = memory();
	let _result;
	try {
		_result = _db.transaction( async () => {
			_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
			await null;
			_db.run( 'INSERT INTO t ( x ) VALUES ( 2 )' );
			throw new Error( 'late failure' );
		} );
	} catch ( error ) {
		assert.match( error.message, /async|promise|synchronous/i, 'refusing an async fn is fine' );
		return;
	}
	await assert.rejects( _result, /late failure/ );
	assert.equal( count( _db ), 0, 'a failed transaction must leave nothing' );
} );

attack( S, 'a fn that returns a promise is refused and its writes are rolled back; the promise is still heard', async () => {
	const _db = memory();
	const _quiet = quiet();
	try {
		assert.throws( () => _db.transaction( () => {
			_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
			return Promise.reject( new Error( 'late' ) );
		} ), /promise/ );
		await new Promise( resolve => setImmediate( resolve ) );
	} finally {
		_quiet.restore();
	}
	assert.equal( count( _db ), 0 );
	assert.equal( _db._depth, 0 );
	assert.deepEqual( _quiet.errors.map( error => error.message ), [ 'late' ], 'no unhandled rejection' );
} );

attack( S, 'when SQLite has already rolled back (RAISE(ROLLBACK)), the original error reaches the caller', () => {
	const _db = memory();
	_db.exec( 'CREATE TRIGGER guard BEFORE INSERT ON t WHEN NEW.x = 666 BEGIN SELECT RAISE( ROLLBACK, \'refused by trigger\' ); END' );
	assert.throws( () => _db.transaction( () => {
		_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
		_db.run( 'INSERT INTO t ( x ) VALUES ( 666 )' );
	} ), /refused by trigger/ );
	assert.equal( _db._depth, 0 );
	assert.equal( count( _db ), 0 );
} );

attack( S, 'a deferred foreign key that fails at COMMIT: error thrown, nothing kept, next transaction works', () => {
	const _db = new Db( ':memory:' );
	_db.exec( `CREATE TABLE p ( id TEXT PRIMARY KEY );
		CREATE TABLE c ( p TEXT REFERENCES p( id ) DEFERRABLE INITIALLY DEFERRED )` );
	assert.throws( () => _db.transaction( () => _db.run( 'INSERT INTO c ( p ) VALUES ( :p )', { p: 'nobody' } ) ), /FOREIGN KEY/ );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM c' ).n, 0 );
	assert.equal( _db.raw.isTransaction, false );
	_db.transaction( () => _db.run( 'INSERT INTO p ( id ) VALUES ( :id )', { id: 'a' } ) );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM p' ).n, 1 );
} );

attack( S, 'a write lock held by another connection: BEGIN fails after the busy timeout and the depth stays 0', () => {
	const _file = file();
	const _a = new Db( _file );
	const _b = new Db( _file );
	_a.exec( 'CREATE TABLE t ( x INTEGER )' );
	_b.exec( 'BEGIN IMMEDIATE' );
	_a.exec( 'PRAGMA busy_timeout = 20' );
	assert.throws( () => _a.transaction( () => _a.run( 'INSERT INTO t ( x ) VALUES ( 1 )' ) ), /locked|busy/ );
	assert.equal( _a._depth, 0 );
	_b.exec( 'COMMIT' );
	_a.transaction( () => _a.run( 'INSERT INTO t ( x ) VALUES ( 1 )' ) );
	assert.equal( count( _b ), 1 );
	_a.close();
	_b.close();
} );

attack( S, 'a transaction holds the write lock from its start: another writer is turned away meanwhile', () => {
	const _file = file();
	const _a = new Db( _file );
	const _b = new Db( _file );
	_a.exec( 'CREATE TABLE t ( x INTEGER )' );
	_b.exec( 'PRAGMA busy_timeout = 10' );
	_a.transaction( () => {
		_a.get( 'SELECT COUNT(*) AS n FROM t' );
		assert.throws( () => _b.run( 'INSERT INTO t ( x ) VALUES ( 2 )' ), /locked|busy/ );
		_a.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
	} );
	assert.deepEqual( _b.all( 'SELECT x FROM t' ).map( row => row.x ), [ 1 ] );
	_a.close();
	_b.close();
} );

attack( S, 'another connection does not see uncommitted rows, and sees them right after COMMIT', () => {
	const _file = file();
	const _a = new Db( _file );
	const _b = new Db( _file );
	_a.exec( 'CREATE TABLE t ( x INTEGER )' );
	_a.transaction( () => {
		_a.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
		assert.equal( count( _b ), 0 );
		assert.equal( count( _a ), 1, 'the writer reads its own rows' );
	} );
	assert.equal( count( _b ), 1 );
	_a.close();
	_b.close();
} );

attack( S, 'three processes increment one counter 40 times each under transactions: exactly 120', async () => {
	const _file = file( 'counter.db' );
	const _setup = new Db( _file );
	_setup.exec( 'CREATE TABLE counter ( n INTEGER ); INSERT INTO counter VALUES ( 0 )' );
	_setup.close();
	const _code = `
		import { boot } from './lib/node.mjs';
		const app = boot( { overrides: '' } );
		const [ Db ] = await app.use( [ 'Lib.Db' ] );
		const db = new Db( process.env.STRESS_DB );
		for ( let i = 0; i < 40; i++ ) {
			db.transaction( () => {
				const n = db.get( 'SELECT n FROM counter' ).n;
				db.run( 'UPDATE counter SET n = :n', { n: n + 1 } );
			} );
		}
		db.close();
		console.log( 'done' );
	`;
	const _runs = await Promise.all( [ 1, 2, 3 ].map( () => childAsync( _code, { env: { STRESS_DB: _file } } ) ) );
	_runs.forEach( run => assert.equal( run.status, 0, run.stderr ) );
	const _db = new Db( _file );
	assert.equal( _db.get( 'SELECT n FROM counter' ).n, 120 );
	_db.close();
} );

attack( S, '100 async callers with read-modify-write transactions lose no update', async () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE counter ( n INTEGER ); INSERT INTO counter VALUES ( 0 )' );
	await Promise.all( Array.from( { length: 100 }, async ( _, i ) => {
		await new Promise( resolve => setImmediate( resolve ) );
		if ( i % 3 === 0 ) { await null; }
		_db.transaction( () => {
			const _n = _db.get( 'SELECT n FROM counter' ).n;
			_db.run( 'UPDATE counter SET n = :n', { n: _n + 1 } );
		} );
	} ) );
	assert.equal( _db.get( 'SELECT n FROM counter' ).n, 100 );
} );

attack( S, 'random nesting with random failures always matches a model of what was committed (seeded)', () => {
	const _rnd = random( 31 );
	const _db = memory();
	let _model = 0;
	for ( let round = 0; round < 200; round++ ) {
		let _pending = 0;
		const _level = ( depth ) => {
			const _n = _rnd.int( 0, 3 );
			for ( let i = 0; i < _n; i++ ) {
				_db.run( 'INSERT INTO t ( x ) VALUES ( :round )', { round } );
				_pending += 1;
			}
			if ( depth < 4 && _rnd() < 0.6 ) { _db.transaction( () => _level( depth + 1 ) ); }
			if ( _rnd() < 0.15 ) { throw new Error( `round ${round} fails` ); }
		};
		try {
			_db.transaction( () => _level( 0 ) );
			_model += _pending;
		} catch {
			// the whole round is gone
		}
		assert.equal( count( _db ), _model, `round ${round}` );
		assert.equal( _db._depth, 0 );
	}
} );

attack( S, '10000 inserts in one transaction take a few seconds at most', () => {
	const _db = memory();
	const _start = performance.now();
	_db.transaction( () => { for ( let i = 0; i < 10000; i++ ) { _db.run( 'INSERT INTO t ( x ) VALUES ( :i )', { i } ); } } );
	assert.ok( performance.now() - _start < 3000 );
	assert.equal( count( _db ), 10000 );
} );

attack( S, 'close() twice is harmless', () => {
	const _db = memory();
	_db.close();
	assert.doesNotThrow( () => _db.close() );
} );

attack( S, 'afterCommit: at once outside a transaction, after the outermost COMMIT inside one, never after a ROLLBACK', () => {
	const _db = memory();
	const _heard = [];
	_db.afterCommit( () => _heard.push( 'outside' ) );
	_db.transaction( () => {
		_db.transaction( () => _db.afterCommit( () => _heard.push( 'inner' ) ) );
		assert.deepEqual( _heard, [ 'outside' ], 'nothing is heard before the COMMIT' );
	} );
	assert.throws( () => _db.transaction( () => {
		_db.afterCommit( () => _heard.push( 'rolled back' ) );
		throw new Error( 'stop' );
	} ), /stop/ );
	_db.transaction( () => 1 );
	assert.deepEqual( _heard, [ 'outside', 'inner' ] );
} );

attack( S, 'a closed database refuses every call with an error, transactions included, and the depth stays 0', () => {
	const _db = memory();
	_db.close();
	assert.throws( () => _db.get( 'SELECT 1' ), /not open/ );
	assert.throws( () => _db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' ), /not open/ );
	assert.throws( () => _db.exec( 'SELECT 1' ), /not open/ );
	assert.throws( () => _db.transaction( () => 1 ), /not open/ );
	assert.equal( _db._depth, 0 );
} );

attack( S, 'two connections in one process see each other\'s committed rows at once (WAL)', () => {
	const _file = file();
	const _a = new Db( _file );
	const _b = new Db( _file );
	_a.exec( 'CREATE TABLE t ( x INTEGER )' );
	for ( let i = 0; i < 50; i++ ) {
		( i % 2 ? _a : _b ).run( 'INSERT INTO t ( x ) VALUES ( :i )', { i } );
		assert.equal( count( i % 2 ? _b : _a ), i + 1 );
	}
	_a.close();
	_b.close();
} );

attack( S, 'a database path with blanks and unicode works and persists', () => {
	const _file = path.join( tempDir( 'db' ), 'folder with ü', 'dätä base.db' );
	const _db = new Db( _file );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
	_db.close();
	assert.equal( count( new Db( _file ) ), 1 );
} );

attack( S, 'run() reports changes and the new row id', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE r ( id INTEGER PRIMARY KEY AUTOINCREMENT, x INTEGER )' );
	const _first = _db.run( 'INSERT INTO r ( x ) VALUES ( 1 )' );
	const _second = _db.run( 'INSERT INTO r ( x ) VALUES ( 2 )' );
	assert.equal( Number( _second.lastInsertRowid ), Number( _first.lastInsertRowid ) + 1 );
	assert.equal( _db.run( 'UPDATE r SET x = 0' ).changes, 2 );
} );

attack( S, 'exec() of several statements where one fails keeps the ones before it (no implicit transaction)', () => {
	const _db = memory();
	assert.throws( () => _db.exec( 'INSERT INTO t ( x ) VALUES ( 1 ); INSERT INTO nowhere VALUES ( 2 );' ), /no such table/ );
	assert.equal( count( _db ), 1 );
} );
