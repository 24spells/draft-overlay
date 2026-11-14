// COPIED from draft-trainer/src/core/roles.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Card roles read from rules text: what a card does for a limited deck.
// Rule-based on purpose, so every tag can be traced to the words that caused
// it (see `why`). Set-agnostic: works on any set's Scryfall text.

export type Role =
  | 'removal'
  | 'soft removal'
  | 'sweeper'
  | 'counterspell'
  | 'card draw'
  | 'card filtering'
  | 'evasion'
  | 'ramp'
  | 'fixing'
  | 'combat trick'
  | 'tokens'
  | 'lifegain'
  | 'threat';

export const ROLE_LABELS: Record<Role, string> = {
  removal: 'Removal',
  'soft removal': 'Soft removal',
  sweeper: 'Board wipe',
  counterspell: 'Counterspell',
  'card draw': 'Card draw',
  'card filtering': 'Card filtering',
  evasion: 'Evasion',
  ramp: 'Ramp',
  fixing: 'Mana fixing',
  'combat trick': 'Combat trick',
  tokens: 'Makes tokens',
  lifegain: 'Lifegain',
  threat: 'Threat',
};

/** Roles that deal with an opposing threat; the deck builder counts these. */
export const INTERACTION: Role[] = ['removal', 'soft removal', 'sweeper', 'counterspell'];

type Rule = { role: Role; test: RegExp; unless?: RegExp; when?: (card: RoleInput) => boolean };

export type RoleInput = { name: string; type: string; text: string; pt?: string | null };

const isCreature = (c: RoleInput) => /Creature/.test(c.type);
const isInstantish = (c: RoleInput) => /Instant/.test(c.type) || /\bflash\b/i.test(c.text);

// "creature" but not "noncreature": destroying a noncreature permanent is not creature removal.
const TARGET_THREAT = String.raw`(?:target|up to (?:one|two|three) target)(?:(?!noncreature)[^.])*?(?:\bcreature|planeswalker|nonland permanent|\bpermanent)`;

const RULES: Rule[] = [
  // Hard removal: kills or exiles a creature outright.
  { role: 'removal', test: new RegExp(String.raw`\b(?:destroy|exile)s? ${TARGET_THREAT}`, 'i'), unless: /exile target (?:creature )?card|from (?:a|your|an opponent's) graveyard|exile target (?:creature|permanent) you control/i },
  { role: 'removal', test: /deals? (?:\d+|X|that much|damage equal to [^.]+?) damage to (?:any target|target creature|target (?:creature or planeswalker|planeswalker or creature)|another target creature|up to (?:one|two) target creatures?|target attacking or blocking creature)/i },
  // Shrinking toughness by 2 or more kills most limited creatures; -X/-1 or -N/-0 does not.
  { role: 'removal', test: /target creature (?:an opponent controls )?gets -(?:\d+|X)\/-(?:[2-9]|\d{2,}|X)\b/i },
  // Burn with a restricted target ("target black or green creature", "target creature with flying").
  { role: 'removal', test: /deals? (?:\d+|X) damage to target [^.]*?(?:creature|planeswalker)/i, unless: /you control/i },
  // Fight and bite; "their power" too (2026-11-13: TRK Common Goal, two creatures each bite).
  { role: 'removal', test: /\bfights?\b (?:target|another target|up to one target)|deals? damage equal to (?:its|their) power to (?:target|another target|that (?:creature|permanent))/i },
  // Tuck: the creature goes to the top or bottom of its owner's library (TRK Guidance Failure).
  { role: 'removal', test: /target creature[^.]*owner puts it (?:on|into) (?:their choice of )?the top or bottom of (?:their|its owner's) library/i },
  { role: 'removal', test: /(?:target|each) (?:player|opponent) sacrifices (?:a|an attacking) creature/i },
  { role: 'removal', test: /-1\/-1 counters? on (?:up to one )?target creature|base power and toughness 0\/0/i },
  { role: 'removal', test: /(?:creature|planeswalker)[^.]*an opponent controls\.? (?:Its owner )?shuffles it into (?:their|its owner's) library/i },
  // Soft removal: neutralizes without killing.
  { role: 'soft removal', test: /enchanted creature can't (?:attack|block)|enchanted creature (?:doesn't untap|loses all abilities)/i },
  { role: 'soft removal', test: /return target (?:creature|nonland permanent)[^.]* to (?:its|their) owner's hand/i },
  { role: 'soft removal', test: /tap target creature[^.]*\. (?:it|that creature) doesn't untap|put a stun counter/i },
  { role: 'soft removal', test: /target nonland permanent[^.]*(?:top|bottom) of (?:their|its owner's) library/i },
  // Board wipes.
  { role: 'sweeper', test: /destroy all creatures|(?:each|all) creatures? gets? -\d+\/-\d+|deals? \d+ damage to each creature|exile all creatures/i },
  // Counterspells, including restricted ones ("counter target white or black spell").
  { role: 'counterspell', test: /counter target [^.]*?(?:spell|ability)/i },
  // Card advantage and selection.
  { role: 'card draw', test: /\bdraws? (?:a card|two cards|three cards|X cards|cards equal)/i, unless: /draw a card, then discard a card|discard a card, then draw a card|each player draws/i },
  { role: 'card filtering', test: /\bsurveil \d|\bscry \d|draw a card, then discard a card|discard a card, then draw a card|look at the top \w+ cards of your library/i },
  // Evasion on creatures.
  { role: 'evasion', test: /\b(?:flying|menace|trample|skulk|shadow|fear|intimidate|horsemanship)\b|can't be blocked/i, when: isCreature, unless: /can't have flying|creatures with flying|\bflying\b[^.]*\b(?:target|you control)/i },
  // Mana fixing.
  // Ramp: more mana sooner. A land put onto the battlefield (not into your
  // hand), a nonland permanent that taps for mana, or Treasure.
  { role: 'ramp', test: /(?:search your library for|put) (?:a|an|two|up to [\w ]+?) (?:basic )?land cards?[^.]*onto the battlefield/i },
  // Any nonland card that adds mana: mana creatures and rocks, mana tokens,
  // planeswalker mana abilities.
  { role: 'ramp', test: /\badd (?:\{[WUBRGC]\}|one mana|two mana|three mana|X mana)/i, when: (c) => !/Land/.test(c.type) },
  { role: 'ramp', test: /create (?:a|an|one|two|three|X|\d+) [^.]*?treasure tokens?/i, unless: /they create|its controller creates|that player creates/i },
  { role: 'fixing', test: /add one mana of (?:any (?:color|type)|the chosen color)|search your library for a basic land|add \{[WUBRG]\} or \{[WUBRG]\}|add \{[WUBRG]\}, \{[WUBRG]\}, or \{[WUBRG]\}|treasure token/i, unless: /they create|its controller creates|that player creates/i },
  // Instant-speed pump or protection.
  { role: 'combat trick', test: /target creature (?:you control )?gets \+\d+\/\+\d+|target creature (?:you control )?gains (?:indestructible|hexproof|protection|first strike|double strike)/i, when: (c) => isInstantish(c) && !isCreature(c) },
  // Bodies and life.
  { role: 'tokens', test: /\bcreate (?:a|an|one|two|three|X|\d+) [^.]*?creature tokens?/i },
  { role: 'lifegain', test: /\byou gain \d+ life|\blifelink\b/i },
];

function sentenceAround(text: string, at: number): string {
  const before = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('\n', at - 1));
  const afterDot = text.indexOf('.', at);
  const afterLine = text.indexOf('\n', at);
  const ends = [afterDot, afterLine].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(before + 1, end + 1);
}

/** Every role a card plays, with the words that triggered each. */
export function tagRoles(card: RoleInput): { role: Role; why: string }[] {
  const out: { role: Role; why: string }[] = [];
  // Reminder text (in parentheses) explains keywords; it is not what the card does.
  const text = card.text.replace(/\([^)]*\)/g, '');
  for (const rule of RULES) {
    if (out.some((r) => r.role === rule.role)) continue;
    if (rule.when && !rule.when(card)) continue;
    const match = text.match(rule.test);
    if (!match) continue;
    // An exception counts only inside the same sentence as the match.
    if (rule.unless && rule.unless.test(sentenceAround(text, match.index ?? 0))) continue;
    out.push({ role: rule.role, why: match[0] });
  }
  // Threat: a card that ends the game if left unanswered (a win condition).
  // Traceable on purpose: a big body, an evasive clock, a planeswalker, or a
  // card that makes several creatures.
  const threat = threatWhy(card, text, out.some((r) => r.role === 'evasion'));
  if (threat) out.push({ role: 'threat', why: threat });
  // Hard removal makes "soft removal" redundant on the same card.
  if (out.some((r) => r.role === 'removal')) {
    return out.filter((r) => r.role !== 'soft removal');
  }
  return out;
}

/** Why a card counts as a threat, or null. Power from the front face's P/T. */
function threatWhy(card: RoleInput, text: string, evasive: boolean): string | null {
  if (/Planeswalker/.test(card.type)) return 'planeswalker';
  if (/you win the game|loses the game/i.test(text)) return 'wins the game';
  const power = Number((card.pt ?? '').split(' // ')[0].split('/')[0]);
  if (isCreature(card) && Number.isFinite(power)) {
    if (power >= 4) return `${power} power`;
    if (power >= 3 && evasive) return `${power} power and evasion`;
  }
  const army = text.match(/\bcreate (?:two|three|four|five|X|[2-9]) [^.]*?creature tokens?/i);
  if (army) return army[0];
  const recurring = text.match(/(?:at the beginning of|whenever)[^.]*?\bcreate (?:a|an|one) [^.]*?creature token/i);
  if (recurring && !/Instant|Sorcery/.test(card.type)) return 'makes a creature every turn';
  return null;
}
