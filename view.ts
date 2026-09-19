import { App, ItemView, Modal, Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import {
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	ChartData,
	LinearScale,
	Legend,
	LineController,
	LineElement,
	LogarithmicScale,
	PointElement,
	ScatterController,
	Tooltip,
} from "chart.js";
import type StockValuationsPlugin from "./main";
import {
	calcDcf,
	calcGraham,
	calcTenCap,
	calcWacc,
	marginOfSafety,
	ownerEarningsYield,
} from "./calculations";
import { SCALE_LABELS, SCALE_MULTIPLIERS, SCALE_OPTIONS, ScaleUnit } from "./units";
import { fetchQuotePrice } from "./priceProvider";
import { formatCurrency, formatPercent, formatWithCommas, sanitizeNumericInput } from "./format";
import { HELP_TEXT } from "./helpText";
import { FormState, Results, SavedValuation } from "./valuationStore";
import { DOCS_INTRO, DOCS_OTHER_INTRO, METHOD_DOCS, OTHER_METHODS } from "./docs";

Chart.register(
	BarController,
	BarElement,
	CategoryScale,
	LinearScale,
	LogarithmicScale,
	LineController,
	LineElement,
	PointElement,
	ScatterController,
	Legend,
	Tooltip
);

export const VIEW_TYPE_STOCK_VALUATIONS = "stock-valuations-view";

// Fixed per-method colors — consistent across tickers and across both charts
// so method disagreement (not just direction) reads at a glance. Independent
// of light/dark theme.
const METHODS = [
	{ label: "DCF", color: "#4c8bf5", mosKey: "dcfMos", ivKey: "dcfIv" },
	{ label: "Graham", color: "#f2a541", mosKey: "grahamMos", ivKey: "grahamIv" },
	{ label: "Ten Cap", color: "#8d6fd1", mosKey: "tenCapMos", ivKey: "tenCapIv" },
] as const satisfies { label: string; color: string; mosKey: keyof Results; ivKey: keyof Results }[];
const AVERAGE_COLOR = "#94a3b8";
const PRICE_COLOR = "#e5484d";

type Screen = "table" | "form" | "docs";

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });

		const buttonRow = this.contentEl.createDiv({ cls: "sv-modal-buttons" });
		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const confirmBtn = buttonRow.createEl("button", { text: "Delete", cls: "mod-warning" });
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class StockValuationsView extends ItemView {
	private static readonly MONEY_KEYS = new Set<keyof FormState>([
		"intExp",
		"totDebt",
		"mktCap",
		"netDebt",
		"fcf",
		"ocf",
		"capex",
	]);
	private static readonly SHARE_KEYS = new Set<keyof FormState>(["shares"]);
	private static readonly PERCENT_KEYS = new Set<keyof FormState>([
		"rfr",
		"mrp",
		"taxRate",
		"growth1to5",
		"growth6to10",
		"terminalGrowth",
		"grahamGrowth",
		"aaaYield",
		"mainPct",
	]);

	private plugin: StockValuationsPlugin;
	private screen: Screen = "table";

	private state!: FormState;
	private moneyScale!: ScaleUnit;
	private sharesScale!: ScaleUnit;
	private moneyHintEls: HTMLElement[] = [];
	private sharesHintEls: HTMLElement[] = [];
	private results!: Results;
	private resultsEl!: HTMLElement;
	private heroTickerEl!: HTMLElement;
	private heroPriceEl!: HTMLElement;
	private charts: Chart[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: StockValuationsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.resetForm();
	}

	getViewType(): string {
		return VIEW_TYPE_STOCK_VALUATIONS;
	}

	getDisplayText(): string {
		return "Stock valuations";
	}

	getIcon(): string {
		return "landmark";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.destroyChart();
		this.contentEl.empty();
	}

	// ---------------------------------------------------------------------
	// Screen management
	// ---------------------------------------------------------------------

	private render(): void {
		this.destroyChart();
		const root = this.contentEl;
		root.empty();
		root.addClass("stock-valuations-view");

		if (this.screen === "table") {
			this.renderTable(root);
		} else if (this.screen === "docs") {
			this.renderDocs(root);
		} else {
			this.renderForm(root);
		}
	}

	private resetForm(): void {
		const s = this.plugin.settings;
		this.moneyScale = s.defaultMoneyScale;
		this.sharesScale = s.defaultSharesScale;
		this.moneyHintEls = [];
		this.sharesHintEls = [];
		this.state = {
			ticker: "",
			price: "",
			shares: "",

			rfr: String(s.riskFreeRate),
			mrp: String(s.marketRiskPremium),
			beta: "",
			intExp: "",
			totDebt: "",
			taxRate: String(s.taxRate),
			mktCap: "",

			netDebt: "",
			growth1to5: "",
			growth6to10: String(s.terminalGrowthRate),
			terminalGrowth: String(s.terminalGrowthRate),
			fcf: "",

			eps: "",
			grahamGrowth: "",
			aaaYield: String(s.aaaBondYield),

			ocf: "",
			capex: "",
			mainPct: String(s.maintenanceCapexPct),
		};
	}

	private loadIntoForm(ticker: string): void {
		const saved = this.plugin.valuations[ticker];
		if (!saved) return;
		this.state = { ...saved.state };
		this.moneyScale = saved.moneyScale;
		this.sharesScale = saved.sharesScale;
		this.results = { ...saved.results };
		this.moneyHintEls = [];
		this.sharesHintEls = [];
	}

	private newValuation(): void {
		this.resetForm();
		this.screen = "form";
		this.render();
	}

	private editValuation(ticker: string): void {
		this.loadIntoForm(ticker);
		this.screen = "form";
		this.render();
	}

	private deleteValuation(ticker: string): void {
		new ConfirmModal(this.app, `Delete the saved valuation for ${ticker}?`, () => {
			delete this.plugin.valuations[ticker];
			void this.plugin.saveValuations();
			this.render();
		}).open();
	}

	private backToTable(): void {
		this.screen = "table";
		this.render();
	}

	openDocs(): void {
		this.screen = "docs";
		this.render();
	}

	private saveValuation(): void {
		const ticker = this.state.ticker.trim().toUpperCase();
		if (!ticker) {
			new Notice("Enter a ticker first.");
			return;
		}
		this.state.ticker = ticker;
		this.recalculate();

		const record: SavedValuation = {
			state: { ...this.state },
			moneyScale: this.moneyScale,
			sharesScale: this.sharesScale,
			results: { ...this.results },
			updatedAt: Date.now(),
		};
		this.plugin.valuations[ticker] = record;
		void this.plugin.saveValuations();
		new Notice(`Saved ${ticker}.`);
		this.screen = "table";
		this.render();
	}

	// ---------------------------------------------------------------------
	// Table screen — the plugin's own version of the spreadsheet. Rows are
	// only ever added/edited through the form below, never hand-edited here.
	// ---------------------------------------------------------------------

	private renderTable(root: HTMLElement): void {
		const header = root.createDiv({ cls: "sv-table-header" });
		header.createEl("h2", { text: "Stock valuations" });

		const headerActions = header.createDiv({ cls: "sv-header-actions" });
		const docsBtn = headerActions.createEl("button", { cls: "sv-docs-btn" });
		setIcon(docsBtn.createSpan({ cls: "sv-docs-btn-icon" }), "help-circle");
		docsBtn.createSpan({ text: "Help" });
		setTooltip(docsBtn, "Help & methodology");
		docsBtn.addEventListener("click", () => this.openDocs());

		const newBtn = headerActions.createEl("button", { text: "+ New valuation", cls: "mod-cta" });
		newBtn.addEventListener("click", () => this.newValuation());

		const tickers = Object.keys(this.plugin.valuations).sort();
		if (tickers.length === 0) {
			root.createEl("p", {
				cls: "sv-empty-state",
				text: "No valuations saved yet. Click “+ New valuation” to add one.",
			});
			return;
		}

		const wrap = root.createDiv({ cls: "sv-table-wrap" });
		const table = wrap.createEl("table", { cls: "sv-main-table" });
		const head = table.createEl("tr");
		[
			"Symbol",
			"DCF MoS",
			"DCF IV",
			"Ten Cap MoS",
			"Ten Cap IV",
			"Ten Cap Yield",
			"Graham MoS",
			"Graham IV",
			"Price",
			"Updated",
			"",
		].forEach((h) => head.createEl("th", { text: h }));

		for (const ticker of tickers) {
			const saved = this.plugin.valuations[ticker];
			const r = saved.results;
			const price = parseFloat(saved.state.price) || 0;

			const tr = table.createEl("tr", { cls: "sv-table-row" });
			tr.addEventListener("click", () => this.editValuation(ticker));

			tr.createEl("td", { text: ticker, cls: "sv-symbol-cell" });
			this.mosCell(tr, r.dcfMos);
			tr.createEl("td", { text: formatCurrency(r.dcfIv), cls: "sv-num" });
			this.mosCell(tr, r.tenCapMos);
			tr.createEl("td", { text: formatCurrency(r.tenCapIv), cls: "sv-num" });
			tr.createEl("td", { text: formatPercent(r.tenCapYield), cls: "sv-num" });
			this.mosCell(tr, r.grahamMos);
			tr.createEl("td", { text: formatCurrency(r.grahamIv), cls: "sv-num" });
			tr.createEl("td", { text: formatCurrency(price), cls: "sv-num" });
			tr.createEl("td", {
				text: window.moment(saved.updatedAt).format("YYYY-MM-DD"),
				cls: "sv-num sv-updated-cell",
			});

			const actionsCell = tr.createEl("td", { cls: "sv-actions-cell" });
			const editBtn = actionsCell.createEl("button", { cls: "sv-icon-btn" });
			setIcon(editBtn, "pencil");
			setTooltip(editBtn, "Edit");
			editBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.editValuation(ticker);
			});

			const deleteBtn = actionsCell.createEl("button", { cls: "sv-icon-btn" });
			setIcon(deleteBtn, "trash-2");
			setTooltip(deleteBtn, "Delete");
			deleteBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deleteValuation(ticker);
			});
		}

		this.renderMosChart(root, tickers);
		this.renderPriceVsValueChart(root, tickers);
	}

	// ---------------------------------------------------------------------
	// Chart 1 — standalone section below the table: one horizontal bar group
	// per ticker, one bar per method (DCF/Graham/Ten Cap MoS%) plus a fourth
	// bar for the ticker's average MoS across the three.
	// ---------------------------------------------------------------------

	private renderMosChart(root: HTMLElement, tickers: string[]): void {
		const section = root.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Margin of safety by method" });

		const wrap = section.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.style.height = `${Math.max(220, tickers.length * 56 + 60)}px`;
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);

		const datasets = METHODS.map((m) => ({
			label: m.label,
			data: tickers.map((t) => {
				const v = this.plugin.valuations[t].results[m.mosKey];
				return isFinite(v) ? v : null;
			}),
			backgroundColor: m.color,
			borderRadius: 3,
		}));

		const averageBar = {
			label: "Average",
			data: tickers.map((t) => {
				const r = this.plugin.valuations[t].results;
				const vals = METHODS.map((m) => r[m.mosKey]).filter((v) => isFinite(v));
				if (vals.length === 0) return null;
				return vals.reduce((a, b) => a + b, 0) / vals.length;
			}),
			backgroundColor: AVERAGE_COLOR,
			borderRadius: 3,
		};

		this.charts.push(
			new Chart(canvas, {
				type: "bar",
				data: { labels: tickers, datasets: [...datasets, averageBar] },
				options: {
					indexAxis: "y",
					responsive: true,
					maintainAspectRatio: false,
					scales: {
						x: {
							title: { display: true, text: "Margin of safety (%)", color: mutedColor },
							grid: { color: borderColor },
							ticks: { color: mutedColor, callback: (v) => `${v}%` },
						},
						y: {
							grid: { display: false },
							ticks: { color: normalColor },
						},
					},
					plugins: {
						legend: { position: "top", labels: { color: mutedColor } },
						tooltip: {
							callbacks: {
								label: (ctx) =>
									`${ctx.dataset.label}: ${ctx.parsed.x === null ? "—" : formatPercent(ctx.parsed.x)}`,
							},
						},
					},
				},
			})
		);
	}

	// ---------------------------------------------------------------------
	// Chart 2 — standalone section below the MoS chart: for each ticker
	// (x-axis, category), a dot per method's IV, a diamond for average IV,
	// and a triangle for current price — so price and IV read off the same
	// vertical line per ticker, compared by height. Y-axis is a dollar value,
	// log-scaled since IV/price can span orders of magnitude across tickers;
	// only strictly-positive values can be plotted on a log scale, so
	// non-positive ones are skipped.
	// ---------------------------------------------------------------------

	private renderPriceVsValueChart(root: HTMLElement, tickers: string[]): void {
		const section = root.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Price vs. fair value" });

		const wrap = section.createDiv({ cls: "sv-chart-canvas-wrap sv-chart-canvas-wrap-fixed" });
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);

		type Point = { x: string; y: number; ticker: string };
		let skipped = 0;

		const datasets = METHODS.map((m) => {
			const data: Point[] = [];
			for (const t of tickers) {
				const iv = this.plugin.valuations[t].results[m.ivKey];
				if (isFinite(iv) && iv > 0) {
					data.push({ x: t, y: iv, ticker: t });
				} else {
					skipped++;
				}
			}
			return {
				label: m.label,
				data,
				backgroundColor: m.color,
				pointRadius: 5,
				pointHoverRadius: 7,
				showLine: false,
			};
		});

		// Average IV per ticker, across the three methods — a normal dataset so
		// it gets the same hover tooltip as the per-method points.
		const averageData: Point[] = [];
		for (const t of tickers) {
			const r = this.plugin.valuations[t].results;
			const ivs = METHODS.map((m) => r[m.ivKey]).filter((v) => isFinite(v) && v > 0);
			if (ivs.length > 0) {
				averageData.push({ x: t, y: ivs.reduce((a, b) => a + b, 0) / ivs.length, ticker: t });
			}
		}
		const averageDataset = {
			label: "Average",
			data: averageData,
			backgroundColor: AVERAGE_COLOR,
			pointStyle: "rectRot" as const,
			pointRadius: 6,
			pointHoverRadius: 8,
			showLine: false,
		};

		// Current price as its own point, at the same ticker category as the IV
		// dots above it — lets price be compared directly against IV by height.
		const priceData: Point[] = [];
		for (const t of tickers) {
			const price = parseFloat(this.plugin.valuations[t].state.price) || 0;
			if (price > 0) {
				priceData.push({ x: t, y: price, ticker: t });
			} else {
				skipped++;
			}
		}
		const priceDataset = {
			label: "Price",
			data: priceData,
			backgroundColor: PRICE_COLOR,
			pointStyle: "triangle" as const,
			pointRadius: 6,
			pointHoverRadius: 8,
			showLine: false,
		};

		this.charts.push(
			new Chart(canvas, {
				type: "scatter",
				// Chart.js's scatter typings assume numeric x — they don't model a
				// category x-axis, which works fine at runtime but not in the types.
				data: {
					labels: tickers,
					datasets: [...datasets, averageDataset, priceDataset] as unknown as ChartData<"scatter">["datasets"],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					scales: {
						x: {
							type: "category",
							labels: tickers,
							grid: { display: false },
							ticks: { color: normalColor },
						},
						y: {
							type: "logarithmic",
							title: { display: true, text: "Value ($, log scale)", color: mutedColor },
							grid: { color: borderColor },
							ticks: { color: mutedColor, callback: (v) => formatCurrency(Number(v), 0) },
						},
					},
					plugins: {
						legend: { position: "top", labels: { color: mutedColor } },
						tooltip: {
							callbacks: {
								title: (items) => (items[0]?.raw as Point | undefined)?.ticker ?? "",
								label: (ctx) => `${ctx.dataset.label}: ${formatCurrency((ctx.raw as Point).y)}`,
							},
						},
					},
				},
			})
		);

		if (skipped > 0) {
			section.createEl("p", {
				cls: "sv-chart-note",
				text: "Some points aren't shown — price and intrinsic value must be positive to plot on a log scale.",
			});
		}
	}

	private chartThemeColors(root: HTMLElement): {
		mutedColor: string;
		normalColor: string;
		borderColor: string;
		faintColor: string;
	} {
		const styles = getComputedStyle(root);
		return {
			mutedColor: styles.getPropertyValue("--text-muted").trim() || "#888888",
			normalColor: styles.getPropertyValue("--text-normal").trim() || "#222222",
			borderColor: styles.getPropertyValue("--background-modifier-border").trim() || "#dddddd",
			faintColor: styles.getPropertyValue("--text-faint").trim() || "#aaaaaa",
		};
	}

	private destroyChart(): void {
		for (const chart of this.charts) chart.destroy();
		this.charts = [];
	}

	private mosCell(row: HTMLElement, mos: number): void {
		const cls = !isFinite(mos) ? "" : mos >= 0 ? "sv-mos-pos" : "sv-mos-neg";
		row.createEl("td", {
			text: isFinite(mos) ? formatPercent(mos) : "—",
			cls: `sv-num ${cls}`.trim(),
		});
	}

	// ---------------------------------------------------------------------
	// Docs screen — methodology, sources, and per-method fit guidance.
	// ---------------------------------------------------------------------

	private renderDocs(root: HTMLElement): void {
		const backRow = root.createDiv({ cls: "sv-back-row" });
		const backBtn = backRow.createEl("button", { text: "← Back to table", cls: "sv-link-btn" });
		backBtn.addEventListener("click", () => this.backToTable());

		const wrap = root.createDiv({ cls: "sv-docs" });
		wrap.createEl("h2", { text: "Help & methodology" });

		const disclaimer = wrap.createDiv({ cls: "sv-docs-disclaimer" });
		disclaimer.createEl("strong", { text: "Not investing advice." });
		disclaimer.createSpan({
			text: " This plugin is a calculator, not a recommendation — it's on you to judge whether its inputs, assumptions, and outputs make sense for a given company. Use it at your own risk.",
		});

		for (const p of DOCS_INTRO) {
			wrap.createEl("p", { text: p, cls: "sv-docs-intro" });
		}

		for (const method of METHOD_DOCS) {
			const section = wrap.createDiv({ cls: "sv-docs-section" });
			section.createEl("h3", { text: method.title });
			section.createEl("pre", { cls: "sv-docs-formula", text: method.formula });
			for (const p of method.body) {
				section.createEl("p", { text: p });
			}

			const fit = section.createDiv({ cls: "sv-docs-fit" });
			fit.createEl("p", { text: "Does this method fit?" , cls: "sv-docs-fit-heading"});
			const fitList = fit.createEl("ul");
			fitList.createEl("li", { text: `Good fit: ${method.goodFor}` });
			fitList.createEl("li", { text: `Use caution: ${method.useCaution}` });

			const sourcesEl = section.createDiv({ cls: "sv-docs-sources" });
			sourcesEl.createSpan({ text: "Sources: " });
			method.sources.forEach((s, idx) => {
				sourcesEl.createEl("a", { text: s.label, href: s.url, cls: "external-link" });
				if (idx < method.sources.length - 1) sourcesEl.createSpan({ text: " · " });
			});
		}

		const otherSection = wrap.createDiv({ cls: "sv-docs-section" });
		otherSection.createEl("h3", { text: "Methods this plugin doesn't compute" });
		otherSection.createEl("p", { text: DOCS_OTHER_INTRO });
		const otherList = otherSection.createEl("ul", { cls: "sv-docs-other-list" });
		for (const m of OTHER_METHODS) {
			const item = otherList.createEl("li");
			item.createEl("a", { text: m.title, href: m.url, cls: "external-link" });
			item.createSpan({ text: ` — ${m.oneLiner}` });
		}
	}

	// ---------------------------------------------------------------------
	// Form screen — add or edit a single ticker's inputs.
	// ---------------------------------------------------------------------

	private renderForm(root: HTMLElement): void {
		const backRow = root.createDiv({ cls: "sv-back-row" });
		const backBtn = backRow.createEl("button", { text: "← Back to table", cls: "sv-link-btn" });
		backBtn.addEventListener("click", () => this.backToTable());

		const hero = root.createDiv({ cls: "sv-hero" });
		const heroMain = hero.createDiv({ cls: "sv-hero-main" });
		this.heroTickerEl = heroMain.createSpan({ cls: "sv-hero-ticker", text: "New valuation" });
		this.heroPriceEl = heroMain.createSpan({ cls: "sv-hero-price", text: "" });

		const unitsRow = root.createDiv({ cls: "sv-units-row" });
		unitsRow.createSpan({ cls: "sv-units-label", text: "Units" });
		this.scaleDropdown(unitsRow, "Money", this.moneyScale, this.moneyHintEls, (v) => {
			this.moneyScale = v;
		});
		this.scaleDropdown(unitsRow, "Shares", this.sharesScale, this.sharesHintEls, (v) => {
			this.sharesScale = v;
		});
		root.createEl("p", {
			cls: "sv-legend",
			text:
				"Money scale applies to dollar aggregates (debt, cash flow, market cap, etc.); Shares scale to the share count. Price and EPS are always actual per-share dollars, never scaled. Fields marked % are percentages — enter 5 for 5%, not 0.05.",
		});

		const layout = root.createDiv({ cls: "sv-layout" });
		const formCol = layout.createDiv({ cls: "sv-form-col" });
		const resultsCol = layout.createDiv({ cls: "sv-results-col" });

		// --- Company section ---
		const company = this.section(formCol, "Company");
		const tickerInput = this.field(company, "Ticker", "ticker", "text");
		const yahooLink = tickerInput.parentElement!.createEl("a", {
			text: "Yahoo Finance ↗",
			cls: "sv-link-btn",
		});
		yahooLink.setAttr("target", "_blank");
		yahooLink.setAttr("rel", "noopener");
		const updateYahooLink = () => {
			const ticker = this.state.ticker.trim();
			yahooLink.toggleClass("sv-hidden", !ticker);
			if (ticker) {
				yahooLink.setAttr("href", `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/financials/`);
			}
		};
		updateYahooLink();

		const priceInput = this.field(company, "Current price", "price", "number", "perShare");
		this.field(company, "Diluted shares outstanding", "shares", "number", "shares");

		const fetchBtn = priceInput.parentElement!.createEl("button", {
			text: "Fetch",
			cls: "sv-link-btn",
		});
		fetchBtn.addEventListener("click", () => {
			void this.fetchPrice(priceInput, fetchBtn, true);
		});
		tickerInput.addEventListener("input", updateYahooLink);
		tickerInput.addEventListener("blur", () => {
			void this.fetchPrice(priceInput, fetchBtn, false);
		});

		// --- WACC section ---
		const wacc = this.section(formCol, "WACC");
		this.field(wacc, "Risk-free rate (RFR)", "rfr", "number", "percent");
		this.field(wacc, "Market risk premium (MRP)", "mrp", "number", "percent");
		this.field(wacc, "Beta", "beta");
		this.field(wacc, "Interest expense", "intExp", "number", "money");
		this.field(wacc, "Total debt", "totDebt", "number", "money");
		this.field(wacc, "Tax rate", "taxRate", "number", "percent");
		this.field(wacc, "Market capitalization", "mktCap", "number", "money");

		// --- DCF section ---
		const dcf = this.section(formCol, "DCF");
		this.field(dcf, "Net debt", "netDebt", "number", "money");
		this.field(dcf, "FCF growth, yrs 1-5", "growth1to5", "number", "percent");
		this.field(dcf, "FCF growth, yrs 6-10", "growth6to10", "number", "percent");
		this.field(dcf, "Terminal growth rate", "terminalGrowth", "number", "percent");
		this.field(dcf, "TTM free cash flow", "fcf", "number", "money");

		// --- Graham section ---
		const graham = this.section(formCol, "Graham");
		this.field(graham, "TTM diluted EPS", "eps", "number", "perShare");
		this.field(graham, "Expected EPS growth, 7-10yr", "grahamGrowth", "number", "percent");
		this.field(graham, "AAA corporate bond yield", "aaaYield", "number", "percent");

		// --- Ten Cap section ---
		const tenCap = this.section(formCol, "Ten Cap");
		this.field(tenCap, "Operating cash flow", "ocf", "number", "money");
		this.field(tenCap, "Capital expenditures", "capex", "number", "money");
		this.field(tenCap, "Maintenance capex", "mainPct", "number", "percent");

		// --- Results (sticky) ---
		resultsCol.createEl("h3", { text: "Summary" });
		this.resultsEl = resultsCol.createDiv({ cls: "sv-results" });

		const saveBtn = resultsCol.createEl("button", { text: "Save", cls: "mod-cta sv-insert-btn" });
		saveBtn.addEventListener("click", () => this.saveValuation());

		this.recalculate();
	}

	private section(container: HTMLElement, title: string): HTMLElement {
		const box = container.createDiv({ cls: "sv-section" });
		box.createEl("h4", { text: title });
		return box.createDiv({ cls: "sv-fields" });
	}

	private field(
		container: HTMLElement,
		label: string,
		key: keyof FormState,
		type: "text" | "number" = "number",
		unitKind?: "money" | "shares" | "perShare" | "percent"
	): HTMLInputElement {
		const wrap = container.createDiv({ cls: "sv-field" });
		const labelRow = wrap.createDiv({ cls: "sv-field-label-row" });

		const labelGroup = labelRow.createDiv({ cls: "sv-field-label-group" });
		labelGroup.createEl("label", { text: label });
		const helpText = HELP_TEXT[key];
		if (helpText) {
			const helpBtn = labelGroup.createSpan({ cls: "sv-help-btn", text: "?" });
			helpBtn.setAttr("role", "button");
			helpBtn.setAttr("tabindex", "0");
			setTooltip(helpBtn, helpText, { placement: "top" });
			const showHelp = (e: Event) => {
				e.preventDefault();
				new Notice(helpText, 6000);
			};
			helpBtn.addEventListener("click", showHelp);
			helpBtn.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") showHelp(e);
			});
		}

		if (unitKind) {
			const hint = labelRow.createSpan({ cls: "sv-unit-hint" });
			if (unitKind === "perShare") {
				hint.setText("$/share");
			} else if (unitKind === "percent") {
				hint.setText("%");
			} else if (unitKind === "money") {
				hint.setText(SCALE_LABELS[this.moneyScale]);
				this.moneyHintEls.push(hint);
			} else {
				hint.setText(SCALE_LABELS[this.sharesScale]);
				this.sharesHintEls.push(hint);
			}
		}

		const isFormattedNumber = unitKind === "money" || unitKind === "shares" || unitKind === "perShare";
		const inputRow = wrap.createDiv({ cls: "sv-input-row" });
		const input = inputRow.createEl("input", { type: isFormattedNumber ? "text" : type });
		if (!isFormattedNumber && type === "number") input.step = "any";
		if (isFormattedNumber) input.setAttr("inputmode", "decimal");

		input.value = isFormattedNumber ? formatWithCommas(this.state[key]) : this.state[key];

		if (isFormattedNumber) {
			input.addEventListener("focus", () => {
				input.value = this.state[key];
			});
			input.addEventListener("blur", () => {
				input.value = formatWithCommas(this.state[key]);
			});
		}

		input.addEventListener("input", () => {
			if (isFormattedNumber) {
				const cleaned = sanitizeNumericInput(input.value);
				if (cleaned !== input.value) input.value = cleaned;
				this.state[key] = cleaned;
			} else if (type === "text") {
				const upper = input.value.toUpperCase();
				if (upper !== input.value) input.value = upper;
				this.state[key] = upper;
			} else {
				this.state[key] = input.value;
			}
			this.recalculate();
		});
		return input;
	}

	private scaleDropdown(
		container: HTMLElement,
		label: string,
		current: ScaleUnit,
		hintEls: HTMLElement[],
		onChange: (value: ScaleUnit) => void
	): void {
		const wrap = container.createDiv({ cls: "sv-scale-dropdown" });
		wrap.createEl("label", { text: label });
		const select = wrap.createEl("select");
		for (const opt of SCALE_OPTIONS) {
			const optionEl = select.createEl("option", { text: SCALE_LABELS[opt], value: opt });
			if (opt === current) optionEl.selected = true;
		}
		select.addEventListener("change", () => {
			const value = select.value as ScaleUnit;
			onChange(value);
			for (const el of hintEls) el.setText(SCALE_LABELS[value]);
			this.recalculate();
		});
	}

	private num(key: keyof FormState): number {
		const parsed = parseFloat(this.state[key]);
		if (isNaN(parsed)) return 0;
		if (StockValuationsView.MONEY_KEYS.has(key)) {
			return parsed * SCALE_MULTIPLIERS[this.moneyScale];
		}
		if (StockValuationsView.SHARE_KEYS.has(key)) {
			return parsed * SCALE_MULTIPLIERS[this.sharesScale];
		}
		if (StockValuationsView.PERCENT_KEYS.has(key)) {
			return parsed / 100;
		}
		return parsed;
	}

	// `explicit` = true for a manual "Fetch" click (always overwrites, reports errors).
	// `explicit` = false for the auto-fetch on leaving the ticker field (only fills a
	// blank/zero price — a non-zero value already there is a signal the user typed
	// their own and doesn't want it silently replaced).
	private async fetchPrice(
		priceInput: HTMLInputElement,
		btn: HTMLButtonElement,
		explicit: boolean
	): Promise<void> {
		const ticker = this.state.ticker.trim();
		if (!ticker) {
			if (explicit) new Notice("Enter a ticker first.");
			return;
		}

		const currentPrice = parseFloat(this.state.price);
		if (!explicit && !isNaN(currentPrice) && currentPrice !== 0) return;

		const originalText = btn.textContent ?? "Fetch";
		if (explicit) {
			btn.disabled = true;
			btn.setText("Fetching…");
		}

		const price = await fetchQuotePrice(ticker);

		if (explicit) {
			btn.disabled = false;
			btn.setText(originalText);
		}

		if (price === null) {
			if (explicit) new Notice(`Couldn't fetch a price for ${ticker}.`);
			return;
		}

		this.state.price = String(price);
		priceInput.value = formatWithCommas(this.state.price);
		this.recalculate();
	}

	private recalculate(): void {
		const wacc = calcWacc({
			rfr: this.num("rfr"),
			mrp: this.num("mrp"),
			beta: this.num("beta"),
			intExp: this.num("intExp"),
			totDebt: this.num("totDebt"),
			taxRate: this.num("taxRate"),
			mktCap: this.num("mktCap"),
		});

		const dcfIv = calcDcf({
			netDebt: this.num("netDebt"),
			shares: this.num("shares"),
			growth1to5: this.num("growth1to5"),
			growth6to10: this.num("growth6to10"),
			terminalGrowth: this.num("terminalGrowth"),
			wacc,
			fcf: this.num("fcf"),
		});

		const grahamIv = calcGraham({
			eps: this.num("eps"),
			growth: this.num("grahamGrowth"),
			aaaYield: this.num("aaaYield"),
		});

		const tenCap = calcTenCap({
			ocf: this.num("ocf"),
			capex: this.num("capex"),
			mainPct: this.num("mainPct"),
			shares: this.num("shares"),
		});

		const price = this.num("price");
		this.results = {
			wacc,
			dcfIv,
			dcfMos: marginOfSafety(dcfIv, price),
			grahamIv,
			grahamMos: marginOfSafety(grahamIv, price),
			tenCapIv: tenCap.iv,
			tenCapYield: ownerEarningsYield(tenCap.ownerEarnings, this.num("shares"), price),
			tenCapMos: marginOfSafety(tenCap.iv, price),
		};

		this.renderResults();
	}

	private renderResults(): void {
		const r = this.results;
		const price = this.num("price");

		this.heroTickerEl.setText(this.state.ticker || "New valuation");
		this.heroPriceEl.setText(price > 0 ? formatCurrency(price) : "");

		this.resultsEl.empty();
		const table = this.resultsEl.createEl("table");
		const head = table.createEl("tr");
		["Method", "Value", "MoS"].forEach((h) => head.createEl("th", { text: h }));

		const row = (name: string, val: string, mos: number | null) => {
			const tr = table.createEl("tr");
			tr.createEl("td", { text: name });
			tr.createEl("td", { text: val, cls: "sv-num" });
			const mosCell = tr.createEl("td", { cls: "sv-num sv-mos" });
			if (mos === null || !isFinite(mos)) {
				mosCell.setText("—");
			} else {
				mosCell.createSpan({ cls: mos >= 0 ? "sv-dot sv-dot-pos" : "sv-dot sv-dot-neg" });
				mosCell.createSpan({ text: formatPercent(mos) });
			}
		};

		row("WACC", formatPercent(r.wacc * 100), null);
		row("DCF", formatCurrency(r.dcfIv), r.dcfMos);
		row("Graham", formatCurrency(r.grahamIv), r.grahamMos);
		row("Ten Cap", formatCurrency(r.tenCapIv), r.tenCapMos);

		this.resultsEl.createEl("p", {
			text: `Ten Cap owner-earnings yield: ${formatPercent(r.tenCapYield)}`,
			cls: "sv-note",
		});
	}

}
