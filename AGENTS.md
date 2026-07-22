# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

A **Warhammer 40,000 (11th edition) army builder** — a client-side web app with
**no build step, no dependencies, and no framework**. Plain HTML + CSS + vanilla
ES modules. Open `index.html` in a browser and it runs.

Game data is **fetched live** from the community [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e)
repository (raw JSON over CORS), plus per-detachment points from the
[wh40k-11e-mfm](https://github.com/BSData/wh40k-11e-mfm) YAML data. Nothing is
bundled locally — a network connection to GitHub is required to load factions.
The user's roster is persisted to `localStorage`.

## Running & testing

- **Run it:** open `index.html` directly, or serve the folder
  (`python3 -m http.server`) and open the page. Selecting a faction triggers the
  live GitHub fetch.
- **No test runner, no linter, no `package.json`.** After editing JS, sanity-check
  syntax with `node --check js/<file>.js`.
- Pure logic (in `engine.js`, `roster.js`) can be exercised from Node by importing
  the ES module directly. `roster.js` touches `localStorage`, so shim it first:
  `globalThis.localStorage = { store:{}, getItem(k){return this.store[k]??null}, setItem(k,v){this.store[k]=v}, removeItem(k){delete this.store[k]} }`.

## Architecture

Three-panel UI (browse units · configure a unit · army roster), wired through a
single reactive store. Modules under `js/`, loaded via
`<script type="module" src="js/app.js">`.

| File | Responsibility |
|------|----------------|
| `js/config.js` | Constants: repo URLs, points presets, `STORAGE_KEY`, DP-budget rule, faction-name ↔ MFM-slug mapping, fallback faction list. |
| `js/data.js` | Network layer. Fetches faction list, catalogue bundle (faction + linked libraries + game system), and MFM detachment points. |
| `js/catalogue.js` | Parses raw BSData JSON into app-friendly objects. `buildIndex`, `listUnits`, `listDetachments`, `resolveUnit`, option-group/weapon/ability/statline extraction. This is the messy part — BSData is deeply nested with cross-file links. |
| `js/engine.js` | **Pure** selection + points logic. No DOM, no I/O. Selection model, constraints (`validate`), `toggleOption`, `computePoints`, `defaultSelections`, `selectionsFromEntry`. |
| `js/roster.js` | **The state store.** Holds `state`, mutating functions, `subscribe`/`emit`, `localStorage` persistence, and text export. |
| `js/ui.js` | **All DOM rendering.** Pure-ish `render*` functions take data + callbacks and write DOM. No app state lives here. |
| `js/app.js` | **Bootstrap + orchestration.** Owns transient app state (`app.*`), wires UI callbacks to store mutations, drives faction loading. |

### Data flow (important)

There is **one reactive path**: every store mutation ends with `emit()`, which
notifies subscribers then `save()`s to `localStorage`. The sole subscriber is
`refreshRoster` in `app.js`, registered via `roster.subscribe(...)`. So:

```
store mutation → emit() → refreshRoster() → ui.renderRoster() + save()
```

The **detail/config panel** (middle) re-renders imperatively — `app.js` calls
`renderDetail()` / `renderEdit()` directly on user interaction; it is NOT driven
by the subscription.

### The two data shapes to keep straight

1. **`selections`** (transient, editable) — what the config UI reads/writes:
   `{ [groupId]: string[], __size: number, __enh: string }`. Keys `__size`/`__enh`
   are `SIZE_KEY`/`ENH_KEY` from `engine.js`.
2. **roster entry** (persisted) — what lives in `state.entries`:
   `{ uid, unitId, unitName, role, points, modelCount, enhancementId, options:[{group,name,cost}], selections }`.
   `options` is *resolved display data*; `selections` is the raw model stored so
   an entry can be re-opened for editing. Convert entry → selections with
   `engine.selectionsFromEntry(unit, entry)` (falls back to reconstructing from
   option names for legacy entries that predate the stored `selections` field).

## Conventions

- **ES modules, no transpile.** Only browser-native JS — no TypeScript, JSX, or
  bare-specifier imports. Import with explicit `./x.js` paths.
- **Keep the layers separated:** logic in `engine.js` stays pure (no DOM/I/O);
  rendering in `ui.js` stays stateless (data in, DOM out, callbacks for actions);
  app state and wiring live only in `app.js`; all persisted state changes go
  through `roster.js` and end in `emit()`.
- **Always `esc()` interpolated data** in `ui.js` template strings (it's the local
  HTML-escaper) — unit/option names come from external data.
- Match the surrounding style: small focused functions, terse comments that
  explain *why* (especially around BSData quirks), 2-space indent.
- Reuse existing render/logic helpers before adding new ones (e.g. the config UI
  is shared by the detail panel and the edit modal via `configBody` /
  `bindConfigInputs` / `renderDetailFoot`).

## Gotchas

- **GitHub rate limits:** the contents API is 60 req/hr unauthenticated;
  `FALLBACK_FACTIONS` in `config.js` covers the list-factions call, but catalogue
  fetches still hit raw GitHub.
- **BSData is gnarly:** entries link across files and nest arbitrarily.
  `catalogue.js` uses bounded-depth walks (`maxDepth`) — be careful changing them.
- **localStorage schema:** `STORAGE_KEY` is versioned (`..._v1`). `roster.load()`
  already migrates the pre-11e single-`detachment` field; add migrations there if
  you change the entry shape.
