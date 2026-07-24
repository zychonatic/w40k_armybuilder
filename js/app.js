// Bootstrap + orchestration.

import { POINTS_PRESETS, dpBudget, normDetName } from './config.js';
import {
  loadFactionList, loadCatalogueBundle, loadDetachmentPoints, loadStratagemData,
} from './data.js';
import { buildIndex, listUnits, listDetachments } from './catalogue.js';
import { buildStratIndex, resolveArmyStratagems } from './stratagems.js';
import {
  defaultSelections, toggleOption, SIZE_KEY, ENH_KEY, isCharacter, selectedEnhancement,
  selectionsFromEntry,
} from './engine.js';
import * as roster from './roster.js';
import * as ui from './ui.js';

const dom = {
  factionSelect: document.getElementById('faction-select'),
  detachmentSelect: document.getElementById('detachment-select'),
  detachmentBar: document.getElementById('detachment-bar'),
  limitSelect: document.getElementById('limit-select'),
  status: document.getElementById('status'),
  unitFilter: document.getElementById('unit-filter'),
  toggleLegends: document.getElementById('toggle-legends'),
  unitList: document.getElementById('unit-list'),
  unitDetail: document.getElementById('unit-detail'),
  rosterList: document.getElementById('roster-list'),
  btnExport: document.getElementById('btn-export'),
  btnPrint: document.getElementById('btn-print'),
  btnClear: document.getElementById('btn-clear'),
  printRoot: document.getElementById('print-root'),
  modalClose: document.getElementById('modal-close'),
  btnCopy: document.getElementById('btn-copy'),
  modal: document.getElementById('modal'),
  editModal: document.getElementById('edit-modal'),
  editModalBox: document.querySelector('#edit-modal .modal-box'),
  editModalBody: document.getElementById('edit-modal-body'),
  editModalClose: document.getElementById('edit-modal-close'),
  btnPlay: document.getElementById('btn-play'),
  playOverlay: document.getElementById('play-overlay'),
  playBody: document.getElementById('play-body'),
  playClose: document.getElementById('play-close'),
  playStrats: document.getElementById('play-strats'),
  mobileTabs: document.querySelectorAll('.mobile-tabs button'),
  detailBack: document.querySelector('.detail-back'),
};

const app = {
  factions: [],
  units: [],
  detachments: [],
  index: null,
  currentUnit: null,
  selections: {},
  edit: { uid: null, unit: null, selections: {} },
  play: { view: 'grid', uid: null, unitById: null },
  strats: null, // built stratagem index, lazily loaded on first play-mode use
  filter: '',
  showLegends: false,
};

// ---- mobile navigation -----------------------------------------------------
// On phones the layout collapses to two tabs (Units / Army) with the unit
// detail shown as a full-screen sheet. These body classes are inert on desktop
// (the overlay/tab CSS lives only inside the phone media query).

function setMobileTab(tab) {
  document.body.classList.toggle('tab-units', tab === 'units');
  document.body.classList.toggle('tab-army', tab === 'army');
  dom.mobileTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}

// Open/close the mobile detail sheet.
function openDetailSheet() { document.body.classList.add('detail-open'); }
function closeDetailSheet() { document.body.classList.remove('detail-open'); }

// ---- roster rendering ------------------------------------------------------

function refreshRoster() {
  const state = roster.getState();
  ui.renderRoster(dom.rosterList, state, roster.total(), state.limit, {
    onRemove: (uid) => roster.removeEntry(uid),
    onEdit: (uid) => editEntry(uid),
    onAttach: (charUid, targetUid) => roster.setAttachment(charUid, targetUid || null),
    attach: buildAttachVM(),
  });
  refreshDetachmentControls();
}
roster.subscribe(refreshRoster);

// Build a view-model describing character→unit attachments in the current army:
// which characters can attach (and to which army entries), the current target,
// and the reverse host→leaders grouping. `unitById` resolves full unit data
// (present only for the loaded faction), which carries `leaderUnitIds` and
// `mandatoryAttach` (a "Support" character that must be attached to a unit).
function buildAttachVM() {
  const entries = roster.getState().entries;
  const unitById = new Map(app.units.map((u) => [u.id, u]));
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  const leaderUnit = (e) => {
    const u = unitById.get(e.unitId);
    return u && isCharacter(u) && u.leaderUnitIds && u.leaderUnitIds.length ? u : null;
  };
  const mandatory = new Set(); // character uids that MUST be attached (Support)

  // Validated current target per character, and reverse host→leaders map.
  const currentTarget = new Map();
  const attachedLeaders = new Map();
  const hiddenUids = new Set();
  const partnerLabel = new Map();
  for (const e of entries) {
    const u = leaderUnit(e);
    if (!u) continue;
    if (u.mandatoryAttach) mandatory.add(e.uid);
    const target = e.attachedToUid && byUid.get(e.attachedToUid) ? e.attachedToUid : null;
    currentTarget.set(e.uid, target);
    if (target) {
      if (!attachedLeaders.has(target)) attachedLeaders.set(target, []);
      attachedLeaders.get(target).push(e);
      hiddenUids.add(e.uid);
      partnerLabel.set(e.uid, { ledLabel: `Leading ${byUid.get(target).unitName}`, partnerUid: target });
      partnerLabel.set(target, { ledLabel: `Led by ${e.unitName}`, partnerUid: e.uid });
    }
  }

  // Hosts that already have an OPTIONAL leader (a Support character can still
  // join a unit that already has a leader; an optional leader cannot).
  const hostHasLeader = new Set();
  for (const [hostUid, leaders] of attachedLeaders) {
    if (leaders.some((l) => !mandatory.has(l.uid))) hostHasLeader.add(hostUid);
  }

  // Eligible targets for each character's picker: army entries in the
  // character's leaderUnitIds. Optional leaders can't pick a host that already
  // has a leader (unless it's the current target); Support characters can.
  const pickerOptions = new Map();
  for (const e of entries) {
    const u = leaderUnit(e);
    if (!u) continue;
    const isMand = mandatory.has(e.uid);
    const options = entries.filter((t) => (
      t.uid !== e.uid
      && u.leaderUnitIds.includes(t.unitId)
      && (isMand || !hostHasLeader.has(t.uid) || currentTarget.get(e.uid) === t.uid)
    )).map((t) => ({ uid: t.uid, name: t.unitName }));
    if (options.length || currentTarget.get(e.uid) || isMand) {
      pickerOptions.set(e.uid, options);
    }
  }

  return { pickerOptions, currentTarget, attachedLeaders, hiddenUids, partnerLabel, mandatory };
}

// ---- detachment ------------------------------------------------------------

// Render both detachment controls: the "add" picker in the top bar and the
// chip list + DP counter in the army panel.
function refreshDetachmentControls() {
  const state = roster.getState();
  const budget = dpBudget(state.limit);
  const used = roster.dpUsed();
  ui.renderDetachmentPicker(dom.detachmentSelect, app.detachments, {
    selectedIds: new Set(state.detachments.map((d) => d.id)),
    dpRemaining: budget - used,
    onAdd: addDetachment,
  });
  ui.renderDetachmentBar(dom.detachmentBar, state.detachments, {
    dpUsed: used,
    dpBudget: budget,
    onView: showDetachment,
    onRemove: removeDetachment,
  });
}

// Show a specific detachment's rules + enhancements in the detail panel.
function showDetachment(id) {
  const det = app.detachments.find((d) => d.id === id) || null;
  app.currentUnit = null;
  renderList();
  ui.renderDetachmentDetail(dom.unitDetail, det);
  openDetailSheet();
}

function addDetachment(id) {
  const det = app.detachments.find((d) => d.id === id);
  if (!det) return;
  // Guard the budget even though the picker disables over-budget options.
  if (roster.dpUsed() + (det.dp || 1) > dpBudget(roster.getState().limit)) return;
  roster.addDetachment(det);
  showDetachment(id);
}

function removeDetachment(id) {
  // Enhancements from this detachment are no longer legal — strip them first.
  const det = app.detachments.find((d) => d.id === id);
  if (det) roster.stripEnhancements(new Set(det.enhancements.map((e) => e.id)));
  roster.removeDetachment(id);
}

// Enhancements offered by any currently-selected detachment (pooled, deduped).
function currentEnhancements() {
  const out = [];
  const seen = new Set();
  for (const sel of roster.getState().detachments) {
    const det = app.detachments.find((d) => d.id === sel.id);
    if (!det) continue;
    for (const e of det.enhancements) {
      if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
    }
  }
  return out;
}

// Enhancement ids already assigned to units in the army (once-per-army rule).
// `excludeUid` skips one entry — used when editing so a unit's own enhancement
// isn't flagged as "in use" against itself.
function usedEnhancementIds(excludeUid = null) {
  return new Set(roster.getState().entries
    .filter((e) => e.uid !== excludeUid)
    .map((e) => e.enhancementId)
    .filter(Boolean));
}

// ---- unit detail -----------------------------------------------------------

function showUnit(unitId) {
  const unit = app.units.find((u) => u.id === unitId) || null;
  app.currentUnit = unit;
  app.selections = unit ? defaultSelections(unit) : {};
  renderDetail();
  renderList(); // update active highlight
  openDetailSheet();
}

// Detachment context for gating detachment-specific abilities/rules: the ids
// currently selected in the army, and all ids the faction offers.
function detCtx() {
  return {
    selected: new Set(roster.getState().detachments.map((d) => d.id)),
    all: new Set(app.detachments.map((d) => d.id)),
  };
}

function renderDetail() {
  const enhancements = isCharacter(app.currentUnit) ? currentEnhancements() : [];
  ui.renderUnitDetail(dom.unitDetail, app.currentUnit, app.selections, {
    onToggle: (groupId, optionId) => {
      const group = app.currentUnit.optionGroups.find((g) => g.id === groupId);
      if (!group) return;
      app.selections = toggleOption(app.currentUnit, app.selections, group, optionId);
      renderDetail();
    },
    onSize: (n) => {
      app.selections = { ...app.selections, [SIZE_KEY]: n };
      renderDetail();
    },
    onEnhance: (enhId) => {
      app.selections = { ...app.selections, [ENH_KEY]: enhId || null };
      renderDetail();
    },
    onAdd: () => {
      if (!app.currentUnit) return;
      const enh = selectedEnhancement(enhancements, app.selections);
      roster.addEntry(app.currentUnit, app.selections, enh);
      // Release the just-assigned enhancement so it can't be handed out twice.
      if (enh) {
        app.selections = { ...app.selections, [ENH_KEY]: null };
        renderDetail();
      }
    },
  }, {
    list: enhancements,
    usedIds: usedEnhancementIds(),
    hasDetachment: roster.getState().detachments.length > 0,
    dets: detCtx(),
  });
}

// ---- edit an existing roster entry -----------------------------------------

function editEntry(uid) {
  const entry = roster.getState().entries.find((e) => e.uid === uid);
  if (!entry) return;
  const unit = app.units.find((u) => u.id === entry.unitId) || null;
  app.edit = {
    uid,
    unit,
    selections: unit ? selectionsFromEntry(unit, entry) : {},
  };
  ui.openEditModal(unit ? `Edit ${unit.name}` : `Edit ${entry.unitName}`);
  renderEdit();
}

function renderEdit() {
  const { unit } = app.edit;
  const enhancements = isCharacter(unit) ? currentEnhancements() : [];
  ui.renderUnitEditor(dom.editModalBody, dom.editModalBox, unit, app.edit.selections, {
    onToggle: (groupId, optionId) => {
      const group = unit.optionGroups.find((g) => g.id === groupId);
      if (!group) return;
      app.edit.selections = toggleOption(unit, app.edit.selections, group, optionId);
      renderEdit();
    },
    onSize: (n) => {
      app.edit.selections = { ...app.edit.selections, [SIZE_KEY]: n };
      renderEdit();
    },
    onEnhance: (enhId) => {
      app.edit.selections = { ...app.edit.selections, [ENH_KEY]: enhId || null };
      renderEdit();
    },
    onSave: () => {
      const enh = isCharacter(unit) ? selectedEnhancement(enhancements, app.edit.selections) : null;
      roster.updateEntry(app.edit.uid, unit, app.edit.selections, enh);
      ui.closeEditModal();
    },
  }, {
    list: enhancements,
    usedIds: usedEnhancementIds(app.edit.uid),
    hasDetachment: roster.getState().detachments.length > 0,
  });
}

// ---- play mode -------------------------------------------------------------

function enterPlayMode() {
  const state = roster.getState();
  app.play.unitById = new Map(app.units.map((u) => [u.id, u]));
  const heading = state.faction ? state.faction.label : 'Army';
  const sub = `${roster.total()} / ${state.limit} pts · ${state.entries.length} unit(s)`;
  ui.openPlayMode(heading, sub);
  showPlayGrid();
}

function showPlayGrid() {
  app.play.view = 'grid';
  ui.renderPlayGrid(dom.playBody, roster.getState().entries, app.play.unitById, {
    onSelect: showPlaySheet,
    attach: buildAttachVM(),
  });
}

function showPlaySheet(uid) {
  const entry = roster.getState().entries.find((e) => e.uid === uid);
  if (!entry) return;
  const unit = app.play.unitById.get(entry.unitId) || null;
  app.play.view = 'sheet';
  ui.renderPlayDatasheet(dom.playBody, entry, unit, {
    onBack: showPlayGrid,
    partner: buildAttachVM().partnerLabel.get(uid) || null,
    onPartner: showPlaySheet,
    dets: detCtx(),
  });
}

// The stratagem dataset is fetched once (lazily) and cached in app.strats;
// failures degrade to empty sections so callers can proceed unconditionally.
async function ensureStrats() {
  if (!app.strats) {
    try {
      app.strats = buildStratIndex(await loadStratagemData());
    } catch (e) {
      console.warn('[app] stratagem load failed', e);
      app.strats = { core: [], byDet: new Map() };
    }
  }
  return app.strats;
}

// Stratagem reference screen (play mode).
async function showPlayStrats() {
  app.play.view = 'strats';
  if (!app.strats) dom.playBody.innerHTML = '<p class="hint">Loading stratagems…</p>';
  await ensureStrats();
  if (app.play.view !== 'strats') return; // user navigated away while loading
  const vm = resolveArmyStratagems(app.strats, roster.getState().detachments);
  ui.renderPlayStratagems(dom.playBody, vm, { onBack: showPlayGrid });
}

function exitPlayMode() {
  ui.closePlayMode();
  app.play.view = 'grid';
}

function renderList() {
  ui.renderUnitList(dom.unitList, app.units, {
    filter: app.filter,
    activeId: app.currentUnit ? app.currentUnit.id : null,
    showLegends: app.showLegends,
    onSelect: showUnit,
  });
}

// ---- faction loading -------------------------------------------------------

async function selectFaction(file) {
  app.currentUnit = null;
  app.selections = {};
  ui.clearDetailFoot();
  closeDetailSheet();
  dom.unitDetail.innerHTML = '<p class="hint">Click a unit to see its stats and wargear.</p>';
  if (!file) {
    app.units = [];
    app.detachments = [];
    refreshDetachmentControls();
    dom.unitList.innerHTML = '<p class="hint">Select a faction to browse its units.</p>';
    return;
  }
  try {
    ui.setStatus(dom.status, 'Loading…', true);
    const { catalogues, missing } = await loadCatalogueBundle(file, (msg) => ui.setStatus(dom.status, msg, true));
    ui.setStatus(dom.status, 'Indexing…', true);
    app.index = buildIndex(catalogues);
    app.units = listUnits(catalogues, app.index);
    app.detachments = listDetachments(catalogues, app.index);

    // Merge detachment-point costs from the MFM data (default 1 if unavailable).
    const dpMap = await loadDetachmentPoints(file);
    for (const d of app.detachments) d.dp = dpMap.get(normDetName(d.name)) || 1;

    // Keep only selected detachments that still exist for this faction.
    roster.reconcileDetachments(new Map(app.detachments.map((d) => [d.id, d])));
    refreshDetachmentControls();

    roster.setFaction({ file, label: file.replace(/\.json$/i, '') });
    let msg = `${app.units.length} units · ${app.detachments.length} detachments`;
    if (missing.length) msg += ` · ${missing.length} linked file(s) unavailable`;
    ui.setStatus(dom.status, msg, false);
    renderList();
  } catch (e) {
    console.error(e);
    ui.setStatus(dom.status, 'Failed to load faction', false);
    dom.unitList.innerHTML = `<p class="hint">Error: ${e.message}</p>`;
  }
}

// ---- print -----------------------------------------------------------------

// Build the printable document (datasheet pages grouped by unit + attached
// leaders, a stratagems page, a detachment-rules page) then open the browser
// print dialog. `#print-root` is hidden on screen and revealed only by the
// print stylesheet.
async function printArmy() {
  const state = roster.getState();
  if (!state.entries.length) {
    alert('Your army is empty — add units before printing.');
    return;
  }
  const label = dom.btnPrint.textContent;
  dom.btnPrint.disabled = true;
  dom.btnPrint.textContent = 'Preparing…';
  await ensureStrats();
  const stratVm = resolveArmyStratagems(app.strats, state.detachments);
  ui.renderPrint(dom.printRoot, {
    heading: state.faction ? state.faction.label : 'Army',
    sub: `${roster.total()} / ${state.limit} pts · ${state.entries.length} unit(s)`,
    entries: state.entries,
    unitById: new Map(app.units.map((u) => [u.id, u])),
    attach: buildAttachVM(),
    dets: detCtx(),
    detachments: state.detachments,
    stratVm,
  });
  dom.btnPrint.disabled = false;
  dom.btnPrint.textContent = label;
  window.print();
}

// ---- events ----------------------------------------------------------------

function wireEvents() {
  dom.factionSelect.addEventListener('change', (e) => selectFaction(e.target.value));
  // The detachment picker binds its own onchange in ui.renderDetachmentPicker.
  dom.limitSelect.addEventListener('change', (e) => roster.setLimit(e.target.value));
  dom.unitFilter.addEventListener('input', (e) => { app.filter = e.target.value; renderList(); });
  dom.toggleLegends.addEventListener('change', (e) => { app.showLegends = e.target.checked; renderList(); });
  dom.btnExport.addEventListener('click', () => ui.openModal(roster.exportText()));
  dom.btnPrint.addEventListener('click', printArmy);
  dom.btnClear.addEventListener('click', () => {
    if (confirm('Clear the whole army?')) roster.clear();
  });
  dom.modalClose.addEventListener('click', ui.closeModal);
  dom.modal.addEventListener('click', (e) => { if (e.target === dom.modal) ui.closeModal(); });
  dom.editModalClose.addEventListener('click', ui.closeEditModal);
  dom.editModal.addEventListener('click', (e) => { if (e.target === dom.editModal) ui.closeEditModal(); });
  dom.mobileTabs.forEach((b) => b.addEventListener('click', () => setMobileTab(b.dataset.tab)));
  dom.detailBack.addEventListener('click', closeDetailSheet);
  dom.btnPlay.addEventListener('click', enterPlayMode);
  dom.playClose.addEventListener('click', exitPlayMode);
  dom.playStrats.addEventListener('click', showPlayStrats);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dom.playOverlay.classList.contains('hidden')) return;
    if (app.play.view === 'sheet' || app.play.view === 'strats') showPlayGrid();
    else exitPlayMode();
  });
  dom.btnCopy.addEventListener('click', async () => {
    const text = document.getElementById('export-text').value;
    try {
      await navigator.clipboard.writeText(text);
      dom.btnCopy.textContent = 'Copied!';
      setTimeout(() => { dom.btnCopy.textContent = 'Copy to clipboard'; }, 1500);
    } catch {
      document.getElementById('export-text').select();
    }
  });
}

// ---- init ------------------------------------------------------------------

async function init() {
  const state = roster.load();
  setMobileTab('units');
  ui.renderLimitSelect(dom.limitSelect, POINTS_PRESETS, state.limit);
  refreshRoster();
  wireEvents();

  ui.setStatus(dom.status, 'Loading factions…', true);
  app.factions = await loadFactionList();
  ui.renderFactionSelect(dom.factionSelect, app.factions, state.faction ? state.faction.file : '');
  ui.setStatus(dom.status, '', false);

  // Auto-load the previously selected faction (so a restored roster is editable).
  if (state.faction && state.faction.file) {
    await selectFaction(state.faction.file);
  }
}

init();
