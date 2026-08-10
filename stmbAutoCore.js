// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — the "just run it" orchestrator's pure decision logic
// (PHA-1846). `/stmb-auto` is a zero-argument command that chains three
// existing pipelines over the WHOLE chat with no user input: the auditor
// walk (auditorCore.js), chunked scene-memory generation (the same primitive
// /stmb-catchup uses), and coverage-driven lorebook-entry generation
// (auditorJobsCore.js). This file only decides WHAT to run, never runs it —
// no ST imports, DI everywhere, so it is testable with plain node:test.

import { estimateTokens, planTokenBoundedPasses } from './contextBudget.js';

/**
 * Defaults for the auto-run. `memoryInterval` reuses the sentinel's
 * boundary-detection window size (autoSettings.js AUTO_MODULE_DEFAULTS.
 * windowSize, 26) rather than inventing a new magic number — there is no
 * single canonical "scene chunk size" elsewhere in the fork (the auditor's
 * chunkSize=40 is sized for entity extraction, not narrative summaries).
 * `coverageMinChunks` is 1 (not the coverage job's own default of 2) because
 * that gate is unsatisfiable on any chat small enough to fit in one audit
 * chunk (<= chunkSize messages) — every name maxes out at chunkCount===1, so
 * a from-scratch full-story run must not require repeat appearances to
 * notice a character exists at all.
 */
export const STMB_AUTO_DEFAULTS = Object.freeze({
    memoryInterval: 26,
    bulkGenerateCap: 60,
    coverageMinChunks: 1,
});

/**
 * Merge auto-run configuration: defaults <- global (autoModule.auto) <-
 * per-chat (chat_metadata.stmbc.auto). Same override shape as
 * resolveAuditConfig/resolveCoverageConfig.
 */
export function resolveStmbAutoConfig(autoModule, chatMetadata) {
    const global = autoModule?.auto || {};
    const perChat = chatMetadata?.stmbc?.auto || {};
    const cfg = { ...STMB_AUTO_DEFAULTS };
    for (const key of ['memoryInterval', 'bulkGenerateCap', 'coverageMinChunks']) {
        if (global[key] != null) cfg[key] = global[key];
        if (perChat[key] != null) cfg[key] = perChat[key];
    }
    // PHA-1870: same escape hatch the auditor uses. If the user pinned
    // memoryInterval by hand we keep the legacy fixed-interval slicing; if they
    // didn't, scene chunks get sized from the model's context window instead.
    cfg.memoryIntervalPinned = global.memoryInterval != null || perChat.memoryInterval != null;
    return cfg;
}

/**
 * Plan the scene-memory chunks for a full-story run: everything after the
 * last processed message through the end of the chat, sliced to `interval`
 * messages per chunk (same slicing rule /stmb-catchup uses). Returns `[]`
 * when there is nothing new (already caught up, or an out-of-range
 * watermark) — the caller treats an empty plan as a clean no-op, not a
 * failure.
 *
 * @param {number|null} highestProcessed - last message id already summarized, or null
 * @param {number} lastIndex - index of the last message in the chat (chat.length - 1)
 * @param {number} interval - messages per chunk
 * @returns {Array<{start:number, end:number}>}
 */
export function planAutoMemoryChunks(highestProcessed, lastIndex, interval) {
    if (!Number.isInteger(lastIndex) || lastIndex < 0) return [];
    const step = Number.isInteger(interval) && interval > 0 ? interval : STMB_AUTO_DEFAULTS.memoryInterval;
    const start = Number.isFinite(highestProcessed) ? highestProcessed + 1 : 0;
    if (start > lastIndex) return [];

    const chunks = [];
    for (let chunkStart = start; chunkStart <= lastIndex; chunkStart += step) {
        chunks.push({ start: chunkStart, end: Math.min(chunkStart + step - 1, lastIndex) });
    }
    return chunks;
}

/**
 * Build the {id, text} list for a message range, using a DI text accessor so
 * this stays free of any SillyTavern import.
 */
function collectRange(start, lastIndex, getText) {
    const messages = [];
    for (let i = start; i <= lastIndex; i++) {
        messages.push({ id: i, text: typeof getText === 'function' ? (getText(i) ?? '') : '' });
    }
    return messages;
}

/**
 * Token-bounded variant of planAutoMemoryChunks (PHA-1870).
 *
 * The fixed 26-message interval was a proxy for size chosen when nothing in the
 * fork could read the model's context window. Now that contextBudget.js can, a
 * scene chunk is exactly "as much story as one call may hold": a 256k model
 * writes a handful of large scene memories instead of dozens of tiny ones that
 * cannot see each other.
 *
 * @param {number|null} highestProcessed - last message id already summarized, or null
 * @param {number} lastIndex - index of the last message in the chat
 * @param {function(number):string} getText - message text by chat index
 * @param {number} tokensPerChunk - budget per chunk (contextBudget inputTokens)
 * @param {function} [estimator]
 * @returns {Array<{start:number, end:number, tokens:number}>}
 */
export function planTokenBoundedMemoryChunks(highestProcessed, lastIndex, getText, tokensPerChunk, estimator = estimateTokens) {
    if (!Number.isInteger(lastIndex) || lastIndex < 0) return [];
    const start = Number.isFinite(highestProcessed) ? highestProcessed + 1 : 0;
    if (start > lastIndex) return [];

    const passes = planTokenBoundedPasses(collectRange(start, lastIndex, getText), tokensPerChunk, estimator);
    return passes.map(p => ({ start: start + p.start, end: start + p.end, tokens: p.tokens }));
}

/**
 * Re-split any chunk that exceeds `tokenCap` so it fits (PHA-1870).
 *
 * This replaces the old behaviour at the non-interactive token gate, which
 * ABORTED the whole run when a chunk came in over the warning threshold. An
 * oversized chunk is a sizing mistake, not a user error: the fix is to cut it
 * smaller and carry on. The only genuinely unrunnable case is a SINGLE message
 * that alone exceeds the cap — nothing can make that fit, so it is reported
 * back as `oversized` and the caller aborts on that alone.
 *
 * @param {Array<{start:number, end:number}>} chunks
 * @param {function(number):string} getText
 * @param {number} tokenCap
 * @param {function} [estimator]
 * @returns {{chunks:Array<{start:number,end:number,tokens:number}>,
 *            oversized:Array<{id:number, tokens:number}>, resized:boolean}}
 */
export function resizeChunksToBudget(chunks, getText, tokenCap, estimator = estimateTokens) {
    const list = Array.isArray(chunks) ? chunks : [];
    const cap = Number.isFinite(tokenCap) && tokenCap > 0 ? Math.floor(tokenCap) : 0;
    const out = [];
    const oversized = [];
    let resized = false;

    for (const chunk of list) {
        const start = Number(chunk?.start);
        const end = Number(chunk?.end);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;

        const messages = collectRange(start, end, getText);
        const total = messages.reduce((sum, m) => sum + Math.max(1, estimator(m.text) || 1), 0);
        if (!cap || total <= cap) {
            out.push({ start, end, tokens: total });
            continue;
        }

        resized = true;
        for (const pass of planTokenBoundedPasses(messages, cap, estimator)) {
            const sub = { start: start + pass.start, end: start + pass.end, tokens: pass.tokens };
            if (pass.start === pass.end && pass.tokens > cap) {
                oversized.push({ id: sub.start, tokens: pass.tokens });
            }
            out.push(sub);
        }
    }

    return { chunks: out, oversized, resized };
}

/**
 * Render the final chat-facing summary for one /stmb-auto run. Pure string
 * formatting so the exact wording is unit-tested rather than eyeballed.
 */
export function buildStmbAutoSummary({
    lorebookName,
    lorebookCreated,
    auditMessage,
    memoriesPlanned,
    memoriesCreated,
    memorySkipReason,
    loreGenerated,
    loreSkipped,
    loreMessage,
} = {}) {
    const parts = ['STMB Auto complete.'];

    if (lorebookName) {
        parts.push(lorebookCreated
            ? `Created and bound lorebook "${lorebookName}".`
            : `Lorebook: "${lorebookName}".`);
    }

    if (auditMessage) parts.push(auditMessage);

    if (memorySkipReason) {
        parts.push(`Scene memories skipped: ${memorySkipReason}`);
    } else if (!memoriesPlanned) {
        parts.push('No new scenes to summarize.');
    } else {
        parts.push(`${memoriesCreated}/${memoriesPlanned} scene memor${memoriesPlanned === 1 ? 'y' : 'ies'} created.`);
    }

    if (loreMessage) {
        parts.push(loreMessage);
    } else if (!loreGenerated && !loreSkipped) {
        parts.push('No missing or thin character/location entries found.');
    }

    return parts.join(' ');
}
