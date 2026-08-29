// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// PHA-1871 — one-shot whole-story lorebook generation, pure core.
// The acceptance criterion is the last suite: zero cross-entry keyword
// collisions with post-hoc dedup disabled.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ONE_SHOT_DEFAULTS,
    ONE_SHOT_PROMPT,
    SELECTIVE_LOGIC,
    applyProvenancePinning,
    attributeSources,
    buildOneShotPrompt,
    collectClaimedKeywords,
    containsWholeWord,
    dropMemoryTitleCollisions,
    enforceGlobalKeywordUniqueness,
    findKeywordCollisions,
    formatExistingEntries,
    formatTranscript,
    generateOneShotEntries,
    hashContent,
    normalizeKeyword,
    parseOneShotEntries,
    salvageEntryObjects,
    summarizeOneShot,
    wasHumanEdited,
} from './oneShotLorebookCore.js';

// The internal, already-parsed entry shape — used directly against the
// keyword-uniqueness / memory-collision helpers, which never see raw model JSON.
const entry = (over = {}) => ({
    title: 'X',
    key: ['x'],
    keysecondary: [],
    selectiveLogic: 0,
    constant: false,
    order: 100,
    position: 1,
    scanDepth: 3,
    preventRecursion: true,
    content: 'x'.repeat(60),
    ...over,
});

// The model's compact six-field output shape (PHA-1915) — used inside reply()
// to simulate what parseOneShotEntries actually receives.
const rawEntry = (over = {}) => ({
    name: 'X',
    keys: ['x'],
    content: 'x'.repeat(60),
    caseSensitive: false,
    cascade: false,
    throttle: 100,
    ...over,
});

const reply = (entries) => JSON.stringify({ entries });

// ---------------------------------------------------------------- prompt

test('the prompt leads with the World Info primer and the six-field output shape', () => {
    assert.ok(ONE_SHOT_PROMPT.startsWith('SILLYTAVERN WORLD INFO'), 'the primer must be first — it is the cache prefix');
    for (const token of ['MECHANISM', 'OUTPUT SHAPE', 'KEYWORD RULES', 'CASCADE AND THROTTLE']) {
        assert.ok(ONE_SHOT_PROMPT.includes(token), `primer must document "${token}"`);
    }
    assert.match(ONE_SHOT_PROMPT, /"name":"","keys":\[\],"content":"","caseSensitive":false,"cascade":false,"throttle":100/);
    // The model's own schema, not SillyTavern's ~28-field entry, must be the
    // OUTPUT SHAPE — "preventRecursion" is allowed to appear only as an example
    // of a field the model must NOT emit.
    for (const stField of ['selectiveLogic', 'scanDepth', '"position"', '"order"']) {
        assert.ok(!ONE_SHOT_PROMPT.includes(stField), `ST-internal field "${stField}" must not be asked of the model`);
    }
    assert.match(ONE_SHOT_PROMPT, /no preventRecursion/);
});

test('PHA-2722: the prompt carries the shared ERROR-CONTROL rules, including the src: msgs provenance rule', () => {
    // Before this, one-shot was the only generation path with none of the
    // never-invent-facts / flag-ambiguity / report-contradictions rules, and
    // its entries carried no `src: msgs` citations for runClaimReverification
    // to find. Asserting against the literal shared block (not a hand-copied
    // string) means this can never drift from the chunked/injection path again.
    assert.match(ONE_SHOT_PROMPT, /ERROR-CONTROL RULES/);
    assert.match(ONE_SHOT_PROMPT, /src: msgs X.Y/);
    assert.match(ONE_SHOT_PROMPT, /Never invent unstated facts/);
    assert.match(ONE_SHOT_PROMPT, /Report contradictions/);
});

test('buildOneShotPrompt fills every token and marks an empty book', () => {
    const p = buildOneShotPrompt({ transcriptText: 'THE-STORY', existingText: '', maxEntries: 7 });
    assert.ok(p.includes('THE-STORY'));
    assert.ok(p.includes('AT MOST 7 entries'));
    assert.ok(p.includes('brand new lorebook'));
    assert.ok(!p.includes('{{'), 'no unfilled placeholders');
});

test('formatTranscript / formatExistingEntries render the two context blocks', () => {
    const t = formatTranscript([{ id: 3, speaker: 'Ada', rawText: 'hello' }], 0);
    assert.equal(t, '[3] Ada: hello');

    const e = formatExistingEntries([
        { title: 'Ada', keys: ['Ada', 'Lovelace'] },
        { title: 'Scene 1-20', keys: ['ballroom'], isMemory: true },
        { title: '', keys: ['ignored'] },
    ]);
    assert.equal(e, '- Ada: Ada, Lovelace\n- Scene 1-20 [scene memory — do not rewrite]: ballroom');
    assert.match(formatExistingEntries([]), /brand new lorebook/);
});

// ---------------------------------------------------------------- parsing

test('parseOneShotEntries accepts a bare object, a fence, and surrounding prose', () => {
    const body = reply([rawEntry({ name: 'Ada' })]);
    for (const variant of [body, '```json\n' + body + '\n```', 'Sure!\n' + body + '\nHope that helps.']) {
        const parsed = parseOneShotEntries(variant);
        assert.equal(parsed.entries.length, 1, variant.slice(0, 20));
        assert.equal(parsed.entries[0].title, 'Ada');
    }
    assert.equal(parseOneShotEntries('no json here'), null);
    assert.equal(parseOneShotEntries(reply([])), null);
});

test('parseOneShotEntries assembles the full ST entry from the six model fields', () => {
    const parsed = parseOneShotEntries(reply([rawEntry({
        name: 'Ada',
        caseSensitive: true,
        cascade: true,
        throttle: 500,   // out of range
    })]));
    const e = parsed.entries[0];
    assert.equal(e.selectiveLogic, SELECTIVE_LOGIC.AND_ANY, 'assembled, not asked of the model');
    assert.equal(e.position, 1);
    assert.equal(e.order, 100);
    assert.equal(e.scanDepth, 3);
    assert.equal(e.constant, false);
    assert.equal(e.caseSensitive, true);
    assert.equal(e.preventRecursion, false, 'cascade:true means this entry MAY trigger others');
    assert.equal(e.probability, 100, 'throttle clamped into 0-100');
    assert.equal(e.useProbability, false, 'throttle:100 never needs the probability roll');
});

test('parseOneShotEntries maps cascade:false to preventRecursion:true, and throttle below 100 to useProbability', () => {
    const parsed = parseOneShotEntries(reply([rawEntry({ name: 'Ada', cascade: false, throttle: 80 })]));
    const e = parsed.entries[0];
    assert.equal(e.preventRecursion, true);
    assert.equal(e.probability, 80);
    assert.equal(e.useProbability, true);
});

test('parseOneShotEntries drops junk instead of guessing', () => {
    const parsed = parseOneShotEntries(reply([
        rawEntry({ name: 'Ada' }),
        rawEntry({ name: '', content: 'x'.repeat(60) }),  // no name
        rawEntry({ name: 'Tiny', content: 'too short' }), // below minContentChars
        rawEntry({ name: 'ada' }),                        // duplicate name, different case
        'not an object',
    ]));
    assert.deepEqual(parsed.entries.map(e => e.title), ['Ada']);
    assert.equal(parsed.dropped, 4);
});

test('parseOneShotEntries splits comma-packed keys — ST treats commas as separators', () => {
    const parsed = parseOneShotEntries(reply([rawEntry({ name: 'Ada', keys: ['Ada, Lovelace', ' Countess '] })]));
    assert.deepEqual(parsed.entries[0].key, ['Ada', 'Lovelace', 'Countess']);
});

test('parseOneShotEntries falls back to the name when no key survives, and honours maxEntries', () => {
    const noKey = parseOneShotEntries(reply([rawEntry({ name: 'Ada', keys: [] })]));
    assert.deepEqual(noKey.entries[0].key, ['Ada']);

    const capped = parseOneShotEntries(
        reply([rawEntry({ name: 'A' }), rawEntry({ name: 'B' }), rawEntry({ name: 'C' })]),
        { maxEntries: 2 },
    );
    assert.equal(capped.entries.length, 2);
});

// ---------------------------------------------------------------- keyword uniqueness

test('collectClaimedKeywords normalizes and honours the rewrite skip-list', () => {
    const existing = [
        { title: 'Ada', keys: ['Ada', '  LOVELACE '] },
        { title: 'Babbage', keys: ['Babbage'] },
    ];
    assert.deepEqual([...collectClaimedKeywords(existing)].sort(), ['ada', 'babbage', 'lovelace']);
    // An entry this run is rewriting releases its keywords back into the pool.
    assert.deepEqual([...collectClaimedKeywords(existing, new Set(['ada']))], ['babbage']);
});

test('a keyword wanted by two entries goes to the one whose title it names', () => {
    const { entries, collisions } = enforceGlobalKeywordUniqueness([
        entry({ title: 'The Brotherhood of Steel', key: ['Brotherhood of Steel', 'the Brotherhood'] }),
        entry({ title: 'Elder Maxson', key: ['Maxson', 'Brotherhood of Steel'] }),
    ]);
    assert.deepEqual(entries[0].key, ['Brotherhood of Steel', 'the Brotherhood']);
    assert.deepEqual(entries[1].key, ['Maxson']);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].winner, 'The Brotherhood of Steel');
    assert.deepEqual(collisions[0].strippedFrom, ['Elder Maxson']);
});

test('an exact title match beats a merely-containing one, and emission order is the last resort', () => {
    const exact = enforceGlobalKeywordUniqueness([
        entry({ title: 'Riverwood Inn', key: ['Riverwood'] }),
        entry({ title: 'Riverwood', key: ['Riverwood'] }),
    ]).entries;
    assert.deepEqual(exact.map(e => e.key), [['Riverwood Inn'], ['Riverwood']],
        'the town wins "Riverwood"; the inn falls back to its own free title');

    const neither = enforceGlobalKeywordUniqueness([
        entry({ title: 'Alpha', key: ['relic'] }),
        entry({ title: 'Beta', key: ['relic'] }),
    ]).entries;
    assert.deepEqual(neither[0].key, ['relic']);
    assert.deepEqual(neither[1].key, ['Beta']);
});

test('the existing book always wins — an incumbent keyword is stripped from every new entry', () => {
    const { entries, collisions } = enforceGlobalKeywordUniqueness(
        [entry({ title: 'Ada Lovelace', key: ['Ada', 'Lovelace'] })],
        collectClaimedKeywords([{ title: 'Ada', keys: ['ADA'] }]),
    );
    assert.deepEqual(entries[0].key, ['Lovelace']);
    assert.equal(collisions[0].winner, '(existing lorebook entry)');
});

// PHA-1886 §4: `key: []` ships an entry nothing can retrieve unless the user
// happens to have Vector Storage wired into World Info, so a disambiguated form
// is tried before giving up.
test('an entry whose every keyword AND title is taken falls back to a disambiguated key', () => {
    const claimed = collectClaimedKeywords([{ title: 'incumbent', keys: ['ghost', 'Ada'] }]);
    const { entries } = enforceGlobalKeywordUniqueness([entry({ title: 'Ada', key: ['ghost'] })], claimed);
    assert.deepEqual(entries[0].key, ['Ada (entry 2)']);
    assert.equal(entries[0].keywordless, undefined);
});

test('two entries contesting the same title get distinct disambiguated keys', () => {
    const claimed = collectClaimedKeywords([{ title: 'incumbent', keys: ['ghost', 'Ada', 'Ada (entry 2)'] }]);
    const { entries } = enforceGlobalKeywordUniqueness([
        entry({ title: 'Ada', key: ['ghost'] }),
        entry({ title: 'Ada', key: ['ghost'] }),
    ], claimed);
    assert.deepEqual(entries[0].key, ['Ada (entry 3)']);
    assert.deepEqual(entries[1].key, ['Ada (entry 4)']);
    assert.notDeepEqual(entries[0].key, entries[1].key);
});

test('an entry is only marked keywordless when even the disambiguated forms are taken', () => {
    const taken = ['ghost', 'Ada'];
    for (let n = 2; n <= 9; n++) taken.push(`Ada (entry ${n})`);
    const claimed = collectClaimedKeywords([{ title: 'incumbent', keys: taken }]);
    const { entries } = enforceGlobalKeywordUniqueness([entry({ title: 'Ada', key: ['ghost'] })], claimed);
    assert.deepEqual(entries[0].key, []);
    assert.equal(entries[0].keywordless, true);
});

test('containsWholeWord does not match a word inside a longer word', () => {
    assert.equal(containsWholeWord('who scattered the ashes?', 'ash'), false);
    assert.equal(containsWholeWord('who took the ash?', 'ash'), true);
    assert.equal(containsWholeWord('a.b matters', 'a.b'), true);
    assert.equal(containsWholeWord('axb matters', 'a.b'), false);
});

// PHA-1886 §5
test('dropMemoryTitleCollisions removes entries that would overwrite a scene memory', () => {
    const existing = [
        { title: 'Scene 1-20', isMemory: true },
        { title: 'Mira', isMemory: false },
    ];
    const { entries, skipped } = dropMemoryTitleCollisions(
        [entry({ title: 'scene 1-20' }), entry({ title: 'Mira' })],
        existing,
    );
    assert.deepEqual(entries.map(e => e.title), ['Mira']);
    assert.deepEqual(skipped, ['scene 1-20']);
});

test('dropMemoryTitleCollisions is a no-op when the book has no scene memories', () => {
    const input = [entry({ title: 'Mira' })];
    const { entries, skipped } = dropMemoryTitleCollisions(input, [{ title: 'Mira', isMemory: false }]);
    assert.equal(entries.length, 1);
    assert.deepEqual(skipped, []);
});

// PHA-1886 §3
test('salvageEntryObjects recovers the complete entries from a truncated reply', () => {
    const truncated = '{"entries": [' +
        '{"name": "Mira", "content": "Mira is a } brace inside a string", "keys": ["Mira"]},' +
        '{"name": "Kell", "content": "Kell guards the gate.", "keys": ["Kell"]},' +
        '{"name": "Ashfa';
    const got = salvageEntryObjects(truncated);
    assert.deepEqual(got.map(e => e.name), ['Mira', 'Kell']);
});

test('parseOneShotEntries salvages a max_tokens-truncated reply instead of losing everything', () => {
    const body = (t) => `{"name": "${t}", "content": "${'a'.repeat(60)}", "keys": ["${t}"]}`;
    const truncated = `{"entries": [${body('Mira')}, ${body('Kell')}, {"name": "Ashfa`;
    const parsed = parseOneShotEntries(truncated);
    assert.ok(parsed, 'a truncated reply must not parse as null');
    assert.deepEqual(parsed.entries.map(e => e.title), ['Mira', 'Kell']);
});

test('salvage does not fire when the reply is simply not JSON', () => {
    assert.equal(parseOneShotEntries('I cannot help with that.'), null);
});

test('regex keys are passed through untouched — they are not text keywords', () => {
    const { entries } = enforceGlobalKeywordUniqueness([
        entry({ title: 'Weather', key: ['/(rain|storm)/i'] }),
        entry({ title: 'Storm', key: ['/(rain|storm)/i', 'Storm'] }),
    ]);
    assert.ok(entries[0].key.includes('/(rain|storm)/i'));
    assert.ok(entries[1].key.includes('/(rain|storm)/i'));
    assert.equal(findKeywordCollisions(entries).length, 0);
});

test('keysecondary loses anything the entry already triggers on, and resets the logic when emptied', () => {
    const { entries } = enforceGlobalKeywordUniqueness([
        entry({ title: 'Ada', key: ['Ada'], keysecondary: ['ada', 'engine'], selectiveLogic: 3 }),
        entry({ title: 'Bob', key: ['Bob'], keysecondary: ['bob'], selectiveLogic: 3 }),
    ]);
    assert.deepEqual(entries[0].keysecondary, ['engine']);
    assert.equal(entries[0].selectiveLogic, 3, 'still has a filter, so the logic stands');
    assert.deepEqual(entries[1].keysecondary, []);
    assert.equal(entries[1].selectiveLogic, SELECTIVE_LOGIC.AND_ANY);
});

// ---------------------------------------------------------------- the call

test('generateOneShotEntries retries once with the JSON-only reprimand', async () => {
    const prompts = [];
    const parsed = await generateOneShotEntries({
        prompt: 'P',
        generate: async (p) => {
            prompts.push(p);
            return prompts.length === 1 ? 'sorry, here is some prose' : reply([rawEntry({ name: 'Ada' })]);
        },
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /No prose, no code fences/);
    assert.equal(parsed.entries[0].title, 'Ada');
});

test('generateOneShotEntries gives up after the retry rather than writing a guess', async () => {
    let calls = 0;
    const parsed = await generateOneShotEntries({ prompt: 'P', generate: async () => { calls++; return 'nope'; } });
    assert.equal(calls, 2);
    assert.equal(parsed, null);
});

test('summarizeOneShot reports what actually happened', () => {
    assert.equal(summarizeOneShot({ created: 3, updated: 1 }), 'one-shot lorebook: 3 created, 1 updated');
    assert.match(summarizeOneShot({ created: 1, dropped: 2, collisions: [{}], keywordless: 1 }),
        /2 unusable entries dropped · 1 keyword collision resolved · 1 entry left without a free keyword/);
});

test('summarizeOneShot surfaces inferred claims and ignored renames (review finding 4 consumer)', () => {
    assert.match(summarizeOneShot({ created: 1, inferred: 2 }),
        /2 entries written with an unstated \(inferred\) claim — worth a source check/);
    assert.match(summarizeOneShot({ created: 0, updated: 1, renamed: [{ uid: 1, from: 'A', to: 'B' }] }),
        /1 rename of a pinned entry ignored \(kept the human-verified title\)/);
});

// ---------------------------------------------------------------- acceptance

test('ACCEPTANCE: one run produces zero cross-entry keyword collisions, post-hoc dedup disabled', async () => {
    // A deliberately hostile model reply: shared surnames, a faction name every
    // member claims, a location named after a person, and keywords the existing
    // book already owns. Nothing downstream is allowed to clean this up.
    const modelReply = reply([
        rawEntry({ name: 'Elder Maxson', keys: ['Maxson', 'Elder', 'Brotherhood of Steel'] }),
        rawEntry({ name: 'Sarah Maxson', keys: ['Maxson', 'Sarah', 'Brotherhood of Steel'] }),
        rawEntry({ name: 'Brotherhood of Steel', keys: ['Brotherhood of Steel', 'the Brotherhood', 'Elder'] }),
        rawEntry({ name: 'Maxson Bridge', keys: ['Maxson Bridge', 'Maxson', 'the bridge'] }),
        rawEntry({ name: 'The Citadel', keys: ['Citadel', 'Ada'] }),   // "Ada" belongs to the book already
    ]);

    const existingBook = [
        { title: 'Ada', keys: ['Ada'], isMemory: false },
        { title: 'Scene 1-20', keys: ['the bridge'], isMemory: true },
    ];

    const parsed = await generateOneShotEntries({ prompt: 'P', generate: async () => modelReply });
    const rewritten = new Set(parsed.entries.map(e => e.title.toLowerCase()));
    const claimed = collectClaimedKeywords(existingBook, rewritten);
    const { entries } = enforceGlobalKeywordUniqueness(parsed.entries, claimed);

    // 1. No two GENERATED entries share a keyword.
    assert.deepEqual(findKeywordCollisions(entries), []);

    // 2. No generated entry steals a keyword the book already owns. The book
    //    after the run is: every untouched existing entry, plus the new set.
    const wholeBook = [
        ...existingBook.filter(e => !rewritten.has(e.title.toLowerCase())).map(e => ({ title: e.title, key: e.keys })),
        ...entries.map(e => ({ title: e.title, key: e.key })),
    ];
    assert.deepEqual(findKeywordCollisions(wholeBook), []);

    // 3. Every entry is still retrievable — the fix must not silence entries.
    for (const e of entries) {
        assert.ok(e.key.length > 0, `${e.title} shipped with no keyword at all`);
    }

    // And the awards landed where a human would put them.
    const byTitle = Object.fromEntries(entries.map(e => [e.title, e.key]));
    assert.ok(byTitle['Brotherhood of Steel'].includes('Brotherhood of Steel'));
    assert.ok(byTitle['Maxson Bridge'].includes('Maxson Bridge'));
    assert.ok(!byTitle['The Citadel'].includes('Ada'), 'the existing "Ada" entry keeps its keyword');
    assert.equal(normalizeKeyword('  Elder   Maxson '), 'elder maxson');
    assert.equal(ONE_SHOT_DEFAULTS.truncate, 0, 'the one-shot path reads full messages');
});

// ---------------------------------------------------------------- PHA-2681: provenance + pinning

test('hashContent is stable across whitespace but changes with content', () => {
    assert.equal(hashContent('Ada is a synth.'), hashContent('  Ada is a synth.  '));
    assert.notEqual(hashContent('Ada is a synth.'), hashContent('Ada is human.'));
});

test('wasHumanEdited: no hash on the entry means never seen this tool, not edited', () => {
    assert.equal(wasHumanEdited(null), false);
    assert.equal(wasHumanEdited({ content: 'x' }), false);
});

test('wasHumanEdited: mismatch between stored hash and current content means a human touched it', () => {
    const written = { content: 'Ada is a synth.', stmbAutoContentHash: hashContent('Ada is a synth.') };
    assert.equal(wasHumanEdited(written), false);
    const edited = { content: 'Ada is actually human.', stmbAutoContentHash: hashContent('Ada is a synth.') };
    assert.equal(wasHumanEdited(edited), true);
});

test('attributeSources: near-verbatim content is stated, novel phrasing is inferred', () => {
    const messages = [
        { id: 5, text: 'Marcus told Elena that the bridge collapsed last spring.' },
        { id: 9, text: 'She never told anyone she still loved him.' },
    ];
    const stated = attributeSources('The bridge collapsed last spring.', messages);
    assert.equal(stated.confidence, 'stated');
    assert.deepEqual(stated.sourceRef, [5]);
    assert.equal(stated.facts.length, 1);
    assert.equal(stated.facts[0].confidence, 'stated');
    assert.deepEqual(stated.facts[0].sourceRef, [5]);

    const inferred = attributeSources('Marcus and Elena are secretly plotting a coup against the council.', messages);
    assert.equal(inferred.confidence, 'inferred');
    assert.deepEqual(inferred.sourceRef, []);
});

test('attributeSources: per-fact, not per-entry — one inferred sentence flips the whole entry (review finding 2)', () => {
    const messages = [
        { id: 3, text: 'The bridge collapsed last spring, everyone in town remembers it.' },
        { id: 40, text: 'Marcus stood on the riverbank and watched the water rise for hours.' },
        { id: 200, text: 'Elena kept a cover story ready, just in case anyone asked where she had been.' },
    ];
    // Two well-sourced sentences plus one the story never actually said — a
    // >=50% majority vote would read this whole entry as "stated" and hide
    // the bad claim exactly like the worked example in the issue.
    const content = 'The bridge collapsed last spring. Marcus watched the water rise for hours. '
        + 'Marcus and Elena are secretly having an affair.';
    const result = attributeSources(content, messages);
    assert.equal(result.facts.length, 3);
    assert.equal(result.facts[0].confidence, 'stated');
    assert.equal(result.facts[1].confidence, 'stated');
    assert.equal(result.facts[2].confidence, 'inferred');
    // Entry-level rollup surfaces the one bad sentence rather than averaging it away.
    assert.equal(result.confidence, 'inferred');
    // Full id list, not a collapsed "3-200" span (review finding 3).
    assert.deepEqual(result.sourceRef, [3, 40]);
});

test('attributeSources: reads the real extractAuditMessages shape (rawText), not just test fixtures\' text/mes', () => {
    // extractAuditMessages (auditorCore.js) emits {id, speaker, rawText} — the
    // ACTUAL shape plan.messages carries at runtime. A prior bug read only
    // .text/.mes, so every real message scored as empty text and every entry
    // came back 'inferred' regardless of content.
    const messages = [{ id: 5, speaker: 'Narrator', rawText: 'The bridge collapsed last spring.' }];
    const result = attributeSources('The bridge collapsed last spring.', messages);
    assert.equal(result.confidence, 'stated');
    assert.deepEqual(result.sourceRef, [5]);
});

test('applyProvenancePinning: unchanged source is skipped, not rewritten', () => {
    const existing = [{ title: 'Ada', content: 'Ada is a synth.', stmbAutoContentHash: hashContent('Ada is a synth.') }];
    const generated = [{ title: 'Ada', content: 'Ada is a synth.' }];
    const { toWrite, skipped } = applyProvenancePinning(generated, existing);
    assert.deepEqual(toWrite, []);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, 'source unchanged');
});

test('applyProvenancePinning: a human-edited entry is pinned and a contradiction is reported, not overwritten', () => {
    // The tool wrote "Ada is a synth." last run (hash matches). A human then
    // corrected it by hand to "Ada is human." — the hash on disk is now stale,
    // which IS the edit signal.
    const existing = [{ title: 'Ada', content: 'Ada is human.', stmbAutoContentHash: hashContent('Ada is a synth.') }];
    const generated = [{ title: 'Ada', content: 'Ada is a synth, revealed in chapter 4.' }];

    const { toWrite, skipped, contradictions, newlyPinned } = applyProvenancePinning(generated, existing);
    assert.deepEqual(toWrite, []);
    assert.equal(skipped[0].reason, 'human-verified, source contradiction reported');
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].existing, 'Ada is human.');
    assert.equal(contradictions[0].proposed, 'Ada is a synth, revealed in chapter 4.');
    assert.deepEqual(newlyPinned, [{ title: 'Ada' }]);
});

test('applyProvenancePinning: a previously-pinned entry stays pinned even once the hash lines up', () => {
    const existing = [{ title: 'Ada', content: 'Ada is human.', stmbAutoVerifiedByHuman: true, stmbAutoContentHash: hashContent('Ada is human.') }];
    const generated = [{ title: 'Ada', content: 'Ada is actually a synth.' }];
    const { toWrite, contradictions } = applyProvenancePinning(generated, existing);
    assert.deepEqual(toWrite, []);
    assert.equal(contradictions.length, 1);
});

test('applyProvenancePinning: a brand new entry with no prior always writes', () => {
    const { toWrite } = applyProvenancePinning([{ title: 'New Guy', content: 'Some new content.' }], []);
    assert.equal(toWrite.length, 1);
});

// ---------------------------------------------------------------- PHA-2681 review finding 5: rename

test('applyProvenancePinning: a renamed pinned entry keeps its pin instead of duplicating', () => {
    const existing = [{
        title: 'Button', uid: 7, content: 'Button is a synth.',
        stmbAutoVerifiedByHuman: true, stmbAutoContentHash: hashContent('Button is a synth.'),
    }];
    const generated = [{ title: 'Button Firewood', content: 'Button is a synth.' }];
    const { toWrite, skipped, renamed } = applyProvenancePinning(generated, existing);
    assert.deepEqual(toWrite, []);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, 'human-verified, unchanged (rename ignored)');
    assert.deepEqual(renamed, [{ uid: 7, from: 'Button', to: 'Button Firewood' }]);
});

test('applyProvenancePinning: a renamed pinned entry with a genuine contradiction is reported, not duplicated', () => {
    const existing = [{
        title: 'Button', uid: 7, content: 'Button is human.',
        stmbAutoVerifiedByHuman: true, stmbAutoContentHash: hashContent('Button is human.'),
    }];
    const generated = [{ title: 'Button Firewood', content: 'Button is a synth, revealed in chapter 9.' }];
    const { toWrite, contradictions, renamed } = applyProvenancePinning(generated, existing);
    assert.deepEqual(toWrite, []);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].renamedFrom, 'Button');
    assert.equal(renamed.length, 0, 'a contradiction does not apply the rename either');
});

test('applyProvenancePinning: rename fallback never fires for a prior that is not human-verified', () => {
    const existing = [{ title: 'Button', content: 'Button is a synth.', stmbAutoContentHash: hashContent('Button is a synth.') }];
    const generated = [{ title: 'Button Firewood', content: 'Button is a synth, reworded slightly.' }];
    const { toWrite, renamed } = applyProvenancePinning(generated, existing);
    assert.equal(renamed.length, 0);
    assert.equal(toWrite.length, 1, 'ordinary (non-pinned) renames are out of scope — treated as a new entry');
});

test('applyProvenancePinning: an exact title match is never stolen by another entry\'s rename fallback', () => {
    const existing = [
        { title: 'Button', uid: 7, content: 'Button is a synth.', stmbAutoVerifiedByHuman: true, stmbAutoContentHash: hashContent('Button is a synth.') },
    ];
    const generated = [
        { title: 'Button', content: 'Button is a synth.' },          // legit exact update
        { title: 'Button Firewood', content: 'Someone unrelated.' }, // must NOT also claim "Button" as its prior
    ];
    const { toWrite, renamed } = applyProvenancePinning(generated, existing);
    assert.equal(renamed.length, 0);
    assert.equal(toWrite.length, 1);
    assert.equal(toWrite[0].title, 'Button Firewood');
});
