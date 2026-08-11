// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only
//
// STMB-Auto fork — SillyTavern World Info primer (PHA-1915).
//
// PHA-1862 was half-fixed by the one-shot path: writers could finally see each
// other, but nothing ever told a writer what a good KEYWORD is. This primer is
// the other half. It sits first in oneShotLorebookCore.ONE_SHOT_PROMPT, ahead of
// any per-run content (transcript, existing book), so it is the ideal cache
// prefix and costs nothing after the first call of a session — see PHA-1915's
// "do not optimize this to 500 tokens" note. Static and first-in-prompt are the
// only real requirements; length is not a constraint here.
//
// Deliberately emits the MODEL's compact shape (name/keys/content/caseSensitive/
// cascade/throttle), not SillyTavern's ~28-field entry schema — a model asked
// for `preventRecursion` and its siblings can emit any of them malformed; a
// model asked for six fields cannot. oneShotLorebookCore.parseOneShotEntries
// assembles the real ST entry around that six-field core.
//
// TODO(verify-against-st-commit): the intended provenance header for this file
// is "verified against ST commit <sha>", cross-checked against the
// `sillytavern-lorebook` skill's references/st-json-schema.md (recursion and
// probability field semantics). That skill and an upstream ST checkout were not
// available in the environment this file was authored in, so the SHA below is
// left unfilled rather than guessed — fill it in from a real `git rev-parse` of
// the vendored/upstream SillyTavern checkout the next time this file is edited,
// and re-check KEYWORD RULES / CASCADE AND THROTTLE against world-info.js's
// `checkWorldInfo` (keyword scan) and recursion pass at that commit.
// Verified against SillyTavern World Info semantics as of upstream commit: TBD

export const WORLD_INFO_PRIMER_VERSION = 1;

export const WORLD_INFO_PRIMER =
`SILLYTAVERN WORLD INFO — WHAT YOU ARE ACTUALLY WRITING

MECHANISM
World Info entries are not read continuously. Each entry has a list of
keywords. On every new message, SillyTavern scans the most recent chat text
for those keywords; an entry whose keyword is found gets its content injected
into the prompt for that generation, then dropped again once the keyword scrolls
out of the scan window. An entry never fires is invisible no matter how good its
content is — the keyword is the entry's only way of being seen. A keyword that
fires on nearly everything is just as broken in the other direction: it burns
context budget on turns it has nothing useful to add to, and crowds out entries
that actually matter for that turn. Good content wasted on a bad keyword is the
single most common way this system fails.

OUTPUT SHAPE
Emit each entry as one JSON object with exactly these six fields, nothing else:
{"name":"Grondulf","keys":["Grondulf","the Landlord"],"content":"Name: Grondulf\\nRace: Dungeon Troll\\n...","caseSensitive":false,"cascade":false,"throttle":100}
Do not emit any other field (no preventRecursion, no probability, no position,
no order — those are assembled from these six afterward). "content" must stand
alone: it is inserted with no title and no keyword attached, so name the subject
in the first sentence and never write "he", "she", or "as mentioned above".

KEYWORD RULES
- Stay silent rather than guess: if you are not sure a keyword actually appears
  in how the story refers to this subject, leave it out.
- Never claim a word another entry has already claimed unless you deliberately
  want both to fire together — a shared word fires both entries on every
  mention of either.
- Set "caseSensitive": true for a name that is also an ordinary word (Button,
  Rose, Will) — otherwise "will" fires the entry on every use of the auxiliary
  verb.
- Never key on the protagonist's name alone (it will fire on nearly every
  message), a title more than one character holds (Captain, the Doctor), or the
  faction's own name as the ONLY key for a faction entry members refer to
  informally.
- 2 to 4 keys per entry. Use real aliases, nicknames, and epithets the story
  actually uses — not a paraphrase or description of the subject.

CASCADE AND THROTTLE
- "cascade": whether this entry firing is allowed to trigger OTHER entries in
  the same scan. Default false — character entries name each other constantly,
  and without this off, one match cascades into a dozen unrelated insertions.
  Set true only for a small deliberate cluster that should always surface
  together.
- "throttle": 0-100, how often this entry fires when its keyword matches.
  Default 100 (always fire on a match). Use 70-90 only for a keyword that
  matches nearly every message (usually the protagonist's own name) — this
  softens an unavoidable near-constant match instead of drowning every turn in
  it. A rare, specific entry needs no throttle below 100: its rarity already
  gates how often it fires.`;
