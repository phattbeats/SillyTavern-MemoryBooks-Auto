// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// PHA-1879 — ledgered chunked lorebook generation, pure core.
// The acceptance criteria are the last suite: a story that does NOT fit still
// produces an entry set with no cross-entry keyword collisions and no silently
// guessed cross-chunk attributions, and every degraded entry says so.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findKeywordCollisions } from './oneShotLorebookCore.js';
import {
    CHUNKED_DEFAULTS,
    CHUNK_PASS_PROMPT,
    RECONCILE_PROMPT,
    applyReconciliation,
    buildEntityRegistry,
    buildPassPrompt,
    buildReconcilePrompt,
    createLedger,
    detectSceneBoundaries,
    formatDraftEntries,
    formatLedger,
    formatPassTranscript,
    formatQuestions,
    generateWithRetry,
    isSceneBoundaryText,
    markDegradedEntries,
    mergeDraftEntries,
    parsePassReply,
    parseReconcileReply,
    planChunkedBudget,
    planLedgerPasses,
    planReconciliation,
    recordPass,
    summarizeChunked,
} from './chunkedLorebookCore.js';

const entry = (over = {}) => ({
    title: 'X',
    kind: 'character',
    key: ['x'],
    keysecondary: [],
    selectiveLogic: 0,
    constant: false,
    order: 100,
    position: 1,
    scanDepth: 3,
    preventRecursion: true,
    content: 'A'.repeat(60),
    ...over,
});

const msg = (id, rawText) => ({ id, speaker: 'Narrator', rawText });

// ----------------------------------------------------------------- budgeting

test('planChunkedBudget reserves the ledger and the reconciliation pass up front', () => {
    const b = planChunkedBudget({ inputTokens: 10000, outputTokens: 4000 });
    assert.equal(b.ledgerTokens, 2000);
    assert.equal(b.passInputTokens, 8000);
    assert.equal(b.reconcileTokens, 4000);
    assert.equal(b.outputTokens, 4000);
    // The reservation is real: a pass can never spend the ledger's share.
    assert.equal(b.passInputTokens + b.ledgerTokens, b.inputTokens);
});

test('planChunkedBudget survives a missing/garbage budget', () => {
    const b = planChunkedBudget(undefined);
    assert.ok(b.passInputTokens >= 500);
    assert.ok(b.reconcileTokens >= 500);
    assert.ok(b.outputTokens > 0);
});

test('planChunkedBudget honours policy overrides', () => {
    const b = planChunkedBudget({ inputTokens: 10000 }, { ledgerFraction: 0.5, reconcileFraction: 0.1 });
    assert.equal(b.ledgerTokens, 5000);
    assert.equal(b.passInputTokens, 5000);
    assert.equal(b.reconcileTokens, 1000);
});

// ---------------------------------------------------------- scene boundaries

test('isSceneBoundaryText recognizes headings, rules and time skips', () => {
    for (const t of [
        '## Chapter Four',
        '---',
        '* * *',
        'Chapter 12: the long road',
        '[Three days later]',
        '*Later that evening*',
        'PROLOGUE',
    ]) {
        assert.equal(isSceneBoundaryText(t), true, `should be a boundary: ${t}`);
    }
});

test('isSceneBoundaryText does not fire on ordinary prose', () => {
    for (const t of [
        'Mira draws her blade and steps forward.',
        '"Later," he said, "we ride."',
        '',
        undefined,
    ]) {
        assert.equal(isSceneBoundaryText(t), false, `should not be a boundary: ${t}`);
    }
});

test('detectSceneBoundaries never reports index 0 — a start is not a cut', () => {
    const found = detectSceneBoundaries([msg(0, '# Chapter One'), msg(1, 'plain'), msg(2, '# Chapter Two')]);
    assert.deepEqual([...found], [2]);
});

// ------------------------------------------------------------ pass planning

test('planLedgerPasses cuts at a scene boundary once the pass is full enough', () => {
    // Every message costs 100 tokens (400 chars); cap 500 => 5 per pass max.
    const body = 'a'.repeat(400);
    const messages = [0, 1, 2, 3, 4, 5, 6, 7].map(i => msg(i, i === 4 ? `# Chapter Two\n${body}` : body));
    const passes = planLedgerPasses(messages, 500, { minFill: 0.6 });
    // Boundary at index 4 with 400/500 already banked (>= 300 floor) => clean cut.
    assert.equal(passes[0].start, 0);
    assert.equal(passes[0].end, 3);
    assert.equal(passes[0].cutMidScene, false);
    assert.equal(passes[1].start, 4);
});

test('planLedgerPasses does not cut at a boundary that would only add a pass', () => {
    const body = 'a'.repeat(400);
    const messages = [0, 1, 2, 3, 4].map(i => msg(i, i === 1 ? `# Chapter Two\n${body}` : body));
    const passes = planLedgerPasses(messages, 600, { minFill: 0.6 });
    // Boundary at index 1 with only 100/500 banked — below the fill floor, so
    // it is ignored and the pass keeps filling.
    assert.equal(passes[0].start, 0);
    assert.equal(passes[0].end, 4);
    assert.equal(passes.length, 1);
});

test('planLedgerPasses flags a forced mid-scene cut', () => {
    const messages = [0, 1, 2, 3].map(i => msg(i, 'a'.repeat(400)));
    const passes = planLedgerPasses(messages, 250, { minFill: 0.6 });
    assert.equal(passes.length, 2);
    // The first cut is forced by the budget with no boundary in reach; the last
    // pass ends because the story does, which dangles nothing.
    assert.deepEqual(passes.map(p => p.cutMidScene), [true, false]);
    assert.deepEqual(passes.map(p => p.index), [0, 1]);
});

test('planLedgerPasses gives an oversized single message its own pass', () => {
    const messages = [msg(0, 'a'.repeat(40000)), msg(1, 'b'.repeat(100))];
    const passes = planLedgerPasses(messages, 500);
    assert.equal(passes[0].start, 0);
    assert.equal(passes[0].end, 0);
    assert.equal(passes[1].start, 1);
});

test('planLedgerPasses handles an empty story', () => {
    assert.deepEqual(planLedgerPasses([], 500), []);
    assert.deepEqual(planLedgerPasses(undefined, 500), []);
});

// -------------------------------------------------------------- the ledger

test('mergeDraftEntries adds new titles and rewrites known ones', () => {
    const a = mergeDraftEntries([], [entry({ title: 'Mira', key: ['mira'] })], 0);
    assert.equal(a.created, 1);
    const b = mergeDraftEntries(
        a.entries,
        [entry({ title: 'mira', key: ['the wanderer'], content: 'B'.repeat(60) })],
        1,
    );
    assert.equal(b.entries.length, 1, 'title match is case-insensitive');
    assert.equal(b.updated, 1);
    // Content is REPLACED (the pass was shown the old text and rewrote it)…
    assert.equal(b.entries[0].content, 'B'.repeat(60));
    // …but keywords are unioned; the award rule decides the rest.
    assert.deepEqual(b.entries[0].key.sort(), ['mira', 'the wanderer']);
    assert.deepEqual(b.entries[0].sourcePasses, [0, 1]);
});

test('mergeDraftEntries respects the whole-run entry cap and reports overflow', () => {
    const draft = [entry({ title: 'A' }), entry({ title: 'B' })];
    const r = mergeDraftEntries(draft, [entry({ title: 'C' }), entry({ title: 'D' })], 1, 2);
    assert.equal(r.entries.length, 2);
    assert.equal(r.overflow, 2);
});

test('recordPass awards contested keywords with the one-shot rule', () => {
    const first = recordPass({
        ledger: createLedger(),
        draft: [],
        entries: [entry({ title: 'Mira', key: ['mira', 'the blade'] })],
        pass: { index: 0, start: 0, end: 3, tokens: 100 },
    });
    // Pass 2 tries to steal "the blade" for a different subject.
    const second = recordPass({
        ledger: first.ledger,
        draft: first.draft,
        entries: [entry({ title: 'The Blade', key: ['the blade'], content: 'C'.repeat(60) })],
        pass: { index: 1, start: 4, end: 8, tokens: 100 },
    });
    assert.deepEqual(findKeywordCollisions(second.draft), []);
    // Exact-title match wins, exactly as the one-shot path resolves it.
    const blade = second.draft.find(e => e.title === 'The Blade');
    const mira = second.draft.find(e => e.title === 'Mira');
    assert.deepEqual(blade.key, ['the blade']);
    assert.deepEqual(mira.key, ['mira']);
    assert.ok(second.ledger.collisions.length >= 1);
});

test('recordPass yields keywords already claimed by the existing book', () => {
    const r = recordPass({
        ledger: createLedger(),
        draft: [],
        entries: [entry({ title: 'Mira', key: ['mira', 'wanderer'] })],
        pass: { index: 0, start: 0, end: 1, tokens: 10 },
        claimedByExisting: new Set(['wanderer']),
    });
    assert.deepEqual(r.draft[0].key, ['mira']);
});

test('recordPass carries open questions forward and dedupes them', () => {
    const one = recordPass({
        ledger: createLedger(),
        draft: [],
        entries: [entry({ title: 'Mira' })],
        unresolved: [{ question: 'Who gave Mira the scar?', about: 'Mira', messageIds: [12] }],
        pass: { index: 0, start: 0, end: 20, tokens: 100 },
    });
    const two = recordPass({
        ledger: one.ledger,
        draft: one.draft,
        entries: [],
        unresolved: [
            { question: 'who gave mira the scar?' },     // same question, different case
            { question: 'What is the Ashfall Pact?' },
        ],
        pass: { index: 1, start: 21, end: 40, tokens: 100 },
    });
    assert.equal(two.ledger.unresolved.length, 2);
    assert.equal(two.ledger.unresolved[0].raisedInPass, 0);
    assert.equal(two.ledger.unresolved[1].raisedInPass, 1);
});

test('recordPass caps the open-question list', () => {
    const r = recordPass({
        ledger: createLedger(),
        draft: [],
        entries: [entry({ title: 'Mira' })],
        unresolved: Array.from({ length: 10 }, (_, i) => ({ question: `q${i}` })),
        pass: { index: 0, start: 0, end: 1, tokens: 10 },
        maxUnresolved: 3,
    });
    assert.equal(r.ledger.unresolved.length, 3);
});

test('buildEntityRegistry reports post-award keywords, not requested ones', () => {
    const r = recordPass({
        ledger: createLedger(),
        draft: [],
        entries: [
            entry({ title: 'Mira', key: ['mira', 'shared'] }),
            entry({ title: 'Kell', key: ['kell', 'shared'], content: 'K'.repeat(60) }),
        ],
        pass: { index: 0, start: 0, end: 1, tokens: 10 },
    });
    const registry = buildEntityRegistry(r.draft);
    const all = registry.flatMap(e => e.keywords);
    assert.equal(all.filter(k => k === 'shared').length, 1, 'the registry must not advertise a keyword twice');
});

// ------------------------------------------------------------- ledger render

test('formatLedger degrades in defined steps and says which one it took', () => {
    const ledger = createLedger();
    ledger.entities = Array.from({ length: 20 }, (_, i) => ({
        name: `Person ${i}`, kind: 'character', keywords: [`p${i}`], content: 'z'.repeat(2000), sourcePasses: [0],
    }));

    const full = formatLedger(ledger, 0);
    assert.equal(full.truncated, false);

    const excerpt = formatLedger(ledger, 2000);
    assert.equal(excerpt.truncated, 'excerpt');
    assert.ok(excerpt.text.includes('…'));

    const bare = formatLedger(ledger, 200);
    assert.equal(bare.truncated, 'keywords-only');
    assert.ok(!bare.text.includes('current entry:'));
    // Even the smallest form keeps the part that prevents collisions.
    assert.ok(bare.text.includes('p0'));
});

test('formatLedger states plainly that nothing is established yet', () => {
    const { text, truncated } = formatLedger(createLedger(), 1000);
    assert.match(text, /nothing established yet/);
    assert.match(text, /OPEN QUESTIONS[\s\S]*\(none\)/);
    assert.equal(truncated, false);
});

test('formatLedger omits questions that were already answered', () => {
    const ledger = createLedger();
    ledger.unresolved = [
        { question: 'open one', resolved: false },
        { question: 'closed one', resolved: true },
    ];
    const { text } = formatLedger(ledger, 0);
    assert.ok(text.includes('open one'));
    assert.ok(!text.includes('closed one'));
});

test('formatPassTranscript renders only the pass range', () => {
    const messages = [msg(10, 'aaa'), msg(11, 'bbb'), msg(12, 'ccc')];
    const text = formatPassTranscript(messages, { start: 1, end: 2 });
    assert.ok(!text.includes('aaa'));
    assert.ok(text.includes('bbb') && text.includes('ccc'));
});

test('formatDraftEntries and formatQuestions handle the empty case', () => {
    assert.match(formatDraftEntries([]), /no entries/);
    assert.equal(formatQuestions([]), '(none)');
    assert.match(formatQuestions([{ question: 'why?', about: 'Mira', messageIds: [3] }]), /1\. why\? \[about: Mira\] \[raised by messages 3\]/);
});

// ------------------------------------------------------------------ prompts

test('buildPassPrompt fills every token and keeps the unknown ones intact', () => {
    const p = buildPassPrompt({
        transcriptText: 'THE-STORY',
        existingText: 'THE-BOOK',
        ledgerText: 'THE-LEDGER',
        passNumber: 2,
        passTotal: 5,
        maxEntries: 12,
    });
    assert.ok(p.includes('THE-STORY') && p.includes('THE-BOOK') && p.includes('THE-LEDGER'));
    assert.ok(p.includes('pass 2 of 5'));
    assert.ok(p.includes('AT MOST 12 entries'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), 'no template token may survive');
});

test('the pass prompt states the two rules PHA-1879 exists for', () => {
    assert.match(CHUNK_PASS_PROMPT, /ALREADY AWARDED/);
    assert.match(CHUNK_PASS_PROMPT, /DO\s*\n?NOT GUESS/);
    assert.match(CHUNK_PASS_PROMPT, /"unresolved"/);
});

test('the reconcile prompt forbids inventing an answer and keeps untouched entries', () => {
    assert.match(RECONCILE_PROMPT, /Do not invent an answer/);
    assert.match(RECONCILE_PROMPT, /an entry you do not re-emit is kept exactly as drafted/i);
});

test('buildPassPrompt and buildReconcilePrompt fall back for empty inputs', () => {
    const p = buildPassPrompt({});
    assert.match(p, /brand new lorebook/);
    assert.match(p, /nothing established yet/);
    const r = buildReconcilePrompt({ draftText: 'D' });
    assert.match(r, /no source text could be re-read/);
    assert.match(r, /OPEN QUESTIONS:\n\(none\)/);
});

// ------------------------------------------------------------------ parsing

test('parsePassReply reads entries and open questions together', () => {
    const reply = JSON.stringify({
        entries: [{ title: 'Mira', key: ['mira'], content: 'M'.repeat(60) }],
        unresolved: [{ question: 'Who is the Warden?', about: 'Mira', messageIds: ['7', 8, 'x'] }],
    });
    const parsed = parsePassReply(reply, {});
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.unresolved.length, 1);
    assert.deepEqual(parsed.unresolved[0].messageIds, [7, 8]);
});

test('parsePassReply keeps a pass that only raised a question', () => {
    const parsed = parsePassReply(JSON.stringify({ entries: [], unresolved: [{ question: 'why?' }] }), {});
    assert.deepEqual(parsed.entries, []);
    assert.equal(parsed.unresolved.length, 1);
});

test('parsePassReply returns null on an unusable reply', () => {
    assert.equal(parsePassReply('I cannot help with that.', {}), null);
    assert.equal(parsePassReply('', {}), null);
});

test('parsePassReply survives a code fence and surrounding prose', () => {
    const reply = 'Sure!\n```json\n{"entries":[{"title":"Kell","key":["kell"],"content":"' + 'K'.repeat(60) + '"}]}\n```\nHope that helps.';
    assert.equal(parsePassReply(reply, {}).entries[0].title, 'Kell');
});

test('parseReconcileReply defaults an answerless "resolved" to false', () => {
    const reply = JSON.stringify({
        resolved: [
            { question: 'a', answer: 'because X', resolved: true },
            { question: 'b', answer: '', resolved: true },
            { question: 'c', answer: 'maybe', resolved: false },
        ],
        entries: [],
    });
    const r = parseReconcileReply(reply, {});
    assert.deepEqual(r.resolved.map(x => x.resolved), [true, false, false]);
});

test('parseReconcileReply returns null when there is nothing to apply', () => {
    assert.equal(parseReconcileReply('nope', {}), null);
    assert.equal(parseReconcileReply('{"resolved":[],"entries":[]}', {}), null);
});

// ----------------------------------------------------------- reconciliation

const ledgerWithPasses = (unresolved) => ({
    ...createLedger(),
    passes: [
        { index: 0, start: 0, end: 9, tokens: 1000 },
        { index: 1, start: 10, end: 19, tokens: 1000 },
        { index: 2, start: 20, end: 29, tokens: 1000 },
    ],
    unresolved,
});

test('planReconciliation re-reads the passes the message ids point at', () => {
    const plan = planReconciliation(
        ledgerWithPasses([{ question: 'q', messageIds: [3], raisedInPass: 2, resolved: false }]),
        { reconcileTokens: 5000 },
    );
    assert.deepEqual(plan.passIndices, [0]);
    assert.equal(plan.items.length, 1);
    assert.deepEqual(plan.dropped, []);
});

test('planReconciliation falls back to the raising pass and the one before it', () => {
    const plan = planReconciliation(
        ledgerWithPasses([{ question: 'q', messageIds: [], raisedInPass: 2, resolved: false }]),
        { reconcileTokens: 5000 },
    );
    assert.deepEqual(plan.passIndices, [1, 2]);
});

test('planReconciliation drops what does not fit rather than overflowing', () => {
    const plan = planReconciliation(
        ledgerWithPasses([
            { question: 'cheap', messageIds: [3], raisedInPass: 1, resolved: false },
            { question: 'expensive', messageIds: [3, 15, 25], raisedInPass: 2, resolved: false },
        ]),
        { reconcileTokens: 1500 },   // room for exactly one 1000-token pass
    );
    assert.deepEqual(plan.passIndices, [0]);
    assert.deepEqual(plan.items.map(i => i.question), ['cheap']);
    assert.deepEqual(plan.dropped.map(i => i.question), ['expensive']);
    assert.ok(plan.tokens <= 1500);
});

test('planReconciliation subtracts the overhead already committed', () => {
    const plan = planReconciliation(
        ledgerWithPasses([{ question: 'q', messageIds: [3], raisedInPass: 0, resolved: false }]),
        { reconcileTokens: 1200, overheadTokens: 800 },
    );
    assert.deepEqual(plan.passIndices, []);
    assert.equal(plan.dropped.length, 1);
});

test('planReconciliation is a no-op when nothing is open', () => {
    const plan = planReconciliation(ledgerWithPasses([]), { reconcileTokens: 9999 });
    assert.deepEqual(plan, { passIndices: [], items: [], dropped: [], tokens: 0 });
});

test('applyReconciliation replaces re-emitted entries and leaves the rest alone', () => {
    const draft = [entry({ title: 'Mira', content: 'old'.padEnd(60, '.') }), entry({ title: 'Kell' })];
    const item = { question: 'q', about: 'Mira', messageIds: [], raisedInPass: 0, resolved: false };
    const applied = applyReconciliation({
        draft,
        ledger: { ...createLedger(), unresolved: [item] },
        askedItems: [item],
        result: {
            entries: [entry({ title: 'Mira', content: 'new'.padEnd(60, '.') })],
            resolved: [{ question: 'q', answer: 'the Warden did', resolved: true }],
        },
    });
    assert.equal(applied.entries.length, 2);
    assert.match(applied.entries.find(e => e.title === 'Mira').content, /^new/);
    assert.equal(applied.entries.find(e => e.title === 'Kell').content, 'A'.repeat(60));
    assert.equal(applied.closed, 1);
    assert.equal(applied.unresolved[0].resolved, true);
    assert.equal(applied.unresolved[0].answer, 'the Warden did');
});

test('applyReconciliation refuses to close a question it never asked', () => {
    const asked = { question: 'asked', messageIds: [], raisedInPass: 0, resolved: false };
    const never = { question: 'never asked', messageIds: [], raisedInPass: 0, resolved: false };
    const applied = applyReconciliation({
        draft: [entry({ title: 'Mira' })],
        ledger: { ...createLedger(), unresolved: [asked, never] },
        askedItems: [asked],
        result: { entries: [], resolved: [{ question: 'never asked', answer: 'made up', resolved: true }] },
    });
    assert.equal(applied.closed, 0);
    assert.deepEqual(applied.unresolved.map(u => u.resolved), [false, false]);
});

// -------------------------------------------------------------- degradation

test('markDegradedEntries records the pass count on every entry', () => {
    const { entries, degraded } = markDegradedEntries([entry({ title: 'Mira' })], [], 7);
    assert.equal(entries[0].stmbAutoPasses, 7);
    assert.equal(entries[0].stmbAutoDegraded, undefined);
    assert.equal(degraded, 0);
});

test('markDegradedEntries flags entries an open question names', () => {
    const open = [
        { question: 'Who gave Mira the scar?', about: '', resolved: false },
        { question: 'unrelated', about: 'Kell', resolved: false },
        { question: 'already answered about Mira', about: 'Mira', resolved: true },
    ];
    const { entries, degraded } = markDegradedEntries(
        [entry({ title: 'Mira' }), entry({ title: 'Kell' }), entry({ title: 'Ashfall' })],
        open,
        4,
    );
    assert.equal(degraded, 2);
    const byTitle = Object.fromEntries(entries.map(e => [e.title, e]));
    assert.equal(byTitle.Mira.stmbAutoDegraded, true);
    assert.match(byTitle.Mira.stmbAutoDegradedReason, /scar/);
    assert.ok(!byTitle.Mira.stmbAutoDegradedReason.includes('already answered'), 'a closed question is not degradation');
    assert.equal(byTitle.Kell.stmbAutoDegraded, true);
    assert.equal(byTitle.Ashfall.stmbAutoDegraded, undefined);
});

// ---------------------------------------------------------------- the calls

test('generateWithRetry retries once with the JSON-only reprimand', async () => {
    const prompts = [];
    const generate = async (p) => {
        prompts.push(p);
        return prompts.length === 1 ? 'sorry, no' : JSON.stringify({ entries: [{ title: 'Mira', key: ['mira'], content: 'M'.repeat(60) }] });
    };
    const parsed = await generateWithRetry({ generate, prompt: 'GO', parse: (r) => parsePassReply(r, {}) });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Reply with ONLY the JSON object/);
    assert.equal(parsed.entries[0].title, 'Mira');
});

test('generateWithRetry gives up after one retry', async () => {
    let calls = 0;
    const parsed = await generateWithRetry({
        generate: async () => { calls++; return 'still no'; },
        prompt: 'GO',
        parse: (r) => parsePassReply(r, {}),
    });
    assert.equal(calls, 2);
    assert.equal(parsed, null);
});

test('summarizeChunked names the degradation instead of hiding it', () => {
    const s = summarizeChunked({
        passes: 4, created: 9, updated: 2, dropped: 1, collisions: [{}, {}],
        keywordless: 1, unresolved: 2, closed: 3, degraded: 2, reconciled: true, midSceneCuts: 1,
    });
    assert.match(s, /4 passes/);
    assert.match(s, /2 keyword collisions resolved/);
    assert.match(s, /1 pass(es)? had to cut mid-scene/);
    assert.match(s, /closed 3\/5 open questions/);
    assert.match(s, /2 entries are flagged degraded/);
    assert.match(s, /raise the context window and re-run/);
});

test('summarizeChunked reports unreconciled questions when no reconciliation ran', () => {
    const s = summarizeChunked({ passes: 2, created: 3, unresolved: 2, reconciled: false });
    assert.match(s, /2 open questions left unreconciled/);
});

// ================================================================ ACCEPTANCE
//
// "A story that does not fit produces an entry set with no cross-entry keyword
// collisions and no silently-guessed cross-chunk attributions, and any entry
// that IS degraded says so."

test('ACCEPTANCE: a multi-pass run ships zero cross-entry keyword collisions', async () => {
    // Three passes, each one greedily claiming the same evocative words — the
    // exact behaviour that produced the original bug when passes were blind.
    const replies = [
        {
            entries: [
                { title: 'Mira Vance', kind: 'character', key: ['mira', 'vance', 'the wanderer'], content: 'Mira Vance is a wandering swordswoman. '.repeat(3) },
                { title: 'Ashfall', kind: 'location', key: ['ashfall', 'the wanderer'], content: 'Ashfall is a ruined mining town. '.repeat(3) },
            ],
            unresolved: [],
        },
        {
            entries: [
                { title: 'Kell Vance', kind: 'character', key: ['kell', 'vance'], content: 'Kell Vance is Mira\'s estranged brother. '.repeat(3) },
                { title: 'Mira Vance', kind: 'character', key: ['mira', 'vance'], content: 'Mira Vance is a wandering swordswoman who carries a burned pact-token. '.repeat(2) },
            ],
            unresolved: [{ question: 'Who burned the Ashfall pact-token?', about: 'Mira Vance', messageIds: [2] }],
        },
        {
            entries: [
                { title: 'The Ashfall Pact', kind: 'concept', key: ['pact', 'ashfall'], content: 'The Ashfall Pact bound the town to the mine. '.repeat(3) },
            ],
            unresolved: [{ question: 'What does Kell owe the Warden?', about: 'Kell Vance', messageIds: [] }],
        },
    ];

    const messages = Array.from({ length: 12 }, (_, i) => msg(i, 'x'.repeat(400)));
    const passes = planLedgerPasses(messages, 500);
    assert.ok(passes.length >= 3, 'this story must not fit in one call');

    let ledger = createLedger();
    let draft = [];
    const existingClaims = new Set(['the warden']);   // an incumbent entry holds this

    for (let i = 0; i < 3; i++) {
        const parsed = parsePassReply(JSON.stringify(replies[i]), {});
        const folded = recordPass({
            ledger,
            draft,
            entries: parsed.entries,
            unresolved: parsed.unresolved,
            pass: passes[i],
            claimedByExisting: existingClaims,
        });
        ledger = folded.ledger;
        draft = folded.draft;

        // Invariant after EVERY pass, not just at the end: the registry the next
        // pass will read must already be collision-free.
        assert.deepEqual(findKeywordCollisions(draft), [], `collision after pass ${i + 1}`);
    }

    // "the wanderer" was contested by Mira and Ashfall; exactly one holds it.
    const holders = draft.filter(e => e.key.includes('the wanderer'));
    assert.equal(holders.length, 1);
    // "vance" is a shared surname — awarded to one entry, not both.
    assert.equal(draft.filter(e => e.key.some(k => k.toLowerCase() === 'vance')).length, 1);
    // Nobody may take a keyword the existing book already holds.
    assert.equal(draft.filter(e => e.key.some(k => k.toLowerCase() === 'the warden')).length, 0);

    // Reconciliation: one question is answerable, the other is not.
    const recon = planReconciliation(ledger, { reconcileTokens: 100000 });
    assert.equal(recon.items.length, 2);

    const applied = applyReconciliation({
        draft,
        ledger,
        askedItems: recon.items,
        result: {
            entries: [{
                title: 'Mira Vance', kind: 'character', key: ['mira'],
                content: 'Mira Vance is a wandering swordswoman who burned her own Ashfall pact-token. '.repeat(2),
            }],
            resolved: [
                { question: 'Who burned the Ashfall pact-token?', answer: 'Mira burned it herself.', resolved: true },
                { question: 'What does Kell owe the Warden?', answer: '', resolved: true },  // no answer => stays open
            ],
        },
    });

    const stillOpen = applied.unresolved.filter(u => !u.resolved);
    assert.deepEqual(stillOpen.map(u => u.question), ['What does Kell owe the Warden?']);

    const marked = markDegradedEntries(applied.entries, stillOpen, passes.length);

    // 1. No cross-entry keyword collisions anywhere in the shipped set.
    assert.deepEqual(findKeywordCollisions(marked.entries), []);
    // 2. The entry whose cross-reference stayed open says so; the reconciled one does not.
    const byTitle = Object.fromEntries(marked.entries.map(e => [e.title, e]));
    assert.equal(byTitle['Kell Vance'].stmbAutoDegraded, true);
    assert.match(byTitle['Kell Vance'].stmbAutoDegradedReason, /Warden/);
    assert.equal(byTitle['Mira Vance'].stmbAutoDegraded, undefined, 'a closed question must not leave the entry flagged');
    // 3. The pass count is recorded on every entry, degraded or not.
    for (const e of marked.entries) assert.equal(e.stmbAutoPasses, passes.length);
});

test('ACCEPTANCE: the defaults keep the reconciliation pass inside the budget', () => {
    const b = planChunkedBudget({ inputTokens: 20000, outputTokens: 4000 }, CHUNKED_DEFAULTS);
    // Reconciliation is reserved out of the SAME input budget a pass reads from,
    // so it can never be the call that overflows the window.
    assert.ok(b.reconcileTokens <= b.inputTokens);
    assert.ok(b.passInputTokens <= b.inputTokens);
});
