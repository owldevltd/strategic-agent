// Data-flow labels along a plan (10.4). Every value carries labels of origin: own, foreign, confidential. A move
// adds its own labels and, if it inherits, all labels of its inputs: derived text is never cleaner than its
// sources. Only trusted code may produce a value without the labels of its inputs; every other move inherits them,
// whatever its catalog entry says. A value computed over a group of people carries that group (the cohort), which a
// goal may allow to leave; mixed with individual confidential rows it is no group any more. The same rules run
// statically on the plan (G2) and again on the real values at the gate.

app.define( 'Core.Label.Flow', [], () => class Flow {

	static LABELS = [ 'own', 'foreign', 'confidential' ];

	// → { name: { labels, group } } for every named value of the plan, as it stands after the last step.
	static infer( steps, catalog ) {
		return Flow.record( Flow.walk( steps, catalog ) );
	}

	// Runs through the plan in its order, as execution will. visit( step, values, producers ) is called before each
	// step with the values as they stand at that step's position and the step that last wrote each name, so a name
	// written again later never changes what an earlier step reads. Names live in a Map: a value may be called
	// "__proto__" or "toString" like any other. initial: the values the node starts with. → the values after the last step.
	static walk( steps, catalog, visit = null, initial = new Map() ) {
		const _values = new Map( initial );
		const _producers = new Map();
		for ( const step of Array.isArray( steps ) ? steps : [] ) {
			if ( !step || typeof step !== 'object' ) { continue; }
			if ( visit ) { visit( step, _values, _producers ); }
			const _move = catalog.get( step.move );
			if ( !_move || !Flow.named( step.as ) ) { continue; }
			_values.set( step.as, Flow.value( _move, Flow.inputs( step ).map( name => Flow.read( _values, name ) ) ) );
			_producers.set( step.as, step );
		}
		return _values;
	}

	// A value no earlier step wrote carries nothing; G2 refuses such a reference before it can matter.
	static read( values, name ) {
		return values.get( name ) || { labels: [], group: false };
	}

	static named( name ) {
		return typeof name === 'string' && name !== '';
	}

	// One step's result. It is a group when its move computes over a group, or when it inherits from a group and every
	// input that carries confidential data is a group itself: individual rows mixed in make it individual again.
	static value( move, inputs ) {
		const _group = Boolean( move.group ) || ( Flow.inherits( move ) && inputs.some( item => item.group )
			&& inputs.every( item => item.group || !item.labels.includes( 'confidential' ) ) );
		return { labels: Flow.derive( move, inputs.map( item => item.labels ) ), group: _group };
	}

	static derive( move, inputLabels ) {
		const _out = new Set( [].concat( move?.labels ?? [] ) );
		if ( Flow.inherits( move ) ) {
			inputLabels.flat().forEach( label => _out.add( label ) );
		}
		return [ ..._out ];
	}

	// 10.4: only trusted code may hand on a value cleaner than its inputs. A model, a person, a wait or a child never
	// does, even when its catalog entry forgets to say "inherit".
	static inherits( move ) {
		return Boolean( move?.inherit ) || ( typeof move?.executor === 'string' && move.executor !== 'code' );
	}

	static inputs( step ) {
		if ( !step?.from ) { return []; }
		return Array.isArray( step.from ) ? step.from : [ step.from ];
	}

	// The values as a plain record; a name like "__proto__" becomes an entry of its own, never the prototype.
	static record( values ) {
		const _out = {};
		for ( const [ name, value ] of values ) {
			Object.defineProperty( _out, name, { value, enumerable: true, writable: true, configurable: true } );
		}
		return _out;
	}

	// Violations of the goal's own flow rules for one outgoing action; rules name actions by name or class.
	// labelsByParam: a Map or a record of parameter → labels; only its own entries count.
	static violations( flowRules, action, labelsByParam, actions ) {
		const _out = [];
		const _of = param => [].concat( ( labelsByParam instanceof Map ? labelsByParam.get( param )
			: labelsByParam && Object.hasOwn( labelsByParam, param ) && labelsByParam[ param ] ) || [] );
		for ( const rule of ( flowRules || [] ).filter( entry => actions.applies( entry.actions, action ) ) ) {
			const _labels = _of( rule.param );
			for ( const label of [].concat( rule.mustNot ?? [] ) ) {
				if ( _labels.includes( label ) ) { _out.push( `${rule.param} would carry ${label} (${rule.criterion})` ); }
			}
			for ( const label of [].concat( rule.mustHave ?? [] ) ) {
				if ( !_labels.includes( label ) ) { _out.push( `${rule.param} lacks ${label} (${rule.criterion})` ); }
			}
		}
		return _out;
	}

} );
