# 📈 Stock Valuations

An [Obsidian](https://obsidian.md) plugin that calculates a stock's intrinsic value using four classic valuation methods, and keeps the results in your vault.

Open it from the ribbon icon (🏛️ landmark icon) or the **Open calculator** command. This opens a dedicated view with a saved-valuations table; **+ New valuation** opens the calculator form, and **Help** opens the built-in help/methodology screen.

## ✨ Features

### 🧮 Valuation methods

All four methods run from a single form and are computed together every time an input changes.

- **WACC** — weighted average cost of capital, used as the DCF's discount rate.
- **DCF** — a 10-year, two-stage free cash flow projection, discounted back to a present value.
- **Graham Formula** — Benjamin Graham's classic valuation formula based on earnings and growth.
- **Ten Cap** — values a business's owner earnings at a 10x multiple, plus the owner-earnings yield at the current price.

Each method also reports a **margin of safety** — how far below intrinsic value the current price trades, as a %. Open the built-in Help screen (below) for the exact formula behind each method and honest guidance on when it does and doesn't apply.

### 📝 Calculator form

- Live price lookup by ticker via Yahoo Finance; price and EPS are always entered as actual per-share dollars, never scaled
- Per-field help tooltips (the `?` button next to each input)
- A configurable **input scale** (ones/thousands/millions/billions) applied separately to money figures (debt, FCF, OCF, capex, market cap, ...) and to share counts — so you can key in numbers exactly as a filing reports them, without doing the unit math yourself
- **🐂 Bull / Base / 🐻 Bear scenario tabs** — DCF and Graham project three growth scenarios side by side, each independently editable; every other field (price, shares, WACC inputs, trailing financials, ...) is a shared fact edited once on Base and inherited read-only on Bull/Bear. Ten Cap has no scenario-specific input, so it's always a single value regardless of tab.
- **Save** stores all three scenarios keyed by ticker, overwriting any prior save for that ticker

### 📊 Sensitivity grids

Each method that has real judgment-call inputs gets its own grid, right on the calculator form, updating live as you type:

- **DCF** — WACC × years 1–5 growth
- **Graham** — AAA bond yield × expected EPS growth
- **Ten Cap** — maintenance-capex split × how far reported capex might swing from what's on the filing

Every grid shows fair value across a small, fixed range of that method's key assumptions instead of one point estimate, and marks two cells: the one nearest your actual current inputs, and the one whose value lands closest to today's price — roughly, what the market is implicitly assuming right now. (WACC alone doesn't get a grid — it has no second independent assumption to pair it with, and DCF's own grid already covers it.)

### 🗂️ Saved valuations table

- One row per saved ticker; DCF and Graham each split into Bear/Base/Bull sub-columns, alongside Ten Cap's IV/MoS/yield, current price, and last-updated date
- Sortable columns, pagination, and clicking a row opens it for editing; Delete removes the row (with confirmation)
- Two charts per page of stocks: margin of safety by method (one bar per method off Base, with a whisker marking the Bear-to-Bull spread where scenarios diverge), and Ten Cap yield vs. bond yield

### 🔗 Research links (optional)

Off by default (**Settings → Optional features → Link research notes**). When enabled, each row gets a Research link pointing at a vault note — nothing about that note's contents, headings, or frontmatter is read or required; it's a bare pointer, the same as a bookmark. From an unlinked row, **Link note** opens a menu to either pick any existing file in the vault (no naming convention required for a note you already have) or create a new, blank one named `TICKER-research.md` in the folder you configure — asks for confirmation first, and refuses (with an error) rather than silently overwriting if a file with that name already exists. Removing a link (the unlink icon) also asks for confirmation, and only clears the pointer; the note itself is untouched. The link is preserved across edits to that valuation, and across toggling the feature off and back on — the only way a link goes away for good is removing it explicitly, or deleting the row it's on.

### 🗒️ Vault summary note

Every save/delete regenerates a markdown table of all saved valuations at a location you configure in Settings (default `Stock Valuations/Stock Valuations.md`). It's the vault-visible mirror of the plugin's own data — rewritten in full on every change, so don't hand-edit it; edits there won't persist. DCF and Graham each get a Bear/Base/Bull column (IV and MoS packed into one cell, e.g. `$164/-33%`); Ten Cap has no scenario-specific input, so it's a single column. It includes a **Research** column (a link) when research links are enabled above.

### ❓ Help & methodology

A built-in documentation screen, opened via the **Help** button in the table header or the **Open help & methodology** command. It covers, for each of the four methods: the formula, its source(s), and explicit "does this method fit?" guidance — none of the four suits every company, and it's on you to judge fit before trusting a number. It also lists standard valuation methods the plugin doesn't compute (DDM, EPV, RIM, NAV, SOTP, comparable company analysis) for when none of the four apply well. Opens with a disclaimer: this is a calculator, not investing advice.

## ⚙️ Settings

| Setting | Description |
|---|---|
| Vault summary note path | Where the auto-generated summary table is written; parent folders are created automatically |
| Default money scale | Pre-fills the unit dropdown for dollar figures (debt, market cap, FCF, OCF, capex, interest expense, net debt) |
| Default share count scale | Pre-fills the unit dropdown for diluted shares outstanding |
| Risk-free rate (%) | 10-year US Treasury yield, pre-filled into new calculations |
| Market risk premium (%) | Pre-filled into new calculations |
| Tax rate (%) | Effective tax rate, used as the WACC after-tax cost of debt default |
| Maintenance capex (%) | Default share of total capex treated as maintenance vs. growth capex, for Ten Cap |
| AAA corporate bond yield (%) | Default for the Graham formula |
| Link research notes | Off by default. Adds the Research link column/cell described above; the first entry under **Optional features**, a home for future opt-in additions |
| Research notes folder | Vault folder new research notes are created in. Required to activate the row above — has no default, and left blank the Research column stays hidden |

All rates are stored and entered as percentages (`4` means `4%`); the calculators divide by 100 internally. Everything here is a *default* — per-stock numbers (beta, EPS, shares, debt, price, growth rates, ...) are always entered fresh for each valuation and can override any default.

## 📥 Installation

**From within Obsidian:** Settings → Community plugins → Browse, search "Stock Valuations", and install.

**Manual:**

1. Download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/fernanluyano/obs-stock-valuations/releases)
2. Copy them into `<your vault>/.obsidian/plugins/stock-valuations/`
3. Reload Obsidian and enable **Stock Valuations** under Settings → Community plugins

## 📄 License

MIT
