// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — ledgered chunked lorebook generation, runtime binding (PHA-1879).
//
// Pure logic lives in chunkedLorebookCore.js; this file is the only part that
// touches SillyTavern (chat, world info, connection profiles, the LLM call).
//
// /stmb-auto asks `planOneShotRun()` whether the story fits in one call. When it
// does NOT, this is what runs instead of the per-entity coverage loop: the same
// entry set, written by N passes that can see each other's work through a
// ledger, closed by a reconciliation pass, and marked where it is degraded.

import { chat, chat_metadata } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';
import { getContext as getStContext } from '../../../extensions.js';
import { extractAuditMessages } from './auditorCore.js';
import { upsertLorebookEntryByTitle } from './addlore.js';
import { requestCompletion } from './stmemory.js';
import { resolveJobsConnection, entriesForCoverage } from './auditorJobs.js';
import {
    resolveContextWindow,
    planContextBudget,
    estimateTokens,
} from './contextBudget.js';
import {
    collectClaimedKeywords,
    enforceGlobalKeywordUniqueness,
    formatExistingEntries,
} from './oneShotLorebookCore.js';
import {
    CHUNKED_DEFAULTS,
    applyReconciliation,
    buildPassPrompt,
    buildReconcilePrompt,
    createLedger,
    formatDraftEntries,
    formatLedger,
    formatPassTranscript,
    formatQuestions,
    generateWithRetry,
    markDegradedEntries,
    parsePassReply,
    parseReconcileReply,
    planChunkedBudget,
    planLedgerPasses,
    planReconciliation,
    recordPass,
    summarizeChunked,
} from './chunkedLorebookCore.js';

const LOG = 'STMemoryBooks: Chunked';

/**
 * Merge chunked configuration from global settings and per-chat metadata over
 * the defaults, same precedence as resolveOneShotConfig (per-chat wins).
 */
export function resolveChunkedConfig(autoModule, chatMetadata) {
    const global = autoModule?.chunkedLorebook || {};
    const perChat = chatMetadata?.stmbc?.chunkedLorebook || {};
    const cfg = { ...CHUNKED_DEFAULTS, enabled: true, profile: undefined };

    for (const key of [
        'truncate', 'maxEntries', 'maxEntriesPerPass', 'minContentChars', 'order',
        'ledgerFraction', 'reconcileFraction', 'boundaryMinFill', 'maxUnresolved',
        'enabled', 'profile',
    ]) {
        if (global[key] != null) cfg[key] = global[key];
        if (perChat[key] != null) cfg[key] = perChat[key];
    }
    if (typeof global.passPrompt === 'string' && global.passPrompt.trim()) cfg.passPrompt = global.passPrompt;
    if (typeof perChat.passPrompt === 'string' && perChat.passPrompt.trim()) cfg.passPrompt = perChat.passPrompt;
    if (typeof global.reconcilePrompt === 'string' && global.reconcilePrompt.trim()) cfg.reconcilePrompt = global.reconcilePrompt;
    if (typeof perChat.reconcilePrompt === 'string' && perChat.reconcilePrompt.trim()) cfg.reconcilePrompt = perChat.reconcilePrompt;
    cfg.enabled = cfg.enabled !== false;
    return cfg;
}

/**
 * Plan a chunked run: the messages, the budget split, and the pass boundaries.
 *
 * `/stmb-auto` already has a `planOneShotRun()` result in hand when it lands
 * here, so it passes it in as `oneShotPlan` and we reuse those numbers rather
 * than re-deriving them — the decision and the work must read from the same
 * context window, which is the whole lesson of PHA-1862.
 *
 * @returns {{ok:boolean, reason:string, messages:Array, passes:Array,
 *            chunkedBudget:object, budget:object, cfg:object}}
 */
export function planChunkedRun({ autoModule, chatMetadata, chatArray, oneShotPlan } = {}) {
    const meta = chatMetadata ?? (typeof chat_metadata === 'object' ? chat_metadata : {});
    const cfg = resolveChunkedConfig(autoModule, meta);
    const messages = oneShotPlan?.messages?.length
        ? oneShotPlan.messages
        : extractAuditMessages(chatArray ?? chat);

    const budget = oneShotPlan?.budget || planContextBudget(resolveContextWindow({
        override: autoModule?.contextWindow,
        perChatOverride: meta?.stmbc?.contextWindow,
        oaiSettings: typeof oai_settings !== 'undefined' ? oai_settings : undefined,
        getMaxContextSize: () => getStContext()?.maxContext,
    }));

    const chunkedBudget = planChunkedBudget(budget, cfg);

    if (!cfg.enabled) {
        return { ok: false, reason: 'chunked lorebook generation is disabled in settings', messages, passes: [], chunkedBudget, budget, cfg };
    }
    if (!messages.length) {
        return { ok: false, reason: 'no readable messages in this chat', messages, passes: [], chunkedBudget, budget, cfg };
    }

    const passes = planLedgerPasses(messages, chunkedBudget.passInputTokens, {
        minFill: cfg.boundaryMinFill,
        estimator: estimateTokens,
    });

    return {
        ok: passes.length > 0,
        reason: `story needs ${passes.length} pass${passes.length === 1 ? '' : 'es'} of ~${chunkedBudget.passInputTokens} tokens`,
        messages,
        passes,
        chunkedBudget,
        budget,
        cfg,
    };
}

/** A single call bound to a connection. Output is sized from the budget. */
function makeGenerate(conn, maxTokens) {
    return async (prompt) => {
        const { text } = await requestCompletion({
            api: conn.api,
            model: conn.model,
            endpoint: conn.endpoint,
            apiKey: conn.apiKey,
            reverseProxy: conn.reverseProxy,
            prompt,
            temperature: 0,            // deterministic extraction, same as the walk
            extra: { max_tokens: maxTokens },
        });
        return text;
    };
}

/**
 * Generate the entry set for a story too large to read at once, carrying a
 * ledger through the passes and reconciling at the end.
 *
 * Scene-memory entries (`stmemorybooks === true`) are shown to the model as
 * context but never rewritten — they are the chronological record, not lore, and
 * their keywords are unconditionally off-limits.
 *
 * @param {object} args
 * @param {{name:string, data:object}} args.lorebook  bound lorebook
 * @param {object} args.plan                          result of planChunkedRun
 * @param {function} [args.onProgress]
 * @param {function} [args.generate]                  DI override for tests
 * @returns {{ok:boolean, message:string, created:number, updated:number,
 *            collisions:Array, unresolved:Array, degraded:number, entries:Array}}
 */
export async function runChunkedLorebook({ lorebook, plan, onProgress, generate } = {}) {
    const fail = (message) => ({
        ok: false, message, created: 0, updated: 0,
        collisions: [], unresolved: [], degraded: 0, entries: [],
    });
    if (!lorebook?.name || !lorebook?.data) return fail('No bound lorebook to write to.');
    if (!plan?.ok) return fail(`Not a chunked run: ${plan?.reason || 'unknown'}`);

    const cfg = plan.cfg || {};
    const { passes, messages, chunkedBudget } = plan;
    const existing = entriesForCoverage(lorebook.data);
    const existingText = formatExistingEntries(existing);

    const conn = resolveJobsConnection(cfg.profile);
    const call = typeof generate === 'function'
        ? generate
        : makeGenerate(conn, chunkedBudget.outputTokens);

    // Keyword claims held by the book. Scene memories are never rewritten here,
    // so their keys are permanently taken; ordinary lore entries release theirs
    // only if this run actually rewrites that title (checked per pass, since the
    // set of rewritten titles grows as passes land).
    const lorePool = existing.filter(e => !e.isMemory);
    const memoryClaims = collectClaimedKeywords(existing.filter(e => e.isMemory));
    const claimsFor = (draft) => {
        const rewritten = new Set(draft.map(e => String(e.title ?? '').trim().toLowerCase()));
        const claimed = collectClaimedKeywords(lorePool, rewritten);
        for (const k of memoryClaims) claimed.add(k);
        return claimed;
    };

    let ledger = createLedger();
    let draft = [];
    let dropped = 0;
    let overflow = 0;
    let ledgerTruncations = 0;

    // ---- the passes
    for (const pass of passes) {
        const n = pass.index + 1;
        onProgress?.(`Reading pass ${n}/${passes.length} (messages ${messages[pass.start]?.id ?? pass.start}-${messages[pass.end]?.id ?? pass.end})…`);

        const rendered = formatLedger(ledger, chunkedBudget.ledgerTokens);
        if (rendered.truncated) {
            ledgerTruncations++;
            console.info(`${LOG}: ledger for pass ${n} shortened to "${rendered.truncated}" to fit ~${chunkedBudget.ledgerTokens} tokens (${ledger.entities.length} entities carried).`);
        }

        const prompt = buildPassPrompt({
            transcriptText: formatPassTranscript(messages, pass, cfg.truncate),
            existingText,
            ledgerText: rendered.text,
            passNumber: n,
            passTotal: passes.length,
            maxEntries: cfg.maxEntriesPerPass,
            template: cfg.passPrompt,
        });

        let parsed = null;
        try {
            parsed = await generateWithRetry({
                generate: call,
                prompt,
                parse: (reply) => parsePassReply(reply, cfg),
            });
        } catch (error) {
            // One dead pass must not lose the passes that already landed.
            console.warn(`${LOG}: pass ${n} failed`, error);
        }
        if (!parsed) {
            console.warn(`${LOG}: pass ${n} produced no usable output; continuing with the ledger so far.`);
            continue;
        }

        dropped += parsed.dropped || 0;
        const folded = recordPass({
            ledger,
            draft,
            entries: parsed.entries,
            unresolved: parsed.unresolved,
            pass,
            claimedByExisting: claimsFor(draft),
            maxEntries: cfg.maxEntries,
            maxUnresolved: cfg.maxUnresolved,
        });
        ledger = folded.ledger;
        draft = folded.draft;
        overflow += folded.overflow;
    }

    if (!draft.length) {
        return fail('The model returned no usable entries across any chunked pass.');
    }

    // ---- reconciliation
    const draftText = formatDraftEntries(draft);
    const overhead = estimateTokens(draftText) + estimateTokens(existingText);
    const recon = planReconciliation(ledger, {
        reconcileTokens: chunkedBudget.reconcileTokens,
        overheadTokens: overhead,
    });
    if (recon.dropped.length) {
        console.info(`${LOG}: ${recon.dropped.length} open question(s) could not be re-read within the ~${chunkedBudget.reconcileTokens}-token reconciliation budget; their entries will be flagged degraded.`, recon.dropped);
    }

    let reconciled = false;
    let closed = 0;
    if (recon.items.length) {
        onProgress?.(`Reconciling ${recon.items.length} open cross-reference${recon.items.length === 1 ? '' : 's'}…`);
        const transcriptText = recon.passIndices
            .map(idx => passes.find(p => p.index === idx))
            .filter(Boolean)
            .map(p => `--- pass ${p.index + 1} ---\n${formatPassTranscript(messages, p, cfg.truncate)}`)
            .join('\n\n');

        const prompt = buildReconcilePrompt({
            transcriptText,
            existingText,
            draftText,
            questionsText: formatQuestions(recon.items),
            passTotal: passes.length,
            template: cfg.reconcilePrompt,
        });

        let result = null;
        try {
            result = await generateWithRetry({
                generate: call,
                prompt,
                parse: (reply) => parseReconcileReply(reply, cfg),
            });
        } catch (error) {
            console.warn(`${LOG}: reconciliation pass failed`, error);
        }
        if (result) {
            const applied = applyReconciliation({ draft, ledger, result, askedItems: recon.items });
            draft = applied.entries;
            ledger = { ...ledger, unresolved: applied.unresolved };
            closed = applied.closed;
            reconciled = true;
        }
    }

    // ---- final award pass, then honest marking
    const awarded = enforceGlobalKeywordUniqueness(draft, claimsFor(draft));
    const stillOpen = ledger.unresolved.filter(u => !u.resolved);
    const marked = markDegradedEntries(awarded.entries, stillOpen, passes.length);
    const entries = marked.entries;
    const collisions = [...ledger.collisions, ...awarded.collisions];

    // ---- write
    let written = 0;
    let createdWrites = 0;
    let updatedWrites = 0;
    let keywordless = 0;
    const failures = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.keywordless) keywordless++;
        try {
            onProgress?.(`Writing “${entry.title}” (${i + 1}/${entries.length})…`);
            const res = await upsertLorebookEntryByTitle(
                lorebook.name,
                lorebook.data,
                entry.title,
                entry.content,
                {
                    entryOverrides: {
                        key: entry.key,
                        keysecondary: entry.keysecondary,
                        selectiveLogic: entry.selectiveLogic,
                        // An entry with no free keyword must not be constant —
                        // it would burn budget on every single generation.
                        constant: entry.keywordless ? false : entry.constant,
                        order: entry.order,
                        position: entry.position,
                        scanDepth: entry.scanDepth,
                        preventRecursion: true,
                        // Keyless entries can still be reached by vector matching.
                        vectorized: true,
                        selective: entry.keysecondary.length > 0,
                        disable: false,
                        // PHA-1879: degradation is recorded in the book, not
                        // hidden. These live on the entry, not in its content,
                        // so they cost nothing at generation time.
                        stmbAutoPasses: entry.stmbAutoPasses,
                        stmbAutoDegraded: entry.stmbAutoDegraded === true,
                        ...(entry.stmbAutoDegraded ? { stmbAutoDegradedReason: entry.stmbAutoDegradedReason } : {}),
                    },
                    refreshEditor: i === entries.length - 1,
                },
            );
            written++;
            if (res.created) createdWrites++;
            else updatedWrites++;
        } catch (e) {
            console.warn(`${LOG}: could not write “${entry.title}”`, e);
            failures.push(`${entry.title}: ${e?.message || e}`);
        }
    }

    let message = summarizeChunked({
        passes: passes.length,
        created: createdWrites,
        updated: updatedWrites,
        dropped,
        collisions,
        keywordless,
        unresolved: stillOpen.length,
        closed,
        degraded: marked.degraded,
        reconciled,
        overflow,
        midSceneCuts: passes.filter(p => p.cutMidScene).length,
    });
    if (ledgerTruncations) message += ` · ledger shortened on ${ledgerTruncations} pass${ledgerTruncations === 1 ? '' : 'es'}`;
    if (failures.length) message += ` · ${failures.length} write failure${failures.length === 1 ? '' : 's'}: ${failures.slice(0, 3).join('; ')}`;

    return {
        ok: written > 0,
        message,
        created: createdWrites,
        updated: updatedWrites,
        collisions,
        unresolved: stillOpen,
        degraded: marked.degraded,
        entries,
    };
}

// Unused-but-intentional re-export: callers that only need the config shape
// (settings UI, tests) should not have to reach into the core.
export { CHUNKED_DEFAULTS };
