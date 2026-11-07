import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, Mission } from '../office.mjs';

const [ ProcessRuntime ] = await use( 'Core.Sandbox.ProcessRuntime' );
const fs = await import( 'node:fs' );
const path = await import( 'node:path' );
const frame = fs.readFileSync( path.join( process.cwd(), 'missions/survey/tools/analysis.py' ), 'utf8' );
const runner = fs.readFileSync( path.join( process.cwd(), 'sandbox/tools/agent_code.py' ), 'utf8' );
// As the executor does it: the frame prepares with the data, the code runs alone with the rows, the frame checks.
const run = async ( code, teams = [ 'design', 'product' ] ) => {
	const _runtime = new ProcessRuntime( { timeoutSeconds: 5 } );
	const _json = async ( script, input, dataDir = null ) => JSON.parse( ( await _runtime.run( { script, input, dataDir } ) ).stdout );
	const _prepared = await _json( frame, { teams, phase: 'prepare' }, 'missions/survey/data' );
	const { rows, ...prepared } = _prepared.value;
	const _ran = await _json( runner, { code, rows } );
	return { ...await _json( frame, { phase: 'check', prepared, ran: _ran } ), cohort: _prepared.cohort };
};

test( '6.1, Pattern A: the agent\'s own analysis code runs in the sandbox; a trusted frame chooses the group and checks the result', async () => {
	const _good = await run( 'result = {"n": 50, "workload": round(sum(r["workload"] for r in rows) / len(rows), 2), '
		+ '"manager": sum(r["manager"] for r in rows) / len(rows), "themes": {t: sum(1 for r in rows if r["theme"] == t) for t in {r["theme"] for r in rows}}}' );
	assert.deepEqual( _good.cohort.length, 12 );
	assert.equal( _good.value.n, 12, 'the size of the group comes from the frame, never from the agent\'s code' );
	const _lies = await run( 'result = {"workload": 1, "manager": 1, "themes": {"workload": 1}}' );
	assert.match( _lies.wall.reason, /differs from the frame's own figures: workload, manager, themes/, 'figures the code made up are refused' );
	assert.deepEqual( _lies.wall.repair, { differs: [ 'workload', 'manager', 'themes' ], keys: [ 'n', 'workload', 'manager', 'themes' ] } );
	const _import = await run( 'import os\nresult = {"n": 1}' );
	assert.match( _import.wall.reason, /ImportError/ );
	const _names = await run( 'result = {"anna": 1}' );
	assert.match( _names.wall.reason, /breaks its schema: 1 unknown key$/, 'a key the code made up is counted, never named: it could carry data' );
	const _text = await run( 'result = {"themes": {"Anna hates her manager": 1}}' );
	assert.match( _text.wall.reason, /breaks its schema: themes/ );
	const _files = await run( 'result = {"n": open("roster.csv").read()}' );
	assert.match( _files.wall.reason, /NameError/, 'no files, no imports, no ids or names in the rows it gets' );
} );

test( 'in a run the agent writes the analysis, the sandbox runs it, and the gate still decides on the group the frame chose', async () => {
	const _o = await office( { edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const _started = _o.log.since( 0 ).filter( event => event.kind === 'move_started' ).map( event => event.data.move );
	assert.ok( _started.includes( 'analysis.write' ) && _started.includes( 'analysis.run' ) );
	const _refused = _root.walls.find( wall => wall.cause === 'group_too_small' );
	assert.match( _refused.reason, /group of 2 < 5/, 'whatever the code computed, two people are refused at the gate' );
	const _sent = _o.outbox.messages( 'hr' );
	assert.equal( _sent.length, 1 );
} );

test( '6.4, Pattern A: code that fails in its frame is written again once; the model hears the kind of error and its line, never data', async () => {
	const _value = await run( 'result = {"n": len(rows), "workload": sum(r["workload"] for r in rows) / int(rows[0]["theme"])}' );
	assert.deepEqual( _value.wall.repair, { error: 'ValueError', line: 1 } );
	assert.doesNotMatch( _value.wall.reason, /invalid literal|workload'|tools'/, 'the message, which quotes a value of the data, stays in the sandbox' );
	const _good = Mission.load( 'survey' ).stub.coder;
	const _asked = [];
	const _o = await office( {
		edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01,
		answers: { coder: [ { code: 'result = {"n": len(rowz)}' }, _good, _good, _good, _good ] },
	} );
	const _complete = _o.runner.executor.provider.complete.bind( _o.runner.executor.provider );
	_o.runner.executor.provider.complete = ( request ) => {
		if ( request.role === 'coder' ) { _asked.push( request.instructions ); }
		return _complete( request );
	};
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const [ _repair ] = _o.events( _root, 'code_repair' );
	assert.deepEqual( _repair.broken, [ { says: 'Your code raised NameError (no rowz here) in line 1.' } ] );
	assert.match( _asked[ 1 ], /could not be used; write it again\. Your code raised NameError \(no rowz here\) in line 1\./ );
	assert.ok( !_root.walls.some( wall => wall.cause === 'move_failed' ), 'the repaired code ran' );
} );
