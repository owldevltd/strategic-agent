// One completion for one role under a step contract: the role gets only the inputs its step allows and must
// answer in the fixed fields of the contract; anything else is refused before it can be used.
// Implementations: OpenAiProvider (any OpenAI-compatible endpoint, Vultr Serverless Inference by default) and
// StubProvider (deterministic answers for tests and for running without a key).

app.define( 'Core.Ai.Provider', [], () => class Provider {

	static NAME = 'none';
	// How much of a key the model chose a problem repeats, and how many such keys it names (the log, the error).
	static KEY_CHARS = 60;
	static KEYS_NAMED = 20;

	constructor( { log = null } = {} ) {
		this.log = log;
	}

	// One repair attempt: a broken answer is refused, the model hears why and may answer once more. A second broken
	// answer is refused for good; nothing outside the contract is ever used.
	async complete( { role, instructions, input, contract, node = null } ) {
		let _problems = null;
		for ( let attempt = 1; attempt <= 2; attempt++ ) {
			const _started = Date.now();
			const _answer = await this._complete( { role, instructions, input, contract, repair: _problems } );
			_problems = Provider.validate( _answer, contract );
			this.log?.append( 'ai_answered', {
				role, provider: this.name( role ), attempt, ok: !_problems.length, problems: _problems, ms: Date.now() - _started,
			}, { node } );
			if ( !_problems.length ) {
				await this.calibration?.review( role, input, _answer );
				return _answer;
			}
		}
		throw new Error( `answer breaks the step contract: ${_problems.join( '; ' )}` );
	}

	name() {
		return this.constructor.NAME;
	}

	_complete() {
		throw new Error( 'Provider._complete must be implemented' );
	}

	// Step contract: { fields: { name: { type: 'string'|'number'|'list'|'enum'|'records', values?, fields?, required?, open? } } }.
	// 'records' is a list of objects with the given fields, e.g. payments; see record(). Only own keys count, on both sides: a
	// name every object inherits (constructor, __proto__, toString) is no field of a contract and no value of an answer.
	static validate( answer, contract ) {
		if ( !answer || typeof answer !== 'object' || Array.isArray( answer ) ) {
			return [ 'answer is not an object' ];
		}
		const _fields = contract.fields || {};
		const _problems = [];
		for ( const [ name, field ] of Object.entries( _fields ) ) {
			const _value = Object.hasOwn( answer, name ) ? answer[ name ] : undefined;
			// An optional field a model fills with "" to say "none" (a paragraph it cannot name) is absent, unless it is text.
			const _none = _value === '' && field.required === false && field.type !== 'string';
			if ( _value === undefined || _value === null || _none ) {
				if ( field.required !== false ) { _problems.push( `${name} is missing` ); }
				continue;
			}
			if ( !Provider.valid( _value, field ) ) { _problems.push( `${name} is not a valid ${field.type}` ); }
		}
		const _extra = Object.keys( answer ).filter( name => !Object.hasOwn( _fields, name ) );
		// The names are text the model chose: cut short, and only so many of them (the rest is counted).
		_extra.slice( 0, Provider.KEYS_NAMED ).forEach( name => _problems.push( `${Provider.key( name )} is not part of the contract` ) );
		if ( _extra.length > Provider.KEYS_NAMED ) {
			_problems.push( `${_extra.length - Provider.KEYS_NAMED} more keys are not part of the contract` );
		}
		return _problems;
	}

	static valid( value, field ) {
		const _values = Array.isArray( field.values ) ? field.values : null;
		switch ( field.type ) {
			case 'string': return typeof value === 'string';
			// NaN and Infinity are numbers to JavaScript, but no number a step can use.
			case 'number': return Number.isFinite( value );
			case 'enum': return ( _values || [] ).includes( value );
			case 'list': return Array.isArray( value ) && value.every( item => ( _values ? _values.includes( item ) : typeof item === 'string' ) );
			case 'records': return Array.isArray( value ) && value.every( item => Provider.record( item, field.fields, field.open === true ) );
			default: return false;
		}
	}

	// A record is an object; when its contract names fields, it carries no other field. A declared field may be missing,
	// unless its spec says { required: true } (most specs are a word for the model, e.g. 'text', and leave it open). A
	// records field with open: true lets other keys through to the caller, whose own gate screens them (the learner's G4,
	// so a refused proposal still reaches a person as a suggestion, 7.2); by default records are closed.
	static record( item, fields, open = false ) {
		if ( !item || typeof item !== 'object' || Array.isArray( item ) ) { return false; }
		if ( !fields || typeof fields !== 'object' ) { return true; }
		const _required = Object.keys( fields ).filter( name => fields[ name ]?.required === true );
		return ( open || Object.keys( item ).every( name => Object.hasOwn( fields, name ) ) )
			&& _required.every( name => Object.hasOwn( item, name ) && item[ name ] !== undefined && item[ name ] !== null );
	}

	static key( name ) {
		return name.length > Provider.KEY_CHARS ? `${name.slice( 0, Provider.KEY_CHARS )}…` : name;
	}

	// G-8: what goes back to the model in a repair repeats only what its contract names. A key the model chose is
	// counted, never repeated: its name is text from the model, or from the data it copied.
	static note( problems, contract ) {
		const _fields = contract?.fields || {};
		const _known = new Set( [ 'answer is not an object', ...Object.entries( _fields ).flatMap( ( [ name, field ] ) => [
			`${name} is missing`, `${name} is not a valid ${field?.type}`,
		] ) ] );
		const _named = ( problems || [] ).filter( problem => _known.has( problem ) );
		const _keys = ( problems || [] ).filter( problem => !_known.has( problem ) )
			.reduce( ( sum, problem ) => sum + Number( /^(\d+) more keys are not part of the contract$/.exec( problem )?.[ 1 ] || 1 ), 0 );
		return _keys ? [ ..._named, `${_keys} ${_keys === 1 ? 'key is' : 'keys are'} not part of the contract` ] : _named;
	}

} );
