// Carries out one step of a checked plan. Code runs in the sandbox; an AI step gets only the values of its
// inputs (no labels, no ids, no cohorts) and must answer in its step contract; actions leave only through the
// gate. Every output carries labels (and, for aggregates, the cohort it was computed from).

app.define( 'Core.Move.Executor', [ 'Core.Label.Flow', 'Core.Budget.Pot', 'Core.Ticket.Board' ], ( Flow, Pot, Board ) => class Executor {

	// What the model may hear of its failed code (6.4): the kind of error only if it is one of Python's built-in
	// exceptions; anything else could be a value of the data under another name.
	static ERRORS = new Set( [
		'BaseException', 'Exception', 'ArithmeticError', 'AssertionError', 'AttributeError', 'BufferError', 'EOFError', 'FloatingPointError',
		'GeneratorExit', 'ImportError', 'ModuleNotFoundError', 'IndexError', 'KeyError', 'KeyboardInterrupt', 'LookupError', 'MemoryError',
		'NameError', 'NotImplementedError', 'OSError', 'OverflowError', 'RecursionError', 'ReferenceError', 'RuntimeError', 'StopIteration',
		'StopAsyncIteration', 'SyntaxError', 'IndentationError', 'TabError', 'SystemError', 'SystemExit', 'TypeError', 'UnboundLocalError',
		'UnicodeError', 'UnicodeEncodeError', 'UnicodeDecodeError', 'UnicodeTranslateError', 'ValueError', 'ZeroDivisionError', 'TimeoutError',
		'ConnectionError', 'BrokenPipeError', 'ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError', 'BlockingIOError',
		'ChildProcessError', 'FileExistsError', 'FileNotFoundError', 'InterruptedError', 'IsADirectoryError', 'NotADirectoryError',
		'PermissionError', 'ProcessLookupError', 'ExceptionGroup', 'BaseExceptionGroup', 'Warning', 'UserWarning', 'DeprecationWarning',
		'PendingDeprecationWarning', 'SyntaxWarning', 'RuntimeWarning', 'FutureWarning', 'ImportWarning', 'UnicodeWarning', 'BytesWarning',
		'ResourceWarning', 'EncodingWarning',
	] );

	constructor( { catalog, runtime, provider, gate, log, board = null, soft = null, expectations = null } ) {
		Object.assign( this, { catalog, runtime, provider, gate, log, board, soft, expectations } );
	}

	async run( step, ctx ) {
		const _move = this.catalog.get( step.move );
		// The five base moves (6.1). A code move with an action is trusted code that hands the action to the gate.
		const _code = _move.action ? '_act' : '_code';
		const _handler = { code: _code, ai: '_ai', child: '_child', human: '_human', wait: '_wait' }[ _move.executor ];
		if ( !_handler ) {
			throw new Error( `executor ${_move.executor} is not available in this version` );
		}
		return this[ _handler ]( step, _move, ctx );
	}

	async _code( step, move, ctx ) {
		// Trusted code of the core itself, e.g. checking and registering a proposal for the catalog (6.1) or finding
		// knowledge through the read gate (9.1).
		if ( move.trusted ) {
			return ctx.runner.trusted( move.trusted, step, ctx );
		}
		const _inputs = this._inputs( step, ctx );
		const _framed = move.agentCode ? await this._framed( step, move, ctx, _inputs ) : null;
		const _given = { ...( step.params || {} ), inputs: _inputs.map( item => item.value ) };
		const _out = _framed ? _framed.out : await this._sandbox( step, move.tool, _given, ctx.mission.dataDir, ctx );
		// The cohort of code a model wrote comes from the frame's own run, never from what that code printed.
		if ( _framed ) { _out.cohort = _out.wall ? null : _framed.cohort; }
		const _labels = Flow.derive( move, _inputs.map( item => item.labels ) );
		// Trusted code may label each field of its result (an account from the master data, an amount from a document),
		// and a move may declare its result an observation of the system, e.g. a count over the vault.
		// 6.4, 7.1: a wall about code a model wrote (one with a repair report, or any wall of the frame's check) is said in
		// the core's own words, from the report and the core's own lists, never in the frame's text. A wall is logged, the
		// log is what a demo shows, and a key, an error class or a message the code made up would otherwise leave through
		// any frame that quotes it.
		const _written = _inputs.map( item => item.value?.code ).filter( text => typeof text === 'string' ).join( '\n' );
		if ( _out.wall && ( _out.wall.repair || ( _framed && !_framed.unchecked ) ) ) { _out.wall = Executor.told( _out.wall, _written ); }
		// 6.4: code a model wrote that fails in its trusted frame gets one repair. The model writes it again and hears
		// only what the frame reports (the kind of error and its line, or the keys that broke the schema), never data.
		const _repair = _out.wall?.repair && [ { says: Executor.repair( _out.wall.repair, _written ) } ];
		if ( _repair && await this._rework( step, ctx, _repair, 'code_repair' ) ) {
			return this._code( step, move, ctx );
		}
		const _facts = move.fact && !_out.wall ? [ {
			kind: move.fact, evidenceClass: 'observation', source: `sandbox ${step.move}`, origin: 'system',
			data: move.about ? { about: _out.value?.[ move.about ], ..._out.value } : _out.value,
		} ] : [];
		return { value: _out.value, cohort: _out.cohort || null, labels: _labels, fieldLabels: _out.fieldLabels || null,
			wall: _out.wall || null, facts: _facts };
	}

	// One run of a script in a fresh sandbox; what it prints is parsed as JSON.
	async _sandbox( step, tool, input, dataDir, ctx ) {
		const _script = app.lib( 'node:fs' ).readFileSync( Executor.script( tool, ctx.mission ), 'utf8' );
		const _run = await this.runtime.run( { script: _script, input, dataDir, node: ctx.node.id } );
		if ( _run.exitCode !== 0 ) {
			throw new Error( `${step.move} failed with exit code ${_run.exitCode}: ${_run.stderr.slice( -300 )}` );
		}
		return JSON.parse( _run.stdout );
	}

	// 6.1, 7.1: code a model wrote runs in a sandbox run of its own, with no data but the rows the trusted frame prepared
	// for it. The frame prepares with the mission's data and checks the result without it, each in a run of its own; the
	// cohort stays with the executor. Code that breaks out of its restricted built-ins can neither see more nor forge
	// what the frame says.
	// A result counts only when the frame says it checked it against figures of its own (4e); a frame that checks only
	// its shape lets made-up figures through, so its result is a wall (fail closed). A wall of the prepare run is the
	// frame's own, about the data: no code a model wrote has run yet (unchecked).
	async _framed( step, move, ctx, inputs ) {
		const _prepared = await this._sandbox( step, move.tool, { ...( step.params || {} ), phase: 'prepare' }, ctx.mission.dataDir, ctx );
		if ( _prepared.wall ) { return { out: _prepared, cohort: null, unchecked: true }; }
		const { rows: _rows, ...prepared } = _prepared.value;
		const _code = inputs[ 0 ]?.value?.code ?? '';
		const _ran = await this._sandbox( step, move.agentCode, { code: _code, rows: _rows }, null, ctx )
			.catch( () => ( { problem: 'the code did not finish within its limits' } ) );
		const _checked = await this._sandbox( step, move.tool, { phase: 'check', prepared, ran: _ran }, null, ctx );
		const _out = _checked.wall || _checked.verified === true ? _checked
			: { value: null, wall: { cause: 'move_failed', repair: { problem: 'the frame did not check the figures' } } };
		return { out: _out, cohort: _prepared.cohort || null };
	}

	async _ai( step, move, ctx ) {
		const _inputs = this._inputs( step, ctx );
		// Writers of outgoing text get the user's soft rules up front, and on a rework what they broke.
		const _soft = move.outbound && this.soft ? ` ${this.soft.instructions( move.outbound )}` : '';
		const _rework = ctx.feedback ? ` Your previous answer could not be used; write it again. ${ctx.feedback.map( item => item.says ).join( ' ' )}` : '';
		const _request = { role: move.role, instructions: `${move.instructions}${_soft}${_rework}`, input: _inputs.map( item => item.value ),
			contract: move.contract, node: ctx.node.id };
		const _answer = await this._complete( _request, step, ctx );
		return { value: _answer, labels: Flow.derive( move, _inputs.map( item => item.labels ) ), cohort: Executor.union( _inputs ) };
	}

	// 6.4: an answer that breaks its step contract (even after the one repair) is not used; it goes to a person with
	// the reason, who may let the model try once more or stop the step.
	async _complete( request, step, ctx ) {
		for ( ;; ) {
			try {
				return await this.provider.complete( request );
			} catch ( error ) {
				// The person's minutes are booked like any cost, and asked for only when the pot can pay them (P1).
				if ( !this.board || !/step contract/.test( error.message ) || !Pot.fits( ctx.node, Executor.HELP_MINUTES ) ) { throw error; }
				Pot.book( ctx.node, { what: 'help ticket', humanMinutes: Executor.HELP_MINUTES } );
				const _answer = await this.board.ask( ctx.node, {
					question: `The model's answer for ${step.move} broke its step contract: ${error.message}. What now?`,
					options: [ 'let the model try once more', 'stop this step' ], recommendation: 'stop this step', minutes: Executor.HELP_MINUTES, kind: 'help',
					reason: 'the step contract was broken (6.4)',
				} );
				if ( _answer.choice !== 'let the model try once more' ) { throw error; }
			}
		}
	}

	static HELP_MINUTES = 2;

	async _act( step, move, ctx ) {
		let _request = this._request( step, move, ctx );
		let _flags = this.soft ? this.soft.check( move.action, _request.params ) : [];
		if ( _flags.length && await this._rework( step, ctx, _flags ) ) {
			_request = this._request( step, move, ctx );
			_flags = this.soft.check( move.action, _request.params );
		}
		const _expectation = this._expect( step, move, ctx, _request );
		const _decision = await this.gate.submit( { ..._request, flags: _flags.length ? _flags : undefined } );
		const _sent = { action: move.action, target: step.target || null, params: _request.params, cohort: _request.cohort };
		return { decision: _decision, ..._sent, expectation: _expectation?.id || null };
	}

	// An action that asks for an answer leaves an expectation. Its key is fixed and written into the action before
	// anything leaves (6.2), so the reply can be matched by code. The same action of the same attempt, sent again (a
	// restart took it up again), keeps the open expectation and its key: answers to the first one still count.
	_expect( step, move, ctx, request ) {
		const _spec = move.creates?.expectation;
		if ( !_spec || !this.expectations ) { return null; }
		const _attempt = ctx.node.plan?.attempt ?? null;
		const _same = item => item.node === ctx.node.id && item.origin === step.target && item.fact === _spec.fact
			&& ( item.spec?.attempt ?? null ) === _attempt && item.status === 'open';
		const _open = _attempt === null ? null : ( this.expectations.listening?.() || [] ).find( _same );
		const _key = _open?.keys?.[ 0 ] || `${_spec.prefix || 'K'}-${app.lib( 'node:crypto' ).randomUUID().slice( 0, 6 ).toUpperCase()}`;
		request.params[ _spec.key ] = _key;
		request.labels[ _spec.key ] = [ 'own' ];
		if ( _open ) { return _open; }
		return this.expectations.create( ctx.node, {
			from: step.target, fact: _spec.fact, need: Number( step.params?.need ?? _spec.need ?? 1 ),
			minutes: Number( _spec.minutes ?? 60 ),
			keys: [ _key ], extract: _spec.extract, parser: _spec.parser, store: _spec.store, attempt: ctx.node.plan?.attempt ?? null,
			carry: _spec.carry || [], validHours: _spec.validHours ?? null, about: _spec.about ?? null, each: _spec.each ?? null,
		} );
	}

	// Waiting (a base move, 6.1): until the expectation has what it needs, or its time is up. A timeout is a result
	// that ends the attempt (8.2); the expectation stays open, so a late answer still counts.
	async _wait( step, move, ctx ) {
		if ( step.params?.node ) {
			return this._waitForNode( step, ctx );
		}
		// The expectation the step names; else, as after a restart that lost the values, the latest of the node, never a new one.
		const _named = step.for && ctx.values[ step.for ]?.expectation;
		const _expectation = ( _named && this.expectations.get( _named ) ) || this.expectations.latest( ctx.node.id );
		if ( !_expectation ) {
			throw new Error( `${step.move}: nothing to wait for` );
		}
		const _minutes = step.params?.minutes ?? move.minutes;
		const _until = _minutes ? new Date( Date.now() + Number( _minutes ) * 60000 ).toISOString() : null;
		ctx.node.emit( 'waiting_for', { expectation: _expectation.id, from: _expectation.origin, need: _expectation.need, until: _until || _expectation.until } );
		const _stop = () => Boolean( ctx.node.stopping || ctx.node.plan?.cancelled );
		const _result = await this.expectations.wait( _expectation.id, { until: _until, stop: _stop } );
		ctx.node.emit( 'wait_ended', { expectation: _expectation.id, ..._result } );
		const _value = { value: _result, labels: [ 'own' ], cohort: null, facts: [] };
		if ( _result.status === 'met' ) {
			return _value;
		}
		const _cause = _result.status === 'stopped' ? 'aborted' : 'no_reaction';
		return { ..._value, wall: { cause: _cause, reason: `${_result.count} of ${_result.need} expected answers before the deadline` } };
	}

	// "Rework" (chapter 7.3): the model step that wrote the text runs once more with the broken rules named. Only the
	// step that produced this step's input is asked: a step without an input has no author to ask. Its call is a model
	// step like any other, booked in the pot, and only when the pot can pay for it (Z6).
	async _rework( step, ctx, flags, kind = 'soft_rework' ) {
		const [ _name ] = Flow.inputs( step );
		const _producer = _name === undefined ? null : ( ctx.plan || [] ).find( item => item.as === _name );
		const _move = _producer && this.catalog.get( _producer.move );
		if ( !_move || _move.executor !== 'ai' || ctx.reworked?.has( _name ) || !Pot.fits( ctx.node, Pot.price( _move ).total ) ) {
			return false;
		}
		ctx.reworked = ctx.reworked || new Set();
		ctx.reworked.add( _name );
		ctx.node.emit( kind, { value: _name, broken: flags } );
		Pot.book( ctx.node, { what: `${_producer.move} (${kind})`, ...Pot.price( _move ) } );
		ctx.values[ _name ] = await this._ai( _producer, _move, { ...ctx, feedback: flags } );
		return true;
	}

	// Where a tool's script is: "./tools/x.py" in the mission's own folder (a company keeps its missions where it
	// likes), anything else in the engine's folder (sandbox/tools). A path that climbs out of its folder is refused.
	static script( tool, mission = null ) {
		const _path = app.lib( 'node:path' );
		if ( typeof tool !== 'string' || !tool ) { throw new Error( 'a code move names no tool' ); }
		const _base = tool.startsWith( './' ) && mission?.dir ? _path.resolve( mission.dir ) : _path.resolve( app.root );
		const _file = _path.resolve( _base, tool );
		if ( !_file.startsWith( `${_base}${_path.sep}` ) ) { throw new Error( `the tool ${tool.slice( 0, 80 )} lies outside its folder` ); }
		return _file;
	}

	// 6.4, the repair report a frame gives about code a model wrote, as the core reads it: { error, line } (a built-in
	// kind of error), { schema, keys } or { differs, keys } (the schema's own keys; any other is "an unknown key"),
	// { failed, of } (counts), or { problem } (one of PROBLEMS). Anything else is "unknown": a frame may pass on what the
	// code printed, and that could quote a value of the data. → { about: 'code' | 'result', text }
	// written: the code the model wrote. A NameError may name what it misses only when that name is a word of this code
	// (names are compiled from its text): code that forged the report can choose among its own words, never say data.
	static fault( report = {}, written = '' ) {
		const _report = report && typeof report === 'object' ? report : {};
		if ( _report.error ) {
			const _kind = Executor.ERRORS.has( _report.error ) ? _report.error : 'an error';
			const _word = typeof _report.name === 'string' && /^[A-Za-z_]\w{0,39}$/.test( _report.name )
				&& new RegExp( `\\b${_report.name}\\b` ).test( String( written ) );
			const _name = _kind === 'NameError' && _word ? ` (no ${_report.name} here)` : '';
			return { about: 'code', text: `raised ${_kind}${_name}${Number.isSafeInteger( _report.line ) && _report.line > 0 ? ` in line ${_report.line}` : ''}` };
		}
		const _keys = Array.isArray( _report.keys ) ? _report.keys : [];
		const _named = list => [ ...new Set( [].concat( list ).map( key => ( _keys.includes( key ) ? key : 'an unknown key' ) ) ) ].join( ', ' );
		if ( _report.schema ) { return { about: 'result', text: `broke its schema at: ${_named( _report.schema )}` }; }
		if ( _report.differs ) { return { about: 'result', text: `has wrong figures at: ${_named( _report.differs )}` }; }
		const _count = value => Number.isSafeInteger( value ) && value >= 0;
		if ( _count( _report.failed ) && _count( _report.of ) ) { return { about: 'code', text: `failed ${_report.failed} of ${_report.of} cases` }; }
		return { about: 'code', text: `was not usable: ${Executor.PROBLEMS.has( _report.problem ) ? _report.problem : 'unknown'}` };
	}

	static PROBLEMS = new Set( [
		'no code', 'no result', 'result is not plain data', 'result is not a dict', 'the code did not finish within its limits',
		'it returned no results', 'it ran longer than its time limit', 'it printed more than allowed', 'it wrote files',
		'the function it was asked for is missing', 'the acceptance tests are missing', 'the frame did not check the figures',
	] );

	// What a model hears for its one repair.
	static repair( report, written = '' ) {
		const { about, text } = Executor.fault( report, written );
		return `Your ${about} ${text}.${report?.differs ? ' Compute exactly what the instructions ask for.' : ''}`;
	}

	// The wall a person and the log see: the same report in the core's words; the frame's own text is not kept.
	static told( wall, written = '' ) {
		const { about, text } = Executor.fault( wall.repair, written );
		return { cause: wall.cause || 'move_failed', reason: `the agent's ${about} ${text}`, ...( wall.repair ? { repair: wall.repair } : {} ) };
	}

	// Waiting for another node to close, e.g. a sibling (an edge of the wait graph, R4).
	async _waitForNode( step, ctx ) {
		const _runner = ctx.runner;
		const _other = _runner.nodes.get( step.params.node );
		if ( !_other ) { throw new Error( `${step.move}: no node ${step.params.node}` ); }
		_runner.waits.add( ctx.node.id, _other.id );
		try {
			while ( _other.state !== 'closed' && !ctx.node.stopping ) {
				await new Promise( resolve => setTimeout( resolve, _runner.pollMs ) );
			}
		} finally {
			_runner.waits.remove( ctx.node.id, _other.id );
		}
		return { value: { node: _other.id, result: _other.result?.status || null }, labels: [ 'own' ], cohort: null, facts: [] };
	}

	// What follows a request at the gate: a person's approval outside any lease (a person is no worker), then the token
	// under a fresh lease (O1, A6, F4), then the operation until it is final (O7). leased( work ) runs work under a new
	// lease and answers { leaseExpired } when it ran out first; waiting( decision ) is told when a person is asked.
	async conclude( decision, { leased, pollMs = 500, stop = () => false, waiting = () => {} } ) {
		let _decision = decision;
		if ( _decision.status === 'awaiting_approval' ) {
			waiting( _decision );
			_decision = await this.settle( _decision, { pollMs, stop } );
			if ( _decision.status !== 'approved' ) { return _decision; }
			const _redeemed = await leased( async lease => ( { decision: await this.redeem( _decision, lease ) } ) );
			if ( _redeemed.leaseExpired ) { return { ..._decision, leaseExpired: true }; }
			_decision = { ..._redeemed.decision, approval: decision.approval };
		}
		if ( _decision.status === 'open' ) {
			_decision = { ...await this.settle( _decision, { pollMs, stop } ), approval: decision.approval };
		}
		return _decision;
	}

	// The worker presents the token of an approved action under its lease (O1, A6, F4).
	async redeem( decision, lease ) {
		const _token = { delivery: decision.delivery, approval: decision.approval, lease: lease?.id || null, fence: lease?.fence ?? null };
		const _result = await this.gate.redeem( _token );
		return { ..._result, approval: decision.approval };
	}

	// An action waiting for a person or still being delivered is followed at the gate until a person decided or it is
	// final. Only the gate knows; the core asks again and again, it is never told by anyone else (A6).
	async settle( decision, { pollMs = 500, stop = () => false } = {} ) {
		let _state = decision;
		while ( [ 'awaiting_approval', 'open' ].includes( _state.status ) && !stop() ) {
			await new Promise( resolve => setTimeout( resolve, pollMs ) );
			const _row = await this.gate.delivery( decision.delivery );
			const { status, reasons, receipt } = _row;
			_state = { delivery: decision.delivery, status, reasons, receipt, approval: decision.approval };
		}
		return _state;
	}

	_request( step, move, ctx ) {
		const [ _input ] = this._inputs( step, ctx );
		const _params = { ...( step.params || {} ) };
		// 10.4: a parameter carries the labels of its value; where trusted code labelled a field of its result (an account
		// from the master data in a foreign document), that field carries those labels. Labels written into the step are
		// added, never put in place of what the value carries.
		const _union = ( ...lists ) => [ ...new Set( lists.flatMap( list => [].concat( list ?? [] ) ) ) ];
		const _labels = {};
		if ( _input && move.param ) {
			_params[ move.param ] = _input.value?.text ?? _input.value;
			_labels[ move.param ] = _union( _input.labels );
		} else if ( _input ) {
			Object.assign( _params, _input.value );
			for ( const name of Object.keys( _input.value || {} ) ) {
				const _field = _input.fieldLabels && Object.hasOwn( _input.fieldLabels, name ) ? _input.fieldLabels[ name ] : null;
				_labels[ name ] = _union( _field ?? _input.labels );
			}
		}
		for ( const [ name, labels ] of Object.entries( step.labels || {} ) ) {
			_labels[ name ] = _union( _labels[ name ], labels );
		}
		return {
			contract: ctx.node.contract.hash, node: ctx.node.id, action: move.action, target: step.target || null,
			params: _params, labels: _labels, cohort: _input?.cohort || null,
			lease: ctx.lease?.id || null, fence: ctx.lease?.fence ?? null,
		};
	}

	// A child gets its own goal from the mission's template and inherits every invariant of its parent by
	// construction; G1 checks that again. It runs the very same loop, and only proven results come back as facts.
	async _child( step, move, ctx ) {
		const _parent = ctx.node;
		// An item an earlier step of this plan settled (a trusted tool found the invoice paid) has its evidence: its
		// child is not started, as no later attempt plans one for it (Plan.resolve). Nothing would be done twice.
		const _settled = ( _parent.valid ? _parent.valid() : _parent.facts || [] )
			.some( fact => fact.kind === 'item_resolved' && String( fact.data?.item ?? '' ).trim() === String( step.item ?? '' ).trim() );
		if ( _settled && step.item !== undefined ) {
			return { child: { id: null, status: 'settled', item: step.item, gates: [] }, facts: [] };
		}
		const _path = app.lib( 'node:path' ).join( ctx.mission.dir, move.template );
		const [ Plan ] = await app.use( [ 'Core.Loop.Plan' ] );
		const _template = Plan.substitute( JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) ), step.item );
		const _spec = ctx.runner.constructor.childSpec( _parent, {
			id: step.item,
			goal: _template.goal,
			criteria: _template.criteria,
			serves: { ..._template.serves, precondition: step.item },
			budget: _template.budget,
			value: _template.value,
		}, move.bufferMinutes ?? 5 );
		const _child = await ctx.runner.spawn( _parent, _spec );
		const _facts = _child.result?.status === 'fulfilled' ? _child.facts.filter( fact => fact.kind === 'item_resolved' ) : [];
		// A child that failed reports the strategy gates that stopped it with its wall (21).
		const _gates = _child.result?.status === 'fulfilled' ? [] : ctx.runner.judgment.constructor.gatesOf( _child );
		return { child: { id: _child.id, status: _child.result?.status, item: step.item, gates: _gates }, facts: _facts };
	}

	// A person decides. The answer is a confirmation (the strongest evidence class after an observation) and can
	// settle an item, e.g. an invoice handed to a person.
	async _human( step, move, ctx ) {
		if ( !this.board ) {
			throw new Error( 'no ticket board to ask a person' );
		}
		const _p = step.params || {};
		// 8.4: the ticket carries only the context needed: the inputs the step names, nothing confidential.
		const _names = Flow.inputs( step );
		const _answer = await this.board.ask( ctx.node, {
			question: _p.question, options: _p.options || move.options, recommendation: _p.recommendation || null,
			deadline: ctx.node.contract.deadline, minutes: move.humanMinutes ?? 2,
			excerpt: _names.length ? { inputs: Board.inputs( _names, this._inputs( step, ctx ) ) } : null,
		} );
		if ( _answer.reason === 'cancelled' ) {
			return { value: _answer, labels: [ 'own' ], cohort: null, facts: [], person: true };
		}
		if ( !_answer.choice ) {
			// Nobody answered in time, or the ticket was withdrawn: no reaction is a result, not an error (8.2).
			return { value: _answer, labels: [ 'own' ], cohort: null, facts: [], person: true,
				wall: { cause: 'no_reaction', reason: _answer.withdrawn ? 'the ticket was withdrawn' : 'nobody answered in time' } };
		}
		const _facts = move.resolves && _p[ move.resolves.item ] ? [ {
			kind: 'item_resolved', evidenceClass: 'confirmation', source: `person ${_answer.by}`,
			data: { item: _p[ move.resolves.item ], outcome: move.resolves.outcome, choice: _answer.choice, about: _p[ move.resolves.item ],
				value: move.resolves.outcome },
		} ] : [];
		// 5.6: an option may name a class of strategies ("classes": { option: class }). At a wall, the person's choice is
		// the diagnosis of that wall: it is learned, and the next strategy is one of that class. Without a wall, or for an
		// option that names no class, the answer is just the answer.
		const _class = Executor.decided( _p.classes, _answer.choice );
		const r = ctx.runner;
		const _wall = _class && r?.mission ? app.get( 'Core.Strategy.Chooser' ).decide( ctx.node, _class, _answer.by,
			{ strategies: r.mission.strategies, kind: r.mission.kind, memory: r.memory, diagnosis: r.diagnosis } ) : null;
		if ( _wall ) {
			return { value: _answer, labels: [ 'own' ], cohort: null, facts: _facts, person: true, wall: _wall };
		}
		// A person as the channel (3.4): the answer confirms a criterion, or exactly this question of a role (14.1).
		if ( move.confirms ) {
			const [ ConfirmedBy ] = await app.use( [ 'Core.Criteria.ConfirmedBy' ] );
			_facts.push( {
				kind: 'confirmation', evidenceClass: 'confirmation', source: `person ${_answer.by}`,
				data: { criterion: _p.criterion || null, role: _p.role || 'client', question: ConfirmedBy.key( _p.question ), choice: _answer.choice },
			} );
		}
		return { value: _answer, labels: [ 'own' ], cohort: null, facts: _facts, person: true };
	}

	// The class an option names: a plain name, from the step's own map, never one of Object.prototype.
	static decided( classes, choice ) {
		const _class = classes && typeof classes === 'object' && typeof choice === 'string' && Object.hasOwn( classes, choice ) ? classes[ choice ] : null;
		return typeof _class === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test( _class ) ? _class : null;
	}

	_inputs( step, ctx ) {
		return Flow.inputs( step ).map( ( name ) => {
			if ( !ctx.values[ name ] ) { throw new Error( `${step.move}: input ${name} is not available` ); }
			return ctx.values[ name ];
		} );
	}

	static union( inputs ) {
		const _cohorts = inputs.map( item => item.cohort ).filter( Boolean );
		return _cohorts.length ? [ ...new Set( _cohorts.flat() ) ].sort() : null;
	}

} );
