# Stock Valuations

An [Obsidian](https://obsidian.md) plugin that calculates a stock's intrinsic value using four classic valuation methods, and keeps the results in your vault.

Open it from the ribbon icon (landmark icon) or the **Open stock valuations** command. This opens a dedicated view with a saved-valuations table; **+ New valuation** opens the calculator form.

## Features

### Valuation methods

All four methods run from a single form and are computed together every time an input changes.

- **WACC** (`calculations.ts: calcWacc`) — weighted average cost of capital, used as the DCF's discount rate. Cost of equity via CAPM (`rfr + beta * mrp`), cost of debt as `intExp / totDebt` tax-adjusted by `taxRate`, blended by market-value weight (`mktCap` vs `totDebt`).
- **DCF** (`calcDcf`) — 10-year, two-stage free cash flow projection: `growth1to5` for years 1–5, `growth6to10` for years 6–10, discounted at WACC. Year 10 flows into a Gordon Growth terminal value at `terminalGrowth`, and `netDebt` is subtracted from enterprise value before dividing by `shares` to get equity value per share.
- **Graham Formula** (`calcGraham`) — Benjamin Graham's `EPS * (8.5 + 2g) * 4.4 / Y` formula, where `g` is expected EPS growth and `Y` is the current AAA bond yield (scales the multiple down as yields rise above Graham's ~4.4% baseline).
- **Ten Cap** (`calcTenCap`) — owner earnings (`ocf - capex * mainPct`) valued at a 10x multiple, plus owner-earnings yield at the current price (`ownerEarningsYield`).

Each method also reports **margin of safety** (`marginOfSafety`) — how far below intrinsic value the current price trades, as a %.

These five functions are pure and have no Obsidian dependency — see `tests/calculations.test.ts` for their exact behavior, including edge cases (zero shares, zero debt, non-positive bond yield, etc).

### Calculator form

- Live price lookup by ticker via Yahoo Finance (`priceProvider.ts`); price and EPS are always entered as actual per-share dollars, never scaled
- Per-field help tooltips (`?` button next to each input) pulled from `helpText.ts`
- A configurable **input scale** (ones/thousands/millions/billions, `units.ts`) applied separately to money figures (debt, FCF, OCF, capex, market cap, ...) and to share counts — so you can key in numbers exactly as a filing reports them, without doing the unit math yourself
- **Save** stores the valuation keyed by uppercase ticker (`valuationStore.ts: ValuationTable`), overwriting any prior save for that ticker

### Saved valuations table

- One row per saved ticker, with each method's intrinsic value, Ten Cap yield, current price, and last-updated date
- Edit re-opens the form pre-filled with the saved inputs; Delete removes the row (with confirmation)
- Two charts per stock (Chart.js): margin of safety by method, and price vs. fair value

### Vault summary note

Every save/delete regenerates a markdown table of all saved valuations at a configurable vault path (`noteSync.ts`, default `Stock Valuations/Stock Valuations.md`). It's the vault-visible mirror of the plugin's own data — rewritten in full on every change, so don't hand-edit it; edits there won't persist.

## Settings

| Setting | Description |
|---|---|
| Vault summary note path | Where the auto-generated summary table is written; parent folders are created automatically |
| Default money scale | Pre-fills the unit dropdown for dollar figures (debt, market cap, FCF, OCF, capex, interest expense, net debt) |
| Default share count scale | Pre-fills the unit dropdown for diluted shares outstanding |
| Risk-free rate (%) | 10-year US Treasury yield, pre-filled into new calculations |
| Market risk premium (%) | Pre-filled into new calculations |
| Tax rate (%) | Effective tax rate, used as the WACC after-tax cost of debt default |
| Maintenance capex (%) | Default share of total capex treated as maintenance vs. growth capex, for Ten Cap |
| Terminal growth rate (%) | DCF terminal growth default; also pre-fills the Year 6–10 growth field |
| AAA corporate bond yield (%) | Default for the Graham formula |

All rates are stored and entered as percentages (`4` means `4%`); the calculators divide by 100 internally. Everything here is a *default* — per-stock numbers (beta, EPS, shares, debt, price, growth rates, ...) are always entered fresh for each valuation and can override any default.

## Project layout

| File | Responsibility |
|---|---|
| `main.ts` | Plugin entry point — registers the view, ribbon icon, command, and settings tab; loads/persists plugin data |
| `view.ts` | The calculator + table UI (`ItemView`), including form rendering, chart rendering, and screen state |
| `calculations.ts` | Pure valuation math (WACC, DCF, Graham, Ten Cap, margin of safety, owner earnings yield) |
| `settings.ts` | Settings schema, defaults, and the settings tab UI |
| `valuationStore.ts` | Types for saved valuations and the in-memory/persisted table |
| `noteSync.ts` | Regenerates the vault summary note from the valuation table |
| `priceProvider.ts` | Yahoo Finance quote lookup |
| `units.ts` | Scale (ones/thousands/millions/billions) types, labels, and multipliers |
| `format.ts` | Number sanitization/formatting for form inputs and display |
| `helpText.ts` | Per-field help tooltip copy |

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

## Manual installation

Not yet on the Obsidian Community Plugins list.

1. `make build`, or download `main.js`, `manifest.json`, and `styles.css` from a release
2. Copy them into `<your vault>/.obsidian/plugins/stock-valuations/`
3. Reload Obsidian and enable **Stock Valuations** under Settings → Community plugins

## License

MIT
