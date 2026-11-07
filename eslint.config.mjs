import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

// The house style of this repository, written down as rules: tabs, blanks inside brackets and parentheses, single
// quotes, short files and functions. Class files are plain scripts that share one global `app`; they run in
// Node (lib, core, gate) or in the browser (ui).

const style = {
	'@stylistic/indent': [ 'error', 'tab', { SwitchCase: 1 } ],
	'@stylistic/no-mixed-spaces-and-tabs': 'error',
	'@stylistic/space-in-parens': [ 'error', 'always', { exceptions: [ 'empty' ] } ],
	'@stylistic/array-bracket-spacing': [ 'error', 'always' ],
	'@stylistic/object-curly-spacing': [ 'error', 'always' ],
	'@stylistic/computed-property-spacing': [ 'error', 'always' ],
	'@stylistic/template-curly-spacing': [ 'error', 'never' ],
	'@stylistic/block-spacing': [ 'error', 'always' ],
	'@stylistic/quotes': [ 'error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' } ],
	'@stylistic/quote-props': [ 'error', 'as-needed' ],
	'@stylistic/semi': [ 'error', 'always' ],
	'@stylistic/semi-spacing': 'error',
	'@stylistic/brace-style': [ 'error', '1tbs', { allowSingleLine: true } ],
	'@stylistic/arrow-parens': [ 'error', 'as-needed', { requireForBlockBody: true } ],
	'@stylistic/arrow-spacing': 'error',
	'@stylistic/space-before-function-paren': [ 'error', { anonymous: 'never', named: 'never', asyncArrow: 'always' } ],
	'@stylistic/space-before-blocks': 'error',
	'@stylistic/keyword-spacing': 'error',
	'@stylistic/space-infix-ops': 'error',
	'@stylistic/space-unary-ops': 'error',
	'@stylistic/comma-spacing': 'error',
	'@stylistic/comma-dangle': [ 'error', 'always-multiline' ],
	'@stylistic/key-spacing': 'error',
	'@stylistic/no-trailing-spaces': 'error',
	'@stylistic/eol-last': 'error',
	'@stylistic/no-multiple-empty-lines': [ 'error', { max: 1, maxEOF: 0, maxBOF: 0 } ],
	'@stylistic/lines-between-class-members': [ 'error', 'always', { exceptAfterSingleLine: true } ],
	'@stylistic/spaced-comment': [ 'error', 'always' ],
	'@stylistic/new-parens': 'error',
	'@stylistic/no-extra-semi': 'error',
	'@stylistic/max-len': [ 'warn', {
		code: 140,
		tabWidth: 4,
		ignoreUrls: true,
		ignoreStrings: true,
		ignoreTemplateLiterals: true,
		ignoreRegExpLiterals: true,
	} ],
};

const quality = {
	curly: [ 'error', 'all' ],
	eqeqeq: [ 'error', 'always' ],
	'no-var': 'error',
	'prefer-const': 'error',
	'prefer-template': 'error',
	'object-shorthand': [ 'error', 'always' ],
	camelcase: [ 'error', { properties: 'always' } ],
	'no-shadow': 'error',
	'no-implicit-globals': 'error',
	'no-unused-vars': [ 'error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' } ],
	'no-console': [ 'warn', { allow: [ 'warn', 'error' ] } ],
	'max-lines': [ 'error', { max: 500, skipBlankLines: false, skipComments: false } ],
	'max-statements': [ 'warn', 40 ],
	'max-depth': [ 'warn', 5 ],
	'max-params': [ 'warn', 6 ],
	complexity: [ 'warn', 25 ],
};

export default [
	{
		ignores: [ 'node_modules/**', 'storage/**' ],
	},
	js.configs.recommended,
	{
		files: [ 'lib/**/*.js', 'core/**/*.js', 'gate/**/*.js', 'world/**/*.js', 'baseline/**/*.js' ],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'script',
			globals: { ...globals.node, app: 'readonly' },
		},
		plugins: { '@stylistic': stylistic },
		rules: { ...style, ...quality },
	},
	{
		files: [ 'ui/**/*.js' ],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'script',
			globals: { ...globals.browser, app: 'readonly' },
		},
		plugins: { '@stylistic': stylistic },
		rules: { ...style, ...quality },
	},
	{
		files: [ 'lib/app.js' ],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node, app: 'off' },
		},
	},
	{
		files: [ '**/*.mjs' ],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: { ...globals.node },
		},
		plugins: { '@stylistic': stylistic },
		rules: { ...style, ...quality, 'no-console': 'off' },
	},
];
