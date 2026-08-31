// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 phattbeats
// SPDX-License-Identifier: AGPL-3.0-only
//
// PHA-2693 — incremental re-runs (Build item 5) and carried keyword awards
// (Build item 6), pure core.
//
// The load-bearing claim under test is NOT "this is cheaper". It is that an
// entry nobody asked the model to rewrite cannot come back re-worded — the
// drift guarantee `applyProvenancePinning` explicitly could not make on its
// own, because it compares against freshly generated prose that is only
// byte-identical by luck.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectPriorAwards,
    dropFrozenEntries,
    enforceGlobalKeywordUniqueness,
    entryHighWater,
    entryNames,
    formatExistingEntries,
    ONE_SHOT_PROMPT,
    planIncrementalRun,
    readHighWaterMark,
    summarizeOneShot,
    transcriptHighWater,
} from './oneShotLorebookCore.js';

/** entriesForCoverage()-shaped existing entry. */
const bookEntry = (over = {}) => ({
    uid: 1,
    title: 'Ada',
    content: 'Ada is the archivist.',
    keys: ['ada'],
    constant: false,
    disable: false,
    isMemory: false,
    stmbAutoRunHighWater: 100,
    ...over,
});

/** extractAuditMessages()-shaped message: `rawText`, not `text`. */
const msg = (id, rawText) => ({ id, rawText });

// ---------------------------------------------------------------- high-water marks

test('entryHighWater / readHighWaterMark: absent or unparseable reads as null, not zero', () => {
    assert.equal(entryHighWater(bookEntry({ stmbAutoRunHighWater: 0 })), 0);
    assert.equal(entryHighWater(bookEntry({ stmbAutoRunHighWater: undefined })), null);
    assert.equal(entryHighWater(bookEntry({ stmbAutoRunHighWater: 'nope' })), null);
    // A mark of 0 is a real mark — treating it as null would force a needless
    // full rebuild on a book written from a one-message story.
    assert.equal(readHighWaterMark([bookEntry({ stmbAutoRunHighWater: 0 })]), 0);
    assert.equal(readHighWaterMark([]), null);
    assert.equal(
        readHighWaterMark([bookEntry({ stmbAutoRunHighWater: 40 }), bookEntry({ stmbAutoRunHighWater: 210 })]),
        210,
    );
});

test('transcriptHighWater: the newest id this run actually read', () => {
    assert.equal(transcriptHighWater([msg(3, 'a'), msg(11, 'b'), msg(7, 'c')]), 11);
    assert.equal(transcriptHighWater([]), null);
});

test('entryNames: an entry answers to its title and its keywords, but never a regex key', () => {
    const names = entryNames(bookEntry({ title: 'Ada Vance', keys: ['ada', 'the archivist', '/^a.*/i'] }));
    assert.deepEqual([...names].sort(), ['ada', 'ada vance', 'the archivist']);
});

// ---------------------------------------------------------------- planIncrementalRun

test('planIncrementalRun: no mark anywhere in the book means full rebuild, not a silent no-op', () => {
    const plan = planIncrementalRun({
        existing: [bookEntry({ stmbAutoRunHighWater: undefined })],
        messages: [msg(1, 'Ada speaks.')],
    });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.frozen.length, 0);
    assert.equal(plan.stale.length, 1);
    assert.equal(plan.canSkipCall, false);
});

test('planIncrementalRun: disabled forces the full-rebuild ground truth', () => {
    const plan = planIncrementalRun({
        existing: [bookEntry()],
        messages: [msg(200, 'Something new.')],
        enabled: false,
    });
    assert.equal(plan.mode, 'full');
    assert.match(plan.reason, /full rebuild/);
    assert.equal(plan.frozenTitles.size, 0);
});

test('planIncrementalRun: an entry nothing new mentions is frozen; one that is named is stale', () => {
    const existing = [
        bookEntry({ uid: 1, title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 }),
        bookEntry({ uid: 2, title: 'Button', keys: ['button'], stmbAutoRunHighWater: 100 }),
    ];
    const messages = [
        msg(100, 'Old news about Ada and Button both.'),
        msg(101, 'Button walked into the firewood shed.'),
    ];
    const plan = planIncrementalRun({ existing, messages });

    assert.equal(plan.mode, 'incremental');
    assert.equal(plan.highWater, 100);
    assert.equal(plan.newMessageCount, 1);
    assert.deepEqual(plan.stale.map(s => s.title), ['Button']);
    assert.deepEqual(plan.frozen.map(f => f.title), ['Ada']);
    assert.ok(plan.frozenTitles.has('ada'));
    assert.match(plan.stale[0].reason, /named in 1 message added since it was written \(101–101\)/);
});

test('planIncrementalRun: staleness is per entry, so a newer sibling cannot hide an older entry', () => {
    // The bug a single book-wide mark would produce: Ada was written at 100,
    // Button at 200. Message 150 names Ada. With one shared mark of 200 that
    // message is "already read" and Ada goes stale forever.
    const existing = [
        bookEntry({ uid: 1, title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 }),
        bookEntry({ uid: 2, title: 'Button', keys: ['button'], stmbAutoRunHighWater: 200 }),
    ];
    const messages = [msg(150, 'Ada finally opened the ledger.')];
    const plan = planIncrementalRun({ existing, messages });

    assert.deepEqual(plan.stale.map(s => s.title), ['Ada']);
    assert.deepEqual(plan.frozen.map(f => f.title), ['Button']);
});

test('planIncrementalRun: substring mentions do not count — whole words only', () => {
    const existing = [bookEntry({ title: 'Ash', keys: ['ash'], stmbAutoRunHighWater: 10 })];
    const plan = planIncrementalRun({ existing, messages: [msg(11, 'She swept the ashes into a pile.')] });
    assert.deepEqual(plan.frozen.map(f => f.title), ['Ash']);
});

test('planIncrementalRun: a still-open unresolved question holds its entry stale even with no new messages', () => {
    const existing = [bookEntry({ title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 })];
    const messages = [msg(100, 'Nothing new.')];

    const open = planIncrementalRun({
        existing, messages,
        unresolvedQuestions: [{ question: 'Who did she report to?', about: 'Ada' }],
    });
    assert.deepEqual(open.stale.map(s => s.title), ['Ada']);
    assert.equal(open.canSkipCall, false);

    // Resolved is not open, and must not hold anything.
    const closed = planIncrementalRun({
        existing, messages,
        unresolvedQuestions: [{ question: 'Who did she report to?', about: 'Ada', resolved: true }],
    });
    assert.deepEqual(closed.frozen.map(f => f.title), ['Ada']);
    assert.equal(closed.canSkipCall, true);
});

test('planIncrementalRun: a question naming the entity only in its prose still counts', () => {
    const plan = planIncrementalRun({
        existing: [bookEntry({ title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 })],
        messages: [msg(100, 'x')],
        unresolvedQuestions: [{ question: 'Was Ada ever in the shed?', about: 'Button' }],
    });
    assert.deepEqual(plan.stale.map(s => s.title), ['Ada']);
});

test('planIncrementalRun: nothing new and nothing stale means do not spend the call at all', () => {
    const plan = planIncrementalRun({
        existing: [bookEntry({ title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 })],
        messages: [msg(99, 'old'), msg(100, 'also old')],
    });
    assert.equal(plan.canSkipCall, true);
    assert.equal(plan.newMessageCount, 0);
    assert.match(plan.reason, /nothing new since message 100/);
});

test('planIncrementalRun: new messages that name nobody still cost a call — new entities live there', () => {
    // Everything existing is frozen, but message 101 introduces a subject the
    // book has never heard of. Skipping the call would lose it permanently.
    const plan = planIncrementalRun({
        existing: [bookEntry({ title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 })],
        messages: [msg(101, 'A stranger in a grey coat paid for the room in coin.')],
    });
    assert.equal(plan.canSkipCall, false);
    assert.equal(plan.newMessageCount, 1);
    assert.deepEqual(plan.frozen.map(f => f.title), ['Ada']);
});

test('planIncrementalRun: scene memories and disabled entries are not the lore this decides about', () => {
    const plan = planIncrementalRun({
        existing: [
            bookEntry({ title: 'Scene 1', isMemory: true, stmbAutoRunHighWater: undefined }),
            bookEntry({ title: 'Retired', disable: true, stmbAutoRunHighWater: undefined }),
            bookEntry({ title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100 }),
        ],
        messages: [msg(100, 'old')],
    });
    assert.equal(plan.mode, 'incremental');
    assert.deepEqual(plan.frozen.map(f => f.title), ['Ada']);
    assert.equal(plan.stale.length, 0);
});

test('planIncrementalRun: a human-verified entry the story has kept talking about is still stale', () => {
    // Freezing pinned entries out of the prompt would save the most tokens and
    // silently kill contradiction reporting — the model never restates the
    // entry, so applyProvenancePinning has nothing to compare. PHA-2693's own
    // "later contradiction reported, not overwritten" criterion depends on this.
    const plan = planIncrementalRun({
        existing: [bookEntry({
            title: 'Ada', keys: ['ada'], stmbAutoRunHighWater: 100,
            stmbAutoVerifiedByHuman: true,
        })],
        messages: [msg(101, 'Ada had never been an archivist at all.')],
    });
    assert.deepEqual(plan.stale.map(s => s.title), ['Ada']);
});

// ---------------------------------------------------------------- the prompt side

test('formatExistingEntries: frozen entries are still listed, but tagged do-not-re-emit', () => {
    const text = formatExistingEntries(
        [
            { title: 'Ada', keys: ['ada'] },
            { title: 'Button', keys: ['button'] },
            { title: 'Scene 1', keys: ['scene'], isMemory: true },
        ],
        new Set(['ada']),
    );
    // Listed, so the model neither duplicates the subject nor takes its keys.
    assert.match(text, /- Ada \[settled — do not re-emit\]: ada/);
    assert.match(text, /- Button: button/);
    // The memory tag wins — that entry is protected for a different reason.
    assert.match(text, /- Scene 1 \[scene memory — do not rewrite\]/);
});

test('formatExistingEntries: with no frozen set the output is byte-identical to before', () => {
    const entries = [{ title: 'Ada', keys: ['ada'] }];
    assert.equal(formatExistingEntries(entries), formatExistingEntries(entries, new Set()));
    assert.equal(formatExistingEntries(entries), '- Ada: ada');
});

test('the shipped prompt actually carries the do-not-re-emit rule', () => {
    assert.match(ONE_SHOT_PROMPT, /\[settled — do not re-emit\]/);
});

test('dropFrozenEntries: a re-emitted settled entry is dropped, not written', () => {
    const { entries, skipped } = dropFrozenEntries(
        [{ title: 'Ada', content: 'reworded' }, { title: 'Button', content: 'new' }],
        new Set(['ada']),
    );
    assert.deepEqual(entries.map(e => e.title), ['Button']);
    assert.deepEqual(skipped, ['Ada']);
});

test('dropFrozenEntries: an empty frozen set is a pass-through, same array identity', () => {
    const input = [{ title: 'Ada' }];
    const out = dropFrozenEntries(input, new Set());
    assert.equal(out.entries, input);
    assert.deepEqual(out.skipped, []);
});

// ---------------------------------------------------------------- carried keyword awards

test('collectPriorAwards: keyword -> the title that currently holds it, regex keys excluded', () => {
    const awards = collectPriorAwards([
        { title: 'Ada Vance', keys: ['ada', 'the archivist', '/^a/i'] },
        { title: 'Retired', keys: ['ghost'], disable: true },
    ]);
    assert.equal(awards.get('ada'), 'ada vance');
    assert.equal(awards.get('the archivist'), 'ada vance');
    assert.equal(awards.has('/^a/i'), false);
    // A disabled entry is not shipping, so it holds nothing.
    assert.equal(awards.has('ghost'), false);
});

test('collectPriorAwards: a book that already double-claims a keyword keeps the first holder', () => {
    const awards = collectPriorAwards([
        { title: 'Ada', keys: ['ledger'] },
        { title: 'Button', keys: ['ledger'] },
    ]);
    assert.equal(awards.get('ledger'), 'ada');
});

test('carried awards: the incumbent keeps a contested keyword a longer title would have taken', () => {
    // Both entries are being rewritten this run, so "ledger" is loose. Without
    // memory, rule 2 (title contains the keyword) hands it to the newcomer and
    // Ada silently stops being retrievable by the key she has owned all along.
    const generated = [
        { title: 'Ada', key: ['ledger'], keysecondary: [], content: 'x' },
        { title: 'The Ledger Room', key: ['ledger'], keysecondary: [], content: 'y' },
    ];

    const without = enforceGlobalKeywordUniqueness(generated, new Set());
    assert.equal(without.entries[1].key.includes('ledger'), true);
    assert.equal(without.entries[0].key.includes('ledger'), false);
    assert.equal(without.collisions[0].reason, 'title contains the keyword');

    const priorAwards = collectPriorAwards([{ title: 'Ada', keys: ['ledger'] }]);
    const withMemory = enforceGlobalKeywordUniqueness(generated, new Set(), priorAwards);
    assert.equal(withMemory.entries[0].key.includes('ledger'), true);
    assert.equal(withMemory.entries[1].key.includes('ledger'), false);
    assert.equal(withMemory.collisions[0].winner, 'Ada');
    assert.equal(withMemory.collisions[0].reason, 'prior award (incumbent)');
});

test('carried awards: incumbency is not a veto — an incumbent that stopped asking loses it', () => {
    const generated = [
        { title: 'Ada', key: ['quill'], keysecondary: [], content: 'x' },
        { title: 'Button', key: ['quill'], keysecondary: [], content: 'y' },
    ];
    // "Carriage" held it last run but is not in this run's entry set at all.
    const priorAwards = collectPriorAwards([{ title: 'Carriage', keys: ['quill'] }]);
    const { entries, collisions } = enforceGlobalKeywordUniqueness(generated, new Set(), priorAwards);
    assert.equal(entries[0].key.includes('quill'), true);
    assert.equal(collisions[0].reason, 'emitted first');
});

test('carried awards: a keyword an untouched existing entry still holds beats everyone', () => {
    const generated = [{ title: 'Ada', key: ['ledger'], keysecondary: [], content: 'x' }];
    const { entries, collisions } = enforceGlobalKeywordUniqueness(
        generated,
        new Set(['ledger']),
        collectPriorAwards([{ title: 'Ada', keys: ['ledger'] }]),
    );
    assert.equal(entries[0].key.includes('ledger'), false);
    assert.equal(collisions[0].winner, '(existing lorebook entry)');
    assert.equal(collisions[0].reason, 'claimed by an untouched existing entry');
});

test('carried awards: omitting priorAwards reproduces the pre-PHA-2693 behaviour exactly', () => {
    const generated = [
        { title: 'Ada', key: ['ledger'], keysecondary: [], content: 'x' },
        { title: 'The Ledger Room', key: ['ledger'], keysecondary: [], content: 'y' },
    ];
    const a = enforceGlobalKeywordUniqueness(generated, new Set());
    const b = enforceGlobalKeywordUniqueness(generated, new Set(), new Map());
    assert.deepEqual(a.entries.map(e => e.key), b.entries.map(e => e.key));
});

// ---------------------------------------------------------------- reporting

test('summarizeOneShot: settled entries are reported, so "0 created, 0 updated" is legible', () => {
    const msg1 = summarizeOneShot({ created: 0, updated: 0, frozen: 48 });
    assert.match(msg1, /48 settled entries left alone \(incremental\)/);
    // Not mentioned at all on a full rebuild, where it would be noise.
    assert.equal(/settled/.test(summarizeOneShot({ created: 3, updated: 1 })), false);
});
