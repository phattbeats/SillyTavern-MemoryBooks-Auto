# PHA-2732 acceptance harness — calibration against current `main`

Run: `node eval/runRewriteAcceptance.js --live --recapture --model claude-haiku-4-5-20251001` to
capture, then `node eval/runRewriteAcceptance.js` (offline, canned replay) to reproduce.

Fixture: `eval/fixtures/transcript.jsonl` (329-message Magisa transcript) against
`eval/fixtures/worldbook.json` (52-entry hand-built reference book). N-slice replay at
message boundaries 66/132/197/263/329.

## Result: ALL CHECKS PASS OR KNOWN-BAD

| # | check | result |
|---|---|---|
| 1 | no-keyword-collisions | PASS |
| 2 | no-zero-key-entries | KNOWN-BAD |
| 3 | no-overbroad-keywords | PASS |
| 4 | provenance-in-bounds | PASS |
| 5 | zero-writes-on-rerun | KNOWN-BAD |
| 6 | human-pin-survives | PASS |
| 7 | entity-coverage | KNOWN-BAD — found 44/52, missed 8, extra 11 |
| 8 | boundary-precision | KNOWN-BAD — precision 0.611 (target ≥0.9), recall 0.328 |
| 9 | drift | PASS |

Missed entities (check 7): Assessor Wimble, Young Hobb, Widow Pell, Greta, Tam,
The Chancellery Conspiracy, The Grand County Council, The Bigger Mystery (recursion hub).

## Known-bad reasons (today's `main`, not the harness)

- **check2** — the one-shot generator occasionally names an entry (e.g. "Pemberly, System
  Liaison") without populating its `keys` array; no post-generation validation backfills or
  drops a keyless entry before it's written. First reproduced at slice≤197.
- **check5** — one-shot regenerates every entry from the model on every run, so identical
  source text rarely reproduces a byte-identical reply; the content hash almost never matches
  even when nothing changed. Idempotent re-runs need a diff/patch generation strategy — the
  reason for the rewrite.
- **check7** — one-shot is a single fixed-size pass with a maxEntries cap; on a 329-message
  story it structurally cannot surface all 52 hand-curated entities. Not designed for
  exhaustive extraction.
- **check8** — boundary detection (`eval/detect.js`) is a separate subsystem from the
  one-shot generator under test; its ~0.61 precision is pre-existing and tracked
  independently. Recorded here only so the number isn't silently dropped from this report.

Cost of the live capture (12 calls across 5 slices + rerun + pin checks):
~1,202,275 input tokens, ~17,967 output tokens (claude-haiku-4-5-20251001).

## Runs it green in CI

`.github/workflows/acceptance-harness.yml` runs `node eval/runRewriteAcceptance.js --json`
offline (replayed from `eval/fixtures/rewriteAcceptance-canned.json`, committed) on every
push/PR to `main` — no network, no API keys.

## Addendum (PHA-2729, 2026-08-30): the CI gate currently checks nothing

`2e5b3fc` (privacy: stop shipping personal roleplay eval fixtures) landed after
`8587c1e` (this harness). The fixtures this harness replays are gitignored, so on a
clean checkout `node eval/runRewriteAcceptance.js --json` prints
`{"skipped":true,...}` and **exits 0** — verified on `origin/main` @ `01ea68a`.
`.github/workflows/acceptance-harness.yml` runs exactly that command, so the
acceptance-harness job is currently green by having nothing to run.

The privacy decision is correct and stands: the transcript is a personal chat log
and is not distributable. But "nothing ran" and "checks passed" must not look
identical to a caller that depends on the gate.

- `--require-fixtures` (added here) exits 1 when the fixtures are absent, so the
  rewrite's own gate cannot pass by vacancy. CI's default invocation is unchanged,
  so unrelated PRs do not go red.
- Restoring real enforcement in CI needs a **synthetic, non-personal fixture set**
  (transcript + reference book + canned replies) committed alongside the local-only
  Magisa ones. Tracked separately; that is what makes PHA-2729's "harness first,
  calibrated green" true on a clean checkout rather than only on this machine.

The KNOWN-BAD table above was measured against the local fixtures and remains the
calibration of record; it is reproducible only where those fixtures exist.
