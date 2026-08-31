// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// PHA-2675 — pure template substitution for auto-created lorebook names.
//
// The naive `template.replace('{{char}}', charName)` double-prefixes whenever a
// literal in the template is already carried by the substituted value: template
// `[E2E] {{char}} Memories` with char `[E2E] Test Wanderer` produced
// `[E2E] [E2E] Test Wanderer Memories`. This module substitutes segment-wise and
// drops the template's copy of any literal the neighbouring value already has.

// Letters/digits, Unicode-aware. Used for both "is this literal worth
// de-duplicating" and word-boundary checks.
const WORDISH = /[\p{L}\p{N}]/u;

const PLACEHOLDER_RE = /\{\{\s*(chat|char|user)\s*\}\}/g;

/**
 * Split a template into alternating literal / placeholder segments.
 * @param {string} template
 * @returns {Array<{literal?: string, key?: string}>}
 */
function splitTemplate(template) {
    const segments = [];
    let cursor = 0;
    let match;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
        if (match.index > cursor) segments.push({ literal: template.slice(cursor, match.index) });
        segments.push({ key: match[1] });
        cursor = match.index + match[0].length;
    }
    if (cursor < template.length) segments.push({ literal: template.slice(cursor) });
    return segments;
}

/** Whitespace-delimited tokens of `text`, with their offsets. */
function tokenize(text) {
    const tokens = [];
    const re = /\S+/g;
    let match;
    while ((match = re.exec(text)) !== null) tokens.push({ text: match[0], index: match.index });
    return tokens;
}

/**
 * `value` starts with `run`, on a word boundary (case-insensitive).
 */
function startsWithToken(value, run) {
    if (!value.toLowerCase().startsWith(run.toLowerCase())) return false;
    // A run ending in punctuation (e.g. "[E2E]") is self-delimiting.
    if (!WORDISH.test(run.charAt(run.length - 1))) return true;
    const next = value.charAt(run.length);
    return next === '' || !WORDISH.test(next);
}

/**
 * `value` ends with `run`, on a word boundary (case-insensitive).
 */
function endsWithToken(value, run) {
    if (!value.toLowerCase().endsWith(run.toLowerCase())) return false;
    if (!WORDISH.test(run.charAt(0))) return true;
    const prev = value.charAt(value.length - run.length - 1);
    return prev === '' || !WORDISH.test(prev);
}

/**
 * Drop the longest trailing token-run of `literal` that `value` already opens with.
 * Original spacing on the surviving part is preserved.
 */
function stripRedundantPrefix(literal, value) {
    if (!value) return literal;
    const tokens = tokenize(literal);
    for (let i = 0; i < tokens.length; i++) {
        const run = literal.slice(tokens[i].index).trimEnd();
        if (!WORDISH.test(run)) continue; // pure separators are layout, not identity
        if (startsWithToken(value, run)) return literal.slice(0, tokens[i].index);
    }
    return literal;
}

/**
 * Drop the longest leading token-run of `literal` that `value` already closes with.
 */
function stripRedundantSuffix(literal, value) {
    if (!value) return literal;
    const tokens = tokenize(literal);
    for (let n = tokens.length; n > 0; n--) {
        const end = tokens[n - 1].index + tokens[n - 1].text.length;
        const run = literal.slice(0, end).trimStart();
        if (!WORDISH.test(run)) continue;
        if (endsWithToken(value, run)) return literal.slice(end);
    }
    return literal;
}

/**
 * Substitute {{chat}}/{{char}}/{{user}} into a lorebook name template without
 * re-applying a prefix or suffix the substituted value already carries.
 *
 * @param {string} template - Template string with {{chat}}, {{char}}, {{user}} placeholders
 * @param {{chat?: string, char?: string, user?: string}} values - Substitution values
 * @returns {string} The rendered name, whitespace-normalized
 */
export function applyLorebookNameTemplate(template, values = {}) {
    const segments = splitTemplate(String(template ?? ''));
    const valueAt = (i) => {
        const seg = segments[i];
        if (!seg || !seg.key) return '';
        return String(values[seg.key] ?? '');
    };

    const rendered = segments.map((seg, i) => {
        if (seg.key) return valueAt(i);

        const left = valueAt(i - 1);
        const right = valueAt(i + 1);
        let literal = stripRedundantSuffix(seg.literal, left);
        literal = stripRedundantPrefix(literal, right);

        // A literal that vanished from between two values still has to separate them.
        if (literal === '' && left && right) return ' ';
        return literal;
    });

    return rendered.join('').replace(/\s{2,}/g, ' ').trim();
}
