// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — one-shot whole-story lorebook generation, pure core (PHA-1871).
//
// The payoff of PHA-1862 and the structural fix for cross-entry keyword overlap.
//
// The chunked path is ceil(N/chunk) audit calls + up to `bulkGenerateCap`
// per-entity derivation calls, none of which share state. No call ever sees the
// whole entry set, so consistent keyword assignment is structurally impossible;
// addlore.js `dedupeAgainstExistingEntries` only filters the symptom afterwards.
//
// When contextBudget.fitsInOneCall() says the whole transcript fits, we skip the
// walk and the coverage loop entirely and make ONE call that emits the COMPLETE
// entry set together. Keywords are then globally assignable — and because "the
// model was told to" is not a guarantee, `enforceGlobalKeywordUniqueness` makes
// it one deterministically, over the emitted set AND the existing book.
//
// Pure functions, DI everywhere — no SillyTavern imports, testable under
// node:test. The runtime binding lives in oneShotLorebook.js, exactly like
// auditorCore.js ↔ auditor.js.

import { formatAuditMessage } from './auditorCore.js';
import { WORLD_INFO_PRIMER } from './worldInfoPrimer.js';
import { ERROR_CONTROL_RULES } from './injectionCore.js';

// ---------------------------------------------------------------- defaults

export const ONE_SHOT_DEFAULTS = Object.freeze({
    // Per-message char cap for the transcript; 0 => full text. The whole point
    // of this path is that the model reads everything, so 0 is the default.
    truncate: 0,
    // Hard cap on how many entries one call may produce. A run that asks for
    // 400 entries will truncate its own JSON mid-object long before it finishes.
    maxEntries: 60,
    // Entries shorter than this (trimmed) are dropped as non-answers.
    minContentChars: 40,
    // Default insertion order for generated entries (see ST "Insertion Order":
    // LOWER numbers are inserted EARLIER in context, higher numbers land closer
    // to the end and carry more weight).
    order: 100,
});

/**
 * SillyTavern `selectiveLogic` values, from ST's `world_info_logic`.
 * Named here so the prompt and the sanitizer agree on the encoding.
 */
export const SELECTIVE_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

/** SillyTavern `position` values used by this path (before/after char defs, @D). */
export const INSERTION_POSITION = Object.freeze({
    BEFORE_CHAR: 0,
    AFTER_CHAR: 1,
    AT_DEPTH: 4,
});

// ---------------------------------------------------------------- prompt

/**
 * The whole-story prompt.
 *
 * PHA-1862's original complaint had two halves. The one-shot path (PHA-1871)
 * fixed the first — writers could finally see each other. This prompt fixes
 * the second: WORLD_INFO_PRIMER (PHA-1915) tells the model what World Info
 * actually is and what makes a keyword good, ahead of anything else, so it is
 * the ideal cache prefix. The model emits a compact six-field shape (name,
 * keys, content, caseSensitive, cascade, throttle) rather than SillyTavern's
 * own ~28-field entry schema — parseOneShotEntries assembles the rest of the
 * real entry around those six fields, so a malformed `preventRecursion` or
 * `position` is structurally impossible rather than something to validate.
 *
 * {{TRANSCRIPT}} {{EXISTING}} {{MAX_ENTRIES}} are filled by buildOneShotPrompt.
 *
 * Carries the same `ERROR_CONTROL_RULES` block as the chunked/injection path
 * (PHA-2722): before this, one-shot was the only generation prompt missing
 * the never-invent-facts / flag-ambiguity / report-contradictions / attach-
 * provenance rule set, backwards given it's the path that reads the whole
 * story at once and is therefore best placed to cite accurately. Sharing the
 * literal constant (rather than a hand-copied rule set) also means
 * `extractProvenanceRanges` — the existing `src: msgs X–Y` consumer used by
 * `runClaimReverification` — picks up one-shot entries with zero new code:
 * one-shot becomes just another writer of the one provenance format instead
 * of a second, unread one (`stmbAutoConfidence` stays as the entry-level
 * ranking signal, see attributeSources below).
 */
export const ONE_SHOT_PROMPT =
`${WORLD_INFO_PRIMER}

THIS TASK
You are building the COMPLETE World Info lorebook for the story below. You can
see the ENTIRE story and the ENTIRE existing lorebook at once, so you are
responsible for the whole entry set being mutually consistent. This is the only
call that will be made — nothing downstream will reconcile your entries.

RULES
1. Cover every subject the story actually establishes, and nothing it does not.
   Do not create an entry for a one-off mention with no substance behind it.
2. Produce AT MOST {{MAX_ENTRIES}} entries. If the story has more subjects than
   that, keep the ones that recur and matter and drop the rest.
3. The EXISTING LOREBOOK below is already in the book. Reuse an existing
   entry's exact "name" to UPDATE it (write the improved full content — it
   will be replaced, not merged). Use a new name to create a new entry. Never
   create a second entry for a subject that already has one.
4. Keywords must not collide with the keywords already claimed by existing
   entries, listed below. Treat those as taken.
5. Do not write entries about the user's own persona's private thoughts, and do
   not summarize the plot beat by beat — that is what memory entries are for.
6. Entries tagged [settled — do not re-emit] are already correct for the story
   so far. Leave them OUT of your reply entirely — do not restate them, do not
   improve their wording. Their keywords stay taken by them.

${ERROR_CONTROL_RULES}

Reply with ONLY a JSON object of exactly this shape — no prose, no code fences:
{"entries":[{"name":"","keys":[],"content":"","caseSensitive":false,"cascade":false,"throttle":100}]}

EXISTING LOREBOOK (names and the keywords they already claim):
{{EXISTING}}

STORY TRANSCRIPT (every message, numbered "[id] Speaker: text"):
{{TRANSCRIPT}}`;

/** Reprimand appended on the single retry when the first reply is unusable. */
export const ONE_SHOT_JSON_ONLY_REPRIMAND =
    'Reply with ONLY the JSON object described: {"entries":[{"name":"","keys":[],"content":"","caseSensitive":false,"cascade":false,"throttle":100}]}. No prose, no code fences.';

// ---------------------------------------------------------------- formatting

/** Render the extracted audit messages as the transcript block. */
export function formatTranscript(messages, truncate = ONE_SHOT_DEFAULTS.truncate) {
    const list = Array.isArray(messages) ? messages : [];
    return list.map(m => formatAuditMessage(m, truncate)).join('\n');
}

/**
 * Render the existing lorebook as "title — keywords" lines, so the model can
 * both update by title and avoid keywords that are already taken.
 *
 * `frozenTitles` (PHA-2693) marks the entries an incremental run has decided
 * are settled. They are still LISTED — the model needs to see them so it does
 * not create a second entry for the same subject or steal their keywords — but
 * tagged so it knows not to spend output tokens re-emitting them. The tag rides
 * the same channel as the existing `[scene memory — do not rewrite]` marker
 * rather than a new prompt token, so a user's custom prompt template keeps
 * working unchanged.
 *
 * @param {Array<{title:string, keys:string[], isMemory?:boolean}>} entries
 * @param {Set<string>} [frozenTitles] normalized titles this run will not re-derive
 */
export function formatExistingEntries(entries, frozenTitles = new Set()) {
    const list = Array.isArray(entries) ? entries : [];
    const lines = [];
    for (const e of list) {
        const title = String(e?.title ?? '').trim();
        if (!title) continue;
        const keys = (Array.isArray(e?.keys) ? e.keys : [])
            .map(k => String(k ?? '').trim())
            .filter(Boolean);
        const tag = e?.isMemory
            ? ' [scene memory — do not rewrite]'
            : (frozenTitles.has(title.toLowerCase()) ? ' [settled — do not re-emit]' : '');
        lines.push(`- ${title}${tag}: ${keys.length ? keys.join(', ') : '(no keywords)'}`);
    }
    return lines.length ? lines.join('\n') : '(empty — this is a brand new lorebook)';
}

/** Fill the one-shot prompt template. */
export function buildOneShotPrompt({ transcriptText, existingText, maxEntries, template } = {}) {
    const replacements = {
        TRANSCRIPT: String(transcriptText ?? ''),
        EXISTING: String(existingText ?? '').trim() || '(empty — this is a brand new lorebook)',
        MAX_ENTRIES: String(Number(maxEntries) || ONE_SHOT_DEFAULTS.maxEntries),
    };
    return String(template || ONE_SHOT_PROMPT).replace(
        /\{\{(TRANSCRIPT|EXISTING|MAX_ENTRIES)\}\}/g,
        (_m, token) => replacements[token] ?? '',
    );
}

// ---------------------------------------------------------------- parsing

const strList = (v) => (Array.isArray(v) ? v : [])
    .filter(x => typeof x === 'string')
    .map(x => x.trim())
    .filter(Boolean);

const clampInt = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Salvage the complete entry objects out of a reply whose JSON was cut off by
 * the output token cap (PHA-1886 §3).
 *
 * A `max_tokens`-truncated reply has no closing brace for the last object, so
 * `lastIndexOf('}')` produces invalid JSON and the retry — same prompt, same
 * cap — truncates in exactly the same place. Rather than losing 50 good entries
 * because the 51st is half-written, walk the text and take every top-level
 * `{...}` that IS balanced, string- and escape-aware so a `}` inside content
 * does not close an object early.
 *
 * @returns {Array<object>} parsed objects, possibly empty
 */
export function salvageEntryObjects(text) {
    const s = typeof text === 'string' ? text : '';
    const out = [];
    const stack = [];       // start offsets of currently open objects
    let inString = false;
    let escaped = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { stack.push(i); continue; }
        if (ch !== '}') continue;
        const start = stack.pop();
        if (start == null) continue;                 // stray brace in prose
        // Entries sit either at the top level (a bare array reply) or one level
        // inside the `{"entries": [...]}` wrapper — whose own brace never closes
        // in a truncated reply. Anything deeper is a nested value, not an entry.
        if (stack.length > 1) continue;
        try {
            const obj = JSON.parse(s.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.name === 'string') out.push(obj);
        } catch { /* not a complete object */ }
    }
    return out;
}

/**
 * Strip a ```json fence and any prose around the JSON object, like parseAuditNotes.
 * Falls back to per-object salvage when the reply was truncated mid-JSON.
 */
function extractJsonObject(reply) {
    if (typeof reply !== 'string') return null;
    let s = reply.trim();
    if (!s) return null;
    const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch { /* try to carve the object out of surrounding prose */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch { /* truncated — salvage below */ }
    }
    const salvaged = salvageEntryObjects(s);
    return salvaged.length ? { entries: salvaged, stmbAutoSalvaged: true } : null;
}

/**
 * Parse and sanitize a reply into the entry set.
 *
 * The whole-story path (oneShotLorebook.js) emits the compact six-field shape
 * from WORLD_INFO_PRIMER: name, keys, content, caseSensitive, cascade,
 * throttle. Everything else SillyTavern needs is assembled here from a
 * known-good template, so a malformed field is structurally impossible rather
 * than something to clamp. The older per-entity chunked walk
 * (chunkedLorebookCore.js) shares this parser but still runs its own prompt
 * asking for the ST-shaped fields directly (kind, key, selectiveLogic,
 * constant, order, position, scanDepth) — both are read here, new shape
 * preferred, so this function stays a single source of truth for either
 * caller. Entries without a name or without usable content are dropped rather
 * than guessed at — a partial book beats a book full of placeholders.
 *
 * @returns {{entries:Array<object>, dropped:number}|null} null when nothing parsed
 */
export function parseOneShotEntries(reply, cfg = {}) {
    const maxEntries = Number(cfg.maxEntries) || ONE_SHOT_DEFAULTS.maxEntries;
    const minContent = Number.isFinite(Number(cfg.minContentChars))
        ? Number(cfg.minContentChars)
        : ONE_SHOT_DEFAULTS.minContentChars;

    const parsed = extractJsonObject(reply);
    if (!parsed || typeof parsed !== 'object') return null;
    const raw = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed.entries) ? parsed.entries
        : null;
    if (!raw) return null;

    const out = [];
    let dropped = 0;
    const seenTitles = new Set();

    for (const item of raw) {
        if (!item || typeof item !== 'object') { dropped++; continue; }
        const title = String(item.name ?? item.title ?? '').trim();
        const content = String(item.content ?? '').trim();
        if (!title || content.length < minContent) { dropped++; continue; }
        // A duplicate name inside one reply would make the two entries fight
        // over the same upsert target; keep the first, drop the rest.
        const titleKey = title.toLowerCase();
        if (seenTitles.has(titleKey)) { dropped++; continue; }
        seenTitles.add(titleKey);

        // Plaintext keys cannot contain commas (ST treats them as separators),
        // so split rather than silently shipping an unmatchable key.
        const splitKeys = (v) => strList(v).flatMap(k => k.split(',').map(x => x.trim()).filter(Boolean));
        const keysSource = item.keys !== undefined ? item.keys : item.key;

        // throttle (0-100, "how often this fires on a match") maps onto ST's
        // probability gate; 100 means the gate never needs to roll at all, and
        // is also the correct default when a caller (the chunked walk) never
        // sends throttle at all.
        const throttle = clampInt(item.throttle, 100, 0, 100);

        out.push({
            title,
            kind: String(item.kind ?? '').trim().toLowerCase() || 'concept',
            key: splitKeys(keysSource).length ? splitKeys(keysSource) : [title],
            keysecondary: splitKeys(item.keysecondary),
            selectiveLogic: clampInt(item.selectiveLogic, SELECTIVE_LOGIC.AND_ANY, 0, 3),
            constant: item.constant === true,
            order: clampInt(item.order, ONE_SHOT_DEFAULTS.order, 0, 10000),
            // Number(null) and Number('') are both 0, which would silently mean
            // BEFORE_CHAR — an omitted position must fall through to the default.
            position: item.position != null && item.position !== ''
                && [0, 1, 2, 3, 4].includes(Number(item.position))
                ? Number(item.position)
                : INSERTION_POSITION.AFTER_CHAR,
            scanDepth: clampInt(item.scanDepth, 3, 1, 100),
            // cascade:true lets this entry's insertion trigger other entries;
            // default false (and always false for the chunked walk, which never
            // sends "cascade"), since these entries name each other constantly
            // and without this one match would otherwise cascade into a dozen.
            preventRecursion: item.cascade !== true,
            caseSensitive: item.caseSensitive === true,
            probability: throttle,
            useProbability: throttle < 100,
            content,
        });
        if (out.length >= maxEntries) break;
    }

    if (out.length === 0) return null;
    return { entries: out, dropped: dropped + Math.max(0, raw.length - out.length - dropped) };
}

// ---------------------------------------------------------------- keyword uniqueness

/** Normalize a keyword for collision comparison: lowercase, collapse whitespace. */
export function normalizeKeyword(k) {
    return String(k ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whole-word containment, on already-normalized text. Shared so keyword awards
 * and degraded-entry marking agree on what "names this entry" means — a
 * substring test flags "Ash" for a question about "ashes" (PHA-1886 §6).
 */
export function containsWholeWord(haystack, needle) {
    const h = String(haystack ?? '');
    const n = String(needle ?? '');
    if (!h || !n) return false;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(h);
}

/** Is this key a regex literal (`/.../flags`)? Those are never deduped by text. */
function isRegexKey(k) {
    return /^\/.*\/[a-z]*$/i.test(String(k ?? '').trim());
}

/**
 * Collect the keywords already claimed by entries in the book, so a newly
 * generated entry cannot steal one.
 * @param {Array<{title:string, keys:string[]}>} entries
 * @param {Set<string>} [skipTitles] normalized titles being rewritten by this run
 * @returns {Set<string>} normalized keywords
 */
export function collectClaimedKeywords(entries, skipTitles = new Set()) {
    const claimed = new Set();
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const title = String(e?.title ?? '').trim().toLowerCase();
        if (title && skipTitles.has(title)) continue;   // we are replacing this entry's keys
        for (const k of (Array.isArray(e?.keys) ? e.keys : [])) {
            const n = normalizeKeyword(k);
            if (n) claimed.add(n);
        }
    }
    return claimed;
}

/**
 * The keyword awards this book already reflects (PHA-2693 Build item 6).
 *
 * `enforceGlobalKeywordUniqueness` used to re-derive every award from scratch
 * on every run, which is not the same thing as remembering them. A title the
 * run is rewriting releases its keywords back into the pool (oneShotLorebook.js
 * builds `claimedByExisting` with those titles skipped, deliberately — the run
 * is about to restate them). While they are loose, a NEWCOMER whose title
 * happens to contain the keyword can take it under rule 2, and the stable
 * entity that has owned it for ten runs loses it. Retrieval for that entity
 * silently changes even though nothing about it did.
 *
 * This is the known state that stops that: keyword -> the normalized title that
 * currently holds it, read off the shipped book once, and consulted FIRST when
 * a contest happens. It is an incumbency rule, not a veto — the incumbent only
 * wins a keyword it is still asking for.
 *
 * @param {Array<{title:string, keys?:string[], key?:string[], disable?:boolean}>} entries
 * @returns {Map<string,string>} normalized keyword -> normalized owning title
 */
export function collectPriorAwards(entries) {
    const awards = new Map();
    for (const e of (Array.isArray(entries) ? entries : [])) {
        if (e?.disable) continue;
        const title = normalizeKeyword(e?.title);
        if (!title) continue;
        const keys = Array.isArray(e?.keys) ? e.keys : (Array.isArray(e?.key) ? e.key : []);
        for (const k of keys) {
            if (isRegexKey(k)) continue;
            const n = normalizeKeyword(k);
            // First writer wins: a book that somehow ships the same keyword on
            // two entries is exactly the state this whole function guards
            // against, so do not let the later one rewrite history.
            if (n && !awards.has(n)) awards.set(n, title);
        }
    }
    return awards;
}

/**
 * Make global keyword uniqueness a guarantee rather than an instruction.
 *
 * A keyword claimed by more than one generated entry is awarded to exactly one
 * of them and stripped from the others. The winner is chosen deterministically,
 * most specific first:
 *   0. the entry that already held this keyword in the shipped book, if it is
 *      still asking for it (PHA-2693 — see `collectPriorAwards`), else
 *   1. the entry whose own title IS the keyword (exact match), else
 *   2. the entry whose title CONTAINS the keyword as a whole word, else
 *   3. the entry that emitted it first.
 * Keywords already claimed by an untouched existing entry are stripped from all
 * generated entries — the book's incumbent keeps them.
 *
 * An entry stripped down to nothing keeps a fallback key so it never ships
 * unretrievable: its title if that is still free, otherwise the entry is marked
 * `keywordless: true` and the caller decides (we make it constant=false and let
 * vector matching carry it rather than silently colliding again).
 *
 * @param {Array<object>} entries parsed entries (mutated copies are returned)
 * @param {Set<string>} claimedByExisting normalized keywords owned by the book
 * @param {Map<string,string>} [priorAwards] `collectPriorAwards` output; omitted
 *        means "no memory", i.e. exactly the pre-PHA-2693 behaviour
 * @returns {{entries:Array<object>, collisions:Array<{keyword:string, winner:string, strippedFrom:string[], reason:string}>}}
 */
export function enforceGlobalKeywordUniqueness(entries, claimedByExisting = new Set(), priorAwards = new Map()) {
    const list = (Array.isArray(entries) ? entries : []).map(e => ({ ...e }));

    // Who wants what.
    const wanters = new Map();  // normalized keyword -> [{idx, original}]
    list.forEach((entry, idx) => {
        for (const k of (Array.isArray(entry.key) ? entry.key : [])) {
            if (isRegexKey(k)) continue;
            const n = normalizeKeyword(k);
            if (!n) continue;
            if (!wanters.has(n)) wanters.set(n, []);
            if (!wanters.get(n).some(w => w.idx === idx)) wanters.get(n).push({ idx, original: String(k).trim() });
        }
    });

    const wholeWord = containsWholeWord;

    const awarded = new Map();      // normalized keyword -> winning idx (or -1 = nobody)
    const collisions = [];

    for (const [keyword, group] of wanters) {
        if (claimedByExisting.has(keyword)) {
            awarded.set(keyword, -1);
            if (group.length) {
                collisions.push({
                    keyword,
                    winner: '(existing lorebook entry)',
                    strippedFrom: group.map(g => list[g.idx].title),
                    reason: 'claimed by an untouched existing entry',
                });
            }
            continue;
        }
        if (group.length === 1) { awarded.set(keyword, group[0].idx); continue; }

        const incumbentTitle = priorAwards.get(keyword);
        const incumbent = incumbentTitle
            ? group.find(g => normalizeKeyword(list[g.idx].title) === incumbentTitle)
            : undefined;
        const exact = group.find(g => normalizeKeyword(list[g.idx].title) === keyword);
        const contained = group.find(g => wholeWord(normalizeKeyword(list[g.idx].title), keyword));
        const winner = incumbent || exact || contained || group[0];
        const reason = incumbent ? 'prior award (incumbent)'
            : exact ? 'title is the keyword'
            : contained ? 'title contains the keyword'
            : 'emitted first';
        awarded.set(keyword, winner.idx);
        collisions.push({
            keyword,
            winner: list[winner.idx].title,
            strippedFrom: group.filter(g => g.idx !== winner.idx).map(g => list[g.idx].title),
            reason,
        });
    }

    // Apply the awards.
    list.forEach((entry, idx) => {
        const kept = (Array.isArray(entry.key) ? entry.key : []).filter((k) => {
            if (isRegexKey(k)) return true;
            const n = normalizeKeyword(k);
            return !!n && awarded.get(n) === idx;
        });
        entry.key = Array.from(new Set(kept));

        if (entry.key.length === 0) {
            // Every candidate contested and the title taken too used to mean the
            // entry shipped with `key: []` — unretrievable unless the user has
            // Vector Storage wired into World Info. Fall through to a
            // deterministic disambiguated form first (PHA-1886 §4); only a title
            // that collides even when qualified gives up.
            const title = String(entry.title ?? '').trim();
            const candidates = title ? [title] : [];
            if (title) for (let n = 2; n <= 9; n++) candidates.push(`${title} (entry ${n})`);

            const free = candidates.find((c) => {
                const n = normalizeKeyword(c);
                return !!n && !n.includes(',') && !claimedByExisting.has(n) && !awarded.has(n);
            });
            if (free) {
                entry.key = [free];
                awarded.set(normalizeKeyword(free), idx);
                delete entry.keywordless;
            } else {
                entry.keywordless = true;
            }
        } else {
            // The same entry can pass through here once per chunked pass. A
            // stale flag from an earlier pass would force constant:false on an
            // entry that has since won a keyword.
            delete entry.keywordless;
        }

        // keysecondary is a filter, not a trigger, so it does not collide the
        // same way — but it must not duplicate this entry's own primary keys.
        const primary = new Set(entry.key.map(normalizeKeyword));
        entry.keysecondary = (Array.isArray(entry.keysecondary) ? entry.keysecondary : [])
            .filter(k => !primary.has(normalizeKeyword(k)));
        if (entry.keysecondary.length === 0) entry.selectiveLogic = SELECTIVE_LOGIC.AND_ANY;
    });

    return { entries: list, collisions };
}

/**
 * Drop generated entries that would overwrite a scene memory (PHA-1886 §5).
 *
 * Scene memories are shown to the model tagged `[scene memory — do not rewrite]`,
 * but `upsertLorebookEntryByTitle` matches on the entry comment: a model that
 * echoes one of those titles back gets the chronological record replaced with
 * lore. The premise of this whole path is that instructions are not guarantees,
 * so make it one at the boundary instead.
 *
 * @param {Array<object>} entries generated entries (`title`)
 * @param {Array<{title:string, isMemory:boolean}>} existing entriesForCoverage output
 * @returns {{entries:Array<object>, skipped:string[]}}
 */
export function dropMemoryTitleCollisions(entries, existing = []) {
    const protectedTitles = new Set();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        if (!e?.isMemory) continue;
        const n = normalizeKeyword(e.title);
        if (n) protectedTitles.add(n);
    }
    const list = Array.isArray(entries) ? entries : [];
    if (!protectedTitles.size) return { entries: list, skipped: [] };

    const kept = [];
    const skipped = [];
    for (const entry of list) {
        if (protectedTitles.has(normalizeKeyword(entry?.title))) skipped.push(String(entry?.title ?? ''));
        else kept.push(entry);
    }
    return { entries: kept, skipped };
}

/**
 * Post-hoc assertion used by the acceptance check and the tests: returns every
 * keyword claimed by more than one entry across the WHOLE book.
 * @param {Array<{title:string, key:string[]}>} entries
 * @returns {Array<{keyword:string, titles:string[]}>}
 */
export function findKeywordCollisions(entries) {
    const owners = new Map();
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const title = String(e?.title ?? '');
        const keys = Array.isArray(e?.key) ? e.key : (Array.isArray(e?.keys) ? e.keys : []);
        for (const k of keys) {
            if (isRegexKey(k)) continue;
            const n = normalizeKeyword(k);
            if (!n) continue;
            if (!owners.has(n)) owners.set(n, []);
            if (!owners.get(n).includes(title)) owners.get(n).push(title);
        }
    }
    const out = [];
    for (const [keyword, titles] of owners) {
        if (titles.length > 1) out.push({ keyword, titles });
    }
    return out;
}

// ---------------------------------------------------------------- provenance (PHA-2681)

/**
 * Deterministic 32-bit content hash (FNV-1a), used only to notice that content
 * changed — not for anything cryptographic. Whitespace-trimmed so re-saving
 * the same book through SillyTavern's own JSON round-trip never reads as an edit.
 */
export function hashContent(text) {
    const s = String(text ?? '').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Human-edit detection with no sidecar and no edit signal from ST: this tool
 * stamps `stmbAutoContentHash` on every entry it writes, so a mismatch at the
 * start of the NEXT run means something changed the content since — and the
 * only actor that can be, since this tool only ever writes through its own
 * upsert path, is a human.
 */
export function wasHumanEdited(existingEntry) {
    if (!existingEntry || typeof existingEntry !== 'object') return false;
    if (!existingEntry.stmbAutoContentHash) return false;
    return hashContent(existingEntry.content) !== existingEntry.stmbAutoContentHash;
}

/**
 * Attribute an entry's content to the transcript messages it came from, at
 * ZERO prompt tokens: this runs post-hoc over the model's finished reply, not
 * as an extra thing the model is asked to emit. A sentence with strong word
 * overlap against some message is `stated`; a sentence the story never said in
 * those words is `inferred` — the model concluded it rather than read it.
 * Crude on purpose: no LLM call, no embeddings, just enough signal to tell
 * "the text said this" from "the model connected two things itself".
 *
 * Provenance is computed PER-FACT (`facts`, one entry per sentence), not
 * per-entry (PHA-2681 review finding 2): an entry-level majority vote averages
 * away exactly the case that motivated this issue — one inferred sentence
 * sitting inside an otherwise well-sourced entry. The rolled-up `confidence`
 * is `'inferred'` if ANY fact is inferred, not a >=50% threshold, so that one
 * bad sentence still flips the whole entry's flag rather than disappearing
 * into an average.
 *
 * `sourceRef`/`facts` are returned for the caller's own use but are NOT what
 * ships on the entry (PHA-2722): the real, re-readable provenance is the
 * `src: msgs X–Y` lines the model itself now writes into `content` (the same
 * format every other writer uses, consumed by
 * `extractProvenanceRanges`/`runClaimReverification`). Keeping a second,
 * differently-shaped provenance record as an entry property duplicated that
 * system without ever feeding it — only `confidence` survives onto the entry
 * as `stmbAutoConfidence`, the ranking signal claim re-verification uses to
 * decide which entries to recheck first.
 *
 * @param {string} content
 * @param {Array<{id?:number, index?:number, text?:string, mes?:string}>} messages
 * @returns {{confidence:'stated'|'inferred', sourceRef:number[],
 *            facts:Array<{text:string, confidence:'stated'|'inferred', sourceRef:number[]}>}}
 */
export function attributeSources(content, messages) {
    const sentences = String(content ?? '')
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(Boolean);
    const list = Array.isArray(messages) ? messages : [];
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const wordsOf = (s) => new Set(norm(s).split(' ').filter(w => w.length > 3));

    // extractAuditMessages (the real runtime source of plan.messages) emits
    // `rawText`, not `text`/`mes` — read it first. Without this every message
    // silently scores as empty text, matching nothing, so EVERY entry
    // regardless of its actual content was stamped confidence:'inferred' in
    // production (caught during the Magisa provenance spot-check, PHA-2681
    // follow-up review).
    const msgWords = list.map(m => ({ id: m?.id ?? m?.index, words: wordsOf(m?.rawText ?? m?.text ?? m?.mes ?? '') }));

    const facts = [];
    for (const sentence of sentences) {
        const sw = wordsOf(sentence);
        if (sw.size < 3) continue;   // too short to score meaningfully — not a fact
        let best = null;
        for (const m of msgWords) {
            if (!m.words.size || m.id == null) continue;
            let overlap = 0;
            for (const w of sw) if (m.words.has(w)) overlap++;
            const ratio = overlap / sw.size;
            if (ratio >= 0.6 && (!best || ratio > best.ratio)) best = { ratio, id: m.id };
        }
        facts.push({
            text: sentence,
            confidence: best ? 'stated' : 'inferred',
            sourceRef: best ? [best.id] : [],
        });
    }

    const confidence = facts.length && facts.every(f => f.confidence === 'stated') ? 'stated' : 'inferred';
    const sourceRef = Array.from(new Set(facts.flatMap(f => f.sourceRef))).sort((a, b) => a - b);
    return { confidence, sourceRef, facts };
}

/**
 * Human-edit pinning (PHA-2681, the load-bearing mechanism of this issue).
 *
 * A hand-corrected entry must survive a later re-run untouched, and a genuine
 * source contradiction against it must be REPORTED, never silently
 * reconciled (PHA-1878 decision 7).
 *
 * This does NOT by itself satisfy "an entry whose source did not change comes
 * back byte-identical": the hash comparison below is against the model's
 * FRESHLY GENERATED content, which reproduces byte-identical prose only in
 * the rare case where the model happens to regenerate the exact same text —
 * in practice essentially never. On unchanged source the fresh content
 * differs from the stored hash, so the entry still falls through to
 * `toWrite` and gets rewritten. That acceptance criterion needs Build item 5
 * (regenerate only entities whose source actually changed, never re-deriving
 * an untouched one at all) — tracked as a pulled-back acceptance criterion on
 * this issue, built in PHA-2693. What this function DOES guarantee: a
 * human-verified entry is never silently overwritten, and a fresh call that
 * happens to reproduce a prior write byte-for-byte costs zero write calls.
 *
 * Title-keyed matching alone loses a pin when the model renames an entry it
 * should have updated in place (review finding 5 — e.g. "Button" ->
 * "Button Firewood"): no exact title match is found, the pin-bearing prior
 * is invisible, and the human correction would either be silently dropped or
 * duplicated under the new title. Bounded fix: fall back to a whole-word
 * title match, but ONLY against a prior a human has actually verified — that
 * narrows the false-positive surface to the one case this feature exists to
 * protect. A rename of an ordinary (non-pinned) entry still isn't tracked;
 * that's a real but lower-severity gap (harmless-ish duplication under the
 * new title) left out of scope here.
 *
 * @param {Array<object>} generated  parsed+deduped one-shot entries (`title`, `content`, ...)
 * @param {Array<object>} existing   entriesForCoverage() output for the bound book
 * @returns {{toWrite:Array<object>, skipped:Array<{title:string, reason:string}>,
 *            contradictions:Array<{title:string, existing:string, proposed:string, renamedFrom?:string}>,
 *            newlyPinned:Array<{title:string}>, renamed:Array<{uid:*, from:string, to:string}>}}
 */
export function applyProvenancePinning(generated, existing) {
    const byTitle = new Map();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        const t = String(e?.title ?? '').trim().toLowerCase();
        if (t) byTitle.set(t, e);
    }

    // Exact matches are claimed up front so the rename fallback below can
    // never steal a prior that some OTHER generated entry is legitimately
    // updating under its own unchanged title.
    const claimedPriors = new Set();
    for (const entry of (Array.isArray(generated) ? generated : [])) {
        const key = String(entry?.title ?? '').trim().toLowerCase();
        if (byTitle.has(key)) claimedPriors.add(key);
    }

    const toWrite = [];
    const skipped = [];
    const contradictions = [];
    const newlyPinned = [];
    const renamed = [];

    for (const entry of (Array.isArray(generated) ? generated : [])) {
        const key = String(entry?.title ?? '').trim().toLowerCase();
        let prior = byTitle.get(key);
        let priorKey = key;
        let isRename = false;

        if (!prior) {
            for (const [existingKey, cand] of byTitle) {
                if (claimedPriors.has(existingKey)) continue;
                if (cand?.stmbAutoVerifiedByHuman !== true) continue;
                if (containsWholeWord(key, existingKey) || containsWholeWord(existingKey, key)) {
                    prior = cand;
                    priorKey = existingKey;
                    isRename = true;
                    break;
                }
            }
        }

        if (!prior) { toWrite.push(entry); continue; }
        claimedPriors.add(priorKey);

        const editedNow = wasHumanEdited(prior);
        const humanVerified = prior.stmbAutoVerifiedByHuman === true || editedNow;
        if (editedNow && prior.stmbAutoVerifiedByHuman !== true) newlyPinned.push({ title: entry.title });

        const sameAsPrior = hashContent(entry.content) === hashContent(prior.content);

        if (humanVerified) {
            if (sameAsPrior) {
                skipped.push({ title: entry.title, reason: isRename ? 'human-verified, unchanged (rename ignored)' : 'human-verified, unchanged' });
                if (isRename) renamed.push({ uid: prior.uid, from: prior.title, to: entry.title });
                continue;
            }
            contradictions.push({
                title: entry.title, existing: prior.content, proposed: entry.content,
                ...(isRename ? { renamedFrom: prior.title } : {}),
            });
            skipped.push({ title: entry.title, reason: 'human-verified, source contradiction reported' });
            continue;
        }

        if (prior.stmbAutoContentHash && hashContent(entry.content) === prior.stmbAutoContentHash) {
            skipped.push({ title: entry.title, reason: 'source unchanged' });
            continue;
        }

        toWrite.push(entry);
    }

    return { toWrite, skipped, contradictions, newlyPinned, renamed };
}

// ---------------------------------------------------------------- incremental runs (PHA-2693)

/**
 * Every name an entry answers to: its title plus its keywords, normalized.
 * Used to ask "does this new message talk about this entry at all?".
 */
export function entryNames(entry) {
    const names = new Set();
    const push = (s) => { const n = normalizeKeyword(s); if (n) names.add(n); };
    push(entry?.title);
    const keys = Array.isArray(entry?.keys) ? entry.keys : (Array.isArray(entry?.key) ? entry.key : []);
    for (const k of keys) { if (!isRegexKey(k)) push(k); }
    return names;
}

/**
 * How far into the story the run that last wrote this entry had actually read.
 *
 * Stamped PER ENTRY rather than once per run, and that is the load-bearing
 * detail: with a single book-wide mark, an entry written at message 100 and an
 * entry written at message 200 share one number, so a message at 150 naming the
 * first entry is never diffed against it and the entry silently goes stale
 * forever. Per entry, "have I read anything about you since I wrote you?" is
 * always answerable.
 */
export function entryHighWater(entry) {
    const n = Number(entry?.stmbAutoRunHighWater);
    return Number.isFinite(n) ? n : null;
}

/**
 * The newest point in the story any run of this tool has read, across the whole
 * book. Only used to decide whether there is anything NEW at all — per-entry
 * staleness uses each entry's own mark.
 */
export function readHighWaterMark(existing) {
    let hw = null;
    for (const e of (Array.isArray(existing) ? existing : [])) {
        const n = entryHighWater(e);
        if (n !== null && (hw === null || n > hw)) hw = n;
    }
    return hw;
}

/** Does any of these names appear as a whole word in this text? */
function textNames(text, names) {
    const hay = normalizeKeyword(text);
    if (!hay) return false;
    for (const n of names) if (containsWholeWord(hay, n)) return true;
    return false;
}

/**
 * Decide which existing entries this run actually has to re-derive (Build item 5).
 *
 * The diff is against each entry's own high-water mark: an entry is stale when
 * the story has said something about it that the run which wrote it never saw,
 * or when an unresolved question is still open against it. Everything else is
 * FROZEN — listed to the model so it neither duplicates the subject nor steals
 * its keywords, but explicitly not asked for.
 *
 * HONEST ACCOUNTING, because this is the thing the issue warns about: under
 * one-shot generation the whole transcript goes into the prompt either way, so
 * this saves close to nothing on INPUT tokens. What it saves is OUTPUT tokens
 * (the model writes 4 entries instead of 52) and write calls (the run touches
 * 4 entries instead of 52). The reason to want it is not cost — it is that an
 * entry nobody asked the model to rewrite cannot come back re-worded, which is
 * the drift guarantee `applyProvenancePinning` explicitly could not make on its
 * own (see its docstring).
 *
 * Failure direction is deliberate: when in doubt, regenerate. An entry with no
 * provenance, a book with no marks at all, a message that might be about the
 * entry — all resolve to "stale". A false stale costs output tokens; a false
 * frozen means an entry never gets updated again, which is silent and wrong.
 *
 * @param {object} p
 * @param {Array<object>} p.existing         entriesForCoverage() output
 * @param {Array<{id?:number, index?:number, rawText?:string, text?:string, mes?:string}>} p.messages
 * @param {Array<string|{question?:string, text?:string}>} [p.unresolvedQuestions]
 * @param {boolean} [p.enabled] false forces the full-rebuild ground truth
 * @returns {{mode:'full'|'incremental', reason:string, highWater:number|null,
 *            newMessageCount:number, canSkipCall:boolean,
 *            frozen:Array<{title:string, reason:string}>,
 *            stale:Array<{title:string, reason:string}>,
 *            frozenTitles:Set<string>}}
 */
export function planIncrementalRun({ existing = [], messages = [], unresolvedQuestions = [], enabled = true } = {}) {
    const lore = (Array.isArray(existing) ? existing : []).filter(e => e && !e.isMemory && !e.disable);
    const msgs = (Array.isArray(messages) ? messages : [])
        .map(m => ({ id: Number(m?.id ?? m?.index), text: String(m?.rawText ?? m?.text ?? m?.mes ?? '') }))
        .filter(m => Number.isFinite(m.id));
    const highWater = readHighWaterMark(lore);
    const newMessageCount = highWater === null ? msgs.length : msgs.filter(m => m.id > highWater).length;

    const full = (reason) => ({
        mode: 'full', reason, highWater, newMessageCount, canSkipCall: false,
        frozen: [], stale: lore.map(e => ({ title: e.title, reason })), frozenTitles: new Set(),
    });

    if (!enabled) return full('incremental runs are off — full rebuild');
    if (!lore.length) return full('nothing in the book yet — full rebuild');
    if (highWater === null) {
        return full('no entry in this book records what the last run had read — full rebuild');
    }

    // The ledger shape is chunkedLorebookCore.js's `{question, about, messageIds,
    // resolved}`; a bare string is accepted too. `about` names the entity the
    // question is against, so it is the precise field — but questions routinely
    // name a second entity only in their prose, so both are matched. Already-
    // resolved entries are not open and must not hold anything stale.
    const questions = (Array.isArray(unresolvedQuestions) ? unresolvedQuestions : [])
        .filter(q => typeof q === 'string' || !q?.resolved)
        .map(q => normalizeKeyword(typeof q === 'string' ? q : `${q?.about ?? ''} ${q?.question ?? q?.text ?? ''}`))
        .filter(Boolean);

    const frozen = [];
    const stale = [];
    const frozenTitles = new Set();

    for (const e of lore) {
        const title = String(e?.title ?? '').trim();
        if (!title) continue;
        const mark = entryHighWater(e);
        if (mark === null) {
            stale.push({ title, reason: 'no record of what the run that wrote it had read' });
            continue;
        }
        const names = entryNames(e);
        if (!names.size) {
            stale.push({ title, reason: 'no title or keywords to match the story against' });
            continue;
        }

        const askedAbout = questions.find(q => textNames(q, names));
        if (askedAbout) {
            stale.push({ title, reason: 'named by a still-open unresolved question' });
            continue;
        }

        const sinceIds = [];
        for (const m of msgs) {
            if (m.id <= mark) continue;
            if (textNames(m.text, names)) sinceIds.push(m.id);
        }
        if (sinceIds.length) {
            stale.push({
                title,
                reason: `named in ${sinceIds.length} message${sinceIds.length === 1 ? '' : 's'} added since it was written (${sinceIds[0]}–${sinceIds[sinceIds.length - 1]})`,
            });
            continue;
        }

        frozen.push({ title, reason: `nothing since message ${mark} mentions it` });
        frozenTitles.add(title.toLowerCase());
    }

    // Nothing new to read AND nothing outstanding: the honest answer is that
    // there is no work, and the caller should not spend a call to be told so.
    const canSkipCall = newMessageCount === 0 && stale.length === 0;

    return {
        mode: 'incremental',
        reason: canSkipCall
            ? `nothing new since message ${highWater} and no entry is stale`
            : `${stale.length} of ${lore.length} entr${lore.length === 1 ? 'y' : 'ies'} need re-deriving, ${frozen.length} settled`,
        highWater,
        newMessageCount,
        canSkipCall,
        frozen,
        stale,
        frozenTitles,
    };
}

/**
 * Drop generated entries the run had frozen.
 *
 * Rule 6 of the prompt tells the model not to re-emit a settled entry; this
 * makes it true regardless — same "instructions are not guarantees" reasoning
 * as `dropMemoryTitleCollisions` and `enforceGlobalKeywordUniqueness`, and it
 * is also what keeps a user's CUSTOM prompt template (which will not carry
 * rule 6) from quietly losing the drift guarantee.
 *
 * Safe because frozen means "no new source names this subject": there is no
 * fresh material for the dropped entry to have contained, so nothing is lost
 * and no contradiction goes unreported.
 *
 * @param {Array<object>} entries
 * @param {Set<string>} frozenTitles normalized titles
 * @returns {{entries:Array<object>, skipped:string[]}}
 */
export function dropFrozenEntries(entries, frozenTitles = new Set()) {
    const list = Array.isArray(entries) ? entries : [];
    if (!frozenTitles.size) return { entries: list, skipped: [] };
    const kept = [];
    const skipped = [];
    for (const entry of list) {
        const t = String(entry?.title ?? '').trim().toLowerCase();
        if (t && frozenTitles.has(t)) skipped.push(String(entry?.title ?? ''));
        else kept.push(entry);
    }
    return { entries: kept, skipped };
}

/** The newest message id in this run's transcript — the mark to stamp on writes. */
export function transcriptHighWater(messages) {
    let hw = null;
    for (const m of (Array.isArray(messages) ? messages : [])) {
        const n = Number(m?.id ?? m?.index);
        if (Number.isFinite(n) && (hw === null || n > hw)) hw = n;
    }
    return hw;
}

// ---------------------------------------------------------------- the call

/**
 * One generation round: a single `generate` call, then a single "JSON only"
 * retry when the first reply is unusable. `generate(prompt) => Promise<string>`
 * is the injected LLM call (retry/backoff lives in stmemory.js's fetchWithRetry).
 * @returns {{entries:Array<object>, dropped:number}|null}
 */
export async function generateOneShotEntries({ generate, prompt, cfg = {} }) {
    let reply = await generate(prompt);
    let parsed = parseOneShotEntries(reply, cfg);
    if (parsed === null) {
        reply = await generate(`${prompt}\n\n${ONE_SHOT_JSON_ONLY_REPRIMAND}`);
        parsed = parseOneShotEntries(reply, cfg);
    }
    return parsed;
}

/**
 * Human-readable summary of a one-shot run, for the toast and the job detail.
 *
 * `inferred` and `renamed` are the first real CONSUMERS of the per-fact
 * provenance stamped on each entry (review finding 4: written but never
 * read). This is a surfaced signal for a human to act on, not automated
 * reconciliation — the one-shot path is architecturally a single call with
 * nothing downstream to reconcile against, so "reconciliation re-checks it"
 * from the original issue text does not apply here the way it does on the
 * chunked path's reconciliation pass.
 */
export function summarizeOneShot({
    created = 0, updated = 0, dropped = 0, collisions = [], keywordless = 0,
    skipped = [], contradictions = [], inferred = 0, renamed = [], frozen = 0,
} = {}) {
    const parts = [`one-shot lorebook: ${created} created, ${updated} updated`];
    if (frozen) parts.push(`${frozen} settled entr${frozen === 1 ? 'y' : 'ies'} left alone (incremental)`);
    if (skipped.length) parts.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} unchanged, skipped`);
    if (contradictions.length) parts.push(`${contradictions.length} human-verified entr${contradictions.length === 1 ? 'y' : 'ies'} contradicted by new source (kept, reported)`);
    if (renamed.length) parts.push(`${renamed.length} rename${renamed.length === 1 ? '' : 's'} of a pinned entry ignored (kept the human-verified title)`);
    if (dropped) parts.push(`${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} dropped`);
    if (collisions.length) parts.push(`${collisions.length} keyword collision${collisions.length === 1 ? '' : 's'} resolved`);
    if (keywordless) parts.push(`${keywordless} entr${keywordless === 1 ? 'y' : 'ies'} left without a free keyword`);
    if (inferred) parts.push(`${inferred} entr${inferred === 1 ? 'y' : 'ies'} written with an unstated (inferred) claim — worth a source check`);
    return parts.join(' · ');
}
