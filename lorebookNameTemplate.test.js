// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// PHA-2675 — auto-created lorebook names must not double-apply a prefix the
// character name already carries. The regression case is the first test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyLorebookNameTemplate } from './lorebookNameTemplate.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ----------------------------------------------------------------------------
// The PHA-2675 regression
// ----------------------------------------------------------------------------

test('PHA-2675: prefix already on the character name is not re-applied', () => {
    const name = applyLorebookNameTemplate('[E2E] {{char}} Memories', {
        char: '[E2E] Test Wanderer',
    });
    assert.equal(name, '[E2E] Test Wanderer Memories');
});

test('PHA-2675: the prefix is still applied when the name lacks it', () => {
    const name = applyLorebookNameTemplate('[E2E] {{char}} Memories', {
        char: 'Test Wanderer',
    });
    assert.equal(name, '[E2E] Test Wanderer Memories');
});

test('PHA-2675: dedupe is case-insensitive', () => {
    const name = applyLorebookNameTemplate('[e2e] {{char}} Memories', {
        char: '[E2E] Test Wanderer',
    });
    assert.equal(name, '[E2E] Test Wanderer Memories');
});

test('PHA-2675: only the redundant tail of a literal is dropped', () => {
    const name = applyLorebookNameTemplate('LTM - [E2E] {{char}}', {
        char: '[E2E] Test Wanderer',
    });
    assert.equal(name, 'LTM - [E2E] Test Wanderer');
});

// ----------------------------------------------------------------------------
// Suffix side
// ----------------------------------------------------------------------------

test('a suffix already on the character name is not re-applied', () => {
    const name = applyLorebookNameTemplate('{{char}} Memories', {
        char: 'Test Wanderer Memories',
    });
    assert.equal(name, 'Test Wanderer Memories');
});

test('a suffix is applied when the name only partially matches it', () => {
    const name = applyLorebookNameTemplate('{{char}} Memories', {
        char: 'Test Memoriser',
    });
    assert.equal(name, 'Test Memoriser Memories');
});

// ----------------------------------------------------------------------------
// The shipped default template is untouched
// ----------------------------------------------------------------------------

test('default template renders unchanged for ordinary names', () => {
    const name = applyLorebookNameTemplate('LTM - {{char}} - {{chat}}', {
        char: 'Seraphina',
        chat: 'Seraphina - 2026-08-30',
    });
    assert.equal(name, 'LTM - Seraphina - Seraphina - 2026-08-30');
});

test('default template drops its own LTM prefix when the char name carries it', () => {
    const name = applyLorebookNameTemplate('LTM - {{char}} - {{chat}}', {
        char: 'LTM - Seraphina',
        chat: 'c1',
    });
    assert.equal(name, 'LTM - Seraphina - c1');
});

test('pure separators are never treated as a dedupable prefix', () => {
    // The literal " - " has no word characters, so it always survives even
    // though the chat id happens to start with a dash.
    const name = applyLorebookNameTemplate('{{char}} - {{chat}}', {
        char: 'Bob',
        chat: '- 2026',
    });
    assert.equal(name, 'Bob - - 2026');
});

test('word boundaries are respected — LTM does not match LTMX', () => {
    const name = applyLorebookNameTemplate('LTM {{char}}', { char: 'LTMX Bob' });
    assert.equal(name, 'LTM LTMX Bob');
});

// ----------------------------------------------------------------------------
// Degenerate inputs
// ----------------------------------------------------------------------------

test('templates with no placeholders pass through trimmed', () => {
    assert.equal(applyLorebookNameTemplate('  Static Book  ', { char: 'Bob' }), 'Static Book');
});

test('missing values collapse without leaving stray separators', () => {
    assert.equal(applyLorebookNameTemplate('{{char}}', {}), '');
    assert.equal(applyLorebookNameTemplate('LTM - {{char}}', {}), 'LTM -');
});

test('whitespace-tolerant placeholders are substituted', () => {
    assert.equal(applyLorebookNameTemplate('{{ char }}', { char: 'Bob' }), 'Bob');
});

test('null/undefined template does not throw', () => {
    assert.equal(applyLorebookNameTemplate(undefined, { char: 'Bob' }), '');
    assert.equal(applyLorebookNameTemplate(null, { char: 'Bob' }), '');
});

// ----------------------------------------------------------------------------
// Call-site invariant — autocreate.js must use the helper, not raw replace()
// ----------------------------------------------------------------------------

test('autocreate.js delegates substitution to the helper', () => {
    const src = readFileSync(resolve(__dirname, 'autocreate.js'), 'utf8');
    assert.match(src, /import \{ applyLorebookNameTemplate \} from ['"]\.\/lorebookNameTemplate\.js['"]/);
    assert.match(src, /applyLorebookNameTemplate\(template,/);
    assert.doesNotMatch(src, /replace\(\/\\\{\\\{char\\\}\\\}\/g/, 'must not re-introduce the naive replace');
});
