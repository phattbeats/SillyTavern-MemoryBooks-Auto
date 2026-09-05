#!/usr/bin/env node
// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 phattbeats
// SPDX-License-Identifier: AGPL-3.0-only
//
// eval/runIncrementalReplay.js — PHA-2693 N-slice replay report.
//
// Runs the verification section of PHA-2693 end to end and writes the evidence
// artifact: drift, correction durability, idempotence, regenerated-vs-total per
// step, a 5-entry provenance spot-check, and cost with input and output kept
// apart.
//
// WHAT THIS RUNS AGAINST, AND WHY IT IS NOT MAGISA
// -------------------------------------------------
// PHA-2693 asks for this against the Magisa story and its hand-built 52-entry
// reference book. Neither ships any more: `2e5b3fc` ("chore(privacy): stop
// shipping personal roleplay eval fixtures") removed `fixtures/transcript.jsonl`
// and `fixtures/worldbook.json`, and the surviving `materials/stmb-auto/…md` is
// a prose export with no reliable per-message boundaries to index provenance
// against — deriving ids from it would produce `src: msgs` citations that are
// wrong in a way this harness cannot detect, which is worse than not running it.
//
// So the DEFAULT fixture is a small committed synthetic story. Every property
// under test here is structural (does an entry the run declared settled come
// back byte-identical; does a hand-edit survive; how many entries were rewritten
// out of how many) and none of them depend on the prose being real. What the
// synthetic fixture CANNOT stand in for is Tier 2 coverage — "did the tool find
// the 52 entities a human found" — which needs the reference book and is
// reported as not-run rather than approximated.
//
// Point `--fixture` at a real transcript to run it for real; see --help.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    replayNSlices,
    runOneShotStep,
    provenanceSpotCheck,
    compareCost,
    withCostTracking,
} from './rewriteAcceptance.js';
import { formatTranscript } from '../oneShotLorebookCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_FIXTURE = resolve(__dirname, 'fixtures/incrementalReplay-synthetic.json');
export const DEFAULT_OUT_DIR = resolve(__dirname, 'reports/incrementalReplay');

/**
 * A `generate` driven by the fixture's scripted replies, keyed by the highest
 * message id visible in the prompt rather than by call index.
 *
 * Call-index keying breaks the moment a step legitimately skips its call
 * (`canSkipCall`) or makes a second one (the JSON-only retry): every later step
 * then silently replays the wrong slice's answer and the whole report is
 * garbage that still looks fine. Keying on the prompt's own content cannot
 * desynchronise.
 */
export function makeSlicedGenerate(replies) {
    return async function sliced(prompt) {
        let highest = -1;
        for (const m of String(prompt).matchAll(/^\[(\d+)\]/gm)) {
            const id = Number(m[1]);
            if (id > highest) highest = id;
        }
        const set = replies[String(highest)];
        if (!set) {
            throw new Error(`makeSlicedGenerate: no scripted reply for a slice ending at message ${highest}`);
        }
        return JSON.stringify({ entries: set });
    };
}

/**
 * The same scripted model, but one that actually OBEYS rule 6 — it reads the
 * `[settled — do not re-emit]` tags out of the prompt and leaves those entries
 * out of its reply.
 *
 * This exists because of a measurement problem that would otherwise make the
 * cost number a lie by omission. A canned reply set replays whatever was
 * recorded, so it re-emits settled entries no matter what the prompt says, and
 * the measured output-token saving comes out at exactly 0% — which reads as
 * "incremental saves nothing" when what it actually means is "a scripted model
 * cannot demonstrate prompt compliance."
 *
 * Running both brackets the real answer honestly:
 *   - the DEFIANT script is the floor: what incremental saves through
 *     enforcement alone (`dropFrozenEntries`, fewer writes), guaranteed
 *     regardless of the model;
 *   - the COMPLIANT script is the ceiling: what it additionally saves if the
 *     model does as it is told, which is not guaranteed and needs a live run to
 *     establish for any given model.
 * The truth for a real model is somewhere between, and this harness cannot say
 * where without one.
 */
export function makeCompliantSlicedGenerate(replies) {
    const defiant = makeSlicedGenerate(replies);
    return async function compliant(prompt) {
        const settled = new Set();
        for (const m of String(prompt).matchAll(/^- (.+?) \[settled — do not re-emit\]:/gm)) {
            settled.add(m[1].trim().toLowerCase());
        }
        const { entries } = JSON.parse(await defiant(prompt));
        return JSON.stringify({ entries: entries.filter((e) => !settled.has(String(e.name).trim().toLowerCase())) });
    };
}

/** Turn the per-step results into the table the issue asks for. */
function stepTable(steps) {
    return steps.map((s) => ({
        step: s.index,
        boundary: s.boundary,
        messages: s.messageCount,
        mode: s.mode,
        totalEntries: s.totalEntries,
        regenerated: s.regenerated,
        frozen: s.frozen,
        regeneratedFraction: s.totalEntries ? Math.round((s.regenerated / s.totalEntries) * 100) / 100 : 0,
        driftOk: s.drift.ok,
        driftBasis: s.drift.basis,
        driftChecked: s.drift.checked,
        driftUnscoreable: s.drift.unscoreable,
        idempotenceOk: s.idempotence ? s.idempotence.ok : null,
        tier1Ok: Object.values(s.tier1).every((c) => c.ok),
        tier1Failures: Object.entries(s.tier1).filter(([, c]) => !c.ok).map(([k]) => k),
        inputTokens: s.cost.inputTokens,
        outputTokens: s.cost.outputTokens,
        calls: s.cost.calls,
    }));
}

export async function run({ fixturePath = DEFAULT_FIXTURE, outDir = DEFAULT_OUT_DIR } = {}) {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const messages = fixture.messages;
    const boundaries = fixture.boundaries;
    const handEdits = new Map(
        Object.entries(fixture.handEdits || {}).map(([k, v]) => [Number(k), v]),
    );

    // ---- incremental replay, with idempotence checked at every step
    const incremental = await replayNSlices({
        auditMessages: messages,
        boundaries,
        generate: makeSlicedGenerate(fixture.replies),
        cfg: { incremental: true },
        handEdits,
        checkIdempotenceEveryStep: true,
    });

    // ---- the same replay again, with a model that actually obeys rule 6
    const compliant = await replayNSlices({
        auditMessages: messages,
        boundaries,
        generate: makeCompliantSlicedGenerate(fixture.replies),
        cfg: { incremental: true },
        handEdits,
    });

    // ---- the same replay with incremental off: the full-rebuild ground truth
    const full = await replayNSlices({
        auditMessages: messages,
        boundaries,
        generate: makeSlicedGenerate(fixture.replies),
        cfg: { incremental: false },
        handEdits,
        checkIdempotenceEveryStep: true,
    });

    // ---- and ONE full rebuild from an empty book at the final boundary, which
    // is the other thing "incremental vs one full rebuild" can mean and the
    // cheaper of the two baselines. Reported alongside rather than instead.
    const finalBoundary = boundaries[boundaries.length - 1];
    const finalSlice = messages.filter((m) => m.id < finalBoundary);
    const oneShotCost = { calls: 0, inputTokens: 0, outputTokens: 0, writes: 0 };
    const oneShotBook = [];
    const oneShotResult = await runOneShotStep({
        book: oneShotBook,
        auditMessages: finalSlice,
        transcriptText: formatTranscript(finalSlice, 0),
        generate: withCostTracking(makeSlicedGenerate(fixture.replies), oneShotCost),
        cfg: { incremental: false },
    });
    oneShotCost.writes = oneShotResult.writes ? oneShotResult.writes.length : 0;

    const report = {
        issue: 'PHA-2693',
        fixture: fixturePath,
        fixtureIsSynthetic: fixturePath === DEFAULT_FIXTURE,
        slices: boundaries.length,
        messages: messages.length,

        drift: {
            ok: incremental.steps.every((s) => s.drift.ok),
            perStep: incremental.steps.map((s) => ({
                step: s.index, basis: s.drift.basis, checked: s.drift.checked,
                unscoreable: s.drift.unscoreable, offenders: s.drift.offenders,
            })),
            fullRebuildComparison: {
                ok: full.steps.every((s) => s.drift.ok),
                offenders: full.steps.flatMap((s) => s.drift.offenders.map((o) => ({ step: s.index, ...o }))),
            },
        },

        correctionDurability: incremental.durability,

        idempotence: {
            ok: incremental.steps.every((s) => !s.idempotence || s.idempotence.ok),
            perStep: incremental.steps.map((s) => ({
                step: s.index,
                ok: s.idempotence?.ok ?? null,
                skippedCall: s.idempotence?.skippedCall ?? null,
                moved: s.idempotence?.moved ?? [],
            })),
        },

        regeneratedVsTotal: stepTable(incremental.steps),
        regeneratedVsTotalFullRebuild: stepTable(full.steps),

        provenanceSpotCheck: provenanceSpotCheck({ book: incremental.book, messages, sampleSize: 5 }),

        cost: {
            // The floor: enforcement only, model assumed to ignore rule 6.
            incrementalVsFullReplay: compareCost({ incremental: incremental.cost, full: full.cost }),
            // The ceiling: the same run with a model that obeys rule 6. See
            // makeCompliantSlicedGenerate — a real model lands between these two
            // and this harness cannot say where without a live run.
            incrementalCompliantVsFullReplay: compareCost({ incremental: compliant.cost, full: full.cost }),
            incrementalVsSingleFullRebuild: compareCost({ incremental: incremental.cost, full: oneShotCost }),
            interpretation: 'The output-token saving is BRACKETED, not measured: incrementalVsFullReplay is the floor a scripted model can demonstrate (enforcement side only — dropFrozenEntries and fewer writes), incrementalCompliantVsFullReplay is the ceiling if the model honours the do-not-re-emit rule. Only a live run establishes where a given model actually falls.',
        },

        coverage: {
            run: false,
            reason: 'Tier 2 coverage scores the generated book against the hand-built 52-entry Magisa reference book, which was removed from the repo by 2e5b3fc and is not present locally. Approximating it against a synthetic fixture would produce a number with no meaning, so it is reported as not-run.',
        },

        finalBook: incremental.book.map((e) => ({
            title: e.title, keys: e.keys, confidence: e.stmbAutoConfidence,
            sourceRef: e.stmbAutoSourceRef, highWater: e.stmbAutoRunHighWater,
            verifiedByHuman: e.stmbAutoVerifiedByHuman === true,
        })),
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

function summarize(r) {
    const lines = [];
    lines.push(`PHA-2693 N-slice replay — ${r.slices} slices over ${r.messages} messages`);
    lines.push(`fixture: ${r.fixture}${r.fixtureIsSynthetic ? '  (SYNTHETIC — see the header of this file)' : ''}`);
    lines.push('');
    lines.push('step  boundary  msgs  mode         total  regen  frozen  drift              idem  tier1  in/out tokens');
    for (const s of r.regeneratedVsTotal) {
        lines.push(
            `${String(s.step).padEnd(5)} ${String(s.boundary).padEnd(9)} ${String(s.messages).padEnd(5)} ` +
            `${s.mode.padEnd(12)} ${String(s.totalEntries).padEnd(6)} ${String(s.regenerated).padEnd(6)} ` +
            `${String(s.frozen).padEnd(7)} ${`${s.driftOk ? 'ok' : 'FAIL'} (${s.driftBasis}, n=${s.driftChecked})`.padEnd(18)} ` +
            `${String(s.idempotenceOk).padEnd(5)} ${String(s.tier1Ok).padEnd(6)} ${s.inputTokens}/${s.outputTokens}`,
        );
    }
    lines.push('');
    lines.push(`drift ok: ${r.drift.ok}   (full rebuild, same replies: ${r.drift.fullRebuildComparison.ok}, ${r.drift.fullRebuildComparison.offenders.length} offender(s))`);
    lines.push(`idempotence ok: ${r.idempotence.ok}`);
    lines.push(`correction durability ok: ${r.correctionDurability?.ok ?? 'n/a'}  (contradictions reported: ${r.correctionDurability?.contradictionsReported.length ?? 0})`);
    lines.push(`provenance: ${r.provenanceSpotCheck.bookTotals.stated} stated / ${r.provenanceSpotCheck.bookTotals.inferred} inferred of ${r.provenanceSpotCheck.bookTotals.entries}`);
    lines.push('');
    const c = r.cost.incrementalVsFullReplay;
    const cc = r.cost.incrementalCompliantVsFullReplay;
    lines.push(`cost vs full replay, FLOOR   (model ignores rule 6): input ${c.delta.inputTokensSavedPct}%, output ${c.delta.outputTokensSavedPct}%, writes ${c.delta.writesSavedPct}%  (${c.incremental.inputTokens}/${c.incremental.outputTokens} tok, ${c.incremental.writes} writes vs ${c.full.inputTokens}/${c.full.outputTokens}, ${c.full.writes})`);
    lines.push(`cost vs full replay, CEILING (model obeys rule 6) : input ${cc.delta.inputTokensSavedPct}%, output ${cc.delta.outputTokensSavedPct}%, writes ${cc.delta.writesSavedPct}%`);
    lines.push(r.cost.interpretation);
    lines.push(c.caveat);
    lines.push('');
    lines.push(`coverage: NOT RUN — ${r.coverage.reason}`);
    return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log([
            'Usage: node eval/runIncrementalReplay.js [--fixture PATH] [--out DIR]',
            '',
            '  --fixture PATH  replay fixture (default: the committed synthetic story).',
            '                  Message ids must be 1-BASED: extractProvenanceRanges',
            '                  (auditorTechnicalPass.js) requires start >= 1.',
            '                  Shape: {messages[{id,speaker,rawText}], boundaries[],',
            '                  handEdits{step:[{title,content}]}, replies{maxMsgId:[entry]}}',
            '  --out DIR       where report.json is written',
            '',
            'Writes report.json and prints a summary. Offline and deterministic.',
        ].join('\n'));
    } else {
        const at = (flag, dflt) => {
            const i = argv.indexOf(flag);
            return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
        };
        run({ fixturePath: at('--fixture', DEFAULT_FIXTURE), outDir: at('--out', DEFAULT_OUT_DIR) })
            .then((r) => { console.log(summarize(r)); })
            .catch((e) => { console.error(e); process.exitCode = 1; });
    }
}

export { summarize };
