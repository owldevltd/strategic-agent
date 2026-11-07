// Restart (chapters 18.1, 18.4, 18.6, Z4, G-1c). The state of every node follows from its events. After the
// core went down, each unfinished goal is rebuilt from the log: contract (the amended one, if the client changed it),
// state, version, result, facts, conflicts, the queue, walls, attempts, costs and children. Only what the log can
// prove is taken: a transition table 16.1 does not allow, or one that does not continue from the node's state, makes
// the log of that run damaged; the run is not resumed (an alarm says so), the other runs are. Children run to their end
// first, then their parents (bottom-up). A move that was running when the core stopped counts as aborted (its lease
// has run out at the gate meanwhile, A4), unless it can go on where it stood (a wait whose expectation is still open, a
// child step); whatever the node's moves left at the gate is settled (A3, O9), what was executed becomes a fact, and
// the node judges again. Overdue deadlines are handled at once, within the restart buffer.

app.define( 'Core.Loop.Restore', [ 'Core.Contract.Contract', 'Core.Node.Node', 'Core.Node.Machine', 'Core.Loop.Plan' ],
	( Contract, Node, Machine, Plan ) => class Restore {

		// The events a rebuild applies (event kinds are data, snake_case), each with its handler; any other kind changes
		// nothing, whatever it is called.
		static HANDLERS = new Map( [
			[ 'state_changed', '_onStateChanged' ], [ 'fact_delivered', '_onFactDelivered' ], [ 'fact_superseded', '_onFactSuperseded' ],
			[ 'fact_queued', '_onFactQueued' ], [ 'credited', '_onCredited' ], [ 'wall', '_onWall' ], [ 'cost_booked', '_onCostBooked' ],
			[ 'budget_reserved', '_onBudgetReserved' ], [ 'budget_reallocated', '_onBudgetReserved' ], [ 'budget_returned', '_onBudgetReturned' ],
			[ 'delivery_started', '_onDeliveryStarted' ], [ 'verdict', '_onVerdict' ], [ 'abort_received', '_onAbortReceived' ],
			[ 'contract_confirmed', '_onContractConfirmed' ], [ 'contract_amended', '_onContractAmended' ], [ 'plan_accepted', '_onPlanAccepted' ],
			[ 'move_started', '_onMoveStarted' ], [ 'move_ended', '_onMoveEnded' ],
		] );

		// U4: the answers to an escalation that grant the single retry.
		static RETRIES = [ 'try once more', 'lift these gates and try once more' ];

		// Runs in the log that still have an open root: [ { run, mission, vault } ].
		static unfinished( log ) {
			const _events = log.since( 0, 1e9 );
			const _closed = new Set( _events.filter( event => event.kind === 'state_changed' && event.data?.to === 'closed' ).map( event => event.node ) );
			const _open = new Set( _events.filter( event => event.kind === 'node_created' && !event.data?.parent && !_closed.has( event.node ) )
				.map( event => event.data?.run ) );
			return _events.filter( event => event.kind === 'run_started' && _open.has( event.data?.run ) ).map( event => event.data );
		}

		constructor( runner ) {
			this.runner = runner;
			this.damaged = [];
		}

		// Rebuilds the nodes of this run from the log; → the open roots, none when the run's log is damaged. A contract
		// that does not match its hash is refused at once (18.1).
		rebuild( events = this.runner.log.since( 0, 1e9 ) ) {
			this.damaged = [];
			const { nodes } = this.runner;
			const _created = events.filter( event => event.kind === 'node_created' && event.node && event.data?.run === this.runner.id );
			for ( const event of _created ) {
				const _contract = new Contract( event.data.spec, this.runner.registry );
				if ( _contract.hash !== event.data.contract?.hash ) {
					throw new Error( `node ${event.node}: the contract in the log does not match its hash` );
				}
				const _node = new Node( { contract: _contract, log: this.runner.log, id: event.node } );
				// rebuilt: what only the rebuild needs (costs and log place of each attempt, attempts a retry or R7 cleared).
				const _rebuilt = { spentAt: {}, planAt: {}, forget: new Set(), missing: new Set(), seen: [] };
				Object.assign( _node, { createdAt: event.id, inbox: [], rebuilt: _rebuilt } );
				nodes.set( _node.id, _node );
			}
			// Parents and owners only once every node exists: a child logged before its parent still finds it.
			for ( const event of _created ) {
				const _node = nodes.get( event.node );
				const _parent = event.data.parent ? nodes.get( event.data.parent ) : null;
				if ( _parent && _parent !== _node ) {
					_node.parent = _parent;
					_parent.children.push( _node );
				}
				nodes.get( event.data.owner )?.processes.push( _node );
			}
			_created.forEach( event => this._depth( nodes.get( event.node ) ) );
			const _ids = new Set( _created.map( event => event.node ) );
			// An event of this run that cannot be read: the log was changed, so the run stays where it is (18.1).
			const _damaged = events.find( item => item.damaged && _ids.has( item.node ) );
			if ( _damaged ) {
				throw new Error( `node ${_damaged.node}: event ${_damaged.id} in the log cannot be read` );
			}
			for ( const event of events.filter( item => _ids.has( item.node ) ) ) {
				this._apply( nodes.get( event.node ), event );
			}
			for ( const node of _created.map( event => nodes.get( event.node ) ) ) {
				node.inbox = node.inbox.filter( fact => !node.facts.some( item => item.id === fact.id ) );
				node.reserved = Number.isFinite( node.reserved ) ? node.reserved : 0;
				this._attempts( node );
			}
			if ( this.damaged.length ) {
				this.runner.log.append?.( 'alarm', { run: this.runner.id, quarantined: true, damaged: this.damaged.slice( 0, 20 ),
					reason: 'the log of this run is damaged; the run is not resumed, a person checks it (18.6)' } );
				return [];
			}
			return _created.filter( event => !event.data.parent ).map( event => nodes.get( event.node ) ).filter( node => node.state !== 'closed' );
		}

		// The depth from the chain of parents; a node that is its own ancestor damages the log.
		_depth( node ) {
			let _depth = 0;
			const _seen = new Set( [ node ] );
			for ( let at = node.parent; at; at = at.parent ) {
				if ( _seen.has( at ) ) {
					this.damaged.push( { node: node.id, event: node.createdAt ?? null, reason: 'the node is its own ancestor' } );
					break;
				}
				_seen.add( at );
				_depth++;
			}
			node.depth = _depth;
		}

		_apply( node, event ) {
			const _method = Restore.HANDLERS.get( event.kind ) || null;
			if ( !_method ) { return; }
			// Damaged data of an event is skipped, never applied half (a fact that is no object, costs without numbers); a
			// transition that cannot be read damages the log.
			if ( !event.data || typeof event.data !== 'object' || Array.isArray( event.data ) ) {
				if ( event.kind === 'state_changed' ) { this.damaged.push( { node: node.id, event: event.id ?? null, reason: 'a transition without data' } ); }
				return;
			}
			this[ _method ]( node, event.data, event );
		}

		// Z3, Z4: only a transition of table 16.1 that continues from the node's state; anything else damages the log.
		_onStateChanged( node, data, event ) {
			if ( data.from !== node.state || !Machine.allowed( node.state, data.to ) ) {
				this.damaged.push( { node: node.id, event: event.id ?? null, reason: `${String( data.from )} → ${String( data.to )} does not continue from ${node.state}` } );
				return;
			}
			node.state = data.to;
			// nodeVersion is the version after the move (Z4).
			const _logged = Number.isSafeInteger( event.nodeVersion ) && event.nodeVersion > node.version;
			node.version = _logged ? event.nodeVersion : node.version + 1;
			// 16.3: the result decided before closing comes with the transition to closing, the final one with closed.
			if ( data.result && typeof data.result === 'object' && typeof data.result.status === 'string' ) { node.result = data.result; }
			// U4: "try once more" is granted a single time; the attempts before it are forgotten, as the judgment did.
			if ( Restore.RETRIES.includes( data.answered ) ) {
				node.retried = true;
				node.rebuilt.forget = new Set( node.rebuilt.seen );
			}
			node.waitedFor = data.to === 'waiting' ? data : null;
			if ( data.to === 'executing' && Array.isArray( data.steps ) ) { node.rebuilt.steps = data.steps; }
			node.amendedBy = null;
		}

		// E2: a fact the node already has (a replayed event) is not taken twice.
		_onFactDelivered( node, data ) {
			if ( !data.id || node.facts.some( fact => fact.id === data.id ) ) { return; }
			node.facts.push( data );
			node.inbox = node.inbox.filter( fact => fact.id !== data.id );
			// R7: a met precondition clears the attempts that stopped at it, as afterChild did.
			if ( data.kind === 'precondition_met' ) { node.rebuilt.missing = new Set( node.rebuilt.seen ); }
		}

		_onFactSuperseded( node, data ) {
			const _fact = node.facts.find( fact => fact.id === data.id );
			if ( _fact ) { _fact.superseded = true; }
		}

		// E3, E4: a fact waits in the queue until it is taken over (then it is delivered under the same id).
		_onFactQueued( node, data ) {
			const _fact = data.fact;
			if ( !_fact || typeof _fact !== 'object' || !_fact.id || node.inbox.some( item => item.id === _fact.id ) ) { return; }
			node.inbox.push( _fact );
		}

		_onCredited( node, data ) {
			if ( typeof data.criterion !== 'string' ) { return; }
			node.credited[ data.criterion ] = { ...data, booked: true };
		}

		_onWall( node, data ) {
			node.walls.push( data );
		}

		// P3: costs only from numbers; what the node holds for its children follows from what is left.
		_onCostBooked( node, data ) {
			if ( !Number.isFinite( data.spent ) || !Number.isFinite( data.left ) ) { return; }
			node.spent = data.spent;
			node.reserved = Math.max( 0, node.contract.budget - data.spent - data.left );
		}

		_onBudgetReserved( node, data ) {
			if ( Number.isFinite( data.reserved ) ) { node.reserved = data.reserved; }
		}

		_onBudgetReturned( node, data ) {
			if ( Number.isFinite( data.left ) ) { node.reserved = Math.max( 0, node.contract.budget - node.spent - data.left ); }
		}

		_onDeliveryStarted( node, data ) {
			if ( typeof data.delivery !== 'string' || !data.delivery ) { return; }
			node.deliveries = [ ...new Set( [ ...( node.deliveries || [] ), data.delivery ] ) ];
			node.deliveryAttempt = { ...( node.deliveryAttempt || {} ), [ data.delivery ]: data.attempt ?? null };
		}

		_onVerdict( node, data, event ) {
			node.lastVerdict = data;
			node.lastVerdictAt = event.id;
		}

		_onAbortReceived( node, data ) {
			node.stopping = data;
		}

		_onContractConfirmed( node, data ) {
			node.confirmed = typeof data.hash === 'string' ? data.hash : node.confirmed;
			node.immutables = node.contract.immutables();
		}

		// 3.2: the amended contract replaces the old one; it must be exactly the one the gate confirmed.
		_onContractAmended( node, data, event ) {
			const _contract = this._contract( data.spec );
			if ( !_contract || _contract.hash !== data.to ) {
				this.damaged.push( { node: node.id, event: event.id ?? null, reason: 'an amended contract that is not in the log or does not match its hash' } );
				return;
			}
			node.contract = _contract;
			node.confirmed = _contract.hash;
			node.amendedBy = data.by || 'the client';
		}

		_contract( spec ) {
			try {
				return spec ? new Contract( spec, this.runner.registry ) : null;
			} catch {
				return null;
			}
		}

		_onPlanAccepted( node, data, event ) {
			node.rebuilt.spentAt[ data.attempt ] = node.spent;
			node.rebuilt.planAt[ data.attempt ] = event.id;
			node.rebuilt.seen.push( data.attempt );
			node.rebuilt.next = 0;
			node.moving = null;
		}

		// The step of the open attempt that runs (moving), or else the one that comes next (rebuilt.next).
		_onMoveStarted( node, data, event ) {
			if ( !data.of && typeof data.move === 'string' ) { node.moving = { move: data.move, index: data.index, at: event.id }; }
		}

		_onMoveEnded( node, data ) {
			if ( data.of ) { return; }
			if ( node.moving?.index === data.index ) { node.moving = null; }
			if ( Number.isSafeInteger( data.index ) ) { node.rebuilt.next = data.index + 1; }
		}

		// The node's attempts from the journal; the last one still open is the move that was interrupted, any earlier one
		// still open is ended at the resume (L2: no attempt stays open).
		_attempts( node ) {
			const _open = [];
			for ( const attempt of this.runner.journal.forNode( node.id ) ) {
				const _wall = Restore._situation( attempt ).wall || null;
				if ( attempt.endedAt ) {
					const _forgotten = node.rebuilt.forget.has( attempt.id ) || ( attempt.cause === 'precondition_missing' && node.rebuilt.missing.has( attempt.id ) );
					if ( !_forgotten ) {
						node.tried.push( { strategy: attempt.strategy, wall: _wall, outcome: attempt.outcome, cause: attempt.cause } );
					}
					continue;
				}
				_open.push( {
					strategy: attempt.strategy, wall: _wall, attempt: attempt.id, trigger: attempt.trigger,
					spentBefore: node.rebuilt.spentAt[ attempt.id ] ?? node.spent, criterion: attempt.criterion ?? null,
					startedAt: Date.parse( attempt.startedAt ),
				} );
			}
			node.plan = _open.pop() || node.plan || null;
			node.openAttempts = _open.map( item => item.attempt );
		}

		static _situation( attempt ) {
			try {
				return JSON.parse( attempt.situation ) || {};
			} catch {
				return {};
			}
		}

		// Children first; then the node continues where its log says it stood. One loop per node, however often the
		// restore is told (16.1): a second call gets the first one's run.
		resume( node ) {
			node.resuming = node.resuming || this._resume( node );
			return node.resuming;
		}

		async _resume( node ) {
			await Promise.all( node.children.filter( child => child.state !== 'closed' ).map( child => this.resume( child ) ) );
			if ( node.state === 'closed' ) {
				return node;
			}
			node.emit( 'resumed', { state: node.state, version: node.version } );
			this._ended( node );
			node.children.filter( child => child.state === 'closed' ).forEach( child => this._take( node, child ) );
			const { pre: _pre, child: _child } = this._deeper( node );
			const _free = !node.plan?.attempt;
			if ( _child?.state === 'closed' && _free && this._waitsFor( node, _pre ) && !this._heard( node, _child ) ) {
				// A node that waited for a child of a missing precondition (U2) gets the child's end as its event (16.1).
				await this._outside( node );
				if ( node.state !== 'judging' ) { node.move( 'judging', { event: 'child_ended', resumed: true } ); }
				this.runner.afterChild( node, _pre, _child );
			} else if ( _pre && !_child && _free && [ 'planning', 'executing', 'waiting', 'judging' ].includes( node.state ) && !node.preconditionMet( _pre.id ) ) {
				// Dead between "deeper" and the child's creation: the step is taken up again, the judgment goes deeper (U2).
				await this._outside( node );
				if ( node.state !== 'judging' ) { node.move( 'judging', { resumed: 'deeper', precondition: _pre.id } ); }
			} else if ( [ 'executing', 'waiting' ].includes( node.state ) ) {
				await this._interrupted( node );
			} else if ( node.plan?.attempt ) {
				await this._unfinished( node );
			} else {
				await this._outside( node );
				// 3.2: the client changed the goal and the gate confirmed it; the node plans for the new contract.
				if ( node.amendedBy && node.state === 'judging' ) { node.move( 'planning', { reason: `${node.amendedBy} changed the goal`, resumed: true } ); }
			}
			return this.runner.run( node, { resume: true } );
		}

		// The last verdict "deeper" (U2), its precondition and the child made for it after that verdict.
		_deeper( node ) {
			const _pre = node.lastVerdict?.verdict === 'deeper' ? node.lastVerdict.precondition : null;
			if ( !_pre?.id ) { return { pre: null, child: null }; }
			const _after = child => node.lastVerdictAt === undefined || child.createdAt === undefined
				|| child.createdAt > node.lastVerdictAt;
			const _for = node.children.filter( child => child.contract.serves?.precondition === _pre.id && _after( child ) );
			return { pre: _pre, child: _for.at( -1 ) || null };
		}

		// The node still waits for that child: it judges it, or it waits, and for that very precondition.
		_waitsFor( node, pre ) {
			if ( node.state === 'judging' ) { return true; }
			return [ 'waiting', 'executing' ].includes( node.state ) && ( !node.waitedFor || node.waitedFor.precondition === pre.id );
		}

		// The node heard the end of its child for a precondition (U2): the met precondition (R7), or the child's failure.
		_heard( node, child ) {
			return node.facts.some( fact => fact.kind === 'precondition_met' && fact.source === `child ${child.id}` )
				|| node.walls.some( wall => wall.cause === 'child_failed' && ( wall.detail || [] ).some( item => item?.id === child.id ) );
		}

		// B3, R7: what a closed child of a child step proved for an item of its parent becomes the parent's fact, as the child
		// move would have taken it; nothing is taken twice, and a child for an item already settled is never started again.
		// A child for a precondition (U2, named by a wall of the node) brings its end through afterChild instead.
		_take( node, child ) {
			const _served = child.contract.serves?.precondition;
			const _precondition = node.walls.some( wall => wall.precondition?.id !== undefined && wall.precondition.id === _served );
			const _taken = node.facts.some( fact => fact.source === `child ${child.id}` );
			if ( child.result?.status !== 'fulfilled' || _precondition || _taken ) { return; }
			for ( const fact of child.facts.filter( item => item.kind === 'item_resolved' && !item.superseded ) ) {
				const _fact = { ...fact, id: undefined, source: `child ${child.id}` };
				if ( this.runner.execution?.admit ) { this.runner.execution.admit( node, _fact ); } else { node.addFact( _fact ); }
			}
		}

		// L2: an attempt the journal still has open next to the interrupted one ends as interrupted.
		_ended( node ) {
			for ( const attempt of node.openAttempts || [] ) {
				this.runner.journal.end( attempt, { outcome: 'wall', cause: 'interrupted', cost: 0 } );
				node.emit( 'attempt_interrupted', { attempt, strategy: this.runner.journal.get( attempt )?.strategy ?? null, state: node.state } );
			}
			node.openAttempts = [];
		}

		// An attempt the journal still has open while the node was planning, judging or closing (the core stopped between
		// its start and its first move, or before it was booked): it ends as interrupted, so it is booked and the node can
		// close (G6, commercial).
		async _unfinished( node ) {
			const _plan = node.plan;
			const _going = [ 'planning', 'judging' ].includes( node.state ) && this._resumable( node );
			await this._outside( node );
			if ( _going ) {
				// Between two steps of its plan (a child step ended, the judgment carries the attempt on): it goes on (19).
				this._carryOn( node, _going );
				return;
			}
			this.runner.journal.end( _plan.attempt, { outcome: 'wall', cause: 'interrupted', cost: node.spent - _plan.spentBefore } );
			// As with an interrupted move, the strategy itself did not fail; it may be chosen again.
			node.emit( 'attempt_interrupted', { attempt: _plan.attempt, strategy: _plan.strategy, state: node.state } );
			node.hitWall( 'interrupted', [], { reason: 'the core stopped while this attempt was open; it counts as aborted' } );
			node.plan = null;
		}

		// O5: what the gate could not settle with the world after a restart is unclear; a person checks it, nothing is
		// sent again on its own.
		async unclear() {
			const { gate, nodes, cascade } = this.runner;
			for ( const delivery of await gate.unclear?.() || [] ) {
				const _node = nodes.get( delivery.node );
				if ( !_node || ( _node.unclear || [] ).includes( delivery.id ) ) { continue; }
				_node.unclear = [ ...( _node.unclear || [] ), delivery.id ];
				cascade.handOver( _node );
			}
		}

		async _interrupted( node ) {
			const { journal } = this.runner;
			const _going = this._resumable( node );
			await this._outside( node );
			if ( _going ) {
				// The interrupted move goes on where it stood: the attempt stays open (19), the judgment carries it on.
				this._carryOn( node, _going );
				node.move( 'judging', { event: 'restart', carriesOn: _going.step?.move ?? null, index: node.plan.next } );
				return;
			}
			node.hitWall( 'interrupted', [], { reason: 'the core stopped while this move ran; it counts as aborted' } );
			if ( node.plan?.attempt ) {
				journal.end( node.plan.attempt, { outcome: 'wall', cause: 'interrupted', cost: node.spent - node.plan.spentBefore } );
			}
			if ( node.plan ) { node.plan.open = false; }
			node.move( 'judging', { outcome: 'wall', cause: 'interrupted' } );
		}

		// 18.4: an attempt that can go on where it stood: at a wait for answers whose expectation is still open, at a child
		// step (its child was resumed first), or with nothing left to run. → the plan rebuilt from the strategy with the step
		// it goes on at, or null. The plan must name the very moves the log has for this attempt; what earlier steps
		// produced is not in the log, so no other kind of step is taken up again.
		_resumable( node ) {
			const { catalog, expectations } = this.runner;
			const _index = node.moving ? node.moving.index : node.rebuilt?.next;
			const _found = node.plan?.attempt && Number.isSafeInteger( _index ) ? this._planned( node ) : null;
			if ( !_found || _index > _found.plan.steps.length ) { return null; }
			const _step = _found.plan.steps[ _index ] || null;
			const _move = _step && catalog?.get?.( _step.move );
			if ( _step && ( ( node.moving && _step.move !== node.moving.move ) || ![ 'wait', 'child' ].includes( _move?.executor ) ) ) { return null; }
			const _open = [ 'open', 'met' ].includes( expectations?.latest?.( node.id )?.status );
			if ( _move?.executor === 'wait' && ( _step.params?.node || !_open ) ) { return null; }
			return { ..._found, step: _step, move: _move, index: _index };
		}

		// The plan of the open attempt, rebuilt from its strategy; only when it has the very moves the log names.
		_planned( node ) {
			const { mission } = this.runner;
			const _strategies = Array.isArray( mission?.strategies ) ? mission.strategies : [];
			const _strategy = _strategies.find( item => item.id === node.plan.strategy );
			const _plan = _strategy ? Restore._resolved( _strategy, node, mission ) : null;
			const _logged = node.rebuilt?.steps;
			const _same = _plan && _logged && _logged.join( '\n' ) === _plan.steps.map( item => item.move ).join( '\n' );
			return _same ? { strategy: _strategy, plan: _plan } : null;
		}

		static _resolved( strategy, node, mission ) {
			try {
				return Plan.resolve( strategy, node, mission, Plan.defaults( strategy, node, mission ) );
			} catch {
				return null;
			}
		}

		// The attempt is open again at its step; a child step whose child has closed is taken as the step's end.
		_carryOn( node, { strategy, plan, step, move, index } ) {
			const _tSignalH = this.runner.signalHours?.( strategy ) ?? null;
			const _started = Number.isFinite( node.plan.startedAt ) ? node.plan.startedAt : Date.now();
			node.plan = {
				...plan, ...node.plan, steps: plan.steps, open: true, next: index, pending: null, values: {}, startedAt: _started,
				tSignalH: _tSignalH, review: _tSignalH && _started + _tSignalH * 3600000,
			};
			const _planAt = node.rebuilt?.planAt[ node.plan.attempt ];
			const _child = move?.executor === 'child' && node.children.filter( item => item.contract.serves?.precondition === step.item
				&& ( _planAt === undefined || item.createdAt === undefined || item.createdAt > _planAt ) ).at( -1 );
			if ( _child?.state !== 'closed' ) { return; }
			this._take( node, _child );
			if ( _child.result?.status !== 'fulfilled' ) {
				node.hitWall( 'child_failed', [ { id: _child.id, status: _child.result?.status || null, item: step.item, gates: [] } ] );
			}
			node.emit( 'move_ended', { move: step.move, index, ok: _child.result?.status === 'fulfilled', resumed: true } );
			node.plan.next = index + 1;
		}

		// What the node's moves left at the gate, also what the dying core asked for but could not record (the gate's own
		// list for the node's contract): unused tokens are revoked, an operation the gate opened runs on (O8) and is
		// followed, also when it won the race against the withdrawal (O9), an executed one leaves its receipt as a fact.
		async _outside( node ) {
			const { gate } = this.runner;
			const _listed = await Promise.resolve( gate.deliveries?.( node.contract.hash ) ).catch( () => null );
			const _mine = row => row?.id && ( !row.node || row.node === node.id );
			const _theirs = ( Array.isArray( _listed ) ? _listed : [] ).filter( _mine ).map( row => row.id );
			node.deliveries = [ ...new Set( [ ...( node.deliveries || [] ), ..._theirs ] ) ];
			for ( const id of node.deliveries ) {
				let _row = await gate.delivery( id );
				if ( [ 'awaiting_approval', 'approved' ].includes( _row?.status ) ) {
					_row = { ..._row, ...await gate.withdraw( id ) };
				}
				if ( _row?.status === 'open' ) {
					this.runner.execution.follow( node, id );
				}
				if ( _row?.status === 'executed' && !node.facts.some( fact => fact.data?.delivery === id ) ) {
					this.runner.execution.receipted( { ..._row, id }, node ).forEach( fact => node.addFact( fact ) );
				}
			}
		}

	} );
