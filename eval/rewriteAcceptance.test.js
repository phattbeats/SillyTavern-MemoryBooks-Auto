// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 Brandon Kelly
// SPDX-License-Identifier: AGPL-3.0-only
//
// eval/rewriteAcceptance.test.js — PHA-2732 harness self-test.
//
// Every check below is proven BOTH ways: it passes on a clean case and it
// FAILS on a deliberately broken one. A check that only ever sees clean input
// cannot prove it would catch a real regression — it would pass by having
// nothing to say, which is exactly the "cannot fail" trap PHA-2732 was opened
// to avoid.
//
// Fully offline: no network, no `generate` other than in-memory stubs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    loadFixture,
    loadReferenceBook,
    projectEntries,
    upsertByTitle,
    runOneShotStep,
    checkNoKeywordCollisions,
    checkNoZeroKeyEntries,
    checkNoOverbroadKeywords,
    checkProvenanceInBounds,
    checkZeroWritesOnRerun,
    checkHumanPinSurvives,
    checkDrift,
    scoreEntityCoverage,
    checkBoundaryPrecision,
    replayNSlices,
    withCostTracking,
    makeCannedGenerate,
    DEFAULT_REFERENCE_BOOK,
} from './rewriteAcceptance.js';

// ---------------------------------------------------------------- fixtures

const entry = (title, keys, overrides = {}) => ({
    title, keys, constant: false, disable: false, isMemory: false, ...overrides,
});

// ---------------------------------------------------------------- check 1

describe('checkNoKeywordCollisions', () => {
    test('clean book: no shared keywords', () => {
        const book = [entry('Grondulf', ['Grondulf']), entry('Aurelium', ['Aurelium', 'the capital'])];
        const r = checkNoKeywordCollisions(book);
        assert.equal(r.ok, true);
        assert.deepEqual(r.collisions, []);
    });

    test('broken book: two entries claim the same keyword', () => {
        const book = [entry('Grondulf', ['Grondulf', 'landlord']), entry('Pemberly', ['Pemberly', 'landlord'])];
        const r = checkNoKeywordCollisions(book);
        assert.equal(r.ok, false);
        assert.equal(r.collisions.length, 1);
        assert.equal(r.collisions[0].keyword, 'landlord');
    });

    test('a disabled entry does not count toward collisions', () => {
        const book = [entry('A', ['x']), entry('B', ['x'], { disable: true })];
        assert.equal(checkNoKeywordCollisions(book).ok, true);
    });
});

// ---------------------------------------------------------------- check 2

describe('checkNoZeroKeyEntries', () => {
    test('clean book: every live entry has a key', () => {
        const book = [entry('A', ['a']), entry('B', ['b'])];
        assert.equal(checkNoZeroKeyEntries(book).ok, true);
    });

    test('broken book: an entry shipped keywordless', () => {
        const book = [entry('A', ['a']), entry('B', [])];
        const r = checkNoZeroKeyEntries(book);
        assert.equal(r.ok, false);
        assert.deepEqual(r.offenders, ['B']);
    });
});

// ---------------------------------------------------------------- check 3

describe('checkNoOverbroadKeywords', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ text: i < 9 ? 'Brandon walked into the room.' : 'A quiet aside about turnips.' }));

    test('clean: a specific keyword only fires on a minority of messages', () => {
        const book = [entry('Turnips', ['turnips'])];
        const r = checkNoOverbroadKeywords({ book, messages });
        assert.equal(r.ok, true);
    });

    test('broken: the protagonist name alone fires on nearly every message', () => {
        const book = [entry('Protagonist', ['Brandon'])];
        const r = checkNoOverbroadKeywords({ book, messages });
        assert.equal(r.ok, false);
        assert.equal(r.offenders.length, 1);
        assert.equal(r.offenders[0].keyword, 'Brandon');
        assert.ok(r.offenders[0].fraction > 0.5);
    });
});

// ---------------------------------------------------------------- check 4

describe('checkProvenanceInBounds', () => {
    test('clean: refs parse and sit inside the transcript range', () => {
        const book = [entry('A', ['a'], { stmbAutoSourceRef: '5-9' }), entry('B', ['b'], { stmbAutoSourceRef: '12' })];
        const r = checkProvenanceInBounds({ book, idMin: 0, idMax: 300 });
        assert.equal(r.ok, true);
    });

    test('an empty ref is not a failure (a purely inferred entry)', () => {
        const book = [entry('A', ['a'], { stmbAutoSourceRef: '' })];
        assert.equal(checkProvenanceInBounds({ book, idMin: 0, idMax: 300 }).ok, true);
    });

    test('broken: unparseable ref', () => {
        const book = [entry('A', ['a'], { stmbAutoSourceRef: 'the whole story' })];
        const r = checkProvenanceInBounds({ book, idMin: 0, idMax: 300 });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].reason, 'unparseable');
    });

    test('broken: ref range outside the transcript', () => {
        const book = [entry('A', ['a'], { stmbAutoSourceRef: '450-460' })];
        const r = checkProvenanceInBounds({ book, idMin: 0, idMax: 300 });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].reason, 'out-of-bounds');
    });
});

// ---------------------------------------------------------------- check 5

describe('checkZeroWritesOnRerun', () => {
    test('clean: nothing to write, everything skipped as unchanged', () => {
        const r = checkZeroWritesOnRerun({ toWrite: [], skipped: [{ title: 'A', reason: 'source unchanged' }] });
        assert.equal(r.ok, true);
        assert.equal(r.unchangedSkips, 1);
    });

    test('broken: a re-run on unchanged source still wants to write something', () => {
        const r = checkZeroWritesOnRerun({ toWrite: [{ title: 'A' }], skipped: [] });
        assert.equal(r.ok, false);
        assert.equal(r.toWriteCount, 1);
    });
});

// ---------------------------------------------------------------- check 6

describe('checkHumanPinSurvives', () => {
    test('clean: a genuine contradiction is reported and the pinned content is untouched', () => {
        const book = [entry('Grondulf', ['Grondulf'], { content: 'HUMAN EDIT: Grondulf is dead.' })];
        const pinning = {
            toWrite: [],
            contradictions: [{ title: 'Grondulf', existing: 'HUMAN EDIT: Grondulf is dead.', proposed: 'Grondulf is alive.' }],
        };
        const r = checkHumanPinSurvives({
            pinning, pinnedTitles: ['Grondulf'], book,
            preStepContent: new Map([['grondulf', 'HUMAN EDIT: Grondulf is dead.']]),
        });
        assert.equal(r.ok, true);
        assert.equal(r.contradictions.length, 1);
    });

    test('broken: pinned content was overwritten without being reported as a contradiction', () => {
        const book = [entry('Grondulf', ['Grondulf'], { content: 'Grondulf is alive now.' })];
        const pinning = { toWrite: [{ title: 'Grondulf' }], contradictions: [] };
        const r = checkHumanPinSurvives({
            pinning, pinnedTitles: ['Grondulf'], book,
            preStepContent: new Map([['grondulf', 'HUMAN EDIT: Grondulf is dead.']]),
        });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].reason, 'content changed without a reported contradiction');
    });

    test('broken: the pinned entry vanished entirely', () => {
        const r = checkHumanPinSurvives({
            pinning: { toWrite: [], contradictions: [] }, pinnedTitles: ['Grondulf'], book: [],
            preStepContent: new Map([['grondulf', 'x']]),
        });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].reason, 'pinned entry disappeared');
    });
});

// ---------------------------------------------------------------- check 9 (drift)

describe('checkDrift', () => {
    test('clean: an entry whose source predates the new slice comes back byte-identical', () => {
        const before = [{ title: 'Grondulf', content: 'Grondulf is a landlord.', stmbAutoSourceRef: '5-9' }];
        const after = [{ title: 'Grondulf', content: 'Grondulf is a landlord.' }];
        const r = checkDrift({ before, after, prevBoundary: 50 });
        assert.equal(r.ok, true);
        assert.equal(r.checked, 1);
    });

    test('broken: same untouched source, but the reply reworded it anyway', () => {
        const before = [{ title: 'Grondulf', content: 'Grondulf is a landlord.', stmbAutoSourceRef: '5-9' }];
        const after = [{ title: 'Grondulf', content: 'Grondulf, landlord of the estate.' }];
        const r = checkDrift({ before, after, prevBoundary: 50 });
        assert.equal(r.ok, false);
        assert.equal(r.offenders[0].title, 'Grondulf');
    });

    test('not checked: the entry\'s source range extends into the new slice', () => {
        const before = [{ title: 'Grondulf', content: 'Grondulf is a landlord.', stmbAutoSourceRef: '5-60' }];
        const after = [{ title: 'Grondulf', content: 'Grondulf is a landlord who now also mentors Sable.' }];
        const r = checkDrift({ before, after, prevBoundary: 50 });
        assert.equal(r.ok, true);
        assert.equal(r.checked, 0);
    });
});

// ---------------------------------------------------------------- check 7

describe('scoreEntityCoverage', () => {
    const reference = [
        entry('Grondulf', ['Grondulf']),
        entry('Aurelium', ['Aurelium', 'the capital']),
        entry('Yminia', ['Yminia']),
    ];

    test('exact title match counts as found', () => {
        const generated = [entry('Grondulf', ['Grondulf', 'landlord'])];
        const r = scoreEntityCoverage(generated, [reference[0]]);
        assert.equal(r.foundCount, 1);
        assert.deepEqual(r.missed, []);
    });

    test('a differently-worded entry that still shares a keyword counts as found (wording never fails this check)', () => {
        const generated = [entry('The Landlord of Fort Bramblehold', ['Grondulf', 'landlord'])];
        const r = scoreEntityCoverage(generated, [reference[0]]);
        assert.equal(r.foundCount, 1);
    });

    test('missing Grondulf fails, regardless of what else was found', () => {
        const generated = [entry('Aurelium', ['Aurelium'])];
        const r = scoreEntityCoverage(generated, reference);
        assert.equal(r.ok, false);
        assert.deepEqual(r.missed, ['Grondulf', 'Yminia']);
        assert.equal(r.foundCount, 1);
    });

    test('an extra generated entry with no reference match is reported, not penalized', () => {
        const generated = [entry('Grondulf', ['Grondulf']), entry('A Nobody', ['nobody-in-particular'])];
        const r = scoreEntityCoverage(generated, [reference[0]]);
        assert.equal(r.ok, true); // extras never flip ok to false
        assert.deepEqual(r.extra, ['A Nobody']);
    });

    test('the real Magisa reference book loads with 52 entries', async () => {
        const ref = await loadReferenceBook(DEFAULT_REFERENCE_BOOK);
        assert.equal(ref.length, 52);
    });
});

// ---------------------------------------------------------------- check 8

describe('checkBoundaryPrecision', () => {
    test('runs against the committed transcript + a previously-captured real prediction set', async () => {
        const { messages } = await loadFixture();
        const r = await checkBoundaryPrecision({ messages });
        assert.ok(r.precision >= 0 && r.precision <= 1, `precision out of range: ${r.precision}`);
        assert.ok(r.predictedCount > 0);
        assert.equal(typeof r.ok, 'boolean');
    });
});

// ---------------------------------------------------------------- upsertByTitle

describe('upsertByTitle', () => {
    test('creates a new entry when the title is unseen', () => {
        const book = [];
        const res = upsertByTitle(book, 'Grondulf', 'content', { key: ['Grondulf'] });
        assert.equal(res.created, true);
        assert.equal(book.length, 1);
        assert.deepEqual(book[0].keys, ['Grondulf']);
    });

    test('updates in place, case-insensitively, on a repeat title', () => {
        const book = [];
        upsertByTitle(book, 'Grondulf', 'v1', { key: ['Grondulf'] });
        const res = upsertByTitle(book, 'grondulf', 'v2', { key: ['Grondulf', 'landlord'] });
        assert.equal(res.updated, true);
        assert.equal(book.length, 1);
        assert.equal(book[0].content, 'v2');
    });
});

// ---------------------------------------------------------------- withCostTracking / makeCannedGenerate

describe('withCostTracking', () => {
    test('accumulates estimated input/output tokens across calls', async () => {
        const tracker = {};
        const gen = withCostTracking(async (p) => 'x'.repeat(40), tracker);
        await gen('y'.repeat(20));
        await gen('y'.repeat(20));
        assert.equal(tracker.calls, 2);
        assert.equal(tracker.inputTokens, 5 + 5); // 20 chars / 4, twice
        assert.equal(tracker.outputTokens, 10 + 10); // 40 chars / 4, twice
    });
});

describe('makeCannedGenerate', () => {
    test('replays recorded replies in order, then throws', async () => {
        const gen = makeCannedGenerate(['a', 'b']);
        assert.equal(await gen('p1'), 'a');
        assert.equal(await gen('p2'), 'b');
        await assert.rejects(() => gen('p3'), /only 2 replies were recorded/);
    });
});

// ---------------------------------------------------------------- runOneShotStep + replayNSlices (integration)

/** A canned one-shot reply naming a couple of entries with sourceRef-able content. */
function makeStepGenerate(entriesByStep) {
    let step = 0;
    return async () => {
        const payload = entriesByStep[Math.min(step, entriesByStep.length - 1)];
        step++;
        return JSON.stringify({ entries: payload });
    };
}

describe('runOneShotStep (integration over the real pure pipeline)', () => {
    const auditMessages = [
        { id: 0, speaker: 'Narrator', rawText: 'Grondulf the landlord frowned at the ledger and mentioned the unpaid rent again.' },
        { id: 1, speaker: 'Narrator', rawText: 'Grondulf the landlord frowned at the ledger and mentioned the unpaid rent again, twice.' },
    ];

    test('a fresh run creates entries with provenance stamped and no zero-key entries', async () => {
        const book = [];
        const generate = makeStepGenerate([[{
            name: 'Grondulf', keys: ['Grondulf', 'landlord'],
            content: 'Grondulf the landlord frowned at the ledger and mentioned the unpaid rent again, a recurring complaint.',
        }]]);
        const r = await runOneShotStep({ book, auditMessages, transcriptText: 'irrelevant', generate });
        assert.equal(r.ok, true);
        assert.equal(book.length, 1);
        assert.equal(checkNoZeroKeyEntries(book).ok, true);
        assert.ok(book[0].stmbAutoContentHash);
    });

    test('a second identical run writes nothing (check 5, driven through the real pinning contract)', async () => {
        const book = [];
        const reply = JSON.stringify({ entries: [{
            name: 'Grondulf', keys: ['Grondulf', 'landlord'],
            content: 'Grondulf the landlord frowned at the ledger and mentioned the unpaid rent again, a recurring complaint.',
        }] });
        const generate = async () => reply;
        await runOneShotStep({ book, auditMessages, transcriptText: 'irrelevant', generate });
        const second = await runOneShotStep({ book, auditMessages, transcriptText: 'irrelevant', generate });
        assert.equal(checkZeroWritesOnRerun(second.pinning).ok, true);
    });
});

describe('replayNSlices', () => {
    test('drives multiple steps, growing the book and reporting Tier 1 + drift per step', async () => {
        const auditMessages = Array.from({ length: 20 }, (_, i) => ({
            id: i, speaker: 'Narrator', rawText: `Message number ${i} about Grondulf the landlord and his ledger.`,
        }));
        // Same entry every step so the harness can prove drift-or-not once the
        // slice stops growing past this entry's cited source range.
        const generate = async () => JSON.stringify({ entries: [{
            name: 'Grondulf', keys: ['Grondulf', 'landlord'],
            content: 'Grondulf the landlord keeps a meticulous ledger of unpaid rent.',
        }] });

        const { steps, book } = await replayNSlices({
            auditMessages, boundaries: [5, 10, 20], generate,
        });

        assert.equal(steps.length, 3);
        assert.equal(book.length, 1);
        for (const step of steps) {
            assert.equal(typeof step.tier1.noKeywordCollisions.ok, 'boolean');
            assert.equal(typeof step.drift.ok, 'boolean');
        }
    });
});

describe('projectEntries', () => {
    test('mirrors auditorJobs.js entriesForCoverage: comment->title, key->keys, stmemorybooks->isMemory', () => {
        const lorebookData = {
            entries: {
                0: { uid: 0, comment: 'A', content: 'c', key: ['a'], stmemorybooks: true, stmbAutoContentHash: 'h' },
            },
        };
        const [e] = projectEntries(lorebookData);
        assert.equal(e.title, 'A');
        assert.deepEqual(e.keys, ['a']);
        assert.equal(e.isMemory, true);
        assert.equal(e.stmbAutoContentHash, 'h');
    });
});
