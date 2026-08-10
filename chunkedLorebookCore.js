// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — ledgered chunked lorebook generation, pure core (PHA-1879).
//
// PHA-1871 fixed the case where the story fits: one call sees everything, so
// keyword assignment is globally consistent by construction. This file fixes the
// case where it does NOT fit, which is still the shape that caused the original
// bug — ceil(N/chunk) passes that are blind to each other, with
// `dedupeAgainstExistingEntries` filtering the symptom after the fact.
//
// The fix is a ledger carried THROUGH the passes:
//
//   1. Entity registry — every subject seen so far, its current content, and the
//      keywords it has already been awarded, rendered into the next pass's
//      prompt. Overlap is prevented at write time instead of string-filtered
//      afterwards. The award rule is `enforceGlobalKeywordUniqueness` from
//      oneShotLorebookCore.js — the SAME function the one-shot path uses, run
//      after every pass, so both paths resolve a contested keyword identically.
//   2. Unresolved-reference list — a pass that sees an effect without its cause
//      records the open question instead of guessing at the answer.
//   3. Reconciliation pass — closes the run with the full draft entry set plus
//      the ledger, re-reading ONLY the passes the unresolved list points at.
//      Its budget is reserved out of the context budget up front so it can never
//      be the pass that overflows.
//   4. Degradation is recorded, not hidden — the pass count and every entry
//      whose facts came from a cross-reference we could not close are written
//      into the lorebook, so the operator can raise context and re-run.
//
// Boundary rule (PHA-1878 decision 4): fewest passes, not fewest EQUAL passes.
// A pass closes early at a scene boundary once it is reasonably full, because
// every mid-scene cut manufactures exactly the dangling references the
// unresolved list then has to clean up.
//
// Pure functions, DI everywhere — no SillyTavern imports, testable under
// node:test. The runtime binding lives in chunkedLorebook.js, exactly like
// oneShotLorebookCore.js ↔ oneShotLorebook.js.

import { formatAuditMessage } from './auditorCore.js';
import { estimateTokens } from './contextBudget.js';
import {
    ONE_SHOT_DEFAULTS,
    containsWholeWord,
    enforceGlobalKeywordUniqueness,
    normalizeKeyword,
    parseOneShotEntries,
} from './oneShotLorebookCore.js';

// ---------------------------------------------------------------- defaults

export const CHUNKED_DEFAULTS = Object.freeze({
    // Per-message char cap for the transcript; 0 => full text.
    truncate: 0,
    // Hard cap on the entry set across the WHOLE run.
    maxEntries: 80,
    // Hard cap on how many entries one pass may emit or revise.
    maxEntriesPerPass: 30,
    // Entries shorter than this (trimmed) are dropped as non-answers.
    minContentChars: ONE_SHOT_DEFAULTS.minContentChars,
    order: ONE_SHOT_DEFAULTS.order,
    // Share of the single-call input budget handed to the ledger block. The
    // registry has to travel with every pass, so it gets a reservation rather
    // than whatever happens to be left over.
    ledgerFraction: 0.2,
    // Share of the single-call input budget reserved for the reconciliation
    // pass's re-read chunks. Reserved UP FRONT: reconciliation is the pass that
    // sees the most at once, so it is the one that must not be sized by accident.
    reconcileFraction: 0.4,
    // A pass may close at a scene boundary once it is this full. Below that,
    // closing early would only add passes.
    boundaryMinFill: 0.6,
    // Cap on carried open questions. An unbounded list eats the ledger budget
    // and starves the registry, which is the part that prevents collisions.
    maxUnresolved: 40,
});

// ---------------------------------------------------------------- budgeting

/**
 * The text of an extracted message. `extractAuditMessages` emits `rawText`;
 * tests and other callers sometimes carry a plain `text`. Read both rather than
 * silently costing every message 1 token and planning one giant pass.
 */
export function messageText(m) {
    return String(m?.rawText ?? m?.text ?? '');
}

const toPositiveInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Split the single-call input budget into the three things a ledgered run has to
 * fit: the story slice each pass reads, the ledger that travels with it, and the
 * reconciliation pass's re-reads.
 *
 * `passInputTokens` is deliberately what remains AFTER the ledger reservation —
 * a pass that fills the whole window with story text has nowhere to put the
 * registry, which is the only thing making the pass non-blind.
 *
 * @param {object} budget - result of contextBudget.planContextBudget
 * @param {object} [policy] - overrides for CHUNKED_DEFAULTS
 * @returns {{inputTokens:number, passInputTokens:number, ledgerTokens:number,
 *            reconcileTokens:number, outputTokens:number}}
 */
export function planChunkedBudget(budget, policy = {}) {
    const cfg = { ...CHUNKED_DEFAULTS, ...policy };
    const inputTokens = toPositiveInt(budget?.inputTokens) || 1000;
    const ledgerTokens = Math.max(200, Math.floor(inputTokens * cfg.ledgerFraction));
    const passInputTokens = Math.max(500, inputTokens - ledgerTokens);
    const reconcileTokens = Math.max(500, Math.floor(inputTokens * cfg.reconcileFraction));
    return {
        inputTokens,
        passInputTokens,
        ledgerTokens,
        reconcileTokens,
        outputTokens: toPositiveInt(budget?.outputTokens) || 8000,
    };
}

// ---------------------------------------------------------------- scene boundaries

/**
 * Does this message begin a new scene?
 *
 * Deliberately conservative and text-only: a false positive costs at most one
 * extra pass, a false negative costs the coherence of one cut. Recognized:
 * markdown headings, horizontal rules and `* * *` dinkuses, explicit
 * chapter/scene/part/epilogue headers, and bracketed time-skip stage directions
 * ("[Later that evening]", "*Three days later*").
 */
export function isSceneBoundaryText(text) {
    const s = String(text ?? '').trim();
    if (!s) return false;
    const head = s.split('\n', 1)[0].trim();
    if (/^#{1,6}\s+\S/.test(head)) return true;
    if (/^(?:-{3,}|_{3,}|\*{3,}|(?:\*\s){2,}\*)$/.test(head)) return true;
    if (/^[*_~\s"'([]*(?:chapter|scene|part|act|epilogue|prologue|interlude)\b/i.test(head)) return true;
    if (/^[[(*_]+\s*(?:(?:some|several|a few|three|two|the next|later|meanwhile|elsewhere|that (?:night|evening|morning))\b|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+later)/i.test(head)) return true;
    return false;
}

/**
 * Indices in `messages` that start a scene, per `detector`.
 * Index 0 is never reported — a pass starting at the first message is not a cut.
 * @param {Array<{text:string}>} messages
 * @param {function} [detector]
 * @returns {Set<number>}
 */
export function detectSceneBoundaries(messages, detector = isSceneBoundaryText) {
    const list = Array.isArray(messages) ? messages : [];
    const out = new Set();
    for (let i = 1; i < list.length; i++) {
        if (detector(messageText(list[i]))) out.add(i);
    }
    return out;
}

/**
 * Slice the story into the fewest passes that fit, cutting at scene boundaries
 * wherever a boundary is available inside the acceptable fill range.
 *
 * PHA-1878 decision 4: fewest passes, not fewest EQUAL passes. Passes come out
 * uneven on purpose. `cutMidScene` records the cuts we could not make cleanly —
 * those are exactly where dangling references get manufactured, and the
 * unresolved list is what cleans them up.
 *
 * @param {Array<{id:number, text:string}>} messages
 * @param {number} tokensPerPass
 * @param {object} [opts] boundaries?: Set<number>, minFill?: number, estimator?: fn
 * @returns {Array<{index:number, start:number, end:number, tokens:number, cutMidScene:boolean}>}
 */
export function planLedgerPasses(messages, tokensPerPass, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) return [];
    const cap = toPositiveInt(tokensPerPass) || 4000;
    const estimator = typeof opts.estimator === 'function' ? opts.estimator : estimateTokens;
    const boundaries = opts.boundaries instanceof Set ? opts.boundaries : detectSceneBoundaries(list);
    const minFill = Number.isFinite(Number(opts.minFill))
        ? Number(opts.minFill)
        : CHUNKED_DEFAULTS.boundaryMinFill;
    const fillFloor = cap * Math.min(0.95, Math.max(0, minFill));

    const passes = [];
    let current = null;
    const close = (cutMidScene) => {
        current.cutMidScene = cutMidScene;
        current.index = passes.length;
        passes.push(current);
        current = null;
    };

    for (let i = 0; i < list.length; i++) {
        const cost = Math.max(1, toPositiveInt(estimator(messageText(list[i]))) || 1);
        if (current) {
            if (current.tokens + cost > cap) {
                // Forced cut. It lands on a boundary only by luck.
                close(!boundaries.has(i));
            } else if (boundaries.has(i) && current.tokens >= fillFloor) {
                // Clean cut: full enough that closing here does not add a pass.
                close(false);
            }
        }
        if (!current) {
            current = { start: i, end: i, tokens: cost, cutMidScene: false };
        } else {
            current.end = i;
            current.tokens += cost;
        }
    }
    if (current) close(false);   // the run ends here; nothing dangles past it
    return passes;
}

// ---------------------------------------------------------------- the ledger

/** A fresh, empty ledger. Plain data — serializable, comparable, loggable. */
export function createLedger() {
    return { entities: [], unresolved: [], passes: [], collisions: [] };
}

const titleKey = (t) => String(t ?? '').trim().toLowerCase();

/**
 * Rebuild the entity registry from the current (post-award) draft entry set.
 *
 * The registry is derived, never accumulated: it always reports the keywords an
 * entity ACTUALLY holds after `enforceGlobalKeywordUniqueness` has run, not the
 * ones a pass asked for. Showing a pass a keyword that was later taken away
 * would be worse than showing it nothing.
 */
export function buildEntityRegistry(draftEntries) {
    return (Array.isArray(draftEntries) ? draftEntries : []).map(e => ({
        name: String(e?.title ?? '').trim(),
        kind: String(e?.kind ?? 'concept'),
        keywords: (Array.isArray(e?.key) ? e.key : []).map(k => String(k)),
        content: String(e?.content ?? ''),
        sourcePasses: Array.isArray(e?.sourcePasses) ? [...e.sourcePasses] : [],
    })).filter(e => e.name);
}

/**
 * Merge a pass's entries into the running draft, keyed by title.
 *
 * A pass is shown the current content of every entity it might touch, so an
 * entry it re-emits is a REWRITE, not an addendum: replace the content, union
 * the keywords (the award rule re-runs immediately afterwards and will take back
 * anything contested), and remember which passes contributed.
 *
 * @returns {{entries:Array<object>, created:number, updated:number, overflow:number}}
 */
export function mergeDraftEntries(draft, incoming, passIndex, maxEntries = CHUNKED_DEFAULTS.maxEntries) {
    const out = (Array.isArray(draft) ? draft : []).map(e => ({ ...e }));
    const byTitle = new Map(out.map((e, i) => [titleKey(e.title), i]));
    let created = 0;
    let updated = 0;
    let overflow = 0;

    for (const item of (Array.isArray(incoming) ? incoming : [])) {
        const key = titleKey(item?.title);
        if (!key) continue;
        const at = byTitle.get(key);
        if (at == null) {
            if (out.length >= maxEntries) { overflow++; continue; }
            byTitle.set(key, out.length);
            out.push({ ...item, sourcePasses: [passIndex] });
            created++;
            continue;
        }
        const prev = out[at];
        const passes = Array.isArray(prev.sourcePasses) ? [...prev.sourcePasses] : [];
        if (!passes.includes(passIndex)) passes.push(passIndex);
        out[at] = {
            ...prev,
            ...item,
            // Union rather than replace: a keyword this pass forgot to restate
            // is still legitimately held by the entity.
            key: Array.from(new Set([...(prev.key || []), ...(item.key || [])])),
            keysecondary: Array.from(new Set([...(prev.keysecondary || []), ...(item.keysecondary || [])])),
            sourcePasses: passes,
        };
        updated++;
    }
    return { entries: out, created, updated, overflow };
}

/** Normalize one model-emitted open question into a ledger item. */
function normalizeUnresolved(item, passIndex) {
    const question = String(item?.question ?? item?.q ?? '').trim();
    if (!question) return null;
    const ids = (Array.isArray(item?.messageIds) ? item.messageIds : [])
        .map(n => Number(n))
        .filter(n => Number.isFinite(n));
    return {
        question,
        about: String(item?.about ?? item?.entry ?? item?.subject ?? '').trim(),
        messageIds: Array.from(new Set(ids)),
        raisedInPass: passIndex,
        resolved: false,
    };
}

/**
 * Fold one pass's output into the ledger.
 *
 * The award rule runs HERE, once per pass, over the whole accumulated draft —
 * that is what makes pass N+1's registry truthful and what makes this path and
 * the one-shot path resolve a contested keyword the same way.
 *
 * @param {object} args
 * @param {object} args.ledger
 * @param {Array<object>} args.draft            entries accumulated so far
 * @param {Array<object>} args.entries          this pass's parsed entries
 * @param {Array<object>} [args.unresolved]     this pass's open questions
 * @param {object} args.pass                    the plan entry {index,start,end,cutMidScene}
 * @param {Set<string>} [args.claimedByExisting] keywords owned by the book
 * @param {number} [args.maxEntries]
 * @returns {{ledger:object, draft:Array<object>, created:number, updated:number, overflow:number}}
 */
export function recordPass({
    ledger,
    draft = [],
    entries = [],
    unresolved = [],
    pass,
    claimedByExisting = new Set(),
    maxEntries = CHUNKED_DEFAULTS.maxEntries,
    maxUnresolved = CHUNKED_DEFAULTS.maxUnresolved,
} = {}) {
    const base = ledger || createLedger();
    const passIndex = Number(pass?.index) || 0;

    const merged = mergeDraftEntries(draft, entries, passIndex, maxEntries);
    const awarded = enforceGlobalKeywordUniqueness(merged.entries, claimedByExisting);

    const open = [...base.unresolved];
    for (const raw of (Array.isArray(unresolved) ? unresolved : [])) {
        const item = normalizeUnresolved(raw, passIndex);
        if (!item) continue;
        if (open.some(o => o.question.toLowerCase() === item.question.toLowerCase())) continue;
        if (open.length >= maxUnresolved) break;
        open.push(item);
    }

    const next = {
        entities: buildEntityRegistry(awarded.entries),
        unresolved: open,
        passes: [...base.passes, {
            index: passIndex,
            start: Number(pass?.start) || 0,
            end: Number(pass?.end) || 0,
            tokens: Number(pass?.tokens) || 0,
            cutMidScene: pass?.cutMidScene === true,
            entriesSeen: merged.created + merged.updated,
        }],
        // Collisions are cumulative evidence for the run summary; the awarded
        // set itself is already clean.
        collisions: [...base.collisions, ...awarded.collisions],
    };

    return {
        ledger: next,
        draft: awarded.entries,
        created: merged.created,
        updated: merged.updated,
        overflow: merged.overflow,
    };
}

// ---------------------------------------------------------------- ledger rendering

const truncateAt = (s, n) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`);

/**
 * Render the ledger for the next pass's prompt, fitted to `ledgerTokens`.
 *
 * Degrades in defined steps rather than being cut off mid-line: full content →
 * 240-char excerpts → names and keywords only. `truncated` says which step we
 * had to take, and the caller logs it — a silently shortened registry looks
 * exactly like a registry that had nothing to say.
 *
 * @returns {{text:string, truncated:false|'excerpt'|'keywords-only', tokens:number}}
 */
export function formatLedger(ledger, ledgerTokens = 0, estimator = estimateTokens) {
    const entities = Array.isArray(ledger?.entities) ? ledger.entities : [];
    const unresolved = (Array.isArray(ledger?.unresolved) ? ledger.unresolved : []).filter(u => !u.resolved);
    const cap = toPositiveInt(ledgerTokens);

    const questions = unresolved.length
        ? unresolved.map(u => `- ${u.question}${u.about ? ` (about: ${u.about})` : ''}`).join('\n')
        : '(none)';

    const render = (mode) => {
        if (!entities.length) return '(nothing established yet — this is the first pass)';
        return entities.map((e) => {
            const keys = e.keywords.length ? e.keywords.join(', ') : '(none — do not give it one that is taken)';
            const head = `- ${e.name} [${e.kind}] — keywords ALREADY AWARDED: ${keys}`;
            if (mode === 'keywords-only') return head;
            const body = mode === 'excerpt' ? truncateAt(e.content, 240) : e.content;
            return body ? `${head}\n  current entry: ${body}` : head;
        }).join('\n');
    };

    const assemble = (body) => `ENTITIES ALREADY IN THE DRAFT (the registry):\n${body}\n\nOPEN QUESTIONS still unanswered:\n${questions}`;

    for (const mode of ['full', 'excerpt', 'keywords-only']) {
        const text = assemble(render(mode));
        const tokens = estimator(text);
        if (!cap || tokens <= cap || mode === 'keywords-only') {
            return { text, truncated: mode === 'full' ? false : mode, tokens };
        }
    }
    /* c8 ignore next */
    return { text: assemble(render('keywords-only')), truncated: 'keywords-only', tokens: 0 };
}

/**
 * Render the draft entry set for the reconciliation prompt, fitted to `capTokens`.
 *
 * Same defined degradation as formatLedger — full content → 240-char excerpts →
 * titles and keywords only — because this render is charged against the
 * reconciliation budget as overhead. Uncapped, 60 drafted entries can consume
 * the entire budget on a small window and starve reconciliation completely
 * (PHA-1886 §2).
 *
 * @returns {{text:string, truncated:false|'excerpt'|'titles-only', tokens:number}}
 */
export function formatDraftEntries(entries, capTokens = 0, estimator = estimateTokens) {
    const list = Array.isArray(entries) ? entries : [];
    const cap = toPositiveInt(capTokens);

    const render = (mode) => {
        if (!list.length) return '(no entries were drafted)';
        return list.map((e) => {
            const keys = (Array.isArray(e.key) ? e.key : []).join(', ') || '(none)';
            const head = `- ${e.title} [${e.kind}] keywords: ${keys}`;
            if (mode === 'titles-only') return head;
            const flat = String(e.content ?? '').replace(/\n+/g, ' ');
            const body = mode === 'excerpt' ? truncateAt(flat, 240) : flat;
            return body ? `${head}\n  ${body}` : head;
        }).join('\n');
    };

    for (const mode of ['full', 'excerpt', 'titles-only']) {
        const text = render(mode);
        const tokens = estimator(text);
        if (!cap || tokens <= cap || mode === 'titles-only') {
            return { text, truncated: mode === 'full' ? false : mode, tokens };
        }
    }
    /* c8 ignore next */
    return { text: render('titles-only'), truncated: 'titles-only', tokens: 0 };
}

/** Render the extracted messages as the transcript block for one pass. */
export function formatPassTranscript(messages, pass, truncate = CHUNKED_DEFAULTS.truncate) {
    const list = Array.isArray(messages) ? messages : [];
    const start = Math.max(0, Number(pass?.start) || 0);
    const end = Math.min(list.length - 1, Number(pass?.end ?? list.length - 1));
    const out = [];
    for (let i = start; i <= end; i++) out.push(formatAuditMessage(list[i], truncate));
    return out.join('\n');
}

// ---------------------------------------------------------------- prompts

/**
 * The per-pass prompt.
 *
 * Two things separate this from the one-shot prompt, and they are the whole
 * point of PHA-1879: the registry of keywords ALREADY AWARDED (so overlap is
 * prevented at write time), and the standing instruction to record an open
 * question rather than guess at a cause this slice does not contain.
 */
export const CHUNK_PASS_PROMPT =
`You are building a SillyTavern World Info lorebook for a story that is TOO LONG
to read in one call. You are reading pass {{PASS_NUMBER}} of {{PASS_TOTAL}}.
Earlier passes have already drafted entries; you can see their registry below.
A reconciliation pass runs at the end and can re-read earlier slices, so you do
NOT have to guess at anything you cannot see.

WHAT A GOOD ENTRY LOOKS LIKE
- "title": the entry memo. Use the subject's canonical name. Reuse a registry
  name EXACTLY to revise that entry; a new name creates a new entry.
- "content": the text inserted into the prompt when the entry fires. Keywords and
  the title are NOT inserted, so it must be COMPLETELY SELF-CONTAINED: name the
  subject in the first sentence, never "he" or "as mentioned". 3-8 sentences,
  present tense for standing facts. When you revise a registry entry, write its
  FULL new content — it REPLACES the old text, it is not appended to it. Keep
  everything from the old content that is still true. Ground every claim in the
  transcript below; do NOT invent anything.
- "key": primary trigger keywords, an array of strings, typically 2-5. Matching
  is case-insensitive and by whole word. Keys MUST NOT contain commas.
- "keysecondary": optional FILTER on top of "key". [] unless genuinely ambiguous.
- "selectiveLogic": 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL. Use 0 when
  keysecondary is empty.
- "constant": true = always inserted. At most 1-2 entries in the whole book.
- "order": LOWER inserts earlier. 100 ordinary, 200 dominant, 50 background.
- "position": 0 before the character definition, 1 after it. Use 1 for main
  characters and the current situation, 0 for background world lore.
- "scanDepth": recent messages scanned for this entry's keys. 2-4 normally.
- "preventRecursion": always true here.
- "kind": one of "character", "location", "faction", "item", "event", "concept".

KEYWORD RULES — THE REGISTRY IS BINDING
1. Every keyword listed as ALREADY AWARDED in the registry, and every keyword
   listed under the EXISTING LOREBOOK, is TAKEN. Do not claim it for a different
   entry. You may restate an entry's OWN awarded keywords when you revise it.
2. A keyword must identify exactly ONE subject in the whole book. When two
   subjects could claim the same word (a shared surname, a place named after a
   person), take it for the one it most specifically identifies and give the
   other a disambiguated form.
3. Never use a generic common word ("the king", "home", "sword") as a key.

WHEN YOU CANNOT SEE THE CAUSE
This slice starts in the middle of the story. If it shows you an EFFECT whose
cause is not in this slice — a character reacting to something you never saw, a
name used as if already introduced, a consequence with no event behind it — DO
NOT GUESS and do not write the guess into an entry. Record it in "unresolved"
instead, with the message ids that raised it. Write only what this slice
actually establishes.

Produce AT MOST {{MAX_ENTRIES}} entries in this pass: new subjects this slice
establishes, plus revisions to registry entries this slice adds real information
to. Do not restate a registry entry you have nothing to add to.

Reply with ONLY a JSON object of exactly this shape — no prose, no code fences:
{"entries":[{"title":"","kind":"","key":[],"keysecondary":[],"selectiveLogic":0,"constant":false,"order":100,"position":1,"scanDepth":3,"preventRecursion":true,"content":""}],"unresolved":[{"question":"","about":"","messageIds":[]}]}

EXISTING LOREBOOK (titles and the keywords they already claim):
{{EXISTING}}

{{LEDGER}}

STORY SLICE, pass {{PASS_NUMBER}} of {{PASS_TOTAL}} (messages numbered "[id] Speaker: text"):
{{TRANSCRIPT}}`;

/**
 * The reconciliation prompt.
 *
 * It sees the whole draft entry set and the ledger, plus ONLY the slices the
 * open questions point at. Its job is to close those questions and correct the
 * entries they touch — not to rewrite the book from memory it does not have.
 */
export const RECONCILE_PROMPT =
`You are closing out a SillyTavern World Info lorebook that was written in
{{PASS_TOTAL}} separate passes over a story too long to read at once. Each pass
could only see its own slice. Some passes saw an effect without its cause and
recorded an OPEN QUESTION instead of guessing.

Below you have: the complete draft entry set, the open questions, and the
ORIGINAL TEXT of only the slices those questions point at.

Your job, in this order:
1. Answer each open question from the re-read slices. If the text genuinely does
   not answer it, say so — mark it "resolved": false. Do not invent an answer.
2. Re-emit ONLY the entries that need to change because of what you just
   resolved, or because two entries contradict each other, or because an entry
   states something no pass could actually support. Write each one's FULL new
   content; it replaces the old entry entirely. Leave everything else alone —
   an entry you do not re-emit is kept exactly as drafted.
3. Never claim a keyword that another entry already holds in the draft, or that
   the existing lorebook holds. Keys must not contain commas.

Reply with ONLY a JSON object of exactly this shape — no prose, no code fences:
{"resolved":[{"question":"","answer":"","resolved":true}],"entries":[{"title":"","kind":"","key":[],"keysecondary":[],"selectiveLogic":0,"constant":false,"order":100,"position":1,"scanDepth":3,"preventRecursion":true,"content":""}]}

EXISTING LOREBOOK (titles and the keywords they already claim):
{{EXISTING}}

DRAFT ENTRY SET:
{{DRAFT}}

OPEN QUESTIONS:
{{QUESTIONS}}

RE-READ SOURCE TEXT (only the slices the questions point at):
{{TRANSCRIPT}}`;

/** Reprimand appended on the single retry when a reply is unusable. */
export const CHUNKED_JSON_ONLY_REPRIMAND =
    'Reply with ONLY the JSON object described in the instructions. No prose, no code fences.';

const fill = (template, replacements) =>
    String(template ?? '').replace(
        /\{\{([A-Z_]+)\}\}/g,
        (m, token) => (token in replacements ? String(replacements[token] ?? '') : m),
    );

/** Fill the per-pass prompt template. */
export function buildPassPrompt({
    transcriptText, existingText, ledgerText, passNumber, passTotal, maxEntries, template,
} = {}) {
    return fill(template || CHUNK_PASS_PROMPT, {
        TRANSCRIPT: transcriptText ?? '',
        EXISTING: String(existingText ?? '').trim() || '(empty — this is a brand new lorebook)',
        LEDGER: String(ledgerText ?? '').trim() || 'ENTITIES ALREADY IN THE DRAFT (the registry):\n(nothing established yet — this is the first pass)',
        PASS_NUMBER: Number(passNumber) || 1,
        PASS_TOTAL: Number(passTotal) || 1,
        MAX_ENTRIES: Number(maxEntries) || CHUNKED_DEFAULTS.maxEntriesPerPass,
    });
}

/** Fill the reconciliation prompt template. */
export function buildReconcilePrompt({
    transcriptText, existingText, draftText, questionsText, passTotal, template,
} = {}) {
    return fill(template || RECONCILE_PROMPT, {
        TRANSCRIPT: String(transcriptText ?? '').trim() || '(no source text could be re-read within the reconciliation budget)',
        EXISTING: String(existingText ?? '').trim() || '(empty — this is a brand new lorebook)',
        DRAFT: draftText ?? '',
        QUESTIONS: String(questionsText ?? '').trim() || '(none)',
        PASS_TOTAL: Number(passTotal) || 1,
    });
}

// ---------------------------------------------------------------- parsing

/**
 * Parse one pass's reply: the entry set (same sanitizer as the one-shot path,
 * so both paths clamp fields identically) plus the open questions.
 * @returns {{entries:Array<object>, unresolved:Array<object>, dropped:number}|null}
 */
export function parsePassReply(reply, cfg = {}) {
    const parsed = parseOneShotEntries(reply, {
        maxEntries: cfg.maxEntriesPerPass ?? CHUNKED_DEFAULTS.maxEntriesPerPass,
        minContentChars: cfg.minContentChars ?? CHUNKED_DEFAULTS.minContentChars,
    });
    // A pass that establishes nothing new but DOES raise a question is a valid,
    // useful pass — so the questions are read even when the entry set is empty.
    const unresolved = extractUnresolved(reply);
    if (!parsed) {
        if (!unresolved.length) return null;
        return { entries: [], unresolved, dropped: 0 };
    }
    return { entries: parsed.entries, unresolved, dropped: parsed.dropped };
}

function looseJson(reply) {
    if (typeof reply !== 'string') return null;
    let s = reply.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch { /* carve it out of surrounding prose */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function extractUnresolved(reply) {
    const parsed = looseJson(reply);
    const raw = Array.isArray(parsed?.unresolved) ? parsed.unresolved : [];
    const out = [];
    for (const item of raw) {
        const norm = normalizeUnresolved(item, 0);
        if (norm) out.push(norm);
    }
    return out;
}

/**
 * Parse the reconciliation reply.
 * @returns {{entries:Array<object>, resolved:Array<{question:string, answer:string, resolved:boolean}>}|null}
 */
export function parseReconcileReply(reply, cfg = {}) {
    const parsed = looseJson(reply);
    if (!parsed || typeof parsed !== 'object') return null;
    const entriesResult = Array.isArray(parsed.entries) && parsed.entries.length
        ? parseOneShotEntries(JSON.stringify({ entries: parsed.entries }), {
            maxEntries: cfg.maxEntries ?? CHUNKED_DEFAULTS.maxEntries,
            minContentChars: cfg.minContentChars ?? CHUNKED_DEFAULTS.minContentChars,
        })
        : null;
    const resolved = (Array.isArray(parsed.resolved) ? parsed.resolved : []).map(r => ({
        question: String(r?.question ?? '').trim(),
        answer: String(r?.answer ?? '').trim(),
        // Default false: "the model did not say" must not read as "answered".
        resolved: r?.resolved === true && String(r?.answer ?? '').trim().length > 0,
    })).filter(r => r.question);
    if (!entriesResult && !resolved.length) return null;
    return { entries: entriesResult?.entries ?? [], resolved };
}

// ---------------------------------------------------------------- reconciliation

/**
 * Choose which passes the reconciliation call re-reads.
 *
 * Passes are scored by how many open questions point at them and taken
 * highest-value first until `reconcileTokens` is spent. A question whose passes
 * did not all make the cut stays open and its entries get marked degraded —
 * `dropped` carries those out so the caller can log them. A budget that quietly
 * truncated here would read as "everything was reconciled".
 *
 * @param {object} ledger
 * @param {object} opts reconcileTokens, plus overheadTokens already committed
 * @returns {{passIndices:number[], items:Array<object>, dropped:Array<object>, tokens:number}}
 */
export function planReconciliation(ledger, { reconcileTokens = 0, overheadTokens = 0, messages = null } = {}) {
    const passes = Array.isArray(ledger?.passes) ? ledger.passes : [];
    const open = (Array.isArray(ledger?.unresolved) ? ledger.unresolved : []).filter(u => !u.resolved);
    if (!open.length || !passes.length) {
        return { passIndices: [], items: [], dropped: [], tokens: 0 };
    }

    const byIndex = new Map(passes.map(p => [p.index, p]));
    // `p.start`/`p.end` are indices into the extracted-message list, but the
    // model quotes the chat id printed by formatAuditMessage. Those diverge as
    // soon as extraction skips a system or blank message, so map back first.
    const indexById = new Map();
    if (Array.isArray(messages)) {
        messages.forEach((m, i) => {
            if (m?.id != null && !indexById.has(m.id)) indexById.set(m.id, i);
        });
    }
    const passForMessage = (id) => {
        const idx = indexById.size ? indexById.get(id) : id;
        if (idx == null) return undefined;
        return passes.find(p => idx >= p.start && idx <= p.end)?.index;
    };

    // Which passes does each question need? Explicit message ids first; failing
    // that, the pass that raised it and the pass that first established the
    // subject it is about.
    const needsByItem = open.map((item) => {
        const need = new Set();
        for (const id of item.messageIds) {
            const idx = passForMessage(id);
            if (idx != null) need.add(idx);
        }
        if (!need.size) {
            if (byIndex.has(item.raisedInPass)) need.add(item.raisedInPass);
            // The cause of an unexplained effect is behind us, so the pass
            // before the one that noticed it is the best cheap guess.
            if (byIndex.has(item.raisedInPass - 1)) need.add(item.raisedInPass - 1);
        }
        return { item, need };
    });

    const demand = new Map();
    for (const { need } of needsByItem) {
        for (const idx of need) demand.set(idx, (demand.get(idx) || 0) + 1);
    }

    const budget = Math.max(0, toPositiveInt(reconcileTokens) - toPositiveInt(overheadTokens));
    const ranked = [...demand.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];                                   // most-wanted first
        return (byIndex.get(a[0])?.tokens || 0) - (byIndex.get(b[0])?.tokens || 0); // then cheapest
    });

    const chosen = new Set();
    let spent = 0;
    for (const [idx] of ranked) {
        const cost = byIndex.get(idx)?.tokens || 0;
        if (spent + cost > budget) continue;
        chosen.add(idx);
        spent += cost;
    }

    const items = [];
    const dropped = [];
    for (const { item, need } of needsByItem) {
        if (need.size && [...need].every(idx => chosen.has(idx))) items.push(item);
        else dropped.push(item);
    }

    return {
        passIndices: [...chosen].sort((a, b) => a - b),
        items,
        dropped,
        tokens: spent,
    };
}

/** Render the open questions the reconciliation call is actually being asked. */
export function formatQuestions(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '(none)';
    return list.map((u, i) => {
        const about = u.about ? ` [about: ${u.about}]` : '';
        const ids = u.messageIds?.length ? ` [raised by messages ${u.messageIds.join(', ')}]` : '';
        return `${i + 1}. ${u.question}${about}${ids}`;
    }).join('\n');
}

/**
 * Apply the reconciliation reply to the draft.
 *
 * Entries it re-emitted replace their drafted namesakes; entries it did not
 * mention are kept exactly as drafted. Questions it answered are closed; the
 * rest stay open and feed the degradation marking.
 *
 * @returns {{entries:Array<object>, unresolved:Array<object>, revised:number, closed:number}}
 */
export function applyReconciliation({ draft = [], ledger, result, askedItems = [] } = {}) {
    const merged = mergeDraftEntries(draft, result?.entries ?? [], -1, Number.MAX_SAFE_INTEGER);
    // A question is closed only when the reply BOTH says so and supplies an
    // answer. "resolved: true, answer: ''" is a guess with the guess left out.
    const answered = new Set(
        (result?.resolved ?? [])
            .filter(r => r?.resolved === true && String(r?.answer ?? '').trim())
            .map(r => String(r.question ?? '').toLowerCase()),
    );
    // Only questions we actually asked can be closed — a reply that "resolves" a
    // question we never sent it is answering from thin air.
    const asked = new Set((askedItems || []).map(i => i.question.toLowerCase()));

    let closed = 0;
    const unresolved = (Array.isArray(ledger?.unresolved) ? ledger.unresolved : []).map((u) => {
        const q = u.question.toLowerCase();
        if (!u.resolved && asked.has(q) && answered.has(q)) {
            closed++;
            const hit = (result?.resolved ?? []).find(r => r.question.toLowerCase() === q);
            return { ...u, resolved: true, answer: hit?.answer ?? '' };
        }
        return { ...u };
    });

    return {
        entries: merged.entries,
        unresolved,
        revised: merged.updated + merged.created,
        closed,
    };
}

// ---------------------------------------------------------------- degradation

/**
 * Mark the output honestly.
 *
 * Every entry records how many passes the run took. Entries touched by a
 * cross-reference we could not close are additionally flagged with the question
 * that stayed open, so an operator reading the lorebook can see which facts to
 * distrust and re-run with a larger context window. The flags are entry
 * properties, not content text — they persist in the lorebook file without
 * costing prompt budget every time the entry fires.
 *
 * An entry matches an open question when the question names it (`about`) or
 * names it inside the question text.
 *
 * @returns {{entries:Array<object>, degraded:number}}
 */
export function markDegradedEntries(entries, unresolved = [], passCount = 0) {
    const open = (Array.isArray(unresolved) ? unresolved : []).filter(u => !u.resolved);
    let degraded = 0;

    const out = (Array.isArray(entries) ? entries : []).map((e) => {
        const name = normalizeKeyword(e.title);
        const hits = open.filter((u) => {
            if (!name) return false;
            if (normalizeKeyword(u.about) === name) return true;
            // Whole-word, not substring: "Ash" must not be flagged degraded by a
            // question about "ashes" (PHA-1886 §6).
            return containsWholeWord(normalizeKeyword(u.question), name);
        });
        const next = { ...e, stmbAutoPasses: passCount };
        if (hits.length) {
            degraded++;
            next.stmbAutoDegraded = true;
            next.stmbAutoDegradedReason = hits.map(h => h.question).slice(0, 3).join(' | ');
        }
        return next;
    });

    return { entries: out, degraded };
}

// ---------------------------------------------------------------- the calls

/**
 * One generation round: a single `generate` call, then a single "JSON only"
 * retry when the first reply is unusable. Mirrors generateOneShotEntries.
 */
export async function generateWithRetry({ generate, prompt, parse }) {
    let reply = await generate(prompt);
    let parsed = parse(reply);
    if (parsed === null) {
        reply = await generate(`${prompt}\n\n${CHUNKED_JSON_ONLY_REPRIMAND}`);
        parsed = parse(reply);
    }
    return parsed;
}

/** Human-readable summary of a chunked run, for the toast and the job detail. */
export function summarizeChunked({
    passes = 0,
    created = 0,
    updated = 0,
    dropped = 0,
    collisions = [],
    keywordless = 0,
    unresolved = 0,
    closed = 0,
    degraded = 0,
    reconciled = false,
    overflow = 0,
    midSceneCuts = 0,
} = {}) {
    const parts = [`chunked lorebook (${passes} pass${passes === 1 ? '' : 'es'}): ${created} created, ${updated} updated`];
    if (dropped) parts.push(`${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} dropped`);
    if (overflow) parts.push(`${overflow} entr${overflow === 1 ? 'y' : 'ies'} over the cap were not written`);
    if (collisions.length) parts.push(`${collisions.length} keyword collision${collisions.length === 1 ? '' : 's'} resolved`);
    if (keywordless) parts.push(`${keywordless} entr${keywordless === 1 ? 'y' : 'ies'} left without a free keyword`);
    if (midSceneCuts) parts.push(`${midSceneCuts} pass${midSceneCuts === 1 ? '' : 'es'} had to cut mid-scene`);
    if (reconciled) parts.push(`reconciliation closed ${closed}/${closed + unresolved} open question${closed + unresolved === 1 ? '' : 's'}`);
    else if (unresolved) parts.push(`${unresolved} open question${unresolved === 1 ? '' : 's'} left unreconciled`);
    if (degraded) parts.push(`${degraded} entr${degraded === 1 ? 'y is' : 'ies are'} flagged degraded — raise the context window and re-run for a clean pass`);
    return parts.join(' · ');
}
