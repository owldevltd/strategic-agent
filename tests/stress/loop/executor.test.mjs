// Stress tests of the executor of one step (6.1, 6.3, 6.4): the five base moves, code in the sandbox, model steps
// under their step contract, and the one repair of code a model wrote. Attacks: unknown and hostile executors, scripts
// that fail, print no JSON or five megabytes, never end; models that break their contract or never stop trying.
import assert from 'node:assert/strict';
import { attack, attacks, within } from '../hostile.mjs';
import { Executor, Catalog, Mission, StubProvider, Board, Supervisor, MOVES, app, fakeGate, node, memoryLog, never } from './kit.mjs';

const EXEC = 'core/move/executor.js';
const [ ProcessRuntime ] = await app.use( [ 'Core.Sandbox.ProcessRuntime' ] );
const FIXTURES = 'tests/stress/loop/fixtures';

// A runtime that prints what the test gives it, and counts its runs.
function printing( ...outputs ) {
	const _runtime = { runs: [], run: async ( request ) => {
		_runtime.runs.push( request );
		const _out = outputs[ Math.min( _runtime.runs.length, outputs.length ) - 1 ];
		return typeof _out === 'string' ? { exitCode: 0, stdout: _out, stderr: '' } : { exitCode: 0, stderr: '', ..._out };
	}, stop: () => {} };
	return _runtime;
}

function asking( answer ) {
	const _provider = { asked: [], complete: async ( request ) => {
		_provider.asked.push( request );
		return typeof answer === 'function' ? answer( request ) : answer;
	} };
	return _provider;
}

function executor( { moves = {}, runtime = printing( '{"value": {}}' ), provider = asking( { text: 'a draft' } ), gate = null, board = null, soft = null } = {} ) {
	const _catalog = Catalog.load( Mission.load( 'survey' ) );
	Object.assign( _catalog.moves, MOVES, moves );
	return new Executor( { catalog: _catalog, runtime, provider, gate, log: memoryLog(), board, soft } );
}

const ctx = ( { values = {}, plan = [], runner = {} } = {} ) => ( { node: node(), mission: { dataDir: null }, values, plan, runner } );
const TOOL = { executor: 'code', tool: 'missions/survey/tools/count.py', price: 0.05, labels: [ 'own' ], reversible: false };
const CODER = { executor: 'ai', role: 'coder', instructions: 'Write code.', contract: { fields: { code: { type: 'string' } } }, price: 0.3, labels: [] };

// --- dispatch ---

attack( EXEC, 'a move with an executor the version does not have is refused before anything runs', async () => {
	const _runtime = printing( '{}' );
	const _exec = executor( { moves: { 'x.robot': { executor: 'robot' } }, runtime: _runtime } );
	await assert.rejects( _exec.run( { move: 'x.robot' }, ctx() ), /executor robot is not available/ );
	assert.equal( _runtime.runs.length, 0 );
} );

attacks( EXEC, [ 'constructor', 'toString', '__proto__', 'hasOwnProperty', '' ].map( name => ( {
	name: `a move with the executor "${name}" is refused and runs nothing`, executor: name,
} ) ), async ( item ) => {
	const _runtime = printing( '{}' );
	const _provider = asking( {} );
	const _exec = executor( { moves: { 'x.hostile': { executor: item.executor } }, runtime: _runtime, provider: _provider } );
	await assert.rejects( _exec.run( { move: 'x.hostile' }, ctx() ) );
	assert.equal( _runtime.runs.length + _provider.asked.length, 0 );
} );

attack( EXEC, 'a move that is not in the catalog is refused and runs nothing (G2 already refuses it)', async () => {
	const _runtime = printing( '{}' );
	await assert.rejects( executor( { runtime: _runtime } ).run( { move: 'no.such.move' }, ctx() ) );
	assert.equal( _runtime.runs.length, 0 );
} );

attack( EXEC, 'a trusted code move of the core runs as the core\'s own code, never in the sandbox', async () => {
	const _runtime = printing( '{}' );
	const _seen = [];
	const _runner = { trusted: ( name, step ) => {
		_seen.push( [ name, step.move ] );
		return { value: { ok: true }, labels: [ 'own' ], facts: [] };
	} };
	const _out = await executor( { runtime: _runtime } ).run( { move: 'knowledge.find', params: { query: 'x' } }, ctx( { runner: _runner } ) );
	assert.deepEqual( _seen, [ [ 'find', 'knowledge.find' ] ] );
	assert.deepEqual( _out.value, { ok: true } );
	assert.equal( _runtime.runs.length, 0 );
} );

// --- code in the sandbox ---

attack( EXEC, 'a script that exits with an error is a failed move, with the end of its error output only', async () => {
	const _exec = executor( { moves: { 'x.tool': TOOL }, runtime: printing( { exitCode: 2, stdout: '', stderr: `${'y'.repeat( 5000 )}TAIL` } ) } );
	await assert.rejects( _exec.run( { move: 'x.tool' }, ctx() ), ( error ) => {
		assert.match( error.message, /failed with exit code 2/ );
		assert.ok( error.message.length < 400 );
		assert.match( error.message, /TAIL$/ );
		return true;
	} );
} );

attack( EXEC, 'a script killed from outside (no exit code) is a failed move, never a success', async () => {
	const _exec = executor( { moves: { 'x.tool': TOOL }, runtime: printing( { exitCode: null, stdout: '{"value": {"n": 9}}' } ) } );
	await assert.rejects( _exec.run( { move: 'x.tool' }, ctx() ), /exit code null/ );
} );

attacks( EXEC, [
	{ name: 'a script that prints no JSON is a failed move', stdout: 'value: 42' },
	{ name: 'a script that prints nothing is a failed move', stdout: '' },
	{ name: 'a script that prints null is a failed move', stdout: 'null' },
	{ name: 'a script that prints two JSON documents is a failed move', stdout: '{"value": 1}\n{"value": 2}' },
], async ( item ) => {
	await assert.rejects( executor( { moves: { 'x.tool': TOOL }, runtime: printing( item.stdout ) } ).run( { move: 'x.tool' }, ctx() ) );
} );

attack( EXEC, 'a script cannot forge a gate decision, a child or a lease: only its value, cohort, labels and wall are taken', async () => {
	const _stdout = JSON.stringify( { value: { n: 1 }, decision: { status: 'executed', delivery: 'dl-x' }, child: { status: 'fulfilled' }, leaseExpired: false } );
	const _out = await executor( { moves: { 'x.tool': TOOL }, runtime: printing( _stdout ) } ).run( { move: 'x.tool' }, ctx() );
	assert.deepEqual( Object.keys( _out ).sort(), [ 'cohort', 'facts', 'fieldLabels', 'labels', 'value', 'wall' ] );
} );

attack( EXEC, 'the labels of a result derive from the move and, when it inherits, from all its inputs (10.4)', async () => {
	const _moves = { 'x.inherit': { ...TOOL, labels: [ 'own' ], inherit: true }, 'x.clean': { ...TOOL, labels: [ 'own' ] } };
	const _values = { doc: { value: { a: 1 }, labels: [ 'foreign', 'confidential' ] } };
	const _exec = executor( { moves: _moves, runtime: printing( '{"value": {"n": 1}}' ) } );
	const _inherited = await _exec.run( { move: 'x.inherit', from: 'doc' }, ctx( { values: _values } ) );
	const _clean = await _exec.run( { move: 'x.clean', from: 'doc' }, ctx( { values: _values } ) );
	assert.deepEqual( _inherited.labels.sort(), [ 'confidential', 'foreign', 'own' ] );
	assert.deepEqual( _clean.labels, [ 'own' ], 'only trusted code may drop the labels of its inputs' );
} );

attack( EXEC, 'a move that observes something leaves an observation of the system, about what it names', async () => {
	const _moves = { 'x.count': { ...TOOL, fact: 'measured', about: 'quantity' } };
	const _out = await executor( { moves: _moves, runtime: printing( '{"value": {"quantity": "answers:design", "count": 4}}' ) } ).run( { move: 'x.count' }, ctx() );
	assert.deepEqual( _out.facts, [ { kind: 'measured', evidenceClass: 'observation', source: 'sandbox x.count', origin: 'system',
		data: { about: 'answers:design', quantity: 'answers:design', count: 4 } } ] );
} );

attack( EXEC, 'a move that reports a wall observes nothing', async () => {
	const _moves = { 'x.count': { ...TOOL, fact: 'measured' } };
	const _out = await executor( { moves: _moves, runtime: printing( '{"value": {"count": 4}, "wall": {"cause": "move_failed"}}' ) } ).run( { move: 'x.count' }, ctx() );
	assert.deepEqual( _out.facts, [] );
	assert.equal( _out.wall.cause, 'move_failed' );
} );

attack( EXEC, 'a step whose input is missing is refused before the sandbox starts', async () => {
	const _runtime = printing( '{}' );
	await assert.rejects( executor( { moves: { 'x.tool': TOOL }, runtime: _runtime } ).run( { move: 'x.tool', from: 'nothing' }, ctx() ), /input nothing is not available/ );
	assert.equal( _runtime.runs.length, 0 );
} );

attack( EXEC, 'a sandbox that cannot start is a failed move', async () => {
	const _runtime = { run: async () => {
		throw new Error( 'spawn timeout ENOENT' );
	} };
	await assert.rejects( executor( { moves: { 'x.tool': TOOL }, runtime: _runtime } ).run( { move: 'x.tool' }, ctx() ), /ENOENT/ );
} );

attack( EXEC, 'the script gets its parameters and the values of its inputs, never their labels or cohorts (minimisation)', async () => {
	const _runtime = printing( '{"value": {}}' );
	const _values = { stats: { value: { n: 5 }, labels: [ 'confidential' ], cohort: [ 'r1', 'r2' ] } };
	await executor( { moves: { 'x.tool': TOOL }, runtime: _runtime } ).run( { move: 'x.tool', from: 'stats', params: { teams: [ 'design' ] } }, ctx( { values: _values } ) );
	assert.deepEqual( _runtime.runs[ 0 ].input, { teams: [ 'design' ], inputs: [ { n: 5 } ] } );
} );

// --- the one repair of code a model wrote (6.4) ---

const REPAIR = '{"value": null, "wall": {"cause": "move_failed", "reason": "the analysis code failed", "repair": {"error": "NameError", "line": 1}}}';
const PLAN = [ { move: 'x.coder', as: 'script' }, { move: 'x.frame', from: [ 'script' ], as: 'stats' } ];
const FRAME = { ...TOOL, tool: 'missions/survey/tools/analysis.py' };

attack( EXEC, '6.4: code that fails in its frame is written again once; the model hears only the kind of error and its line', async () => {
	const _runtime = printing( REPAIR, '{"value": {"n": 12}}' );
	const _provider = asking( { code: 'result = {"n": len(rows)}' } );
	const _ctx = ctx( { values: { script: { value: { code: 'result = {"n": len(rowz)}' }, labels: [] } }, plan: PLAN } );
	const _out = await executor( { moves: { 'x.coder': CODER, 'x.frame': FRAME }, runtime: _runtime, provider: _provider } ).run( PLAN[ 1 ], _ctx );
	assert.deepEqual( _out.value, { n: 12 } );
	assert.equal( _provider.asked.length, 1 );
	assert.match( _provider.asked[ 0 ].instructions, /write it again\. Your code raised NameError in line 1\.$/ );
	assert.equal( _runtime.runs.length, 2 );
} );

attack( EXEC, '6.4: never more than one repair: code that fails again is a wall', async () => {
	const _runtime = printing( REPAIR, REPAIR, REPAIR );
	const _provider = asking( { code: 'still broken' } );
	const _ctx = ctx( { values: { script: { value: { code: 'broken' }, labels: [] } }, plan: PLAN } );
	const _out = await executor( { moves: { 'x.coder': CODER, 'x.frame': FRAME }, runtime: _runtime, provider: _provider } ).run( PLAN[ 1 ], _ctx );
	assert.equal( _out.wall.cause, 'move_failed' );
	assert.equal( _provider.asked.length, 1 );
	assert.equal( _runtime.runs.length, 2 );
} );

attack( EXEC, '6.4: code that was not written by a model is not repaired', async () => {
	const _runtime = printing( REPAIR );
	const _provider = asking( {} );
	const _plan = [ { move: 'x.tool', as: 'script' }, { move: 'x.frame', from: [ 'script' ] } ];
	const _ctx = ctx( { values: { script: { value: {}, labels: [] } }, plan: _plan } );
	const _out = await executor( { moves: { 'x.tool': TOOL, 'x.frame': FRAME }, runtime: _runtime, provider: _provider } ).run( _plan[ 1 ], _ctx );
	assert.equal( _out.wall.cause, 'move_failed' );
	assert.equal( _provider.asked.length, 0 );
} );

attack( EXEC, '6.4: a failing move without any input never makes an unrelated model step write again', async () => {
	const _runtime = printing( REPAIR, REPAIR );
	const _provider = asking( { code: 'x' } );
	const _plan = [ { move: 'x.coder' }, { move: 'x.frame' } ];
	const _out = await executor( { moves: { 'x.coder': CODER, 'x.frame': FRAME }, runtime: _runtime, provider: _provider } ).run( _plan[ 1 ], ctx( { plan: _plan } ) );
	assert.equal( _provider.asked.length, 0, 'the first model step of the plan had nothing to do with this code' );
	assert.equal( _out.wall.cause, 'move_failed' );
} );

attack( EXEC, '6.4: the repair message carries the error kind and line, never the error text', () => {
	assert.equal( Executor.repair( { error: 'ValueError', line: 3 } ), 'Your code raised ValueError in line 3.' );
	assert.equal( Executor.repair( { error: 'ImportError' } ), 'Your code raised ImportError.' );
} );

attack( EXEC, '6.4: a broken schema is reported by its keys only, and only by the schema\'s own keys', () => {
	const _keys = [ 'n', 'workload', 'manager', 'themes' ];
	assert.equal( Executor.repair( { schema: [ 'anna', 'themes' ], keys: _keys } ), 'Your result broke its schema at: an unknown key, themes.' );
	assert.equal( Executor.repair( { schema: 'themes', keys: _keys } ), 'Your result broke its schema at: themes.' );
	assert.equal( Executor.repair( { schema: [ 'anna' ] } ), 'Your result broke its schema at: an unknown key.' );
} );

attack( EXEC, '6.4: any other problem is named by the frame\'s own words, or as unknown', () => {
	assert.equal( Executor.repair( { problem: 'no code' } ), 'Your code was not usable: no code.' );
	assert.equal( Executor.repair( {} ), 'Your code was not usable: unknown.' );
} );

// --- pentest E/C: the core's own rules for code a model wrote, for every frame ---

const FRAMED = { executor: 'code', tool: 'missions/survey/tools/analysis.py', agentCode: 'sandbox/tools/agent_code.py', price: 0.05, labels: [ 'own' ] };
const PREPARED = '{"value": {"teams": ["design"], "n": 5, "themes": ["tools"], "rows": [], "expected": {}}, "cohort": ["r1", "r2", "r3", "r4", "r5"]}';

attack( EXEC, 'pentest: a wall about code a model wrote is told in the core\'s words; what the frame quoted never reaches the node or the log', async () => {
	const _quoting = JSON.stringify( { value: null, wall: { cause: 'move_failed', reason: 'keys: Anna_w1_m1, Ben_w5_m5', detail: [ 'Anna_w1_m1' ],
		repair: { schema: [ 'Anna_w1_m1', 'themes' ], keys: [ 'n', 'themes' ] } } } );
	const _ctx = ctx( { values: { script: { value: { code: 'x' }, labels: [] } }, plan: PLAN } );
	const _out = await executor( { moves: { 'x.coder': CODER, 'x.frame': FRAME }, runtime: printing( _quoting ), provider: asking( { code: 'y' } ) } )
		.run( PLAN[ 1 ], _ctx );
	assert.equal( _out.wall.reason, 'the agent\'s result broke its schema at: an unknown key, themes' );
	assert.ok( !JSON.stringify( _out.wall ).includes( 'Anna' ) || JSON.stringify( _out.wall.repair ).includes( 'Anna' ), 'only the structured report keeps it' );
	assert.equal( _out.wall.detail, undefined );
} );

attack( EXEC, 'pentest: a problem a frame passes on from the code counts only in the core\'s own words; counts stay counts', () => {
	assert.equal( Executor.repair( { problem: 'Anna rated her manager 1' } ), 'Your code was not usable: unknown.' );
	assert.equal( Executor.repair( { failed: 3, of: 24 } ), 'Your code failed 3 of 24 cases.' );
	assert.equal( Executor.repair( { failed: 'Anna', of: 24 } ), 'Your code was not usable: unknown.' );
	assert.equal( Executor.repair( { error: 'Anna_wrote_it', line: 2 } ), 'Your code raised an error in line 2.' );
	assert.equal( Executor.told( { cause: 'move_failed', reason: 'Anna', repair: { problem: 'it wrote files' } } ).reason, 'the agent\'s code was not usable: it wrote files' );
	assert.equal( Executor.told( { reason: 'Anna' } ).reason, 'the agent\'s code was not usable: unknown' );
} );

attack( EXEC, 'use cases: a NameError names what it misses only when that is a word of the model\'s own code', () => {
	const _code = 'try:\n    x = 1\nexcept UnknownThing:\n    pass\n';
	assert.equal( Executor.repair( { error: 'NameError', line: 3, name: 'UnknownThing' }, _code ), 'Your code raised NameError (no UnknownThing here) in line 3.' );
	assert.equal( Executor.repair( { error: 'NameError', line: 3, name: 'Anna_w1_m1' }, _code ), 'Your code raised NameError in line 3.', 'a name the code never wrote is data' );
	assert.equal( Executor.repair( { error: 'NameError', line: 3, name: 'Unknown Thing' }, _code ), 'Your code raised NameError in line 3.' );
	assert.equal( Executor.repair( { error: 'TypeError', line: 3, name: 'UnknownThing' }, _code ), 'Your code raised TypeError in line 3.' );
	assert.equal( Executor.told( { repair: { error: 'NameError', line: 2, name: 'Thing' } }, 'UnknownThing' ).reason, 'the agent\'s code raised NameError in line 2', 'a part of a word is no word' );
} );

attack( EXEC, 'pentest: a framed result the frame did not check against figures of its own is a wall (fail closed); a checked one counts', async () => {
	const _shape = await executor( { moves: { 'x.framed': FRAMED }, runtime: printing( PREPARED, '{"result": {}}', '{"value": {"n": 5, "workload": 1}}' ) } )
		.run( { move: 'x.framed' }, ctx() );
	assert.equal( _shape.wall.reason, 'the agent\'s code was not usable: the frame did not check the figures' );
	assert.equal( _shape.cohort, null );
	const _checked = await executor( { moves: { 'x.framed': FRAMED }, runtime: printing( PREPARED, '{"result": {}}', '{"value": {"n": 5, "workload": 1}, "verified": true}' ) } )
		.run( { move: 'x.framed' }, ctx() );
	assert.deepEqual( [ _checked.wall, _checked.value.n, _checked.cohort.length ], [ null, 5, 5 ] );
} );

attack( EXEC, 'pentest: a wall of the frame\'s prepare run, before any code a model wrote has run, keeps the frame\'s own words', async () => {
	const _out = await executor( { moves: { 'x.framed': FRAMED }, runtime: printing( '{"value": null, "wall": {"cause": "move_failed", "reason": "no answers of the team sales"}}' ) } )
		.run( { move: 'x.framed' }, ctx() );
	assert.equal( _out.wall.reason, 'no answers of the team sales' );
} );

// --- model steps under their step contract ---

attack( EXEC, 'a model step gets only the values of its inputs, its role and its step contract (minimisation)', async () => {
	const _provider = asking( { text: 'draft' } );
	const _values = { stats: { value: { n: 12 }, labels: [ 'confidential' ], cohort: [ 'r1' ] } };
	await executor( { provider: _provider } ).run( { move: 'report.draft', from: [ 'stats' ] }, ctx( { values: _values } ) );
	const [ _request ] = _provider.asked;
	assert.deepEqual( _request.input, [ { n: 12 } ] );
	assert.equal( _request.role, 'writer' );
	assert.deepEqual( Object.keys( _request.contract.fields ), [ 'text' ] );
} );

attack( EXEC, 'a writer of outgoing text gets the user\'s soft rules with its instructions (7.3)', async () => {
	const _provider = asking( { text: 'draft' } );
	const _soft = { instructions: action => `Rules for ${action}.` };
	await executor( { provider: _provider, soft: _soft } ).run( { move: 'report.draft', from: [ 'stats' ] }, ctx( { values: { stats: { value: {}, labels: [] } } } ) );
	assert.match( _provider.asked[ 0 ].instructions, / Rules for report\.$/ );
} );

attack( EXEC, 'a model step\'s result carries the group of all its inputs, once each and sorted', async () => {
	const _values = { a: { value: 1, labels: [], cohort: [ 'r3', 'r1' ] }, b: { value: 2, labels: [], cohort: [ 'r1', 'r2' ] }, c: { value: 3, labels: [] } };
	const _out = await executor().run( { move: 'report.draft', from: [ 'a', 'b', 'c' ] }, ctx( { values: _values } ) );
	assert.deepEqual( _out.cohort, [ 'r1', 'r2', 'r3' ] );
	assert.equal( Executor.union( [ { cohort: null } ] ), null );
} );

attack( EXEC, 'a model that fails for another reason is a failed move; no person is bothered', async () => {
	const _board = { asked: 0, ask: async () => {
		_board.asked++;
	} };
	const _provider = asking( () => Promise.reject( new Error( 'rate limited' ) ) );
	await assert.rejects( executor( { provider: _provider, board: _board } ).run( { move: 'report.draft' }, ctx() ), /rate limited/ );
	assert.equal( _board.asked, 0 );
} );

function broken( { answers = [], board = null } = {} ) {
	let _calls = 0;
	const _provider = asking( () => {
		_calls++;
		return _calls <= answers.length && answers[ _calls - 1 ] ? Promise.resolve( answers[ _calls - 1 ] )
			: Promise.reject( new Error( 'answer breaks the step contract: text is missing' ) );
	} );
	return executor( { provider: _provider, board } );
}

attack( EXEC, '6.4: an answer that breaks its step contract goes to a person with the reason; "stop this step" fails the move', async () => {
	const _board = { specs: [], ask: async ( of, spec ) => {
		_board.specs.push( spec );
		return { choice: 'stop this step', by: 'p' };
	} };
	await assert.rejects( broken( { board: _board } ).run( { move: 'report.draft' }, ctx() ), /step contract/ );
	assert.deepEqual( _board.specs[ 0 ].options, [ 'let the model try once more', 'stop this step' ] );
	assert.equal( _board.specs[ 0 ].kind, 'help' );
} );

attack( EXEC, '6.4: the person may let the model try once more; its next answer is used', async () => {
	const _board = { ask: async () => ( { choice: 'let the model try once more', by: 'p' } ) };
	const _out = await broken( { answers: [ null, { text: 'fixed' } ], board: _board } ).run( { move: 'report.draft' }, ctx() );
	assert.deepEqual( _out.value, { text: 'fixed' } );
} );

attack( EXEC, '6.4: a ticket about a broken answer that nobody answers fails the move, it never retries on its own', async () => {
	const _board = new Board( memoryLog(), { sweepMs: 10 } );
	const _exec = broken( { board: _board } );
	const _ctx = ctx();
	_ctx.node.contract.deadline = new Date( Date.now() + 50 ).toISOString();
	await assert.rejects( within( _exec.run( { move: 'report.draft' }, _ctx ), 2000 ), /step contract/ );
} );

attack( EXEC, '6.4: without a ticket board a broken answer simply fails the move', async () => {
	await assert.rejects( broken().run( { move: 'report.draft' }, ctx() ), /step contract/ );
} );

attack( EXEC, '6.4: a stub model whose answer breaks the contract is refused by the provider, never returned as a value', async () => {
	const _stub = new StubProvider( { answers: { writer: { text: 'ok', secret: 'extra field' } } } );
	const _exec = executor( { provider: _stub } );
	await assert.rejects( _exec.run( { move: 'report.draft' }, ctx() ), /step contract: secret is not part of the contract/ );
} );

attack( EXEC, 'a long answer inside the contract is taken whole: the contract, not the length, decides', async () => {
	const _text = 'x'.repeat( 100000 );
	const _out = await executor( { provider: new StubProvider( { answers: { writer: { text: _text } } } ) } ).run( { move: 'report.draft' }, ctx() );
	assert.equal( _out.value.text.length, 100000 );
} );

attack( EXEC, 'a model that never answers is ended by the lease of its move, never waited for longer (A1, A3)', async () => {
	const _exec = executor( { provider: { complete: never } } );
	const _gate = fakeGate();
	const _supervisor = new Supervisor( { gate: _gate, beatMs: 15000 } );
	const _ctx = ctx();
	const _move = { ..._exec.catalog.get( 'report.draft' ), leaseMaxMin: 0.001 };
	const _out = await within( _supervisor.hold( _ctx.node, { move: 'report.draft' }, _move, lease => _exec.run( { move: 'report.draft' }, { ..._ctx, lease } ) ), 2000 );
	assert.deepEqual( _out, { leaseExpired: true } );
} );

// --- real scripts in the development runtime ---

const real = timeoutSeconds => ( { moves: { 'x.script': { ...TOOL, tool: null } }, runtime: new ProcessRuntime( { timeoutSeconds } ) } );
const script = ( file, seconds = 5 ) => {
	const _options = real( seconds );
	_options.moves[ 'x.script' ].tool = `${FIXTURES}/${file}`;
	return executor( _options ).run( { move: 'x.script' }, ctx() );
};

attack( EXEC, 'a real script that prints no JSON fails its move', async () => {
	await assert.rejects( within( script( 'invalid-json.py' ), 8000 ), SyntaxError );
} );

attack( EXEC, 'a real script that exits with 3 fails its move, with its exit code', async () => {
	await assert.rejects( within( script( 'exit-3.py' ), 8000 ), /exit code 3/ );
} );

attack( EXEC, 'a real script that prints five megabytes is read whole', async () => {
	const _out = await within( script( 'huge.py' ), 8000 );
	assert.equal( _out.value.blob.length, 5 * 1024 * 1024 );
} );

attack( EXEC, 'a real script that never ends is killed by the runtime\'s time limit and fails its move', async () => {
	await assert.rejects( within( script( 'endless.py', 1 ), 8000 ), /exit code/ );
} );

attacks( EXEC, [
	{ name: '5.6: an option that names a class decides it', classes: { 'the week after': 'later' }, choice: 'the week after', want: 'later' },
	{ name: '5.6: an option without a class decides nothing', classes: { 'the week after': 'later' }, choice: 'drop it', want: null },
	{ name: '5.6: no map of classes decides nothing', classes: undefined, choice: 'the week after', want: null },
	{ name: '5.6: a class that is no plain name decides nothing', classes: { x: 'Later Class' }, choice: 'x', want: null },
	{ name: '5.6: an inherited name is no option of the map', classes: {}, choice: 'constructor', want: null },
	{ name: '5.6: a class that is no text decides nothing', classes: { x: { class: 'later' } }, choice: 'x', want: null },
], ( { classes, choice, want } ) => {
	assert.equal( Executor.decided( classes, choice ), want );
} );
