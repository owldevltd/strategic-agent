// One pot (chapters 5.2, 5.4, 23). Every cost is counted in one unit for the choice; a human minute is the dearest
// part, so the system avoids people by itself (P1, P2). Units, human minutes and duration are booked and logged
// one by one (P5). Every round costs its moves, at least one unit (P3). A child reserves its budget from what its
// parent has left; what it does not use flows back when it closes (P4). Budget is never a reason to start
// more: returned reservations do not add start tokens (R1).

app.define( 'Core.Budget.Pot', [], () => class Pot {

	static MINUTE = 1;
	static ROUND_MINIMUM = 1;

	// The pot counts only amounts it can read: a finite number of at least zero. Anything else (text, NaN, a negative
	// price that would buy budget back) is a cost nobody can tell, so it counts as more than any budget: fail closed.
	// An infinite price stays infinite, a move nobody can pay for.
	static amount( value ) {
		const _value = typeof value === 'number' || ( typeof value === 'string' && value.trim() !== '' ) ? Number( value ) : NaN;
		return Number.isNaN( _value ) || _value < 0 ? Infinity : _value;
	}

	static price( move ) {
		const _units = Pot.amount( move?.price ?? 1 );
		const _minutes = Pot.amount( move?.humanMinutes ?? 0 );
		return { units: _units, humanMinutes: _minutes, total: Pot.round( _units + _minutes * Pot.MINUTE ) };
	}

	static left( node ) {
		return Pot.round( node.contract.budget - node.spent - ( node.reserved || 0 ) );
	}

	// Z6 before every move: its price must fit what is left; a free move fits also when nothing is left.
	static fits( node, price ) {
		return Pot.round( Pot.amount( price ) ) <= Pot.left( node );
	}

	static book( node, { what, units = 0, humanMinutes = 0, ms = 0 } ) {
		const _units = Pot.amount( units );
		const _minutes = Pot.amount( humanMinutes );
		const _total = Pot.round( _units + _minutes * Pot.MINUTE );
		node.spent = Pot.round( node.spent + _total );
		node.costs = node.costs || { units: 0, humanMinutes: 0, ms: 0 };
		node.costs.units = Pot.round( node.costs.units + _units );
		node.costs.humanMinutes = Pot.round( node.costs.humanMinutes + _minutes );
		node.costs.ms += Number.isFinite( ms ) && ms > 0 ? ms : 0;
		node.emit( 'cost_booked', { what, units: _units, humanMinutes: _minutes, ms, total: _total, spent: node.spent, left: Pot.left( node ) } );
		return _total;
	}

	// P3: a round that cost less than the minimum is booked up to it.
	static closeRound( node, spentBefore ) {
		const _round = node.spent - spentBefore;
		if ( _round < Pot.ROUND_MINIMUM ) {
			Pot.book( node, { what: 'round minimum', units: Pot.round( Pot.ROUND_MINIMUM - _round ) } );
		}
		return Pot.round( node.spent - spentBefore );
	}

	// P4: only an amount the pot can read, rounded as the pot counts, and never more than is left. The reservation is
	// kept per child (held), so a release frees what that child holds; the parent also keeps the sum of the budgets it
	// reserved, so for a reservation that names no child a release still knows whether a reallocation shrank them.
	static reserve( parent, amount, child = null ) {
		const _amount = Pot.round( Pot.amount( amount ) );
		if ( !Number.isFinite( _amount ) || _amount > Pot.left( parent ) ) {
			return false;
		}
		parent.reserved = Pot.round( ( parent.reserved || 0 ) + _amount );
		parent.reservedBudgets = Pot.round( ( parent.reservedBudgets ?? Pot.round( parent.reserved - _amount ) ) + _amount );
		if ( child?.id ) { parent.held = { ...( parent.held || {} ), [ child.id ]: _amount }; }
		parent.emit( 'budget_reserved', { amount: _amount, reserved: parent.reserved, left: Pot.left( parent ) } );
		return true;
	}

	// The child's spending becomes the parent's; the rest of the reservation flows back. A child holds its budget until a
	// reallocation shrinks every open child to what it can still spend (5.4); from then on only that rest is freed, never
	// the reservation of an open sibling.
	static release( parent, child ) {
		const _budget = Pot.round( Pot.amount( child.contract.budget ) );
		const _budgets = parent.reservedBudgets ?? ( parent.reserved || 0 );
		const _shrunk = Pot.round( parent.reserved || 0 ) < Pot.round( _budgets );
		const _own = parent.held && Object.hasOwn( parent.held, child.id ) ? parent.held[ child.id ] : null;
		const _held = _own ?? ( _shrunk ? Math.max( 0, Pot.round( _budget - ( child.spent || 0 ) ) ) : _budget );
		parent.reserved = Pot.round( Math.max( 0, ( parent.reserved || 0 ) - _held ) );
		parent.reservedBudgets = Pot.round( Math.max( 0, _budgets - _budget ) );
		if ( _own !== null ) { parent.held = Object.fromEntries( Object.entries( parent.held ).filter( ( [ id ] ) => id !== child.id ) ); }
		const _costs = child.costs || { units: 0, humanMinutes: 0, ms: 0 };
		Pot.book( parent, { what: `child ${child.id}`, units: _costs.units, humanMinutes: _costs.humanMinutes, ms: _costs.ms } );
		parent.emit( 'budget_returned', { child: child.id, returned: Pot.round( child.contract.budget - child.spent ), left: Pot.left( parent ) } );
	}

	// 5.4: at each judgment the node re-distributes what is left: an open child keeps reserved only what it can still
	// spend; the rest flows back to the node.
	static reallocate( node ) {
		const _open = node.children.filter( child => child.state !== 'closed' );
		if ( !_open.length ) { return; }
		const _rest = child => Pot.round( Math.max( 0, child.contract.budget - child.spent ) );
		const _needed = _open.reduce( ( sum, child ) => sum + _rest( child ), 0 );
		for ( const child of _open.filter( item => node.held && Object.hasOwn( node.held, item.id ) ) ) {
			node.held = { ...node.held, [ child.id ]: _rest( child ) };
		}
		if ( Pot.round( _needed ) !== Pot.round( node.reserved || 0 ) ) {
			node.reserved = Pot.round( _needed );
			node.emit( 'budget_reallocated', { reserved: node.reserved, left: Pot.left( node ) } );
		}
	}

	// k(s) of chapter 19: the strategy's own estimate, never below what its moves cost by the catalog. An estimate the
	// pot cannot read (text, NaN, negative, infinite) is no estimate; the moves count.
	static strategyCost( strategy, catalog ) {
		const _moves = ( strategy.steps || [] ).reduce( ( sum, step ) => sum + Pot.price( catalog?.get( step.move ) ).total, 0 );
		const _own = Pot.amount( strategy.price ?? 0 );
		return Pot.round( Math.max( Number.isFinite( _own ) ? _own : 0, _moves, Pot.ROUND_MINIMUM ) );
	}

	static round( value ) {
		return Math.round( value * 1000 ) / 1000;
	}

} );
