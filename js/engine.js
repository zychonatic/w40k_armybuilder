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
