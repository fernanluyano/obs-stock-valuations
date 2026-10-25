// Hand-maintained "What's new" copy, one entry per released version — same
// manual-upkeep approach as docs.ts. Add a new entry (newest first) whenever
// a version is released via `make release`; nothing here bumps itself.
export interface ChangelogEntry {
	version: string;
	highlights: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
	{
		version: "2.1.0",
		highlights: [
			"🎯 New optional \"Your position\" section on the calculator form: type your average entry price and the date it applies from. It's one value shared by Bull/Base/Bear, entered by hand, and saved in the ticker's note (avgEntry / entryDate)",
			"📈 The \"Fair value vs. price\" charts now draw your entry as a dashed line from the entry date on, so you can see how far or close price and fair value are to where you bought. It's recomputed each time the charts draw — nothing extra is stored in the history",
			"🔍 Each \"Fair value vs. price\" chart now has a zoom icon that opens it in a larger window, where you can click the legend to hide or show lines — useful when one method's fair value dwarfs the rest",
			"🧮 New PEG ratio in the form's Other metrics: (price ÷ EPS) ÷ your expected EPS growth, per scenario. Green at 1 or below, yellow up to 2, red beyond; \"—\" when EPS or growth isn't positive. It uses the same growth input as Graham",
			"📋 The form's Margin of safety table gains a \"MoS @ entry\" column — was your cost basis a good price, not just today's?",
		],
	},
	{
		version: "2.0.2",
		highlights: [
			"🐛 Fixed the plugin showing no valuations after closing and reopening the app, mainly on mobile. It read your notes before Obsidian had finished indexing the vault, so it found none until the plugin was reloaded. It now waits for the vault to be ready, and shows \"Loading valuations…\" until then. Your notes were never affected and nothing needs repairing",
		],
	},
	{
		version: "2.0.1",
		highlights: [
			"🐛 Fixed the date range under \"Valuation history\" showing backwards (newest → oldest) after the plugin reloaded. Only that label was affected — your notes, the history table, the charts and everything saved were always correct, and nothing needs repairing",
		],
	},
	{
		version: "2.0.0",
		highlights: [
			"💾 Breaking: your valuations and settings now live in your vault as Markdown notes instead of the plugin's data.json. Each ticker has its own note, TICKER.md (e.g. ADBE.md), holding every Bull/Base/Bear input and the whole valuation history; Settings.md holds your settings. Remove the plugin and reinstall it and everything comes back from those notes — keep the folder (Settings → \"Notes folder\", default Stock Valuations). data.json now only caches market data",
			"🔁 Upgrading is automatic and runs once on first start: every saved ticker is written to a note, Settings.md is written last as the completion marker, and nothing existing is overwritten (an existing file named TICKER.md is left alone and the ticker gets TICKER (valuation).md instead). Your old TICKER-history.md files are left exactly as they were and are no longer updated — delete them whenever you like. Versions before 2.0 can't read the new notes, so don't downgrade",
			"🗑️ Deleting a ticker now moves its note to Obsidian's trash (the note is your data, so leaving it would bring the ticker back). Changing the notes folder doesn't move any notes — it just loads from the new folder. The notes are written by the plugin: a note whose history table has a row the plugin can't read is reported and left untouched rather than overwritten",
			"🎚️ New \"Bulk edit\" button on the saved-valuations table — change the market risk premium (MRP) for several tickers at once. Pick the tickers (all selected by default), enter a value, and it's applied to every Bull/Base/Bear case of each one and recalculated. A blank field leaves each ticker's value alone, and company-specific inputs (beta, growth, tax rate, ...) can't be bulk edited. Each updated ticker also gets a Valuation history entry",
			"🏦 The AAA corporate bond yield (Graham's Y) is now fetched automatically, like the risk-free rate — Moody's Seasoned Aaa yield from FRED, cached for 24 hours. New valuations are pre-filled with it, \"Fetch data\" fills it into a blank field, and \"Refresh prices\" force-refreshes it across every saved ticker (so it now moves Graham values too). The Settings entry is gone; tickers saved earlier keep their old value until the next \"Refresh prices\"",
		],
	},
	{
		version: "1.1.0",
		highlights: [
			"🃏 The Macro screen's numbers are now cards with a colored top edge and a status pill (CHEAP / FAIR / EXPENSIVE, LOW / ELEVATED / HIGH, NORMAL / FLAT / INVERTED, and so on) instead of plain figures. Each card's \"?\" help spells out its color cut points. TR-CAPE and dividend yield stay uncolored — there are no agreed cut points for them",
			"📉 New Treasury yield curve chart: today's curve across 3-month, 5-year, 10-year, and 30-year maturities, with the same curve from a year ago as a dashed line. Normally it slopes up; if the left side sits above the right, the curve is inverted",
			"📏 New 10y − 3M spread — a card plus a 10-year chart with a dashed zero line. Below zero the curve is inverted, which has preceded most US recessions",
			"🛢️ New VIX, gold, silver, and crude oil cards, each with its move over the last 5 trading days. VIX and oil are colored by level; gold and silver by how fast they've moved over those 5 days",
			"🔁 The 10-year Treasury yield on the Macro screen now comes live from Yahoo Finance (^TNX), the same source as the risk-free rate, instead of Shiller's monthly figure. The old \"10y yield over time\" chart is gone, replaced by the yield curve and spread charts. Everything from Yahoo is cached for 24 hours",
			"👀 On the Bull, Base, and Bear tabs, each growth assumption (FCF growth yrs 1-5 and 6-10, terminal growth, EPS growth, dividend growth) now shows the other two cases' values right under its label, so you can compare while editing without switching tabs",
		],
	},
	{
		version: "1.0.0",
		highlights: [
			"🎉 1.0 — the plugin's been tested enough to call it stable",
			"🗒️ The single all-tickers summary note is replaced by one note per ticker — TICKER-history.md (e.g. ADBE-history.md) holds that ticker's whole valuation history, one row per saved valuation or price refresh, newest first. Only the ticker that changed is rewritten, instead of every ticker on every save. A ticker's note first appears the next time you save or refresh it. The old summary note is no longer updated but is left untouched — delete it whenever you like. Settings → \"History notes folder\" (default: the folder your summary note was in) sets where they go",
			"⏳ New \"Payback Time\" row in the results panel's Other metrics table, right below Ten Cap's owner-earnings yield — Phil Town's years-to-recoup metric: how many years of growing FCF it takes to add up to enterprise value (market cap + net debt). FCF compounds at each scenario's own DCF growth rates (years 1–5, 6–10, then terminal growth), so Bull/Base/Bear each get their own number. Colored green at 8 years or less (Town's buy rule), yellow up to 10, red beyond; see Help for the full method and its caveats",
			"💵 New DDM (dividend discount model) method, for dividend payers only — D₁ ÷ (kₑ − g), discounted at cost of equity (now shown in Other metrics) rather than WACC. Dividend growth is a Bull/Base/Bear input, and \"Fetch data\" fills in trailing dividends per share from SEC EDGAR. Non-payers show \"—\". Shows up everywhere DCF and Graham do: Bear/Base/Bull columns in the saved-valuations table, the margin-of-safety charts, and valuation history (table, chart, and history note)",
			"📊 New DDM sensitivity grid (cost of equity × dividend growth). Every sensitivity grid now only appears once at least one case has a fair value for that method, instead of showing an empty grid",
			"🔧 Bull/Bear results now update live when you edit a shared field on Base — previously they only caught up on Save, so the margin-of-safety chart could lag behind what you'd typed",		],
	},
	{
		version: "0.10.0",
		highlights: [
			"📊 New \"Macro\" screen — Shiller CAPE, TR-CAPE, dividend yield, and 10-year Treasury yield as of the latest month, plus three charts: CAPE/TR-CAPE over time, 10-year yield over time (both over a rolling 40-year window), and S&P 500 nominal vs. inflation-adjusted over the last 10 years. No cheap/fair/expensive verdict — just the numbers and the history, left for you to judge",
			"🔁 Risk-free rate (RFR) is no longer a Settings default — it's now fetched live from Yahoo Finance (^TNX) and cached for 24 hours, the same as price. \"Refresh prices\" force-refreshes it across every saved ticker, and \"Fetch data\" fills it the same way as any other auto-fillable field",
		],
	},
	{
		version: "0.9.0",
		highlights: [
			"🔁 \"Refresh prices\" now also records a Valuation history entry per ticker, not just an explicit Save — a refresh only ever moves price and what's derived from it (MoS, IV), but that's exactly what this timeline exists to track. Same same-day dedup and 6-month compaction apply, so refreshing repeatedly in one sitting still only keeps one entry per day",
			"🗓️ The Valuation history section now shows its date range (oldest to newest entry) under the header",
			"〰️ Smoothed out the \"Fair value vs. price\" chart lines for an easier-to-read trend",
		],
	},
	{
		version: "0.8.0",
		highlights: [
			"🔁 New \"Reverse DCF (implied growth)\" row in the results panel's Other metrics table — solves backward from today's price for the flat FCF growth rate the market is already assuming, a quick gut check against the company's own growth history and guidance",
			"📈 New \"Valuation history\" table on the calculator form — every explicit Save (never a price-only refresh) appends a timestamped snapshot, so you can see whether a ticker has actually looked cheap for a long stretch and never re-rated, or whether a big margin of safety is brand new. Paginated and sortable like the main table; delete a mistaken entry or compact everything older than 6 months down to one entry per month, both with confirmation",
			"🔁 Reverse DCF (implied growth) is now also its own column in the saved-valuations table and the vault summary note, not just the results panel",
		],
	},
	{
		version: "0.7.1",
		highlights: [
			"🔧 Fixed a plugin-review lint failure (direct style assignments instead of Obsidian's CSS helpers)",
			"📊 The ticker form now has its own margin-of-safety chart — Bull/Base/Bear bars per method, always showing all three cases at once instead of just whichever scenario tab is active",
			"🎯 Sensitivity grids now mark all three scenarios' current inputs at once, each in its own color (stacking as rings when they land on the same cell), instead of only the active tab's",
			"📉 Swapped the table's old per-ticker margin-of-safety chart (now redundant with the ticker form's own chart and the table's DCF/Graham/Ten Cap columns) for a margin-of-safety distribution chart — how many tickers fall into each range, broken out by method — shown side by side with the Ten Cap yield spread chart",
			"⏰ New stale-price tracking — a badge counts tickers that haven't been refreshed in 7+ days (click it to sort oldest first), and their Price cell is highlighted the same way",
		],
	},
	{
		version: "0.7.0",
		highlights: [
			"📊 The ticker form now has its own margin-of-safety chart — Bull/Base/Bear bars per method, always showing all three cases at once instead of just whichever scenario tab is active",
			"🎯 Sensitivity grids now mark all three scenarios' current inputs at once, each in its own color (stacking as rings when they land on the same cell), instead of only the active tab's",
			"📉 Swapped the table's old per-ticker margin-of-safety chart (now redundant with the ticker form's own chart and the table's DCF/Graham/Ten Cap columns) for a margin-of-safety distribution chart — how many tickers fall into each range, broken out by method — shown side by side with the Ten Cap yield spread chart",
			"⏰ New stale-price tracking — a badge counts tickers that haven't been refreshed in 7+ days (click it to sort oldest first), and their Price cell is highlighted the same way",
		],
	},
	{
		version: "0.6.0",
		highlights: [
			"📊 New sensitivity grids for DCF (WACC × growth yrs 1-5), Graham (AAA yield × EPS growth), and Ten Cap (maintenance-capex split × how far reported capex might swing) — see fair value across a range of assumptions instead of one point estimate, with the cell nearest your current inputs and the cell closest to today's price both marked",
		],
	},
	{
		version: "0.5.2",
		highlights: [
			"📱💻 Polished up the valuations table's layout — columns now size themselves sensibly instead of one stretching oddly wide, on both mobile and desktop",
			"🐂🐻 DCF and Graham's Bear/Bull figures are now clearly labeled (e.g. \"Graham Bear\") so there's no mixing them up when a narrow screen tucks them into a row's expandable details",
		],
	},
	{
		version: "0.5.0",
		highlights: [
			"🐂🐻 Bull/Base/Bear scenario tabs — DCF and Graham now project three growth scenarios side by side; shared facts (price, shares, WACC inputs, etc.) stay in sync across all three automatically, and Ten Cap (which has no scenario-specific input) stays a single value",
			"⚡ The saved-valuations table is now sortable (click any column header), paginated, and clicking a row opens it for editing; DCF and Graham each split into Bear/Base/Bull sub-columns",
			"📊 Margin-of-safety chart redesigned: one bar per method off the Base scenario, with a thin whisker marking the Bear-to-Bull spread wherever a ticker's scenarios diverge",
		],
	},
	{
		version: "0.4.0",
		highlights: [
			'🔄 New "Refresh prices" button on the table — updates every ticker\'s price in one click, and the vault summary note along with it',
			"🧮 Market cap is now always computed as price × shares, so it — and WACC, and DCF IV — stay accurate automatically instead of needing a manual edit",
			"📱 Fixed action icons (edit, delete, research links) not rendering on mobile",
			"✨ This \"What's new\" screen — shows once after an update, same as what you're reading right now",
		],
	},
	{
		version: "0.3.0",
		highlights: [
			"🔗 Link a research note to any ticker straight from the table",
			"⚙️ Release automation and a CI test step, so every release is tested before it ships",
		],
	},
	{
		version: "0.2.1",
		highlights: [
			"📊 The margin-of-safety chart now caps at −100% and stays centered on zero, so one outlier ticker can't blow out the scale for the rest",
		],
	},
	{
		version: "0.2.0",
		highlights: [
			'📥 "Fetch data" now pulls fundamentals (EPS, cash flow, debt, shares, tax rate) from SEC EDGAR, alongside price from Yahoo Finance',
			"✨ Various calculator UI improvements",
		],
	},
	{
		version: "0.1.3",
		highlights: ["🐛 Fixed a compatibility issue opening the calculator on older Obsidian versions"],
	},
	{
		version: "0.1.2",
		highlights: ["🐛 Fixed remaining community-plugin health-check issues"],
	},
	{
		version: "0.1.1",
		highlights: ["📝 Cleaned up the plugin description for the community plugin directory"],
	},
	{
		version: "0.1.0",
		highlights: [
			"🎉 Initial release — WACC, DCF, Graham, and Ten Cap intrinsic value calculators, tracked in a vault summary note",
		],
	},
];

export function getChangelogEntry(version: string): ChangelogEntry | undefined {
	return CHANGELOG.find((e) => e.version === version);
}
