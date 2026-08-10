// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — context-window budgeting (PHA-1862).
//
// Every work-unit size in the fork used to be a static constant: the auditor's
// chunkSize=40/tokenCap=20000, the auto-run's memoryInterval=26, the coverage
// job's tokenBudget=12000. Nothing anywhere read the model's context window,
// so an 8k model and a 256k model chunked the story identically — which is why
// a 128k-context preset still produced dozens of tiny, mutually-blind calls and
// the resulting lorebook entries kept claiming each other's keywords.
//
// This module is the missing input. It resolves the usable context window once
// and derives every work-unit size from it, so a large-context model reads the
// story in a few big passes (ideally one) instead of many small ones. Pure
// functions, DI everywhere — no SillyTavern imports, testable under node:test.

/**
 * Context-window sizing policy.
 *
 * `TARGET` is the size we assume when we cannot detect anything (the user's
 * stated target: modern hosted and self-hosted models alike reach 256k).
 * `FLOOR` is the smallest window we will scale down to before treating the
 * model as "small" and falling back to conservative legacy-ish chunking.
 */
export const CONTEXT_BUDGET_DEFAULTS = Object.freeze({
    target: 256000,
    floor: 64000,
    // Fraction of the window we are willing to fill with story text. The rest
    // is headroom for the system/preset prompt, the existing lorebook that gets
    // injected as reference, and the model's own output.
    inputFraction: 0.6,
    // Fraction of the window reserved for output when no explicit cap is set.
    outputFraction: 0.15,
    // Hard ceiling on a single request's output tokens. The user observed a 20k
    // effective output cap; that is a context-derived consequence, not a
    // separate limit, so we derive it rather than hardcode it.
    maxOutputTokens: 32000,
});

/** Chars-per-token heuristic shared with constants.js / auditorCore.js. */
const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a string using the fork's standard chars/4 heuristic. */
export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

const toPositiveInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Resolve the model's usable context window, in tokens.
 *
 * Precedence, highest first:
 *   1. explicit user override (per-chat, then global settings)
 *   2. whatever the host reports (chat-completion max context, textgen max
 *      context, or a `getMaxContextSize()`-style callback)
 *   3. CONTEXT_BUDGET_DEFAULTS.target
 *
 * Every source is optional; each is read defensively because the host's shape
 * differs per API backend and we must never throw here — a bad reading should
 * degrade to the default, not abort the run.
 *
 * @param {object} sources
 * @param {number} [sources.override]        - user-set contextWindow (global)
 * @param {number} [sources.perChatOverride] - user-set contextWindow (per-chat)
 * @param {object} [sources.oaiSettings]     - SillyTavern `oai_settings`
 * @param {object} [sources.textgenSettings] - SillyTavern textgen settings
 * @param {function} [sources.getMaxContextSize] - host callback
 * @returns {number} usable context window in tokens, never below `floor`
 */
export function resolveContextWindow(sources = {}) {
    const {
        override,
        perChatOverride,
        oaiSettings,
        textgenSettings,
        getMaxContextSize,
    } = sources;

    const explicit = toPositiveInt(perChatOverride) || toPositiveInt(override);
    if (explicit) return explicit;

    let detected = 0;
    try {
        detected = toPositiveInt(oaiSettings?.openai_max_context)
            || toPositiveInt(textgenSettings?.max_context_length)
            || toPositiveInt(textgenSettings?.truncation_length)
            || (typeof getMaxContextSize === 'function' ? toPositiveInt(getMaxContextSize()) : 0);
    } catch {
        detected = 0; // host threw (unconfigured backend) — fall through to the default
    }

    if (!detected) return CONTEXT_BUDGET_DEFAULTS.target;

    // Detected windows below the floor are honoured as-is (an 8k model really
    // is 8k); we simply won't pretend it can one-shot anything.
    return detected;
}

/**
 * Derive every work-unit budget from a context window.
 *
 * The shape of the answer is deliberately simple: one number, `inputTokens`,
 * is the amount of story text we may put in front of the model in a single
 * call. Audit chunks, scene chunks and coverage excerpts are all just that
 * number (or a share of it), rather than three unrelated constants.
 *
 * @param {number} contextWindow - tokens, as returned by resolveContextWindow
 * @param {object} [policy] - overrides for CONTEXT_BUDGET_DEFAULTS
 * @returns {{contextWindow:number, inputTokens:number, outputTokens:number,
 *            auditTokenCap:number, coverageTokenBudget:number,
 *            isLargeContext:boolean}}
 */
export function planContextBudget(contextWindow, policy = {}) {
    const cfg = { ...CONTEXT_BUDGET_DEFAULTS, ...policy };
    const window = toPositiveInt(contextWindow) || cfg.target;

    const inputTokens = Math.max(1000, Math.floor(window * cfg.inputFraction));
    const outputTokens = Math.min(
        cfg.maxOutputTokens,
        Math.max(1000, Math.floor(window * cfg.outputFraction)),
    );

    return {
        contextWindow: window,
        inputTokens,
        outputTokens,
        // The auditor gets the full input budget: reading more of the story per
        // pass is the entire point.
        auditTokenCap: inputTokens,
        // Coverage re-derivation shares the window with the existing lorebook
        // and the entity's prior body, so it gets half.
        coverageTokenBudget: Math.max(1000, Math.floor(inputTokens / 2)),
        isLargeContext: window >= cfg.floor,
    };
}

/**
 * Does the whole story fit in one call?
 *
 * This is the question the old architecture never asked. When the answer is
 * yes, the caller should stop chunking entirely and hand the model the full
 * transcript — one call that can see every character and every entry at once,
 * which is the only way keyword assignment can be globally consistent.
 *
 * @param {number} storyTokens - estimated tokens of the full transcript
 * @param {object} budget - result of planContextBudget
 * @returns {boolean}
 */
export function fitsInOneCall(storyTokens, budget) {
    const tokens = toPositiveInt(storyTokens);
    if (!tokens) return false;
    return budget?.isLargeContext === true && tokens <= toPositiveInt(budget?.inputTokens);
}

/**
 * Plan how many passes the story needs, and how many tokens each may hold.
 *
 * Returns `passes: 1` whenever the story fits — callers use that to take the
 * one-shot path. Otherwise the story is split into the FEWEST equal passes
 * that fit, rather than into fixed-size slices: 10 passes of 60% each beats
 * 40 passes of 15% each, both for coherence and for cost.
 *
 * @param {number} storyTokens
 * @param {object} budget - result of planContextBudget
 * @returns {{passes:number, tokensPerPass:number, oneShot:boolean}}
 */
export function planPasses(storyTokens, budget) {
    const tokens = toPositiveInt(storyTokens);
    const cap = toPositiveInt(budget?.inputTokens) || CONTEXT_BUDGET_DEFAULTS.target;
    if (!tokens) return { passes: 0, tokensPerPass: cap, oneShot: false };

    if (fitsInOneCall(tokens, budget)) {
        return { passes: 1, tokensPerPass: tokens, oneShot: true };
    }

    const passes = Math.ceil(tokens / cap);
    return { passes, tokensPerPass: Math.ceil(tokens / passes), oneShot: false };
}

/**
 * Slice a message list into the fewest token-bounded passes.
 *
 * Same greedy fill as auditorCore.planChunks, but with no message-count cap —
 * the only limit is the token budget, because a message count is a proxy for
 * size and we now have the real thing. A single message larger than the budget
 * still gets its own pass rather than being dropped.
 *
 * @param {Array<{id:number, text:string}>} messages
 * @param {number} tokensPerPass
 * @param {function} [estimator] - defaults to the chars/4 heuristic
 * @returns {Array<{start:number, end:number, tokens:number}>}
 */
export function planTokenBoundedPasses(messages, tokensPerPass, estimator = estimateTokens) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) return [];
    const cap = toPositiveInt(tokensPerPass) || CONTEXT_BUDGET_DEFAULTS.target;

    const passes = [];
    let current = null;

    for (let i = 0; i < list.length; i++) {
        const cost = Math.max(1, toPositiveInt(estimator(list[i]?.text)) || 1);
        if (current && current.tokens + cost > cap) {
            passes.push(current);
            current = null;
        }
        if (!current) {
            current = { start: i, end: i, tokens: cost };
        } else {
            current.end = i;
            current.tokens += cost;
        }
    }
    if (current) passes.push(current);
    return passes;
}
