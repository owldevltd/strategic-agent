// Any OpenAI-compatible chat endpoint; by default Vultr Serverless Inference. The answer must be one JSON object
// with exactly the fields of the step contract.

app.define( 'Core.Ai.OpenAiProvider', [ 'Core.Ai.Provider' ], Provider => class OpenAiProvider extends Provider {

	static NAME = 'openai-compatible';

	// models: a model per role (LLM_MODELS); a role not named uses model. effort: how long a reasoning model may think,
	// per role or for every role ("*") (LLM_EFFORT); none named, the endpoint decides.
	constructor( { baseUrl, apiKey, model, models = {}, effort = {}, timeoutSeconds = 150, log = null } ) {
		super( { log } );
		Object.assign( this, { baseUrl, apiKey, model, timeoutSeconds } );
		this.models = models && typeof models === 'object' ? models : {};
		this.effort = effort && typeof effort === 'object' ? effort : {};
	}

	modelFor( role ) {
		return typeof role === 'string' && Object.hasOwn( this.models, role ) ? this.models[ role ] : this.model;
	}

	effortFor( role ) {
		const _own = typeof role === 'string' && Object.hasOwn( this.effort, role ) ? this.effort[ role ] : undefined;
		return _own ?? ( Object.hasOwn( this.effort, '*' ) ? this.effort[ '*' ] : null );
	}

	name( role = null ) {
		return this.modelFor( role );
	}

	// The system message is the step's own text and its format, nothing else. Whatever came from the model or the world
	// stays in the user message: the input, and in a repair the note on what was wrong (G-8).
	// A2: every try together stays within timeoutSeconds, so the client still gives up before the move's lease ends. A
	// failure of the service itself (a busy or broken gateway, the network) is tried once more while time is left; an
	// answer it gave, or running out of time, is final.
	static TRANSIENT = new Set( [ 429, 500, 502, 503, 504 ] );
	static RETRY_MS = 2000;

	async _complete( request ) {
		const _end = Date.now() + this.timeoutSeconds * 1000;
		for ( let attempt = 1; ; attempt++ ) {
			try {
				return await this._once( request, _end );
			} catch ( error ) {
				const _left = _end - Date.now() - OpenAiProvider.RETRY_MS;
				if ( attempt >= 2 || !error.transient || _left < 5000 ) { throw error; }
				this.log?.append( 'ai_retry', { role: request.role, reason: String( error.message ).slice( 0, 120 ) } );
				await new Promise( resolve => setTimeout( resolve, OpenAiProvider.RETRY_MS ) );
			}
		}
	}

	async _once( { role, instructions, input, contract, repair = null }, end ) {
		const _repair = repair ? `\n\nYour previous answer was refused: ${Provider.note( repair, contract ).join( '; ' )}. Follow the format exactly.` : '';
		const _response = await this._fetch( `${this.baseUrl.replace( /\/$/, '' )}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify( {
				model: this.modelFor( role ),
				messages: [
					{ role: 'system', content: `${instructions}\n${OpenAiProvider.format( contract )}` },
					{ role: 'user', content: `${JSON.stringify( input ) ?? 'null'}${_repair}` },
				],
				response_format: { type: 'json_object' }, // eslint-disable-line camelcase
				temperature: 0.2,
				...( this.effortFor( role ) ? { reasoning_effort: this.effortFor( role ) } : {} ), // eslint-disable-line camelcase
			} ),
			// The key goes to the configured endpoint only: a redirect is refused, never followed with the key.
			redirect: 'error',
			// A2: the client gives up before the move's lease ends.
			signal: AbortSignal.timeout( Math.max( 1, end - Date.now() ) ),
		} );
		if ( !_response.ok ) {
			throw Object.assign( new Error( `inference for ${role} failed: HTTP ${_response.status}` ), { transient: OpenAiProvider.TRANSIENT.has( _response.status ) } );
		}
		const _data = await _response.json();
		const _choice = _data?.choices?.[ 0 ];
		const _text = OpenAiProvider.text( _choice?.message?.content );
		// A model that reached its token limit before it answered (a reasoning model that thought its whole budget away)
		// gave no answer at all: said so, instead of a broken answer a repair cannot mend under the same limit.
		if ( !_text.trim() && _choice?.finish_reason === 'length' ) {
			const _used = Number.isFinite( _data?.usage?.completion_tokens ) ? ` (${_data.usage.completion_tokens} tokens)` : '';
			throw Object.assign( new Error( `${this.modelFor( role )} reached its token limit${_used} before it answered; give the role ${role} a lower effort (LLM_EFFORT) or another model (LLM_MODELS)` ),
				{ transient: false } );
		}
		return OpenAiProvider.parse( _text );
	}

	// The request itself; a network failure (no answer at all, not a timeout) may be tried once more.
	async _fetch( url, options ) {
		try {
			return await fetch( url, options );
		} catch ( error ) {
			const _timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
			throw Object.assign( error instanceof Error ? error : new Error( String( error ) ), { transient: !_timeout } );
		}
	}

	// The content of a message: a string, or a list of parts whose text parts are read in order.
	static text( content ) {
		if ( typeof content === 'string' ) { return content; }
		if ( Array.isArray( content ) ) {
			return content.filter( part => part?.type === 'text' && typeof part.text === 'string' ).map( part => part.text ).join( '' );
		}
		return '';
	}

	// The one JSON object of an answer, also inside prose or a markdown fence. Anything else (no object, two of them,
	// JSON that does not parse) is null: a broken answer that gets its one repair (6.4), never an exception.
	static parse( text ) {
		const _whole = OpenAiProvider._json( text.trim() );
		if ( _whole !== undefined ) { return _whole; }
		const _objects = OpenAiProvider.objects( text );
		return _objects.length === 1 ? OpenAiProvider._json( _objects[ 0 ] ) ?? null : null;
	}

	static _json( text ) {
		try {
			return JSON.parse( text );
		} catch {
			return undefined;
		}
	}

	// The top-level {…} spans of a text; braces inside JSON strings do not count.
	static objects( text ) {
		const _found = [];
		let _depth = 0;
		let _start = -1;
		let _string = false;
		for ( let i = 0; i < text.length; i++ ) {
			const _char = text[ i ];
			if ( _string ) {
				if ( _char === '\\' ) { i++; } else if ( _char === '"' ) { _string = false; }
			} else if ( _char === '"' && _depth > 0 ) {
				_string = true;
			} else if ( _char === '{' ) {
				if ( _depth++ === 0 ) { _start = i; }
			} else if ( _char === '}' && _depth > 0 && --_depth === 0 ) {
				_found.push( text.slice( _start, i + 1 ) );
			}
		}
		return _found;
	}

	// The step contract as a template a model can follow; models tend to copy a JSON schema instead of filling it.
	static format( contract ) {
		const _quoted = values => ( Array.isArray( values ) ? values : [] ).map( value => `"${value}"` );
		const _describe = {
			string: () => 'text',
			number: () => 'a number',
			list: field => ( Array.isArray( field.values ) ? `a list of values from ${_quoted( field.values ).join( ', ' )}` : 'a list of strings' ),
			enum: field => `one of ${_quoted( field.values ).join( ' | ' )}`,
			records: field => `a list of objects like { ${Object.entries( field.fields || {} ).map( ( [ key, type ] ) => `"${key}": ${type?.type ?? type}` ).join( ', ' )} }`,
		};
		const _lines = Object.entries( contract.fields ).map( ( [ name, field ] ) => {
			const _optional = field.required === false ? ' (may be empty)' : '';
			const _type = Object.hasOwn( _describe, field.type ) ? _describe[ field.type ]( field ) : 'a value';
			return `  "${name}": ${_type}${_optional}`;
		} );
		return `Answer with exactly one JSON object with these keys and nothing else:\n{\n${_lines.join( ',\n' )}\n}`;
	}

} );
