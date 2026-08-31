// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 phattbeats
// SPDX-License-Identifier: AGPL-3.0-only
//
// eval/rewriteAcceptance.js — PHA-2732: the rewrite's acceptance harness.
//
// Calibrated against `main` BEFORE the rewrite (PHA-2729) touches any code, so
// a pass here proves the harness can fail, not just that it agrees with
// whatever the running copy already does. See PHA-2732 for the full spec.
//
// Tests properties and coverage, never wording — the rewrite is expected to
// produce BETTER lorebooks, so a byte-diff against today's output would
// register every genuine improvement as a regression.
//
//   TIER 1 — invariants, asserted on any generated book:
//     1. checkNoKeywordCollisions   — no keyword claimed by two entries
//     2. checkNoZeroKeyEntries      — no entry ships with zero keys
//     3. checkNoOverbroadKeywords   — no key fires on nearly every message
//     4. checkProvenanceInBounds    — `src: msgs X–Y` parses and is in-range
//     5. checkZeroWritesOnRerun     — re-run on unchanged source writes nothing
//     6. checkHumanPinSurvives      — a pinned entry survives; contradictions
//                                     are reported, never silently overwritten
//     9. checkDrift                 — an entry whose source didn't change is
//                                     byte-identical step to step (N-slice only)
//
//   TIER 2 — coverage, as set comparison:
//     7. scoreEntityCoverage        — found/missed/extra vs the Magisa 52-entry
//                                     hand-built reference book
//     8. checkBoundaryPrecision     — meets the project's own boundary-detection
//                                     gate (README.md: precision >= 0.9 @ ±1,
//                                     raw boundaries)
//
//   N-SLICE REPLAY — replayNSlices() drives runOneShotStep() across growing
//   transcript slices, so the harness exercises "many sessions, story growing
//   between them" rather than a single before/after diff.
//
//   PHA-2693 REPORT DIMENSIONS — the rest of what the N-slice verification
//   section asks for, layered on the same replay:
//    10. checkIdempotence          — a second pass over the SAME slice leaves
//                                    the book byte-identical (stronger than
//                                    check 5, which only asks what the pinning
//                                    stage decided)
//    11. checkCorrectionDurability — a hand-edit at step K is still there at
//                                    step N, and later contradictions were
//                                    reported rather than applied
//    12. provenanceSpotCheck       — 5 entries with their `src: msgs` citations
//                                    and the cited message text inline.
//                                    Reported for a human to judge, never
//                                    asserted
//    13. compareCost               — incremental vs one full rebuild, input and
//                                    output NEVER summed (see compareCost)
//   Per step, replayNSlices also reports regenerated-vs-total, frozen vs stale,
//   and per-step cost.
//
// WHAT THIS EXERCISES, AND WHAT IT DOES NOT
// ------------------------------------------
// This harness drives the ONE-SHOT lorebook path (oneShotLorebookCore.js),
// imported unmodified from the extension root — every pure function below
// (generateOneShotEntries, enforceGlobalKeywordUniqueness,
// applyProvenancePinning, attributeSources, hashContent, ...) is the REAL
// production code, not a reimplementation. The one true external dependency —
// "what does the model reply with?" — is injected as `generate(prompt) =>
// Promise<string>`, exactly like every other phaseN harness in this directory.
//
// `runOneShotStep` below is a Node-runnable clone of the ORCHESTRATION in
// oneShotLorebook.js:136-285 (the SillyTavern-bound binding layer), because
// that file imports ST module specifiers (extensions.js, script.js,
// openai.js, addlore.js's upsert path, stmemory.js's fetchWithRetry) that do
// not resolve outside a running SillyTavern — the same reason
// oneShotLorebookCore.test.js never imports it either (verified in the PHA-2732
// survey). Keep the step order here in sync with oneShotLorebook.js if that
// file's orchestration ever changes; a divergence there is a harness bug, not
// a product bug.
//
// Checks 4 and 9 read provenance as `src: msgs X–Y` lines in entry CONTENT,
// via the same `extractProvenanceRanges` the product's claim re-verification
// uses. PHA-2722 collapsed the two provenance systems this file's earlier
// comment described: `stmbAutoSourceRef` (an entry property nothing read) is
// gone, and one-shot now emits `src: msgs` citations like every other writer.
//
// This matters to the harness specifically, and is why the switch is not
// optional: both checks used to `continue` past any entry whose
// `stmbAutoSourceRef` didn't parse. With the field removed that guard hits
// EVERY entry, so check 4 returns `ok: true` with zero offenders and check 9
// returns `checked: 0` — two of nine acceptance checks passing unconditionally
// without inspecting anything. A harness that cannot fail proves nothing
// (see the calibration note at the top of this file), so check 4 now also
// fails a non-empty book in which NO entry carries provenance at all, rather
// than reporting that as clean.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonlFile } from './parser.js';
import { deriveGroundTruth } from './groundTruth.js';
import { scoreBoundaries } from './score.js';

import { extractAuditMessages } from '../auditorCore.js';
import { extractProvenanceRanges } from '../auditorTechnicalPass.js';
import {
    ONE_SHOT_DEFAULTS,
    ONE_SHOT_PROMPT,
    buildOneShotPrompt,
    formatExistingEntries,
    formatTranscript,
    generateOneShotEntries,
    dropMemoryTitleCollisions,
    collectClaimedKeywords,
    enforceGlobalKeywordUniqueness,
    applyProvenancePinning,
    attributeSources,
    hashContent,
    findKeywordCollisions,
    normalizeKeyword,
    containsWholeWord,
    collectPriorAwards,
    dropFrozenEntries,
    planIncrementalRun,
    transcriptHighWater,
} from '../oneShotLorebookCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The 328-message Satire Isekai / Magisa chat export (same fixture Phase 7 uses). */
export const DEFAULT_TRANSCRIPT = resolve(__dirname, 'fixtures/transcript.jsonl');

/** The hand-built 52-entry Magisa reference book — ground truth for check 7. */
export const DEFAULT_REFERENCE_BOOK = resolve(__dirname, 'fixtures/worldbook.json');

/** A previously-captured real-detector run, reused (not re-called) for check 8. */
export const DEFAULT_PREDICTIONS = resolve(__dirname, 'out/predictions.json');

/** Canned one-shot replies captured from a real `--live` calibration run (PHA-2732). */
export const DEFAULT_CANNED_REPLIES = resolve(__dirname, 'fixtures/rewriteAcceptance-canned.json');

export const REWRITE_ACCEPTANCE_DEFAULTS = Object.freeze({
    ...ONE_SHOT_DEFAULTS,
    // Ground-truth rules, same as phase7Acceptance.js (PHA-1555 comment 083e4488).
    timeJumpMinutes: 90,
    minSceneMessages: 6,
    // README.md's own Phase-0 gate: "precision >= 0.9 at +/-1 message tolerance
    // against the raw ground-truth boundary set." Reused verbatim as check 8's bar.
    boundaryTolerance: 1,
    minBoundaryPrecision: 0.9,
    // Check 3: a keyword that fires on more than this fraction of messages is
    // "nearly every message" (protagonist name alone, the faction's own name).
    maxKeywordFireFraction: 0.5,
});

// ----------------------------------------------------------------------------
// Fixture loading
// ----------------------------------------------------------------------------

/**
 * Load the transcript as BOTH shapes the harness needs: the eval parser's
 * header-aware messages (for scene-boundary ground truth) and the auditor's
 * own `{id, speaker, rawText}` shape (for one-shot generation input) — the
 * exact shape `formatTranscript`/`attributeSources` expect, produced by the
 * REAL `extractAuditMessages` (auditorCore.js), not a reimplementation.
 *
 * @param {string} [fixturePath]
 * @returns {Promise<{messages:object[], chat:object[], auditMessages:object[], warnings:string[]}>}
 */
export async function loadFixture(fixturePath = DEFAULT_TRANSCRIPT) {
    const { messages, warnings } = await parseJsonlFile(fixturePath);
    const chat = messages.map((m) => ({
        name: m.speaker,
        is_user: m.isUser === true,
        is_system: m.isSystem === true,
        mes: m.text,
    }));
    const auditMessages = extractAuditMessages(chat);
    return { messages, chat, auditMessages, warnings: warnings || [] };
}

/**
 * Project a raw SillyTavern world-info blob (`{entries:{uid:entry}}`) into the
 * flat shape the one-shot pipeline's pure functions consume.
 *
 * Mirrors auditorJobs.js:147-168 `entriesForCoverage` EXACTLY. Reimplemented
 * here rather than imported: auditorJobs.js pulls in SillyTavern module
 * specifiers (extensions.js, script.js, popup.js, world-info.js, ...) at the
 * top of the file that do not resolve outside a running SillyTavern. If that
 * projection ever changes, this must change with it.
 *
 * @param {object} lorebookData
 * @returns {Array<object>}
 */
export function projectEntries(lorebookData) {
    const out = [];
    for (const entry of Object.values(lorebookData?.entries || {})) {
        if (!entry) continue;
        out.push({
            uid: entry.uid,
            title: entry.comment || '',
            content: entry.content || '',
            keys: Array.isArray(entry.key) ? entry.key : [],
            constant: !!entry.constant,
            disable: entry.disable === true,
            isMemory: entry.stmemorybooks === true,
            stmbAutoContentHash: entry.stmbAutoContentHash,
            stmbAutoVerifiedByHuman: entry.stmbAutoVerifiedByHuman === true,
            stmbAutoConfidence: entry.stmbAutoConfidence,
        });
    }
    return out;
}

/**
 * Load the Magisa reference book (or any worldbook.json-shaped fixture) already
 * projected into the flat coverage shape.
 * @param {string} [bookPath]
 */
export async function loadReferenceBook(bookPath = DEFAULT_REFERENCE_BOOK) {
    const raw = JSON.parse(await readFile(bookPath, 'utf8'));
    return projectEntries(raw);
}

// ----------------------------------------------------------------------------
// Harness-only book state (NOT a product reimplementation — see file header)
// ----------------------------------------------------------------------------

/**
 * Harness stand-in for `upsertLorebookEntryByTitle` (addlore.js): match by
 * normalized title, replace in place or append. It does none of the real
 * function's SillyTavern bookkeeping (uid allocation against a live world-info
 * object, `saveWorldInfo`) — it only needs to keep the flat coverage-shaped
 * array the harness's checks read, so the pure pinning/uniqueness/attribution
 * functions above see the same "existing book" shape on the next step.
 *
 * @param {Array<object>} book mutated in place
 * @param {string} title
 * @param {string} content
 * @param {object} [overrides] entryOverrides shape from oneShotLorebook.js:211-236
 * @returns {{created:boolean, updated:boolean}}
 */
export function upsertByTitle(book, title, content, overrides = {}) {
    const norm = String(title ?? '').trim().toLowerCase();
    const idx = book.findIndex((e) => String(e.title ?? '').trim().toLowerCase() === norm);
    const next = {
        uid: idx >= 0 ? book[idx].uid : book.length,
        title,
        content,
        keys: overrides.key ?? (idx >= 0 ? book[idx].keys : []),
        constant: overrides.constant ?? (idx >= 0 ? book[idx].constant : false),
        disable: overrides.disable ?? false,
        isMemory: idx >= 0 ? book[idx].isMemory : false,
        stmbAutoContentHash: overrides.stmbAutoContentHash,
        stmbAutoVerifiedByHuman: overrides.stmbAutoVerifiedByHuman === true,
        stmbAutoConfidence: overrides.stmbAutoConfidence,
        // PHA-2693: mirrors auditorJobs.js `entriesForCoverage` carrying the
        // mark through the projection. Without it every step reads "no record
        // of a prior run" and silently degrades to a full rebuild.
        stmbAutoRunHighWater: overrides.stmbAutoRunHighWater
            ?? (idx >= 0 ? book[idx].stmbAutoRunHighWater : undefined),
    };
    if (idx >= 0) { book[idx] = next; return { created: false, updated: true }; }
    book.push(next);
    return { created: true, updated: false };
}

/**
 * One full one-shot generation step: prompt build -> generate -> parse ->
 * memory-title guard -> global keyword uniqueness -> provenance pinning ->
 * write. Mirrors oneShotLorebook.js:145-268 step-for-step (see file header).
 *
 * `existing` is snapshotted BEFORE any writes, exactly like
 * `entriesForCoverage(lorebook.data)` at oneShotLorebook.js:145 is a snapshot
 * unaffected by the writes the same run performs later.
 *
 * @param {{book:Array<object>, auditMessages:Array<object>, transcriptText:string,
 *          generate:function, cfg?:object}} p
 * @returns {Promise<{ok:boolean, message?:string, parsed?:object, guarded?:object,
 *           entries?:Array, collisions?:Array, pinning?:object, writes?:Array, prompt?:string}>}
 */
export async function runOneShotStep({ book, auditMessages, transcriptText, generate, cfg = {} } = {}) {
    const fullCfg = { ...REWRITE_ACCEPTANCE_DEFAULTS, ...cfg };
    const existing = book.map((e) => ({ ...e }));
    const lorePool = existing.filter((e) => !e.isMemory);

    // PHA-2693 Build item 5, mirroring oneShotLorebook.js. `incremental: false`
    // is the full-rebuild ground truth the report compares against.
    const incremental = planIncrementalRun({
        existing,
        messages: auditMessages,
        unresolvedQuestions: fullCfg.unresolvedQuestions,
        enabled: fullCfg.incremental !== false,
    });
    const NO_PINNING = { toWrite: [], skipped: [], contradictions: [], newlyPinned: [], renamed: [] };
    if (incremental.canSkipCall) {
        return { ok: true, skippedCall: true, incremental, entries: [], collisions: [], writes: [], pinning: NO_PINNING };
    }

    const prompt = buildOneShotPrompt({
        transcriptText,
        existingText: formatExistingEntries(existing, incremental.frozenTitles),
        maxEntries: fullCfg.maxEntries,
        template: fullCfg.prompt || ONE_SHOT_PROMPT,
    });

    const parsed = await generateOneShotEntries({ generate, prompt, cfg: fullCfg });
    if (!parsed) {
        return { ok: false, message: 'the model returned no usable entry set', prompt, incremental };
    }

    const thawed = dropFrozenEntries(parsed.entries, incremental.frozenTitles);
    if (!thawed.entries.length && thawed.skipped.length) {
        // The model agreed with the run's own staleness call. A correct
        // no-change incremental step, not a failure.
        return { ok: true, prompt, parsed, incremental, thawed, entries: [], collisions: [], writes: [], pinning: NO_PINNING };
    }

    const guarded = dropMemoryTitleCollisions(thawed.entries, existing);
    if (!guarded.entries.length) {
        return { ok: false, message: 'every generated entry collided with an existing scene memory', prompt, parsed, guarded, incremental };
    }

    const rewritten = new Set(guarded.entries.map((e) => e.title.trim().toLowerCase()));
    const claimedByExisting = collectClaimedKeywords(lorePool, rewritten);
    for (const k of collectClaimedKeywords(existing.filter((e) => e.isMemory))) claimedByExisting.add(k);

    // PHA-2693 Build item 6.
    const priorAwards = collectPriorAwards(existing);
    const { entries, collisions } = enforceGlobalKeywordUniqueness(guarded.entries, claimedByExisting, priorAwards);
    const pinning = applyProvenancePinning(entries, existing);

    const runHighWater = transcriptHighWater(auditMessages);
    const writes = [];
    for (const entry of pinning.toWrite) {
        // PHA-2722: `stmbAutoConfidence` is the only provenance-derived property
        // the product persists now — the citations themselves live in content.
        const { confidence } = attributeSources(entry.content, auditMessages);
        const overrides = {
            key: entry.key,
            keysecondary: entry.keysecondary,
            constant: entry.keywordless ? false : entry.constant,
            disable: false,
            stmbAutoContentHash: hashContent(entry.content),
            stmbAutoConfidence: confidence,
            stmbAutoVerifiedByHuman: false,
            stmbAutoRunHighWater: runHighWater,
        };
        const res = upsertByTitle(book, entry.title, entry.content, overrides);
        writes.push({ title: entry.title, confidence, ...res });
    }

    // Latch the pin, same as oneShotLorebook.js:252-268: re-write the SAME prior
    // content but stamp stmbAutoVerifiedByHuman so the pin survives once the
    // hash-mismatch signal that revealed the edit is gone.
    for (const { title } of pinning.newlyPinned) {
        const prior = existing.find((e) => String(e.title ?? '').trim().toLowerCase() === title.trim().toLowerCase());
        if (!prior) continue;
        upsertByTitle(book, title, prior.content, {
            key: prior.keys,
            constant: prior.constant,
            stmbAutoVerifiedByHuman: true,
            stmbAutoContentHash: hashContent(prior.content),
        });
    }

    return { ok: true, prompt, parsed, guarded, thawed, incremental, entries, collisions, pinning, writes };
}

// ----------------------------------------------------------------------------
// TIER 1 — invariants
// ----------------------------------------------------------------------------

/** Check 1: no keyword claimed by two entries. Reuses `findKeywordCollisions` verbatim. */
export function checkNoKeywordCollisions(book) {
    const live = (book || []).filter((e) => !e.disable);
    const collisions = findKeywordCollisions(live.map((e) => ({ title: e.title, key: e.keys })));
    return { ok: collisions.length === 0, collisions };
}

/** Check 2: no entry ships with zero keys. */
export function checkNoZeroKeyEntries(book) {
    const offenders = (book || [])
        .filter((e) => !e.disable && (!Array.isArray(e.keys) || e.keys.length === 0))
        .map((e) => e.title);
    return { ok: offenders.length === 0, offenders };
}

/**
 * Check 3: no key fires on nearly every message (protagonist name alone, a
 * title the protagonist also holds, the faction's own name).
 *
 * @param {{book:Array<object>, messages:Array<{text?:string, rawText?:string}>, maxFireFraction?:number}} p
 */
export function checkNoOverbroadKeywords({ book, messages, maxFireFraction = REWRITE_ACCEPTANCE_DEFAULTS.maxKeywordFireFraction } = {}) {
    const total = (messages || []).length || 1;
    const lowerTexts = (messages || []).map((m) => String(m.text ?? m.rawText ?? '').toLowerCase());
    const offenders = [];
    const seen = new Set();
    for (const e of (book || [])) {
        if (e.disable) continue;
        for (const k of (e.keys || [])) {
            const nk = normalizeKeyword(k);
            if (!nk || seen.has(nk)) continue;
            seen.add(nk);
            let hits = 0;
            for (const text of lowerTexts) if (containsWholeWord(text, nk)) hits++;
            const fraction = hits / total;
            if (fraction > maxFireFraction) offenders.push({ keyword: k, fraction, hits, total });
        }
    }
    return { ok: offenders.length === 0, offenders, maxFireFraction };
}

/** A `src: msgs` marker in any shape, valid or not — used to tell "no citation
 *  was written" apart from "a citation was written but is malformed". */
const PROVENANCE_MARKER_RE = /src:\s*msgs\b/gi;

/** How many `src: msgs` markers appear in `content`, parseable or not. */
function countProvenanceMarkers(content) {
    PROVENANCE_MARKER_RE.lastIndex = 0;
    let n = 0;
    while (PROVENANCE_MARKER_RE.exec(String(content ?? '')) !== null) n++;
    return n;
}

/**
 * Check 4: every `src: msgs X–Y` citation in entry content parses and is
 * in-bounds for the source transcript. An entry with no citation is not itself
 * a failure — `attributeSources` legitimately finds nothing to cite on a purely
 * inferred entry — but a citation that IS written must parse and sit inside
 * [idMin, idMax].
 *
 * A non-empty book in which no entry carries any citation IS a failure
 * (`no-provenance-in-book`). Before PHA-2722 this function read a
 * `stmbAutoSourceRef` property and skipped anything that didn't parse; once
 * that property was removed the skip swallowed every entry and the check
 * passed unconditionally. "Nothing to check" is not "clean" — that distinction
 * is the same one PHA-2722 drew in the product between `noProvenance` and
 * `unknown`.
 *
 * @param {{book:Array<object>, idMin:number, idMax:number}} p
 */
export function checkProvenanceInBounds({ book, idMin, idMax } = {}) {
    const offenders = [];
    const live = (book || []).filter((e) => !e.disable);
    let cited = 0;

    for (const e of live) {
        const ranges = extractProvenanceRanges(e.content);
        const markers = countProvenanceMarkers(e.content);
        if (markers > ranges.length) {
            offenders.push({ title: e.title, ref: e.content, reason: 'unparseable' });
        }
        if (ranges.length === 0) continue;
        cited++;
        for (const r of ranges) {
            if (r.start < idMin || r.end > idMax) {
                offenders.push({
                    title: e.title,
                    ref: `${r.start}-${r.end}`,
                    reason: 'out-of-bounds',
                    idMin,
                    idMax,
                });
            }
        }
    }

    if (live.length > 0 && cited === 0) {
        offenders.push({ title: null, ref: null, reason: 'no-provenance-in-book' });
    }

    return { ok: offenders.length === 0, offenders, idMin, idMax, cited, entries: live.length };
}

/** Check 5: a re-run on unchanged source produces zero writes (PHA-2681's own Done-when). */
export function checkZeroWritesOnRerun(pinning) {
    const unchangedSkips = (pinning?.skipped || []).filter((s) => s.reason === 'source unchanged').length;
    return {
        ok: (pinning?.toWrite || []).length === 0,
        toWriteCount: (pinning?.toWrite || []).length,
        skippedCount: (pinning?.skipped || []).length,
        unchangedSkips,
    };
}

/**
 * Check 6: a human-pinned entry survives a re-run; a genuine contradiction is
 * reported, never silently overwritten. Pure logic (`applyProvenancePinning`),
 * so this is checked directly against ANY step's pinning result — no live
 * model call is needed to prove the contract, only a step where a pinned
 * entry existed going in.
 *
 * @param {{pinning:object, pinnedTitles:Iterable<string>, book:Array<object>,
 *          preStepContent:Map<string,string>}} p
 */
export function checkHumanPinSurvives({ pinning, pinnedTitles, book, preStepContent } = {}) {
    const pinned = new Set([...(pinnedTitles || [])].map((t) => t.trim().toLowerCase()));
    const offenders = [];
    for (const title of pinned) {
        const before = preStepContent.get(title);
        const after = (book || []).find((e) => e.title.trim().toLowerCase() === title);
        if (!after) { offenders.push({ title, reason: 'pinned entry disappeared' }); continue; }
        const wasWritten = (pinning?.toWrite || []).some((e) => e.title.trim().toLowerCase() === title);
        if (wasWritten && after.content !== before) {
            const reportedAsContradiction = (pinning?.contradictions || []).some((c) => c.title.trim().toLowerCase() === title);
            if (!reportedAsContradiction) {
                offenders.push({ title, reason: 'content changed without a reported contradiction' });
            } else if (after.content !== before) {
                offenders.push({ title, reason: 'contradiction was reported but the pinned content was overwritten anyway' });
            }
        }
    }
    return { ok: offenders.length === 0, offenders, contradictions: pinning?.contradictions || [] };
}

/**
 * Check 9 (N-slice only): an entry whose source material never changed must be
 * byte-identical across steps — not a re-worded photocopy. "Never changed"
 * means the LAST message cited by its `src: msgs X–Y` lines sits at or before
 * the PREVIOUS step's slice boundary, i.e. no new message could have informed
 * a rewrite. Reads citations from content (PHA-2722) — the `stmbAutoSourceRef`
 * property this used to consult no longer exists, and skipping on its absence
 * silently reduced this check to `checked: 0`.
 *
 * @param {{before:Array<{title:string, content:string}>,
 *          after:Array<{title:string, content:string}>, prevBoundary:number}} p
 */
export function checkDrift({ before, after, prevBoundary, frozenTitles } = {}) {
    const beforeByTitle = new Map((before || []).map((e) => [e.title.trim().toLowerCase(), e]));
    const offenders = [];
    let checked = 0;
    let unscoreable = 0;

    // Two bases, and which one is in play matters when reading the result.
    //
    // `frozen-set` is the run's OWN answer to "whose source changed?", from
    // planIncrementalRun (PHA-2693). It is the right basis whenever it exists.
    //
    // `source-ref` is the original PHA-2732 proxy — "this entry's citations end
    // at or before the last slice boundary" — and it is only a proxy. An
    // entry's citations say where its CURRENT content came from, not whether
    // new material could legitimately extend it: an entry sourced at message 1
    // that the story is still discussing at message 20 scores as
    // source-unchanged, so every honest update to it reads as drift. Kept as
    // the fallback because a full rebuild has no frozen set to use, and that is
    // exactly the mode where real drift is expected to show up.
    const useFrozen = frozenTitles instanceof Set && frozenTitles.size > 0;

    for (const e of (after || [])) {
        const key = e.title.trim().toLowerCase();
        const prior = beforeByTitle.get(key);
        if (!prior) continue; // new entry this step — nothing to compare

        if (useFrozen) {
            if (!frozenTitles.has(key)) continue;
        } else {
            const ranges = extractProvenanceRanges(prior.content);
            // Counted rather than silently dropped: an entry with no citation
            // is a HOLE in this check's coverage, and a check that reports `ok`
            // while quietly scoring nothing is worse than one that fails.
            if (ranges.length === 0) { unscoreable++; continue; }
            const end = Math.max(...ranges.map((r) => r.end));
            if (end > prevBoundary) continue; // source COULD have changed
        }

        checked++;
        if (e.content !== prior.content) {
            offenders.push({ title: e.title, prevBoundary });
        }
    }
    return { ok: offenders.length === 0, offenders, checked, unscoreable, basis: useFrozen ? 'frozen-set' : 'source-ref' };
}

/** Run every non-N-slice-specific Tier 1 check and return a named map. */
export function runTier1Checks({ book, messages, idMin, idMax, cfg = {} } = {}) {
    return {
        noKeywordCollisions: checkNoKeywordCollisions(book),
        noZeroKeyEntries: checkNoZeroKeyEntries(book),
        noOverbroadKeywords: checkNoOverbroadKeywords({ book, messages, maxFireFraction: cfg.maxKeywordFireFraction }),
        provenanceInBounds: checkProvenanceInBounds({ book, idMin, idMax }),
    };
}

// ----------------------------------------------------------------------------
// TIER 2 — coverage as set comparison
// ----------------------------------------------------------------------------

/** Every normalized name an entry can be recognized by: its title and its keys. */
export function extractEntityNames(entry) {
    const names = new Set();
    const push = (s) => { const n = normalizeKeyword(s); if (n) names.add(n); };
    push(entry.title);
    for (const k of (entry.keys || entry.key || [])) push(k);
    return names;
}

/** Do two name-sets refer to the same entity? Exact match, or a >=4-char whole-name containment. */
function namesOverlap(a, b) {
    for (const x of a) {
        for (const y of b) {
            if (x === y) return true;
            if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
        }
    }
    return false;
}

/**
 * Check 7: entity/event/location coverage, as a SET comparison against the
 * hand-built Magisa reference book. Wording differences never fail this check
 * — only a reference entity with no matching name anywhere in the generated
 * book does. "Extra" entries (in the generated book, matching nothing in the
 * reference) are informational: the reference is a human artifact, not
 * exhaustive by definition, so extras are reported, never penalized.
 *
 * @param {Array<object>} generatedBook
 * @param {Array<object>} referenceBook
 */
export function scoreEntityCoverage(generatedBook, referenceBook) {
    const refs = (referenceBook || []).filter((e) => !e.disable);
    const gens = (generatedBook || []).filter((e) => !e.disable);
    const genNamed = gens.map((e) => ({ title: e.title, names: extractEntityNames(e) }));

    const found = [];
    const missed = [];
    const matchedGenTitles = new Set();
    for (const ref of refs) {
        const rn = extractEntityNames(ref);
        let hit = false;
        for (const g of genNamed) {
            if (namesOverlap(rn, g.names)) { hit = true; matchedGenTitles.add(g.title); }
        }
        (hit ? found : missed).push(ref.title);
    }
    const extra = gens.filter((e) => !matchedGenTitles.has(e.title)).map((e) => e.title);

    return {
        ok: missed.length === 0,
        total: refs.length,
        foundCount: found.length,
        missedCount: missed.length,
        extraCount: extra.length,
        found,
        missed,
        extra,
    };
}

/**
 * Check 8: boundary-detection precision meets or beats the project's own
 * measured gate. Reuses a PREVIOUSLY-CAPTURED real-detector run
 * (`eval/out/predictions.json`, captured via the claude-cli shim against this
 * same transcript) rather than making a fresh live call — the gate is about
 * whether the rewrite regresses detection quality, which this frozen
 * real-model snapshot is sufficient to check deterministically and for free.
 * A `--live` recalibration can regenerate `predictions.json` via eval/run.js.
 *
 * Scored against RAW boundaries (not merged) at +/-1 tolerance, matching
 * README.md's own stated Phase-0 gate: "precision >= 0.9 at +/-1 message
 * tolerance against the raw ground-truth boundary set."
 *
 * @param {{messages:Array<object>, predictionsPath?:string, minPrecision?:number,
 *          tolerance?:number, timeJumpMinutes?:number, minSceneMessages?:number}} p
 */
export async function checkBoundaryPrecision({
    messages,
    predictionsPath = DEFAULT_PREDICTIONS,
    minPrecision = REWRITE_ACCEPTANCE_DEFAULTS.minBoundaryPrecision,
    tolerance = REWRITE_ACCEPTANCE_DEFAULTS.boundaryTolerance,
    timeJumpMinutes = REWRITE_ACCEPTANCE_DEFAULTS.timeJumpMinutes,
    minSceneMessages = REWRITE_ACCEPTANCE_DEFAULTS.minSceneMessages,
} = {}) {
    const raw = JSON.parse(await readFile(predictionsPath, 'utf8'));
    const predicted = Array.isArray(raw?.predictions) ? raw.predictions : [];
    const gt = deriveGroundTruth(messages, { timeJumpMinutes, minSceneMessages });
    const score = scoreBoundaries({
        predicted,
        groundTruth: gt.raw,
        tolerance,
        messageCount: messages.length,
    });
    return {
        ok: score.precision >= minPrecision,
        precision: score.precision,
        recall: score.recall,
        minPrecision,
        tolerance,
        predictionsPath,
        rawBoundaryCount: gt.raw.length,
        predictedCount: predicted.length,
        score,
    };
}

// ----------------------------------------------------------------------------
// PHA-2693 report dimensions
// ----------------------------------------------------------------------------

/**
 * Idempotence: run the SAME step again against the SAME slice and assert the
 * book does not move.
 *
 * Distinct from check 5 (`checkZeroWritesOnRerun`), which asks whether the
 * pinning stage decided to write. This asks the stronger, end-to-end question:
 * after a second full pass, is the book byte-identical? A step can legitimately
 * "write" an entry whose content happens to match and still be idempotent; a
 * step that re-words one entry is not, no matter what it reported.
 *
 * @param {{book:Array<object>, auditMessages:Array<object>, transcriptText:string,
 *          generate:function, cfg?:object}} p
 */
export async function checkIdempotence({ book, auditMessages, transcriptText, generate, cfg = {} } = {}) {
    const shape = (list) => JSON.stringify((list || []).map((e) => ({ title: e.title, content: e.content, keys: e.keys })));
    const snapshot = shape(book);
    const replay = book.map((e) => ({ ...e }));
    const result = await runOneShotStep({ book: replay, auditMessages, transcriptText, generate, cfg });

    const moved = [];
    if (snapshot !== shape(replay)) {
        const byTitle = new Map((book || []).map((e) => [e.title, e]));
        for (const e of replay) {
            const prior = byTitle.get(e.title);
            if (!prior) { moved.push({ title: e.title, reason: 'appeared on the second pass' }); continue; }
            if (prior.content !== e.content) moved.push({ title: e.title, reason: 'content changed' });
            else if (JSON.stringify(prior.keys) !== JSON.stringify(e.keys)) moved.push({ title: e.title, reason: 'keywords changed' });
        }
    }
    return {
        ok: moved.length === 0,
        moved,
        skippedCall: result.skippedCall === true,
        writes: result.writes ? result.writes.length : 0,
    };
}

/**
 * Correction durability: a hand-edit made at step K is still there, byte for
 * byte, at step N — and any later source that contradicts it was REPORTED
 * rather than applied.
 *
 * `pinnedAt` is the content the human left behind. Anything else in the book at
 * the end is a failure regardless of how it got there, which is the point: this
 * check does not care which mechanism was supposed to protect it.
 *
 * @param {{book:Array<object>, pinnedAt:Map<string,{content:string, step:number}>,
 *          steps:Array<object>}} p
 */
export function checkCorrectionDurability({ book, pinnedAt, steps } = {}) {
    const offenders = [];
    const survived = [];
    const contradictionsReported = [];

    for (const [title, { content, step }] of (pinnedAt || new Map())) {
        const key = title.trim().toLowerCase();
        const now = (book || []).find((e) => e.title.trim().toLowerCase() === key);
        if (!now) { offenders.push({ title, step, reason: 'the pinned entry is gone from the book' }); continue; }
        if (now.content !== content) {
            offenders.push({ title, step, reason: 'the human correction was overwritten' });
            continue;
        }
        survived.push({ title, step, stepsSurvived: (steps || []).filter((s) => s.index > step).length });
        for (const s of (steps || [])) {
            for (const c of (s.result?.pinning?.contradictions || [])) {
                if (c.title.trim().toLowerCase() === key) {
                    contradictionsReported.push({ title, atStep: s.index, boundary: s.boundary });
                }
            }
        }
    }
    return { ok: offenders.length === 0, offenders, survived, contradictionsReported };
}

/**
 * Provenance spot-check: sample N entries and report what each one CLAIMS about
 * where it came from — the `src: msgs X–Y` ranges the model wrote into its own
 * content (PHA-2722's single provenance format), the messages those ranges
 * actually name, and the entry-level `stated`/`inferred` ranking signal — so a
 * human can go read those messages and say whether the claim holds.
 *
 * Deliberately not a pass/fail check. Whether a citation is *apt* is a
 * judgement about prose, which is why the issue asks for a spot-check a person
 * reads rather than an assertion. Sampling is deterministic (evenly spaced over
 * the title-sorted book) so the same book always yields the same five entries
 * to argue about.
 *
 * @param {{book:Array<object>, messages:Array<object>, sampleSize?:number}} p
 */
export function provenanceSpotCheck({ book, messages, sampleSize = 5 } = {}) {
    const live = (book || []).filter((e) => !e.disable).slice().sort((a, b) => a.title.localeCompare(b.title));
    const n = Math.min(sampleSize, live.length);
    const byId = new Map((messages || []).map((m) => [m.id, String(m.rawText ?? m.text ?? m.mes ?? '')]));

    const samples = [];
    for (let i = 0; i < n; i++) {
        const e = live[Math.floor((i * live.length) / n)];
        const ranges = extractProvenanceRanges(e.content);
        const ids = [];
        for (const r of ranges) for (let id = r.start; id <= r.end; id++) ids.push(id);
        samples.push({
            title: e.title,
            // The entry-level ranking signal PHA-2722 kept as a property.
            confidence: e.stmbAutoConfidence ?? '(none recorded)',
            citedRanges: ranges.map((r) => `${r.start}-${r.end}`),
            citedMessageCount: ids.length,
            content: e.content,
            // The actual message text, so the reader can judge the citation
            // without going back to the transcript by hand.
            cited: ids.slice(0, 12).map((id) => ({ id, text: (byId.get(id) || '').slice(0, 400) })),
        });
    }

    const live2 = (book || []).filter((e) => !e.disable);
    return {
        sampleSize: n,
        samples,
        bookTotals: {
            entries: live2.length,
            stated: live2.filter((e) => e.stmbAutoConfidence === 'stated').length,
            inferred: live2.filter((e) => e.stmbAutoConfidence === 'inferred').length,
            noConfidence: live2.filter((e) => e.stmbAutoConfidence == null).length,
            uncited: live2.filter((e) => extractProvenanceRanges(e.content).length === 0).length,
        },
    };
}

/**
 * Cost, reported honestly.
 *
 * The issue is explicit that token savings must not be led with, and the reason
 * is structural: under one-shot generation the whole transcript is in the prompt
 * on EVERY step regardless, so incremental cannot meaningfully move input
 * tokens. It moves output tokens (fewer entries emitted) and write calls. Input
 * and output are therefore reported separately and never summed into a single
 * headline number, because a summed number would hide exactly that.
 *
 * @param {{incremental:{calls:number, inputTokens:number, outputTokens:number, writes:number},
 *          full:{calls:number, inputTokens:number, outputTokens:number, writes:number}}} p
 */
export function compareCost({ incremental, full } = {}) {
    const pct = (a, b) => (b === 0 ? null : Math.round(((b - a) / b) * 1000) / 10);
    return {
        incremental,
        full,
        delta: {
            inputTokensSavedPct: pct(incremental.inputTokens, full.inputTokens),
            outputTokensSavedPct: pct(incremental.outputTokens, full.outputTokens),
            writesSavedPct: pct(incremental.writes, full.writes),
            calls: { incremental: incremental.calls, full: full.calls },
        },
        // Stated in the artifact itself so a reader who only skims the numbers
        // still gets the caveat.
        caveat: 'Input tokens are the whole transcript on every step in both modes, so an input-side saving here would be noise, not a result. Output tokens and write calls are where incremental actually differs. Token counts are char/4 estimates, not billed usage.',
    };
}

// ----------------------------------------------------------------------------
// N-slice replay
// ----------------------------------------------------------------------------

/**
 * Replay the transcript in N growing slices, running a full one-shot step at
 * each, so the harness exercises "many sessions, story growing between them"
 * rather than a single before/after diff. Reports, per step: entities
 * regenerated vs. total, every Tier 1 check, drift (check 9), and cumulative
 * token cost (input/output separated).
 *
 * @param {{book?:Array<object>, auditMessages:Array<object>, boundaries:number[],
 *          generate:function, cfg?:object, onStep?:function}} p
 * @returns {Promise<{steps:Array<object>, book:Array<object>}>}
 */
export async function replayNSlices({
    book: initialBook = [], auditMessages, boundaries, generate, cfg = {}, onStep,
    handEdits = new Map(), checkIdempotenceEveryStep = false,
} = {}) {
    const book = initialBook.map((e) => ({ ...e }));
    const steps = [];
    const cost = { calls: 0, inputTokens: 0, outputTokens: 0, writes: 0 };
    const tracked = withCostTracking(generate, cost);
    const pinnedAt = new Map();
    let prevBoundary = 0;
    let index = 0;

    for (const boundary of boundaries) {
        // A hand-edit "at step K" happens BEFORE step K runs — that is what a
        // human correcting the book between sessions looks like. The entry is
        // left with a content hash that no longer matches, which is the only
        // signal `wasHumanEdited` has to work from.
        for (const { title, content } of (handEdits.get(index) || [])) {
            const target = book.find((e) => e.title.trim().toLowerCase() === title.trim().toLowerCase());
            if (!target) continue;
            target.content = content;              // hash deliberately left stale
            pinnedAt.set(target.title, { content, step: index });
        }

        const slice = (auditMessages || []).filter((m) => m.id < boundary);
        const transcriptText = formatTranscript(slice, cfg.truncate);

        const before = book.map((e) => ({ title: e.title, content: e.content }));
        const stepCost = { calls: 0, inputTokens: 0, outputTokens: 0 };
        const stepTracked = withCostTracking(tracked, stepCost);
        const result = await runOneShotStep({ book, auditMessages: slice, transcriptText, generate: stepTracked, cfg });
        const after = book.map((e) => ({ title: e.title, content: e.content }));

        // The human's content IS the new baseline once the run latches the pin,
        // so track what it became rather than what it was stamped as.
        for (const [title, rec] of pinnedAt) {
            const now = book.find((e) => e.title.trim().toLowerCase() === title.trim().toLowerCase());
            if (now && now.stmbAutoVerifiedByHuman === true) rec.content = now.content;
        }

        const tier1 = runTier1Checks({ book, messages: slice, idMin: 0, idMax: boundary - 1, cfg });
        const drift = checkDrift({ before, after, prevBoundary, frozenTitles: result.incremental?.frozenTitles });
        const zeroWrites = checkZeroWritesOnRerun(result.pinning);
        const writes = result.writes ? result.writes.length : 0;
        cost.writes += writes;

        const idempotence = checkIdempotenceEveryStep
            ? await checkIdempotence({ book, auditMessages: slice, transcriptText, generate, cfg })
            : null;

        const step = {
            index,
            boundary,
            messageCount: slice.length,
            totalEntries: book.length,
            // "regenerated vs total", the issue's own per-step metric.
            regenerated: writes,
            frozen: result.incremental?.frozen.length ?? 0,
            stale: result.incremental?.stale.length ?? 0,
            mode: result.incremental?.mode ?? 'full',
            skippedCall: result.skippedCall === true,
            cost: stepCost,
            result,
            tier1,
            drift,
            zeroWrites,
            idempotence,
        };
        steps.push(step);
        prevBoundary = boundary;
        index++;
        if (typeof onStep === 'function') onStep(step);
    }

    const durability = pinnedAt.size ? checkCorrectionDurability({ book, pinnedAt, steps }) : null;

    return { steps, book, cost, durability, pinnedAt };
}

/**
 * Wrap a `generate(prompt) => Promise<string>` so every call's estimated
 * input/output token cost accumulates into `tracker`. Estimation, not exact
 * API usage — the char/4 heuristic already used elsewhere in this codebase
 * (auditorCore.js's `estimateTokensChars`) — since the injected `generate` may
 * be a CLI subprocess with no usage field to read. Reported honestly as an
 * estimate in the evidence, not billed truth.
 *
 * @param {function} generate
 * @param {{calls:number, inputTokens:number, outputTokens:number}} tracker mutated in place
 */
export function withCostTracking(generate, tracker) {
    const estimate = (t) => Math.ceil(String(t ?? '').length / 4);
    return async function tracked(prompt) {
        tracker.calls = (tracker.calls || 0) + 1;
        tracker.inputTokens = (tracker.inputTokens || 0) + estimate(prompt);
        const reply = await generate(prompt);
        tracker.outputTokens = (tracker.outputTokens || 0) + estimate(reply);
        return reply;
    };
}

/**
 * A `generate` that replays canned replies captured from a real calibration
 * run, keyed by call index. Offline, deterministic, zero cost — the default
 * for CI. Throws if more calls are made than were recorded, so a harness
 * change that adds a call is loud rather than silently replaying stale data.
 *
 * @param {string[]} replies
 * @returns {function}
 */
export function makeCannedGenerate(replies) {
    let i = 0;
    return async function canned() {
        if (i >= replies.length) {
            throw new Error(`makeCannedGenerate: call ${i + 1} requested but only ${replies.length} replies were recorded`);
        }
        return replies[i++];
    };
}
