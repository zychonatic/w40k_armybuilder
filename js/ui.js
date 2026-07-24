// Rendering helpers. Pure-ish: take data + callbacks, write DOM.

import { factionLabel, compareRoles } from './config.js';
import {
  computePoints, selectedOptions, isSingleChoice, validate, currentSize, sizeCost,
  ENH_KEY, isCharacter, selectedEnhancement, totalWithEnhancement, selectionsFromEntry,
} from './engine.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Iterate a Map keyed by role in canonical battlefield-role order. Roster/play
// entries arrive in add-order, so grouping alone doesn't order the groups.
function rolesInOrder(byRole) {
  return [...byRole.entries()].sort((a, b) => compareRoles(a[0], b[0]));
}

export function setStatus(el, text, busy = false) {
  el.innerHTML = busy ? `<span class="spinner"></span>${esc(text)}` : esc(text);
}

export function renderFactionSelect(el, factions, currentFile) {
  el.innerHTML = '<option value="">— choose faction —</option>'
    + factions.map((f) => `<option value="${esc(f.file)}"${f.file === currentFile ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
}

export function renderLimitSelect(el, presets, current) {
  el.innerHTML = presets.map((p) => `<option value="${p}"${p === current ? ' selected' : ''}>${p} pts</option>`).join('');
}

// ---- detachment ------------------------------------------------------------

// The top-bar detachment control is an "add" picker: choosing an entry adds it
// to the army (11e allows several up to a DP budget). Already-selected and
// over-budget detachments are omitted / disabled. `dpRemaining` is the DP left.
export function renderDetachmentPicker(el, detachments, { selectedIds, dpRemaining, onAdd }) {
  if (!detachments.length) {
    el.innerHTML = '<option value="">— none available —</option>';
    el.disabled = true;
    el.onchange = null;
    return;
  }
  el.disabled = false;
  let opts = '<option value="">＋ add detachment…</option>';
  for (const d of detachments) {
    if (selectedIds.has(d.id)) continue;
    const dp = d.dp || 1;
    const tooBig = dp > dpRemaining;
    opts += `<option value="${esc(d.id)}"${tooBig ? ' disabled' : ''}>`
      + `${esc(d.name)} — ${dp} DP${tooBig ? ' (not enough DP)' : ''}</option>`;
  }
  el.innerHTML = opts;
  el.value = '';
  el.onchange = () => { const id = el.value; el.value = ''; if (id) onAdd(id); };
}

// Render the detachment's rules + enhancements into the detail panel. Purely
// informational: enhancements are assigned by selecting a Character unit.
export function renderDetachmentDetail(el, det) {
  clearDetailFoot();
  if (!det) {
    el.innerHTML = '<p class="hint">No detachment selected.</p>';
    return;
  }
  let html = `<div class="detail-title"><h3>${esc(det.name)}</h3><span class="role">Detachment</span></div>`;
  if (det.rules.length) {
    html += '<div class="section-label">Detachment Rule</div>';
    for (const r of det.rules) {
      html += `<div class="ability"><div class="a-name">${esc(r.name)}</div>`;
      if (r.text) html += `<div class="a-text">${esc(r.text)}</div>`;
      html += '</div>';
    }
  }
  if (det.enhancements.length) {
    html += '<div class="section-label">Enhancements</div>';
    html += '<p class="hint" style="margin:2px 2px 8px">Select a Character unit to assign an enhancement.</p>';
    for (const e of det.enhancements) {
      html += `<div class="opt-group"><h4><span>${esc(e.name)}</span><span class="o-cost">+${e.cost}</span></h4>`;
      if (e.text) html += `<div class="a-text">${esc(e.text)}</div>`;
      html += '</div>';
    }
  } else {
    html += '<p class="hint" style="margin-top:10px">No selectable enhancements for this detachment.</p>';
  }
  el.innerHTML = html;
}

// The selected-detachments bar in the army panel: a DP counter plus a chip per
// detachment (name views its rules, ✕ removes it).
export function renderDetachmentBar(el, detachments, { dpUsed, dpBudget, onView, onRemove }) {
  const over = dpUsed > dpBudget;
  let html = '<span class="det-label">Detachments</span>'
    + `<span class="dp-count${over ? ' over' : ''}">${dpUsed} / ${dpBudget} DP</span>`;
  if (!detachments.length) {
    el.innerHTML = `${html} <span class="det-none">none selected</span>`;
    return;
  }
  html += '<div class="det-chips">';
  for (const d of detachments) {
    html += '<span class="det-chip">'
      + `<button class="det-link" data-view="${esc(d.id)}">${esc(d.name)}</button>`
      + `<span class="det-dp">${d.dp || 1} DP</span>`
      + `<button class="det-x" data-remove="${esc(d.id)}" title="Remove detachment">✕</button>`
      + '</span>';
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => onView(b.dataset.view)));
  el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => onRemove(b.dataset.remove)));
}

// ---- unit browser ----------------------------------------------------------

export function renderUnitList(el, units, {
  filter = '', activeId = null, showLegends = false, onSelect,
}) {
  const q = filter.trim().toLowerCase();
  const filtered = units.filter((u) => {
    if (!showLegends && u.legends) return false;
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
  });
  if (!filtered.length) {
    el.innerHTML = `<p class="hint">${units.length ? 'No units match your filter.' : 'No buildable units found.'}</p>`;
    return;
  }
  const byRole = new Map();
  for (const u of filtered) {
    if (!byRole.has(u.role)) byRole.set(u.role, []);
    byRole.get(u.role).push(u);
  }
  let html = '';
  for (const [role, us] of rolesInOrder(byRole)) {
    html += `<div class="role-group"><div class="role-title">${esc(role)} (${us.length})</div>`;
    for (const u of us) {
      html += `<div class="unit-row${u.id === activeId ? ' active' : ''}" data-id="${esc(u.id)}">
        <span class="u-name">${esc(u.name)}</span>
        <span class="u-pts">${u.baseCost} pts</span>
      </div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.unit-row').forEach((row) => {
    row.addEventListener('click', () => onSelect(row.dataset.id));
  });
}

// ---- unit detail / config --------------------------------------------------

function statTable(statlines) {
  if (!statlines.length) return '';
  const cols = ['M', 'T', 'Sv', 'W', 'LD', 'OC', 'InSv'];
  const multi = statlines.length > 1;
  let html = '<table class="stat-table"><thead><tr>';
  if (multi) html += '<th>Model</th>';
  html += cols.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
  for (const s of statlines) {
    html += '<tr>';
    if (multi) html += `<td>${esc(s.name)}</td>`;
    html += cols.map((c) => `<td>${esc(s[c] || '–')}</td>`).join('');
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function weaponTable(weapons) {
  if (!weapons.length) return '';
  let html = '<div class="section-label">Weapons</div><table class="weap-table"><thead><tr>'
    + '<th>Weapon</th><th>Range</th><th>A</th><th>Skill</th><th>S</th><th>AP</th><th>D</th><th>Keywords</th>'
    + '</tr></thead><tbody>';
  for (const w of weapons) {
    const skill = w.BS || w.WS || '';
    html += `<tr>
      <td class="wname">${esc(w.name)}</td>
      <td>${esc(w.Range || '–')}</td>
      <td>${esc(w.A || '–')}</td>
      <td>${esc(skill || '–')}</td>
      <td>${esc(w.S || '–')}</td>
      <td>${esc(w.AP || '–')}</td>
      <td>${esc(w.D || '–')}</td>
      <td>${esc(w.keywords || '')}</td>
    </tr>`;
  }
  return html + '</tbody></table>';
}

// A compact one-line stat summary (M/T/Sv/W) from a unit's first statline,
// used on play-mode cards. Empty string when no stats are available.
function statStrip(unit) {
  const s = unit && unit.statlines && unit.statlines[0];
  if (!s) return '';
  const cell = (label, v) => `<span>${label}<b>${esc(v || '–')}</b></span>`;
  return `<div class="stat-strip">
    ${cell('M', s.M)}${cell('T', s.T)}${cell('Sv', s.Sv)}${cell('W', s.W)}
  </div>`;
}

function abilitiesBlock(abilities) {
  if (!abilities.length) return '';
  let html = '<div class="section-label">Abilities</div>';
  for (const a of abilities) {
    html += `<div class="ability"><div class="a-name">${esc(a.name)}</div>`;
    if (a.text) html += `<div class="a-text">${esc(a.text)}</div>`;
    html += '</div>';
  }
  return html;
}

// A model-count picker for units whose points scale with squad size.
function sizeBlock(unit, selections) {
  if (!unit.size) return '';
  const cur = currentSize(unit, selections);
  const opts = [];
  for (let n = unit.size.min; n <= unit.size.max; n += 1) {
    opts.push(`<option value="${n}"${n === cur ? ' selected' : ''}>${n} models — ${sizeCost(unit.size, n)} pts</option>`);
  }
  return `<div class="section-label">Unit Size</div>
    <div class="size-control">
      <label for="size-select">Models</label>
      <select id="size-select">${opts.join('')}</select>
      <span class="size-range">(${unit.size.min}–${unit.size.max})</span>
    </div>`;
}

// A single-choice enhancement picker, shown for Character units. When no
// detachment (or no enhancements) is available it shows a guiding hint instead,
// so the section is always discoverable on a character. `usedIds` are
// enhancements already assigned to other units (each is once-per-army).
function enhancementBlock(unit, selections, enhancements, usedIds, hasDetachment) {
  if (!isCharacter(unit)) return ''; // only characters take enhancements
  const label = '<div class="section-label">Enhancement</div>';
  if (!hasDetachment) {
    return `${label}<p class="hint" style="margin:2px 2px 8px">Select a detachment in the top bar to assign an enhancement to this character.</p>`;
  }
  if (!enhancements || !enhancements.length) {
    return `${label}<p class="hint" style="margin:2px 2px 8px">This detachment has no enhancements.</p>`;
  }
  const chosen = selections[ENH_KEY] || '';
  let html = `${label}<div class="opt-group enh-group"><h4><span>Detachment Enhancement</span>`
    + '<span class="constraint">Character · max 1</span></h4>';
  const noneChecked = chosen ? '' : ' checked';
  html += `<div class="opt">
    <label><input type="radio" name="enh" value=""${noneChecked} /><span>No enhancement</span></label>
  </div>`;
  for (const e of enhancements) {
    const isChosen = e.id === chosen;
    const taken = usedIds.has(e.id) && !isChosen; // in use by another unit
    const checked = isChosen ? ' checked' : '';
    const disabled = taken ? ' disabled' : '';
    const note = taken ? ' <span class="badge">in use</span>' : '';
    html += `<div class="opt${taken ? ' unresolved' : ''}">
      <label>
        <input type="radio" name="enh" value="${esc(e.id)}"${checked}${disabled} />
        <span>${esc(e.name)}${note}</span>
      </label><span class="o-cost">+${e.cost}</span>
    </div>`;
    if (e.text) html += `<div class="a-text enh-text">${esc(e.text)}</div>`;
  }
  return html + '</div>';
}

function optionGroupsBlock(unit, selections) {
  if (!unit.optionGroups.length) return '';
  let html = '<div class="section-label">Wargear &amp; Options</div>';
  for (const g of unit.optionGroups) {
    const chosen = selections[g.id] || [];
    const single = isSingleChoice(g);
    const inputType = single ? 'radio' : 'checkbox';
    let constraint = '';
    if (g.min != null || g.max != null) {
      const parts = [];
      if (g.min != null) parts.push(`min ${g.min}`);
      if (g.max != null) parts.push(`max ${g.max}`);
      constraint = `<span class="constraint">${parts.join(', ')}</span>`;
    }
    html += `<div class="opt-group"><h4><span>${esc(g.name)}</span>${constraint}</h4>`;
    for (const o of g.options) {
      const checked = chosen.includes(o.id) ? ' checked' : '';
      const cost = o.cost ? `<span class="o-cost">+${o.cost}</span>` : '';
      const badge = o.unresolved ? ' <span class="badge">unresolved</span>' : '';
      html += `<div class="opt${o.unresolved ? ' unresolved' : ''}">
        <label>
          <input type="${inputType}" name="grp-${esc(g.id)}" value="${esc(o.id)}" data-group="${esc(g.id)}"${checked} />
          <span>${esc(o.name)}${badge}</span>
        </label>${cost}
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

// The configurable part of a unit (size + enhancement + wargear), shared by the
// inline detail panel and the edit modal.
function configBody(unit, selections, enhancements, usedIds, hasDetachment) {
  return `${sizeBlock(unit, selections)}
    ${enhancementBlock(unit, selections, enhancements, usedIds, hasDetachment)}
    ${optionGroupsBlock(unit, selections)}`;
}

// Wire the config inputs rendered by configBody. Callbacks are optional.
function bindConfigInputs(el, { onToggle, onSize, onEnhance }) {
  if (onToggle) {
    el.querySelectorAll('input[data-group]').forEach((inp) => {
      inp.addEventListener('change', () => onToggle(inp.dataset.group, inp.value));
    });
  }
  const sizeSel = el.querySelector('#size-select');
  if (sizeSel && onSize) {
    sizeSel.addEventListener('change', () => onSize(Number(sizeSel.value)));
  }
  if (onEnhance) {
    el.querySelectorAll('input[name="enh"]').forEach((inp) => {
      inp.addEventListener('change', () => onEnhance(inp.value));
    });
  }
}

// Render the detail panel for a unit.
// Callbacks: onToggle(groupId, optionId), onSize(modelCount), onEnhance(enhId|''), onAdd().
// `enh` carries detachment enhancement context: { list, usedIds }.
export function renderUnitDetail(el, unit, selections, { onToggle, onSize, onEnhance, onAdd }, enh = {}) {
  if (!unit) {
    el.innerHTML = '<p class="hint">Click a unit to see its stats and wargear.</p>';
    return;
  }
  const enhancements = enh.list || [];
  const usedIds = enh.usedIds || new Set();
  const chosenEnh = selectedEnhancement(enhancements, selections);
  const pts = totalWithEnhancement(unit, selections, isCharacter(unit) ? chosenEnh : null);
  const chips = unit.keywords.map((k) => `<span class="chip">${esc(k)}</span>`).join('');
  el.innerHTML = `
    <div class="detail-title">
      <h3>${esc(unit.name)}</h3>
      <span class="role">${esc(unit.role)}</span>
    </div>
    ${statTable(unit.statlines)}
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${rulesBlock(visibleRules(unit, enh.dets))}
    ${weaponTable(unit.weapons)}
    ${abilitiesBlock(visibleAbilities(unit, enh.dets))}
    ${configBody(unit, selections, enhancements, usedIds, enh.hasDetachment)}
    <div style="height:8px"></div>
  `;
  bindConfigInputs(el, { onToggle, onSize, onEnhance });
  renderDetailFoot(document.querySelector('.panel.detail'), unit, selections, pts,
    { label: 'Add to army', onAction: onAdd });
}

// Render the edit modal body: just the configurable part of a unit, plus a
// footer with a "Save changes" action. `unit` may be null when its faction
// isn't loaded, in which case only a guiding hint is shown.
// Callbacks: onToggle, onSize, onEnhance, onSave.
export function renderUnitEditor(bodyEl, boxEl, unit, selections, { onToggle, onSize, onEnhance, onSave }, enh = {}) {
  clearDetailFoot(boxEl);
  if (!unit) {
    bodyEl.innerHTML = '<p class="hint">Load this unit\'s faction to edit it.</p>';
    return;
  }
  const enhancements = enh.list || [];
  const usedIds = enh.usedIds || new Set();
  const chosenEnh = selectedEnhancement(enhancements, selections);
  const pts = totalWithEnhancement(unit, selections, isCharacter(unit) ? chosenEnh : null);
  bodyEl.innerHTML = configBody(unit, selections, enhancements, usedIds, enh.hasDetachment);
  bindConfigInputs(bodyEl, { onToggle, onSize, onEnhance });
  renderDetailFoot(boxEl, unit, selections, pts, { label: 'Save changes', onAction: onSave });
}

// The footer (points + primary action) is appended to `container`.
function renderDetailFoot(container, unit, selections, pts, { label, onAction }) {
  let foot = container.querySelector('.detail-foot');
  if (!foot) {
    foot = document.createElement('div');
    foot.className = 'detail-foot';
    container.appendChild(foot);
  }
  const problems = validate(unit, selections);
  const warn = problems.length
    ? `<span class="cfg-warn" title="${esc(problems.map((p) => `${p.name}: ${p.message}`).join('; '))}">⚠ ${problems.length} option note(s)</span>`
    : '';
  foot.innerHTML = `
    ${warn}
    <span class="cfg-pts">${pts} pts</span>
    <button id="btn-add">${esc(label)}</button>
  `;
  const btn = foot.querySelector('#btn-add');
  if (btn) btn.addEventListener('click', onAction);
}

export function clearDetailFoot(container = document.querySelector('.panel.detail')) {
  const foot = container && container.querySelector('.detail-foot');
  if (foot) foot.remove();
}

// ---- roster ----------------------------------------------------------------

// The "Attach to…" picker shown on eligible character rows. `mandatory` marks a
// Support character that must be attached (shown with a required placeholder and
// a warning while unattached).
function attachSelect(uid, options, current, mandatory) {
  const label = mandatory ? '↳ Attach to <span class="req">(required)</span>:' : '↳ Attach to:';
  if (mandatory && !options.length && !current) {
    return `<div class="r-attach warn">⚠ Must be attached, but no eligible unit is in the army.</div>`;
  }
  const placeholder = mandatory ? '— choose a unit —' : '— not attached —';
  const opts = [`<option value="">${placeholder}</option>`]
    .concat(options.map((o) => `<option value="${esc(o.uid)}"${o.uid === current ? ' selected' : ''}>${esc(o.name)}</option>`))
    .join('');
  const warn = mandatory && !current ? ' warn' : '';
  return `<div class="r-attach${warn}">${label}
    <select class="attach-select" data-uid="${esc(uid)}">${opts}</select></div>`;
}

function rosterEntryHtml(e, attach, nested) {
  const opts = e.options.map((o) => o.name).join(', ');
  const sizeTag = e.modelCount ? ` <span class="r-size">×${e.modelCount}</span>` : '';
  const picker = attach.pickerOptions.has(e.uid)
    ? attachSelect(e.uid, attach.pickerOptions.get(e.uid), attach.currentTarget.get(e.uid) || '', attach.mandatory.has(e.uid))
    : '';
  const leadTag = nested
    ? `<span class="r-lead">${attach.mandatory.has(e.uid) ? 'Support' : 'Leader'}</span> `
    : '';
  return `<div class="roster-entry${nested ? ' nested' : ''}" data-uid="${esc(e.uid)}">
    <div class="r-main">
      <div class="r-name">${leadTag}${esc(e.unitName)}${sizeTag}</div>
      ${opts ? `<div class="r-opts">${esc(opts)}</div>` : ''}
      ${picker}
    </div>
    <span class="r-pts">${e.points}</span>
    <span class="r-btns">
      <button data-act="edit" title="Edit">✎</button>
      <button data-act="del" title="Remove">✕</button>
    </span>
  </div>`;
}

export function renderRoster(el, state, total, limit, { onRemove, onEdit, onAttach, attach }) {
  const totalEl = document.getElementById('roster-total');
  const limitEl = document.getElementById('roster-limit');
  const totalWrap = totalEl.closest('.roster-total');
  totalEl.textContent = total;
  limitEl.textContent = limit;
  totalWrap.classList.toggle('over', total > limit);

  if (!state.entries.length) {
    el.innerHTML = '<p class="hint">Your army is empty.</p>';
    return;
  }
  // Attached leaders are rendered nested under their host, not in their own role.
  const byRole = new Map();
  for (const e of state.entries) {
    if (attach.hiddenUids.has(e.uid)) continue;
    if (!byRole.has(e.role)) byRole.set(e.role, []);
    byRole.get(e.role).push(e);
  }
  let html = '';
  for (const [role, entries] of rolesInOrder(byRole)) {
    html += `<div class="role-title">${esc(role)}</div>`;
    for (const e of entries) {
      html += rosterEntryHtml(e, attach, false);
      for (const leader of attach.attachedLeaders.get(e.uid) || []) {
        html += rosterEntryHtml(leader, attach, true);
      }
    }
  }
  el.innerHTML = html;
  el.querySelectorAll('.roster-entry').forEach((row) => {
    const uid = row.dataset.uid;
    row.querySelector('[data-act="edit"]').addEventListener('click', () => onEdit(uid));
    row.querySelector('[data-act="del"]').addEventListener('click', () => onRemove(uid));
  });
  el.querySelectorAll('.attach-select').forEach((sel) => {
    sel.addEventListener('change', () => onAttach(sel.dataset.uid, sel.value));
  });
}

// ---- modal -----------------------------------------------------------------

export function openModal(text) {
  document.getElementById('export-text').value = text;
  document.getElementById('modal').classList.remove('hidden');
}
export function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

export function openEditModal(title) {
  document.getElementById('edit-modal-title').textContent = title;
  document.getElementById('edit-modal').classList.remove('hidden');
}
export function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

// ---- play mode -------------------------------------------------------------

// Full-screen grid of army units, grouped by role. `unitById` maps unit id to
// full unit data (may be missing for units whose faction isn't loaded).
function playCardHtml(e, unitById, tagLabel) {
  const sizeTag = e.modelCount ? ` <span class="pc-size">×${e.modelCount}</span>` : '';
  const tag = tagLabel ? `<span class="pc-leader-tag">↳ ${esc(tagLabel)}</span>` : '';
  const unit = unitById.get(e.unitId);
  return `<button class="play-card" data-uid="${esc(e.uid)}">
    <div class="pc-top">
      <span class="pc-name">${esc(e.unitName)}</span>
      <span class="pc-pts">${e.points} pts</span>
    </div>
    <div class="pc-role">${tag}${esc(e.role)}${sizeTag}</div>
    ${statStrip(unit)}
    ${keywordChips(unit)}
  </button>`;
}

// Compact keyword-chip row for a unit (empty when the unit's faction isn't loaded).
function keywordChips(unit) {
  const kws = unit && unit.keywords ? unit.keywords : [];
  if (!kws.length) return '';
  return `<div class="chips pc-keywords">${kws.map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>`;
}

export function renderPlayGrid(bodyEl, entries, unitById, { onSelect, attach }) {
  if (!entries.length) {
    bodyEl.innerHTML = '<p class="hint">Your army is empty — add units to the roster first.</p>';
    return;
  }
  // Attached leaders render grouped with their host, not in their own role.
  const byRole = new Map();
  for (const e of entries) {
    if (attach.hiddenUids.has(e.uid)) continue;
    if (!byRole.has(e.role)) byRole.set(e.role, []);
    byRole.get(e.role).push(e);
  }
  let html = '';
  for (const [role, es] of rolesInOrder(byRole)) {
    html += `<div class="play-role">${esc(role)}</div><div class="play-grid">`;
    for (const e of es) {
      const leaders = attach.attachedLeaders.get(e.uid) || [];
      if (leaders.length) {
        html += `<div class="play-unit-group">${playCardHtml(e, unitById, '')}`;
        for (const l of leaders) {
          html += playCardHtml(l, unitById, attach.mandatory.has(l.uid) ? 'Support' : 'Leader');
        }
        html += '</div>';
      } else {
        html += playCardHtml(e, unitById, '');
      }
    }
    html += '</div>';
  }
  bodyEl.innerHTML = html;
  bodyEl.querySelectorAll('.play-card').forEach((card) => {
    card.addEventListener('click', () => onSelect(card.dataset.uid));
  });
}

// Full-screen datasheet for one entry. `unit` may be null when its faction
// isn't loaded — then only the chosen options and a hint are shown.
// Narrow a unit's full weapon list down to what THIS roster entry actually
// carries: weapons offered by a real wargear option appear only when that option
// was selected during army building; any weapon not offered by such an option is
// base kit and always shown.
//
// `model`-type options are skipped entirely: BSData nests a squad's constituent
// model inside the size/count group, and that model aggregates *every* weapon it
// can reach — including both sides of a nested either/or choice (e.g. an
// Immortal's Gauss blaster AND Tesla carbine). Gating on the real choice group's
// selection is what distinguishes the two; the model's fixed weapons (e.g. a
// Close combat weapon) fall through as "not offered by any option" and stay.
function weaponsForEntry(unit, entry) {
  const optional = new Set();   // weapon names a real wargear option can grant
  const selected = new Set();   // weapon names granted by the chosen options
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
  return unit.weapons.filter((w) => selected.has(w.name) || !optional.has(w.name));
}

// Whether an ability/rule is gated out by the army's detachment choice (e.g. a
// C'tan Shard's Distortion Fields (Aura), which is Pantheon-of-Woe-only). `dets`
// is { selected, all } — Sets of detachment ids currently selected / offered by
// the faction. A hide rule is only evaluated when its target is a known
// detachment; otherwise it's left visible (we can't judge the condition).
function hiddenByDetachment(hideRules, dets) {
  const all = dets && dets.all;
  const selected = (dets && dets.selected) || new Set();
  for (const r of hideRules || []) {
    if (all && !all.has(r.id)) continue;
    const isSel = selected.has(r.id);
    if (r.cmp === 'absent' && !isSel) return true;
    if (r.cmp === 'present' && isSel) return true;
  }
  return false;
}

function visibleAbilities(unit, dets) {
  return unit.abilities.filter((a) => !hiddenByDetachment(a.hideRules, dets));
}

function visibleRules(unit, dets) {
  return (unit.rules || []).filter((r) => !hiddenByDetachment(r.hideRules, dets));
}

// Compact list of a unit's named special rules (Core/Faction rules).
function rulesBlock(rules) {
  if (!rules.length) return '';
  const chips = rules.map((r) => `<span class="rule-chip">${esc(r.name)}</span>`).join('');
  return `<div class="section-label">Rules</div><div class="rule-list">${chips}</div>`;
}

export function renderPlayDatasheet(bodyEl, entry, unit, { onBack, partner, onPartner, dets }) {
  const sizeStr = entry.modelCount ? ` · ×${entry.modelCount}` : '';
  let body;
  if (unit) {
    body = `
      ${statTable(unit.statlines)}
      ${keywordChips(unit)}
      ${rulesBlock(visibleRules(unit, dets))}
      ${weaponTable(weaponsForEntry(unit, entry))}
      ${abilitiesBlock(visibleAbilities(unit, dets))}`;
  } else {
    body = '<p class="hint">Full datasheet unavailable — load this unit\'s faction to see stats, weapons and abilities.</p>';
  }
  const partnerLine = partner
    ? `<button class="ds-partner" data-uid="${esc(partner.partnerUid)}">⚔ ${esc(partner.ledLabel)}</button>`
    : '';
  bodyEl.innerHTML = `
    <div class="play-datasheet">
      <div class="ds-head">
        <button class="play-back">← Back</button>
        <div class="ds-title">
          <h3>${esc(entry.unitName)}</h3>
          <span class="role">${esc(entry.role)} · ${entry.points} pts${sizeStr}</span>
        </div>
      </div>
      ${partnerLine}
      ${body}
      ${selectedOptionsBlock(entry.options)}
    </div>`;
  bodyEl.querySelector('.play-back').addEventListener('click', onBack);
  const partnerBtn = bodyEl.querySelector('.ds-partner');
  if (partnerBtn && onPartner) {
    partnerBtn.addEventListener('click', () => onPartner(partnerBtn.dataset.uid));
  }
}

// Display-only list of an entry's chosen wargear/enhancements, grouped by group.
function selectedOptionsBlock(options) {
  if (!options || !options.length) return '';
  const byGroup = new Map();
  for (const o of options) {
    if (!byGroup.has(o.group)) byGroup.set(o.group, []);
    byGroup.get(o.group).push(o);
  }
  let html = '<div class="section-label">Selected Wargear</div><div class="ds-options">';
  for (const [group, opts] of byGroup) {
    const names = opts.map((o) => `${esc(o.name)}${o.cost ? ` <span class="o-cost">+${o.cost}</span>` : ''}`).join(', ');
    html += `<div class="ds-opt"><span class="ds-grp">${esc(group)}:</span> ${names}</div>`;
  }
  return html + '</div>';
}

// ---- stratagems (Wahapedia-derived) ----------------------------------------

// Stratagem text fields carry sanctioned GW HTML (bold, breaks, lists). We keep
// the "always esc() external data" rule by escaping FIRST, then re-enabling a
// tiny whitelist of formatting tags. Attribute-bearing <span> wrappers (rare)
// are dropped, keeping their text. Nothing else survives as live markup.
function stratText(s) {
  return esc(s)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/&lt;(\/?)(b|i|u|ul|li)&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?span[\s\S]*?&gt;/gi, '');
}

// Human label for a stratagem's coded `timing`.
const TIMING_LABEL = {
  anyTurn: 'Any turn', yourTurn: 'Your turn',
  opponentsTurn: "Opponent's turn", eitherTurn: 'Either turn',
};

function stratCardHtml(s) {
  const cp = (s.cp === 0 || s.cp) ? `<span class="strat-cp">${esc(s.cp)}CP</span>` : '';
  const chips = [];
  if (s.type) chips.push(`<span class="chip">${esc(s.type)}</span>`);
  const timing = TIMING_LABEL[s.timing] || s.timing;
  if (timing) chips.push(`<span class="chip">${esc(timing)}</span>`);
  if (Array.isArray(s.phases)) {
    for (const p of s.phases) {
      if (p && p !== 'any') chips.push(`<span class="chip">${esc(p)}</span>`);
    }
  }
  const field = (label, val) => (val
    ? `<div class="strat-field"><span class="sf-label">${label}</span> <span class="sf-text">${stratText(val)}</span></div>`
    : '');
  return `<div class="strat-card">
    <div class="strat-head"><span class="strat-name">${esc(s.name)}</span>${cp}</div>
    <div class="chips strat-meta">${chips.join('')}</div>
    ${field('WHEN', s.when)}
    ${field('TARGET', s.target)}
    ${field('EFFECT', s.effect)}
    ${field('RESTRICTIONS', s.restrictions)}
  </div>`;
}

// The stratagem sections (per-detachment groups + Core), shared by the
// full-screen play view and the print sheet. Returns inner HTML only.
function stratSections(vm) {
  const section = (title, tag, strats, emptyHint) => {
    let h = `<div class="strat-section"><div class="strat-sec-head"><h3>${esc(title)}</h3>`
      + (tag ? `<span class="strat-sec-tag">${esc(tag)}</span>` : '') + '</div>';
    h += strats.length
      ? strats.map(stratCardHtml).join('')
      : `<p class="hint">${esc(emptyHint)}</p>`;
    return h + '</div>';
  };
  let html = '';
  for (const g of vm.groups) {
    html += section(g.name, g.found ? '10th ed. data' : '', g.strats,
      'No 10th-edition stratagems match this detachment — likely a new 11th-edition detachment not yet in the dataset.');
  }
  if (!vm.groups.length) {
    html += '<p class="hint">No detachment selected — add one in the army panel to see its stratagems.</p>';
  }
  html += section('Core Stratagems', '11th ed. · everyone', vm.core,
    'Core stratagem data unavailable — check your connection.');
  return html;
}

const STRAT_ATTRIB = 'Stratagem data via Wahapedia, from the community card-generator dataset. '
  + '10th-edition detachment rules are shown as a fallback until 11th-edition data is published.';

// Full-screen stratagem reference: a Core section (11e, everyone) plus one
// section per selected detachment (10e fallback data, or a hint when unmatched).
export function renderPlayStratagems(bodyEl, vm, { onBack }) {
  bodyEl.innerHTML = '<div class="play-stratagems"><button class="play-back">← Back</button>'
    + stratSections(vm)
    + `<p class="strat-attrib">${STRAT_ATTRIB}</p></div>`;
  bodyEl.querySelector('.play-back').addEventListener('click', onBack);
}

// ---- print -----------------------------------------------------------------

// One unit's datasheet, static (no interactive buttons). Mirrors the play-mode
// datasheet body, reusing the same stat/weapon/ability helpers.
function printDatasheetHtml(entry, unit, dets) {
  const sizeStr = entry.modelCount ? ` · ×${entry.modelCount}` : '';
  const body = unit
    ? `${statTable(unit.statlines)}
       ${keywordChips(unit)}
       ${rulesBlock(visibleRules(unit, dets))}
       ${weaponTable(weaponsForEntry(unit, entry))}
       ${abilitiesBlock(visibleAbilities(unit, dets))}`
    : '<p class="hint">Full datasheet unavailable — load this unit\'s faction to include stats.</p>';
  return `<div class="print-ds">
    <div class="ds-title print-ds-head">
      <h3>${esc(entry.unitName)}</h3>
      <span class="role">${esc(entry.role)} · ${entry.points} pts${sizeStr}</span>
    </div>
    ${body}
    ${selectedOptionsBlock(entry.options)}
  </div>`;
}

// The detachment rules + enhancements shown on the final print page.
function detachmentRulesHtml(detachments) {
  if (!detachments.length) return '<p class="hint">No detachment selected.</p>';
  let html = '';
  for (const d of detachments) {
    html += `<div class="print-det"><h3>${esc(d.name)}</h3>`;
    if (d.rules.length) {
      html += '<div class="section-label">Detachment Rule</div>';
      for (const r of d.rules) {
        html += `<div class="ability"><div class="a-name">${esc(r.name)}</div>`;
        if (r.text) html += `<div class="a-text">${esc(r.text)}</div>`;
        html += '</div>';
      }
    }
    if (d.enhancements.length) {
      html += '<div class="section-label">Enhancements</div>';
      for (const e of d.enhancements) {
        html += `<div class="opt-group"><h4><span>${esc(e.name)}</span><span class="o-cost">+${e.cost}</span></h4>`;
        if (e.text) html += `<div class="a-text">${esc(e.text)}</div>`;
        html += '</div>';
      }
    }
    html += '</div>';
  }
  return html;
}

// Build the full print document: one page per unit (attached leaders/support
// share their host's page), then a stratagems page, then a rules page.
// `attach`/`dets` match the view-models used by play mode.
export function renderPrint(el, { heading, sub, entries, unitById, attach, dets, detachments, stratVm }) {
  const byRole = new Map();
  for (const e of entries) {
    if (attach.hiddenUids.has(e.uid)) continue; // attached leaders share a host page
    if (!byRole.has(e.role)) byRole.set(e.role, []);
    byRole.get(e.role).push(e);
  }
  let pages = '';
  let first = true;
  for (const [, es] of rolesInOrder(byRole)) {
    for (const e of es) {
      let sheets = printDatasheetHtml(e, unitById.get(e.unitId), dets);
      for (const l of attach.attachedLeaders.get(e.uid) || []) {
        sheets += printDatasheetHtml(l, unitById.get(l.unitId), dets);
      }
      const head = first
        ? `<div class="print-army-head"><h2>${esc(heading)}</h2><span>${esc(sub)}</span></div>`
        : '';
      pages += `<div class="print-page">${head}${sheets}</div>`;
      first = false;
    }
  }
  if (!pages) pages = '<div class="print-page"><p class="hint">Your army is empty.</p></div>';
  pages += '<div class="print-page print-stratagems">'
    + '<h2 class="print-page-title">Stratagems</h2>'
    + stratSections(stratVm)
    + `<p class="strat-attrib">${STRAT_ATTRIB}</p></div>`;
  pages += '<div class="print-page">'
    + '<h2 class="print-page-title">Detachment Rules &amp; Enhancements</h2>'
    + detachmentRulesHtml(detachments) + '</div>';
  el.innerHTML = pages;
}

export function openPlayMode(heading, sub) {
  document.getElementById('play-heading').textContent = heading;
  document.getElementById('play-sub').textContent = sub;
  document.getElementById('play-overlay').classList.remove('hidden');
}
export function closePlayMode() {
  document.getElementById('play-overlay').classList.add('hidden');
}
