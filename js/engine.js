// Selection constraints + points computation.
// Selections shape: { [groupId]: string[] }  (array of selected option ids),
// plus a reserved SIZE_KEY entry holding the chosen model count (number) for
// units that scale in size.

// Reserved selections key for the chosen unit size (model count).
export const SIZE_KEY = '__size';
// Reserved selections key for a character's chosen detachment enhancement id.
export const ENH_KEY = '__enh';

// Only Character units may take a detachment enhancement.
export function isCharacter(unit) {
  return !!unit && Array.isArray(unit.keywords) && unit.keywords.includes('Character');
}

// Resolve the enhancement chosen in `selections` from the available list.
export function selectedEnhancement(enhancements, selections) {
  if (!enhancements || !enhancements.length) return null;
  const id = selections[ENH_KEY];
  return id ? enhancements.find((e) => e.id === id) || null : null;
}

// Whether a group behaves as a single-choice (radio) picker.
export function isSingleChoice(group) {
  return group.max === 1 || (group.max == null && group.min === 1);
}

// Clamp/resolve the chosen model count for a sized unit. Returns null for units
// that don't scale (no `size` info).
export function currentSize(unit, selections) {
  if (!unit || !unit.size) return null;
  const n = Number(selections[SIZE_KEY]);
  const chosen = Number.isFinite(n) ? n : unit.size.min;
  return Math.min(unit.size.max, Math.max(unit.size.min, chosen));
}

// Points for a sized unit at model count `n`: the cost of the highest tier whose
// threshold has been reached.
export function sizeCost(size, n) {
  let cost = size.tiers.length ? size.tiers[0].cost : size.base;
  for (const t of size.tiers) if (n >= t.start) cost = t.cost;
  return cost;
}

// Reasonable default selections for a unit: honor each group's defaultId, and
// otherwise select the first option when the group requires at least one.
export function defaultSelections(unit) {
  const sel = {};
  if (unit.size) sel[SIZE_KEY] = unit.size.min;
  for (const g of unit.optionGroups) {
    if (g.defaultId && g.options.some((o) => o.id === g.defaultId)) {
      sel[g.id] = [g.defaultId];
    } else if ((g.min || 0) >= 1 && g.options.length) {
      sel[g.id] = [g.options[0].id];
    } else {
      sel[g.id] = [];
    }
  }
  return sel;
}

// Rebuild the editable selections model for an existing roster entry so it can
// be re-opened for editing. Prefers the selections persisted on the entry; for
// legacy entries (added before selections were stored) it reconstructs them by
// matching each stored option's group/name back to option ids (best-effort —
// unmatched options are dropped).
export function selectionsFromEntry(unit, entry) {
  if (entry.selections) {
    const out = {};
    for (const k in entry.selections) {
      out[k] = Array.isArray(entry.selections[k]) ? [...entry.selections[k]] : entry.selections[k];
    }
    return out;
  }
  const sel = {};
  for (const g of unit.optionGroups) sel[g.id] = [];
  if (unit.size) sel[SIZE_KEY] = entry.modelCount || unit.size.min;
  if (entry.enhancementId) sel[ENH_KEY] = entry.enhancementId;
  for (const o of entry.options || []) {
    if (o.group === 'Enhancement') continue;
    const g = unit.optionGroups.find((gr) => gr.name === o.group);
    if (!g) continue;
    const opt = g.options.find((op) => op.name === o.name);
    if (opt && !sel[g.id].includes(opt.id)) sel[g.id].push(opt.id);
  }
  return sel;
}

// Split an entry's reachable weapon names by provenance:
//   optional — names a real wargear option can grant
//   selected — names granted by the options actually chosen
//
// `model`-type options are skipped entirely: BSData nests a squad's constituent
// model inside the size/count group, and that model aggregates *every* weapon it
// can reach — including both sides of a nested either/or choice (e.g. an
// Immortal's Gauss blaster AND Tesla carbine). Gating on the real choice group's
// selection is what distinguishes the two; the model's fixed weapons (e.g. a
// Close combat weapon) fall through as "not offered by any option" and stay.
function scanEntryWeapons(unit, entry) {
  const optional = new Set();
  const selected = new Set();
  const selections = selectionsFromEntry(unit, entry);
  for (const g of unit.optionGroups) {
    const chosen = selections[g.id] || [];
    for (const opt of g.options) {
      if (opt.type === 'model') continue;
      for (const w of opt.weapons || []) {
        optional.add(w.name);
        if (chosen.includes(opt.id)) selected.add(w.name);
      }
    }
  }
  return { optional, selected };
}

// Narrow a unit's full weapon list down to what THIS roster entry actually
// carries: weapons offered by a real wargear option appear only when that option
// was selected during army building; any weapon not offered by such an option is
// base kit and always shown.
export function weaponsForEntry(unit, entry) {
  const { optional, selected } = scanEntryWeapons(unit, entry);
  return unit.weapons.filter((w) => selected.has(w.name) || !optional.has(w.name));
}

// Weapon names an entry could only have via a wargear option — i.e. NOT base kit.
export function optionalWeaponNames(unit, entry) {
  return scanEntryWeapons(unit, entry).optional;
}

// Model-type option names across the entry's size groups — i.e. the distinct kinds
// of model the squad is built from ("Intercessor Sergeant", "Intercessor", …).
function squadModelNames(unit) {
  const names = new Set();
  for (const g of unit.optionGroups) {
    for (const opt of g.options) if (opt.type === 'model') names.add(opt.name);
  }
  return names;
}

// How many models carry each weapon. BSData records no weapon multiplicity at all,
// so this is a documented guess the UI lets the user override — never trust it as
// fact. A wargear group's name is path-prefixed with the model it belongs to
// ("Intercessor Sergeant · Weapon 1"), which is the only signal available:
//   - base kit, granted by no option        -> every model ("Close combat weapon")
//   - granted under a *named* sub-model, in
//     a squad built from several kinds      -> 1 (it's the sergeant's gun)
//   - granted under the squad's only model
//     type, or by an unprefixed choice      -> every model ("Immortal · Weapons")
// Returns Map(weaponName -> model count).
export function weaponModelCounts(unit, entry) {
  const all = Math.max(1, Number(entry.modelCount) || 1);
  const modelNames = squadModelNames(unit);
  const selections = selectionsFromEntry(unit, entry);
  const counts = new Map();
  for (const g of unit.optionGroups) {
    const chosen = selections[g.id] || [];
    const owner = g.name.includes(' · ') ? g.name.split(' · ')[0].trim() : '';
    // A prefix naming one of several model kinds scopes the group to that model.
    const perModel = owner && modelNames.size > 1 && modelNames.has(owner);
    for (const opt of g.options) {
      if (opt.type === 'model' || !chosen.includes(opt.id)) continue;
      for (const w of opt.weapons || []) counts.set(w.name, perModel ? 1 : all);
    }
  }
  // Anything left is base kit: carried by every model.
  for (const w of unit.weapons) if (!counts.has(w.name)) counts.set(w.name, all);
  return counts;
}

// Validate selections against group min/max constraints.
// Returns [{ groupId, name, message }] for any violations.
export function validate(unit, selections) {
  const problems = [];
  for (const g of unit.optionGroups) {
    const chosen = (selections[g.id] || []).length;
    if (g.min != null && chosen < g.min) {
      problems.push({ groupId: g.id, name: g.name, message: `choose at least ${g.min}` });
    }
    if (g.max != null && chosen > g.max) {
      problems.push({ groupId: g.id, name: g.name, message: `choose at most ${g.max}` });
    }
  }
  return problems;
}

// Toggle an option within a group, respecting single-choice semantics.
// Returns a new selections object (does not mutate the input).
export function toggleOption(unit, selections, group, optionId) {
  const next = { ...selections, [group.id]: [...(selections[group.id] || [])] };
  const cur = next[group.id];
  const idx = cur.indexOf(optionId);
  if (isSingleChoice(group)) {
    next[group.id] = idx === -1 ? [optionId] : []; // radio; allow deselect only if min 0
    if (idx !== -1 && (group.min || 0) >= 1) next[group.id] = [optionId]; // keep required pick
  } else if (idx === -1) {
    if (group.max == null || cur.length < group.max) cur.push(optionId);
  } else {
    cur.splice(idx, 1);
  }
  return next;
}

// Total points for a configured unit = base cost + sum of selected option costs.
// (Conditional / size-scaling modifiers are approximated by option costs only;
// see plan's engine boundary.)
export function computePoints(unit, selections) {
  // A sized unit's base is its per-size tier cost; otherwise the flat baseCost.
  let total = unit.size ? sizeCost(unit.size, currentSize(unit, selections)) : (unit.baseCost || 0);
  for (const g of unit.optionGroups) {
    const chosen = selections[g.id] || [];
    for (const optId of chosen) {
      const opt = g.options.find((o) => o.id === optId);
      if (opt) total += opt.cost || 0;
    }
  }
  return total;
}

// Total points for a configured unit including any assigned enhancement.
export function totalWithEnhancement(unit, selections, enhancement) {
  return computePoints(unit, selections) + (enhancement ? enhancement.cost || 0 : 0);
}

// Human-readable summary of the selected wargear (for roster export & display).
export function selectedOptions(unit, selections) {
  const out = [];
  for (const g of unit.optionGroups) {
    for (const optId of selections[g.id] || []) {
      const opt = g.options.find((o) => o.id === optId);
      if (opt) out.push({ group: g.name, name: opt.name, cost: opt.cost || 0 });
    }
  }
  return out;
}
