# Development notes

Technical reference for working on this plugin. See `README.md` for user-facing documentation (what ships in the in-app Help screen's spirit — keep that file free of file/function names and build details; put those here instead).

## Project layout

| File | Responsibility |
|---|---|
| `main.ts` | Plugin entry point — registers the view, ribbon icon, command, and settings tab; loads/persists plugin data |
| `view.ts` | The calculator + table UI (`ItemView`), including form rendering, chart rendering, screen state, and the research-link menus/modals |
| `calculations.ts` | Pure valuation math (WACC, DCF, Graham, Ten Cap, margin of safety, owner earnings yield) |
| `settings.ts` | Settings schema, defaults, and the settings tab UI (imperative `display()` for pre-1.13 Obsidian, plus the declarative `getSettingDefinitions()` for 1.13+) |
| `valuationStore.ts` | Types for saved valuations and the in-memory/persisted table |
| `noteSync.ts` | Regenerates the vault summary note from the valuation table |
| `priceProvider.ts` | Yahoo Finance quote lookup |
| `units.ts` | Scale (ones/thousands/millions/billions) types, labels, and multipliers |
| `format.ts` | Number sanitization/formatting for form inputs and display |
| `helpText.ts` | Per-field help tooltip copy |
| `docs.ts` | Content for the in-app help/methodology screen — formulas, sources, per-method fit guidance |

### Valuation methods (implementation)

- **WACC** (`calculations.ts: calcWacc`) — cost of equity via CAPM (`rfr + beta * mrp`), cost of debt as `intExp / totDebt` tax-adjusted by `taxRate`, blended by market-value weight (`mktCap` vs `totDebt`).
- **DCF** (`calcDcf`) — 10-year, two-stage free cash flow projection: `growth1to5` for years 1–5, `growth6to10` for years 6–10, discounted at WACC. Year 10 flows into a Gordon Growth terminal value at `terminalGrowth`, and `netDebt` is subtracted from enterprise value before dividing by `shares` to get equity value per share.
- **Graham Formula** (`calcGraham`) — `EPS * (8.5 + 2g) * 4.4 / Y`, where `g` is expected EPS growth and `Y` is the current AAA bond yield.
- **Ten Cap** (`calcTenCap`) — owner earnings (`ocf - capex * mainPct`) valued at a 10x multiple, plus owner-earnings yield at the current price (`ownerEarningsYield`).
- Margin of safety: `marginOfSafety`.

These five functions are pure and have no Obsidian dependency — see `tests/calculations.test.ts` for their exact behavior, including edge cases (zero shares, zero debt, non-positive bond yield, etc).

### Research links (implementation)

- Data: `SavedValuation.researchNotePath` (`valuationStore.ts`) — an optional vault path, set/cleared only from the table (never the calculator form). `view.ts: saveValuation()` explicitly carries it forward from `this.originalTicker`'s prior record on every save, since the record object is otherwise rebuilt from scratch — don't lose this when touching that method.
- Gate: `settings.ts: researchLinksActive(settings)` — `true` only when `enableResearchLinks` is on **and** `researchNotesFolder` is non-blank (no shipped default folder). Both the table (`view.ts`) and the vault summary note (`noteSync.ts` via `main.ts`) call this so they never disagree about whether the column is showing.
- Table UI: `view.ts: renderResearchCell()` renders either an open+unlink icon pair (linked, file resolves), a "Link note" pill with a "not found — click to relink" tooltip (path stored but `Vault.getAbstractFileByPath` can't resolve it), or the same pill with a neutral tooltip (never linked). Both the open and unlink icon clicks (and the row-delete flow) go through `ConfirmModal` for anything that removes state — `ConfirmModal` takes an optional `confirmLabel`/`confirmCls` now (`"mod-warning"` default for destructive actions, `"mod-cta"` used for the create confirmation below) since it's shared across all of these.
- `openLinkNoteMenu()` shows an Obsidian `Menu` with two items: "Choose an existing note…" opens `LinkNoteSuggestModal` (a `FuzzySuggestModal<TFile>` over `vault.getFiles()` — intentionally not markdown-only, since the plugin never reads the file), and "Create a new note here…" builds the path as `<folder>/<TICKER>-research.md` directly — **no filename prompt**; the ticker convention is fixed, unlike the free-form naming "Choose existing" allows for a note you already have. It checks `Vault.getAbstractFileByPath()` first: if something's already there it shows an error `Notice` and stops (no confirm, no overwrite); otherwise it shows a `ConfirmModal` naming the exact path before calling `createAndLinkResearchNote()`, which re-checks existence itself as a race-condition guard and errors the same way if it lost the race. Both paths funnel into `setResearchLink()`, which mutates the in-memory record and calls `saveValuations()`.
- Note creation reuses `noteSync.ts`'s exported `ensureFolderExists()` rather than duplicating parent-folder creation logic.
- "Research notes folder" is a plain text field, no autocomplete (a hand-rolled `AbstractInputSuggest` subclass was tried and dropped — couldn't confirm it was actually firing at runtime, not worth the unverifiable custom code). Instead, `settings.ts: researchFolderWarning()` is a non-blocking sanity check called from both the imperative `onChange` and the declarative `setControlValue()`: if the typed path resolves to an existing file (not a folder) it warns; if it doesn't exist yet it warns but still saves the value, since `view.ts: createAndLinkResearchNote()` creates the folder automatically the first time a note is actually added there. Surfaced via `Notice`, not a persisted inline error — deliberately not wired through the declarative API's `validate` hook, which *rejects* (doesn't persist) a value on a non-empty return, which is wrong here since a not-yet-existing folder is a valid, expected state.
- Vault summary note: `noteSync.ts: researchLinkCell()` renders a bare wikilink (`[[path-without-extension|Research]]`, pipe-escaped) or `—`. Toggling the feature off never deletes `researchNotePath` from any record — it only stops rendering the column in both places. Deleting the whole row (`deleteValuation()`) is still what removes a link for good, same as it removes everything else about that ticker.

## Development

```
make install     # npm install
make dev         # build main.ts and watch for changes (unminified, inline sourcemaps)
make build       # typecheck, then produce a minified production main.js
make typecheck   # tsc -noEmit over the project
make test        # run the test suite once (vitest)
make test-watch  # run tests in watch mode
make clean       # remove build output (main.js, main.js.map)
```

Run `make help` for the full list of targets.

### Testing

`calculations.ts`, `format.ts`, and `units.ts` are pure and framework-agnostic, so they're covered by unit tests under `tests/` (Vitest). The rest of the plugin (`main.ts`, `view.ts`, `settings.ts`, `noteSync.ts`, `priceProvider.ts`) is written directly against the Obsidian API/DOM and isn't currently unit tested — verify changes there by loading the built plugin in a vault (`make build`, then copy `main.js`/`manifest.json`/`styles.css` into `<vault>/.obsidian/plugins/stock-valuations/` and reload Obsidian).

### Build

`esbuild.config.mjs` bundles `main.ts` into `main.js`, marking `obsidian`, `electron`, and the CodeMirror/`@lezer` packages as external (they're provided by the Obsidian runtime). `make dev` runs an esbuild watch context with inline sourcemaps; `make build` typechecks first, then produces a minified, sourcemap-free production bundle.

### Compatibility

`manifest.json` pins `minAppVersion` to `1.7.2`. The declarative settings API (`getSettingDefinitions()`, `toggle`/`folder`/`file` control types, per-item `visible`) is 1.13.0+ only and is ignored on older Obsidian, which falls back to the imperative `display()` in `settings.ts` — when adding a setting, add it to both and keep them behaviorally equivalent. Everything else used (`Menu`, `FuzzySuggestModal`, `normalizePath`, `TFile`, etc.) predates 1.7.2.
