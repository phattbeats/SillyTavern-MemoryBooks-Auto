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
//     4. checkProvenanceInBounds    — stmbAutoSourceRef parses and is in-range
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
// Check 4 covers the `stmbAutoSourceRef` provenance format (PHA-2681, the
// one-shot lore path this harness exercises). The OLDER `src: msgs X-Y`
// format (nudgeHelpers.js, consumed by auditorTechnicalPass.js's claim
// reverification) belongs to the scene-memory-creation path, which this
// harness does not exercise — no scene memories are ever created here, so
// there is nothing of that shape to check. See PHA-2722 for the state of
// those two systems.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonlFile } from './parser.js';
import { deriveGroundTruth } from './groundTruth.js';
import { scoreBoundaries } from './score.js';

import { extractAuditMessages } from '../auditorCore.js';
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
            stmbAutoSourceRef: entry.stmbAutoSourceRef,
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
        stmbAutoSourceRef: overrides.stmbAutoSourceRef,
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

    const prompt = buildOneShotPrompt({
        transcriptText,
        existingText: formatExistingEntries(existing),
        maxEntries: fullCfg.maxEntries,
        template: fullCfg.prompt || ONE_SHOT_PROMPT,
    });

    const parsed = await generateOneShotEntries({ generate, prompt, cfg: fullCfg });
    if (!parsed) {
        return { ok: false, message: 'the model returned no usable entry set', prompt };
    }

    const guarded = dropMemoryTitleCollisions(parsed.entries, existing);
    if (!guarded.entries.length) {
        return { ok: false, message: 'every generated entry collided with an existing scene memory', prompt, parsed, guarded };
    }

    const rewritten = new Set(guarded.entries.map((e) => e.title.trim().toLowerCase()));
    const claimedByExisting = collectClaimedKeywords(lorePool, rewritten);
    for (const k of collectClaimedKeywords(existing.filter((e) => e.isMemory))) claimedByExisting.add(k);

    const { entries, collisions } = enforceGlobalKeywordUniqueness(guarded.entries, claimedByExisting);
    const pinning = applyProvenancePinning(entries, existing);

    const writes = [];
    for (const entry of pinning.toWrite) {
        const { confidence, sourceRef } = attributeSources(entry.content, auditMessages);
        const overrides = {
            key: entry.key,
            keysecondary: entry.keysecondary,
            constant: entry.keywordless ? false : entry.constant,
            disable: false,
            stmbAutoContentHash: hashContent(entry.content),
            stmbAutoConfidence: confidence,
            stmbAutoSourceRef: sourceRef,
            stmbAutoVerifiedByHuman: false,
        };
        const res = upsertByTitle(book, entry.title, entry.content, overrides);
        writes.push({ title: entry.title, sourceRef, confidence, ...res });
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

    return { ok: true, prompt, parsed, guarded, entries, collisions, pinning, writes };
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

const SOURCE_REF_RE = /^(\d+)(?:-(\d+))?$/;

/**
 * Check 4: `stmbAutoSourceRef` parses, and every range is in-bounds for the
 * source transcript. An empty ref is not itself a failure — `attributeSources`
 * legitimately emits '' when no sentence matched strongly enough (a purely
 * inferred entry) — but anything non-empty must parse as "N" or "N-M" with
 * both ends inside [idMin, idMax].
 *
 * @param {{book:Array<object>, idMin:number, idMax:number}} p
 */
export function checkProvenanceInBounds({ book, idMin, idMax } = {}) {
    const offenders = [];
    for (const e of (book || [])) {
        if (e.disable) continue;
        const ref = e.stmbAutoSourceRef;
        if (ref == null || ref === '') continue;
        const m = SOURCE_REF_RE.exec(String(ref));
        if (!m) { offenders.push({ title: e.title, ref, reason: 'unparseable' }); continue; }
        const a = Number(m[1]);
        const b = m[2] != null ? Number(m[2]) : a;
        if (a > b || a < idMin || b > idMax) {
            offenders.push({ title: e.title, ref, reason: 'out-of-bounds', idMin, idMax });
        }
    }
    return { ok: offenders.length === 0, offenders, idMin, idMax };
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
 * means its `stmbAutoSourceRef` range ends at or before the PREVIOUS step's
 * slice boundary, i.e. no new message could have informed a rewrite.
 *
 * @param {{before:Array<{title:string, content:string, stmbAutoSourceRef:string}>,
 *          after:Array<{title:string, content:string}>, prevBoundary:number}} p
 */
export function checkDrift({ before, after, prevBoundary } = {}) {
    const beforeByTitle = new Map((before || []).map((e) => [e.title.trim().toLowerCase(), e]));
    const offenders = [];
    let checked = 0;
    for (const e of (after || [])) {
        const key = e.title.trim().toLowerCase();
        const prior = beforeByTitle.get(key);
        if (!prior) continue; // new entry this step — nothing to compare
        const m = SOURCE_REF_RE.exec(String(prior.stmbAutoSourceRef ?? ''));
        if (!m) continue; // no ref to reason about staleness from
        const end = m[2] != null ? Number(m[2]) : Number(m[1]);
        if (end > prevBoundary) continue; // source COULD have changed for this entry
        checked++;
        if (e.content !== prior.content) {
            offenders.push({ title: e.title, sourceRef: prior.stmbAutoSourceRef, prevBoundary });
        }
    }
    return { ok: offenders.length === 0, offenders, checked };
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
export async function replayNSlices({ book: initialBook = [], auditMessages, boundaries, generate, cfg = {}, onStep } = {}) {
    const book = initialBook.map((e) => ({ ...e }));
    const steps = [];
    let prevBoundary = 0;

    for (const boundary of boundaries) {
        const slice = (auditMessages || []).filter((m) => m.id < boundary);
        const transcriptText = formatTranscript(slice, cfg.truncate);

        const before = book.map((e) => ({ title: e.title, content: e.content, stmbAutoSourceRef: e.stmbAutoSourceRef }));
        const result = await runOneShotStep({ book, auditMessages: slice, transcriptText, generate, cfg });
        const after = book.map((e) => ({ title: e.title, content: e.content }));

        const tier1 = runTier1Checks({ book, messages: slice, idMin: 0, idMax: boundary - 1, cfg });
        const drift = checkDrift({ before, after, prevBoundary });

        const step = {
            boundary,
            messageCount: slice.length,
            totalEntries: book.length,
            regenerated: result.writes ? result.writes.length : 0,
            result,
            tier1,
            drift,
        };
        steps.push(step);
        prevBoundary = boundary;
        if (typeof onStep === 'function') onStep(step);
    }

    return { steps, book };
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
