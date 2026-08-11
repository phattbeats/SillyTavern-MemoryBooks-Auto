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
 * @param {Array<{title:string, keys:string[], isMemory?:boolean}>} entries
 */
export function formatExistingEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const lines = [];
    for (const e of list) {
        const title = String(e?.title ?? '').trim();
        if (!title) continue;
        const keys = (Array.isArray(e?.keys) ? e.keys : [])
            .map(k => String(k ?? '').trim())
            .filter(Boolean);
        const tag = e?.isMemory ? ' [scene memory — do not rewrite]' : '';
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
 * Make global keyword uniqueness a guarantee rather than an instruction.
 *
 * A keyword claimed by more than one generated entry is awarded to exactly one
 * of them and stripped from the others. The winner is chosen deterministically,
 * most specific first:
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
 * @returns {{entries:Array<object>, collisions:Array<{keyword:string, winner:string, strippedFrom:string[]}>}}
 */
export function enforceGlobalKeywordUniqueness(entries, claimedByExisting = new Set()) {
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
                });
            }
            continue;
        }
        if (group.length === 1) { awarded.set(keyword, group[0].idx); continue; }

        const exact = group.find(g => normalizeKeyword(list[g.idx].title) === keyword);
        const contained = group.find(g => wholeWord(normalizeKeyword(list[g.idx].title), keyword));
        const winner = exact || contained || group[0];
        awarded.set(keyword, winner.idx);
        collisions.push({
            keyword,
            winner: list[winner.idx].title,
            strippedFrom: group.filter(g => g.idx !== winner.idx).map(g => list[g.idx].title),
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
 */
export function summarizeOneShot({ created = 0, updated = 0, dropped = 0, collisions = [], keywordless = 0 } = {}) {
    const parts = [`one-shot lorebook: ${created} created, ${updated} updated`];
    if (dropped) parts.push(`${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} dropped`);
    if (collisions.length) parts.push(`${collisions.length} keyword collision${collisions.length === 1 ? '' : 's'} resolved`);
    if (keywordless) parts.push(`${keywordless} entr${keywordless === 1 ? 'y' : 'ies'} left without a free keyword`);
    return parts.join(' · ');
}
