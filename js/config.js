// Configuration & constants for the W40k Army Builder.
// Data is fetched live from the BSData wh40k-11e repository.

export const REPO = 'BSData/wh40k-11e';
export const BRANCH = 'main';

// Raw file base (CORS-enabled: access-control-allow-origin: *)
export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
// GitHub contents API (used once to list faction files; 60 req/hr unauth)
export const CONTENTS_API = `https://api.github.com/repos/${REPO}/contents/?ref=${BRANCH}`;

// Shared game system file (categories, shared profiles, cost types).
export const GAME_SYSTEM_FILE = 'Warhammer 40,000.json';

// Common army points limits.
export const POINTS_PRESETS = [500, 1000, 1500, 2000, 3000];
export const DEFAULT_LIMIT = 2000;

// MFM (Munitorum Field Manual) data repo — source of per-detachment "detachment
// points" (dp) and enhancement costs. Raw YAML, CORS-enabled like the main repo.
export const MFM_RAW_BASE = 'https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/main/data/';

// 11th edition lets you take several detachments up to a detachment-point (DP)
// budget that scales with battle size. The official values live in the WH40k
// app; this mirrors them for our presets (2000 pts → 3 DP). Adjust here if you
// have the exact battle-size table.
export function dpBudget(limit) {
  return Math.floor((Number(limit) || 0) / 1000) + 1;
}

// Normalise a detachment name for matching across the two data sources (casing
// and punctuation differ, e.g. "Emperor's Shield" vs "Emperor’S Shield").
export function normDetName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Map a BSData faction filename to its MFM slug. Most derive by stripping the
// grand-alliance prefix and slugifying; the rest are explicit because the two
// repos split factions differently (Aeldari) or BSData has per-chapter files
// that share one MFM sheet (Space Marine successors).
const MFM_SLUG_ALIAS = {
  'Aeldari - Craftworlds': 'aeldari',
  'Imperium - Adeptus Titanicus': 'titan-legions',
  'Chaos - Titanicus Traitoris': 'chaos-titan-legions',
  'Imperium - Agents of the Imperium': 'imperial-agents',
  'Imperium - Imperial Fists': 'space-marines',
  'Imperium - Iron Hands': 'space-marines',
  'Imperium - Raven Guard': 'space-marines',
  'Imperium - Salamanders': 'space-marines',
  'Imperium - Ultramarines': 'space-marines',
  'Imperium - White Scars': 'space-marines',
};
export function mfmSlug(factionFile) {
  const base = String(factionFile || '').replace(/\.json$/i, '');
  if (MFM_SLUG_ALIAS[base]) return MFM_SLUG_ALIAS[base];
  return base
    .replace(/^(Imperium|Chaos|Aeldari)\s*-\s*/, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const STORAGE_KEY = 'w40k_armybuilder_roster_v1';

// Fallback faction list if the GitHub contents API is unavailable / rate-limited.
// Value = filename in the repo; label is derived from it.
export const FALLBACK_FACTIONS = [
  'Aeldari - Craftworlds.json',
  'Aeldari - Drukhari.json',
  'Chaos - Chaos Daemons.json',
  'Chaos - Chaos Knights.json',
  'Chaos - Chaos Space Marines.json',
  'Chaos - Death Guard.json',
  "Chaos - Emperor's Children.json",
  'Chaos - Thousand Sons.json',
  'Chaos - Titanicus Traitoris.json',
  'Chaos - World Eaters.json',
  'Genestealer Cults.json',
  'Imperium - Adepta Sororitas.json',
  'Imperium - Adeptus Custodes.json',
  'Imperium - Adeptus Mechanicus.json',
  'Imperium - Adeptus Titanicus.json',
  'Imperium - Agents of the Imperium.json',
  'Imperium - Astra Militarum.json',
  'Imperium - Black Templars.json',
  'Imperium - Blood Angels.json',
  'Imperium - Dark Angels.json',
  'Imperium - Deathwatch.json',
  'Imperium - Grey Knights.json',
  'Imperium - Imperial Fists.json',
  'Imperium - Imperial Knights.json',
  'Imperium - Iron Hands.json',
  'Imperium - Raven Guard.json',
  'Imperium - Salamanders.json',
  'Imperium - Space Marines.json',
  'Imperium - Space Wolves.json',
  'Imperium - Ultramarines.json',
  'Imperium - White Scars.json',
  'Leagues of Votann.json',
  'Necrons.json',
  'Orks.json',
  "T'au Empire.json",
  'Tyranids.json',
  'Unaligned Forces.json',
];

// Turn a filename into a friendly display label.
export function factionLabel(filename) {
  return filename.replace(/\.json$/i, '');
}
