// bin/promote.mjs: writes a mission bundle as a folder and checks it. It writes nothing over, takes only the files a
// mission has, and only a bundle with a plain kind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync( path.join( os.tmpdir(), 'promote-' ) );
after( () => fs.rmSync( DIR, { recursive: true, force: true } ) );
const promote = ( bundle, extra = [] ) => {
	const _file = path.join( DIR, `bundle-${Math.random().toString( 36 ).slice( 2 )}.json` );
	fs.writeFileSync( _file, typeof bundle === 'string' ? bundle : JSON.stringify( bundle ) );
	return spawnSync( process.execPath, [ 'bin/promote.mjs', '--bundle', _file, '--to', DIR, ...extra ], { encoding: 'utf8', env: { ...process.env, AGENCY_MISSIONS: '' } } );
};
const FRAME = { 'mission.json': { id: 'k', kind: 'k', contract: 'contract.json' }, 'contract.json': { id: 'k', goal: 'x', deadline: '{{in:24h}}', criteria: [] } };

test( 'a bundle with a kind that is no plain name is refused, nothing written', () => {
	for ( const kind of [ '../escape', 'Upper', '', null ] ) {
		const _run = promote( { kind, files: FRAME } );
		assert.equal( _run.status, 1, String( kind ) );
		assert.match( _run.stderr, /no mission bundle/ );
	}
	assert.deepEqual( fs.readdirSync( DIR ).filter( name => !name.startsWith( 'bundle-' ) ), [] );
} );

test( 'a bundle with a file a mission does not have is refused: no path, no script', () => {
	for ( const name of [ '../../evil.json', 'tool.py', 'overrides.json', 'stub.json' ] ) {
		const _run = promote( { kind: 'odd', files: { ...FRAME, [ name ]: {} } } );
		assert.equal( _run.status, 1, name );
		assert.match( _run.stderr, /known files only/ );
	}
	assert.equal( fs.existsSync( path.join( DIR, 'odd' ) ), false );
} );

test( 'a bundle of another kind than the one asked for is refused', () => {
	const _file = path.join( DIR, 'other.json' );
	fs.writeFileSync( _file, JSON.stringify( { kind: 'notices', files: FRAME } ) );
	const _run = spawnSync( process.execPath, [ 'bin/promote.mjs', 'invoices', '--bundle', _file, '--to', DIR ], { encoding: 'utf8' } );
	assert.equal( _run.status, 1 );
	assert.match( _run.stderr, /of the kind notices, not invoices/ );
} );

test( 'without --to nothing is written', () => {
	const _run = spawnSync( process.execPath, [ 'bin/promote.mjs', 'notices' ], { encoding: 'utf8' } );
	assert.equal( _run.status, 1 );
	assert.match( _run.stderr, /usage/ );
} );

test( 'a frame that the check refuses is written, and the check says why (exit 1)', () => {
	const _run = promote( { kind: 'frame-only', files: FRAME } );
	assert.equal( _run.status, 1 );
	assert.match( _run.stdout, /written: .*frame-only/ );
	assert.match( _run.stdout, /no outcome criterion|the check found problems/ );
	assert.ok( fs.existsSync( path.join( DIR, 'frame-only', 'mission.json' ) ) );
} );
