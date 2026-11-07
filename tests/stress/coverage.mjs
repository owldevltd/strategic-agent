// Counts the stress tests of every engine module (lib/, core/, gate/) and of every allowed transition of the node's
// state machine, and lists the defects the tests found (TODO). Fails when a module or a transition has fewer than
// MIN tests, or when a test fails.
//
//   node tests/stress/coverage.mjs            the whole suite
//   MIN=50 node tests/stress/coverage.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from '../../lib/node.mjs';

const MIN = Number( process.env.MIN || 50 );
const app = boot( { overrides: '' } );
const [ Machine ] = await app.use( [ 'Core.Node.Machine' ] );

const modules = [ 'lib', 'core', 'gate' ].flatMap( dir => fs.readdirSync( path.join( ROOT, dir ), { recursive: true } )
	.map( String ).filter( name => name.endsWith( '.js' ) ).map( name => `${dir}/${name}` ) ).sort();
const transitions = Object.entries( Machine.TRANSITIONS ).flatMap( ( [ from, list ] ) => list.map( to => `transition ${from}→${to}` ) );

// Four test files at a time: the suite shares a small machine with people and other workers (STRESS_CONCURRENCY changes it).
const _concurrency = `--test-concurrency=${Number.parseInt( process.env.STRESS_CONCURRENCY, 10 ) || 4}`;
const _run = spawnSync( process.execPath, [ '--disable-warning=ExperimentalWarning', '--test', _concurrency, '--test-reporter=tap', 'tests/**/*.test.mjs' ], {
	cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512,
} );
const counts = new Map( [ ...modules, ...transitions ].map( subject => [ subject, { tests: 0, defects: [], fixed: [] } ] ) );
const failed = [];
let total = 0;
for ( const line of _run.stdout.split( '\n' ) ) {
	const _match = line.match( /^\s*(not ok|ok) \d+ - (.+?)(?: # (TODO|SKIP)\s*(.*))?$/ );
	if ( !_match ) { continue; }
	const [ , _status, _name, _directive, _reason ] = _match;
	const _subject = _name.split( ': ' )[ 0 ];
	if ( !counts.has( _subject ) ) { continue; }
	total += 1;
	const _entry = counts.get( _subject );
	_entry.tests += 1;
	// A defect test that fails is an open defect; one that passes is fixed, and its marker should go.
	if ( _directive === 'TODO' ) { _entry[ _status === 'ok' ? 'fixed' : 'defects' ].push( `${_name.slice( _subject.length + 2 )} (${_reason})` ); }
	if ( _status === 'not ok' && _directive !== 'TODO' ) { failed.push( _name ); }
}

const _short = [ ...counts ].filter( ( [ , entry ] ) => entry.tests < MIN );
const _width = Math.max( ...[ ...counts.keys() ].map( key => key.length ) );
for ( const [ subject, entry ] of counts ) {
	const _flag = entry.tests < MIN ? '  < MIN' : '';
	console.log( `${subject.padEnd( _width )}  ${String( entry.tests ).padStart( 4 )}  open defects ${entry.defects.length}  fixed ${entry.fixed.length}${_flag}` );
}
const _defects = [ ...counts ].flatMap( ( [ subject, entry ] ) => entry.defects.map( text => `${subject}: ${text}` ) );
console.log( `\n${total} stress tests over ${modules.length} modules and ${transitions.length} transitions (minimum ${MIN} each)` );
const _fixed = [ ...counts ].flatMap( ( [ subject, entry ] ) => entry.fixed.map( text => `${subject}: ${text}` ) );
console.log( `${_short.length} below the minimum, ${failed.length} failing, ${_defects.length} open defects, ${_fixed.length} fixed (marker to remove)` );
_defects.forEach( text => console.log( `  DEFECT ${text}` ) );
if ( process.env.FIXED ) { _fixed.forEach( text => console.log( `  FIXED ${text}` ) ); }
failed.forEach( name => console.log( `  FAILED ${name}` ) );
if ( _run.status !== 0 && !failed.length ) { console.log( '  the test run itself failed outside the stress tests; run npm test' ); }
process.exit( _short.length || _run.status !== 0 ? 1 : 0 );
