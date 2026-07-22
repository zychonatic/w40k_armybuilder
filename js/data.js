// Fetch + cache layer. Pulls catalogue JSON live from raw.githubusercontent.com.

import {
  RAW_BASE, CONTENTS_API, GAME_SYSTEM_FILE, FALLBACK_FACTIONS, factionLabel,
  MFM_RAW_BASE, mfmSlug, normDetName,
  STRAT_RAW_BASE, STRAT_CARDS_11E, STRAT_CARDS_10E,
} from './config.js';

// filename -> Promise<catalogue object | null>  (global cache; shared libraries load once)
const fileCache = new Map();

// Fetch a single catalogue file and return its `catalogue` (or `gameSystem`) object.
// Returns null on 404 / parse error (callers treat missing files as skippable).
async function fetchCatalogueFile(filename) {
  if (fileCache.has(filename)) return fileCache.get(filename);
  const p = (async () => {
    const url = RAW_BASE + encodeURIComponent(filename);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.warn('[data] network error for', filename, e);
      return null;
    }
    if (!res.ok) {
      console.warn('[data] fetch failed', res.status, filename);
      return null;
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      console.warn('[data] JSON parse failed', filename, e);
      return null;
    }
    // Files wrap their payload under `catalogue` or `gameSystem`.
    return json.catalogue || json.gameSystem || json;
  })();
  fileCache.set(filename, p);
  return p;
}

// List available factions. Tries the GitHub contents API, falls back to a
// hardcoded list. Returns [{ file, label }].
export async function loadFactionList() {
  try {
    const res = await fetch(CONTENTS_API);
    if (res.ok) {
      const items = await res.json();
      const files = items
        .filter((it) => it.type === 'file' && /\.json$/i.test(it.name))
        .map((it) => it.name)
        .filter((n) => n !== GAME_SYSTEM_FILE && !/Library/i.test(n));
      if (files.length) {
        files.sort((a, b) => a.localeCompare(b));
        return files.map((file) => ({ file, label: factionLabel(file) }));
      }
    } else {
      console.warn('[data] contents API returned', res.status, '- using fallback list');
    }
  } catch (e) {
    console.warn('[data] contents API error - using fallback list', e);
  }
  return FALLBACK_FACTIONS.map((file) => ({ file, label: factionLabel(file) }));
}

// ---- detachment points (MFM) ----------------------------------------------

// slug -> Promise<Map(normalisedName -> dp)>
const dpCache = new Map();

// Pull a minimal `name -> dp` map from the MFM YAML for a faction. We only need
// the detachments block, so we scan it line-wise rather than pulling in a YAML
// parser. Any failure (missing sheet, network, format drift) yields an empty
// map; callers then default each detachment to 1 DP.
export async function loadDetachmentPoints(factionFile) {
  const slug = mfmSlug(factionFile);
  if (!slug) return new Map();
  if (dpCache.has(slug)) return dpCache.get(slug);
  const p = (async () => {
    const url = `${MFM_RAW_BASE}${encodeURIComponent(slug)}.yaml`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn('[data] MFM fetch failed', res.status, slug);
        return new Map();
      }
      return parseDetachmentDp(await res.text());
    } catch (e) {
      console.warn('[data] MFM network error', slug, e);
      return new Map();
    }
  })();
  dpCache.set(slug, p);
  return p;
}

function stripYamlScalar(s) {
  return s.trim().replace(/^["'](.*)["']$/, '$1').trim();
}

// Scan the top-level `detachments:` list for `- name:` / `dp:` pairs.
function parseDetachmentDp(text) {
  const map = new Map();
  let inDetachments = false;
  let curName = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\S/.test(line)) { // a new top-level key ends the detachments block
      inDetachments = /^detachments\s*:/.test(line);
      curName = null;
      continue;
    }
    if (!inDetachments) continue;
    const nameM = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (nameM) { curName = stripYamlScalar(nameM[1]); continue; }
    const dpM = line.match(/^\s*dp:\s*(\d+)/);
    if (dpM && curName) map.set(normDetName(curName), Number(dpM[1]));
  }
  return map;
}

// ---- stratagems (Wahapedia-derived) ----------------------------------------

// Promise cache: the raw stratagem JSON bundle is fetched once per session.
let stratDataPromise = null;

async function fetchStratJson(file) {
  const url = STRAT_RAW_BASE + file;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[data] stratagem fetch failed', res.status, file);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[data] stratagem network/parse error', file, e);
    return null;
  }
}

// Fetch the two stratagem card files in parallel. Returns { core11, cards10 };
// either may be null on failure (caller degrades: missing core11 → no core
// section, missing cards10 → every detachment shows "no data").
export async function loadStratagemData() {
  if (stratDataPromise) return stratDataPromise;
  stratDataPromise = (async () => {
    const [core11, cards10] = await Promise.all([
      fetchStratJson(STRAT_CARDS_11E),
      fetchStratJson(STRAT_CARDS_10E),
    ]);
    return { core11, cards10 };
  })();
  return stratDataPromise;
}

// Load a faction and everything needed to resolve its units:
//   - the faction catalogue itself
//   - every catalogueLink whose name contains "Library" (holds unit data for
//     split factions and shared sub-factions)
//   - the shared game system file (categories, shared profiles)
// Returns an array of catalogue objects (already de-duplicated & cached).
export async function loadCatalogueBundle(factionFile, onProgress = () => {}) {
  onProgress(`Loading ${factionLabel(factionFile)}…`);
  const base = await fetchCatalogueFile(factionFile);
  if (!base) throw new Error(`Could not load ${factionFile}`);

  const catalogues = [base];
  const missing = [];

  const libraryLinks = (base.catalogueLinks || [])
    .filter((cl) => /Library/i.test(cl.name || ''))
    .map((cl) => `${cl.name}.json`);

  for (const lib of libraryLinks) {
    onProgress(`Loading ${factionLabel(lib)}…`);
    const cat = await fetchCatalogueFile(lib);
    if (cat) catalogues.push(cat);
    else missing.push(lib);
  }

  onProgress('Loading game system…');
  const gs = await fetchCatalogueFile(GAME_SYSTEM_FILE);
  if (gs) catalogues.push(gs);

  return { catalogues, missing };
}
