// The cards a person acts on: a goal to confirm, an action to approve, a question to answer. Used by the control
// room and by the office. The decisions go to the gate or the core through the callbacks; a refusal (a missing
// reason, a wrong pin) comes back onto the card.

app.define( 'Ui.Cards', [ 'Ui.Describe' ], Describe => class Cards {

	static contract( data, { onConfirm } ) {
		const _card = Cards.text( 'div', '', 'card' );
		const _rules = data.rules.gate.map( rule => Describe.rule( rule ) ).join( '\n' );
		const _button = Cards.text( 'button', 'Confirm goal and rules', 'primary' );
		_button.addEventListener( 'click', () => Cards._settle( _card, onConfirm() ) );
		_card.append( Cards.text( 'div', data.goal, 'title' ) );
		if ( data.understood ) {
			_card.append( Cards.text( 'div', data.understood.backTranslation, 'understood' ) );
			if ( data.understood.notCovered?.length ) {
				_card.append( Cards.text( 'pre', `Not covered:\n${data.understood.notCovered.map( item => `• ${item}` ).join( '\n' )}`, 'rules' ) );
			}
		}
		_card.append( Cards.text( 'pre', `Rules derived from the goal:\n${_rules}`, 'rules' ), _button );
		return _card;
	}

	// The criticality decides what the person has to give (5.3): money needs a reason, the irreversible an explicit yes.
	static approval( approval, { onDecide } ) {
		const { summary } = approval;
		const _card = Cards.text( 'div', '', 'card' );
		// The address the gate resolved the recipient to is what the person approves (18.5).
		const _to = `${summary.target || ''}${summary.address ? ` <${summary.address}>` : ''}`;
		const _text = `${summary.action} → ${_to} (${summary.criticality || 'outward'})\n${JSON.stringify( summary.params, null, 1 )}`;
		_card.append( Cards.text( 'pre', _text, 'rules' ) );
		if ( summary.marked?.length ) {
			_card.append( Cards.text( 'div', `Marked: ${summary.marked.map( item => item.says ).join( ' ' )}`, 'warn' ) );
		}
		const _reason = document.createElement( 'input' );
		_reason.placeholder = 'Reason (required for money)';
		const _explicit = document.createElement( 'input' );
		_explicit.type = 'checkbox';
		if ( summary.needs?.reason ) { _card.append( _reason ); }
		if ( summary.needs?.explicit ) { _card.append( Cards.text( 'label', 'I know this cannot be undone ' ), _explicit ); }
		const _yes = Cards.text( 'button', 'Approve exactly this', 'primary' );
		const _no = Cards.text( 'button', 'Reject' );
		_yes.addEventListener( 'click', () => Cards._settle( _card, onDecide( 'approve', { reason: _reason.value, explicit: _explicit.checked } ) ) );
		_no.addEventListener( 'click', () => Cards._settle( _card, onDecide( 'reject', {} ) ) );
		_card.append( _yes, ' ', _no );
		return _card;
	}

	static ticket( ticket, { onAnswer } ) {
		const _card = Cards.text( 'div', '', 'card' );
		_card.append( Cards.text( 'div', ticket.question ) );
		const _cost = `${ticket.minutes ?? 2} min of your time${ticket.overCapacity ? ' · over today\'s capacity' : ''}`;
		_card.append( Cards.text( 'small', _cost, ticket.overCapacity ? 'warn' : 'soft' ) );
		const _row = Cards.text( 'div', '', 'options' );
		for ( const option of ticket.options ) {
			const _button = Cards.text( 'button', option, option === ticket.recommendation ? 'primary' : '' );
			_button.addEventListener( 'click', () => Cards._settle( _card, onAnswer( option ) ) );
			_row.append( _button );
		}
		_card.append( _row );
		return _card;
	}

	// O5: an action nobody can say went out or not. The person checks outside (the bank, the recipient) and says what
	// they found; that sends nothing, it only books the answer at the gate.
	static unclear( delivery, { onSettle } ) {
		const _card = Cards.text( 'div', '', 'card' );
		_card.append( Cards.text( 'div', 'Did this action take effect? Nobody can tell from here; please check outside.', 'warn' ) );
		const _to = `${delivery.target || ''}${delivery.address ? ` <${delivery.address}>` : ''}`;
		_card.append( Cards.text( 'pre', `${delivery.action} → ${_to}\n${JSON.stringify( delivery.params, null, 1 )}`, 'rules' ) );
		const _reason = document.createElement( 'input' );
		_reason.placeholder = 'What you checked';
		const _done = Cards.text( 'button', 'It took effect' );
		const _not = Cards.text( 'button', 'It did not' );
		_done.addEventListener( 'click', () => Cards._settle( _card, onSettle( 'executed', _reason.value ) ) );
		_not.addEventListener( 'click', () => Cards._settle( _card, onSettle( 'not_sent', _reason.value ) ) );
		_card.append( _reason, ' ', _done, ' ', _not );
		return _card;
	}

	// What the agent proposes at the gate (AGENCY_PROPOSALS): an action the table lacks, or a master-data value for one
	// kind of task. The person sees exactly what would become true and decides; nothing is sent by deciding.
	static gateProposal( proposal, { onDecide } ) {
		const _card = Cards.text( 'div', '', 'card' );
		const _what = proposal.kind === 'action'
			? `A new action "${proposal.body.name}" for the gate's table:\n${JSON.stringify( proposal.body.entry, null, 1 )}`
			: `A master-data value for the tasks of the kind ${proposal.scope}:\n${proposal.body.kind}: ${proposal.body.value}`;
		_card.append( Cards.text( 'div', 'The agent proposes, you decide at the gate. Check it as if you wrote it yourself.', 'warn' ) );
		_card.append( Cards.text( 'pre', _what, 'rules' ) );
		const _reason = document.createElement( 'input' );
		_reason.placeholder = 'Reason';
		const _yes = Cards.text( 'button', 'Approve', 'primary' );
		const _no = Cards.text( 'button', 'Reject' );
		_yes.addEventListener( 'click', () => Cards._settle( _card, onDecide( 'approve', _reason.value ) ) );
		_no.addEventListener( 'click', () => Cards._settle( _card, onDecide( 'reject', _reason.value ) ) );
		_card.append( _reason, ' ', _yes, ' ', _no );
		return _card;
	}

	// The callback answers with a fetch response; a refusal is shown on the card.
	static async _settle( card, pending ) {
		const _response = await pending;
		if ( _response && !_response.ok ) {
			const _error = ( await _response.json().catch( () => ( {} ) ) ).error || 'refused';
			card.append( Cards.text( 'div', _error, 'warn' ) );
		}
	}

	static text( tag, text, className = '' ) {
		const _el = document.createElement( tag );
		_el.textContent = text;
		if ( className ) { _el.className = className; }
		return _el;
	}

} );
