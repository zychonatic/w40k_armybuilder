// Army roster state: entries, totals, persistence, export.

import { DEFAULT_LIMIT } from './config.js';
import { selectedOptions, currentSize, totalWithEnhancement } from './engine.js';
import * as lists from './lists.js';

let state = {
  faction: null, // { file, label }
  // 11e: several detachments up to a DP budget. { id, name, rules:[{name,text}], dp }
  detachments: [],
  limit: DEFAULT_LIMIT,
  entries: [], // { uid, unitId, unitName, role, points, modelCount, enhancementId, options:[{group,name,cost}], selections, attachedToUid? }
};

// Clone a selections object ({ [groupId]: string[], __size, __enh }) so the
// stored copy can't be mutated by later edits to the live selections.
function cloneSelections(sel) {
  const out = {};
  for (const k in sel) out[k] = Array.isArray(sel[k]) ? [...sel[k]] : sel[k];
  return out;
}

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(state); save(); }

export function getState() { return state; }

let counter = 0;
function newUid() {
  counter += 1;
  return `u${Date.now().toString(36)}${counter}`;
}

export function setFaction(faction) {
  state = { ...state, faction };
  emit();
}

export function setLimit(limit) {
  state = { ...state, limit: Number(limit) || DEFAULT_LIMIT };
  emit();
}

function slimDet(det) {
  return { id: det.id, name: det.name, rules: det.rules || [], dp: det.dp || 1 };
}

export function addDetachment(det) {
  if (!det || state.detachments.some((d) => d.id === det.id)) return;
  state = { ...state, detachments: [...state.detachments, slimDet(det)] };
  emit();
}

export function removeDetachment(id) {
  state = { ...state, detachments: state.detachments.filter((d) => d.id !== id) };
  emit();
}

// Total detachment points currently committed.
export function dpUsed() {
  return state.detachments.reduce((sum, d) => sum + (d.dp || 1), 0);
}

// After a faction (re)loads, keep only detachments that still exist and refresh
// their name/rules/dp from the freshly parsed catalogue. `byId` is a Map(id->det).
export function reconcileDetachments(byId) {
  const kept = state.detachments
    .filter((d) => byId.has(d.id))
    .map((d) => slimDet(byId.get(d.id)));
  if (kept.length !== state.detachments.length
      || kept.some((d, i) => d.dp !== state.detachments[i].dp)) {
    state = { ...state, detachments: kept };
    emit();
  }
}

// Drop enhancements whose ids are no longer legal (e.g. their detachment was
// removed): strip the option line, refund its cost, clear the assignment.
export function stripEnhancements(ids) {
  let changed = false;
  const entries = state.entries.map((e) => {
    if (!e.enhancementId || !ids.has(e.enhancementId)) return e;
    changed = true;
    const enhOpt = e.options.find((o) => o.group === 'Enhancement');
    return {
      ...e,
      enhancementId: null,
      points: e.points - (enhOpt ? enhOpt.cost || 0 : 0),
      options: e.options.filter((o) => o.group !== 'Enhancement'),
    };
  });
  if (changed) { state = { ...state, entries }; emit(); }
}

// Add a configured unit to the roster. `enhancement` (optional) is a detachment
// enhancement assigned to a Character: its cost is folded into the unit and it is
// shown as an option line.
export function addEntry(unit, selections, enhancement = null) {
  const options = selectedOptions(unit, selections);
  if (enhancement) {
    options.push({ group: 'Enhancement', name: enhancement.name, cost: enhancement.cost || 0 });
  }
  const entry = {
    uid: newUid(),
    unitId: unit.id,
    unitName: unit.name,
    role: unit.role,
    points: totalWithEnhancement(unit, selections, enhancement),
    modelCount: currentSize(unit, selections),
    enhancementId: enhancement ? enhancement.id : null,
    options,
    selections: cloneSelections(selections),
  };
  state = { ...state, entries: [...state.entries, entry] };
  emit();
  return entry;
}

// Re-configure an existing entry in place: recompute options/points/size/
// enhancement from fresh selections, preserving the entry's uid and position.
export function updateEntry(uid, unit, selections, enhancement = null) {
  const idx = state.entries.findIndex((e) => e.uid === uid);
  if (idx === -1) return;
  const options = selectedOptions(unit, selections);
  if (enhancement) {
    options.push({ group: 'Enhancement', name: enhancement.name, cost: enhancement.cost || 0 });
  }
  const updated = {
    ...state.entries[idx],
    unitName: unit.name,
    role: unit.role,
    points: totalWithEnhancement(unit, selections, enhancement),
    modelCount: currentSize(unit, selections),
    enhancementId: enhancement ? enhancement.id : null,
    options,
    selections: cloneSelections(selections),
  };
  const entries = [...state.entries];
  entries[idx] = updated;
  state = { ...state, entries };
  emit();
}

export function removeEntry(uid) {
  const entries = state.entries
    .filter((e) => e.uid !== uid)
    // If a host unit is removed, detach any leader that was attached to it.
    .map((e) => (e.attachedToUid === uid ? { ...e, attachedToUid: null } : e));
  state = { ...state, entries };
  emit();
}

// Attach a character entry to a host unit entry (or detach with a falsy target).
// Eligibility is validated by the caller (app.js has the unit catalogue).
export function setAttachment(charUid, targetUid) {
  const entries = state.entries.map((e) => (
    e.uid === charUid ? { ...e, attachedToUid: targetUid || null } : e
  ));
  state = { ...state, entries };
  emit();
}

export function clear() {
  state = { ...state, entries: [] };
  emit();
}

export function total() {
  return state.entries.reduce((sum, e) => sum + (e.points || 0), 0);
}

// ---- persistence -----------------------------------------------------------
// The store holds the *active* list's roster; persistence targets that list's
// slot in the collection (js/lists.js), not a flat key. The pre-11e schema
// migration now lives in lists.js (it wraps the legacy single roster).

export function save() {
  lists.saveActiveRoster(state);
}

// Replace the live state with a given list's roster (deep-cloned so later edits
// can't mutate the stored copy) and re-render. Used when opening/switching lists.
export function loadRoster(roster) {
  const src = roster || {};
  state = {
    faction: src.faction || null,
    detachments: Array.isArray(src.detachments) ? src.detachments.map((d) => ({ ...d })) : [],
    limit: src.limit || DEFAULT_LIMIT,
    entries: Array.isArray(src.entries) ? src.entries.map((e) => ({ ...e })) : [],
  };
  emit();
  return state;
}

// ---- export ----------------------------------------------------------------

export function exportText() {
  const lines = [];
  const title = state.faction ? state.faction.label : 'Army';
  lines.push(`=== ${title} — ${total()} / ${state.limit} pts ===`);
  if (state.detachments.length) {
    const names = state.detachments.map((d) => `${d.name} (${d.dp || 1} DP)`).join(', ');
    lines.push(`Detachments (${dpUsed()} DP): ${names}`);
  }
  lines.push('');
  // Attachment lookups: name of the host a character joins, and leaders per host.
  const byUid = new Map(state.entries.map((e) => [e.uid, e]));
  const leadersOf = new Map();
  for (const e of state.entries) {
    if (!e.attachedToUid || !byUid.has(e.attachedToUid)) continue;
    if (!leadersOf.has(e.attachedToUid)) leadersOf.set(e.attachedToUid, []);
    leadersOf.get(e.attachedToUid).push(e.unitName);
  }
  // Group by role for readability.
  const byRole = new Map();
  for (const e of state.entries) {
    if (!byRole.has(e.role)) byRole.set(e.role, []);
    byRole.get(e.role).push(e);
  }
  for (const [role, entries] of byRole) {
    lines.push(`# ${role}`);
    for (const e of entries) {
      const sizeStr = e.modelCount ? ` (${e.modelCount} models)` : '';
      lines.push(`  ${e.unitName}${sizeStr} — ${e.points} pts`);
      const host = e.attachedToUid && byUid.get(e.attachedToUid);
      if (host) lines.push(`      ↳ attached to ${host.unitName}`);
      if (leadersOf.has(e.uid)) lines.push(`      Leader: ${leadersOf.get(e.uid).join(', ')}`);
      for (const o of e.options) {
        lines.push(`      • ${o.name}${o.cost ? ` (+${o.cost})` : ''}`);
      }
    }
    lines.push('');
  }
  lines.push(`Total: ${total()} pts`);
  return lines.join('\n');
}
