// Catalogue indexing + unit normalization.
// Turns raw BSData/BattleScribe catalogue objects into a flat id->node index and
// then into simplified `unit` objects the UI can render.

const WEAPON_TYPES = new Set(['Ranged Weapons', 'Melee Weapons']);
const STAT_ORDER = ['M', 'T', 'Sv', 'W', 'LD', 'OC', 'InSv'];
const WEAPON_STAT_ORDER = ['Range', 'A', 'BS', 'WS', 'S', 'AP', 'D'];

// ---- generic helpers -------------------------------------------------------

// Depth-first walk over any nested BSData structure.
export function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
  } else if (node && typeof node === 'object') {
    visit(node);
    for (const key of Object.keys(node)) walk(node[key], visit);
  }
}

// Points value from a costs[] array.
export function getPts(costs) {
  if (!Array.isArray(costs)) return 0;
  const c = costs.find((x) => x && x.name === 'pts');
  return c ? Number(c.value) || 0 : 0;
}

// A characteristic's text value (note the BSData "$text" key).
function charText(ch) {
  if (!ch) return '';
  return ch['$text'] != null ? String(ch['$text']) : (ch.text != null ? String(ch.text) : '');
}

function getChar(profile, name) {
  const list = (profile && profile.characteristics) || [];
  const c = list.find((x) => x.name === name);
  return charText(c);
}

// ---- indexing --------------------------------------------------------------

// Build a merged id -> node index across all supplied catalogue objects.
export function buildIndex(catalogues) {
  const index = new Map();
  for (const cat of catalogues) {
    walk(cat, (node) => {
      if (typeof node.id === 'string' && !index.has(node.id)) index.set(node.id, node);
    });
  }
  return index;
}

// Resolve a link (entryLink / infoLink / categoryLink) to its target node.
function resolveTarget(link, index) {
  return link && link.targetId ? index.get(link.targetId) || null : null;
}

// ---- profile collection ----------------------------------------------------

// Gather all profiles reachable from a selection entry's subtree: its own
// profiles, profiles pulled in via infoLinks, and profiles on wargear reached
// via entryLinks / nested selection entries & groups. Bounded by a visited set
// and a depth cap so shared/category links can't cause runaway expansion.
function collectProfiles(entry, index, { maxDepth = 6 } = {}) {
  const out = [];
  const seenNodes = new Set();

  function addProfile(p) {
    if (p && p.characteristics) out.push(p);
  }

  function visitNode(node, depth) {
    if (!node || depth > maxDepth) return;
    // Avoid revisiting the same shared node.
    const key = node.id || node;
    if (seenNodes.has(key)) return;
    seenNodes.add(key);

    (node.profiles || []).forEach(addProfile);

    for (const il of node.infoLinks || []) {
      const t = resolveTarget(il, index);
      if (t) {
        if (t.characteristics) addProfile(t);
        else visitNode(t, depth + 1);
      }
    }
    for (const el of node.entryLinks || []) {
      const t = resolveTarget(el, index);
      if (t) visitNode(t, depth + 1);
    }
    for (const se of node.selectionEntries || []) visitNode(se, depth + 1);
    for (const g of node.selectionEntryGroups || []) visitNode(g, depth + 1);
  }

  visitNode(entry, 0);
  return out;
}

// Names of option pools that are codex-wide upgrades, not the unit's own kit.
const UPGRADE_POOL = /enhancement|crusade|relic|warlord trait|battle scar/i;

// Collect a unit's weapons: inline profiles + weapons reached through its own
// wargear (selection entries/groups and entryLinks to weapon entries), while
// skipping codex-wide enhancement/relic pools.
function collectWeapons(entry, index, { maxDepth = 8 } = {}) {
  const out = [];
  const seen = new Set();
  function visit(node, depth) {
    if (!node || depth > maxDepth) return;
    if (node.name && UPGRADE_POOL.test(node.name)) return;
    const key = node.id || node;
    if (seen.has(key)) return;
    seen.add(key);
    for (const p of node.profiles || []) {
      if (WEAPON_TYPES.has(p.typeName)) out.push(p);
    }
    for (const il of node.infoLinks || []) {
      const t = resolveTarget(il, index);
      if (t && WEAPON_TYPES.has(t.typeName) && t.characteristics) out.push(t);
      else if (t) visit(t, depth + 1);
    }
    for (const el of node.entryLinks || []) {
      const t = resolveTarget(el, index);
      if (t) visit(t, depth + 1);
    }
    for (const se of node.selectionEntries || []) visit(se, depth + 1);
    for (const g of node.selectionEntryGroups || []) visit(g, depth + 1);
  }
  visit(entry, 0);
  return out;
}

// Collect only a unit's INTRINSIC abilities (its own + its models' inline
// profiles and directly-attached shared abilities via infoLinks). Deliberately
// does NOT follow entryLinks, which lead into codex-wide enhancement/relic pools
// that would otherwise flood the unit with hundreds of unrelated abilities.
function collectAbilities(entry, index, { maxDepth = 3 } = {}) {
  const out = [];
  const seen = new Set();
  function visit(node, depth) {
    if (!node || depth > maxDepth) return;
    const key = node.id || node;
    if (seen.has(key)) return;
    seen.add(key);
    for (const p of node.profiles || []) {
      if (p.typeName === 'Abilities') out.push(p);
    }
    for (const il of node.infoLinks || []) {
      const t = resolveTarget(il, index);
      if (t && t.typeName === 'Abilities' && t.characteristics) out.push(t);
    }
    // Some units nest their ability profiles (incl. the "Leader"/"Support"
    // attach ability) inside an infoGroup container rather than listing them
    // directly under `profiles` — e.g. the Necron Overlord. Recurse into those.
    for (const ig of node.infoGroups || []) visit(ig, depth + 1);
    // Recurse only into constituent models, not wargear/enhancement links.
    for (const se of node.selectionEntries || []) {
      if (se.type === 'model') visit(se, depth + 1);
    }
    for (const g of node.selectionEntryGroups || []) visit(g, depth + 1);
  }
  visit(entry, 0);
  return out;
}

// Extract force-scoped "set hidden = true" conditions on a profile that depend
// on another selection being present/absent. BSData uses these to gate abilities
// to a detachment — e.g. a C'tan Shard's Distortion Fields (Aura) is hidden
// unless the Pantheon of Woe detachment is in the force. Returns
// [{ id, cmp }] where `id` is the depended-on selection (a detachment id) and
// `cmp` is 'absent' (hidden while `id` is NOT selected → the ability requires it)
// or 'present' (hidden while `id` IS selected → the ability is excluded by it).
function hiddenSelectionRules(profile) {
  const rules = [];
  const scan = (mods) => {
    for (const m of mods || []) {
      if (m.field !== 'hidden' || m.type !== 'set' || m.value !== true) continue;
      for (const c of m.conditions || []) {
        if (c.field !== 'selections' || c.scope !== 'force' || !c.childId) continue;
        const v = Number(c.value);
        let cmp = null;
        if ((c.type === 'lessThan' && v === 1) || (c.type === 'atMost' && v === 0)
            || (c.type === 'equalTo' && v === 0)) cmp = 'absent';
        else if ((c.type === 'atLeast' && v === 1) || (c.type === 'greaterThan' && v === 0)
            || (c.type === 'equalTo' && v >= 1)) cmp = 'present';
        if (cmp) rules.push({ id: c.childId, cmp });
      }
    }
  };
  scan(profile.modifiers);
  for (const mg of profile.modifierGroups || []) scan(mg.modifiers);
  return rules;
}

// Collect a unit's named special rules (Core/Faction rules such as Deep Strike,
// Scouts, Stealth, Infiltrators, Feel No Pain, Reanimation Protocols, …). These
// are `rule`-type infoLinks attached to the unit and its constituent models —
// NOT the weapon keywords (Lethal Hits, Rapid Fire, …), which hang off weapon
// entries and are excluded by the same model-only recursion collectAbilities
// uses. Each rule keeps its detachment `hideRules` so play-mode can gate rules
// that only apply under a specific detachment.
function collectRules(entry, index, { maxDepth = 3 } = {}) {
  const out = [];
  const seen = new Set();
  function visit(node, depth) {
    if (!node || depth > maxDepth) return;
    const key = node.id || node;
    if (seen.has(key)) return;
    seen.add(key);
    for (const il of node.infoLinks || []) {
      if (il.type === 'rule' && il.name && il.hidden !== true) {
        out.push({ name: ruleName(il), hideRules: hiddenSelectionRules(il) });
      }
    }
    for (const se of node.selectionEntries || []) {
      if (se.type === 'model') visit(se, depth + 1);
    }
    for (const g of node.selectionEntryGroups || []) visit(g, depth + 1);
  }
  visit(entry, 0);
  return out;
}

// A rule's display name with any `append`-to-name modifiers applied, e.g.
// "Scouts" + "6\"" → "Scouts 6\"", "Feel No Pain" + "5+" → "Feel No Pain 5+".
function ruleName(il) {
  let name = il.name;
  const scan = (mods) => {
    for (const m of mods || []) {
      if (m.field === 'name' && m.type === 'append' && m.value != null && m.value !== '') {
        name += ` ${m.value}`;
      }
    }
  };
  scan(il.modifiers);
  for (const mg of il.modifierGroups || []) scan(mg.modifiers);
  return name;
}

function toWeapon(profile) {
  const w = { name: profile.name, type: profile.typeName };
  for (const s of WEAPON_STAT_ORDER) {
    const v = getChar(profile, s);
    if (v) w[s] = v;
  }
  w.keywords = getChar(profile, 'Keywords');
  return w;
}

// ---- unit resolution -------------------------------------------------------

// Find the representative Unit statline for an entry. For a `model` it's the
// entry's own Unit profile; for a `unit` (squad) it's the first Unit profile
// found among its nested model entries.
function findStatline(entry, index) {
  const profiles = collectProfiles(entry, index, { maxDepth: 7 });
  const unitProfiles = profiles.filter((p) => p.typeName === 'Unit');
  return unitProfiles.map((p) => {
    const stat = { name: p.name };
    for (const s of STAT_ORDER) stat[s] = getChar(p, s);
    return stat;
  });
}

// Build the interactive option groups (wargear / model choices) for an entry.
// Crusade-mode option groups (Crusade Relics, Battle Honours, Weapon
// Modifications, …) are hidden from the builder. Word-boundary match so it
// never catches "Crusader Squad" / "Crusader's Helm".
const CRUSADE_GROUP = /\bcrusade\b/i;

function buildOptionGroups(entry, index) {
  const groups = [];

  function optionFromEntry(se) {
    const localProfiles = (se.profiles || [])
      .concat((se.infoLinks || []).map((il) => resolveTarget(il, index)).filter(Boolean));
    const weapons = collectProfiles(se, index, { maxDepth: 3 })
      .filter((p) => WEAPON_TYPES.has(p.typeName))
      .map(toWeapon);
    return {
      id: se.id,
      name: se.name,
      type: se.type,
      cost: getPts(se.costs),
      weapons: dedupeWeapons(weapons),
    };
  }

  function optionFromLink(el) {
    const t = resolveTarget(el, index);
    const name = el.name || (t && t.name) || 'Option';
    const weapons = t
      ? dedupeWeapons(collectProfiles(t, index, { maxDepth: 3 })
          .filter((p) => WEAPON_TYPES.has(p.typeName)).map(toWeapon))
      : [];
    return {
      id: el.id,
      targetId: el.targetId,
      name,
      type: 'link',
      cost: getPts(el.costs) || (t ? getPts(t.costs) : 0),
      weapons,
      unresolved: !t,
    };
  }

  function readConstraints(g) {
    let min = null; let max = null;
    for (const c of g.constraints || []) {
      if (c.type === 'min') min = Number(c.value);
      if (c.type === 'max') max = Number(c.value);
    }
    return { min, max };
  }

  function visitGroup(g, path) {
    if (g.name && CRUSADE_GROUP.test(g.name)) return; // skip Crusade-mode panels
    const { min, max } = readConstraints(g);
    const options = [];
    for (const se of g.selectionEntries || []) options.push(optionFromEntry(se));
    for (const el of g.entryLinks || []) options.push(optionFromLink(el));
    if (options.length) {
      groups.push({
        id: g.id,
        name: path ? `${path} · ${g.name}` : g.name,
        min, max,
        defaultId: g.defaultSelectionEntryId || null,
        options,
      });
    }
    // Recurse into nested groups (e.g. a model's "Weapon 1"/"Weapon 2").
    for (const se of g.selectionEntries || []) {
      for (const sub of se.selectionEntryGroups || []) visitGroup(sub, se.name);
    }
    for (const sub of g.selectionEntryGroups || []) visitGroup(sub, g.name);
  }

  for (const g of entry.selectionEntryGroups || []) visitGroup(g, '');
  // A model's directly-linked wargear (entryLinks not inside a group).
  const directLinks = (entry.entryLinks || []).filter((el) => el.type === 'selectionEntry');
  if (directLinks.length) {
    groups.push({
      id: `${entry.id}-direct`,
      name: 'Wargear',
      min: null, max: null,
      defaultId: null,
      options: directLinks.map(optionFromLink),
    });
  }
  return groups;
}

function dedupeByName(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

// Dedupe weapons by name AND profile type: many weapons (e.g. a Necron Staff of
// Light) list both a Ranged and a Melee profile under the same name — keying on
// name alone would silently drop one of them.
function dedupeWeapons(weapons) {
  const seen = new Set();
  const out = [];
  for (const w of weapons) {
    if (!w) continue;
    const key = `${w.name} ${w.type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

// The primary category = battlefield role; all categories = keywords.
function readCategories(entry) {
  const links = entry.categoryLinks || [];
  const primary = links.find((c) => c.primary);
  const keywords = links.map((c) => c.name).filter(Boolean);
  return {
    role: primary ? primary.name : (keywords[0] || 'Other'),
    keywords,
  };
}

// Determine a unit's variable size (model count) and its per-size point tiers.
// Returns { min, max, base, tiers:[{start,cost}] } sorted by start, or null when
// the unit has a fixed size (single model / no size choice).
//
// Model count comes from the entry's direct child groups that contain `model`
// sub-entries (summed, so a squad split into "Boyz" + "Boss Nob" groups totals
// correctly). Point tiers come from the entry's own `set` pts cost modifiers
// keyed on a model-count condition (`atLeast N` / `greaterThan N`); the base
// tier is the unit's listed cost at the minimum size.
function parseUnitSize(entry) {
  const ptsCost = (entry.costs || []).find((c) => c.name === 'pts');
  if (!ptsCost) return null;
  const ptsType = ptsCost.typeId;
  const base = Number(ptsCost.value) || 0;

  // ---- model-count range: sum direct model-bearing groups -------------------
  let min = 0; let max = 0; let found = false;
  for (const g of entry.selectionEntryGroups || []) {
    const modelEntries = (g.selectionEntries || []).filter((se) => se.type === 'model');
    if (!modelEntries.length) continue;
    let gmin = null; let gmax = null;
    for (const c of g.constraints || []) {
      if (c.field !== 'selections') continue;
      if (c.type === 'min') gmin = Number(c.value);
      if (c.type === 'max') gmax = Number(c.value);
    }
    // Group carries no count constraint of its own: fall back to its models'.
    if (gmin == null || gmax == null) {
      for (const se of modelEntries) {
        for (const c of se.constraints || []) {
          if (c.field !== 'selections') continue;
          if (c.type === 'min' && gmin == null) gmin = Number(c.value);
          if (c.type === 'max' && gmax == null) gmax = Number(c.value);
        }
      }
    }
    if (gmin != null || gmax != null) {
      found = true;
      min += gmin || 0;
      max += gmax || 0;
    }
  }
  min = Math.max(1, min);
  if (!found || max <= min) return null; // fixed size — no selector

  // ---- point tiers from the entry's own `set` pts modifiers -----------------
  const tierMap = new Map([[min, base]]);
  const scanMods = (mods) => {
    for (const m of mods || []) {
      if (m.field !== ptsType || m.type !== 'set') continue;
      for (const c of m.conditions || []) {
        if (c.field !== 'selections') continue;
        let start = null;
        if (c.type === 'atLeast') start = Number(c.value);
        else if (c.type === 'greaterThan') start = Number(c.value) + 1;
        if (start != null) { tierMap.set(start, Number(m.value) || 0); break; }
      }
    }
  };
  scanMods(entry.modifiers);
  for (const mg of entry.modifierGroups || []) scanMods(mg.modifiers);

  const tiers = [...tierMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, cost]) => ({ start, cost }));
  return { min, max, base, tiers };
}

// Normalize a raw selection entry into a simplified unit.
export function resolveUnit(entry, index) {
  const statlines = findStatline(entry, index);
  const weapons = dedupeWeapons(collectWeapons(entry, index).map(toWeapon));
  const abilities = dedupeByName(
    collectAbilities(entry, index)
      .map((p) => ({ name: p.name, text: getChar(p, 'Description'), hideRules: hiddenSelectionRules(p) })),
  );
  const rules = dedupeByName(collectRules(entry, index));
  const { role, keywords } = readCategories(entry);
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    legends: /\[\s*legends\s*\]/i.test(entry.name || ''),
    role,
    keywords,
    baseCost: getPts(entry.costs),
    size: parseUnitSize(entry),
    statlines,
    weapons,
    abilities,
    rules,
    optionGroups: buildOptionGroups(entry, index),
    raw: entry,
  };
}

// Description text from an entry's Abilities profile (used for enhancements).
function entryDescription(entry) {
  for (const p of entry.profiles || []) {
    if (p.characteristics) {
      const d = getChar(p, 'Description');
      if (d) return d;
    }
  }
  return '';
}

// Best-effort rule text: a shallow search for the first rules[] description or
// Abilities Description characteristic within a node's subtree.
function findRuleText(node, depth = 0) {
  if (!node || depth > 3) return '';
  for (const r of node.rules || []) if (r.description) return r.description;
  for (const p of node.profiles || []) {
    if (p.characteristics) {
      const d = getChar(p, 'Description');
      if (d) return d;
    }
  }
  for (const se of node.selectionEntries || []) {
    const t = findRuleText(se, depth + 1);
    if (t) return t;
  }
  return '';
}

// Collect a detachment's rule(s): inline rules[] first, else rules attached via
// infoLinks (how Necrons and some others store the detachment rule).
function detachmentRules(entry, index) {
  const rules = (entry.rules || []).map((r) => ({ name: r.name, text: r.description || '' }));
  if (!rules.length) {
    for (const il of entry.infoLinks || []) {
      const t = resolveTarget(il, index);
      rules.push({ name: il.name || (t && t.name) || 'Detachment Rule', text: t ? findRuleText(t) : '' });
    }
  }
  return rules;
}

// True for a selection entry that represents an enhancement: it consumes an
// "Enhancements" slot (a cost line named "Enhancements" with value ≥ 1).
function isEnhancementEntry(entry) {
  return entry && entry.type === 'upgrade'
    && (entry.costs || []).some((c) => c.name === 'Enhancements' && (Number(c.value) || 0) >= 1);
}

// Detachment ids that a node is gated to. Factions that share one enhancement
// pool (e.g. Necrons) tie each enhancement — or the group holding them — to its
// detachment with a condition of the form "…selections in this force of the
// detachment entry". Such conditions live on the node's modifiers (commonly a
// `set hidden` modifier) or constraints, nested arbitrarily deep in
// conditionGroups, so we recurse and keep only force-scoped selection refs to a
// known detachment id.
function forceScopedDetachmentRefs(node, detIdSet) {
  const ids = new Set();
  const consider = (c) => {
    if (c && c.childId && c.field === 'selections' && c.scope === 'force' && detIdSet.has(c.childId)) {
      ids.add(c.childId);
    }
  };
  const walkConds = (obj) => {
    if (!obj) return;
    for (const c of obj.conditions || []) consider(c);
    for (const cg of obj.conditionGroups || []) walkConds(cg);
  };
  for (const m of node.modifiers || []) walkConds(m);
  for (const mg of node.modifierGroups || []) for (const m of mg.modifiers || []) walkConds(m);
  for (const c of node.constraints || []) consider(c);
  return ids;
}

// Extract the faction's detachments. Detachments live inside container groups
// named "Detachment"; the real list is sometimes behind an entryLink, so we
// resolve through the index. Each detachment carries rule text (`rules[]`) and
// its enhancements, resolved two ways: a matching "<name> Enhancements" group
// (Space Marines etc.) and/or a shared enhancement pool where each entry is
// gated to the detachment via a `hidden` condition (Necrons etc.).
export function listDetachments(catalogues, index) {
  const containers = [];
  for (const cat of catalogues) {
    if (cat.type === 'gameSystem') continue;
    walk(cat, (n) => {
      if (n.name === 'Detachment' && (n.selectionEntries || n.entryLinks)) containers.push(n);
    });
  }

  const entries = new Map(); // id -> detachment entry
  function collect(group, depth) {
    if (!group || depth > 3) return;
    for (const se of group.selectionEntries || []) {
      if (se.type === 'upgrade' && !se.hidden) entries.set(se.id, se);
    }
    for (const el of group.entryLinks || []) {
      const t = resolveTarget(el, index);
      if (!t) continue;
      if (t.type === 'upgrade') entries.set(t.id, t);
      else collect(t, depth + 1); // nested "Detachment" group
    }
  }
  for (const c of containers) collect(c, 0);

  const detIdSet = new Set(entries.keys());

  // Index enhancement groups by name for quick "<Detachment> Enhancements" lookup
  // (Method A), and map each detachment id to the enhancement entries gated to it
  // (Method B). A gated node contributes its enhancement entries: itself if it is
  // one, otherwise any enhancement entries in its subtree (handles both
  // per-enhancement gating and whole-group gating).
  const enhByName = new Map();
  const enhByDetId = new Map(); // detId -> Map(enhId -> entry)
  const addEnh = (detId, en) => {
    if (!enhByDetId.has(detId)) enhByDetId.set(detId, new Map());
    const m = enhByDetId.get(detId);
    if (!m.has(en.id)) m.set(en.id, en);
  };
  for (const cat of catalogues) {
    if (cat.type === 'gameSystem') continue;
    walk(cat, (n) => {
      if (typeof n.name === 'string' && /Enhancements$/.test(n.name) && n.selectionEntries) {
        enhByName.set(n.name, n);
      }
      const refs = forceScopedDetachmentRefs(n, detIdSet);
      if (!refs.size) return;
      const enhs = [];
      if (isEnhancementEntry(n)) enhs.push(n);
      else walk(n, (m) => { if (m !== n && isEnhancementEntry(m)) enhs.push(m); });
      for (const detId of refs) for (const en of enhs) addEnh(detId, en);
    });
  }

  const mkEnh = (en) => ({
    id: en.id, name: en.name, cost: getPts(en.costs), text: entryDescription(en),
  });

  const dets = [];
  for (const e of entries.values()) {
    const rules = detachmentRules(e, index);
    const byId = new Map();
    // Method A: a dedicated "<Detachment> Enhancements" group.
    const enhGroup = enhByName.get(`${e.name} Enhancements`);
    if (enhGroup) {
      for (const en of enhGroup.selectionEntries || []) {
        if (!en.hidden) byId.set(en.id, mkEnh(en));
      }
    }
    // Method B: shared-pool entries gated to this detachment id.
    const gated = enhByDetId.get(e.id);
    if (gated) for (const en of gated.values()) if (!byId.has(en.id)) byId.set(en.id, mkEnh(en));

    const enhancements = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    dets.push({ id: e.id, name: e.name, rules, enhancements });
  }
  dets.sort((a, b) => a.name.localeCompare(b.name));
  return dets;
}

// Units carrying the "[Crucible]" sub-faction tag are hidden from the builder.
const HIDDEN_UNIT_TAG = /\[\s*crucible\s*\]/i;

// List all buildable units in a faction bundle: type model/unit, has a Unit
// profile and a positive points cost. Returns resolved unit objects sorted by
// role then name.
export function listUnits(catalogues, index) {
  const units = [];
  const seen = new Set();
  for (const cat of catalogues) {
    // Only pull units from actual faction/library catalogues, not the game system.
    if (cat.type === 'gameSystem') continue;
    const entries = (cat.sharedSelectionEntries || []).concat(cat.selectionEntries || []);
    for (const e of entries) {
      if (!e || seen.has(e.id)) continue;
      if (e.type !== 'model' && e.type !== 'unit') continue;
      if (e.hidden) continue;
      if (HIDDEN_UNIT_TAG.test(e.name || '')) continue; // hide [Crucible] variants
      const pts = getPts(e.costs);
      if (pts <= 0) continue; // skip 0-pt sub-components / upgrades
      const unit = resolveUnit(e, index);
      if (!unit.statlines.length) continue; // must have a statline
      seen.add(e.id);
      units.push(unit);
    }
  }
  units.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  annotateLeaders(units);
  return units;
}

// Normalise a unit name for matching leader-target text against real unit names
// (case-insensitive, drop [Legends] tags, collapse whitespace incl. NBSP).
function normName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\[legends\]/g, '')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

// Extract the unit names listed in a "Leader" ability's description. The text
// reads "This model can be attached to the following units:" then one bulleted
// (■, U+25A0) line per unit, in uppercase.
function parseLeaderTargets(text) {
  if (!text) return [];
  return text.split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^■/.test(l))
    .map((l) => l.replace(/^[■\s]+/, '').trim())
    .filter(Boolean);
}

// The Character→attachable-units relationship isn't structured in BSData; derive
// it from the free-text ability by name-matching against loaded units. Two
// ability names carry the same ■-bulleted target list: "Leader" (optional — the
// character can operate on its own) and "Support" (mandatory — the character
// must be attached to one of the listed units). They are mutually exclusive.
// Sets `unit.leaderUnitIds` (attachable target ids) and `unit.mandatoryAttach`.
function annotateLeaders(units) {
  const nameIndex = new Map();
  for (const u of units) {
    const k = normName(u.name);
    if (!nameIndex.has(k)) nameIndex.set(k, u.id);
  }
  for (const u of units) {
    u.leaderUnitIds = [];
    u.mandatoryAttach = false;
    if (!u.keywords.includes('Character')) continue;
    const byName = (name) => u.abilities.find((a) => a.name && a.name.toLowerCase() === name);
    const leader = byName('leader');
    const support = byName('support');
    const src = leader || support;
    if (!src) continue;
    u.mandatoryAttach = !leader && !!support; // "Support" without "Leader" = must attach
    for (const tok of parseLeaderTargets(src.text)) {
      const id = nameIndex.get(normName(tok));
      if (id && id !== u.id && !u.leaderUnitIds.includes(id)) u.leaderUnitIds.push(id);
    }
  }
}
