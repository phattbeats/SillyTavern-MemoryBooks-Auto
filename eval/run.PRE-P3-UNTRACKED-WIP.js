#!/usr/bin/env node
/**
 * STMB-Auto Phase 0 — P0.4: one-command re-score.
 *
 * Chains parse-transcript.js -> derive-labels.js -> run-detection.js ->
 * score.js and prints the acceptance-gate report. This is the single
 * command the plan's Phase 0 accept criterion calls for: point --config at
 * a different model/endpoint (or pass different window/prompt options) and
 * rerun to get a fresh score, no manual multi-step reproduction needed.
 *
 * Exits non-zero if the gate metric (precision vs raw ground truth @±1,
 * stmb-auto-plan.md §3.2 / §6 Phase 0 accept) is below --gate (default 0.90).
 *
 * Usage:
 *   node eval/run.js --config eval/detect.config.claude-cli.json
 *   node eval/run.js --config eval/detect.config.claude-cli.json --json
 *
 * Options:
 *   --config <path>      detection config for run-detection.js (required)
 *   --input <path>       transcript for parse-transcript.js
 *                         (default: the Satire Fantasy Isekai fixture)
 *   --out-dir <path>     where fixture.json/labels.json/predictions.json/
 *                         report.json are written (default: eval/out)
 *   --user-tag / --char-tag / --time-jump / --min-scene
 *                         passed through to parse-transcript.js
 *   --window / --overlap / --truncate / --guard
 *                         passed through to run-detection.js
 *   --gate <precision>   acceptance threshold for precision(raw)@±1
 *                         (default: 0.90, the Phase 0 exit gate)
 *   --json                also print the machine-readable report to stdout
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { score } from './score.js';

const __filename = fileURLToPath(import.meta.url);
const root = path.dirname(__filename);

function parseArgs(argv) {
    const opts = {
        config: null,
        input: path.join(root, 'materials/stmb-auto/Satire Fantasy Isekai - 2026-07-12@10h18m29s211ms.jsonl'),
        outDir: path.join(root, 'out'),
        userTag: null,
        charTag: null,
        timeJump: null,
        minScene: null,
        window: null,
        overlap: null,
        truncate: null,
        guard: null,
        gate: 0.9,
        json: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--config': opts.config = next(); break;
            case '--input': opts.input = next(); break;
            case '--out-dir': opts.outDir = next(); break;
            case '--user-tag': opts.userTag = next(); break;
            case '--char-tag': opts.charTag = next(); break;
            case '--time-jump': opts.timeJump = next(); break;
            case '--min-scene': opts.minScene = next(); break;
            case '--window': opts.window = next(); break;
            case '--overlap': opts.overlap = next(); break;
            case '--truncate': opts.truncate = next(); break;
            case '--guard': opts.guard = next(); break;
            case '--gate': opts.gate = Number(next()); break;
            case '--json': opts.json = true; break;
            case '--help':
                console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }
    if (!opts.config) throw new Error('--config is required (detection endpoint/model — see eval/detect.config.example.json)');
    return opts;
}

function run(script, args) {
    const res = spawnSync(process.execPath, [path.join(root, script), ...args], { stdio: 'inherit' });
    if (res.status !== 0) {
        process.exit(res.status ?? 1);
    }
}

function fmt(m) {
    return m.value === null ? 'n/a' : `${m.value.toFixed(3)} (${m.hit}/${m.total})`;
}

function main() {
    const opts = parseArgs(process.argv);
    fs.mkdirSync(opts.outDir, { recursive: true });
    const fixturePath = path.join(opts.outDir, 'fixture.json');
    const labelsPath = path.join(opts.outDir, 'labels.json');
    const predictionsPath = path.join(opts.outDir, 'predictions.json');
    const reportPath = path.join(opts.outDir, 'report.json');

    console.error('== 1/4 parse transcript ==');
    const parseArgs_ = ['--input', opts.input, '--out', fixturePath];
    if (opts.userTag) parseArgs_.push('--user-tag', opts.userTag);
    if (opts.charTag) parseArgs_.push('--char-tag', opts.charTag);
    if (opts.timeJump) parseArgs_.push('--time-jump', opts.timeJump);
    if (opts.minScene) parseArgs_.push('--min-scene', opts.minScene);
    run('parse-transcript.js', parseArgs_);

    console.error('== 2/4 derive ground-truth labels ==');
    run('derive-labels.js', ['--fixture', fixturePath, '--out', labelsPath]);

    console.error('== 3/4 run detection ==');
    const detectArgs = ['--fixture', fixturePath, '--config', opts.config, '--out', predictionsPath];
    if (opts.window) detectArgs.push('--window', opts.window);
    if (opts.overlap) detectArgs.push('--overlap', opts.overlap);
    if (opts.truncate) detectArgs.push('--truncate', opts.truncate);
    if (opts.guard) detectArgs.push('--guard', opts.guard);
    run('run-detection.js', detectArgs);

    console.error('== 4/4 score ==');
    const predictions = JSON.parse(fs.readFileSync(predictionsPath, 'utf8'));
    const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
    const report = score(predictions, labels);
    report.gate = { metric: 'precision_vs_raw @±1', threshold: opts.gate, value: report.metrics['±1'].precision_vs_raw.value };
    report.gate.pass = report.gate.value !== null && report.gate.value >= opts.gate;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`predictions=${report.predictions} raw-truth=${report.raw} merged-truth=${report.merged}`);
    for (const [tol, m] of Object.entries(report.metrics)) {
        console.log(`  ${tol}: precision(raw)=${fmt(m.precision_vs_raw)} precision(merged)=${fmt(m.precision_vs_merged)} recall(raw)=${fmt(m.recall_vs_raw)} recall(merged)=${fmt(m.recall_vs_merged)}`);
    }
    if (report.falsePositives_vs_raw_tol1.length) {
        console.log(`  false positives vs raw @±1: [${report.falsePositives_vs_raw_tol1.join(', ')}]`);
    }
    console.log(`GATE precision(raw)@±1 >= ${opts.gate}: ${report.gate.pass ? 'PASS' : 'FAIL'} (${fmt(report.metrics['±1'].precision_vs_raw)})`);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    }

    if (!report.gate.pass) process.exit(1);
}

main();
