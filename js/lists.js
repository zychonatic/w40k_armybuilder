// Multi-list collection layer. Owns the set of saved army lists and which one
// is active, plus localStorage persistence and the one-time migration from the
// old single-roster key. Lower-level than roster.js — no DOM, and it must NOT
// import roster.js (roster.js imports this; keep the dependency one-way).

import { STORAGE_KEY, LISTS_KEY, DEFAULT_LIMIT } from './config.js';

// The persisted roster shape a list wraps: { faction, detachments, limit, entries }.
function emptyRoster() {
  return { faction: null, detachments: [], limit: DEFAULT_LIMIT, entries: [] };
}

// Coerce an arbitrary parsed object into a valid roster. Carries over the
// pre-11e single-`detachment` → `detachments[]` migration and defaults each
// detachment's dp (the logic that used to live in roster.load()).
function normalizeRoster(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  let detachments = Array.isArray(p.detachments) ? p.detachments : [];
  if (!detachments.length && p.detachment) detachments = [p.detachment];
  return {
    faction: p.faction || null,
    detachments: detachments.map((d) => ({ ...d, dp: d.dp || 1 })),
    limit: p.limit || DEFAULT_LIMIT,
    entries: Array.isArray(p.entries) ? p.entries : [],
  };
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

let counter = 0;
function newId() {
  counter += 1;
  return `l${Date.now().toString(36)}${counter}`;
}

function factionName(roster) {
  return roster.faction && roster.faction.label ? roster.faction.label : 'My Army';
}

// ---- persistence -----------------------------------------------------------

let collection = null; // cached in memory; the localStorage copy is the source of truth on first load

export function loadCollection() {
  if (collection) return collection;
  try {
    const raw = localStorage.getItem(LISTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const lists = Array.isArray(parsed.lists) ? parsed.lists : [];
      collection = {
        activeId: parsed.activeId || null,
        lists: lists.map((l) => ({
          id: l.id || newId(),
          name: l.name || 'Army',
          updatedAt: l.updatedAt || Date.now(),
          roster: normalizeRoster(l.roster),
        })),
      };
    }
  } catch (e) {
    console.warn('[lists] load failed', e);
  }
  if (!collection) collection = migrateOrEmpty();
  return collection;
}

export function saveCollection(coll) {
  collection = coll;
  try {
    localStorage.setItem(LISTS_KEY, JSON.stringify(coll));
  } catch (e) {
    console.warn('[lists] save failed', e);
  }
}

// First run under the multi-list schema: wrap the legacy single roster (if any)
// as one list. The old key is left in place as a backup.
function migrateOrEmpty() {
  let lists = [];
  let activeId = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const roster = normalizeRoster(JSON.parse(raw));
      const id = newId();
      lists = [{ id, name: factionName(roster), updatedAt: Date.now(), roster }];
      activeId = id;
    }
  } catch (e) {
    console.warn('[lists] migration failed', e);
  }
  const coll = { activeId, lists };
  saveCollection(coll);
  return coll;
}

function coll() { return collection || loadCollection(); }

// ---- accessors -------------------------------------------------------------

export function all() { return coll().lists; }

export function getActive() {
  const c = coll();
  return c.lists.find((l) => l.id === c.activeId) || null;
}

export function find(id) {
  return coll().lists.find((l) => l.id === id) || null;
}

// Light per-list metadata for the overview cards, most-recently-edited first.
export function summaries() {
  return coll().lists
    .map((l) => ({
      id: l.id,
      name: l.name,
      factionLabel: l.roster.faction && l.roster.faction.label ? l.roster.faction.label : null,
      total: l.roster.entries.reduce((s, e) => s + (e.points || 0), 0),
      limit: l.roster.limit || DEFAULT_LIMIT,
      unitCount: l.roster.entries.length,
      detachmentCount: l.roster.detachments.length,
      updatedAt: l.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ---- mutators --------------------------------------------------------------

export function setActive(id) {
  const c = coll();
  c.activeId = id;
  saveCollection(c);
}

export function create(name) {
  const c = coll();
  const id = newId();
  c.lists.push({ id, name: name || 'New Army', updatedAt: Date.now(), roster: emptyRoster() });
  saveCollection(c);
  return id;
}

export function duplicate(id) {
  const c = coll();
  const src = c.lists.find((l) => l.id === id);
  if (!src) return null;
  const nid = newId();
  c.lists.push({ id: nid, name: `${src.name} (copy)`, updatedAt: Date.now(), roster: clone(src.roster) });
  saveCollection(c);
  return nid;
}

export function rename(id, name) {
  const c = coll();
  const l = c.lists.find((x) => x.id === id);
  if (!l || !name) return;
  l.name = name;
  l.updatedAt = Date.now();
  saveCollection(c);
}

export function remove(id) {
  const c = coll();
  c.lists = c.lists.filter((l) => l.id !== id);
  if (c.activeId === id) c.activeId = null;
  saveCollection(c);
}

// Persist the active list's roster — called by roster.save() on every emit.
// No-op when no list is active (e.g. while sitting on the overview).
export function saveActiveRoster(rosterState) {
  const c = coll();
  const l = c.lists.find((x) => x.id === c.activeId);
  if (!l) return;
  l.roster = clone(rosterState);
  l.updatedAt = Date.now();
  saveCollection(c);
}

// ---- export / import -------------------------------------------------------

// Pretty JSON for a single list ({ name, roster }), suitable for a .json file.
export function exportList(id) {
  const l = find(id);
  if (!l) return null;
  return JSON.stringify({ name: l.name, roster: l.roster }, null, 2);
}

// Parse an exported list and add it as a new list. Accepts either the
// { name, roster } wrapper or a bare roster object. Returns the new id; throws
// on invalid JSON so the caller can surface an error to the user.
export function importList(text) {
  const parsed = JSON.parse(text);
  const roster = normalizeRoster(parsed && parsed.roster ? parsed.roster : parsed);
  const name = (parsed && parsed.name && String(parsed.name)) || factionName(roster);
  const c = coll();
  const id = newId();
  c.lists.push({ id, name, updatedAt: Date.now(), roster });
  saveCollection(c);
  return id;
}
