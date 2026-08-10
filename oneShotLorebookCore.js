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
 * PHA-1862's original complaint was that the fork's prompts never say EXACTLY
 * what a good World Info entry looks like, so this one spells out the field
 * semantics from the current SillyTavern World Info docs:
 *
 *   key            — primary trigger keywords. Case-insensitive, matched against
 *                    the recent chat buffer. Plaintext keys cannot contain commas.
 *   keysecondary   — optional filter, only meaningful together with selectiveLogic.
 *   selectiveLogic — 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL.
 *   constant       — true = always inserted, no keyword needed (blue circle).
 *   order          — priority; LOWER inserts earlier, higher lands closer to the end.
 *   position       — 0 before char defs, 1 after char defs, 4 at depth.
 *   scanDepth      — how many recent messages to scan for this entry's keys.
 *   preventRecursion — once inserted, this entry cannot trigger others.
 *
 * {{TRANSCRIPT}} {{EXISTING}} {{MAX_ENTRIES}} are filled by buildOneShotPrompt.
 */
export const ONE_SHOT_PROMPT =
`You are building the COMPLETE SillyTavern World Info lorebook for the story below.
You can see the ENTIRE story and the ENTIRE existing lorebook at once, so you are
responsible for the whole entry set being mutually consistent. This is the only
call that will be made — nothing downstream will reconcile your entries.

WHAT A GOOD ENTRY LOOKS LIKE
Each entry is one JSON object. Field semantics (SillyTavern World Info):
- "title": the entry memo/label. Not sent to the AI and not a trigger; it exists
  so a human can find the entry. Use the subject's canonical name.
- "content": the text actually inserted into the prompt when the entry fires.
  Keywords and the title are NOT inserted, so content must be COMPLETELY
  SELF-CONTAINED: name the subject in the first sentence and never write "he",
  "the above", or "as mentioned". Concise and factual — every token here is taken
  out of the context budget. 3-8 sentences. Present tense for standing facts.
  Ground every claim in the transcript; do NOT invent anything.
- "key": the primary trigger keywords, an array of strings. Matching is
  case-insensitive and by whole word. Plaintext keys MUST NOT contain commas.
  List ONLY names/aliases/nicknames/titles that refer to THIS subject —
  typically 2-5. A keyword must be unique across the ENTIRE lorebook: if two
  entries share a keyword, both fire on every unrelated mention and burn the
  budget. When two subjects could claim the same word (a surname shared by a
  family, a place named after a person), give the shared word to exactly ONE
  entry — the one it most specifically identifies — and give the other entry a
  disambiguated form instead. Never use a generic common word ("the king",
  "home", "sword") as a key unless it uniquely identifies this subject in this
  story.
- "keysecondary": optional extra keywords used as a FILTER on top of "key".
  Leave it as [] unless the primary key is genuinely ambiguous. It does nothing
  on its own.
- "selectiveLogic": how keysecondary combines with key. 0 = AND ANY (fire if key
  and any secondary match), 1 = NOT ALL, 2 = NOT ANY (fire only if no secondary
  matches — use this to suppress a homonym), 3 = AND ALL. Use 0 when
  keysecondary is empty.
- "constant": true means the entry is ALWAYS inserted with no keyword needed.
  Reserve this for at most 1-2 entries that are load-bearing for every scene
  (the world premise, the current status quo). Everything else MUST be false —
  constant entries permanently consume budget.
- "order": insertion priority. LOWER numbers are inserted EARLIER in the
  context; higher numbers land closer to the end and carry more weight. Use 100
  for ordinary entries, 200 for entries that should dominate (the premise,
  hard rules), 50 for background colour.
- "position": 0 = before the character definition, 1 = after it. Use 1 for
  entries about the main characters and the current situation (greater
  influence), 0 for background world/location lore.
- "scanDepth": how many recent messages are scanned for this entry's keys.
  Use 2-4 for people and things that come and go; use a larger value only for
  entries that must survive a lull in mentions.
- "preventRecursion": true means this entry, once inserted, cannot trigger
  other entries. Set it to true for every entry here: these entries name each
  other in their own content, and without it one insertion cascades into all
  the others.
- "kind": one of "character", "location", "faction", "item", "event", "concept".

RULES
1. Cover every subject the story actually establishes, and nothing it does not.
   Do not create an entry for a one-off mention with no substance behind it.
2. Produce AT MOST {{MAX_ENTRIES}} entries. If the story has more subjects than
   that, keep the ones that recur and matter and drop the rest.
3. The EXISTING LOREBOOK below is already in the book. Reuse an existing entry's
   exact "title" to UPDATE it (write the improved full content — it will be
   replaced, not merged). Use a new title to create a new entry. Never create a
   second entry for a subject that already has one.
4. Keywords must not collide with the keywords already claimed by existing
   entries, listed below. Treat those as taken.
5. Do not write entries about the user's own persona's private thoughts, and do
   not summarize the plot beat by beat — that is what memory entries are for.

Reply with ONLY a JSON object of exactly this shape — no prose, no code fences:
{"entries":[{"title":"","kind":"","key":[],"keysecondary":[],"selectiveLogic":0,"constant":false,"order":100,"position":1,"scanDepth":3,"preventRecursion":true,"content":""}]}

EXISTING LOREBOOK (titles and the keywords they already claim):
{{EXISTING}}

STORY TRANSCRIPT (every message, numbered "[id] Speaker: text"):
{{TRANSCRIPT}}`;

/** Reprimand appended on the single retry when the first reply is unusable. */
export const ONE_SHOT_JSON_ONLY_REPRIMAND =
    'Reply with ONLY the JSON object described: {"entries":[{"title":"","kind":"","key":[],"keysecondary":[],"selectiveLogic":0,"constant":false,"order":100,"position":1,"scanDepth":3,"preventRecursion":true,"content":""}]}. No prose, no code fences.';

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
            if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.title === 'string') out.push(obj);
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
 * Parse and sanitize a one-shot reply into the entry set.
 *
 * Every field is clamped to something SillyTavern will actually accept, because
 * these values are written straight onto a world info entry: a model that emits
 * `"position": 9` or `"selectiveLogic": "AND ANY"` must not corrupt the book.
 * Entries without a title or without usable content are dropped rather than
 * guessed at — a partial book beats a book full of placeholders.
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
        const title = String(item.title ?? '').trim();
        const content = String(item.content ?? '').trim();
        if (!title || content.length < minContent) { dropped++; continue; }
        // A duplicate title inside one reply would make the two entries fight
        // over the same upsert target; keep the first, drop the rest.
        const titleKey = title.toLowerCase();
        if (seenTitles.has(titleKey)) { dropped++; continue; }
        seenTitles.add(titleKey);

        // Plaintext keys cannot contain commas (ST treats them as separators),
        // so split rather than silently shipping an unmatchable key.
        const splitKeys = (v) => strList(v).flatMap(k => k.split(',').map(x => x.trim()).filter(Boolean));

        out.push({
            title,
            kind: String(item.kind ?? '').trim().toLowerCase() || 'concept',
            key: splitKeys(item.key).length ? splitKeys(item.key) : [title],
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
            // Always on: these entries name each other, so recursion would make
            // one insertion cascade into the whole book.
            preventRecursion: true,
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
            const kind = String(entry.kind ?? '').trim();
            const candidates = title ? [title] : [];
            if (title && kind) candidates.push(`${title} (${kind})`);
            if (title) for (let n = 2; n <= 9; n++) candidates.push(`${title} (${kind || 'entry'} ${n})`);

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
