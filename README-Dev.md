# Development notes

Technical reference for working on this plugin. See `README.md` for user-facing documentation (what ships in the in-app Help screen's spirit — keep that file free of file/function names and build details; put those here instead).

## Project layout

| File | Responsibility |
|---|---|
| `main.ts` | Plugin entry point — registers the view, ribbon icon, command, and settings tab; constructs `DataRepository` and awaits its `load()` |
| `dataRepository.ts` | Owns every read/write of persisted state (settings + the valuation table) — see **Data persistence (implementation)** below |
| `view.ts` | The calculator + table UI (`ItemView`), including form rendering, chart rendering, screen state, and the research-link menus/modals |
| `calculations.ts` | Pure valuation math (WACC, DCF, Graham, Ten Cap, margin of safety, owner earnings yield) |
| `settings.ts` | Settings schema, defaults, and the settings tab UI (imperative `display()` for pre-1.13 Obsidian, plus the declarative `getSettingDefinitions()` for 1.13+) |
| `valuationStore.ts` | Types for saved valuations and the in-memory/persisted table, including a ticker's `HistoryEntry[]` timeline |
| `historyStore.ts` | Pure logic for a saved valuation's history timeline — building an entry (`buildHistoryEntry`), append-with-dedupe-by-day, single-entry delete, and 6-month/monthly compaction |
| `migrations.ts` | On-disk schema version + the v1→v2 (single-scenario → Bull/Base/Bear) migration, run once by `DataRepository.load()` |
| `noteSync.ts` | Regenerates the vault summary note from the valuation table |
| `priceProvider.ts` | Yahoo Finance quote lookup |
| `units.ts` | Scale (ones/thousands/millions/billions) types, labels, and multipliers |
| `format.ts` | Number sanitization/formatting for form inputs and display |
| `helpText.ts` | Per-field help tooltip copy |
| `docs.ts` | Content for the in-app help/methodology screen — formulas, sources, per-method fit guidance |

### Valuation methods (implementation)

- **WACC** (`calculations.ts: calcWacc`) — cost of equity via CAPM (`rfr + beta * mrp`), cost of debt as `intExp / totDebt` tax-adjusted by `taxRate`, blended by market-value weight (`mktCap` vs `totDebt`).
- **DCF** (`calcDcf`) — 10-year, two-stage free cash flow projection: `growth1to5` for years 1–5, `growth6to10` for years 6–10, discounted at WACC. Year 10 flows into a Gordon Growth terminal value at `terminalGrowth`, and `netDebt` is subtracted from enterprise value before dividing by `shares` to get equity value per share.
- **Reverse DCF** (`calcImpliedGrowth`) — fixes price and every other `DcfInputs` field, bisects for the `growth1to5` that makes `calcDcf(...)` equal price (`calcDcf` is monotonic increasing in `growth1to5` for a fixed `wacc`, so bisection is safe). Returns `NaN` when price falls outside what the `[lo, hi]` bracket (default `[-0.5, 1.0]`) can produce, which the UI shows as "—". `valuationCalc.ts: computeResultsForState` wires it into `Results.impliedGrowth`; `view.ts: renderResults()` surfaces it as its own labeled row in the results panel's "Other metrics" table (`HELP_TEXT.impliedGrowth` behind the row's `?` icon) rather than a grid — kept out of the "Margin of safety" table above it since it has no MoS of its own (see `mosRow`/`metricRow` in `renderResults()`).
- **Graham Formula** (`calcGraham`) — `EPS * (8.5 + 2g) * 4.4 / Y`, where `g` is expected EPS growth and `Y` is the current AAA bond yield.
- **Ten Cap** (`calcTenCap`) — owner earnings (`ocf - capex * mainPct`) valued at a 10x multiple, plus owner-earnings yield at the current price (`ownerEarningsYield`).
- Margin of safety: `marginOfSafety`.

These six functions are pure and have no Obsidian dependency — see `tests/calculations.test.ts` for their exact behavior, including edge cases (zero shares, zero debt, non-positive bond yield, out-of-bracket reverse DCF, etc).

### Research links (implementation)

- Data: `SavedValuation.researchNotePath` (`valuationStore.ts`) — an optional vault path, set/cleared only from the table (never the calculator form). `view.ts: saveValuation()` explicitly carries it forward from `this.originalTicker`'s prior record (`plugin.data.getValuation(...)`) on every save, since the record object is otherwise rebuilt from scratch — don't lose this when touching that method.
- Gate: `settings.ts: researchLinksActive(settings)` — `true` only when `enableResearchLinks` is on **and** `researchNotesFolder` is non-blank (no shipped default folder). Both the table (`view.ts`) and the vault summary note (`noteSync.ts` via `main.ts`) call this so they never disagree about whether the column is showing.
- Table UI: `view.ts: renderResearchCell()` renders either an open+unlink icon pair (linked, file resolves), a "Link note" pill with a "not found — click to relink" tooltip (path stored but `Vault.getAbstractFileByPath` can't resolve it), or the same pill with a neutral tooltip (never linked). Both the open and unlink icon clicks (and the row-delete flow) go through `ConfirmModal` for anything that removes state — `ConfirmModal` takes an optional `confirmLabel`/`confirmCls` now (`"mod-warning"` default for destructive actions, `"mod-cta"` used for the create confirmation below) since it's shared across all of these.
- `openLinkNoteMenu()` shows an Obsidian `Menu` with two items: "Choose an existing note…" opens `LinkNoteSuggestModal` (a `FuzzySuggestModal<TFile>` over `vault.getFiles()` — intentionally not markdown-only, since the plugin never reads the file), and "Create a new note here…" builds the path as `<folder>/<TICKER>-research.md` directly — **no filename prompt**; the ticker convention is fixed, unlike the free-form naming "Choose existing" allows for a note you already have. It checks `Vault.getAbstractFileByPath()` first: if something's already there it shows an error `Notice` and stops (no confirm, no overwrite); otherwise it shows a `ConfirmModal` naming the exact path before calling `createAndLinkResearchNote()`, which re-checks existence itself as a race-condition guard and errors the same way if it lost the race. Both paths funnel into `setResearchLink()`, which mutates the in-memory record (from `plugin.data.getValuation()`) and calls `plugin.data.persistValuations()`.
- Note creation reuses `noteSync.ts`'s exported `ensureFolderExists()` rather than duplicating parent-folder creation logic.
- "Research notes folder" is a plain text field, no autocomplete (a hand-rolled `AbstractInputSuggest` subclass was tried and dropped — couldn't confirm it was actually firing at runtime, not worth the unverifiable custom code). Instead, `settings.ts: researchFolderWarning()` is a non-blocking sanity check called from both the imperative `onChange` and the declarative `setControlValue()`: if the typed path resolves to an existing file (not a folder) it warns; if it doesn't exist yet it warns but still saves the value, since `view.ts: createAndLinkResearchNote()` creates the folder automatically the first time a note is actually added there. Surfaced via `Notice`, not a persisted inline error — deliberately not wired through the declarative API's `validate` hook, which *rejects* (doesn't persist) a value on a non-empty return, which is wrong here since a not-yet-existing folder is a valid, expected state.
- Vault summary note: `noteSync.ts: researchLinkCell()` renders a bare wikilink (`[[path-without-extension|Research]]`, pipe-escaped) or `—`. Toggling the feature off never deletes `researchNotePath` from any record — it only stops rendering the column in both places. Deleting the whole row (`deleteValuation()`) is still what removes a link for good, same as it removes everything else about that ticker.

### Valuation history (implementation)

- Data: `HistoryEntry` (`valuationStore.ts`) — `at` (epoch ms, doubles as dedupe key and chart x-axis), `price`, `dcfBearIv`/`dcfBaseIv`/`dcfBullIv`, `grahamBearIv`/`grahamBaseIv`/`grahamBullIv`, `tenCapIv`, `impliedGrowth`. No MoS fields — always derived from `iv`/`price` via `calculations.ts: marginOfSafety` at render time, never stored, so a formula change can't leave stale MoS sitting in old entries. `SavedValuation.history?: HistoryEntry[]`, omitted (not `[]`) once empty, same convention as `researchNotePath`/`lastPriceRefreshAt`. Purely additive to the schema — no `CURRENT_SCHEMA_VERSION` bump, same reasoning as those two optional fields.
- Logic: `historyStore.ts`, Obsidian-free and fully unit tested (`tests/historyStore.test.ts`). `appendHistoryEntry` replaces any existing entry from the same **local** calendar day rather than accumulating one per save; `deleteHistoryEntry` removes by exact timestamp; `compactHistory` collapses anything older than ~182 days to the latest entry per calendar month (local time), leaving recent entries untouched — idempotent, and the caller's job to gate behind a confirmation since it's irreversible.
- Wiring: `historyStore.ts: buildHistoryEntry(at, scenarios)` builds one `HistoryEntry` from a scenario set (all three scenarios' DCF/Graham IV, Base's price/Ten Cap/impliedGrowth) — the single place that mapping lives, shared by both callers below. `view.ts: saveValuation()` calls it on the record it just built and runs the result through `appendHistoryEntry`, carrying the prior `history` forward from `this.originalTicker` the same way `researchNotePath`/`lastPriceRefreshAt` are. `refreshAllPrices()` calls it too, per ticker, right after recomputing that ticker's price-derived results — a price refresh earns a history point the same as a Save does, since MoS/IV moving with price is exactly what this timeline tracks; Graham/Ten Cap end up unchanged entry-to-entry from refreshes since they don't depend on price, same as the live results.
- UI: `view.ts: renderHistorySection()`/`renderHistoryTabulator()`, rendered last on the calculator form (`renderForm()`), after the sensitivity grids — skipped entirely for a brand-new, never-saved valuation (`this.originalTicker === null`). A date-range line (oldest → newest entry) sits under the section header. Read live off `plugin.data.getValuation()`, not copied into form state, same as research links. The table itself is a second `Tabulator` instance (`this.historyTabulator`, torn down in `destroyTabulator()` alongside the others) with the same paginated/sortable/responsive-collapse setup as the main table (`StockValuationsView.PAGE_SIZE` rows/page) — `HistoryRow`/`buildHistoryRow()` flatten a `HistoryEntry` into precomputed IV/MoS pairs the same shape as `TableRow`, and `ivMosFormatter` was genericized (`ivMosFormatter<T>`) so both tables' columns share one formatter. Delete and Compact both go through `ConfirmModal`, then a full `this.render()` — same "just re-render the screen" pattern as every other data-mutating action here (delete/link/unlink), rather than patching the Tabulator instance in place. `renderHistoryChart()` plots one "fair value vs. price" line chart per scenario off the same entries (Chart.js `tension: 0.4` on each dataset for a curved rather than segmented line).
- Docs: `docs.ts: VALUATION_HISTORY_DOC`, rendered in `view.ts: renderDocs()` right after `DATA_SOURCES_DOC` — explicitly states history only accrues forward from the next Save or refresh, since there's no way to reconstruct entries for saves/refreshes made before this feature existed.
- Never touches the vault note: `noteContent.ts: buildNoteContent()` reads only `scenarios`/`updatedAt` — structurally incapable of seeing `history`, not just conventionally.

### Data persistence (implementation)

- `dataRepository.ts: DataRepository` owns every read/write of the plugin's persisted state (settings + the per-ticker `ValuationTable`) — `main.ts` and `view.ts` go through `plugin.data.*` rather than touching `plugin.settings`/`plugin.valuations` fields directly. Key methods: `load()` (migration included), `getValuation()`/`getAllValuations()`/`tickers()` (reads), `saveValuation(ticker, record)` (whole-record upsert — the calculator form's Save), `deleteValuation(ticker)`, `persistValuations()` (flush-to-disk-and-resync-note, for callers that mutated a record obtained from `getValuation()` in place — history edits, research-note linking, `refreshAllPrices()`'s batch loop), and `saveSettings()` (disk only, no note resync).
- Deliberately Obsidian-runtime-free, same reasoning as `historyStore.ts`/`migrations.ts` (the `obsidian` npm package ships type declarations only, no runtime, so a class built against it can't be constructed in a Vitest test). `PluginDataAdapter` is a two-method duck-typed interface (`loadData`/`saveData`) that Obsidian's real `Plugin` already satisfies structurally — `main.ts` just passes `this`. The vault note resync and note-sync-failure `Notice` are injected (`NoteSyncFn`, `onNoteSyncError`) rather than imported, for the same reason.
- Covered by `tests/dataRepository.test.ts` using an in-memory fake adapter — fresh-install load, settings-merge-over-defaults, legacy-schema migration (and that it persists immediately), already-migrated load (and that it does *not* re-persist), the full valuation CRUD surface, the persist-after-in-place-mutation path, settings-only save (no note resync), and note-sync failure handling.

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

`calculations.ts`, `format.ts`, `units.ts`, `historyStore.ts`, `migrations.ts`, and `dataRepository.ts` are pure/Obsidian-runtime-free and framework-agnostic, so they're covered by unit tests under `tests/` (Vitest) — `dataRepository.ts` via a fake `PluginDataAdapter` rather than the real Obsidian `Plugin`. The rest of the plugin (`main.ts`, `view.ts`, `settings.ts`, `noteSync.ts`, `priceProvider.ts`) is written directly against the Obsidian API/DOM and isn't currently unit tested — verify changes there by loading the built plugin in a vault (`make build`, then copy `main.js`/`manifest.json`/`styles.css` into `<vault>/.obsidian/plugins/stock-valuations/` and reload Obsidian).

### Build

`esbuild.config.mjs` bundles `main.ts` into `main.js`, marking `obsidian`, `electron`, and the CodeMirror/`@lezer` packages as external (they're provided by the Obsidian runtime). `make dev` runs an esbuild watch context with inline sourcemaps; `make build` typechecks first, then produces a minified, sourcemap-free production bundle.

### Compatibility

`manifest.json` pins `minAppVersion` to `1.7.2`. The declarative settings API (`getSettingDefinitions()`, `toggle`/`folder`/`file` control types, per-item `visible`) is 1.13.0+ only and is ignored on older Obsidian, which falls back to the imperative `display()` in `settings.ts` — when adding a setting, add it to both and keep them behaviorally equivalent. Everything else used (`Menu`, `FuzzySuggestModal`, `normalizePath`, `TFile`, etc.) predates 1.7.2.
