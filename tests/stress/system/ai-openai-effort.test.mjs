// core/ai/openaiprovider.js, part two: a reasoning model that thinks its whole token limit away, and LLM_EFFORT, how
// long a model may think, per role or for every role. Seen live: on a whole PHP parser both models of the endpoint
// spent 32,768 tokens on reasoning and answered nothing; with reasoning_effort they answered in seconds.
import http from 'node:http';
import assert from 'node:assert/strict';
import { attack, attacks, within } from '../hostile.mjs';
import { use } from '../../helper.mjs';

const [ OpenAiProvider ] = await use( 'Core.Ai.OpenAiProvider' );
const S = 'core/ai/openaiprovider.js';
const KEY = 'sk-test-0123456789-secret';
const TEXT = { fields: { text: { type: 'string' } } };

// A fake inference server; handler( req, res, body, n ) answers the n-th request. Every request is recorded.
async function serve( handler ) {
	const _requests = [];
	const _server = http.createServer( ( req, res ) => {
		const _chunks = [];
		req.on( 'data', chunk => _chunks.push( chunk ) );
		req.on( 'end', () => {
			const _text = Buffer.concat( _chunks ).toString( 'utf8' );
			let _body;
			try { _body = JSON.parse( _text ); } catch { _body = _text; }
			_requests.push( { method: req.method, url: req.url, headers: req.headers, body: _body } );
			handler( req, res, _body, _requests.length );
		} );
	} );
	await new Promise( resolve => _server.listen( 0, '127.0.0.1', resolve ) );
	const _port = _server.address().port;
	return {
		url: `http://127.0.0.1:${_port}/v1`, port: _port, requests: _requests,
		close: () => {
			_server.closeAllConnections();
			return new Promise( resolve => _server.close( () => resolve() ) );
		},
	};
}

const json = ( res, status, data ) => {
	res.writeHead( status, { 'Content-Type': 'application/json' } );
	res.end( typeof data === 'string' ? data : JSON.stringify( data ) );
};
const content = text => ( { choices: [ { message: { role: 'assistant', content: text } } ] } );
// Answers with the given contents in turn (the last one repeats).
const replies = ( ...texts ) => ( req, res, body, n ) => json( res, 200, content( texts[ Math.min( n, texts.length ) - 1 ] ) );

const recorder = () => {
	const _events = [];
	return { events: _events, append: ( kind, data ) => _events.push( { kind, data } ) };
};

// One call against a fresh server, closed afterwards. → { result | error, server, provider, log }.
async function call( handler, { contract = TEXT, input = [ 'in' ], instructions = 'Write a short report.', options = {}, baseUrl = null } = {} ) {
	const _server = await serve( handler );
	const _log = recorder();
	const _provider = new OpenAiProvider( { baseUrl: baseUrl || _server.url, apiKey: KEY, model: 'test-model', log: _log, ...options } );
	try {
		const _result = await within( _provider.complete( { role: 'writer', instructions, input, contract } ), 5000 );
		return { result: _result, server: _server, provider: _provider, log: _log };
	} catch ( error ) {
		return { error, server: _server, provider: _provider, log: _log };
	} finally {
		await _server.close();
	}
}

// A reasoning model that thinks its whole token budget away answers with no content and finish_reason "length".
// (The fields as the wire spells them, so as JSON text.)
const exhausted = ( extra = {} ) => ( { ...JSON.parse( `{"choices":[{"message":{"content":"","reasoning_content":"${'x'.repeat( 1000 )}"},"finish_reason":"length"}],`
	+ '"usage":{"completion_tokens":32768,"completion_tokens_details":{"reasoning_tokens":32768}}}' ), ...extra } );
const stopped = ( text, reason ) => JSON.parse( `{"choices":[{"message":{"content":${JSON.stringify( text )}},"finish_reason":"${reason}"}]}` );

attack( S, 'a model that reached its token limit before it answered is named so, once: no repair, no retry under the same limit', async () => {
	const { error, server } = await call( ( req, res ) => json( res, 200, exhausted() ) );
	assert.match( error?.message || '', /test-model reached its token limit \(32768 tokens\) before it answered; give the role writer a lower effort \(LLM_EFFORT\) or another model \(LLM_MODELS\)/ );
	assert.equal( server.requests.length, 1 );
} );

// LLM_EFFORT: how long a reasoning model may think, per role or for every role.
attacks( S, [
	{ name: 'effort: a role\'s own effort goes with its request as reasoning_effort', effort: { writer: 'medium' }, want: 'medium' },
	{ name: 'effort: one effort for every role ("*") goes with every request', effort: { '*': 'low' }, want: 'low' },
	{ name: 'effort: a role\'s own effort comes before the one for every role', effort: { '*': 'low', writer: 'high' }, want: 'high' },
	{ name: 'effort: another role\'s effort is not this one\'s', effort: { coder: 'medium' }, want: undefined },
	{ name: 'effort: none set sends none (the endpoint decides)', effort: {}, want: undefined },
	{ name: 'effort: a role named like a property of every object is no role', effort: JSON.parse( '{"__proto__":{"writer":"high"}}' ), want: undefined },
], async ( { effort, want } ) => {
	const { server } = await call( replies( '{"text":"ok"}' ), { options: { effort } } );
	assert.equal( server.requests[ 0 ].body.reasoning_effort, want );
} );

attack( S, 'the token limit without a usage report is named without a number', async () => {
	const { error } = await call( ( req, res ) => json( res, 200, exhausted( { usage: null } ) ) );
	assert.match( error?.message || '', /test-model reached its token limit before it answered/ );
} );

attack( S, 'the token limit names the model of the role that hit it (LLM_MODELS)', async () => {
	const { error } = await call( ( req, res ) => json( res, 200, exhausted() ), { options: { models: { writer: 'slow-thinker' } } } );
	assert.match( error?.message || '', /^slow-thinker reached its token limit/ );
} );

attack( S, 'an answer cut by the limit that still has text is a broken answer and gets its repair', async () => {
	const { result, server } = await call( ( req, res, body, n ) => json( res, 200, n === 1
		? stopped( '{"text":"half', 'length' ) : content( '{"text":"whole"}' ) ) );
	assert.deepEqual( result, { text: 'whole' } );
	assert.equal( server.requests.length, 2 );
} );

attack( S, 'an empty answer that stopped for another reason is a broken answer, as before', async () => {
	const { result } = await call( ( req, res, body, n ) => json( res, 200, n === 1
		? stopped( '', 'stop' ) : content( '{"text":"ok"}' ) ) );
	assert.deepEqual( result, { text: 'ok' } );
} );

attacks( S, [
	{ name: 'LLM_EFFORT: one effort for every role', text: 'medium', want: { '*': 'medium' } },
	{ name: 'LLM_EFFORT: an effort per role, blanks around them are no part of them', text: 'coder=medium, judge = low', want: { coder: 'medium', judge: 'low' } },
	{ name: 'LLM_EFFORT: one for every role and one for the coder', text: 'low,coder=high', want: { '*': 'low', coder: 'high' } },
	{ name: 'LLM_EFFORT: unset is none', text: undefined, want: {} },
	{ name: 'LLM_EFFORT: empty is none', text: '', want: {} },
], async ( { text, want } ) => {
	const [ Config ] = await use( 'Lib.Config' );
	assert.deepEqual( Config._effort( text ), want );
} );

attacks( S, [ 'none', 'LOW', 'coder=max', 'coder=', '=low', 'Coder=low', '__proto__=low', 'coder=low=high', '1' ].map( text => ( {
	name: `LLM_EFFORT: ${JSON.stringify( text )} stops the start (an effort the endpoints do not know would be sent as it is)`, text,
} ) ), async ( { text } ) => {
	const [ Config ] = await use( 'Lib.Config' );
	assert.throws( () => Config._effort( text ), /LLM_EFFORT must be one of low, medium, high/ );
} );
