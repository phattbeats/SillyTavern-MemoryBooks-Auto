// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CONTEXT_BUDGET_DEFAULTS,
    estimateTokens,
    resolveContextWindow,
    planContextBudget,
    fitsInOneCall,
    planPasses,
    planTokenBoundedPasses,
} from './contextBudget.js';

test('resolveContextWindow defaults to the 256k target when nothing is detectable', () => {
    assert.equal(resolveContextWindow(), CONTEXT_BUDGET_DEFAULTS.target);
    assert.equal(resolveContextWindow({}), 256000);
});

test('resolveContextWindow prefers per-chat override, then global override', () => {
    assert.equal(resolveContextWindow({ override: 128000 }), 128000);
    assert.equal(resolveContextWindow({ override: 128000, perChatOverride: 64000 }), 64000);
    // an override always beats a detected host value
    assert.equal(
        resolveContextWindow({ override: 128000, oaiSettings: { openai_max_context: 8000 } }),
        128000,
    );
});

test('resolveContextWindow reads the host chat-completion and textgen windows', () => {
    assert.equal(resolveContextWindow({ oaiSettings: { openai_max_context: 200000 } }), 200000);
    assert.equal(resolveContextWindow({ textgenSettings: { max_context_length: 32768 } }), 32768);
    assert.equal(resolveContextWindow({ textgenSettings: { truncation_length: 16384 } }), 16384);
    assert.equal(resolveContextWindow({ getMaxContextSize: () => 1000000 }), 1000000);
});

test('resolveContextWindow degrades to the target when the host throws or reports junk', () => {
    assert.equal(resolveContextWindow({ getMaxContextSize: () => { throw new Error('no backend'); } }), 256000);
    assert.equal(resolveContextWindow({ oaiSettings: { openai_max_context: 0 } }), 256000);
    assert.equal(resolveContextWindow({ oaiSettings: { openai_max_context: 'wat' } }), 256000);
    assert.equal(resolveContextWindow({ override: -5 }), 256000);
});

test('resolveContextWindow honours a genuinely small detected window', () => {
    assert.equal(resolveContextWindow({ oaiSettings: { openai_max_context: 8000 } }), 8000);
});

test('planContextBudget scales every work unit off the window', () => {
    const big = planContextBudget(256000);
    assert.equal(big.contextWindow, 256000);
    assert.equal(big.inputTokens, 153600);        // 60%
    assert.equal(big.coverageTokenBudget, 76800); // half of input
    assert.equal(big.auditTokenCap, big.inputTokens);
    assert.equal(big.isLargeContext, true);

    const small = planContextBudget(64000);
    assert.equal(small.inputTokens, 38400);
    assert.equal(small.isLargeContext, true, '64k is the floor, still "large"');

    const tiny = planContextBudget(8000);
    assert.equal(tiny.isLargeContext, false);
    assert.ok(tiny.inputTokens < small.inputTokens);
});

test('planContextBudget caps output tokens but derives them from the window', () => {
    // 15% of 256k would be 38400 -> clamped to the 32k ceiling
    assert.equal(planContextBudget(256000).outputTokens, CONTEXT_BUDGET_DEFAULTS.maxOutputTokens);
    // 15% of 64k = 9600, under the ceiling, so used as-is
    assert.equal(planContextBudget(64000).outputTokens, 9600);
    // never degenerate to zero
    assert.equal(planContextBudget(1000).outputTokens, 1000);
});

test('planContextBudget falls back to the target for junk input', () => {
    assert.equal(planContextBudget(0).contextWindow, 256000);
    assert.equal(planContextBudget(null).contextWindow, 256000);
});

test('planContextBudget accepts a policy override', () => {
    const budget = planContextBudget(100000, { inputFraction: 0.9 });
    assert.equal(budget.inputTokens, 90000);
});

test('fitsInOneCall is the whole-story question the old chunker never asked', () => {
    const budget = planContextBudget(256000); // inputTokens 153600
    assert.equal(fitsInOneCall(150000, budget), true);
    assert.equal(fitsInOneCall(153600, budget), true, 'exactly at the budget still fits');
    assert.equal(fitsInOneCall(153601, budget), false);
    assert.equal(fitsInOneCall(0, budget), false);
});

test('fitsInOneCall refuses to one-shot on a sub-floor model', () => {
    const budget = planContextBudget(8000);
    assert.equal(budget.isLargeContext, false);
    assert.equal(fitsInOneCall(100, budget), false, 'small models never take the one-shot path');
});

test('planPasses returns a single pass when the story fits', () => {
    const budget = planContextBudget(256000);
    assert.deepEqual(planPasses(120000, budget), { passes: 1, tokensPerPass: 120000, oneShot: true });
});

test('planPasses splits into the FEWEST equal passes, not fixed slices', () => {
    const budget = planContextBudget(256000); // inputTokens 153600
    const plan = planPasses(400000, budget);
    assert.equal(plan.passes, 3, 'ceil(400000/153600)');
    assert.equal(plan.oneShot, false);
    // equalised, so no runt final pass
    assert.equal(plan.tokensPerPass, Math.ceil(400000 / 3));
    assert.ok(plan.tokensPerPass <= budget.inputTokens);
});

test('planPasses on the old 20k-cap behaviour shows the improvement', () => {
    const legacyPasses = Math.ceil(400000 / 20000); // what the hardcoded tokenCap did
    const plan = planPasses(400000, planContextBudget(256000));
    assert.equal(legacyPasses, 20);
    assert.ok(plan.passes < legacyPasses / 5, 'at least 5x fewer LLM calls');
});

test('planPasses handles an empty story', () => {
    assert.deepEqual(planPasses(0, planContextBudget(256000)), {
        passes: 0, tokensPerPass: 153600, oneShot: false,
    });
});

test('planTokenBoundedPasses greedily fills to the token cap with no message-count cap', () => {
    // each message ~25 tokens (100 chars / 4)
    const messages = Array.from({ length: 10 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    const passes = planTokenBoundedPasses(messages, 100);
    assert.equal(passes.length, 3, '4 + 4 + 2 messages');
    assert.deepEqual(passes[0], { start: 0, end: 3, tokens: 100 });
    assert.deepEqual(passes[2], { start: 8, end: 9, tokens: 50 });
    passes.forEach(p => assert.ok(p.tokens <= 100));
});

test('planTokenBoundedPasses puts the whole list in one pass under a large budget', () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    const passes = planTokenBoundedPasses(messages, 153600);
    assert.equal(passes.length, 1, '500 messages, no 40-message cap any more');
    assert.deepEqual(passes[0], { start: 0, end: 499, tokens: 12500 });
});

test('planTokenBoundedPasses never drops an oversized single message', () => {
    const messages = [
        { id: 0, text: 'x'.repeat(10) },
        { id: 1, text: 'x'.repeat(100000) },
        { id: 2, text: 'x'.repeat(10) },
    ];
    const passes = planTokenBoundedPasses(messages, 100);
    const covered = passes.flatMap(p => Array.from({ length: p.end - p.start + 1 }, (_, k) => p.start + k));
    assert.deepEqual(covered, [0, 1, 2], 'every message is covered exactly once');
});

test('planTokenBoundedPasses handles empty and non-array input', () => {
    assert.deepEqual(planTokenBoundedPasses([], 1000), []);
    assert.deepEqual(planTokenBoundedPasses(null, 1000), []);
});

test('estimateTokens matches the fork chars/4 heuristic', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
});
