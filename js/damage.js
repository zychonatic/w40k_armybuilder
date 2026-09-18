// Damage-calculator math. Pure: no DOM, no I/O, no RNG (mirrors engine.js).
//
// Input is raw catalogue data, so every characteristic arrives as a STRING and
// keys are omitted when empty (a melee profile carries no BS at all). The parsers
// here are deliberately forgiving: real BSData holds "2d6+2" (lowercase d), a
// WS of "3" with no plus, "N/A" skills on Torrent weapons, "Anti Vehicle 3+"
// without its hyphen and a literal "-" meaning "no keywords".
//
// A *distribution* is a plain number[] indexed by value: dist[k] = P(value === k).
// They stay small (a few hundred cells worst case), so exact convolution is cheap
// and the whole module is deterministic — the same inputs always give the same
// numbers, with no simulation noise between keystrokes.

// ---- generic helpers -------------------------------------------------------

function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

// A characteristic as a number, falling back when it's missing or unparseable.
function num(v, dflt) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : dflt;
}

// ---- dice ------------------------------------------------------------------

// "2D6+1" -> { n:2, sides:6, plus:1 } ; "5" -> { n:0, sides:0, plus:5 }.
// Returns null when there's nothing usable to parse.
export function parseDice(expr) {
  const s = String(expr == null ? '' : expr).trim();
  if (!s) return null;
  const m = s.match(/^(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?$/);
  if (m) {
    const sign = m[3] === '-' ? -1 : 1;
    return { n: m[1] ? Number(m[1]) : 1, sides: Number(m[2]), plus: m[4] ? sign * Number(m[4]) : 0 };
  }
  const flat = s.match(/^([+-]?\d+)$/);
  return flat ? { n: 0, sides: 0, plus: Number(flat[1]) } : null;
}

const distCache = new Map(); // expression -> distribution (only ~20 distinct ones exist)

// Probability distribution of a dice expression, as dist[value] = probability.
export function diceDist(expr, dflt = 1) {
  const key = `${expr}|${dflt}`;
  const hit = distCache.get(key);
  if (hit) return hit;
  const d = parseDice(expr) || { n: 0, sides: 0, plus: dflt };
  let dist = [1]; // point mass at 0
  for (let i = 0; i < d.n; i++) {
    const die = new Array(d.sides + 1).fill(0);
    for (let f = 1; f <= d.sides; f++) die[f] = 1 / d.sides;
    dist = convolve(dist, die);
  }
  dist = shift(dist, d.plus);
  distCache.set(key, dist);
  return dist;
}

export function diceAvg(expr, dflt = 1) {
  return mean(diceDist(expr, dflt));
}

export function mean(dist) {
  let m = 0;
  for (let k = 0; k < dist.length; k++) m += k * dist[k];
  return m;
}

function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) {
      if (b[j]) out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

// n independent copies of `dist`, via binary exponentiation (model counts reach ~20).
function convolveN(dist, n) {
  let result = [1];
  let base = dist;
  let k = n;
  while (k > 0) {
    if (k & 1) result = convolve(result, base);
    k >>= 1;
    if (k) base = convolve(base, base);
  }
  return result;
}

// Add a flat amount to every value, clamping at zero (never a negative count).
function shift(dist, k) {
  if (!k) return dist;
  const out = new Array(Math.max(1, dist.length + k)).fill(0);
  for (let i = 0; i < dist.length; i++) {
    if (dist[i]) out[Math.max(0, i + k)] += dist[i];
  }
  return out;
}

// ---- characteristic parsing ------------------------------------------------

// "3+" | "3" -> { auto:false, target:3 } ; "N/A" -> { auto:true } (Torrent).
export function parseSkill(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { auto: false, target: null };
  if (/n\s*\/?\s*a/i.test(s)) return { auto: true, target: null };
  const n = num(s, null);
  return n == null ? { auto: false, target: null } : { auto: false, target: clamp(n, 2, 6) };
}

// AP arrives already signed ("-2"), so it is ADDED to a save, never negated twice.
export function parseAp(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-') return 0;
  return num(s, 0);
}

// Parse a weapon's comma-separated Keywords characteristic. Tokens are normalised
// to lower case with runs of spaces/hyphens collapsed, which folds the real-world
// variants (Twin-linked/Twin-Linked, Anti-FLY/Anti Vehicle, Devastating wounds).
// Anything not recognised here — Heavy, Hazardous, Precision, Lance, … — is
// collected in `unmodelled` so the UI can say which keywords it ignored rather
// than quietly implying full coverage.
export function parseKeywords(str) {
  const ab = {
    sustained: null, lethal: false, devastating: false, twinLinked: false,
    torrent: false, blast: false, ignoresCover: false,
    melta: 0, rapidFire: 0, anti: [], unmodelled: [],
  };
  const raw = String(str == null ? '' : str).trim();
  if (!raw || raw === '-') return ab;
  for (const piece of raw.split(',')) {
    const tok = piece.toLowerCase().replace(/[\s\-]+/g, ' ').trim();
    if (!tok || tok === '-') continue;
    let m;
    if (tok === 'lethal hits') ab.lethal = true;
    else if (tok === 'devastating wounds') ab.devastating = true;
    else if (tok === 'twin linked') ab.twinLinked = true;
    else if (tok === 'torrent') ab.torrent = true;
    else if (tok === 'blast') ab.blast = true;
    else if (tok === 'ignores cover') ab.ignoresCover = true;
    else if ((m = tok.match(/^sustained hits (\S+)$/))) ab.sustained = m[1].toUpperCase();
    else if ((m = tok.match(/^rapid fire (\d+)$/))) ab.rapidFire = Number(m[1]);
    else if ((m = tok.match(/^melta (\d+)$/))) ab.melta = Number(m[1]);
    else if ((m = tok.match(/^anti (.+) ([1-6])\+?$/))) ab.anti.push({ kw: m[1].toUpperCase(), on: Number(m[2]) });
    else ab.unmodelled.push(piece.trim());
  }
  return ab;
}

// ---- roll probabilities ----------------------------------------------------

// P(d6 >= n). A natural 1 always fails and a natural 6 always succeeds, so the
// result can never leave [1/6, 5/6] however good or bad the modified target is.
function pAtLeast(n) {
  return clamp((7 - n) / 6, 1 / 6, 5 / 6);
}

// Re-rolls apply to the critical probability too, so Sustained/Lethal scale with
// them. They never stack — the caller passes the single strongest mode.
function applyReroll(p, crit, mode) {
  if (mode === 'all') return { p: p + (1 - p) * p, crit: crit + (1 - p) * crit };
  if (mode === 'ones') return { p: p + (1 / 6) * p, crit: crit + (1 / 6) * crit };
  return { p, crit };
}

// The 11e Strength-vs-Toughness table.
export function woundTarget(S, T) {
  if (S >= 2 * T) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (S * 2 <= T) return 6;
  return 5;
}

// Best save available against this weapon. Armour worsens by AP and improves by
// cover; an invulnerable save is never modified by either.
export function saveTarget(tgt, ap, ignoresCover, inCover) {
  let armour = tgt.sv - ap; // ap is 0 or negative, so this worsens the save
  // Note: the "Benefit of Cover" restriction (a 3+ or better armour save gains
  // nothing from cover against AP 0) is not modelled — see the view's caveats.
  if (inCover && !ignoresCover) armour -= 1;
  armour = Math.max(2, armour);
  return tgt.inv == null ? armour : Math.min(armour, tgt.inv);
}

// ---- target ----------------------------------------------------------------

export function normalizeTarget(t) {
  const sv = num(t.sv, 7);
  const inv = num(t.inv, null);
  const fnp = num(t.fnp, null);
  return {
    T: Math.max(1, num(t.T, 4)),
    W: Math.max(1, num(t.W, 1)),
    models: Math.max(1, num(t.models, 1)),
    sv: sv >= 2 && sv <= 6 ? sv : 7,
    inv: inv != null && inv >= 2 && inv <= 6 ? inv : null,
    fnp: fnp != null && fnp >= 2 && fnp <= 6 ? fnp : null,
    kw: new Set(String(t.keywords || '').split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean)),
  };
}

// ---- per-weapon resolution -------------------------------------------------

// Feel No Pain: each point of damage is ignored on a successful roll, so damage d
// becomes Binomial(d, 1 - pFnp). Rolling FNP for every point and then capping at
// the model's remaining wounds is equivalent to rolling only up to the kill, so
// folding it into the damage distribution before allocation stays exact.
function fnpApply(dist, pFnp) {
  if (!pFnp) return dist;
  const q = 1 - pFnp;
  const out = new Array(dist.length).fill(0);
  for (let d = 0; d < dist.length; d++) {
    if (!dist[d]) continue;
    // Binomial(d, q) row, built iteratively to avoid factorials.
    let term = Math.pow(pFnp, d);
    for (let k = 0; k <= d; k++) {
      out[k] += dist[d] * term;
      if (k < d) term = term * (q / pFnp) * ((d - k) / (k + 1));
    }
  }
  return out;
}

// Damage dealt by ONE hit that reached the wound roll.
function eventDist(pWound, pCritW, dev, pFail, dEff) {
  const out = new Array(dEff.length).fill(0);
  const pNorm = Math.max(0, pWound - pCritW);
  out[0] += 1 - pWound; // failed to wound
  for (let k = 0; k < dEff.length; k++) {
    out[k] += pNorm * pFail * dEff[k];
    // A Devastating Wound is ordinary damage that skips armour AND invuln — it is
    // not a mortal wound, so it is allocated (and wasted on overkill) like any other.
    out[k] += pCritW * (dev ? 1 : pFail) * dEff[k];
  }
  out[0] += pNorm * (1 - pFail);
  if (!dev) out[0] += pCritW * (1 - pFail);
  return out;
}

// Resolve one weapon row against the target. Returns the expectation breakdown the
// UI shows plus the distributions the models-slain DP consumes, so the chain is
// computed in exactly one place.
export function resolveRow(weapon, tgt, opts) {
  const melee = weapon.type === 'Melee Weapons' || weapon.Range === 'Melee';
  const ab = parseKeywords(weapon.keywords);
  const models = Math.max(0, Number(opts.models) || 0);
  const skill = parseSkill(melee ? (weapon.WS || weapon.BS) : (weapon.BS || weapon.WS));
  const auto = skill.auto || ab.torrent;
  const half = !melee && !!opts.halfRange;

  const zero = {
    name: weapon.name, type: weapon.type, models, unresolved: false,
    unmodelled: ab.unmodelled,
    aDist: [1], sustDist: [1], ev: { hit: [1], lethal: [1] },
    p: { hit: 0, critHit: 0, wound: 0, critWound: 0, failSave: 0 },
    exp: { attacks: 0, hits: 0, sustained: 0, wounds: 0, unsaved: 0, damage: 0 },
  };
  // No skill at all and not a Torrent weapon: we cannot resolve it, and guessing
  // an auto-hit would silently inflate the result.
  if (!models || (!auto && skill.target == null)) {
    return { ...zero, unresolved: !!models && !auto && skill.target == null };
  }

  // ---- attacks
  const perModel = shift(diceDist(weapon.A), (half ? ab.rapidFire : 0) + (ab.blast ? Math.floor(tgt.models / 5) : 0));
  const aDist = convolveN(perModel, models);

  // ---- hit
  let pHit = 1;
  let pCritHit = 0;
  if (!auto) {
    const target = clamp(skill.target - clamp(Number(opts.hitMod) || 0, -1, 1), 2, 6);
    const rr = applyReroll(pAtLeast(target), 1 / 6, opts.rerollHits);
    pHit = rr.p;
    pCritHit = Math.min(rr.crit, rr.p);
  }
  // An auto-hit involves no hit roll, so there are no critical hits — Sustained
  // Hits and Lethal Hits cannot trigger on a Torrent weapon.
  const lethal = ab.lethal && !auto;
  const sustDist = (ab.sustained && !auto) ? diceDist(ab.sustained, 0) : [1];

  // ---- wound
  const S = num(weapon.S, 4);
  let wt = woundTarget(S, tgt.T);
  let critW = 6;
  for (const a of ab.anti) {
    if (tgt.kw.has(a.kw)) critW = Math.min(critW, a.on);
  }
  wt = clamp(wt - clamp(Number(opts.woundMod) || 0, -1, 1), 2, 6);
  // A critical wound always wounds, so Anti-X can only improve the threshold.
  const succ = Math.min(wt, critW);
  const wMode = ab.twinLinked && opts.rerollWounds === 'none' ? 'all' : opts.rerollWounds;
  const rrW = applyReroll(pAtLeast(succ), clamp((7 - critW) / 6, 0, 5 / 6), wMode);
  const pWound = rrW.p;
  const pCritW = Math.min(rrW.crit, rrW.p);

  // ---- save & damage
  const best = saveTarget(tgt, parseAp(weapon.AP), ab.ignoresCover, opts.inCover);
  const pFail = 1 - clamp((7 - best) / 6, 0, 5 / 6); // a 1 always fails, so a save is never automatic
  const pFnp = tgt.fnp == null ? 0 : clamp((7 - tgt.fnp) / 6, 0, 5 / 6);
  const dEff = fnpApply(shift(diceDist(weapon.D), half ? ab.melta : 0), pFnp);

  const evHit = eventDist(pWound, pCritW, ab.devastating, pFail, dEff);
  // A Lethal Hit auto-wounds but is NOT a critical wound, so it never triggers
  // Devastating Wounds and the target still gets its save.
  const evLethal = lethal ? eventDist(1, 0, false, pFail, dEff) : evHit;

  // ---- expectations for the displayed breakdown
  const EA = mean(aDist);
  const Esust = mean(sustDist);
  const sustained = EA * pCritHit * Esust;
  const hits = EA * pHit + sustained;
  const woundRolls = EA * (pHit - pCritHit) + sustained + (lethal ? 0 : EA * pCritHit);
  const autoWounds = lethal ? EA * pCritHit : 0;
  const wounds = autoWounds + woundRolls * pWound;
  const unsaved = autoWounds * pFail
    + woundRolls * (Math.max(0, pWound - pCritW) * pFail + pCritW * (ab.devastating ? 1 : pFail));
  // Taken from the event distributions so the headline damage can never drift
  // from what the models-slain DP actually allocates.
  const damage = EA * ((pHit - pCritHit) * mean(evHit) + pCritHit * (mean(evLethal) + Esust * mean(evHit)));

  return {
    name: weapon.name, type: weapon.type, models, unresolved: false,
    unmodelled: ab.unmodelled,
    aDist, sustDist, ev: { hit: evHit, lethal: evLethal },
    p: { hit: pHit, critHit: pCritHit, wound: pWound, critWound: pCritW, failSave: pFail },
    exp: { attacks: EA, hits, sustained, wounds, unsaved, damage },
  };
}

// ---- models slain ----------------------------------------------------------
//
// State st[m][r] = P(m models slain AND the model currently being allocated to has
// r wounds left), flattened to m * W + (r - 1). m === M is absorbing.
//
// Damage is allocated model by model and excess is DISCARDED on a kill, which is
// why expected-damage / wounds-per-model overstates kills badly (a D6 weapon into
// 1-wound models kills one model per wound, not 3.5).

function applyEvent(st, ev, W, M) {
  const out = new Float64Array(st.length);
  for (let m = 0; m <= M; m++) {
    for (let r = 1; r <= W; r++) {
      const p = st[m * W + (r - 1)];
      if (!p) continue;
      if (m === M) { out[m * W + (r - 1)] += p; continue; } // unit already wiped
      for (let k = 0; k < ev.length; k++) {
        if (!ev[k]) continue;
        const pq = p * ev[k];
        if (k === 0) out[m * W + (r - 1)] += pq;            // no damage got through
        else if (k < r) out[m * W + (r - 1 - k)] += pq;     // wounded, still standing
        else out[(m + 1) * W + (W - 1)] += pq;              // slain; excess wasted
      }
    }
  }
  return out;
}

function addInto(dst, src, w) {
  if (!w) return;
  for (let i = 0; i < dst.length; i++) dst[i] += src[i] * w;
}

// One attack: miss, ordinary hit, or a critical hit that resolves its own event
// and THEN its sustained extras. The extras must be applied as separate events —
// convolving them into a single damage lump would let one kill absorb both and
// under-count the dead.
function stepAttack(st, row, W, M) {
  const { p, ev, sustDist } = row;
  const out = new Float64Array(st.length);
  addInto(out, st, 1 - p.hit);
  addInto(out, applyEvent(st, ev.hit, W, M), p.hit - p.critHit);
  let s = applyEvent(st, ev.lethal, W, M);
  for (let x = 0; x < sustDist.length; x++) {
    addInto(out, s, p.critHit * sustDist[x]);
    if (x + 1 < sustDist.length) s = applyEvent(s, ev.hit, W, M);
  }
  return out;
}

// Mix over the row's attack-count distribution: after n sequential attacks, the
// state is the answer for "the row had exactly n attacks".
function applyRow(st, row, W, M) {
  const a = row.aDist;
  const out = new Float64Array(st.length);
  let cur = st;
  for (let n = 0; n < a.length; n++) {
    if (a[n]) addInto(out, cur, a[n]);
    if (n + 1 < a.length) cur = stepAttack(cur, row, W, M);
  }
  return out;
}

// Keeps a pathological roster from freezing the tab: past this many cell updates
// we collapse a row's attack count to its rounded mean instead.
const DP_BUDGET = 5e6;

// Distribution of models slain across all rows. One state threads through every
// row because the whole unit shoots the same target, so overkill waste carries
// across weapons — which also makes row ORDER matter (W=2 hit for 1,2,1 kills one
// model; 2,1,1 kills two). Rows resolve in the order given.
export function slainDist(rows, tgt) {
  const W = tgt.W;
  const M = tgt.models;
  let st = new Float64Array((M + 1) * W);
  st[W - 1] = 1; // 0 slain, current model at full wounds
  let approx = false;
  for (const row of rows) {
    if (!row.models || row.unresolved || row.aDist.length <= 1) continue;
    let r = row;
    if (row.aDist.length * st.length > DP_BUDGET) {
      const n = Math.round(mean(row.aDist));
      const a = new Array(n + 1).fill(0);
      a[n] = 1;
      r = { ...row, aDist: a };
      approx = true;
    }
    st = applyRow(st, r, W, M);
  }
  const dist = new Array(M + 1).fill(0);
  for (let m = 0; m <= M; m++) {
    for (let r = 1; r <= W; r++) dist[m] += st[m * W + (r - 1)];
  }
  let expected = 0;
  for (let m = 0; m <= M; m++) expected += m * dist[m];
  return { dist, expected, wipeChance: dist[M], approx };
}

// ---- top level -------------------------------------------------------------

// rows: [{ weapon, models, ...per-row opts }] — already filtered to enabled rows.
// Returns the per-weapon breakdown, the summed chain and the models-slain result.
export function resolveAttack(rows, target, mods = {}) {
  const tgt = normalizeTarget(target);
  const resolved = rows.map((r) => resolveRow(r.weapon, tgt, { ...mods, models: r.models }));
  const totals = { attacks: 0, hits: 0, sustained: 0, wounds: 0, unsaved: 0, damage: 0 };
  for (const r of resolved) {
    for (const k of Object.keys(totals)) totals[k] += r.exp[k];
  }
  const slain = slainDist(resolved, tgt);
  const unmodelled = [...new Set(resolved.flatMap((r) => r.unmodelled))];
  return { rows: resolved, totals, slain, target: tgt, unmodelled };
}
