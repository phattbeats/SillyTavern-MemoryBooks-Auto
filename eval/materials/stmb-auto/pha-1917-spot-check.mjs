// PHA-1917 manual spot-check: simulate a one-shot reply against the Magisa
// story transcript (persona hand-authored per WORLD_INFO_PRIMER rules, since
// no live LLM/SillyTavern connection is reachable in this environment) and
// run it through the REAL parser/uniqueness code to validate schema +
// keyword hygiene + the Button Firewood caseSensitive case.
import { parseOneShotEntries, enforceGlobalKeywordUniqueness, findKeywordCollisions } from '../../../oneShotLorebookCore.js';

const reply = JSON.stringify({
  entries: [
    { name: 'Button Firewood', keys: ['Button Firewood', 'Button', 'the Hollow-Hide'], content: 'Name: Button Firewood\nRace: void hollow-kin, formerly unnamed specimen 7-119\nBackground: sole survivor of a drained mire clutch, spent two winters as a hermit\'s pretend dog under the name "Button" before being renamed "Button Firewood" by the protagonist.\nRole: guards the farm\'s goats, speaks in all-caps, deeply earnest and eager to earn its keep.', caseSensitive: true, cascade: false, throttle: 100 },
    { name: 'Marta Barlow', keys: ['Marta Barlow', 'Marta'], content: 'Name: Marta Barlow\nRole: farm seamstress/tailor who measures monsters for coats without flinching, brisk and no-nonsense.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Farmer Haldric', keys: ['Haldric'], content: 'Name: Farmer Haldric\nRole: owner of the farm the protagonist is building his monster household on; gruff, pipe-smoking, quietly fond of the chaos.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Grondulf', keys: ['Grondulf'], content: 'Name: Grondulf\nRace: troll\nRole: sets fence posts for Haldric\'s farm, part of the protagonist\'s growing monster household.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Archlector Melvus', keys: ['Archlector Melvus', 'Melvus'], content: 'Name: Archlector Melvus\nRole: cultist archlector devoted to the protagonist as a "Dread Lord," fervent and dramatic, still smarting over being pelted with root vegetables at Millbrook market.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Hero Clarissa', keys: ['Hero Clarissa', 'Clarissa'], content: 'Name: Clarissa\nRole: hero sent by a princess to smite the protagonist as "the rising darkness," carries EX-Rank organizational powers and a talking sword; believes she once killed him and is guilt-stricken to find him alive.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Gerald, Blade of Dawn', keys: ['Gerald', 'Blade of Dawn'], content: 'Name: Gerald\nRole: Clarissa\'s sentient talking sword, self-important and secretly rattled by the protagonist\'s off-the-charts darkness readings.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Pemberly', keys: ['Pemberly'], content: 'Name: Pemberly\nRole: an overworked bureaucratic functionary fielding paperwork about the protagonist\'s "skinwalker" activity, deadpan and exhausted.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Fort Bramblehold', keys: ['Fort Bramblehold', 'Bramblehold'], content: 'Location: Fort Bramblehold, six miles up the county road from Haldric\'s farm. Garrison of roughly forty soldiers, run by Baron Aldous Wexley the Third.', caseSensitive: false, cascade: false, throttle: 100 },
    { name: 'Baron Aldous Wexley the Third', keys: ['Baron Wexley', 'Wexley the Third'], content: 'Name: Baron Aldous Wexley the Third\nRole: hosts wine tastings at Fort Bramblehold and raised the grain tax to fund a marble statue of himself whose arm has since fallen off.', caseSensitive: false, cascade: false, throttle: 100 },
  ],
});

const parsed = parseOneShotEntries(reply, { maxEntries: 20, minContentChars: 20 });
console.log('parsed entries:', parsed.entries.length, 'dropped:', parsed.dropped);

const { entries: deduped, awarded, keywordless } = enforceGlobalKeywordUniqueness(parsed.entries, new Set());
console.log('after uniqueness pass: keywordless=', keywordless, 'awarded=', Array.from(awarded ?? []).length);

const collisions = findKeywordCollisions(deduped);
console.log('remaining collisions:', collisions.length, JSON.stringify(collisions, null, 2));

const button = deduped.find(e => e.title === 'Button Firewood');
console.log('\nButton Firewood entry:', JSON.stringify({ key: button.key, caseSensitive: button.caseSensitive, preventRecursion: button.preventRecursion, probability: button.probability, useProbability: button.useProbability }, null, 2));

for (const e of deduped) {
  const requiredFields = ['title', 'kind', 'key', 'selectiveLogic', 'constant', 'order', 'position', 'scanDepth', 'preventRecursion', 'caseSensitive', 'probability', 'useProbability', 'content'];
  const missing = requiredFields.filter(f => e[f] === undefined);
  if (missing.length) console.log('MISSING FIELDS on', e.title, missing);
}
console.log('\nAll', deduped.length, 'entries have full ST-shaped field sets: OK');
