// The single way out (A6). Every outgoing action is checked here against the rules of its confirmed contract,
// with the gate's own code and ledger. An approval by a person turns into a one-time token bound to the hash of
// exactly that action; the core can neither create nor reuse it. A worker with a valid lease presents the token,
// and in one booking the gate checks lease, fencing token, hash and expiry, consumes the token and opens the
// delivery operation (O1, F2, F4). Starting an attempt is one conditional booking (O8: open, not withdrawn, not
// expired, the stored content still has the approved hash), so it races correctly against a withdrawal (O9); right
// before sending the expiry is checked again, so nothing new leaves after deadline plus buffer, even if the core is
// down (G-1b). Only a service that keeps the idempotency key gets repeated attempts, and only as long as it keeps
// it (O2, O7); after a crash the gate rebuilds its open operations and settles the unclear ones with the world (O4).
//
// The gate never takes the rules of a goal from the proposer: it derives them itself from the goal, with the
// criterion classes. They are loaded before the class is handed out, so propose() stays one synchronous booking.

app.define( 'Gate.Egress', [ 'Lib.Hash', 'Gate.Rules', 'Gate.Store', 'Gate.Leases', 'Gate.Channels', 'Gate.Recovery', 'Gate.Proposals' ], (
	Hash, Rules, Store, Leases, Channels, Recovery,
) => app.use( [ 'Core.Criteria.Registry' ] ).then( ( [ Registry ] ) => Registry.load() ).then( registry => class Egress {

	constructor( options ) {
		const { db, log, channels, bufferMinutes = 5, approvalMinutes = 240, now = () => Date.now(), ledger = 'gate' } = options;
		const { actions = undefined, retryMs = 2000, sendMs = 60000, proposals = false } = options;
		Object.assign( this, { db, log, channels: channels || {}, now, approvalMinutes, bufferMinutes, retryMs, sendMs } );
		this.registry = options.registry || registry;
		this.store = new Store( db );
		this.rules = new Rules( this.store, { bufferMinutes, now, actions, ledger } );
		this.leases = new Leases( db, { now, bufferMinutes } );
		// What the agent proposes and the operator decides here (AGENCY_PROPOSALS).
		this.proposals = new ( app.get( 'Gate.Proposals' ) )( this, { on: proposals } );
	}

	// A lease for one running move, granted only for a goal the gate knows and a named node (A6). It ends at the
	// latest at the root deadline plus the buffer (A7), and never later than the length the move asked for (A1).
	lease( request ) {
		const { node, move, contract, minutes, beatMinutes } = Rules.object( request ) ? request : {};
		const _contract = this.store.contract( contract );
		if ( !_contract || typeof node !== 'string' || !node ) {
			throw Rules.refusal( 'a lease is granted only for a goal the gate knows and a named node (A6, A7)', _contract ? 400 : 404 );
		}
		const _root = this.store.contract( _contract.root ) || _contract;
		const _limit = this.rules.expiresAt( _root );
		const _lease = this.leases.grant( { node, move, contract: _contract.hash, minutes, beatMinutes, limit: _limit } );
		if ( !_lease ) {
			throw Rules.refusal( 'a lease needs its minutes as a number (A8)' );
		}
		this.log.append( 'lease_granted', { node, move, lease: _lease.id, fence: _lease.fence, maxUntil: _lease.maxUntil } );
		return _lease;
	}

	// A goal waits for a person. A child goal is confirmed by derivation only when its parent is confirmed, it ends
	// no later than the parent and it carries every rule of the parent (it can only be stricter); anything else
	// waits for a person as well. The rules are the gate's own derivation; rules sent along that differ from it, a
	// criterion the gate does not know or a rule it cannot check refuse the proposal (A8).
	propose( spec, rules, hash ) {
		if ( !Rules.object( spec ) || typeof hash !== 'string' ) {
			throw Rules.refusal( 'a proposal needs the goal (an object) and its hash (a text)' );
		}
		const _goal = Rules.goal( spec, this.registry );
		if ( !_goal || _goal.hash !== hash ) {
			throw Rules.refusal( 'contract hash does not match its content' );
		}
		const _existing = this.store.contract( hash );
		if ( _existing ) { return _existing; }
		if ( _goal.unknown.length ) {
			throw Rules.refusal( 'the goal names criteria the gate does not know (fail closed)' );
		}
		const _rules = Rules.json( _goal.rules() );
		const _problems = Rules.check( _rules );
		if ( _problems.length ) {
			throw Rules.refusal( `the rules of this goal cannot be checked at the gate: ${_problems.join( '; ' )}` );
		}
		if ( !Rules.same( rules, _rules ) ) {
			throw Rules.refusal( 'the rules sent along do not follow from the goal (the gate derives them itself)' );
		}
		const _parent = spec.parent ? this.store.contract( spec.parent ) : null;
		const _derived = _parent?.status === 'confirmed' && Date.parse( spec.deadline ) <= Date.parse( _parent.spec.deadline )
			&& Rules.covers( _rules, _parent.rules );
		this.db.run( `INSERT INTO contracts ( hash, id, parent, root, spec, rules, status, proposedAt, confirmedAt, confirmedBy )
			VALUES ( :hash, :id, :parent, :root, :spec, :rules, :status, :at, :confirmedAt, :confirmedBy )`, {
			hash, id: String( spec.id ?? '' ), parent: _parent?.hash || null, root: _parent?.root || hash,
			spec: JSON.stringify( Egress.canonical( spec ) ), rules: JSON.stringify( _rules ), status: _derived ? 'confirmed' : 'proposed',
			at: this._iso(), confirmedAt: _derived ? this._iso() : null, confirmedBy: _derived ? `derived from ${_parent.id}` : null,
		} );
		this.log.append( _derived ? 'contract_derived' : 'contract_proposed', {
			hash, id: spec.id, goal: spec.goal, understood: spec.understood || null, rules: _rules, parent: _parent?.id || null,
		} );
		return this.store.contract( hash );
	}

	// A goal nobody has confirmed yet is taken back by the core that proposed it (its goal was aborted first): it leaves
	// the person's list and can no longer be confirmed. A confirmed goal stays; its actions have their own withdrawal.
	withdrawContract( hash ) {
		const _done = typeof hash === 'string' && this.db.run( 'UPDATE contracts SET status = \'withdrawn\' WHERE hash = :hash AND status = \'proposed\'',
			{ hash } ).changes > 0;
		if ( _done ) { this.log.append( 'contract_withdrawn', { hash } ); }
		return { withdrawn: Boolean( _done ), status: typeof hash === 'string' ? this.store.contract( hash )?.status ?? null : null };
	}

	confirm( hash, by ) {
		const _done = typeof hash === 'string' && this.db.run( `UPDATE contracts SET status = 'confirmed', confirmedAt = :at, confirmedBy = :by
			WHERE hash = :hash AND status = 'proposed'`, { hash, by: String( by ), at: this._iso() } );
		if ( _done?.changes ) {
			this.log.append( 'contract_confirmed', { hash, by } );
		}
		return this.store.contract( hash );
	}

	// The types are checked once, here at the boundary: whatever cannot be read is refused and booked (A8).
	async submit( raw ) {
		this._expire();
		const { request, problems } = Rules.request( raw );
		if ( problems.length ) { return this._refuse( request, problems ); }
		const _contract = this.store.contract( request.contract );
		if ( !_contract || _contract.status !== 'confirmed' ) {
			return this._refuse( request, [ { rule: 'contract', reason: 'contract is not confirmed at the gate' } ] );
		}
		// 6.2, 18.5: the recipient the gate resolves; the core never names an address (Rules.request does not read one).
		const _unresolved = this._resolve( request, _contract );
		if ( _unresolved ) { return this._refuse( request, [ { rule: 'recipient', reason: _unresolved } ], _contract ); }
		const { refusals, needsApproval } = this.rules.evaluate( _contract, request );
		if ( refusals.length ) {
			return this._refuse( request, refusals, _contract );
		}
		// A6: only a worker with a running lease for this goal and the current fencing token starts an outside action.
		if ( !this._leased( request.lease, request.fence, _contract ) ) {
			return this._refuse( request, [ { rule: 'lease', reason: 'no valid lease for this goal with the current fencing token (A6)' } ], _contract );
		}
		// O1: the action and the person's approval are one booking; a crash in between leaves neither behind.
		const _booked = this.db.transaction( () => {
			const _id = this._insert( request, _contract, needsApproval ? 'awaiting_approval' : 'open' );
			return { id: _id, approval: needsApproval ? this._requestApproval( _id ) : null };
		} );
		this.log.append( 'request_accepted', {
			delivery: _booked.id, action: request.action, target: request.target, address: request.address || undefined,
			node: request.node, status: needsApproval ? 'awaiting_approval' : 'open', flags: request.flags || [],
		} );
		if ( _booked.approval ) {
			this.log.append( 'awaiting_approval', { approval: _booked.approval.id, delivery: _booked.id, summary: _booked.approval.summary } );
			return { ...this._result( _booked.id ), approval: _booked.approval.id };
		}
		return this._execute( _booked.id );
	}

	// 6.2, 18.5: a recipient named by its reference goes to the one address on file for it; the rules, the hash, the
	// person and the channel all see that address. An action of recipient type contact goes to such a reference only.
	_resolve( request, contract ) {
		const _addresses = this.store.addresses( request.target, this.rules.scope( contract ) );
		request.address = _addresses.length === 1 ? _addresses[ 0 ] : null;
		const _target = String( request.target ?? '' ).slice( 0, 60 ) || 'no target';
		if ( _addresses.length > 1 ) { return `${_target} has ${_addresses.length} addresses on file; which one is meant cannot be told`; }
		return !request.address && this.rules.actions.toContact( request.action ) ? `${request.action} goes only to a contact on file (6.2); ${_target} is none` : null;
	}

	// A person decides; an approval issues the token, it does not send anything. Money or legal effect needs a reason
	// (a text), an irreversible action an explicit confirmation (5.3); without them nothing is decided. Only an action
	// that still waits for its person can be decided: a refused, withdrawn or decided one stays as it is.
	async decide( approvalId, decision, by, { reason = '', explicit = false } = {} ) {
		const _approval = this.store.approval( approvalId );
		const _waiting = delivery => delivery?.status === 'awaiting_approval' && !delivery.withdrawn;
		if ( !_approval || _approval.status !== 'pending' || !_waiting( this.store.delivery( _approval.delivery ) ) ) {
			throw Rules.refusal( 'no pending approval with this id', 404 );
		}
		if ( typeof by !== 'string' || !by.trim() ) {
			throw Rules.refusal( 'a decision names the person who takes it' );
		}
		const _needs = this.rules.actions.requires( this.store.delivery( _approval.delivery ).action );
		const _reason = typeof reason === 'string' ? reason.trim() : '';
		if ( decision === 'approve' && _needs.reason && !_reason ) {
			throw Rules.refusal( 'an approval with money or legal effect needs a reason' );
		}
		if ( decision === 'approve' && _needs.explicit && explicit !== true ) {
			throw Rules.refusal( 'an irreversible action needs an explicit confirmation' );
		}
		const _expired = this.now() > Date.parse( _approval.expiresAt );
		const _approve = decision === 'approve' && !_expired;
		this.db.transaction( () => {
			if ( this.store.approval( approvalId )?.status !== 'pending' || !_waiting( this.store.delivery( _approval.delivery ) ) ) {
				throw Rules.refusal( 'no pending approval with this id', 404 );
			}
			this.db.run( 'UPDATE approvals SET status = :status, decidedAt = :at, decidedBy = :by, reason = :reason WHERE id = :id', {
				id: approvalId, status: _approve ? 'approved' : ( _expired ? 'expired' : 'rejected' ), at: this._iso(), by: by.slice( 0, 200 ), reason: _reason.slice( 0, 500 ),
			} );
			this.store.setStatus( _approval.delivery, _approve ? 'approved' : 'rejected' );
		} );
		this.log.append( _approve ? 'approved' : 'approval_refused', { approval: approvalId, delivery: _approval.delivery, by, expired: _expired } );
		return { ...this._result( _approval.delivery ), approval: approvalId };
	}

	// O1, F2, F4, A6: the worker presents the token under its lease. In one booking the gate checks that the token is
	// unused and unexpired, that the stored content still has the approved hash, that the lease is valid for this goal
	// with the current fencing token and that the operation has not expired or been withdrawn; then it consumes the
	// token and opens the operation. Anything off: nothing is sent, the action is refused and every token of it is
	// void, so no person can revive it. A token presented again answers the operation it opened.
	async redeem( raw ) {
		const { delivery, approval, lease, fence } = Rules.object( raw ) ? raw : {};
		this._expire();
		const _row = this.store.delivery( delivery );
		if ( !_row ) {
			const _reasons = [ { rule: 'operation', reason: 'no such operation at the gate' } ];
			this.log.append( 'redeem_refused', { delivery: typeof delivery === 'string' ? delivery.slice( 0, 200 ) : null, reasons: _reasons } );
			return { delivery: typeof delivery === 'string' ? delivery : null, status: 'refused', reasons: _reasons, receipt: null };
		}
		// The world may have changed while the person decided; the rules are checked again before anything is sent.
		const _contract = this.store.contract( _row.contract );
		const _checked = _contract?.status === 'confirmed' ? this.rules.evaluate( _contract, _row ).refusals
			: [ { rule: 'contract', reason: 'contract is not confirmed at the gate' } ];
		const _outcome = this.db.transaction( () => {
			const _delivery = this.store.delivery( delivery );
			const _token = this.store.approval( approval, delivery );
			if ( _token?.status === 'consumed' ) {
				return { replay: true, problems: [ { rule: 'token', reason: 'already redeemed' } ] };
			}
			// F4: lease, fencing token, hash and expiry are checked right before the operation is booked; if anything
			// deviates, nothing is sent and a new approval is needed.
			const _found = [
				!_token || _token.status !== 'approved' ? { rule: 'token', reason: 'no unused approval for this action (F2)' } : null,
				_token && this.now() > Date.parse( _token.expiresAt ) ? { rule: 'token', reason: 'the approval has expired (F3)' } : null,
				_delivery.status !== 'approved' || _delivery.withdrawn ? { rule: 'operation', reason: 'the action is no longer waiting for this token' } : null,
				this.now() > Date.parse( _delivery.expiresAt ) ? { rule: 'expires', reason: 'the action has expired (A7)' } : null,
				_token && !Egress.unchanged( _delivery, _token.actionHash ) ? { rule: 'hash', reason: 'the content differs from what was approved (F4, F5)' } : null,
				!this._leased( lease, fence, _contract ) ? { rule: 'lease', reason: 'no valid lease for this goal with the current fencing token (A6)' } : null,
				..._checked,
			].filter( Boolean );
			if ( !_found.length ) {
				this.db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: approval } );
				this.db.run( 'UPDATE deliveries SET status = \'open\', lease = :lease, fence = :fence WHERE id = :id', { id: delivery, lease, fence } );
				return { problems: [] };
			}
			if ( _token?.status === 'approved' ) {
				this.db.run( 'UPDATE approvals SET status = \'void\' WHERE id = :id', { id: approval } );
			}
			if ( [ 'approved', 'awaiting_approval' ].includes( _delivery.status ) ) {
				this.db.run( 'UPDATE deliveries SET status = \'refused\', reasons = :reasons WHERE id = :id', { id: delivery, reasons: JSON.stringify( _found ) } );
				this.db.run( 'UPDATE approvals SET status = \'void\' WHERE delivery = :id AND status IN ( \'pending\', \'approved\' )', { id: delivery } );
			}
			return { problems: _found };
		} );
		const _approval = typeof approval === 'string' ? approval.slice( 0, 200 ) : null;
		this.log.append( _outcome.problems.length ? 'redeem_refused' : 'token_consumed', { delivery, approval: _approval, reasons: _outcome.problems } );
		if ( _outcome.replay ) {
			const _now = this._result( delivery );
			return { ..._now, reasons: [ ..._now.reasons, ..._outcome.problems ] };
		}
		return _outcome.problems.length ? this._result( delivery ) : this._execute( delivery );
	}

	withdraw( id ) {
		if ( !this.store.delivery( id ) ) {
			return { delivery: typeof id === 'string' ? id : null, status: null, reasons: [ { rule: 'operation', reason: 'no such operation at the gate' } ], receipt: null };
		}
		const _changed = this.db.transaction( () => {
			const _delivery = this.store.delivery( id );
			if ( ![ 'open', 'awaiting_approval', 'approved' ].includes( _delivery.status ) ) {
				return false;
			}
			// O9: no attempt begun: not sent. An attempt in flight: its result decides (executed, or unclear). Attempts
			// that all ended without confirmation: unclear, and no further one begins.
			const _attempts = this.db.get( 'SELECT COUNT(*) AS n, SUM( result IS NULL ) AS flying FROM attempts WHERE delivery = :id', { id } );
			const _status = !_attempts.n ? 'not_sent' : _attempts.flying ? _delivery.status : 'unclear';
			this.db.run( 'UPDATE deliveries SET withdrawn = 1, status = :status WHERE id = :id', { id, status: _status } );
			this.db.run( 'UPDATE approvals SET status = \'withdrawn\' WHERE delivery = :id AND status IN ( \'pending\', \'approved\' )', { id } );
			return true;
		} );
		if ( _changed ) {
			this.log.append( 'withdrawn', { delivery: id } );
		}
		return this._result( id );
	}

	// F3: an approval nobody decided in time is no longer pending; it is shown to nobody and blocks nothing.
	pendingApprovals() {
		this._expire();
		return this.store.pendingApprovals();
	}

	async _execute( id ) {
		const { nr: _nr, events } = this._beginAttempt( id );
		events.forEach( ( [ kind, data ] ) => this.log.append( kind, data ) );
		if ( !_nr ) { return this._result( id ); }
		const _delivery = this.store.delivery( id );
		if ( this.now() > Date.parse( _delivery.expiresAt ) ) {
			// Re-checked right before sending (O8): not sent now; after earlier attempts the operation is unclear.
			this._finishAttempt( id, _nr, _nr > 1 ? 'unclear' : 'not_sent', null );
			return this._result( id );
		}
		// A2: the call to the service has a timeout shorter than the lease of an outward action. A timeout leaves it
		// open whether the service acted: repeated only with its guarantee (O2), otherwise unclear (O5).
		const _sent = await Channels.send( this._channel( _delivery ), _delivery, this.sendMs );
		const _error = _sent.ok ? null : _sent.error;
		if ( _sent.ok ) {
			this._finishAttempt( id, _nr, 'executed', _sent.receipt );
		} else if ( this.store.delivery( id ).withdrawn ) {
			// O9: withdrawn while this attempt was in flight: no further attempt; without confirmation it is unclear.
			this._finishAttempt( id, _nr, 'unclear', { error: _error, withdrawn: true } );
		} else if ( this._idempotent( _delivery ) ) {
			// O7: the service keeps the idempotency key, so the same operation is sent again, later, until it is
			// confirmed or expires; these are attempts of the approved action and need no new token.
			this._finishAttempt( id, _nr, 'open', { error: _error } );
			const _timer = setTimeout( () => this._execute( id ).catch( app.fail ), Math.min( 60000, this.retryMs * 2 ** ( _nr - 1 ) ) );
			_timer.unref?.();
		} else {
			// O3, O5: without the service's guarantee there is no second attempt; the result stays unclear for a person.
			this._finishAttempt( id, _nr, 'unclear', { error: _error } );
		}
		return this._result( id );
	}

	_channel( delivery ) {
		return Channels.pick( this.channels, delivery.action );
	}

	// O2: a repetition is safe only when the service keeps the idempotency key, and only for as long as it keeps it
	// (idempotencyH in the action table); the channel class must declare it. A window no longer than the reserve
	// for late requests is no guarantee: one attempt only.
	_idempotent( delivery ) {
		return Channels.idempotent( this._channel( delivery ) ) && this._retention( delivery ) > Egress.RESERVE_H;
	}

	_retention( delivery ) {
		const _hours = this.rules.actions.entry( delivery.action )?.idempotencyH;
		return typeof _hours === 'number' && Number.isFinite( _hours ) ? _hours : 0;
	}

	// O8: one booking checks status, withdrawal, expiry, the channel and that the stored content still has the approved
	// hash, and records the attempt; an earlier check counts for nothing. O2: from the first attempt on, the operation
	// expires when the service no longer keeps its key, less a reserve for requests processed late. The events are
	// written after the booking, so a rolled back booking leaves none behind. → { nr, events }, nr 0: no attempt.
	_beginAttempt( id ) {
		const _events = [];
		const _nr = this.db.transaction( () => {
			const _delivery = this.store.delivery( id );
			if ( !_delivery || _delivery.status !== 'open' || _delivery.withdrawn ) {
				return 0;
			}
			const _next = this.db.get( 'SELECT COUNT(*) AS n FROM attempts WHERE delivery = :id', { id } ).n + 1;
			const _approved = this.db.get( 'SELECT actionHash FROM approvals WHERE delivery = :id AND status = \'consumed\'', { id } );
			const _hash = _delivery.actionHash;
			const _changed = !Egress.unchanged( _delivery, _hash ) || ( _approved?.actionHash ?? _hash ) !== _hash;
			const _channel = this._channel( _delivery );
			if ( this.now() > Date.parse( _delivery.expiresAt ) || _changed || !_channel ) {
				// Expired, changed or no channel: with no attempt nothing was sent; after one without confirmation it is unclear.
				const _reasons = _channel ? _delivery.reasons : [ { rule: 'channel', reason: 'no channel delivers this action (fail closed)' } ];
				this.db.run( 'UPDATE deliveries SET status = :status, reasons = :reasons WHERE id = :id', {
					id, status: _next > 1 ? 'unclear' : 'not_sent', reasons: JSON.stringify( _reasons ) } );
				if ( _changed ) { _events.push( [ 'content_changed', { delivery: id, nr: _next } ] ); }
				return 0;
			}
			if ( _next > 1 && !this._idempotent( _delivery ) ) {
				return 0;
			}
			if ( _next === 1 && this._idempotent( _delivery ) ) {
				const _until = this.now() + ( this._retention( _delivery ) - Egress.RESERVE_H ) * 3600000;
				if ( _until < Date.parse( _delivery.expiresAt ) ) {
					this.db.run( 'UPDATE deliveries SET expiresAt = :at WHERE id = :id', { id, at: new Date( _until ).toISOString() } );
				}
			}
			this.db.run( 'INSERT INTO attempts ( delivery, nr, begunAt ) VALUES ( :id, :nr, :at )', { id, nr: _next, at: this._iso() } );
			_events.push( [ 'attempt_begun', { delivery: id, nr: _next } ] );
			return _next;
		} );
		return { nr: _nr, events: _events };
	}

	// O1, O4, O5, O7: after a crash the gate rebuilds its open operations from its ledger (Gate.Recovery).
	async recover() {
		return Recovery.recover( this );
	}

	// F3: approvals nobody decided before they expired end as expired, their actions as rejected; neither is shown as
	// pending nor counts against "exactly once", sums or releases any more.
	_expire() {
		this.store.expireApprovals( this._iso(), [ { rule: 'token', reason: 'nobody decided before the approval expired (F3)' } ] )
			.forEach( item => this.log.append( 'approval_expired', { approval: item.id, delivery: item.delivery } ) );
	}

	// O5: the operations nobody can say went out or not, and how a person settles one (Gate.Recovery).
	unclear() {
		return Recovery.unclear( this );
	}

	settle( id, decision ) {
		return Recovery.settle( this, id, decision );
	}

	// status 'open': this attempt failed and the operation stays open for the next one (O7).
	_finishAttempt( id, nr, status, receipt ) {
		this.db.transaction( () => {
			this.db.run( 'UPDATE attempts SET result = :result WHERE delivery = :id AND nr = :nr', { id, nr, result: status === 'open' ? 'failed' : status } );
			this.db.run( 'UPDATE deliveries SET status = :status, receipt = :receipt WHERE id = :id', { id, status, receipt: JSON.stringify( Rules.json( receipt ) ?? null ) } );
			const _delivery = this.store.delivery( id );
			if ( status === 'executed' && Array.isArray( _delivery.cohort ) ) {
				this.db.run( 'INSERT INTO releases ( contract, root, delivery, cohort ) VALUES ( :contract, :root, :id, :cohort )',
					{ contract: _delivery.contract, root: _delivery.root, id, cohort: JSON.stringify( [ ..._delivery.cohort ].sort() ) } );
			}
		} );
		this.log.append( status === 'open' ? 'attempt_failed' : status, { delivery: id, nr, receipt } );
	}

	// F1: the row is the normalised request, and the hash is taken over exactly that.
	_insert( request, contract, status ) {
		const _id = Hash.id( 'dl' );
		const { node, action, target, lease, fence, params, labels, flags, cohort, address = null } = request;
		this.store.book( {
			id: _id, contract: contract.hash, root: contract.root, node, action, target, address, lease, fence, status,
			params: JSON.stringify( params ), labels: JSON.stringify( labels ), actionHash: Egress.actionHash( request ),
			flags: flags && JSON.stringify( flags ), cohort: cohort && JSON.stringify( cohort ),
			// G-1b, A7: every action expires with its goal, and never later than the root deadline plus the buffer.
			expiresAt: this.rules.expiresAt( contract ), createdAt: this._iso(),
		} );
		return _id;
	}

	// A refused request is booked so a person can see it, but only so much of it: texts are cut, and what it carried
	// is kept only while it is small (a refused request must not fill the ledger).
	_refuse( request, reasons, contract = null ) {
		const _id = Hash.id( 'dl' );
		const _cut = value => ( typeof value === 'string' ? value.slice( 0, Egress.KEEP_TEXT ) : null );
		const _small = JSON.stringify( [ request.params, request.labels, request.cohort ] ).length <= Egress.KEEP_REFUSED;
		const _reasons = _small ? reasons : [ ...reasons, { rule: 'size', reason: 'the request was too large to keep; only its refusal is booked' } ];
		this.store.book( {
			id: _id, contract: contract?.hash || _cut( request.contract ) || '', root: contract?.root || _cut( request.contract ) || '',
			node: _cut( request.node ), action: _cut( request.action ) || '', target: _cut( request.target ),
			params: JSON.stringify( _small ? request.params : {} ), labels: JSON.stringify( _small ? request.labels : {} ),
			cohort: _small && request.cohort !== null ? JSON.stringify( request.cohort ) : null, actionHash: Egress.actionHash( request ),
			status: 'refused', reasons: JSON.stringify( _reasons ), expiresAt: this._iso(), createdAt: this._iso(),
		} );
		this.log.append( 'refused', { delivery: _id, action: _cut( request.action ), target: _cut( request.target ), node: _cut( request.node ), reasons: _reasons } );
		return this._result( _id );
	}

	// The person sees exactly what would leave: action, recipient, parameters and the group it names (10.4); marked:
	// an outgoing text that still breaks a soft rule of the user's base setup (7.3). Booked inside the caller's booking.
	_requestApproval( deliveryId ) {
		const _delivery = this.store.delivery( deliveryId );
		const _id = Hash.id( 'ap' );
		const _summary = {
			action: _delivery.action, target: _delivery.target, ...( _delivery.address ? { address: _delivery.address } : {} ),
			params: _delivery.params, cohort: _delivery.cohort,
			group: Array.isArray( _delivery.cohort ) ? Rules.people( _delivery.cohort )?.size ?? null : null, marked: _delivery.flags,
			criticality: this.rules.actions.criticality( _delivery.action ), needs: this.rules.actions.requires( _delivery.action ),
		};
		const _expires = Math.min( this.now() + this.approvalMinutes * 60000, Date.parse( _delivery.expiresAt ) );
		this.store.ask( {
			id: _id, delivery: deliveryId, actionHash: _delivery.actionHash, summary: JSON.stringify( _summary ), requestedAt: this._iso(),
			expiresAt: new Date( _expires ).toISOString(),
		} );
		return { id: _id, summary: _summary };
	}

	// A6: a valid lease with the current fencing token, granted for this goal or for one above it in its tree.
	_leased( id, fence, contract ) {
		const _lease = this.leases.valid( id, fence );
		return _lease && this.store.lineage( contract?.hash ).includes( _lease.contract ) ? _lease : null;
	}

	_result( id ) {
		const _delivery = this.store.delivery( id );
		return { delivery: id, status: _delivery.status, reasons: _delivery.reasons, receipt: _delivery.receipt };
	}

	_iso() { return new Date( this.now() ).toISOString(); }

	static RESERVE_H = 1;
	static KEEP_REFUSED = 64 * 1024;
	static KEEP_TEXT = 200;

	// F1: the hash covers every resolved parameter and the content; the stored row must still produce it.
	static unchanged( delivery, hash ) {
		return Egress.actionHash( delivery ) === hash;
	}

	// 18.5: over the resolved recipient too, when the gate resolved one: another address is another action.
	static actionHash( request ) {
		const { contract, action, target = null, params = {}, address = null } = request;
		return Hash.sha256( typeof address === 'string' ? { contract, action, target, address, params } : { contract, action, target, params } );
	}

	static canonical( spec ) {
		return Rules.canonical( spec );
	}

	// Is the child at least as strict as the parent (Gate.Rules.covers)?
	static covers( child, parent ) {
		return Rules.covers( child, parent );
	}

} ) );
