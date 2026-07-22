// Pure stratagem indexing + resolution. No DOM, no I/O (mirrors engine.js).
//
// Input is the Wahapedia-derived card-generator JSON (see data.loadStratagemData):
//   { factions: { <name>: { detachments: { <detName>: Stratagem[] } } } }
// The special faction "Core" holds universal stratagems under the '(none)' key.
//
// A Stratagem leaf looks like:
//   { id, name, cp, type, group, timing, phases:[…], when, target, effect,
//     restrictions, ref?, flavor? }
// where when/target/effect/restrictions carry sanctioned HTML (<b>, <br>, ▪).

import { normDetName } from './config.js';

// Pull the core stratagem array out of an 11e card bundle (best-effort).
function coreOf(bundle) {
  const dets = bundle && bundle.factions && bundle.factions.Core
    && bundle.factions.Core.detachments;
  if (!dets) return [];
  // The core bucket is keyed '(none)'; fall back to the first detachment list.
  return dets['(none)'] || Object.values(dets)[0] || [];
}

// Build the lookup used at render time.
//   core: universal stratagems (from the 11e bundle)
//   byDet: Map(normDetName -> Stratagem[]) across every 10e faction/detachment
export function buildStratIndex({ core11, cards10 } = {}) {
  const core = coreOf(core11);
  const byDet = new Map();
  const factions = (cards10 && cards10.factions) || {};
  for (const [facName, fac] of Object.entries(factions)) {
    if (facName === 'Core') continue; // core comes from the 11e bundle
    const dets = (fac && fac.detachments) || {};
    for (const [detName, strats] of Object.entries(dets)) {
      const key = normDetName(detName);
      if (!key || !Array.isArray(strats) || !strats.length) continue;
      // First writer wins; detachment names are unique across factions so
      // collisions are not expected in practice.
      if (!byDet.has(key)) byDet.set(key, strats);
    }
  }
  return { core, byDet };
}

// Resolve the stratagems relevant to the current army.
//   detachments: roster state detachments, [{ id, name, ... }]
// Returns { core, groups: [{ name, found, strats }] } — one group per selected
// detachment, in selection order. `found` is false when no 10e match exists
// (typically a new 11th-edition detachment not yet in the dataset).
export function resolveArmyStratagems(index, detachments = []) {
  const byDet = (index && index.byDet) || new Map();
  const groups = detachments.map((d) => {
    const strats = byDet.get(normDetName(d.name)) || [];
    return { name: d.name, found: strats.length > 0, strats };
  });
  return { core: (index && index.core) || [], groups };
}
