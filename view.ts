import {
	App,
	FuzzySuggestModal,
	ItemView,
	Menu,
	Modal,
	normalizePath,
	Notice,
	TFile,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from "obsidian";
import { BarController, BarElement, CategoryScale, Chart, LinearScale, Legend, Tooltip } from "chart.js";
import type StockValuationsPlugin from "./main";
import { computeResultsForState, MONEY_KEYS, numFromState, SHARE_KEYS } from "./valuationCalc";
import { SCALE_LABELS, SCALE_MULTIPLIERS, SCALE_OPTIONS, ScaleUnit } from "./units";
import { fetchQuotePrice } from "./priceProvider";
import { fetchFundamentals, FieldResult, isFundamentalsError } from "./fundamentalsProvider";
import { secHttpGet } from "./secHttp";
import { formatCurrency, formatPercent, formatWithCommas, sanitizeNumericInput } from "./format";
import { HELP_TEXT } from "./helpText";
import { FormState, Results, SavedValuation } from "./valuationStore";
import { DATA_SOURCES_DOC, DOCS_INTRO, DOCS_OTHER_INTRO, METHOD_DOCS, OTHER_METHODS } from "./docs";
import { getChangelogEntry } from "./changelog";
import { researchLinksActive } from "./settings";
import { ensureFolderExists } from "./noteSync";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Legend, Tooltip);

export const VIEW_TYPE_STOCK_VALUATIONS = "stock-valuations-view";

// Fixed per-method colors — consistent across tickers so method disagreement
// (not just direction) reads at a glance. Independent of light/dark theme.
const METHODS = [
	{ label: "DCF", color: "#4c8bf5", mosKey: "dcfMos", ivKey: "dcfIv" },
	{ label: "Graham", color: "#f2a541", mosKey: "grahamMos", ivKey: "grahamIv" },
	{ label: "Ten Cap", color: "#8d6fd1", mosKey: "tenCapMos", ivKey: "tenCapIv" },
] as const satisfies { label: string; color: string; mosKey: keyof Results; ivKey: keyof Results }[];
const AVERAGE_COLOR = "#94a3b8";

type Screen = "table" | "form" | "docs" | "changelog";

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void,
		private confirmLabel: string = "Delete",
		private confirmCls: string = "mod-warning"
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });

		const buttonRow = this.contentEl.createDiv({ cls: "sv-modal-buttons" });
		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const confirmBtn = buttonRow.createEl("button", { text: this.confirmLabel, cls: this.confirmCls });
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Vault-wide file picker for "Choose an existing note…" — deliberately not
// restricted to markdown, since the plugin never reads the linked file.
class LinkNoteSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onChoose: (file: TFile) => void
	) {
		super(app);
		this.setPlaceholder("Choose a note to link…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

export class StockValuationsView extends ItemView {
	private plugin: StockValuationsPlugin;
	private screen: Screen = "table";
	private changelogVersion: string | null = null;

	private state!: FormState;
	// The ticker this form session started as (null for a brand-new valuation) —
	// used to tell "editing this same ticker" apart from "typed a ticker that
	// collides with a different saved valuation" in saveValuation().
	private originalTicker: string | null = null;
	private moneyScale!: ScaleUnit;
	private sharesScale!: ScaleUnit;
	private fundamentalsFetchInFlight = false;
	private priceRefreshInFlight = false;
	private results!: Results;
	private resultsEl!: HTMLElement;
	private heroTickerEl!: HTMLElement;
	private heroPriceEl!: HTMLElement;
	private mktCapInput!: HTMLInputElement;
	private charts: Chart[] = [];
	private tablePage = 0;
	private static readonly PAGE_SIZE = 10;

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
		} else if (this.screen === "changelog") {
			this.renderChangelog(root);
		} else {
			this.renderForm(root);
		}
	}

	private resetForm(): void {
		const s = this.plugin.settings;
		this.originalTicker = null;
		this.moneyScale = s.defaultMoneyScale;
		this.sharesScale = s.defaultSharesScale;
		this.state = {
			ticker: "",
			price: "",
			shares: "",

			rfr: String(s.riskFreeRate),
			mrp: String(s.marketRiskPremium),
			beta: "",
			intExp: "",
			totDebt: "",
			// Left blank, unlike the other Settings-defaulted fields below —
			// taxRate is also fetchable (from SEC EDGAR), and a non-blank
			// default here would mean "Fetch data" could never fill it in,
			// since it would never look blank/zero.
			taxRate: "",
			mktCap: "",

			netDebt: "",
			growth1to5: "",
			growth6to10: "",
			terminalGrowth: "",
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
		this.originalTicker = ticker;
		this.state = { ...saved.state };
		this.moneyScale = saved.moneyScale;
		this.sharesScale = saved.sharesScale;
		this.results = { ...saved.results };
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

	// Called once by the plugin on the first load after an update — shows
	// only the entry for the version just landed on, not the full history.
	openChangelog(version: string): void {
		this.changelogVersion = version;
		this.screen = "changelog";
		this.render();
	}

	// True (and warns) when the ticker currently typed into a *new* valuation
	// collides with one already saved — called as soon as the ticker field is
	// left, not just at save time, so the user finds out before filling in
	// the rest of the form.
	private warnIfDuplicateTicker(): boolean {
		const ticker = this.state.ticker.trim().toUpperCase();
		if (!ticker || ticker === this.originalTicker) return false;
		if (!this.plugin.valuations[ticker]) return false;
		new Notice(`A valuation for ${ticker} already exists — edit it from the table instead, or delete it first.`, 8000);
		return true;
	}

	private saveValuation(): void {
		const ticker = this.state.ticker.trim().toUpperCase();
		if (!ticker) {
			new Notice("Enter a ticker first.");
			return;
		}
		if (this.warnIfDuplicateTicker()) return;
		this.state.ticker = ticker;
		this.recalculate();

		// A linked research note is set only from the table, never this form —
		// carry it forward from the record being edited so re-saving the
		// calculator inputs can't silently drop it.
		const previousLink = this.originalTicker
			? this.plugin.valuations[this.originalTicker]?.researchNotePath
			: undefined;

		const record: SavedValuation = {
			state: { ...this.state },
			moneyScale: this.moneyScale,
			sharesScale: this.sharesScale,
			results: { ...this.results },
			updatedAt: Date.now(),
		};
		if (previousLink) record.researchNotePath = previousLink;
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

		const tickers = Object.keys(this.plugin.valuations).sort();

		const refreshBtn = headerActions.createEl("button", { cls: "sv-docs-btn mod-cta" });
		const refreshIcon = refreshBtn.createSpan({ cls: "sv-docs-btn-icon" });
		setIcon(refreshIcon, "refresh-cw");
		const refreshLabel = refreshBtn.createSpan({ text: "Refresh prices" });
		setTooltip(
			refreshBtn,
			"Updates each ticker's price only — recomputes market cap, WACC, DCF IV, and every margin of safety off the new price. Leaves fundamentals untouched."
		);
		refreshBtn.toggleClass("sv-hidden", tickers.length === 0);
		refreshBtn.addEventListener("click", () => {
			void this.refreshAllPrices(refreshBtn, refreshLabel);
		});

		const newBtn = headerActions.createEl("button", { text: "+ New valuation", cls: "mod-cta" });
		newBtn.addEventListener("click", () => this.newValuation());

		if (tickers.length === 0) {
			root.createEl("p", {
				cls: "sv-empty-state",
				text: "No valuations saved yet. Click “+ New valuation” to add one.",
			});
			return;
		}

		const pageCount = Math.max(1, Math.ceil(tickers.length / StockValuationsView.PAGE_SIZE));
		this.tablePage = Math.min(this.tablePage, pageCount - 1);
		const pageStart = this.tablePage * StockValuationsView.PAGE_SIZE;
		const pageTickers = tickers.slice(pageStart, pageStart + StockValuationsView.PAGE_SIZE);

		if (pageCount > 1) {
			this.renderPagination(root, tickers.length, pageStart, pageTickers.length, pageCount);
		}

		const showResearch = this.isResearchLinksEnabled();

		const wrap = root.createDiv({ cls: "sv-table-wrap" });
		const table = wrap.createEl("table", { cls: "sv-main-table" });
		const head = table.createEl("tr");
		const headers = [
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
		];
		if (showResearch) headers.push("Research");
		headers.push("");
		headers.forEach((h) => {
			const th = head.createEl("th", { text: h });
			if (h === "Research") th.addClass("sv-left-header");
		});

		for (const ticker of pageTickers) {
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

			if (showResearch) {
				this.renderResearchCell(tr, ticker, saved);
			}

			const actionsCell = tr.createEl("td", { cls: "sv-actions-cell" });
			const editBtn = actionsCell.createEl("button", { cls: "sv-icon-btn" });
			setIcon(editBtn.createSpan(), "pencil");
			setTooltip(editBtn, "Edit");
			editBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.editValuation(ticker);
			});

			const deleteBtn = actionsCell.createEl("button", { cls: "sv-icon-btn" });
			setIcon(deleteBtn.createSpan(), "trash-2");
			setTooltip(deleteBtn, "Delete");
			deleteBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deleteValuation(ticker);
			});
		}

		this.renderMosChart(root, pageTickers);

		if (pageCount > 1) {
			this.renderPagination(root, tickers.length, pageStart, pageTickers.length, pageCount);
		}

		this.renderYieldSpreadChart(root, pageTickers);
	}

	// Prev/next controls for the ticker table and its charts — both are keyed
	// off the same alphabetically-sorted, paged slice of tickers.
	private renderPagination(
		root: HTMLElement,
		total: number,
		pageStart: number,
		pageLength: number,
		pageCount: number
	): void {
		const bar = root.createDiv({ cls: "sv-pagination" });

		const prevBtn = bar.createEl("button", { text: "← Prev", cls: "sv-link-btn" });
		prevBtn.disabled = this.tablePage === 0;
		prevBtn.addEventListener("click", () => {
			this.tablePage--;
			this.render();
		});

		bar.createSpan({
			cls: "sv-pagination-label",
			text: `${pageStart + 1}–${pageStart + pageLength} of ${total} (page ${this.tablePage + 1} of ${pageCount})`,
		});

		const nextBtn = bar.createEl("button", { text: "Next →", cls: "sv-link-btn" });
		nextBtn.disabled = this.tablePage >= pageCount - 1;
		nextBtn.addEventListener("click", () => {
			this.tablePage++;
			this.render();
		});
	}

	// ---------------------------------------------------------------------
	// Standalone section below the table: one horizontal bar group per
	// ticker, one bar per method (DCF/Graham/Ten Cap MoS%) plus a fourth bar
	// for the ticker's average MoS across the three. Hovering a bar also
	// shows that method's intrinsic value alongside its MoS%.
	// ---------------------------------------------------------------------

	private renderMosChart(root: HTMLElement, tickers: string[]): void {
		const section = root.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Margin of safety by method" });

		const wrap = section.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.style.height = `${Math.max(220, tickers.length * 56 + 60)}px`;
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);

		// Clamp the floor to -100% so a single wildly negative MOS (e.g. a
		// method dividing by a near-zero intrinsic value) doesn't blow out the
		// axis scale and squash every other bar. The tooltip still reports the
		// true, uncapped value.
		const MOS_FLOOR = -100;
		const clampMos = (v: number) => Math.max(v, MOS_FLOOR);

		const datasets = METHODS.map((m) => ({
			label: m.label,
			data: tickers.map((t) => {
				const v = this.plugin.valuations[t].results[m.mosKey];
				return isFinite(v) ? clampMos(v) : null;
			}),
			backgroundColor: m.color,
			borderRadius: 3,
			categoryPercentage: 0.65,
		}));

		const averageBar = {
			label: "Average",
			data: tickers.map((t) => {
				const r = this.plugin.valuations[t].results;
				const vals = METHODS.map((m) => r[m.mosKey]).filter((v) => isFinite(v));
				if (vals.length === 0) return null;
				return clampMos(vals.reduce((a, b) => a + b, 0) / vals.length);
			}),
			backgroundColor: AVERAGE_COLOR,
			borderRadius: 3,
			categoryPercentage: 0.65,
		};

		// Force a symmetric axis around 0 — otherwise Chart.js auto-scales to
		// the data's actual min/max, which shifts 0 off-center (and shifts the
		// tick labels) depending on which tickers happen to be on screen.
		const allValues = [...datasets, averageBar].flatMap((d) => d.data).filter((v): v is number => v !== null);
		const maxAbs = allValues.length ? Math.max(...allValues.map(Math.abs)) : 0;
		const axisBound = Math.max(25, Math.ceil(maxAbs / 25) * 25);

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
							min: -axisBound,
							max: axisBound,
							title: { display: true, text: "Margin of safety (%)", color: mutedColor },
							grid: {
								color: (ctx) => (ctx.tick?.value === 0 ? normalColor : borderColor),
								lineWidth: (ctx) => (ctx.tick?.value === 0 ? 1.5 : 1),
							},
							ticks: {
								color: mutedColor,
								callback: (v) => (Number(v) === 0 ? "0% (price)" : `${v}%`),
							},
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
								label: (ctx) => {
									const ticker = tickers[ctx.dataIndex];
									const r = this.plugin.valuations[ticker].results;
									// Report the true, uncapped MOS here even though the bar
									// itself is clamped at MOS_FLOOR for display.
									let trueMos: number | undefined;
									let iv: number | undefined;
									if (ctx.datasetIndex < METHODS.length) {
										trueMos = r[METHODS[ctx.datasetIndex].mosKey];
										iv = r[METHODS[ctx.datasetIndex].ivKey];
									} else {
										const mosVals = METHODS.map((m) => r[m.mosKey]).filter((v) => isFinite(v));
										trueMos = mosVals.length
											? mosVals.reduce((a, b) => a + b, 0) / mosVals.length
											: undefined;
										const ivs = METHODS.map((m) => r[m.ivKey]).filter((v) => isFinite(v));
										iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : undefined;
									}
									const mosPct =
										trueMos !== undefined && isFinite(trueMos) ? formatPercent(trueMos) : "—";
									const ivStr = iv !== undefined && isFinite(iv) ? formatCurrency(iv) : "—";
									const price = parseFloat(this.plugin.valuations[ticker].state.price);
									const priceStr = isFinite(price) ? formatCurrency(price) : "—";
									return `${ctx.dataset.label}: ${mosPct} (IV ${ivStr}, Price ${priceStr})`;
								},
							},
						},
					},
				},
			})
		);
	}

	// ---------------------------------------------------------------------
	// Standalone section: Ten Cap yield minus the AAA bond yield assumed at
	// save time, per ticker — the actual "ten cap" question (Munger/Buffett
	// owner-earnings framing): is this business paying more than a safe bond?
	// Diverging bar at 0, same visual language as the MoS chart above.
	// ---------------------------------------------------------------------

	private renderYieldSpreadChart(root: HTMLElement, tickers: string[]): void {
		const section = root.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Ten Cap yield vs. bond yield" });

		const wrap = section.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.style.height = `${Math.max(180, tickers.length * 32 + 50)}px`;
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);
		const tenCap = METHODS.find((m) => m.label === "Ten Cap")!;

		const spreadOf = (t: string) => {
			const state = this.plugin.valuations[t].state;
			const yield_ = this.plugin.valuations[t].results.tenCapYield;
			const bond = parseFloat(state.aaaYield);
			return isFinite(yield_) && isFinite(bond) ? yield_ - bond : null;
		};

		this.charts.push(
			new Chart(canvas, {
				type: "bar",
				data: {
					labels: tickers,
					datasets: [
						{
							label: "Yield spread",
							data: tickers.map(spreadOf),
							backgroundColor: tenCap.color,
							borderRadius: 3,
							barThickness: 10,
						},
					],
				},
				options: {
					indexAxis: "y",
					responsive: true,
					maintainAspectRatio: false,
					scales: {
						x: {
							title: { display: true, text: "Ten Cap yield vs. bond yield (pp)", color: mutedColor },
							grid: {
								color: (ctx) => (ctx.tick?.value === 0 ? normalColor : borderColor),
								lineWidth: (ctx) => (ctx.tick?.value === 0 ? 1.5 : 1),
							},
							ticks: {
								color: mutedColor,
								callback: (v) => (Number(v) === 0 ? "0 (bond yield)" : `${v}`),
							},
						},
						y: {
							grid: { display: false },
							ticks: { color: normalColor },
						},
					},
					plugins: {
						legend: { display: false },
						tooltip: {
							callbacks: {
								label: (ctx) => {
									const ticker = tickers[ctx.dataIndex];
									const state = this.plugin.valuations[ticker].state;
									const yield_ = this.plugin.valuations[ticker].results.tenCapYield;
									const bond = parseFloat(state.aaaYield);
									return `Ten Cap yield ${formatPercent(yield_)} vs. bond ${formatPercent(bond)}`;
								},
							},
						},
					},
				},
			})
		);
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

	// ---------------------------------------------------------------------
	// Research links — an optional, opt-in column. The linked file's
	// contents are never read; the plugin only stores and opens a path.
	// ---------------------------------------------------------------------

	private isResearchLinksEnabled(): boolean {
		return researchLinksActive(this.plugin.settings);
	}

	private renderResearchCell(row: HTMLElement, ticker: string, saved: SavedValuation): void {
		const cell = row.createEl("td", { cls: "sv-research-cell" });
		const path = saved.researchNotePath;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;

		if (path && file instanceof TFile) {
			const wrap = cell.createSpan({ cls: "sv-research-linked" });

			const openBtn = wrap.createEl("button", { cls: "sv-icon-btn" });
			setIcon(openBtn.createSpan(), "file-text");
			setTooltip(openBtn, `Open ${file.basename}`);
			openBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.app.workspace.getLeaf(true).openFile(file);
			});

			const unlinkBtn = wrap.createEl("button", { cls: "sv-icon-btn" });
			setIcon(unlinkBtn.createSpan(), "unlink");
			setTooltip(unlinkBtn, "Remove link (the note itself is untouched)");
			unlinkBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				new ConfirmModal(
					this.app,
					`Remove the research link for ${ticker}? "${file.basename}" itself won't be touched.`,
					() => {
						delete saved.researchNotePath;
						void this.plugin.saveValuations();
						this.render();
					},
					"Remove link"
				).open();
			});
			return;
		}

		const linkBtn = cell.createEl("button", { cls: "sv-research-empty" });
		setIcon(linkBtn.createSpan(), "link");
		linkBtn.createSpan({ text: "Link note" });
		setTooltip(
			linkBtn,
			path ? `Linked file "${path}" not found — click to relink` : "Link an existing note, or create a new one"
		);
		linkBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openLinkNoteMenu(e, ticker);
		});
	}

	private openLinkNoteMenu(evt: MouseEvent, ticker: string): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Choose an existing note…")
				.setIcon("search")
				.onClick(() => {
					new LinkNoteSuggestModal(this.app, (file) => this.setResearchLink(ticker, file.path)).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Create a new note here…")
				.setIcon("plus")
				.onClick(() => {
					const folder = this.plugin.settings.researchNotesFolder;
					const filename = `${ticker}-research`;
					const path = normalizePath(folder ? `${folder}/${filename}.md` : `${filename}.md`);
					if (this.app.vault.getAbstractFileByPath(path)) {
						new Notice(`"${path}" already exists — use "Choose an existing note…" to link it instead.`);
						return;
					}
					new ConfirmModal(
						this.app,
						`Create "${path}"?`,
						() => void this.createAndLinkResearchNote(ticker, folder, filename),
						"Create",
						"mod-cta"
					).open();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	private setResearchLink(ticker: string, path: string): void {
		const saved = this.plugin.valuations[ticker];
		if (!saved) return;
		saved.researchNotePath = path;
		void this.plugin.saveValuations();
		this.render();
	}

	private async createAndLinkResearchNote(ticker: string, folder: string, filename: string): Promise<void> {
		const withExt = filename.toLowerCase().endsWith(".md") ? filename : `${filename}.md`;
		const path = normalizePath(folder ? `${folder}/${withExt}` : withExt);

		try {
			if (this.app.vault.getAbstractFileByPath(path)) {
				new Notice(`"${path}" already exists — use "Choose an existing note…" to link it instead.`);
				return;
			}
			await ensureFolderExists(this.app, path);
			await this.app.vault.create(path, "");
			this.setResearchLink(ticker, path);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file);
		} catch (e) {
			console.error("Stock Valuations: failed to create research note", e);
			new Notice(`Couldn't create "${path}" — check the folder and filename and try again.`);
		}
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
			text: " This plugin is a calculator, not a recommendation — it's on you to judge whether its inputs, assumptions, and outputs make sense for a given company. That includes the data it fetches for you: prices and fundamentals are pulled from free, unofficial, or best-effort sources (see \"Where the data comes from\" below), not verified feeds. Take every auto-filled number with a grain of salt, verify anything that matters against the actual source, and use this at your own risk.",
		});

		const dataSources = wrap.createDiv({ cls: "sv-docs-section" });
		dataSources.createEl("h3", { text: DATA_SOURCES_DOC.title });
		for (const p of DATA_SOURCES_DOC.body) {
			dataSources.createEl("p", { text: p });
		}

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
	// Changelog screen — shown once, automatically, the first time the view
	// opens after an update. Only the entry for the version just landed on,
	// never the full history (see openChangelog).
	// ---------------------------------------------------------------------

	private renderChangelog(root: HTMLElement): void {
		const backRow = root.createDiv({ cls: "sv-back-row" });
		const backBtn = backRow.createEl("button", { text: "← Back to table", cls: "sv-link-btn" });
		backBtn.addEventListener("click", () => this.backToTable());

		const wrap = root.createDiv({ cls: "sv-docs sv-changelog" });
		const version = this.changelogVersion;
		const entry = version ? getChangelogEntry(version) : undefined;

		wrap.createEl("h2", { text: `✨ What's new in ${version ?? "this version"}` });

		if (!entry) {
			wrap.createEl("p", { text: "No release notes for this version." });
			return;
		}

		const list = wrap.createEl("ul", { cls: "sv-changelog-list" });
		for (const highlight of entry.highlights) {
			list.createEl("li", { text: highlight });
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
		this.scaleDropdown(unitsRow, "Money", this.moneyScale, MONEY_KEYS, (v) => {
			this.moneyScale = v;
		});
		this.scaleDropdown(unitsRow, "Shares", this.sharesScale, SHARE_KEYS, (v) => {
			this.sharesScale = v;
		});
		root.createEl("p", {
			cls: "sv-legend",
			text:
				"Money scale applies to dollar aggregates (debt, cash flow, market cap, etc.); Shares scale to the share count. Switching either rescales whatever's already typed, so the real value stays the same. Price and EPS are always actual per-share dollars, never scaled. Fields marked % are percentages — enter 5 for 5%, not 0.05. \"Fetch data\" (below) pulls price from Yahoo Finance and fundamentals from SEC EDGAR, but only into fields that are blank or zero — it never overwrites a value you've already typed.",
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
		const fetchAllBtn = tickerInput.parentElement!.createEl("button", {
			text: "Fetch data",
			cls: "sv-link-btn",
		});
		setTooltip(
			fetchAllBtn,
			"Fills blank or zero fields below with price (Yahoo Finance) and fundamentals (SEC EDGAR). Never overwrites a value you've already entered."
		);
		fetchAllBtn.addEventListener("click", () => {
			void this.fetchAllIntoForm(fetchAllBtn);
		});
		const updateYahooLink = () => {
			const ticker = this.state.ticker.trim();
			yahooLink.toggleClass("sv-hidden", !ticker);
			if (ticker) {
				yahooLink.setAttr("href", `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/financials/`);
			}
		};
		updateYahooLink();

		this.field(company, "Current price", "price", "number", "perShare");
		this.field(company, "Diluted shares outstanding", "shares", "number", "shares");

		tickerInput.addEventListener("input", updateYahooLink);
		tickerInput.addEventListener("blur", () => {
			this.warnIfDuplicateTicker();
		});

		// --- WACC section ---
		const wacc = this.section(formCol, "WACC");
		this.field(wacc, "Risk-free rate (RFR)", "rfr", "number", "percent");
		this.field(wacc, "Market risk premium (MRP)", "mrp", "number", "percent");
		this.field(wacc, "Beta", "beta");
		this.field(wacc, "Interest expense", "intExp", "number", "money");
		this.field(wacc, "Total debt", "totDebt", "number", "money");
		this.field(wacc, "Tax rate", "taxRate", "number", "percent");
		this.mktCapInput = this.field(wacc, "Market capitalization", "mktCap", "number", "money", { readOnly: true });

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
		unitKind?: "money" | "shares" | "perShare" | "percent",
		options?: { readOnly?: boolean }
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
			} else {
				hint.setText(SCALE_LABELS[this.sharesScale]);
			}
		}

		const isFormattedNumber = unitKind === "money" || unitKind === "shares" || unitKind === "perShare";
		const inputRow = wrap.createDiv({ cls: "sv-input-row" });
		const input = inputRow.createEl("input", { type: isFormattedNumber ? "text" : type });
		if (!isFormattedNumber && type === "number") input.step = "any";
		if (isFormattedNumber) input.setAttr("inputmode", "decimal");
		// taxRate is the one field left blank on purpose despite having a
		// Settings default (see num()) — the placeholder makes that fallback
		// visible instead of leaving an empty box with no explanation.
		if (key === "taxRate") {
			input.placeholder = `${this.plugin.settings.taxRate} (Settings default)`;
		}

		input.value = isFormattedNumber ? formatWithCommas(this.state[key]) : this.state[key];

		if (options?.readOnly) {
			// Computed, not typed in (market cap = price × shares) — no focus/blur/
			// input wiring at all, just a live display recalculate() keeps in sync.
			input.readOnly = true;
			input.tabIndex = -1;
			input.addClass("sv-readonly-field");
			setTooltip(input, "Computed as price × shares — not an input you can edit.");
			return input;
		}

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

	// Rounds a computed/converted value to at most 2 decimal places before
	// it's written into a field — keeps scale conversions and fetched values
	// free of floating-point noise (e.g. "10481.000000004") without forcing
	// trailing zeros onto whole numbers ("10481", not "10481.00").
	private roundForField(value: number): string {
		return String(Math.round(value * 100) / 100);
	}

	// Switching the Money/Shares scale changes what a given typed number
	// *means* (100 under "millions" is a different real amount than 100 under
	// "billions") — so every field in that scale's group gets converted to
	// keep representing the same real-world value, not just relabeled.
	// Blank fields are left alone; user-typed values are rescaled exactly
	// like fetched ones, since there's no way to tell them apart once stored.
	private rescaleFields(keys: ReadonlySet<keyof FormState>, oldScale: ScaleUnit, newScale: ScaleUnit): void {
		if (oldScale === newScale) return;
		const ratio = SCALE_MULTIPLIERS[oldScale] / SCALE_MULTIPLIERS[newScale];
		for (const key of keys) {
			const raw = this.state[key];
			const parsed = parseFloat(raw);
			if (raw.trim() === "" || isNaN(parsed)) continue;
			this.state[key] = this.roundForField(parsed * ratio);
		}
	}

	private scaleDropdown(
		container: HTMLElement,
		label: string,
		current: ScaleUnit,
		keys: ReadonlySet<keyof FormState>,
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
			this.rescaleFields(keys, current, value);
			onChange(value);
			this.render();
		});
	}

	private num(key: keyof FormState): number {
		return numFromState(this.state, key, this.moneyScale, this.sharesScale, this.plugin.settings.taxRate);
	}

	// A field is "unset" — and so fair game for the API to fill — if it's
	// blank or literally 0. Anything else is treated as a value the user
	// already entered on purpose and is never overwritten. This is the one
	// rule every field fetched below follows, price included.
	private isBlankOrZero(key: keyof FormState): boolean {
		const raw = this.state[key];
		const parsed = parseFloat(raw);
		return raw.trim() === "" || isNaN(parsed) || parsed === 0;
	}

	// The single entry point for pulling in outside data: price from Yahoo
	// Finance, everything else from SEC EDGAR. Always talks to the network
	// through fetchQuotePrice / secHttpGet (both wrap Obsidian's requestUrl),
	// which works the same way on mobile as on desktop — unlike a browser
	// fetch(), it isn't blocked by CORS or the mobile webview. Every field it
	// touches follows the same blank-or-zero rule as isBlankOrZero — see also
	// the legend text above the form and this button's tooltip.
	private async fetchAllIntoForm(btn: HTMLButtonElement): Promise<void> {
		const ticker = this.state.ticker.trim();
		if (!ticker) {
			new Notice("Enter a ticker first.");
			return;
		}
		if (this.fundamentalsFetchInFlight) return;
		this.fundamentalsFetchInFlight = true;

		const originalText = btn.textContent ?? "Fetch data";
		btn.disabled = true;
		btn.setText("Fetching…");

		const filled: string[] = [];
		const keptExisting: string[] = [];
		const unavailable: string[] = [];
		const caveats: string[] = [];
		let entityLabel = ticker.toUpperCase();
		let fundamentalsErrorMessage: string | null = null;

		try {
			if (this.isBlankOrZero("price")) {
				const price = await fetchQuotePrice(ticker);
				if (price !== null) {
					this.state.price = this.roundForField(price);
					filled.push("Current price");
				} else {
					unavailable.push("Current price (Yahoo Finance)");
				}
			} else {
				keptExisting.push("Current price");
			}

			const result = await fetchFundamentals(ticker, secHttpGet);
			if (isFundamentalsError(result)) {
				fundamentalsErrorMessage = result.message;
			} else {
				entityLabel = `${result.entityName} (CIK ${result.cik})`;

				const apply = (
					label: string,
					key: keyof FormState,
					field: FieldResult,
					kind: "money" | "shares" | "percent" | "perShare"
				) => {
					if (field.value === null) {
						unavailable.push(label);
						return;
					}
					if (!this.isBlankOrZero(key)) {
						keptExisting.push(label);
						return;
					}
					let scaled: number;
					if (kind === "money") scaled = field.value / SCALE_MULTIPLIERS[this.moneyScale];
					else if (kind === "shares") scaled = field.value / SCALE_MULTIPLIERS[this.sharesScale];
					else if (kind === "percent") scaled = field.value * 100;
					else scaled = field.value; // perShare — always actual dollars, never scaled
					this.state[key] = this.roundForField(scaled);
					filled.push(label);
				};

				apply("TTM diluted EPS", "eps", result.eps, "perShare");
				apply("TTM operating cash flow", "ocf", result.ocf, "money");
				apply("TTM capex", "capex", result.capex, "money");
				apply("TTM free cash flow", "fcf", result.fcf, "money");
				apply("TTM interest expense", "intExp", result.intExp, "money");
				apply("Diluted shares outstanding", "shares", result.shares, "shares");
				apply("Total debt", "totDebt", result.totDebt, "money");
				apply("Net debt", "netDebt", result.netDebt, "money");
				apply("Tax rate", "taxRate", result.taxRate, "percent");

				// Total debt has no single canonical XBRL tag, so it's always
				// worth a second look; a TTM-capable field that fell back to a
				// bare fiscal-year figure (no matching year-ago period to roll
				// forward) is a real deviation from "trailing twelve months" —
				// both are surfaced here rather than left silently inside the
				// field's own note.
				if (filled.includes("Total debt")) caveats.push(result.totDebt.note);
				const ttmFields: [string, FieldResult][] = [
					["TTM diluted EPS", result.eps],
					["TTM operating cash flow", result.ocf],
					["TTM capex", result.capex],
					["TTM interest expense", result.intExp],
				];
				for (const [label, field] of ttmFields) {
					if (filled.includes(label) && field.basis === "fiscal-year") {
						caveats.push(`${label}: ${field.note}`);
					}
				}
			}

		} finally {
			btn.disabled = false;
			btn.setText(originalText);
			this.fundamentalsFetchInFlight = false;
		}

		this.render();

		const parts: string[] = [];
		if (filled.length > 0) parts.push(`Filled: ${filled.join(", ")}.`);
		if (unavailable.length > 0) parts.push(`Not available: ${unavailable.join(", ")}.`);
		if (keptExisting.length > 0) parts.push(`Left as-is (already had a value): ${keptExisting.join(", ")}.`);
		if (caveats.length > 0) parts.push(`Worth double-checking — ${caveats.join(" ")}`);
		if (fundamentalsErrorMessage) parts.push(`Fundamentals (SEC EDGAR) failed: ${fundamentalsErrorMessage}`);
		if (parts.length === 0) parts.push("Nothing to fill — every field already had a value.");
		new Notice(`${entityLabel}: ${parts.join(" ")}`, 15000);
	}

	// Refreshes just the price for every saved valuation (table button, not the
	// per-ticker form) — no fundamentals are touched. Everything price-derived
	// is recomputed off the new price: MoS and Ten Cap yield always; market cap
	// too (price × shares), which in turn moves WACC and DCF IV. Graham and Ten
	// Cap IV don't depend on WACC/market cap, so those stay fixed.
	private async refreshAllPrices(btn: HTMLButtonElement, label: HTMLElement): Promise<void> {
		const tickers = Object.keys(this.plugin.valuations).sort();
		if (tickers.length === 0 || this.priceRefreshInFlight) return;
		this.priceRefreshInFlight = true;

		const originalText = label.textContent ?? "Refresh prices";
		btn.disabled = true;
		label.setText("Refreshing…");

		let updated = 0;
		const failed: string[] = [];

		try {
			for (const ticker of tickers) {
				const record = this.plugin.valuations[ticker];
				if (!record) continue;
				const price = await fetchQuotePrice(ticker);
				if (price === null) {
					failed.push(ticker);
					continue;
				}
				record.state.price = this.roundForField(price);
				record.results = computeResultsForState(
					record.state,
					record.moneyScale,
					record.sharesScale,
					this.plugin.settings.taxRate
				);
				updated++;
			}
		} finally {
			btn.disabled = false;
			label.setText(originalText);
			this.priceRefreshInFlight = false;
		}

		if (updated > 0) {
			void this.plugin.saveValuations();
		}
		this.render();

		const parts = [`Updated ${updated} of ${tickers.length} price${tickers.length === 1 ? "" : "s"}.`];
		if (failed.length > 0) parts.push(`Couldn't fetch: ${failed.join(", ")}.`);
		new Notice(parts.join(" "), 10000);
	}

	private recalculate(): void {
		// Mutates this.state.mktCap as a side effect — see computeResultsForState.
		this.results = computeResultsForState(this.state, this.moneyScale, this.sharesScale, this.plugin.settings.taxRate);
		this.mktCapInput.value = formatWithCommas(this.state.mktCap);
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
