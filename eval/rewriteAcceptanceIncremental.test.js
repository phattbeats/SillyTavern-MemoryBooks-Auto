// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 phattbeats
// SPDX-License-Identifier: AGPL-3.0-only
//
// eval/rewriteAcceptanceIncremental.test.js — PHA-2693 harness self-test.
//
// Same rule as rewriteAcceptance.test.js: every check is proven BOTH ways, on
// a clean case and on a deliberately broken one. Fully offline.
//
// Message ids are 1-BASED and entry content carries real `src: msgs N-M`
// citations, because that is the format `extractProvenanceRanges` accepts
// (auditorTechnicalPass.js requires `start >= 1`) and PHA-2722 made it the
// product's only provenance format.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { run, makeSlicedGenerate, makeCompliantSlicedGenerate } from './runIncrementalReplay.js';
import {
    checkDrift,
    checkIdempotence,
    checkCorrectionDurability,
    provenanceSpotCheck,
    compareCost,
    replayNSlices,
    runOneShotStep,
} from './rewriteAcceptance.js';

// ---------------------------------------------------------------- fixtures

const auditMessages = [
    { id: 1, speaker: 'Narrator', rawText: 'Grondulf the landlord frowned at the ledger about the unpaid rent again.' },
    { id: 2, speaker: 'Narrator', rawText: 'Pemberly the baker kneaded dough before dawn in her warm and floury kitchen.' },
    { id: 3, speaker: 'Narrator', rawText: 'Pemberly the baker delivered warm bread to the garrison gate at noon.' },
    { id: 4, speaker: 'Narrator', rawText: 'A stranger in a grey coat paid for a room upstairs in silver coin.' },
];

const GRONDULF_V1 = 'Grondulf the landlord frowned at the ledger about the unpaid rent again, a recurring complaint of his. (src: msgs 1-1)';
const GRONDULF_V2 = 'Grondulf, who keeps the ledger, is the landlord and complains about unpaid rent at every opportunity. (src: msgs 1-1)';
const PEMBERLY_V1 = 'Pemberly the baker kneaded dough before dawn in her warm and floury kitchen, every single morning. (src: msgs 2-2)';
const PEMBERLY_V2 = 'Pemberly the baker kneaded dough before dawn and delivered warm bread to the garrison gate at noon. (src: msgs 2-3)';
const STRANGER_V1 = 'A stranger in a grey coat paid for a room upstairs in silver coin, saying nothing else at all. (src: msgs 4-4)';

const gen = (payload) => ({ name: payload.name, keys: payload.keys, content: payload.content });

/** A `generate` that returns a scripted entry set per call index. */
function scripted(setsByCall) {
    let i = 0;
    return async () => {
        const set = setsByCall[Math.min(i, setsByCall.length - 1)];
        i++;
        return JSON.stringify({ entries: set });
    };
}

// ---------------------------------------------------------------- check 9, revisited

describe('checkDrift: coverage holes and the two bases', () => {
    const before = (content) => [{ title: 'A', content }];

    test('an entry with no citation is counted as a coverage HOLE, not silently ignored', () => {
        // Before PHA-2693 this entry was skipped and the check still reported
        // `ok: true` — an ok over an empty sample, which reads as verified.
        const r = checkDrift({
            before: before('no citation here at all'),
            after: [{ title: 'A', content: 'reworded' }],
            prevBoundary: 5,
        });
        assert.equal(r.ok, true);
        assert.equal(r.checked, 0);
        assert.equal(r.unscoreable, 1);   // the number that stops ok meaning "verified"
    });

    test('a cited entry whose source predates the boundary is scored, and fails when it drifted', () => {
        const clean = checkDrift({
            before: before('original (src: msgs 1-3)'),
            after: [{ title: 'A', content: 'original (src: msgs 1-3)' }],
            prevBoundary: 5,
        });
        assert.equal(clean.ok, true);
        assert.equal(clean.checked, 1);

        const drifted = checkDrift({
            before: before('original (src: msgs 1-3)'),
            after: [{ title: 'A', content: 'reworded (src: msgs 1-3)' }],
            prevBoundary: 5,
        });
        assert.equal(drifted.ok, false);
        assert.equal(drifted.offenders[0].title, 'A');
        assert.equal(drifted.basis, 'source-ref');
    });

    test('an entry whose citations reach into the new slice is correctly out of scope', () => {
        const r = checkDrift({
            before: before('original (src: msgs 1-9)'),
            after: [{ title: 'A', content: 'reworded (src: msgs 1-9)' }],
            prevBoundary: 5,
        });
        assert.equal(r.ok, true);
        assert.equal(r.checked, 0);
        assert.equal(r.unscoreable, 0);
    });

    test('a frozen set overrides the citation proxy and scores exactly what the run froze', () => {
        const r = checkDrift({
            before: [
                { title: 'A', content: 'a (src: msgs 1-1)' },
                { title: 'B', content: 'b (src: msgs 1-1)' },
            ],
            after: [
                { title: 'A', content: 'a (src: msgs 1-1)' },
                { title: 'B', content: 'B REWORDED (src: msgs 1-1)' },   // legitimately updated
            ],
            prevBoundary: 5,
            frozenTitles: new Set(['a']),
        });
        assert.equal(r.basis, 'frozen-set');
        assert.equal(r.checked, 1);      // only A — B was never claimed to be settled
        assert.equal(r.ok, true);
    });
});

// ---------------------------------------------------------------- check 10: idempotence

describe('checkIdempotence', () => {
    const slice = auditMessages.slice(0, 2);
    const transcriptText = slice.map((m) => `[${m.id}] ${m.speaker}: ${m.rawText}`).join('\n');

    async function seededBook() {
        const book = [];
        await runOneShotStep({
            book, auditMessages: slice, transcriptText,
            generate: scripted([[gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V1 })]]),
            cfg: { incremental: false },
        });
        return book;
    }

    test('a second pass that reproduces the same content leaves the book byte-identical', async () => {
        const book = await seededBook();
        const r = await checkIdempotence({
            book, auditMessages: slice, transcriptText,
            generate: scripted([[gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V1 })]]),
            cfg: { incremental: false },
        });
        assert.equal(r.ok, true);
        assert.deepEqual(r.moved, []);
    });

    test('a second pass that re-words the entry FAILS — this is the drift case', async () => {
        const book = await seededBook();
        const r = await checkIdempotence({
            book, auditMessages: slice, transcriptText,
            generate: scripted([[gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V2 })]]),
            cfg: { incremental: false },
        });
        assert.equal(r.ok, false);
        assert.deepEqual(r.moved, [{ title: 'Grondulf', reason: 'content changed' }]);
    });

    test('with incremental on, the same re-wording never gets the chance — the call is skipped', async () => {
        const book = await seededBook();
        const r = await checkIdempotence({
            book, auditMessages: slice, transcriptText,
            generate: scripted([[gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V2 })]]),
            cfg: { incremental: true },
        });
        assert.equal(r.ok, true);
        assert.equal(r.skippedCall, true);
    });
});

// ---------------------------------------------------------------- check 11: correction durability

describe('checkCorrectionDurability', () => {
    const HUMAN = 'HUMAN: Grondulf runs the inn. (src: msgs 1-1)';

    test('the hand-edited content is still in the book at the end', () => {
        const r = checkCorrectionDurability({
            book: [{ title: 'Grondulf', content: HUMAN }],
            pinnedAt: new Map([['Grondulf', { content: HUMAN, step: 1 }]]),
            steps: [{ index: 1, result: {} }, { index: 2, result: {} }],
        });
        assert.equal(r.ok, true);
        assert.equal(r.survived[0].stepsSurvived, 1);
    });

    test('an overwritten correction fails, however it happened', () => {
        const r = checkCorrectionDurability({
            book: [{ title: 'Grondulf', content: GRONDULF_V2 }],
            pinnedAt: new Map([['Grondulf', { content: HUMAN, step: 1 }]]),
            steps: [],
        });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].reason, 'the human correction was overwritten');
    });

    test('a vanished pinned entry fails too', () => {
        const r = checkCorrectionDurability({
            book: [],
            pinnedAt: new Map([['Grondulf', { content: HUMAN, step: 0 }]]),
            steps: [],
        });
        assert.equal(r.ok, false);
        assert.match(r.offenders[0].reason, /gone from the book/);
    });

    test('a later contradiction against the pin is collected as reported evidence', () => {
        const r = checkCorrectionDurability({
            book: [{ title: 'Grondulf', content: HUMAN }],
            pinnedAt: new Map([['Grondulf', { content: HUMAN, step: 0 }]]),
            steps: [{
                index: 2, boundary: 8,
                result: { pinning: { contradictions: [{ title: 'Grondulf', existing: 'a', proposed: 'b' }] } },
            }],
        });
        assert.equal(r.ok, true);
        assert.deepEqual(r.contradictionsReported, [{ title: 'Grondulf', atStep: 2, boundary: 8 }]);
    });
});

// ---------------------------------------------------------------- check 12: provenance spot-check

describe('provenanceSpotCheck', () => {
    const book = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t, i) => ({
        title: t,
        disable: false,
        stmbAutoConfidence: i % 2 ? 'inferred' : 'stated',
        content: `${t} says a thing. (src: msgs ${i + 1}-${i + 1})`,
    }));

    test('samples 5 entries and reports the citations each one actually carries', () => {
        const r = provenanceSpotCheck({ book, messages: auditMessages, sampleSize: 5 });
        assert.equal(r.sampleSize, 5);
        assert.equal(r.samples.length, 5);
        assert.equal(r.bookTotals.entries, 7);
        assert.equal(r.bookTotals.stated + r.bookTotals.inferred, 7);
        assert.equal(r.bookTotals.uncited, 0);
        assert.ok(r.samples.every((s) => s.citedRanges.length === 1));
    });

    test('sampling is deterministic — the same book always yields the same five', () => {
        const a = provenanceSpotCheck({ book, messages: auditMessages }).samples.map((s) => s.title);
        const b = provenanceSpotCheck({ book, messages: auditMessages }).samples.map((s) => s.title);
        assert.deepEqual(a, b);
    });

    test('each sample carries the cited message text, so the claim is checkable without the transcript', () => {
        const r = provenanceSpotCheck({ book, messages: auditMessages, sampleSize: 1 });
        assert.deepEqual(r.samples[0].citedRanges, ['1-1']);
        assert.equal(r.samples[0].cited[0].id, 1);
        assert.match(r.samples[0].cited[0].text, /Grondulf the landlord/);
    });

    test('an uncited book is reported as uncited, not scored as clean', () => {
        const r = provenanceSpotCheck({ book: [{ title: 'A', disable: false, content: 'no citation' }], messages: [] });
        assert.equal(r.bookTotals.uncited, 1);
        assert.equal(r.bookTotals.noConfidence, 1);
        assert.equal(r.samples[0].confidence, '(none recorded)');
        assert.deepEqual(r.samples[0].citedRanges, []);
    });
});

// ---------------------------------------------------------------- check 13: cost

describe('compareCost', () => {
    test('input and output are reported separately and never summed', () => {
        const r = compareCost({
            incremental: { calls: 3, inputTokens: 30000, outputTokens: 1200, writes: 6 },
            full: { calls: 3, inputTokens: 30000, outputTokens: 9000, writes: 52 },
        });
        assert.equal(r.delta.inputTokensSavedPct, 0);
        assert.equal(r.delta.outputTokensSavedPct, 86.7);
        assert.ok(r.delta.writesSavedPct > 88);
        assert.equal('totalTokensSavedPct' in r.delta, false);
        assert.match(r.caveat, /whole transcript on every step in both modes/);
    });

    test('a zero baseline yields null rather than a fabricated percentage', () => {
        const r = compareCost({
            incremental: { calls: 1, inputTokens: 0, outputTokens: 0, writes: 0 },
            full: { calls: 1, inputTokens: 0, outputTokens: 0, writes: 0 },
        });
        assert.equal(r.delta.outputTokensSavedPct, null);
    });
});

// ---------------------------------------------------------------- N-slice replay, both modes

describe('replayNSlices: incremental vs the full-rebuild ground truth', () => {
    const boundaries = [3, 5];

    // Step 2's reply re-emits Grondulf re-worded even though he was settled —
    // exactly the model behaviour rule 6 asks for and cannot guarantee.
    const setsByCall = [
        [
            gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V1 }),
            gen({ name: 'Pemberly', keys: ['Pemberly', 'baker'], content: PEMBERLY_V1 }),
        ],
        [
            gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V2 }),
            gen({ name: 'Pemberly', keys: ['Pemberly', 'baker'], content: PEMBERLY_V2 }),
            gen({ name: 'Stranger in a Grey Coat', keys: ['grey coat', 'stranger'], content: STRANGER_V1 }),
        ],
    ];

    test('incremental: the settled entry is frozen, and a re-emitted copy of it is dropped', async () => {
        const r = await replayNSlices({
            auditMessages, boundaries, generate: scripted(setsByCall), cfg: { incremental: true },
        });

        // Step 0 has no marks to diff against, so it is a full rebuild by design.
        assert.equal(r.steps[0].mode, 'full');
        assert.equal(r.steps[0].regenerated, 2);

        // Step 1: nothing after message 2 names Grondulf, so he is settled.
        assert.equal(r.steps[1].mode, 'incremental');
        assert.equal(r.steps[1].frozen, 1);
        assert.equal(r.steps[1].stale, 1);
        assert.equal(r.steps[1].regenerated, 2);          // Pemberly + the new Stranger
        assert.equal(r.steps[1].totalEntries, 3);

        // The point of the whole mechanism: Grondulf did not move.
        assert.equal(r.book.find((e) => e.title === 'Grondulf').content, GRONDULF_V1);
        assert.equal(r.steps[1].drift.ok, true);
        // Scored against the run's own frozen set, not the citation proxy —
        // which would have flagged Pemberly's legitimate update as drift.
        assert.equal(r.steps[1].drift.basis, 'frozen-set');
        assert.equal(r.steps[1].drift.checked, 1);
    });

    test('full rebuild: the same reply re-words the settled entry — the drift incremental prevents', async () => {
        const r = await replayNSlices({
            auditMessages, boundaries, generate: scripted(setsByCall), cfg: { incremental: false },
        });
        assert.equal(r.book.find((e) => e.title === 'Grondulf').content, GRONDULF_V2);
        assert.equal(r.steps[1].drift.ok, false);
        assert.equal(r.steps[1].drift.basis, 'source-ref');
        assert.ok(r.steps[1].drift.offenders.some((o) => o.title === 'Grondulf'));
        assert.equal(r.steps[1].regenerated, 3);          // every entry, not two
    });

    test('the source-ref fallback basis is a proxy, and this is what it gets wrong', async () => {
        // Documented rather than hidden: on a full rebuild, Pemberly's honest
        // update (message 3 is genuinely about her) is reported as drift purely
        // because her recorded citation predates the slice boundary. The
        // frozen-set basis has no such failure mode, which is why it wins when
        // it is available.
        const r = await replayNSlices({
            auditMessages, boundaries, generate: scripted(setsByCall), cfg: { incremental: false },
        });
        assert.ok(r.steps[1].drift.offenders.some((o) => o.title === 'Pemberly'));
    });

    test('cost: fewer writes, identical input — reported, not spun', async () => {
        const inc = await replayNSlices({ auditMessages, boundaries, generate: scripted(setsByCall), cfg: { incremental: true } });
        const full = await replayNSlices({ auditMessages, boundaries, generate: scripted(setsByCall), cfg: { incremental: false } });
        const cmp = compareCost({ incremental: inc.cost, full: full.cost });

        assert.equal(inc.cost.calls, full.cost.calls);
        assert.ok(inc.cost.writes < full.cost.writes);
        // The prompts differ only by the `[settled — do not re-emit]` tag, so
        // input is within a rounding error of identical. That IS the finding.
        assert.ok(Math.abs(cmp.delta.inputTokensSavedPct) < 1);
    });

    test('a hand-edit at step K survives to step N, and the later contradiction is reported', async () => {
        // A story that keeps talking about Grondulf, so he stays stale and the
        // model gets a real chance to overwrite the correction.
        const talky = [
            ...auditMessages.slice(0, 2),
            { id: 3, speaker: 'Narrator', rawText: 'Grondulf the landlord raised the rent again that same evening, unprompted.' },
            { id: 4, speaker: 'Narrator', rawText: 'Grondulf the landlord counted the silver twice and locked the ledger away.' },
        ];
        const HUMAN = 'Corrected by hand: Grondulf owns the building but never collects the rent himself. (src: msgs 1-1)';

        const r = await replayNSlices({
            auditMessages: talky,
            boundaries,
            generate: scripted([
                [gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V1 })],
                [gen({ name: 'Grondulf', keys: ['Grondulf', 'landlord'], content: GRONDULF_V2 })],
            ]),
            cfg: { incremental: true },
            handEdits: new Map([[1, [{ title: 'Grondulf', content: HUMAN }]]]),
        });

        assert.equal(r.steps[1].stale, 1);                 // he really was re-derived
        assert.equal(r.durability.ok, true);
        assert.equal(r.book.find((e) => e.title === 'Grondulf').content, HUMAN);
        assert.equal(r.durability.contradictionsReported.length, 1);
        assert.equal(r.durability.contradictionsReported[0].atStep, 1);
    });
});

// ---------------------------------------------------------------- the report runner

describe('runIncrementalReplay', () => {
    const replies = { 3: [gen({ name: 'A', keys: ['a'], content: `${'x'.repeat(60)} (src: msgs 1-3)` })] };

    test('scripted replies are keyed by the slice, so a skipped call cannot desynchronise them', async () => {
        const g = makeSlicedGenerate(replies);
        assert.equal(JSON.parse(await g('[1] N: one\n[3] N: two')).entries[0].name, 'A');
        // Call it again with the SAME slice — a call-index-keyed script would
        // have moved on and silently answered for the next slice.
        assert.equal(JSON.parse(await g('[3] N: two')).entries[0].name, 'A');
    });

    test('a slice with no scripted reply throws instead of replaying a stale one', async () => {
        await assert.rejects(() => makeSlicedGenerate(replies)('[9] N: nine'), /no scripted reply/);
    });

    test('the compliant model drops entries the prompt tagged settled; the defiant one does not', async () => {
        const prompt = '- A [settled — do not re-emit]: a\n[3] N: two';
        assert.equal(JSON.parse(await makeSlicedGenerate(replies)(prompt)).entries.length, 1);
        assert.equal(JSON.parse(await makeCompliantSlicedGenerate(replies)(prompt)).entries.length, 0);
    });

    test('end to end: the report carries every dimension PHA-2693 asks for, and no fabricated coverage', async () => {
        const outDir = await mkdtemp(join(tmpdir(), 'stmb-2693-'));
        try {
            const r = await run({ outDir });
            assert.equal(r.drift.ok, true);
            // The whole point: the same replies DO drift on a full rebuild.
            assert.equal(r.drift.fullRebuildComparison.ok, false);
            assert.equal(r.idempotence.ok, true);
            assert.equal(r.correctionDurability.ok, true);
            assert.ok(r.correctionDurability.contradictionsReported.length > 0);
            assert.equal(r.regeneratedVsTotal.length, 4);
            assert.ok(r.provenanceSpotCheck.samples.length > 0);
            // Every entry in the shipped book carries a citation, so check 4 is
            // scoring something rather than passing vacuously.
            assert.equal(r.provenanceSpotCheck.bookTotals.uncited, 0);
            // Cost is bracketed, and the floor is genuinely lower than the ceiling.
            assert.ok(r.cost.incrementalCompliantVsFullReplay.delta.outputTokensSavedPct
                > r.cost.incrementalVsFullReplay.delta.outputTokensSavedPct);
            // Coverage is declared not-run rather than approximated.
            assert.equal(r.coverage.run, false);
        } finally {
            await rm(outDir, { recursive: true, force: true });
        }
    });
});
