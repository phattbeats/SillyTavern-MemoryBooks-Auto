// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// maxTokensMigration.test.js — PHA-1846 follow-up regression: lowering
// DEFAULT_MAX_TOKENS from 4000 to 0 (see index.js) only fixes fresh settings
// objects. Anyone who already had this extension installed got 4000 written
// into moduleSettings.maxTokens by validateSettings the first time it ever
// ran, and that persisted value keeps silently capping every STMB request
// regardless of the constant. A v7 migration must reset that specific stale
// value back to 0 on existing installs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, 'index.js');
const BUILD_PATH = resolve(__dirname, 'index.build.js');

const indexSrc = readFileSync(INDEX_PATH, 'utf8');

test('DEFAULT_MAX_TOKENS is 0 (inherit the Chat Completion preset)', () => {
    assert.match(
        indexSrc,
        /const\s+DEFAULT_MAX_TOKENS\s*=\s*0\s*;/,
        'expected DEFAULT_MAX_TOKENS to be 0',
    );
});

test('defaultSettings migrationVersion is at least 7 (forces the v7 migration to run on existing installs)', () => {
    const defaultBlock = indexSrc.match(
        /const\s+defaultSettings\s*=\s*\{[\s\S]*?migrationVersion\s*:\s*(\d+)\s*,/,
    );
    assert.ok(defaultBlock, 'defaultSettings block not found');
    assert.ok(
        Number(defaultBlock[1]) >= 7,
        `expected migrationVersion >= 7, got ${defaultBlock[1]}`,
    );
});

test('initializeSettings has a v7 migration that resets a stale maxTokens: 4000 back to DEFAULT_MAX_TOKENS', () => {
    assert.match(
        indexSrc,
        /currentVersion\s*<\s*7[\s\S]{0,600}?moduleSettings\?\.maxTokens\s*===\s*4000[\s\S]{0,200}?moduleSettings\.maxTokens\s*=\s*DEFAULT_MAX_TOKENS/,
        'expected a v7 migration that resets moduleSettings.maxTokens from 4000 to DEFAULT_MAX_TOKENS',
    );
    assert.match(
        indexSrc,
        /currentVersion\s*<\s*7[\s\S]{0,800}?migrationVersion\s*=\s*7/,
        'expected the v7 migration to bump migrationVersion to 7',
    );
});

test('index.build.js contains the v7 maxTokens migration (bundled output is in sync)', () => {
    const built = readFileSync(BUILD_PATH, 'utf8');
    assert.match(built, /maxTokens\s*===\s*4000/);
});
