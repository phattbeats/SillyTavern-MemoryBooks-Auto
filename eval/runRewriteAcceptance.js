#!/usr/bin/env node
// Copyright (C) 2024–2026 Aiko Hanasaki
// Copyright (C) 2026 phattbeats
// SPDX-License-Identifier: AGPL-3.0-only
//
// eval/runRewriteAcceptance.js — CLI runner for the PHA-2732 acceptance harness.
//
// Offline by default: replays canned one-shot replies captured from a real
// `--live` calibration run (eval/fixtures/rewriteAcceptance-canned.json), so
// CI gets the exact same real-model output every time at zero cost. `--live`
// re-generates fresh replies from a real model via the `claude` CLI (the same
// mechanism eval/tools/claude-cli-shim.js already uses in this environment)
// and re-captures the canned file.
//
//   node eval/runRewriteAcceptance.js                # offline, canned replay
//   node eval/runRewriteAcceptance.js --json
//   node eval/runRewriteAcceptance.js --live --model claude-haiku-4-5-20251001
//   node eval/runRewriteAcceptance.js --live --recapture   # overwrite the canned fixture
//
// Exit code 0 = every check passed or is explicitly recorded known-bad; 1 = a
// check failed without one.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_TRANSCRIPT,
    DEFAULT_REFERENCE_BOOK,
    DEFAULT_CANNED_REPLIES,
    REWRITE_ACCEPTANCE_DEFAULTS,
    loadFixture,
    loadReferenceBook,
    runOneShotStep,
    replayNSlices,
    runTier1Checks,
    checkZeroWritesOnRerun,
    checkHumanPinSurvives,
    scoreEntityCoverage,
    checkBoundaryPrecision,
    withCostTracking,
    makeCannedGenerate,
} from './rewriteAcceptance.js';
import { formatTranscript, hashContent } from '../oneShotLorebookCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Growing slices over the 329-message fixture: ~20/40/60/80/100%, i.e. "many
// sessions, story growing between them" rather than a single before/after.
const DEFAULT_SLICE_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 1.0];

function parseArgs(argv) {
    const args = {
        transcript: DEFAULT_TRANSCRIPT,
        referenceBook: DEFAULT_REFERENCE_BOOK,
        canned: DEFAULT_CANNED_REPLIES,
        out: resolve(__dirname, 'reports/rewriteAcceptance'),
        json: false,
        live: false,
        recapture: false,
        model: process.env.STMB_EVAL_MODEL || 'claude-haiku-4-5-20251001',
        slices: null, // comma-separated message counts; default derived from DEFAULT_SLICE_FRACTIONS
        requireFixtures: false,
        help: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') args.json = true;
        else if (a === '--require-fixtures') args.requireFixtures = true;
        else if (a === '--live') args.live = true;
        else if (a === '--recapture') args.recapture = true;
        else if (a === '--transcript') args.transcript = argv[++i];
        else if (a === '--reference-book') args.referenceBook = argv[++i];
        else if (a === '--canned') args.canned = argv[++i];
        else if (a === '--model') args.model = argv[++i];
        else if (a === '--slices') args.slices = argv[++i].split(',').map(Number);
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(2); }
    }
    return args;
}

function printHelp() {
    console.log(`PHA-2732 rewrite acceptance harness — offline (canned replay) by default.

Usage: node eval/runRewriteAcceptance.js [options]

  --transcript <path>       JSONL transcript      (default: eval/fixtures/transcript.jsonl)
  --reference-book <path>   Magisa 52-entry book   (default: eval/fixtures/worldbook.json)
  --canned <path>           canned replies file    (default: eval/fixtures/rewriteAcceptance-canned.json)
  --slices <a,b,c>          message-count boundaries for the N-slice replay (default: 20/40/60/80/100%)
  --live                    call a real model via the \`claude\` CLI instead of replaying canned output
  --recapture               with --live, overwrite the canned replies fixture with this run's real output
  --model <name>            model id for --live      (default: claude-haiku-4-5-20251001)
  --out <dir>               evidence output dir     (default: eval/reports/rewriteAcceptance)
  --require-fixtures        exit 1 instead of 0 when the local-only fixtures are absent, so a
                            gate that is meant to actually run cannot pass by having nothing to do
  --json                    emit the machine-readable result only
  -h, --help                this message
`);
}

/** Shell out to the `claude` CLI for one completion. Same mechanism as eval/tools/claude-cli-shim.js. */
function makeClaudeCliGenerate(model) {
    return function claudeCliGenerate(prompt) {
        return new Promise((resolvePromise, reject) => {
            const claudeBin = process.env.CLAUDE_CLI_BIN || '/usr/local/bin/claude';
            // cwd must NOT be PAPERCLIP_RUN_SCRATCH_DIR: Paperclip deletes that
            // directory as soon as the run that created it ends, and a long-lived
            // background replay outlives its launching run. A missing cwd makes
            // Node report ENOENT on the spawned command itself, which is a red
            // herring — the binary is fine, the cwd just vanished underneath it.
            const child = execFile(claudeBin, ['-p', '--model', model], {
                timeout: 300000,
                maxBuffer: 32 * 1024 * 1024,
                cwd: '/tmp',
                env: { ...process.env, PATH: `/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:${process.env.PATH || ''}` },
            }, (err, stdout, stderr) => {
                if (err) reject(new Error(`claude CLI failed: ${err.message}\n${String(stderr).slice(0, 500)}`));
                else resolvePromise(stdout.trim());
            });
            child.stdin.write(prompt);
            child.stdin.end();
        });
    };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mark = (ok) => (ok ? 'PASS' : 'FAIL');

// Checks recorded here fail on today's `main` for a real product reason, not
// a harness bug — per PHA-2732's Done-when, that's an acceptable calibration
// outcome as long as the reason is on record. Re-check these first whenever
// the rewrite lands; a rewrite that clears one of these should DELETE the
// entry here, not just leave the check green.
const KNOWN_BAD = {
    'check2-no-zero-key-entries': 'the one-shot generator occasionally names an entry (e.g. "Pemberly, System '
        + 'Liaison") in its JSON reply without populating that entry\'s keys array — there is no post-generation '
        + 'validation step that backfills or drops a keyless entry before it is written to the book. Pre-existing '
        + 'gap in today\'s generator, reproduced at slice<=197 onward; not a harness defect.',
    'check5-zero-writes-on-rerun': 'one-shot regenerates every entry from scratch via the model each run, '
        + 'so identical source text rarely produces a byte-identical reply — the content hash almost never '
        + 'matches even though nothing changed. Idempotent re-runs need a diff/patch generation strategy, '
        + 'which is exactly what the rewrite is for.',
    'check7-entity-coverage': 'one-shot is a single fixed-size pass over the whole transcript with a '
        + 'maxEntries cap, so on a 329-message story it structurally cannot surface every one of 52 '
        + 'hand-curated entities (measured 41/52) — it was never designed to do exhaustive extraction.',
    'check8-boundary-precision': 'boundary detection is a separate, unrelated subsystem (eval/detect.js) '
        + 'from the one-shot generator under test here; its current precision (~0.61) is pre-existing and '
        + 'tracked independently — recorded here only so the number is not silently dropped from this report.',
};

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) { printHelp(); process.exit(0); }
    const log = args.json ? () => {} : (...a) => console.log(...a);

    // The captured roleplay transcript and everything derived from it are
    // local-only (untracked — see .gitignore). Without them there is nothing
    // to replay: record a skipped report so CI's upload step still has a
    // file, and exit green rather than failing on a fixture we no longer ship.
    //
    // That green is a "nothing ran" green, not a "checks passed" green, and the
    // two are indistinguishable to anyone reading a CI badge. Whoever is
    // relying on this harness as a gate — the PHA-2729 rewrite above all —
    // passes `--require-fixtures` so an absent fixture is a hard failure
    // instead of a silent pass. The default stays permissive so the privacy
    // decision (fixtures are personal chat logs, not distributable) does not
    // turn every unrelated PR red.
    const { existsSync } = await import('node:fs');
    const needed = [args.transcript, args.referenceBook, ...(args.live ? [] : [args.canned])];
    const missing = needed.filter((p) => !existsSync(p));
    if (missing.length) {
        await mkdir(args.out, { recursive: true });
        const report = {
            skipped: true,
            reason: 'local-only eval fixtures not present',
            missing,
            ...(args.requireFixtures ? { required: true } : {}),
        };
        await writeFile(resolve(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        log(`SKIPPED: local-only eval fixtures not present:\n  ${missing.join('\n  ')}`);
        if (args.requireFixtures) {
            log('--require-fixtures was set: a harness with nothing to check does not pass.');
        }
        if (args.json) console.log(JSON.stringify(report));
        process.exit(args.requireFixtures ? 1 : 0);
    }

    log('PHA-2732 rewrite acceptance harness');
    log('='.repeat(72));

    const { messages, auditMessages } = await loadFixture(args.transcript);
    const referenceBook = await loadReferenceBook(args.referenceBook);
    log(`fixture      ${messages.length} messages`);
    log(`reference    ${referenceBook.length} entries (Magisa hand-built book)`);

    const boundaries = args.slices || DEFAULT_SLICE_FRACTIONS.map((f) => Math.max(1, Math.round(auditMessages.length * f)));
    log(`slices       ${boundaries.join(', ')} (of ${auditMessages.length} messages)`);
    log(`mode         ${args.live ? `LIVE (claude CLI, model=${args.model})` : 'offline (canned replay)'}`);
    log('');

    // ---------------------------------------------------------------- generate
    const tracker = { calls: 0, inputTokens: 0, outputTokens: 0 };
    const captured = [];
    let rawGenerate;
    if (args.live) {
        const cliGenerate = makeClaudeCliGenerate(args.model);
        rawGenerate = async (prompt) => {
            const reply = await cliGenerate(prompt);
            captured.push(reply);
            return reply;
        };
    } else {
        const canned = JSON.parse(await readFile(args.canned, 'utf8'));
        rawGenerate = makeCannedGenerate(canned.replies);
    }
    const generate = withCostTracking(rawGenerate, tracker);

    // ---------------------------------------------------------------- N-slice replay
    log('N-SLICE REPLAY');
    log('-'.repeat(72));
    const stepReports = [];
    const { steps, book } = await replayNSlices({
        auditMessages, boundaries, generate,
        onStep: (step) => {
            const t1 = step.tier1;
            const allT1Ok = Object.values(t1).every((c) => c.ok);
            log(`  slice<=${step.boundary}  msgs=${step.messageCount}  entries=${step.totalEntries}  `
                + `regenerated=${step.regenerated}  tier1=${mark(allT1Ok)}  drift=${mark(step.drift.ok)}`);
        },
    });
    log('');

    // ---------------------------------------------------------------- check 5: zero writes on rerun
    log('CHECK 5 — zero writes on an unchanged re-run');
    log('-'.repeat(72));
    const lastBoundary = boundaries[boundaries.length - 1];
    const finalSlice = auditMessages.filter((m) => m.id < lastBoundary);
    const rerunTranscriptText = formatTranscript(finalSlice, REWRITE_ACCEPTANCE_DEFAULTS.truncate);
    const rerunStep = await runOneShotStep({ book, auditMessages: finalSlice, transcriptText: rerunTranscriptText, generate });
    const check5 = checkZeroWritesOnRerun(rerunStep.pinning);
    log(`  toWrite=${check5.toWriteCount}  unchangedSkips=${check5.unchangedSkips}  ${mark(check5.ok)}`);
    log('');

    // ---------------------------------------------------------------- check 6: human pin (synthetic, offline, always)
    log('CHECK 6 — human-pinned entry survives a re-run; a contradiction is reported, not overwritten');
    log('-'.repeat(72));
    const pinnedBook = [{
        title: 'Grondulf', keys: ['Grondulf'], content: 'HUMAN EDIT: Grondulf died offscreen.', isMemory: false, disable: false,
        stmbAutoContentHash: hashContent('HUMAN EDIT: Grondulf died offscreen.'),
        stmbAutoVerifiedByHuman: true,
    }];
    const contradictingGenerate = async () => JSON.stringify({
        entries: [{ name: 'Grondulf', keys: ['Grondulf'], content: 'Grondulf is alive and well, still collecting rent.' }],
    });
    const pinStep = await runOneShotStep({
        book: pinnedBook, auditMessages: finalSlice, transcriptText: rerunTranscriptText, generate: contradictingGenerate,
    });
    const check6 = checkHumanPinSurvives({
        pinning: pinStep.pinning, pinnedTitles: ['Grondulf'], book: pinnedBook,
        preStepContent: new Map([['grondulf', 'HUMAN EDIT: Grondulf died offscreen.']]),
    });
    log(`  contradictions reported=${check6.contradictions.length}  ${mark(check6.ok)}`);
    log('');

    // ---------------------------------------------------------------- check 7: entity coverage
    log('CHECK 7 — entity/event/location coverage vs the Magisa reference book');
    log('-'.repeat(72));
    const check7 = scoreEntityCoverage(book, referenceBook);
    log(`  found=${check7.foundCount}/${check7.total}  missed=${check7.missedCount}  extra=${check7.extraCount}  ${mark(check7.ok)}`);
    if (check7.missed.length) log(`  missed: ${check7.missed.join(', ')}`);
    log('');

    // ---------------------------------------------------------------- check 8: boundary precision
    log('CHECK 8 — boundary-detection precision');
    log('-'.repeat(72));
    const check8 = await checkBoundaryPrecision({ messages });
    log(`  precision=${check8.precision.toFixed(3)} (>=${check8.minPrecision})  recall=${check8.recall.toFixed(3)}  `
        + `raw-boundaries=${check8.rawBoundaryCount}  predicted=${check8.predictedCount}  ${mark(check8.ok)}`);
    log('');

    // ---------------------------------------------------------------- final-state Tier 1 + drift roll-up
    const finalTier1 = runTier1Checks({ book, messages: finalSlice, idMin: 0, idMax: lastBoundary - 1 });
    const anyDriftOffenders = steps.flatMap((s) => s.drift.offenders);

    const criteria = [
        { id: 'check1-no-keyword-collisions', ...finalTier1.noKeywordCollisions },
        { id: 'check2-no-zero-key-entries', ...finalTier1.noZeroKeyEntries },
        { id: 'check3-no-overbroad-keywords', ...finalTier1.noOverbroadKeywords },
        { id: 'check4-provenance-in-bounds', ...finalTier1.provenanceInBounds },
        { id: 'check5-zero-writes-on-rerun', ...check5 },
        { id: 'check6-human-pin-survives', ...check6 },
        { id: 'check7-entity-coverage', ...check7 },
        { id: 'check8-boundary-precision', ...check8 },
        { id: 'check9-drift', ok: anyDriftOffenders.length === 0, offenders: anyDriftOffenders },
    ];
    for (const c of criteria) c.knownBad = !c.ok && KNOWN_BAD[c.id] ? KNOWN_BAD[c.id] : null;
    const unexplainedFailures = criteria.filter((c) => !c.ok && !c.knownBad);
    const allPass = unexplainedFailures.length === 0;

    log('SUMMARY');
    log('-'.repeat(72));
    for (const c of criteria) {
        const status = c.ok ? 'PASS' : (c.knownBad ? 'KNOWN-BAD' : 'FAIL');
        log(`  ${status.padEnd(10)} ${c.id}`);
        if (c.knownBad) log(`             ${c.knownBad}`);
    }
    log(`  cost (estimated)  calls=${tracker.calls}  inputTokens~${tracker.inputTokens}  outputTokens~${tracker.outputTokens}`);
    log('');
    log(allPass ? 'ALL CHECKS PASS OR KNOWN-BAD' : 'SOME CHECKS FAILED WITHOUT EXPLANATION');

    // ---------------------------------------------------------------- persist
    await mkdir(args.out, { recursive: true });
    const result = {
        generatedAt: new Date().toISOString(),
        mode: args.live ? 'live' : 'canned',
        model: args.live ? args.model : null,
        fixture: args.transcript,
        referenceBook: args.referenceBook,
        boundaries,
        steps: steps.map((s) => ({
            boundary: s.boundary, messageCount: s.messageCount, totalEntries: s.totalEntries,
            regenerated: s.regenerated, tier1: s.tier1, drift: s.drift,
        })),
        criteria,
        allPass,
        cost: tracker,
    };
    await writeFile(resolve(args.out, 'report.json'), JSON.stringify(result, null, 2));
    log(`\nReport written to ${args.out}/report.json`);

    if (args.live && args.recapture) {
        await writeFile(args.canned, JSON.stringify({
            capturedAt: new Date().toISOString(), model: args.model, replies: captured,
        }, null, 2));
        log(`Canned replies recaptured to ${args.canned} (${captured.length} replies).`);
    }

    if (args.json) console.log(JSON.stringify(result, null, 2));
    process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
