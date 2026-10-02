# 📈 Stock Valuations

An [Obsidian](https://obsidian.md) plugin that calculates a stock's intrinsic value using five classic valuation methods, and keeps the results in your vault.

Open it from the ribbon icon (🏛️ landmark icon) or the **Open calculator** command. This opens a dedicated view with a saved-valuations table; **+ New valuation** opens the calculator form, and **Help** opens the built-in help/methodology screen.

## ✨ Features

### 🧮 Valuation methods

All five methods run from a single form and are computed together every time an input changes.

- **WACC** — weighted average cost of capital, used as the DCF's discount rate.
- **DCF** — a 10-year, two-stage free cash flow projection, discounted back to a present value. Also runs a **reverse DCF** alongside it: solving backward from today's price for the years 1–5 growth rate the market is already assuming (every other DCF input held fixed) — a gut check on whether that implied growth is realistic, without debating the forward growth/WACC assumptions directly.
- **Graham Formula** — Benjamin Graham's classic valuation formula based on earnings and growth.
- **Ten Cap** — values a business's owner earnings at a 10x multiple, plus the owner-earnings yield at the current price.
- **DDM (dividend discount model)** — **dividend payers only.** The Gordon Growth formula, D₁ ÷ (kₑ − g): next year's dividend divided by cost of equity minus dividend growth. Discounts at cost of equity (CAPM, from the same inputs WACC uses), not WACC, since dividends go only to shareholders. Shows "—" for a company that doesn't pay a dividend, or when growth is at or above cost of equity. Dividend growth is a Bull/Base/Bear input; dividends per share can be fetched from SEC EDGAR.- **Payback Time** — Phil Town's years-to-recoup metric: how many years of growing FCF it takes to add up to enterprise value (market cap + net debt), undiscounted. FCF compounds at each scenario's own DCF growth stages (years 1–5, 6–10, then terminal growth), so Bull/Base/Bear each get their own number. Not a fair value — a years figure, capped at 30, colored green at ≤ 8 years (Town's buy rule), yellow up to 10, red beyond.

Each method also reports a **margin of safety** — how far below intrinsic value the current price trades, as a %. The results panel splits these into two tables: **Margin of safety** (DCF/Graham/Ten Cap/DDM — the methods that actually have a fair value and a MoS to show) and **Other metrics** (WACC, cost of equity, reverse DCF's implied growth, Ten Cap's owner-earnings yield, Payback Time — real numbers, but not a valuation with a MoS of their own; a `?` icon next to a metric's name explains it). Open the built-in Help screen (below) for the exact formula behind each method and honest guidance on when it does and doesn't apply.

### 📝 Calculator form

- Live price lookup by ticker via Yahoo Finance; price and EPS are always entered as actual per-share dollars, never scaled
- Per-field help tooltips (the `?` button next to each input)
- A configurable **input scale** (ones/thousands/millions/billions) applied separately to money figures (debt, FCF, OCF, capex, market cap, ...) and to share counts — so you can key in numbers exactly as a filing reports them, without doing the unit math yourself
- **🐂 Bull / Base / 🐻 Bear scenario tabs** — DCF, Graham, and DDM project three growth scenarios side by side, each independently editable; every other field (price, shares, WACC inputs, trailing financials, ...) is a shared fact edited once on Base and inherited read-only on Bull/Bear. Ten Cap has no scenario-specific input, so it's always a single value regardless of tab.
- **Save** stores all three scenarios keyed by ticker, overwriting any prior save's current values — a timestamped snapshot is also appended to that ticker's history (see **Valuation history** below), never overwritten

### 📊 Sensitivity grids

Each method that has real judgment-call inputs gets its own grid, right on the calculator form, updating live as you type:

- **DCF** — WACC × years 1–5 growth
- **Graham** — AAA bond yield × expected EPS growth
- **Ten Cap** — maintenance-capex split × how far reported capex might swing from what's on the filing
- **DDM** — cost of equity × dividend growth (cells where growth is at or above cost of equity show "—")

A grid only appears once at least one of Bull/Base/Bear has a fair value for that method — so a method you haven't filled in yet, or a non-payer's DDM, doesn't show an empty grid (and the whole Sensitivity section stays hidden until some method has a value). Every grid shows fair value across a small, fixed range of that method's key assumptions instead of one point estimate, and marks two cells: the one nearest your actual current inputs, and the one whose value lands closest to today's price — roughly, what the market is implicitly assuming right now. (WACC alone doesn't get a grid — it has no second independent assumption to pair it with, and DCF's own grid already covers it.)

### 🗂️ Saved valuations table

- One row per saved ticker; DCF, Graham, and DDM each split into Bear/Base/Bull sub-columns (DDM shows "—" for non-payers), alongside Reverse DCF, Ten Cap's IV/MoS/yield, current price, and last-updated date
- Sortable columns, pagination, and clicking a row opens it for editing; Delete removes the row (with confirmation)
- Two charts per page of stocks: margin of safety by method (one bar per method off Base, with a whisker marking the Bear-to-Bull spread where scenarios diverge), and Ten Cap yield vs. bond yield

### 📈 Valuation history

Every explicit Save, and every price refresh (the table's "Refresh prices" button), appends a timestamped snapshot (price, DCF/Graham/DDM Bear/Base/Bull, Ten Cap, Reverse DCF) to that ticker's own history — a second table, paginated and sortable just like the saved-valuations table, at the bottom of that ticker's calculator form, along with a "fair value vs. price" chart per scenario. A refresh only ever moves price and what's derived from it (margin of safety, DCF IV) — never fundamentals — but that's exactly what this timeline exists to track. More than one Save or refresh on the same calendar day replaces that day's entry instead of piling up duplicates, and the header shows the date range (oldest to newest entry) at a glance.

The point is answering a value-trap question the current-state view can't: has this ticker actually looked cheap for a long stretch and never re-rated, or is a big margin of safety brand new? History only accrues going forward — there's no way to build it backwards, so a ticker saved before this feature existed starts with an empty table and fills in from your next Save or refresh on. Delete any entry (with confirmation) if it was a mistake, or use **Compact history** (also confirmed) to collapse everything older than ~6 months down to one entry per calendar month, keeping years of regular saves/refreshes from growing the file without bound. The saved-valuations table always reflects the latest save only; the full history is what each ticker's vault history note (below) mirrors.

### 🔗 Research links (optional)

Off by default (**Settings → Optional features → Link research notes**). When enabled, each row gets a Research link pointing at a vault note — nothing about that note's contents, headings, or frontmatter is read or required; it's a bare pointer, the same as a bookmark. From an unlinked row, **Link note** opens a menu to either pick any existing file in the vault (no naming convention required for a note you already have) or create a new, blank one named `TICKER-research.md` in the folder you configure — asks for confirmation first, and refuses (with an error) rather than silently overwriting if a file with that name already exists. Removing a link (the unlink icon) also asks for confirmation, and only clears the pointer; the note itself is untouched. The link is preserved across edits to that valuation, and across toggling the feature off and back on — the only way a link goes away for good is removing it explicitly, or deleting the row it's on.

### 🗒️ Vault history notes

Each saved ticker gets its own note, `TICKER-history.md` (e.g. `ADBE-history.md`), in a folder you configure in Settings (default `Stock Valuations`). It holds that ticker's whole valuation history as a markdown table — one row per saved valuation or price refresh (at most one per day, same as the history table above), newest first, with price, DCF/Graham/DDM Bear/Base/Bull, Ten Cap, and Reverse DCF. IV and MoS are packed into one cell (e.g. `$164/-33%`), with MoS measured against that row's own price.

Only the ticker that changed is ever rewritten: saving ADBE rewrites `ADBE-history.md` and nothing else; **Refresh prices** rewrites the note of each ticker whose price it actually updated; deleting or compacting history rewrites that ticker's note. A note is first written the next time its ticker is saved or refreshed — nothing is written in bulk. Each note is a mirror of the plugin's own data, rewritten in full when its ticker changes, so don't hand-edit it; edits there won't persist. Deleting a ticker's valuation leaves its history note in place as a record — remove it yourself if you don't want it.

> **Upgrading from 0.x?** This replaces the single all-tickers summary note (`Stock Valuations/Stock Valuations.md` by default). That note is no longer updated, but it's left exactly as it was — delete it whenever you like. If you'd customized its path, history notes go in that same folder.

### ❓ Help & methodology

A built-in documentation screen, opened via the **Help** button in the table header or the **Open help & methodology** command. It covers, for each of the five methods (and Payback Time): the formula, its source(s), and explicit "does this method fit?" guidance — none of them suits every company (the DDM, for one, only applies to dividend payers), and it's on you to judge fit before trusting a number. It also lists standard valuation methods the plugin doesn't compute (EPV, RIM, NAV, SOTP, comparable company analysis) for when none of the five apply well. Opens with a disclaimer: this is a calculator, not investing advice.

## ⚙️ Settings

| Setting | Description |
|---|---|
| History notes folder | Where each ticker's auto-generated `TICKER-history.md` note is written; folders are created automatically, and blank means the vault root. Changing it doesn't move notes already written |
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
