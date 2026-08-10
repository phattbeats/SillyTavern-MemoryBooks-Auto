// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STMB_AUTO_DEFAULTS,
    resolveStmbAutoConfig,
    planAutoMemoryChunks,
    planTokenBoundedMemoryChunks,
    resizeChunksToBudget,
    buildStmbAutoSummary,
} from './stmbAutoCore.js';

test('resolveStmbAutoConfig', async (t) => {
    await t.test('falls back to defaults when nothing is configured', () => {
        assert.deepEqual(resolveStmbAutoConfig(undefined, undefined), {
            ...STMB_AUTO_DEFAULTS,
            memoryIntervalPinned: false,
        });
    });

    await t.test('flags a hand-pinned memoryInterval so the legacy path is kept', () => {
        assert.equal(resolveStmbAutoConfig(undefined, undefined).memoryIntervalPinned, false);
        assert.equal(resolveStmbAutoConfig({ auto: { memoryInterval: 10 } }, undefined).memoryIntervalPinned, true);
        assert.equal(
            resolveStmbAutoConfig(undefined, { stmbc: { auto: { memoryInterval: 5 } } }).memoryIntervalPinned,
            true,
        );
        assert.equal(resolveStmbAutoConfig({ auto: { bulkGenerateCap: 5 } }, undefined).memoryIntervalPinned, false);
    });

    await t.test('global overrides defaults', () => {
        const cfg = resolveStmbAutoConfig({ auto: { memoryInterval: 10 } }, undefined);
        assert.equal(cfg.memoryInterval, 10);
        assert.equal(cfg.bulkGenerateCap, STMB_AUTO_DEFAULTS.bulkGenerateCap);
    });

    await t.test('per-chat overrides global', () => {
        const cfg = resolveStmbAutoConfig(
            { auto: { memoryInterval: 10 } },
            { stmbc: { auto: { memoryInterval: 5 } } },
        );
        assert.equal(cfg.memoryInterval, 5);
    });

    await t.test('ignores null/undefined override values', () => {
        const cfg = resolveStmbAutoConfig({ auto: { memoryInterval: null } }, undefined);
        assert.equal(cfg.memoryInterval, STMB_AUTO_DEFAULTS.memoryInterval);
    });
});

test('planAutoMemoryChunks', async (t) => {
    await t.test('fresh chat, unset watermark, starts at 0', () => {
        const chunks = planAutoMemoryChunks(null, 9, 5);
        assert.deepEqual(chunks, [{ start: 0, end: 4 }, { start: 5, end: 9 }]);
    });

    await t.test('resumes from one past the watermark', () => {
        const chunks = planAutoMemoryChunks(4, 9, 5);
        assert.deepEqual(chunks, [{ start: 5, end: 9 }]);
    });

    await t.test('already caught up returns no chunks', () => {
        assert.deepEqual(planAutoMemoryChunks(9, 9, 5), []);
    });

    await t.test('watermark past the end of the chat (stale/edited) returns no chunks', () => {
        assert.deepEqual(planAutoMemoryChunks(20, 9, 5), []);
    });

    await t.test('interval larger than the whole chat produces one chunk', () => {
        assert.deepEqual(planAutoMemoryChunks(null, 9, 100), [{ start: 0, end: 9 }]);
    });

    await t.test('last chunk is clipped to lastIndex, not padded', () => {
        const chunks = planAutoMemoryChunks(null, 11, 5);
        assert.deepEqual(chunks, [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 11 }]);
    });

    await t.test('invalid/negative interval falls back to the default', () => {
        const chunks = planAutoMemoryChunks(null, 30, -1);
        assert.equal(chunks[0].end - chunks[0].start + 1, STMB_AUTO_DEFAULTS.memoryInterval);
    });

    await t.test('no messages at all (lastIndex < 0) returns no chunks', () => {
        assert.deepEqual(planAutoMemoryChunks(null, -1, 5), []);
    });
});

test('buildStmbAutoSummary', async (t) => {
    await t.test('reports a freshly created lorebook', () => {
        const msg = buildStmbAutoSummary({
            lorebookName: 'LTM - Foo',
            lorebookCreated: true,
            memoriesPlanned: 0,
            memoriesCreated: 0,
            loreGenerated: 0,
            loreSkipped: 0,
        });
        assert.match(msg, /Created and bound lorebook "LTM - Foo"/);
        assert.match(msg, /No new scenes to summarize\./);
        assert.match(msg, /No missing or thin character\/location entries found\./);
    });

    await t.test('reports an existing lorebook without claiming creation', () => {
        const msg = buildStmbAutoSummary({ lorebookName: 'LTM - Foo', lorebookCreated: false });
        assert.match(msg, /Lorebook: "LTM - Foo"\./);
        assert.doesNotMatch(msg, /Created and bound/);
    });

    await t.test('pluralizes a single created memory correctly', () => {
        const msg = buildStmbAutoSummary({ memoriesPlanned: 1, memoriesCreated: 1 });
        assert.match(msg, /1\/1 scene memory created\./);
    });

    await t.test('pluralizes multiple created memories correctly', () => {
        const msg = buildStmbAutoSummary({ memoriesPlanned: 3, memoriesCreated: 2 });
        assert.match(msg, /2\/3 scene memories created\./);
    });

    await t.test('surfaces a skip reason instead of the planned/created count', () => {
        const msg = buildStmbAutoSummary({ memoriesPlanned: 3, memoriesCreated: 0, memorySkipReason: 'no lorebook bound' });
        assert.match(msg, /Scene memories skipped: no lorebook bound/);
        assert.doesNotMatch(msg, /0\/3/);
    });

    await t.test('includes the audit message when present', () => {
        const msg = buildStmbAutoSummary({ auditMessage: 'Audit complete: 2 chunks · 5 characters.' });
        assert.match(msg, /Audit complete: 2 chunks · 5 characters\./);
    });

    await t.test('prefers an explicit lore message over the generic no-op line', () => {
        const msg = buildStmbAutoSummary({ loreMessage: 'Generated 3/3 entries into "LTM - Foo".', loreGenerated: 3 });
        assert.match(msg, /Generated 3\/3 entries/);
        assert.doesNotMatch(msg, /No missing or thin/);
    });
});

// PHA-1870: scene-memory chunks are sized from the context window, and the
// non-interactive token gate resizes rather than aborts.

/** 400 chars ~= 100 tokens under the chars/4 heuristic. */
const msg = (chars) => 'x'.repeat(chars);

test('planTokenBoundedMemoryChunks', async (t) => {
    await t.test('fills each chunk to the token budget instead of a fixed interval', () => {
        // 10 messages of ~100 tokens each, 250-token budget => 100+100 per chunk.
        const chunks = planTokenBoundedMemoryChunks(null, 9, () => msg(400), 250);
        assert.deepEqual(chunks.map(c => [c.start, c.end]), [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]]);
        assert.equal(chunks[0].tokens, 200);
    });

    await t.test('a big budget swallows the whole tail in one chunk', () => {
        const chunks = planTokenBoundedMemoryChunks(null, 9, () => msg(400), 153600);
        assert.deepEqual(chunks, [{ start: 0, end: 9, tokens: 1000 }]);
    });

    await t.test('starts after the watermark and no-ops when caught up', () => {
        assert.deepEqual(
            planTokenBoundedMemoryChunks(7, 9, () => msg(400), 153600),
            [{ start: 8, end: 9, tokens: 200 }],
        );
        assert.deepEqual(planTokenBoundedMemoryChunks(9, 9, () => msg(400), 1000), []);
        assert.deepEqual(planTokenBoundedMemoryChunks(null, -1, () => msg(400), 1000), []);
    });

    await t.test('an oversized single message still gets its own chunk', () => {
        const chunks = planTokenBoundedMemoryChunks(null, 1, (i) => msg(i === 0 ? 8000 : 400), 500);
        assert.deepEqual(chunks.map(c => [c.start, c.end]), [[0, 0], [1, 1]]);
        assert.equal(chunks[0].tokens, 2000);
    });
});

test('resizeChunksToBudget', async (t) => {
    const getText = () => msg(400); // ~100 tokens each

    await t.test('leaves a chunk that already fits alone', () => {
        const result = resizeChunksToBudget([{ start: 0, end: 3 }], getText, 1000);
        assert.equal(result.resized, false);
        assert.deepEqual(result.chunks, [{ start: 0, end: 3, tokens: 400 }]);
        assert.deepEqual(result.oversized, []);
    });

    await t.test('re-splits an oversized chunk instead of failing it', () => {
        const result = resizeChunksToBudget([{ start: 0, end: 9 }], getText, 250);
        assert.equal(result.resized, true);
        assert.deepEqual(result.oversized, []);
        assert.deepEqual(result.chunks.map(c => [c.start, c.end]), [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]]);
        assert.ok(result.chunks.every(c => c.tokens <= 250));
    });

    await t.test('preserves chunk offsets when resizing a later range', () => {
        const result = resizeChunksToBudget([{ start: 20, end: 23 }], getText, 150);
        assert.deepEqual(result.chunks.map(c => [c.start, c.end]), [[20, 20], [21, 21], [22, 22], [23, 23]]);
    });

    await t.test('reports only a single message that cannot fit at all', () => {
        const result = resizeChunksToBudget(
            [{ start: 0, end: 2 }],
            (i) => msg(i === 1 ? 8000 : 400),
            500,
        );
        assert.deepEqual(result.oversized, [{ id: 1, tokens: 2000 }]);
        // The unrunnable message is still surfaced as its own chunk, and the
        // messages around it are not dragged down with it.
        assert.deepEqual(result.chunks.map(c => [c.start, c.end]), [[0, 0], [1, 1], [2, 2]]);
    });

    await t.test('ignores malformed chunks and a missing cap', () => {
        assert.deepEqual(resizeChunksToBudget(null, getText, 500).chunks, []);
        assert.deepEqual(resizeChunksToBudget([{ start: 5, end: 1 }], getText, 500).chunks, []);
        assert.deepEqual(
            resizeChunksToBudget([{ start: 0, end: 1 }], getText, 0).chunks,
            [{ start: 0, end: 1, tokens: 200 }],
        );
    });
});
