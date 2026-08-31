// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — one-shot whole-story lorebook generation, runtime binding (PHA-1871).
//
// Pure logic lives in oneShotLorebookCore.js; this file is the only part that
// touches SillyTavern (chat, world info, connection profiles, the LLM call).
// /stmb-auto asks `planOneShotRun()` whether the story fits in one call; when it
// does, it runs `runOneShotLorebook()` INSTEAD of the audit walk and the
// per-entity coverage loop, and every entry in the book is written by a single
// call that could see all of them at once.

import { extension_settings, getContext as getStContext } from '../../../extensions.js';
import { chat, chat_metadata } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';
import { extractAuditMessages } from './auditorCore.js';
import { upsertLorebookEntryByTitle } from './addlore.js';
import { requestCompletion } from './stmemory.js';
import { resolveJobsConnection, entriesForCoverage } from './auditorJobs.js';
import {
    resolveContextWindow,
    planContextBudget,
    fitsInOneCall,
    estimateTokens,
} from './contextBudget.js';
import {
    ONE_SHOT_DEFAULTS,
    ONE_SHOT_PROMPT,
    applyProvenancePinning,
    attributeSources,
    buildOneShotPrompt,
    collectClaimedKeywords,
    dropMemoryTitleCollisions,
    enforceGlobalKeywordUniqueness,
    formatExistingEntries,
    formatTranscript,
    generateOneShotEntries,
    hashContent,
    summarizeOneShot,
} from './oneShotLorebookCore.js';

const LOG = 'STMemoryBooks: OneShot';

/**
 * Merge one-shot configuration from global settings and per-chat metadata over
 * the defaults, same precedence as resolveAuditConfig (per-chat wins).
 * `enabled` defaults to true: the whole point of PHA-1871 is that a model big
 * enough to read the story does so.
 */
export function resolveOneShotConfig(autoModule, chatMetadata) {
    const global = autoModule?.oneShot || {};
    const perChat = chatMetadata?.stmbc?.oneShot || {};
    const cfg = { ...ONE_SHOT_DEFAULTS, enabled: true, profile: undefined };

    for (const key of ['truncate', 'maxEntries', 'minContentChars', 'order', 'enabled', 'profile']) {
        if (global[key] != null) cfg[key] = global[key];
        if (perChat[key] != null) cfg[key] = perChat[key];
    }
    if (typeof global.prompt === 'string' && global.prompt.trim()) cfg.prompt = global.prompt;
    if (typeof perChat.prompt === 'string' && perChat.prompt.trim()) cfg.prompt = perChat.prompt;
    cfg.enabled = cfg.enabled !== false;
    return cfg;
}

/**
 * Decide whether this chat can be done in one call, and hand back everything the
 * run needs so the decision and the work read from the SAME numbers.
 *
 * Returned `oneShot:false` is not an error — it means fall back to the chunked
 * audit-walk + coverage path, which is still the correct behaviour for a small
 * model or a story that outgrew the window.
 *
 * @returns {{oneShot:boolean, reason:string, messages:Array, transcript:string,
 *            storyTokens:number, budget:object, cfg:object}}
 */
export function planOneShotRun({ autoModule, chatMetadata, chatArray } = {}) {
    const meta = chatMetadata ?? (typeof chat_metadata === 'object' ? chat_metadata : {});
    const cfg = resolveOneShotConfig(autoModule, meta);
    const messages = extractAuditMessages(chatArray ?? chat);
    const transcript = formatTranscript(messages, cfg.truncate);
    const storyTokens = estimateTokens(transcript);

    const budget = planContextBudget(resolveContextWindow({
        override: autoModule?.contextWindow,
        perChatOverride: meta?.stmbc?.contextWindow,
        oaiSettings: typeof oai_settings !== 'undefined' ? oai_settings : undefined,
        getMaxContextSize: () => getStContext()?.maxContext,
    }));

    if (!cfg.enabled) {
        return { oneShot: false, reason: 'one-shot generation is disabled in settings', messages, transcript, storyTokens, budget, cfg };
    }
    if (!messages.length) {
        return { oneShot: false, reason: 'no readable messages in this chat', messages, transcript, storyTokens, budget, cfg };
    }
    if (!fitsInOneCall(storyTokens, budget)) {
        const reason = budget.isLargeContext
            ? `story is ~${storyTokens} tokens, over the ~${budget.inputTokens}-token single-call budget`
            : `model context window (${budget.contextWindow}) is too small for a single-call pass`;
        return { oneShot: false, reason, messages, transcript, storyTokens, budget, cfg };
    }
    return { oneShot: true, reason: `story fits in one call (~${storyTokens} of ~${budget.inputTokens} tokens)`, messages, transcript, storyTokens, budget, cfg };
}

/** Single whole-story call bound to a connection. Output is sized from the budget. */
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
 * Generate the COMPLETE entry set for the bound lorebook in one call and write it.
 *
 * Scene-memory entries (`stmemorybooks === true`) are shown to the model as
 * context but never rewritten — they are the chronological record, not lore.
 *
 * @param {object} args
 * @param {{name:string, data:object}} args.lorebook  bound lorebook (loadBoundLorebook)
 * @param {object} args.plan                          result of planOneShotRun
 * @param {function} [args.onProgress]
 * @param {function} [args.generate]                  DI override for tests
 * @returns {{ok:boolean, message:string, created:number, updated:number,
 *             collisions:Array, entries:Array}}
 */
export async function runOneShotLorebook({ lorebook, plan, onProgress, generate } = {}) {
    if (!lorebook?.name || !lorebook?.data) {
        return { ok: false, message: 'No bound lorebook to write to.', created: 0, updated: 0, collisions: [], entries: [] };
    }
    if (!plan?.oneShot) {
        return { ok: false, message: `Not a one-shot run: ${plan?.reason || 'unknown'}`, created: 0, updated: 0, collisions: [], entries: [] };
    }

    const cfg = plan.cfg || {};
    const existing = entriesForCoverage(lorebook.data);
    const lorePool = existing.filter(e => !e.isMemory);

    const prompt = buildOneShotPrompt({
        transcriptText: plan.transcript,
        existingText: formatExistingEntries(existing),
        maxEntries: cfg.maxEntries,
        template: cfg.prompt || ONE_SHOT_PROMPT,
    });

    onProgress?.(`Reading the whole story in one pass (~${plan.storyTokens} tokens)…`);

    const conn = resolveJobsConnection(cfg.profile);
    const call = typeof generate === 'function'
        ? generate
        : makeGenerate(conn, plan.budget?.outputTokens || 8000);

    const parsed = await generateOneShotEntries({ generate: call, prompt, cfg });
    if (!parsed) {
        return { ok: false, message: 'The model returned no usable entry set for the one-shot pass.', created: 0, updated: 0, collisions: [], entries: [] };
    }

    // A model that echoes a scene-memory title back would have its lore written
    // straight over the chronological record — the upsert matches on comment.
    const guarded = dropMemoryTitleCollisions(parsed.entries, existing);
    if (guarded.skipped.length) {
        console.warn(`${LOG}: skipped ${guarded.skipped.length} entr${guarded.skipped.length === 1 ? 'y' : 'ies'} whose title collides with a scene memory:`, guarded.skipped);
    }
    if (!guarded.entries.length) {
        return { ok: false, message: 'Every generated entry collided with an existing scene memory; nothing was written.', created: 0, updated: 0, collisions: [], entries: [] };
    }

    // Titles this run is rewriting release their old keywords back into the pool;
    // every other existing entry keeps its claims.
    const rewritten = new Set(guarded.entries.map(e => e.title.trim().toLowerCase()));
    const claimedByExisting = collectClaimedKeywords(lorePool, rewritten);
    // Scene memories keep their keywords unconditionally — this pass never
    // rewrites them, so stealing their keys would silently break retrieval.
    for (const k of collectClaimedKeywords(existing.filter(e => e.isMemory))) claimedByExisting.add(k);

    const { entries, collisions } = enforceGlobalKeywordUniqueness(guarded.entries, claimedByExisting);

    // PHA-2681: a hand-edited entry is pinned and skipped rather than
    // re-derived from the same ambiguous source, and a genuine source
    // contradiction against it is reported rather than silently applied. An
    // entry whose FRESH regeneration happens to hash-match what's already on
    // disk also costs zero write calls — but that is a byte-identical-by-luck
    // case, not the "unchanged source stays unchanged" guarantee: this path
    // still regenerates every entry from scratch, so it does NOT by itself
    // stop ordinary re-wording drift on unchanged source (that needs Build
    // item 5 — regenerate only entities whose source actually changed —
    // tracked as a pulled-back acceptance criterion on PHA-2681, built in
    // PHA-2693).
    const pinning = applyProvenancePinning(entries, existing);

    let created = 0;
    let updated = 0;
    let keywordless = 0;
    let inferred = 0;
    const failures = [];
    const toWrite = pinning.toWrite;

    for (let i = 0; i < toWrite.length; i++) {
        const entry = toWrite[i];
        if (entry.keywordless) keywordless++;
        const { confidence } = attributeSources(entry.content, plan.messages);
        if (confidence === 'inferred') inferred++;
        try {
            onProgress?.(`Writing “${entry.title}” (${i + 1}/${toWrite.length})…`);
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
                        preventRecursion: entry.preventRecursion,
                        caseSensitive: entry.caseSensitive,
                        probability: entry.probability,
                        useProbability: entry.useProbability,
                        // Keyless entries can still be reached by vector matching.
                        vectorized: true,
                        selective: entry.keysecondary.length > 0,
                        disable: false,
                        // Provenance (PHA-2681/PHA-2722): the model attaches its
                        // own `src: msgs X–Y` lines in `content` now (the one
                        // format every writer + `runClaimReverification` share —
                        // see ERROR_CONTROL_RULES in the prompt). `stmbAutoConfidence`
                        // is the only provenance-derived entry property: a
                        // zero-token, post-hoc rollup used purely as a ranking
                        // signal (which entries to recheck first), not a second
                        // record of the citations themselves.
                        stmbAutoContentHash: hashContent(entry.content),
                        stmbAutoConfidence: confidence,
                        stmbAutoVerifiedByHuman: false,
                    },
                    // Only the last write needs to refresh the editor.
                    refreshEditor: i === toWrite.length - 1,
                },
            );
            if (res.created) created++;
            else updated++;
        } catch (e) {
            console.warn(`${LOG}: could not write “${entry.title}”`, e);
            failures.push(`${entry.title}: ${e?.message || e}`);
        }
    }

    // Latch the pin: the first run to notice a human edited an entry stamps
    // stmbAutoVerifiedByHuman so it stays pinned even once the hash mismatch
    // that revealed it is gone (the human's content IS the new baseline).
    if (pinning.newlyPinned.length) {
        for (const { title } of pinning.newlyPinned) {
            const prior = existing.find(e => String(e?.title ?? '').trim().toLowerCase() === title.trim().toLowerCase());
            if (!prior) continue;
            try {
                await upsertLorebookEntryByTitle(lorebook.name, lorebook.data, title, prior.content, {
                    entryOverrides: {
                        stmbAutoVerifiedByHuman: true,
                        stmbAutoContentHash: hashContent(prior.content),
                    },
                    refreshEditor: false,
                });
            } catch (e) {
                console.warn(`${LOG}: could not pin human edit on “${title}”`, e);
            }
        }
    }

    let message = summarizeOneShot({
        created, updated, dropped: parsed.dropped + guarded.skipped.length, collisions, keywordless,
        skipped: pinning.skipped, contradictions: pinning.contradictions,
        inferred, renamed: pinning.renamed,
    });
    if (pinning.renamed.length) {
        console.warn(`${LOG}: ${pinning.renamed.length} rename${pinning.renamed.length === 1 ? '' : 's'} of a pinned entry ignored, kept the human-verified title:`,
            pinning.renamed.map(r => `${r.from} -> ${r.to}`));
    }
    if (pinning.contradictions.length) {
        console.warn(`${LOG}: ${pinning.contradictions.length} human-verified entr${pinning.contradictions.length === 1 ? 'y' : 'ies'} contradicted by new source, kept as-is:`,
            pinning.contradictions.map(c => c.title));
    }
    if (failures.length) message += ` · ${failures.length} write failure${failures.length === 1 ? '' : 's'}: ${failures.slice(0, 3).join('; ')}`;

    return {
        ok: created + updated > 0 || pinning.skipped.length > 0,
        message, created, updated, collisions, entries,
        skipped: pinning.skipped, contradictions: pinning.contradictions,
    };
}
