// Retention of the run copies (VAULT_RETENTION_DAYS): the copy of a finished run goes after so many days without a
// change; an open run keeps its copy however old; nothing else in the folder is touched, and no link is followed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { Vault, tmp } from './rig.mjs';

const S = 'core/vault/vault.js';
const DAY = 86400000;

// A storage folder with run copies of the given ages in days: { name: age }.
function storage( runs ) {
	const _root = tmp( 'prune-' );
	const _base = path.join( _root, 'vault' );
	fs.mkdirSync( _base, { recursive: true } );
	for ( const [ name, age ] of Object.entries( runs ) ) {
		const _dir = path.join( _base, name );
		fs.mkdirSync( _dir );
		fs.writeFileSync( path.join( _dir, 'roster.csv' ), 'name\nMira\n' );
		const _then = new Date( Date.now() - age * DAY );
		fs.utimesSync( _dir, _then, _then );
	}
	return { root: _root, base: _base, left: () => fs.readdirSync( _base ).sort() };
}

attack( S, 'prune: a finished run older than the days goes, a younger one stays', () => {
	const s = storage( { 'survey-aaaaaa': 40, 'survey-bbbbbb': 3 } );
	const _removed = Vault.prune( s.root, { days: 30 } );
	assert.deepEqual( s.left(), [ 'survey-bbbbbb' ] );
	assert.deepEqual( _removed, [ path.join( s.base, 'survey-aaaaaa' ) ] );
} );

attack( S, 'prune: an open run keeps its copy however old', () => {
	const s = storage( { 'invoices-cccccc': 400 } );
	Vault.prune( s.root, { days: 30, keep: [ path.join( s.base, 'invoices-cccccc' ) ] } );
	assert.deepEqual( s.left(), [ 'invoices-cccccc' ] );
} );

attack( S, 'prune: an open run named by a relative path keeps its copy too', () => {
	const s = storage( { 'invoices-dddddd': 400 } );
	Vault.prune( s.root, { days: 30, keep: [ path.relative( process.cwd(), path.join( s.base, 'invoices-dddddd' ) ) ] } );
	assert.deepEqual( s.left(), [ 'invoices-dddddd' ] );
} );

attacks( S, [
	{ name: 'prune: a folder that is no run copy stays', name2: 'notes' },
	{ name: 'prune: a folder with a name of path parts stays', name2: '..hidden-eeeeee' },
	{ name: 'prune: a run name with too short a suffix stays', name2: 'survey-abc' },
], ( { name2 } ) => {
	const s = storage( { [ name2 ]: 400 } );
	Vault.prune( s.root, { days: 30 } );
	assert.deepEqual( s.left(), [ name2 ] );
} );

attack( S, 'prune: a file next to the run copies stays', () => {
	const s = storage( {} );
	fs.writeFileSync( path.join( s.base, 'survey-ffffff' ), 'not a folder' );
	const _then = new Date( Date.now() - 400 * DAY );
	fs.utimesSync( path.join( s.base, 'survey-ffffff' ), _then, _then );
	Vault.prune( s.root, { days: 30 } );
	assert.deepEqual( s.left(), [ 'survey-ffffff' ] );
} );

attack( S, 'prune: a link named like a run copy is not followed, and what it points to stays', () => {
	const s = storage( {} );
	const _outside = tmp( 'outside-' );
	fs.writeFileSync( path.join( _outside, 'keep.txt' ), 'mine' );
	fs.symlinkSync( _outside, path.join( s.base, 'survey-gggggg' ) );
	Vault.prune( s.root, { days: 1, now: Date.now() + 400 * DAY } );
	assert.ok( fs.existsSync( path.join( _outside, 'keep.txt' ) ) );
} );

attacks( S, [
	{ name: 'prune: without a storage folder nothing is pruned', root: null, days: 30 },
	{ name: 'prune: zero days prunes nothing (no retention is no deletion)', root: 'given', days: 0 },
	{ name: 'prune: days that are no number prune nothing', root: 'given', days: '30' },
	{ name: 'prune: a storage folder without a vault prunes nothing', root: 'empty', days: 30 },
], ( { root, days } ) => {
	const s = storage( { 'survey-hhhhhh': 400 } );
	const _root = root === 'given' ? s.root : root === 'empty' ? tmp( 'empty-' ) : null;
	assert.deepEqual( Vault.prune( _root, { days } ), [] );
	assert.deepEqual( s.left(), [ 'survey-hhhhhh' ] );
} );
