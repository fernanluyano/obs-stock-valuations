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
import {
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	LinearScale,
	Legend,
	LineController,
	LineElement,
	PointElement,
	Tooltip,
} from "chart.js";
import {
	FormatModule,
	InteractionModule,
	PageModule,
	ResponsiveLayoutModule,
	SortModule,
	Tabulator,
} from "tabulator-tables";
import type { CellComponent, ColumnDefinition } from "tabulator-tables";
import type StockValuationsPlugin from "./main";
import {
	calcDcfGrid,
	calcDdmGrid,
	calcGrahamGrid,
	calcTenCapGrid,
	DcfInputs,
	DdmInputs,
	GrahamInputs,
	hasIntrinsicValue,
	marginOfSafety,
	paybackTone,
	PaybackTone,
	TenCapInputs,
} from "./calculations";
import { computeResultsForState, MONEY_KEYS, numFromState, SHARE_KEYS } from "./valuationCalc";
import { SCALE_LABELS, SCALE_MULTIPLIERS, SCALE_OPTIONS, ScaleUnit } from "./units";
import { fetchQuotePrice } from "./priceProvider";
import type { MacroRow } from "./macro";
import { fetchFundamentals, FieldResult, isFundamentalsError } from "./fundamentalsProvider";
import { secHttpGet } from "./secHttp";
import { formatCurrency, formatPercent, formatWithCommas, formatYears, sanitizeNumericInput } from "./format";
import { HELP_TEXT } from "./helpText";
import { FormState, HistoryEntry, historyIv, Results, SavedValuation, Scenario, ScenarioKey } from "./valuationStore";
import { appendHistoryEntry, buildHistoryEntry, compactHistory, deleteHistoryEntry } from "./historyStore";
import { DATA_SOURCES_DOC, DOCS_INTRO, DOCS_OTHER_INTRO, METHOD_DOCS, OTHER_METHODS, VALUATION_HISTORY_DOC } from "./docs";
import { getChangelogEntry } from "./changelog";
import { researchLinksActive } from "./settings";
import { validateScenarios } from "./scenarioValidation";
import { ensureFolderExists } from "./noteSync";

Chart.register(
	BarController,
	BarElement,
	CategoryScale,
	LinearScale,
	Legend,
	LineController,
	LineElement,
	PointElement,
	Tooltip
);
// Core Tabulator + only the modules the table actually uses (cell formatters,
// column sorting, pagination, row click, responsive column collapsing) — not
// TabulatorFull, which bundles every module (filtering, editing, export,
// print, etc.) and is ~2.5x the size.
Tabulator.registerModule([FormatModule, SortModule, PageModule, InteractionModule, ResponsiveLayoutModule]);

export const VIEW_TYPE_STOCK_VALUATIONS = "stock-valuations-view";

// Fixed per-method colors — consistent across tickers so method disagreement
// (not just direction) reads at a glance. Independent of light/dark theme.
const METHODS = [
	{ label: "DCF", color: "#4c8bf5", mosKey: "dcfMos", ivKey: "dcfIv" },
	{ label: "Graham", color: "#f2a541", mosKey: "grahamMos", ivKey: "grahamIv" },
	{ label: "Ten Cap", color: "#8d6fd1", mosKey: "tenCapMos", ivKey: "tenCapIv" },
	{ label: "DDM", color: "#2bb3a3", mosKey: "ddmMos", ivKey: "ddmIv" },
] as const satisfies { label: string; color: string; mosKey: keyof Results; ivKey: keyof Results }[];

// Display order for the scenario tabs/selector — optimistic to pessimistic,
// left to right.
const SCENARIO_KEYS: ScenarioKey[] = ["bull", "base", "bear"];
const SCENARIO_LABELS: Record<ScenarioKey, string> = { bull: "Bull", base: "Base", bear: "Bear" };
const SCENARIO_TOOLTIPS: Record<ScenarioKey, string> = {
	bull: "Optimistic assumptions.",
	base: "Most-likely assumptions.",
	bear: "Pessimistic assumptions.",
};

// Which HistoryEntry fields hold DCF/Graham/DDM's fair value for a given
// scenario — used by renderHistoryChart to draw one "fair value vs. price"
// chart per scenario. Ten Cap and price have no scenario-specific value (see
// SCENARIO_SPECIFIC_FIELDS), so only DCF/Graham/DDM vary here.
const HISTORY_SCENARIO_FIELDS: Record<
	ScenarioKey,
	{
		dcf: "dcfBullIv" | "dcfBaseIv" | "dcfBearIv";
		graham: "grahamBullIv" | "grahamBaseIv" | "grahamBearIv";
		ddm: "ddmBullIv" | "ddmBaseIv" | "ddmBearIv";
	}
> = {
	bull: { dcf: "dcfBullIv", graham: "grahamBullIv", ddm: "ddmBullIv" },
	base: { dcf: "dcfBaseIv", graham: "grahamBaseIv", ddm: "ddmBaseIv" },
	bear: { dcf: "dcfBearIv", graham: "grahamBearIv", ddm: "ddmBearIv" },
};

function cloneScenario(s: Scenario): Scenario {
	return { state: { ...s.state }, results: { ...s.results } };
}

// The only fields that actually differ between bull/base/bear — everything
// else (ticker/price/shares, WACC inputs, debt, trailing EPS/OCF/capex/FCF,
// bond yield) is a company or market fact, not a scenario assumption. Those
// facts are edited only on the Base tab and shown read-only, inherited live
// from Base, on Bull/Bear — see field()'s readOnly handling and
// setStateField() below.
const SCENARIO_SPECIFIC_FIELDS: ReadonlySet<keyof FormState> = new Set([
	"growth1to5",
	"growth6to10",
	"terminalGrowth",
	"grahamGrowth",
	"ddmGrowth",
]);

// One flat row per ticker for the Tabulator table — every IV/MoS value for
// every scenario, precomputed, since Tabulator's column/formatter model
// works off plain fields rather than the nested scenarios/results shape.
interface TableRow {
	ticker: string;
	dcfBearIv: number;
	dcfBearMos: number;
	dcfBaseIv: number;
	dcfBaseMos: number;
	dcfBullIv: number;
	dcfBullMos: number;
	impliedGrowth: number;
	tenCapIv: number;
	tenCapMos: number;
	tenCapYield: number;
	grahamBearIv: number;
	grahamBearMos: number;
	grahamBaseIv: number;
	grahamBaseMos: number;
	grahamBullIv: number;
	grahamBullMos: number;
	ddmBearIv: number;
	ddmBearMos: number;
	ddmBaseIv: number;
	ddmBaseMos: number;
	ddmBullIv: number;
	ddmBullMos: number;
	price: number;
	updatedAt: number;
	// 0 (sorts/reads as "infinitely stale") for records never explicitly
	// refreshed via "Refresh prices" — never falls back to updatedAt, since a
	// recent edit doesn't mean the price itself was confirmed current.
	lastPriceRefreshAt: number;
	researchNotePath?: string;
}

function buildTableRow(ticker: string, saved: SavedValuation): TableRow {
	const { base, bear, bull } = saved.scenarios;
	return {
		ticker,
		dcfBearIv: bear.results.dcfIv,
		dcfBearMos: bear.results.dcfMos,
		dcfBaseIv: base.results.dcfIv,
		dcfBaseMos: base.results.dcfMos,
		dcfBullIv: bull.results.dcfIv,
		dcfBullMos: bull.results.dcfMos,
		// Reverse DCF has a scenario-specific input (terminal growth), like DCF
		// itself, but reads off Base only — same convention as Ten Cap Yield
		// below, to avoid a Bear/Base/Bull spread for one auxiliary metric.
		impliedGrowth: base.results.impliedGrowth,
		// Ten Cap has no scenario-specific input (see SCENARIO_SPECIFIC_FIELDS
		// above), so bear/base/bull are always identical — one value suffices.
		tenCapIv: base.results.tenCapIv,
		tenCapMos: base.results.tenCapMos,
		tenCapYield: base.results.tenCapYield,
		grahamBearIv: bear.results.grahamIv,
		grahamBearMos: bear.results.grahamMos,
		grahamBaseIv: base.results.grahamIv,
		grahamBaseMos: base.results.grahamMos,
		grahamBullIv: bull.results.grahamIv,
		grahamBullMos: bull.results.grahamMos,
		ddmBearIv: bear.results.ddmIv,
		ddmBearMos: bear.results.ddmMos,
		ddmBaseIv: base.results.ddmIv,
		ddmBaseMos: base.results.ddmMos,
		ddmBullIv: bull.results.ddmIv,
		ddmBullMos: bull.results.ddmMos,
		price: parseFloat(base.state.price) || 0,
		updatedAt: saved.updatedAt,
		lastPriceRefreshAt: saved.lastPriceRefreshAt ?? 0,
		researchNotePath: saved.researchNotePath,
	};
}

// Packs IV and MoS into one cell ("$164/-33%") instead of splitting them
// across two columns. `field` on the column holds the MoS value (so sorting
// the column sorts by margin of safety, the more decision-relevant number);
// `ivField` names the sibling field this formatter pulls the IV from. Shared
// by the ticker table (TableRow) and the per-ticker history table
// (HistoryRow) below — same cell convention in both places, so the type
// parameter is always given explicitly at the call site rather than inferred.
function ivMosFormatter<T>(ivField: keyof T): (cell: CellComponent) => string {
	return (cell) => {
		const mos = cell.getValue() as number;
		const iv = (cell.getData() as T)[ivField] as number;
		const el = cell.getElement();
		el.classList.remove("sv-mos-pos", "sv-mos-neg");
		if (isFinite(mos)) el.classList.add(mos >= 0 ? "sv-mos-pos" : "sv-mos-neg");
		return `${formatCurrency(iv, 0)}/${formatPercent(mos, 0)}`;
	};
}

// One row per history entry for the Tabulator table in renderHistoryTabulator
// — same flattened-and-precomputed shape as TableRow above (MoS derived from
// the stored IV + price, not stored itself; see HistoryEntry).
interface HistoryRow {
	at: number;
	price: number;
	dcfBearIv: number;
	dcfBearMos: number;
	dcfBaseIv: number;
	dcfBaseMos: number;
	dcfBullIv: number;
	dcfBullMos: number;
	grahamBearIv: number;
	grahamBearMos: number;
	grahamBaseIv: number;
	grahamBaseMos: number;
	grahamBullIv: number;
	grahamBullMos: number;
	tenCapIv: number;
	tenCapMos: number;
	impliedGrowth: number;
	ddmBearIv: number;
	ddmBearMos: number;
	ddmBaseIv: number;
	ddmBaseMos: number;
	ddmBullIv: number;
	ddmBullMos: number;
}

function buildHistoryRow(entry: HistoryEntry): HistoryRow {
	// Stored values may be null (recorded as NaN — see HistoryIv) or, for
	// DDM on entries from before it existed, missing — historyIv turns both
	// into NaN, so they render as "—".
	const dcfBearIv = historyIv(entry.dcfBearIv);
	const dcfBaseIv = historyIv(entry.dcfBaseIv);
	const dcfBullIv = historyIv(entry.dcfBullIv);
	const grahamBearIv = historyIv(entry.grahamBearIv);
	const grahamBaseIv = historyIv(entry.grahamBaseIv);
	const grahamBullIv = historyIv(entry.grahamBullIv);
	const tenCapIv = historyIv(entry.tenCapIv);
	const ddmBearIv = historyIv(entry.ddmBearIv);
	const ddmBaseIv = historyIv(entry.ddmBaseIv);
	const ddmBullIv = historyIv(entry.ddmBullIv);
	return {
		at: entry.at,
		price: entry.price,
		dcfBearIv,
		dcfBearMos: marginOfSafety(dcfBearIv, entry.price),
		dcfBaseIv,
		dcfBaseMos: marginOfSafety(dcfBaseIv, entry.price),
		dcfBullIv,
		dcfBullMos: marginOfSafety(dcfBullIv, entry.price),
		grahamBearIv,
		grahamBearMos: marginOfSafety(grahamBearIv, entry.price),
		grahamBaseIv,
		grahamBaseMos: marginOfSafety(grahamBaseIv, entry.price),
		grahamBullIv,
		grahamBullMos: marginOfSafety(grahamBullIv, entry.price),
		tenCapIv,
		tenCapMos: marginOfSafety(tenCapIv, entry.price),
		impliedGrowth: historyIv(entry.impliedGrowth),
		ddmBearIv,
		ddmBearMos: marginOfSafety(ddmBearIv, entry.price),
		ddmBaseIv,
		ddmBaseMos: marginOfSafety(ddmBaseIv, entry.price),
		ddmBullIv,
		ddmBullMos: marginOfSafety(ddmBullIv, entry.price),
	};
}

// Index of the value in `values` closest to `target` — used by both
// sensitivity grids to find which fixed axis tick to treat as "current".
function nearestIndex(values: number[], target: number): number {
	return values.reduce((best, v, i) => (Math.abs(v - target) < Math.abs(values[best] - target) ? i : best), 0);
}

type Screen = "table" | "form" | "docs" | "changelog" | "macro";

// One sensitivity-grid cell coordinate — where a given scenario's "current
// inputs" marker lands (see buildSensitivityGrid).
interface GridMarker {
	row: number;
	col: number;
}

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

	// All three scenarios for the ticker currently open in the form. `state`/
	// `results` below always alias whichever scenario is active — the same
	// object references, not copies — so the existing field bindings that
	// read/write `this.state`/`this.results` keep working unmodified; only
	// which scenario they point at changes on a tab switch.
	private scenarios!: Record<ScenarioKey, Scenario>;
	private activeScenario: ScenarioKey = "base";
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
	// Container for the Bull/Base/Bear tab strip, and the two-column
	// form/results layout below it — both rebuilt in isolation by
	// switchScenario() (via renderFormBody()) so a tab click never touches
	// the MoS chart or sensitivity grids, which no longer vary by tab.
	private scenarioTabsWrapEl!: HTMLElement;
	private layoutEl!: HTMLElement;
	private mktCapInput!: HTMLInputElement;
	private saveBtn!: HTMLButtonElement;
	private validationErrorsEl!: HTMLElement;
	private charts: Chart[] = [];
	// The three sensitivity grids (DCF, Graham, Ten Cap) live on the form
	// screen and are rebuilt on every keystroke (see recalculate()),
	// separately from `tabulator` below (the ticker table on the table
	// screen) and `charts` above (only torn down wholesale on a screen
	// switch) so retyping a field doesn't touch those.
	// MoS by method, scoped to the single ticker on the form screen — grouped
	// by scenario (Bull/Base/Bear bars per method) rather than by ticker,
	// since there's only ever one ticker here. Rebuilt on every keystroke
	// from recalculate(), like the sensitivity grids below, always
	// reading all three of this.scenarios directly rather than
	// this.results/this.state (which follow whichever tab is active), so the
	// chart always shows every case and never changes when the Bull/Base/Bear
	// tab does.
	private stockMosChart: Chart | null = null;
	private stockMosChartWrapEl!: HTMLElement;
	private dcfSensitivityTabulator: Tabulator | null = null;
	private dcfSensitivityWrapEl!: HTMLElement;
	private grahamSensitivityTabulator: Tabulator | null = null;
	private grahamSensitivityWrapEl!: HTMLElement;
	private tenCapSensitivityTabulator: Tabulator | null = null;
	private tenCapSensitivityWrapEl!: HTMLElement;
	private ddmSensitivityTabulator: Tabulator | null = null;
	private ddmSensitivityWrapEl!: HTMLElement;
	// The whole "Sensitivity" section — hidden when no method has a value
	// (see updateSensitivityVisibility), so a blank form doesn't show a header
	// over nothing.
	private sensitivitySectionEl!: HTMLElement;
	private tabulator: Tabulator | null = null;
	// Per-ticker "Valuation history" table on the form screen — same
	// paginated/sortable Tabulator as `tabulator` above, just a second
	// instance. Rebuilt (via a full render()) on any delete/compact, never
	// patched in place.
	private historyTabulator: Tabulator | null = null;
	// "Fair value vs. price" line charts under the history table — one per
	// scenario (Bull/Base/Bear), destroyed in destroyChart() alongside
	// stockMosChart, rebuilt whenever the history section itself is (full
	// render(), same as the table above).
	private historyCharts: Chart[] = [];
	private macroRefreshInFlight = false;
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
		this.destroyTabulator();
		this.contentEl.empty();
	}

	// ---------------------------------------------------------------------
	// Screen management
	// ---------------------------------------------------------------------

	private render(): void {
		this.destroyChart();
		this.destroyTabulator();
		const root = this.contentEl;
		root.empty();
		root.addClass("stock-valuations-view");

		if (this.screen === "table") {
			this.renderTable(root);
		} else if (this.screen === "docs") {
			this.renderDocs(root);
		} else if (this.screen === "changelog") {
			this.renderChangelog(root);
		} else if (this.screen === "macro") {
			this.renderMacroScreen(root);
		} else {
			this.renderForm(root);
		}
	}

	// A fresh form's state: blank, apart from the Settings-defaulted fields.
	// Also the base loadIntoForm lays a saved record over, so a field added
	// after that record was saved (e.g. the DDM's dps/ddmGrowth) comes up
	// blank instead of undefined — no schema migration needed for new fields.
	private blankFormState(): FormState {
		const s = this.plugin.data.settings;
		return {
			ticker: "",
			price: "",
			shares: "",

			rfr: String(this.plugin.data.getCachedRiskFreeRate()),
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

			dps: "",
			ddmGrowth: "",
		};
	}

	private resetForm(): void {
		const s = this.plugin.data.settings;
		this.originalTicker = null;
		this.moneyScale = s.defaultMoneyScale;
		this.sharesScale = s.defaultSharesScale;
		this.activeScenario = "base";

		this.scenarios = {} as Record<ScenarioKey, Scenario>;
		for (const key of SCENARIO_KEYS) {
			const state = this.blankFormState();
			this.scenarios[key] = {
				state,
				results: computeResultsForState(state, this.moneyScale, this.sharesScale, s.taxRate),
			};
		}
		this.state = this.scenarios.base.state;
		this.results = this.scenarios.base.results;
	}

	private loadIntoForm(ticker: string): void {
		const saved = this.plugin.data.getValuation(ticker);
		if (!saved) return;
		this.originalTicker = ticker;
		this.moneyScale = saved.moneyScale;
		this.sharesScale = saved.sharesScale;
		this.activeScenario = "base";

		this.scenarios = {} as Record<ScenarioKey, Scenario>;
		for (const key of SCENARIO_KEYS) {
			const scenario = cloneScenario(saved.scenarios[key]);
			scenario.state = { ...this.blankFormState(), ...scenario.state };
			this.scenarios[key] = scenario;
		}

		// Base is the source of truth for every shared fact. Force Bull/Bear's
		// copies to match it and recompute their results — a saved record from
		// before facts were shared (or edited under an older build) could still
		// have its own divergent values, and "inherited from Base" needs to be
		// true the moment the form opens, not just prospectively from here on.
		// Base's results are recomputed too (from its own unchanged state), so
		// a record saved by an older build picks up any result field added
		// since — e.g. paybackYears — instead of rendering it as undefined.
		const factKeys = (Object.keys(this.scenarios.base.state) as (keyof FormState)[]).filter(
			(k) => !SCENARIO_SPECIFIC_FIELDS.has(k)
		);
		for (const key of SCENARIO_KEYS) {
			if (key !== "base") {
				for (const field of factKeys) {
					this.scenarios[key].state[field] = this.scenarios.base.state[field];
				}
			}
			this.scenarios[key].results = computeResultsForState(
				this.scenarios[key].state,
				this.moneyScale,
				this.sharesScale,
				this.plugin.data.settings.taxRate
			);
		}

		this.state = this.scenarios[this.activeScenario].state;
		this.results = this.scenarios[this.activeScenario].results;
	}

	// Switches which scenario's fields the form shows/edits. Doesn't touch the
	// other two scenarios' data — each keeps whatever was last typed into it
	// until Save, which persists all three together. Rebuilds only the tab
	// strip and the form/results body (renderFormBody) rather than the whole
	// screen — the MoS chart and sensitivity grids below always show every
	// case at once now, so there's nothing in them a tab switch would change.
	private switchScenario(key: ScenarioKey): void {
		if (key === this.activeScenario) return;
		this.activeScenario = key;
		this.state = this.scenarios[key].state;
		this.results = this.scenarios[key].results;
		this.scenarioTabsWrapEl.empty();
		this.renderScenarioTabs(this.scenarioTabsWrapEl);
		this.renderFormBody(this.layoutEl);
	}

	// Writes a value into the active scenario's state — and, for every field
	// that isn't one of the scenario-specific growth assumptions (see
	// SCENARIO_SPECIFIC_FIELDS), into the other two scenarios as well, since
	// those are shared facts. The one place that should ever assign into
	// this.state[key].
	private setStateField(key: keyof FormState, value: string): void {
		this.state[key] = value;
		if (!SCENARIO_SPECIFIC_FIELDS.has(key)) {
			for (const otherKey of SCENARIO_KEYS) {
				if (otherKey !== this.activeScenario) this.scenarios[otherKey].state[key] = value;
			}
		}
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
			void this.plugin.data.deleteValuation(ticker);
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

	private openMacro(): void {
		this.screen = "macro";
		this.render();
		void this.loadMacroData();
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
		if (!this.plugin.data.getValuation(ticker)) return false;
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
		// Save button is disabled whenever updateValidation() finds a violation —
		// this is just a backstop against a stale disabled state.
		if (validateScenarios(this.scenarios).length > 0) return;
		this.state.ticker = ticker;
		this.recalculate();

		// A linked research note is set only from the table, never this form —
		// carry it forward from the record being edited so re-saving the
		// calculator inputs can't silently drop it.
		const previousRecord = this.originalTicker ? this.plugin.data.getValuation(this.originalTicker) : undefined;
		const previousLink = previousRecord?.researchNotePath;
		// Carried forward, not reset here — an ordinary form save doesn't
		// guarantee the price was actually refreshed, only refreshAllPrices does.
		const previousPriceRefresh = previousRecord?.lastPriceRefreshAt;
		const previousHistory = previousRecord?.history;

		// The record is keyed by one ticker — every scenario must agree on it,
		// even though only one tab is on screen when Save is clicked. Results
		// for the other two scenarios are recomputed too: a scale switch or a
		// shared-field edit (ticker/price/shares) updates their state without
		// ever visiting their tab, which would otherwise leave stale results.
		for (const key of SCENARIO_KEYS) {
			this.scenarios[key].state.ticker = ticker;
			this.scenarios[key].results = computeResultsForState(
				this.scenarios[key].state,
				this.moneyScale,
				this.sharesScale,
				this.plugin.data.settings.taxRate
			);
		}

		const now = Date.now();
		const record: SavedValuation = {
			scenarios: {
				bull: cloneScenario(this.scenarios.bull),
				base: cloneScenario(this.scenarios.base),
				bear: cloneScenario(this.scenarios.bear),
			},
			moneyScale: this.moneyScale,
			sharesScale: this.sharesScale,
			updatedAt: now,
		};
		if (previousLink) record.researchNotePath = previousLink;
		if (previousPriceRefresh) record.lastPriceRefreshAt = previousPriceRefresh;

		// One history entry per explicit Save, same as one per price refresh
		// (see refreshAllPrices) — appendHistoryEntry collapses same-day entries
		// either way, so resaving/refreshing a few times in one sitting doesn't
		// spam the timeline with more than one entry for that day.
		const historyEntry = buildHistoryEntry(now, record.scenarios);
		const history = appendHistoryEntry(previousHistory, historyEntry);
		if (history.length > 0) record.history = history;

		void this.plugin.data.saveValuation(ticker, record);
		new Notice(`Saved ${ticker}.`);
		this.screen = "table";
		this.render();
	}

	// ---------------------------------------------------------------------
	// Valuation history — one entry per day this ticker was either explicitly
	// saved or had its price refreshed (see saveValuation() and
	// refreshAllPrices() above, and buildHistoryEntry() in historyStore.ts).
	// Read live off plugin.data rather than copied into form state, same as
	// researchNotePath, so delete/compact take effect immediately without
	// re-opening the form.
	// ---------------------------------------------------------------------

	// Only meaningful once at least one Save has happened — a brand-new,
	// never-saved valuation has nothing to show yet, so the section is
	// skipped entirely rather than rendered empty.
	private renderHistorySection(parent: HTMLElement): void {
		if (!this.originalTicker) return;
		const ticker = this.originalTicker;
		const history = this.plugin.data.getValuation(ticker)?.history ?? [];

		const section = parent.createDiv({ cls: "sv-chart-section" });
		const header = section.createDiv({ cls: "sv-table-header" });
		header.createEl("h3", { text: "Valuation history" });
		if (history.length > 0) {
			const actions = header.createDiv({ cls: "sv-header-actions" });
			const compactBtn = actions.createEl("button", { cls: "sv-docs-btn" });
			compactBtn.createSpan({ text: "Compact history" });
			setTooltip(compactBtn, "Collapses entries older than 6 months to one per month. Can't be undone.");
			compactBtn.addEventListener("click", () => {
				new ConfirmModal(
					this.app,
					`Compact history for ${ticker}? Entries older than 6 months will be collapsed to one per calendar month — the detail in between can't be recovered.`,
					() => {
						const saved = this.plugin.data.getValuation(ticker);
						if (!saved?.history) return;
						const compacted = compactHistory(saved.history, Date.now());
						if (compacted.length > 0) saved.history = compacted;
						else delete saved.history;
						void this.plugin.data.persistValuations([ticker]);
						// Full re-render, same as every other data-mutating action on
						// this screen (delete/link/unlink) — simplest way to keep the
						// table, its pagination, and the Compact button's visibility
						// (hidden once history is empty) all in sync.
						this.render();
					},
					"Compact"
				).open();
			});
		}
		// history is sorted ascending by `at` (appendHistoryEntry's guarantee —
		// see historyStore.ts), so the first/last entries are the min/max dates
		// without needing to sort again here.
		if (history.length > 0) {
			const first = window.moment(history[0].at).format("YYYY-MM-DD");
			const last = window.moment(history[history.length - 1].at).format("YYYY-MM-DD");
			section.createEl("p", {
				cls: "sv-chart-caption",
				text: `${first} to ${last}`,
			});
		}
		section.createEl("p", {
			cls: "sv-chart-caption",
			text: "One entry per day this ticker was saved or had its price refreshed (whichever happens more than once a day, the last one replaces that day's entry rather than adding another). Delete a mistaken entry, or compact everything older than 6 months down to one entry per month to keep the list short — both need confirmation and can't be undone.",
		});

		if (history.length === 0) {
			section.createEl("p", {
				cls: "sv-empty-state",
				text: "No history yet — each Save or price refresh adds an entry here.",
			});
			return;
		}

		this.renderHistoryTabulator(section, ticker, history);
		this.renderHistoryChart(section, history);
	}

	// Same paginated/sortable Tabulator setup as the table screen's own
	// spreadsheet (renderTable below), just scoped to one ticker's timeline
	// instead of every saved ticker — kept to PAGE_SIZE rows per page for the
	// same reason: an unbounded history (which this feature deliberately lets
	// grow — see Compact above) shouldn't make the calculator form itself grow
	// without bound.
	private renderHistoryTabulator(section: HTMLElement, ticker: string, history: HistoryEntry[]): void {
		const tableWrap = section.createDiv({ cls: "sv-table-wrap" });
		const rows: HistoryRow[] = history.map(buildHistoryRow);

		const deleteFormatter = (cell: CellComponent): HTMLElement => {
			const row = cell.getData() as HistoryRow;
			const actionsWrap = createSpan({ cls: "sv-actions-cell" });
			const deleteBtn = actionsWrap.createEl("button", { cls: "sv-icon-btn" });
			setIcon(deleteBtn.createSpan(), "trash-2");
			setTooltip(deleteBtn, "Delete this entry");
			deleteBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				new ConfirmModal(
					this.app,
					`Delete the ${window.moment(row.at).format("YYYY-MM-DD")} history entry for ${ticker}? This can't be undone.`,
					() => {
						const saved = this.plugin.data.getValuation(ticker);
						if (!saved?.history) return;
						const remaining = deleteHistoryEntry(saved.history, row.at);
						if (remaining.length > 0) saved.history = remaining;
						else delete saved.history;
						void this.plugin.data.persistValuations([ticker]);
						this.render();
					},
					"Delete"
				).open();
			});
			return actionsWrap;
		};

		const columns: ColumnDefinition[] = [
			{
				title: "",
				formatter: "responsiveCollapse",
				hozAlign: "center",
				headerSort: false,
				width: 30,
				minWidth: 30,
				responsive: 0,
			},
			{
				title: "Date",
				field: "at",
				sorter: "number",
				formatter: (cell) => window.moment(cell.getValue() as number).format("YYYY-MM-DD"),
				cssClass: "sv-num",
				responsive: 0,
			},
			{
				title: "DCF Bear",
				field: "dcfBearMos",
				formatter: ivMosFormatter<HistoryRow>("dcfBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DCF Base",
				field: "dcfBaseMos",
				formatter: ivMosFormatter<HistoryRow>("dcfBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "DCF Bull",
				field: "dcfBullMos",
				formatter: ivMosFormatter<HistoryRow>("dcfBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Reverse DCF",
				field: "impliedGrowth",
				formatter: (cell) => formatPercent((cell.getValue() as number) * 100, 1),
				cssClass: "sv-num",
				responsive: 2,
			},
			{
				title: "Ten Cap IV / MoS",
				field: "tenCapMos",
				formatter: ivMosFormatter<HistoryRow>("tenCapIv"),
				cssClass: "sv-num sv-scenario-col",
				responsive: 1,
			},
			{
				title: "Graham Bear",
				field: "grahamBearMos",
				formatter: ivMosFormatter<HistoryRow>("grahamBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Graham Base",
				field: "grahamBaseMos",
				formatter: ivMosFormatter<HistoryRow>("grahamBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "Graham Bull",
				field: "grahamBullMos",
				formatter: ivMosFormatter<HistoryRow>("grahamBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DDM Bear",
				field: "ddmBearMos",
				formatter: ivMosFormatter<HistoryRow>("ddmBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DDM Base",
				field: "ddmBaseMos",
				formatter: ivMosFormatter<HistoryRow>("ddmBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "DDM Bull",
				field: "ddmBullMos",
				formatter: ivMosFormatter<HistoryRow>("ddmBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Price",
				field: "price",
				formatter: (cell) => formatCurrency(cell.getValue() as number),
				cssClass: "sv-num",
				responsive: 1,
			},
			{
				title: "",
				field: "at",
				headerSort: false,
				hozAlign: "right",
				formatter: deleteFormatter,
				responsive: 0,
			},
		];

		this.historyTabulator = new Tabulator(tableWrap, {
			data: rows,
			columns,
			layout: "fitData",
			responsiveLayout: "collapse",
			columnDefaults: { hozAlign: "right", headerSort: true },
			initialSort: [{ column: "at", dir: "desc" }],
			pagination: true,
			paginationSize: StockValuationsView.PAGE_SIZE,
			paginationCounter: "rows",
		});
	}

	// "Fair value vs. price" over time — the first of the chart ideas in
	// ideas.md's "Charts off the valuation history data": price plus each
	// method's fair value, oldest to newest, so a ticker that's looked cheap
	// for a long stretch without re-rating reads as a wide, sustained gap
	// rather than something you'd have to compare table rows to notice. Same
	// per-method colors as METHODS (DCF/Graham/Ten Cap) elsewhere in the
	// plugin, so "which line is which method" reads the same way here as on
	// the distribution charts and the MoS-by-method chart.
	// One chart per scenario (Bull/Base/Bear), side by side in a row (same
	// .sv-chart-row/.sv-chart-col layout as the table screen's two overview
	// charts). X-axis is a true linear scale over epoch ms, not category/index
	// — history entries aren't evenly spaced in time (compaction alone
	// guarantees that), so index-based spacing would misrepresent the actual
	// gaps.
	private renderHistoryChart(parent: HTMLElement, history: HistoryEntry[]): void {
		const section = parent.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Fair value vs. price" });
		section.createEl("p", {
			cls: "sv-chart-caption",
			text: "Price against each method's fair value, spaced by actual elapsed time (not just entry order) — one chart per scenario, oldest to newest. A price line that stays well under fair value for a long stretch without the gap closing is the value-trap pattern this history table exists to surface. Ten Cap and price aren't scenario-specific, so those two lines are identical across all three charts.",
		});

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(section);
		const dcfMethod = METHODS.find((m) => m.label === "DCF")!;
		const grahamMethod = METHODS.find((m) => m.label === "Graham")!;
		const tenCapMethod = METHODS.find((m) => m.label === "Ten Cap")!;
		const ddmMethod = METHODS.find((m) => m.label === "DDM")!;

		// One shared legend above all three charts instead of tripling it —
		// the colors mean the same thing in every one.
		const legend = section.createDiv({ cls: "sv-grid-legend" });
		const legendItem = (color: string, text: string) => {
			const item = legend.createSpan({ cls: "sv-grid-legend-item" });
			const swatch = item.createSpan({ cls: "sv-grid-legend-swatch" });
			swatch.setCssStyles({ boxShadow: `inset 0 0 0 2px ${color}` });
			item.createSpan({ text });
		};
		legendItem(normalColor, "Price");
		legendItem(dcfMethod.color, "DCF");
		legendItem(grahamMethod.color, "Graham");
		legendItem(tenCapMethod.color, "Ten Cap");
		legendItem(ddmMethod.color, "DDM");

		const sorted = [...history].sort((a, b) => a.at - b.at);
		const firstAt = sorted[0].at;
		const lastAt = sorted[sorted.length - 1].at;
		// Chart.js's default tick generation for a linear scale rounds to "nice"
		// values, which tends to land outside the data's actual range and leave
		// visible padding before the first point and after the last. Forcing the
		// first/last ticks to the data's own extremes (evenly spaced by time
		// in between, not by entry count) keeps the axis flush with the data —
		// see xTickValues below.
		const X_TICK_COUNT = 4;
		const xTickValues =
			firstAt === lastAt
				? [firstAt]
				: Array.from({ length: X_TICK_COUNT }, (_, i) => firstAt + ((lastAt - firstAt) * i) / (X_TICK_COUNT - 1));
		const row = section.createDiv({ cls: "sv-chart-row" });

		for (const key of SCENARIO_KEYS) {
			const fields = HISTORY_SCENARIO_FIELDS[key];
			const col = row.createDiv({ cls: "sv-chart-col" });
			col.createEl("h4", { text: SCENARIO_LABELS[key] });
			const wrap = col.createDiv({ cls: "sv-chart-canvas-wrap" });
			wrap.setCssStyles({ height: "220px" });
			const canvas = wrap.createEl("canvas");

			const chart = new Chart(canvas, {
				type: "line",
				data: {
					datasets: [
						{
							label: "Price",
							data: sorted.map((e) => ({ x: e.at, y: e.price })),
							borderColor: normalColor,
							backgroundColor: normalColor,
							borderWidth: 2.5,
							pointRadius: 2,
							tension: 0.4,
						},
						{
							label: "DCF",
							data: sorted.map((e) => ({ x: e.at, y: e[fields.dcf] })),
							borderColor: dcfMethod.color,
							backgroundColor: dcfMethod.color,
							borderWidth: 1.5,
							pointRadius: 1.5,
							tension: 0.4,
						},
						{
							label: "Graham",
							data: sorted.map((e) => ({ x: e.at, y: e[fields.graham] })),
							borderColor: grahamMethod.color,
							backgroundColor: grahamMethod.color,
							borderWidth: 1.5,
							pointRadius: 1.5,
							tension: 0.4,
						},
						{
							label: "Ten Cap",
							data: sorted.map((e) => ({ x: e.at, y: e.tenCapIv })),
							borderColor: tenCapMethod.color,
							backgroundColor: tenCapMethod.color,
							borderWidth: 1.5,
							pointRadius: 1.5,
							tension: 0.4,
						},
						{
							label: "DDM",
							// NaN (Chart.js skips it, leaving a gap) for non-payers and
							// for entries recorded before the DDM existed.
							data: sorted.map((e) => ({ x: e.at, y: e[fields.ddm] ?? NaN })),
							borderColor: ddmMethod.color,
							backgroundColor: ddmMethod.color,
							borderWidth: 1.5,
							pointRadius: 1.5,
							tension: 0.4,
						},
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: "index", intersect: false },
					scales: {
						x: {
							type: "linear",
							min: firstAt,
							max: lastAt,
							bounds: "data",
							afterBuildTicks: (axis) => {
								axis.ticks = xTickValues.map((value) => ({ value }));
							},
							grid: { color: borderColor },
							ticks: {
								color: mutedColor,
								maxRotation: 0,
								callback: (v) => window.moment(Number(v)).format("MMM D"),
							},
						},
						y: {
							grid: { color: borderColor },
							ticks: { color: mutedColor, callback: (v) => formatCurrency(Number(v), 0) },
						},
					},
					plugins: {
						legend: { display: false },
						tooltip: {
							callbacks: {
								title: (items) => (items[0] ? window.moment(items[0].parsed.x).format("YYYY-MM-DD") : ""),
								label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(Number(ctx.parsed.y))}`,
							},
						},
					},
				},
			});
			this.historyCharts.push(chart);
		}
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

		const macroBtn = headerActions.createEl("button", { cls: "sv-docs-btn mod-cta sv-macro-btn" });
		setIcon(macroBtn.createSpan({ cls: "sv-docs-btn-icon" }), "trending-up");
		macroBtn.createSpan({ text: "Macro" });
		setTooltip(macroBtn, "Shiller CAPE and other market-wide valuation context — separate from per-ticker valuations");
		macroBtn.addEventListener("click", () => this.openMacro());

		const tickers = this.plugin.data.tickers();

		// Valuations don't update themselves when the market moves — flag
		// whichever tickers haven't had even a price refresh in a while, since
		// those MoS numbers are quietly drifting out of date. A ticker that's
		// never gone through "Refresh prices" has no confirmed-fresh price at
		// all, no matter how recently it was saved/edited — treat missing
		// lastPriceRefreshAt as infinitely stale (epoch 0) rather than
		// guessing from updatedAt, so it can't be masked by a recent edit.
		// Clicking sorts the table oldest-first (missing ones land first too),
		// so the badge stays useful even once you've acted on part of it.
		const STALE_MS = 7 * 24 * 60 * 60 * 1000;
		const lastKnownFreshAt = (t: string) => this.plugin.data.getValuation(t)?.lastPriceRefreshAt ?? 0;
		const staleCount = tickers.filter((t) => Date.now() - lastKnownFreshAt(t) > STALE_MS).length;
		const staleBtn = headerActions.createEl("button", { cls: "sv-docs-btn sv-stale-btn" });
		setIcon(staleBtn.createSpan({ cls: "sv-docs-btn-icon" }), "alert-triangle");
		staleBtn.createSpan({ text: `${staleCount} stale` });
		setTooltip(
			staleBtn,
			`${staleCount} ticker${staleCount === 1 ? "" : "s"} haven't had a price refresh in 7+ days — click to sort oldest first`
		);
		staleBtn.toggleClass("sv-hidden", staleCount === 0);
		staleBtn.addEventListener("click", () => {
			this.tabulator?.setSort("lastPriceRefreshAt", "asc");
		});

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

		const showResearch = this.isResearchLinksEnabled();
		const rows: TableRow[] = tickers.map((t) => buildTableRow(t, this.plugin.data.getValuation(t)!));

		const wrap = root.createDiv({ cls: "sv-table-wrap" });
		const tableEl = wrap.createDiv();
		const chartsWrap = root.createDiv();

		// Ten Cap has no scenario lever (shared facts only — see
		// SCENARIO_SPECIFIC_FIELDS), so it's a single merged IV/MoS column. DCF,
		// Graham, and DDM each get a "IV / MoS" group with Bear/Base/Bull
		// sub-columns — explicit labels, IV and MoS packed into the same cell
		// (ivMosFormatter) rather than IV living in its own column.
		// `responsive` (higher = hidden sooner) keeps Symbol, each method's Base
		// case, Price, and Actions on screen on a narrow iPad/phone width;
		// everything else tucks into the row's expandable "+" collapse list
		// (the toggle column below) rather than forcing horizontal scrolling.
		const columns: ColumnDefinition[] = [
			{
				title: "",
				formatter: "responsiveCollapse",
				hozAlign: "center",
				headerSort: false,
				width: 30,
				minWidth: 30,
				responsive: 0,
			},
			{
				title: "Symbol",
				field: "ticker",
				cssClass: "sv-symbol-cell",
				hozAlign: "left",
				headerHozAlign: "left",
				responsive: 0,
			},
			{
				title: "DCF Bear",
				field: "dcfBearMos",
				formatter: ivMosFormatter<TableRow>("dcfBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DCF Base",
				field: "dcfBaseMos",
				formatter: ivMosFormatter<TableRow>("dcfBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "DCF Bull",
				field: "dcfBullMos",
				formatter: ivMosFormatter<TableRow>("dcfBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Reverse DCF",
				field: "impliedGrowth",
				formatter: (cell) => formatPercent((cell.getValue() as number) * 100, 1),
				cssClass: "sv-num",
				responsive: 2,
			},
			{
				title: "Ten Cap IV / MoS",
				field: "tenCapMos",
				formatter: ivMosFormatter<TableRow>("tenCapIv"),
				cssClass: "sv-num sv-scenario-col",
				responsive: 1,
			},
			{
				title: "Ten Cap Yield",
				field: "tenCapYield",
				formatter: (cell) => formatPercent(cell.getValue() as number, 1),
				cssClass: "sv-num",
				responsive: 2,
			},
			{
				title: "Graham Bear",
				field: "grahamBearMos",
				formatter: ivMosFormatter<TableRow>("grahamBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Graham Base",
				field: "grahamBaseMos",
				formatter: ivMosFormatter<TableRow>("grahamBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "Graham Bull",
				field: "grahamBullMos",
				formatter: ivMosFormatter<TableRow>("grahamBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DDM Bear",
				field: "ddmBearMos",
				formatter: ivMosFormatter<TableRow>("ddmBearIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "DDM Base",
				field: "ddmBaseMos",
				formatter: ivMosFormatter<TableRow>("ddmBaseIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 1,
			},
			{
				title: "DDM Bull",
				field: "ddmBullMos",
				formatter: ivMosFormatter<TableRow>("ddmBullIv"),
				cssClass: "sv-num sv-scenario-col sv-subheader",
				responsive: 3,
			},
			{
				title: "Price",
				field: "price",
				formatter: (cell) => {
					const row = cell.getData() as TableRow;
					const el = cell.getElement();
					const stale = Date.now() - row.lastPriceRefreshAt > STALE_MS;
					el.classList.toggle("sv-price-stale", stale);
					if (stale) setTooltip(el, "Not refreshed in 7+ days — click “Refresh prices” above");
					return formatCurrency(cell.getValue() as number);
				},
				cssClass: "sv-num",
				responsive: 1,
			},
			{
				title: "Updated",
				field: "updatedAt",
				sorter: "number",
				formatter: (cell) => window.moment(cell.getValue() as number).format("YYYY-MM-DD"),
				cssClass: "sv-num sv-updated-cell",
				responsive: 2,
			},
			// Not shown as its own column (the "Updated" column above already
			// covers last-edit date) — kept in the column list only so the
			// stale-price badge can sort by it.
			{
				title: "Price refreshed",
				field: "lastPriceRefreshAt",
				sorter: "number",
				visible: false,
			},
		];
		if (showResearch) {
			columns.push({
				title: "Research",
				field: "researchNotePath",
				hozAlign: "left",
				headerHozAlign: "left",
				headerSort: false,
				formatter: this.researchFormatter,
				responsive: 2,
			});
		}
		columns.push({
			title: "Actions",
			field: "ticker",
			headerSort: false,
			hozAlign: "right",
			formatter: this.actionsFormatter,
			responsive: 0,
		});

		// Charts stay scoped to whatever page is currently visible, same as
		// before Tabulator — re-render them on every page/sort change rather
		// than once up front.
		const renderChartsForCurrentPage = () => {
			this.destroyChart();
			chartsWrap.empty();
			const activeTickers = (this.tabulator?.getData("visible") ?? []).map((r) => (r as TableRow).ticker);
			// Distribution is a compact overview and Ten Cap yield is a taller
			// per-ticker breakdown — side by side makes better use of width
			// than stacking two sections of very different heft.
			const row = chartsWrap.createDiv({ cls: "sv-chart-row" });
			this.renderMosDistributionChart(row.createDiv({ cls: "sv-chart-col" }), activeTickers);
			this.renderYieldSpreadChart(row.createDiv({ cls: "sv-chart-col" }), activeTickers);
		};

		this.tabulator = new Tabulator(tableEl, {
			data: rows,
			columns,
			// "fitDataStretch" would force the LAST column to absorb all
			// leftover container width (see Tabulator's fitDataStretch mode) —
			// wrong here since the last column is the blank-title, icon-only
			// actions column. "fitData" sizes every column to its content and
			// leaves any excess width as plain background instead.
			layout: "fitData",
			// Collapses lower-priority columns (see each column's `responsive`
			// value above) into the row's expandable "+" list once the table no
			// longer fits — otherwise a table this wide (three scenario columns
			// per method) is unusable on an iPad/phone-width screen.
			responsiveLayout: "collapse",
			columnDefaults: { hozAlign: "right", headerSort: true },
			initialSort: [{ column: "ticker", dir: "asc" }],
			pagination: true,
			paginationSize: StockValuationsView.PAGE_SIZE,
			paginationCounter: "rows",
		});
		this.tabulator.on("rowClick", (_e, row) => {
			this.editValuation((row.getData() as TableRow).ticker);
		});
		// dataSorted/pageLoaded fire mid-pipeline (sort resolves before the
		// page stage re-slices and the DOM re-renders), so getData("visible")
		// there can still reflect the previous page. renderComplete fires
		// once the whole sort+page pipeline has settled and the DOM matches.
		this.tabulator.on("tableBuilt", renderChartsForCurrentPage);
		this.tabulator.on("renderComplete", renderChartsForCurrentPage);
	}

	// Builds either the "linked" state (open/unlink buttons) or the "link a
	// note" button — same as the old renderResearchCell, adapted to return a
	// node for Tabulator to insert rather than building into a <td> directly.
	private researchFormatter = (cell: CellComponent): HTMLElement | string => {
		const ticker = (cell.getData() as TableRow).ticker;
		const saved = this.plugin.data.getValuation(ticker);
		if (!saved) return "";
		const path = saved.researchNotePath;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;

		if (path && file instanceof TFile) {
			const wrap = createSpan();
			wrap.addClass("sv-research-linked");

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
						// Research links aren't in the history note — nothing to rewrite.
						void this.plugin.data.persistValuations([]);
						this.render();
					},
					"Remove link"
				).open();
			});
			return wrap;
		}

		const linkBtn = createEl("button");
		linkBtn.addClass("sv-research-empty");
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
		return linkBtn;
	};

	// Edit/delete icon buttons — same as the old actions <td>, wrapped in a
	// span (sv-actions-cell already lays out as a right-justified flex row)
	// so it works as a single returned node for Tabulator's formatter.
	private actionsFormatter = (cell: CellComponent): HTMLElement => {
		const ticker = (cell.getData() as TableRow).ticker;
		const wrap = createSpan();
		wrap.addClass("sv-actions-cell");

		const editBtn = wrap.createEl("button", { cls: "sv-icon-btn" });
		setIcon(editBtn.createSpan(), "pencil");
		setTooltip(editBtn, "Edit");
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.editValuation(ticker);
		});

		const deleteBtn = wrap.createEl("button", { cls: "sv-icon-btn" });
		setIcon(deleteBtn.createSpan(), "trash-2");
		setTooltip(deleteBtn, "Delete");
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.deleteValuation(ticker);
		});

		return wrap;
	};

	// ---------------------------------------------------------------------
	// Standalone section: how many tickers on this page fall into each
	// Base-MoS range, broken out per method (DCF/Graham/Ten Cap don't move
	// together, so blending them into one number would hide real
	// disagreement) — replaces the old per-ticker MoS-by-method chart (now
	// redundant with the table's own DCF/Graham/Ten Cap columns) with a
	// shape-of-the-list view: is the list skewing cheap or expensive right
	// now, at a glance, rather than ticker by ticker.
	// ---------------------------------------------------------------------
	private renderMosDistributionChart(root: HTMLElement, tickers: string[]): void {
		root.createEl("h3", { text: "Margin of safety distribution" });
		root.createEl("p", {
			cls: "sv-chart-caption",
			text: "How many tickers fall into each range of Base margin of safety, one bar per method. Hover a bar to see which tickers.",
		});

		const wrap = root.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.setCssStyles({ height: "260px" });
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);

		// Fixed, symmetric 25pp-wide buckets — simple and legible for a
		// watchlist-sized list; not worth making configurable.
		const BUCKETS: { label: string; min: number; max: number }[] = [
			{ label: "< -50%", min: -Infinity, max: -50 },
			{ label: "-50 to -25%", min: -50, max: -25 },
			{ label: "-25 to 0%", min: -25, max: 0 },
			{ label: "0 to 25%", min: 0, max: 25 },
			{ label: "25 to 50%", min: 25, max: 50 },
			{ label: "> 50%", min: 50, max: Infinity },
		];
		const bucketIndexOf = (v: number) => {
			const i = BUCKETS.findIndex((b) => v >= b.min && v < b.max);
			return i === -1 ? BUCKETS.length - 1 : i;
		};

		// tickersByMethodBucket[method][bucket] = tickers landing there — kept
		// per method (not merged) since a ticker can be cheap by one method
		// and expensive by another; the tooltip and bar heights both read off
		// this directly, never an average across methods.
		const tickersByMethodBucket: string[][][] = METHODS.map(() => BUCKETS.map(() => []));
		for (const t of tickers) {
			const { base } = this.plugin.data.getValuation(t)!.scenarios;
			METHODS.forEach((m, methodIndex) => {
				const v = base.results[m.mosKey];
				if (!isFinite(v)) return;
				tickersByMethodBucket[methodIndex][bucketIndexOf(v)].push(t);
			});
		}

		this.charts.push(
			new Chart(canvas, {
				type: "bar",
				data: {
					labels: BUCKETS.map((b) => b.label),
					datasets: METHODS.map((m, methodIndex) => ({
						label: m.label,
						data: tickersByMethodBucket[methodIndex].map((ts) => ts.length),
						backgroundColor: m.color,
						borderRadius: 3,
					})),
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					scales: {
						x: { grid: { display: false }, ticks: { color: normalColor } },
						y: {
							beginAtZero: true,
							ticks: { color: mutedColor, precision: 0 },
							grid: { color: borderColor },
						},
					},
					plugins: {
						legend: { position: "top", labels: { color: mutedColor } },
						tooltip: {
							callbacks: {
								label: (ctx) => {
									const ts = tickersByMethodBucket[ctx.datasetIndex][ctx.dataIndex];
									return `${ctx.dataset.label}: ${ts.length ? ts.join(", ") : "none"}`;
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
	// Diverging bar at 0, same visual language as the MoS chart above. Ten Cap
	// has no scenario-specific input (see SCENARIO_SPECIFIC_FIELDS), so this
	// chart is scenario-invariant by construction — reads straight off Base.
	// ---------------------------------------------------------------------

	private renderYieldSpreadChart(root: HTMLElement, tickers: string[]): void {
		root.createEl("h3", { text: "Ten Cap yield vs. bond yield" });

		const wrap = root.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.setCssStyles({ height: `${Math.max(180, tickers.length * 32 + 50)}px` });
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(root);
		const tenCap = METHODS.find((m) => m.label === "Ten Cap")!;

		const spreadOf = (t: string) => {
			const state = this.plugin.data.getValuation(t)!.scenarios.base.state;
			const yield_ = this.plugin.data.getValuation(t)!.scenarios.base.results.tenCapYield;
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
									const state = this.plugin.data.getValuation(ticker)!.scenarios.base.state;
									const yield_ = this.plugin.data.getValuation(ticker)!.scenarios.base.results.tenCapYield;
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

	// Per-scenario colors, matching the form's own Bull/Base/Bear tab colors
	// (see .sv-scenario-tab-*.is-active in styles.css) — shared by the
	// single-ticker MoS chart and the sensitivity grid markers so "which case"
	// reads the same way everywhere on the form screen.
	private scenarioColors(el: HTMLElement): Record<ScenarioKey, string> {
		const styles = getComputedStyle(el);
		return {
			bull: styles.getPropertyValue("--sv-pos").trim() || "#3aa55c",
			base: styles.getPropertyValue("--interactive-accent").trim() || "#4c8bf5",
			bear: styles.getPropertyValue("--sv-neg").trim() || "#c2564f",
		};
	}

	// Color for the sensitivity grid's "nearest to today's price" marker —
	// deliberately not one of the scenario colors above, since that marker
	// isn't tied to any one case.
	private nearestPriceColor(el: HTMLElement): string {
		return getComputedStyle(el).getPropertyValue("--color-yellow").trim() || "#d4a72c";
	}

	private destroyChart(): void {
		for (const chart of this.charts) chart.destroy();
		this.charts = [];
		this.stockMosChart?.destroy();
		this.stockMosChart = null;
		for (const chart of this.historyCharts) chart.destroy();
		this.historyCharts = [];
	}

	private destroyTabulator(): void {
		this.tabulator?.destroy();
		this.tabulator = null;
		this.historyTabulator?.destroy();
		this.historyTabulator = null;
		this.dcfSensitivityTabulator?.destroy();
		this.dcfSensitivityTabulator = null;
		this.grahamSensitivityTabulator?.destroy();
		this.grahamSensitivityTabulator = null;
		this.tenCapSensitivityTabulator?.destroy();
		this.tenCapSensitivityTabulator = null;
		this.ddmSensitivityTabulator?.destroy();
		this.ddmSensitivityTabulator = null;
	}

	// ---------------------------------------------------------------------
	// Research links — an optional, opt-in column. The linked file's
	// contents are never read; the plugin only stores and opens a path.
	// ---------------------------------------------------------------------

	private isResearchLinksEnabled(): boolean {
		return researchLinksActive(this.plugin.data.settings);
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
					const folder = this.plugin.data.settings.researchNotesFolder;
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
		const saved = this.plugin.data.getValuation(ticker);
		if (!saved) return;
		saved.researchNotePath = path;
		// Research links aren't in the history note — nothing to rewrite.
		void this.plugin.data.persistValuations([]);
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

		const historyDoc = wrap.createDiv({ cls: "sv-docs-section" });
		historyDoc.createEl("h3", { text: VALUATION_HISTORY_DOC.title });
		for (const p of VALUATION_HISTORY_DOC.body) {
			historyDoc.createEl("p", { text: p });
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

		const support = wrap.createEl("p", { cls: "sv-changelog-support" });
		support.createSpan({ text: "☕ Enjoying the plugin? " });
		support.createEl("a", {
			text: "Buy me a coffee",
			href: "https://buymeacoffee.com/fernanluyano",
			cls: "external-link",
		});
	}

	// ---------------------------------------------------------------------
	// Macro screen — Shiller CAPE and market-wide context, separate from any
	// single ticker's valuation. No cheap/fair/expensive verdict is rendered
	// here on purpose (see plan.md) — just the current numbers and the raw
	// history, left for the user to judge.
	// ---------------------------------------------------------------------

	private renderMacroScreen(root: HTMLElement): void {
		const backRow = root.createDiv({ cls: "sv-back-row" });
		const backBtn = backRow.createEl("button", { text: "← Back to table", cls: "sv-link-btn" });
		backBtn.addEventListener("click", () => this.backToTable());

		const rows = this.plugin.data.getCachedMacroData();

		const header = root.createDiv({ cls: "sv-table-header" });
		header.createEl("h2", { text: "Macro" });
		if (rows && rows.length > 0) {
			// "Last updated" here means the most recent data point's own date,
			// not when this plugin last fetched it — the dataset itself only
			// moves monthly (and only when the upstream fork's Action is
			// manually re-run), so that's the freshness that actually matters.
			const latestMonth = rows.reduce((max, r) => (r.month > max ? r.month : max), rows[0].month);
			header.createEl("p", {
				cls: "sv-chart-caption",
				text: `Last updated: ${window.moment(latestMonth).format("MMMM YYYY")} — Shiller's data updates monthly, which is plenty for a value-investing view of the overall market.`,
			});
		}

		const body = root.createDiv({ cls: "sv-macro-body" });
		if (rows && rows.length > 0) {
			this.renderMacroContent(body, rows);
		} else {
			body.createEl("p", { cls: "sv-empty-state", text: "Loading macro data…" });
		}
	}

	// Fetches macro data if the cache is missing/stale (respects the 24h TTL —
	// no manual override; this data only moves when the upstream fork's
	// GitHub Action is re-run, which isn't something to expose a button for),
	// and re-renders the macro screen with whatever comes back. Guards
	// against clobbering a screen the user has since navigated away from.
	private async loadMacroData(): Promise<void> {
		if (this.macroRefreshInFlight) return;
		this.macroRefreshInFlight = true;
		try {
			const rows = await this.plugin.data.refreshMacroData();
			if (!rows || rows.length === 0) {
				new Notice("Couldn't load macro data — check your connection and try again.");
			}
		} finally {
			this.macroRefreshInFlight = false;
		}
		if (this.screen === "macro") this.render();
	}

	// Current-values readout plus two line charts (CAPE/TR-CAPE, and the 10y
	// Treasury yield) over the same rolling window fetchMacroData filtered to.
	// Same "?" help-button pattern as the calculator form's own fields
	// (HELP_TEXT-driven, hover tooltip + tap-to-show Notice for mobile) —
	// shared by the macro screen's stats and chart headings.
	private appendHelpBtn(container: HTMLElement, helpKey: string): void {
		const helpText = HELP_TEXT[helpKey];
		if (!helpText) return;
		const helpBtn = container.createSpan({ cls: "sv-help-btn", text: "?" });
		helpBtn.setAttr("role", "button");
		helpBtn.setAttr("tabindex", "0");
		setTooltip(helpBtn, helpText, { placement: "top" });
		const showHelp = (e: Event) => {
			e.preventDefault();
			new Notice(helpText, 8000);
		};
		helpBtn.addEventListener("click", showHelp);
		helpBtn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") showHelp(e);
		});
	}

	private renderMacroContent(body: HTMLElement, rows: MacroRow[]): void {
		const sorted = [...rows].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
		const latest = sorted[sorted.length - 1];

		const stats = body.createDiv({ cls: "sv-macro-stats" });
		const stat = (label: string, value: string, helpKey: string) => {
			const cell = stats.createDiv({ cls: "sv-macro-stat" });
			const labelGroup = cell.createDiv({ cls: "sv-field-label-group" });
			labelGroup.createDiv({ cls: "sv-macro-stat-label", text: label });
			this.appendHelpBtn(labelGroup, helpKey);
			cell.createDiv({ cls: "sv-macro-stat-value", text: value });
		};
		stat("CAPE", latest.cape !== null ? latest.cape.toFixed(2) : "—", "cape");
		stat("TR-CAPE", latest.trCape !== null ? latest.trCape.toFixed(2) : "—", "trCape");
		stat("Dividend yield", latest.dividendYield !== null ? formatPercent(latest.dividendYield * 100) : "—", "dividendYield");
		stat("10y Treasury yield", latest.tenYearYield !== null ? formatPercent(latest.tenYearYield) : "—", "tenYearYield");

		const monthToMs = (month: string) => window.moment(month, "YYYY-MM-DD").valueOf();
		const { mutedColor, borderColor } = this.chartThemeColors(body);
		const firstAt = monthToMs(sorted[0].month);
		const lastAt = monthToMs(sorted[sorted.length - 1].month);
		const X_TICK_COUNT = 4;
		const xTickValues =
			firstAt === lastAt
				? [firstAt]
				: Array.from({ length: X_TICK_COUNT }, (_, i) => firstAt + ((lastAt - firstAt) * i) / (X_TICK_COUNT - 1));

		const row = body.createDiv({ cls: "sv-chart-row" });

		// Fixed hex colors, not theme-derived (--text-normal/--text-muted are
		// both near-white in dark mode and render as indistinguishable gray
		// lines) — same palette METHODS uses elsewhere so "which line is which"
		// stays visually consistent with the rest of the plugin.
		const capeCol = row.createDiv({ cls: "sv-chart-col" });
		capeCol.createEl("h3", { text: "CAPE over time" });
		this.renderMacroLineChart(
			capeCol,
			sorted,
			[
				{ label: "CAPE", field: "cape", color: "#4c8bf5" },
				{ label: "TR-CAPE", field: "trCape", color: "#f2a541" },
			],
			(v) => v.toFixed(1),
			{ firstAt, lastAt, xTickValues, mutedColor, borderColor }
		);

		const yieldCol = row.createDiv({ cls: "sv-chart-col" });
		yieldCol.createEl("h3", { text: "10y Treasury yield over time" });
		this.renderMacroLineChart(
			yieldCol,
			sorted,
			[{ label: "10y yield", field: "tenYearYield", color: "#8d6fd1" }],
			(v) => formatPercent(v, 1),
			{ firstAt, lastAt, xTickValues, mutedColor, borderColor }
		);

		// Nominal vs. inflation-adjusted price — the gap between the two lines
		// is exactly what "real" means: how much of the nominal index's rise is
		// actual growth vs. just inflation. This is also what CAPE's own price
		// side is computed from (real, not nominal). Only the last 10 years,
		// not the full 40-year window the other two charts use — the full
		// window compresses the recent, more relevant stretch into an
		// unreadably short segment.
		const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;
		const last10y = sorted.filter((r) => monthToMs(r.month) >= lastAt - TEN_YEARS_MS);
		const sp500FirstAt = monthToMs(last10y[0].month);
		const sp500XTickValues =
			sp500FirstAt === lastAt
				? [sp500FirstAt]
				: Array.from(
						{ length: X_TICK_COUNT },
						(_, i) => sp500FirstAt + ((lastAt - sp500FirstAt) * i) / (X_TICK_COUNT - 1)
				  );

		const sp500Row = body.createDiv({ cls: "sv-chart-row" });
		const sp500Col = sp500Row.createDiv({ cls: "sv-chart-col sv-chart-col-half" });
		const sp500Heading = sp500Col.createDiv({ cls: "sv-field-label-group" });
		sp500Heading.createEl("h3", { text: "S&P 500: nominal vs. inflation-adjusted (10y)" });
		this.appendHelpBtn(sp500Heading, "realPrice");
		sp500Col.createEl("p", {
			cls: "sv-chart-caption",
			text: "The gap between the two lines is inflation — the real line is what CAPE's own price side is computed from, not the nominal one.",
		});
		this.renderMacroLineChart(
			sp500Col,
			last10y,
			[
				{ label: "S&P 500 (nominal)", field: "sp500", color: "#4c8bf5" },
				{ label: "S&P 500 (real)", field: "realPrice", color: "#f2a541" },
			],
			(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
			{ firstAt: sp500FirstAt, lastAt, xTickValues: sp500XTickValues, mutedColor, borderColor }
		);
	}

	private renderMacroLineChart(
		col: HTMLElement,
		sorted: MacroRow[],
		series: { label: string; field: "cape" | "trCape" | "tenYearYield" | "sp500" | "realPrice"; color: string }[],
		formatY: (v: number) => string,
		axis: { firstAt: number; lastAt: number; xTickValues: number[]; mutedColor: string; borderColor: string }
	): void {
		const wrap = col.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.setCssStyles({ height: "220px" });
		const canvas = wrap.createEl("canvas");

		const chart = new Chart(canvas, {
			type: "line",
			data: {
				datasets: series.map((s) => ({
					label: s.label,
					data: sorted
						.filter((r) => r[s.field] !== null)
						.map((r) => ({ x: window.moment(r.month, "YYYY-MM-DD").valueOf(), y: r[s.field] as number })),
					borderColor: s.color,
					backgroundColor: s.color,
					borderWidth: 2,
					pointRadius: 0,
					tension: 0.2,
				})),
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: "index", intersect: false },
				scales: {
					x: {
						type: "linear",
						min: axis.firstAt,
						max: axis.lastAt,
						bounds: "data",
						afterBuildTicks: (a) => {
							a.ticks = axis.xTickValues.map((value) => ({ value }));
						},
						grid: { color: axis.borderColor },
						ticks: {
							color: axis.mutedColor,
							maxRotation: 0,
							callback: (v) => window.moment(Number(v)).format("YYYY"),
						},
					},
					y: {
						grid: { color: axis.borderColor },
						ticks: { color: axis.mutedColor, callback: (v) => formatY(Number(v)) },
					},
				},
				plugins: {
					legend: {
						display: series.length > 1,
						labels: { color: axis.mutedColor },
					},
					tooltip: {
						callbacks: {
							title: (items) => (items[0] ? window.moment(items[0].parsed.x).format("YYYY-MM") : ""),
							label: (ctx) => `${ctx.dataset.label}: ${formatY(Number(ctx.parsed.y))}`,
						},
					},
				},
			},
		});
		this.charts.push(chart);
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
		this.scenarioTabsWrapEl = hero.createDiv();
		this.renderScenarioTabs(this.scenarioTabsWrapEl);

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
		this.layoutEl = layout;
		this.renderFormBody(layout);

		// --- MoS by method (single ticker) — same chart as the overview,
		// scoped to this ticker, above the sensitivity grids. ---
		this.stockMosChartWrapEl = this.renderStockMosChartShell(root);

		// --- Sensitivity grids (own section — not squeezed into the
		// already-dense sticky Results column above). One shared intro covers
		// what's true of every grid below (the markers, the "does this method
		// fit?" caveat); each grid's own caption below that only needs to say
		// which two inputs it varies. ---
		const sensitivitySection = root.createDiv({ cls: "sv-chart-section" });
		this.sensitivitySectionEl = sensitivitySection;
		sensitivitySection.createEl("h3", { text: "Sensitivity" });
		sensitivitySection.createEl("p", {
			cls: "sv-chart-caption",
			text: 'Fair value across a small, fixed range of each method\'s key assumptions, instead of one point estimate. Every grid below marks each case\'s current inputs in its own color (see legend), plus the market-implied cell in yellow; overlapping markers stack as rings. Non-scenario inputs are held at the Base tab\'s values, so grids don\'t change when you switch tabs. Only meaningful if the method itself is a good fit for the business being valued — see "Does this method fit?" on the Help & methodology screen (← Back to table, then Help).',
		});

		this.dcfSensitivityWrapEl = this.renderSensitivityGridShell(
			sensitivitySection,
			"DCF",
			"WACC × years 1-5 growth, holding the rest of the DCF inputs steady."
		);
		this.grahamSensitivityWrapEl = this.renderSensitivityGridShell(
			sensitivitySection,
			"Graham",
			"AAA bond yield × expected EPS growth, holding EPS steady."
		);
		this.tenCapSensitivityWrapEl = this.renderSensitivityGridShell(
			sensitivitySection,
			"Ten Cap",
			"Maintenance-capex split × how far reported capex might swing from what's on the filing, holding operating cash flow and shares steady."
		);
		this.ddmSensitivityWrapEl = this.renderSensitivityGridShell(
			sensitivitySection,
			"DDM",
			"Cost of equity × dividend growth, holding dividends per share steady. \"—\" where growth is at or above cost of equity, where the model breaks down."
		);

		// --- Valuation history — last on the page, on purpose: it's a record
		// of the past, not something that shapes today's inputs above. ---
		this.renderHistorySection(root);

		this.recalculate();
	}

	// Builds the two-column form body (input fields + sticky Summary panel) —
	// everything inside `layout` that actually depends on which scenario tab
	// is active (field values, editable-vs-inherited styling, "Fetch data"
	// availability, the Summary numbers). Split out from renderForm so
	// switchScenario() can rebuild just this on a tab click, without tearing
	// down and rebuilding the MoS chart or sensitivity grids below — those no
	// longer vary by active tab (they always show every case at once), so
	// there's nothing in them for a tab switch to redraw.
	private renderFormBody(layout: HTMLElement): void {
		layout.empty();
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
		// Every field it can fill is a shared fact, not a scenario assumption —
		// same restriction as those fields' inputs, so it's only usable from Base.
		if (this.activeScenario === "base") {
			setTooltip(
				fetchAllBtn,
				"Fills blank or zero fields below with price (Yahoo Finance) and fundamentals (SEC EDGAR). Never overwrites a value you've already entered."
			);
			fetchAllBtn.addEventListener("click", () => {
				void this.fetchAllIntoForm(fetchAllBtn);
			});
		} else {
			fetchAllBtn.disabled = true;
			setTooltip(fetchAllBtn, "Switch to the Base tab to fetch data.");
		}
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

		// --- DDM section ---
		const ddm = this.section(formCol, "DDM (dividend payers only)");
		this.field(ddm, "TTM dividends per share", "dps", "number", "perShare");
		this.field(ddm, "Expected dividend growth", "ddmGrowth", "number", "percent");

		// --- Results (sticky) ---
		resultsCol.createEl("h3", { text: "Summary" });
		this.resultsEl = resultsCol.createDiv({ cls: "sv-results" });

		this.validationErrorsEl = resultsCol.createDiv({ cls: "sv-validation-errors" });
		this.saveBtn = resultsCol.createEl("button", { text: "Save", cls: "mod-cta sv-insert-btn" });
		this.saveBtn.addEventListener("click", () => this.saveValuation());

		this.refreshResultsDisplay();
	}

	// Header/caption shell for the single-ticker MoS-by-method chart above the
	// sensitivity grids. Returns the (initially empty) canvas-wrap container
	// renderStockMosChart() draws into.
	private renderStockMosChartShell(parent: HTMLElement): HTMLElement {
		const section = parent.createDiv({ cls: "sv-chart-section" });
		section.createEl("h3", { text: "Margin of safety by method" });
		section.createEl("p", {
			cls: "sv-chart-caption",
			text: "Bull/Base/Bear margin of safety for each method, plus the average across all three. Always shows all three cases, regardless of which scenario tab is active. Ten Cap has no scenario-specific input, so its three bars are always equal. Hover a bar for exact numbers and intrinsic value.",
		});
		const wrap = section.createDiv({ cls: "sv-chart-canvas-wrap" });
		wrap.setCssStyles({ height: "280px" });
		return wrap;
	}

	// Rebuilt on every keystroke (see recalculate()) from all three of
	// this.scenarios (not this.results/this.state, which follow whichever
	// scenario tab is active) — one grouped set of Bull/Base/Bear bars per
	// method, so the chart always shows every case at once and never changes
	// when the Bull/Base/Bear tab does. Categories are methods (DCF/Graham/Ten
	// Cap/Average); scenario is the grouping dimension, colored to match the
	// form's own Bull/Base/Bear tab colors.
	private renderStockMosChart(): void {
		this.stockMosChart?.destroy();
		this.stockMosChart = null;

		const wrap = this.stockMosChartWrapEl;
		wrap.empty();
		const canvas = wrap.createEl("canvas");

		const { mutedColor, normalColor, borderColor } = this.chartThemeColors(wrap);
		const scenarioColors = this.scenarioColors(wrap);

		const MOS_FLOOR = -100;
		const clampMos = (v: number) => Math.max(v, MOS_FLOOR);
		const avgOf = (vals: number[]) => {
			const finite = vals.filter((v) => isFinite(v));
			return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
		};

		const labels = [...METHODS.map((m) => m.label), "Average"];

		// mosByScenario[key] / ivByScenario[key] are parallel to `labels` —
		// one entry per method plus one for the average.
		const mosByScenario: Record<ScenarioKey, number[]> = {} as Record<ScenarioKey, number[]>;
		const ivByScenario: Record<ScenarioKey, number[]> = {} as Record<ScenarioKey, number[]>;
		for (const key of SCENARIO_KEYS) {
			const r = this.scenarios[key].results;
			const methodMos = METHODS.map((m) => r[m.mosKey]);
			const methodIv = METHODS.map((m) => r[m.ivKey]);
			mosByScenario[key] = [...methodMos, avgOf(methodMos)];
			ivByScenario[key] = [...methodIv, avgOf(methodIv)];
		}

		const datasets = SCENARIO_KEYS.map((key) => ({
			label: SCENARIO_LABELS[key],
			data: mosByScenario[key].map((v) => (isFinite(v) ? clampMos(v) : null)),
			backgroundColor: scenarioColors[key],
			borderRadius: 3,
			categoryPercentage: 0.7,
		}));

		const allValues = SCENARIO_KEYS.flatMap((key) => mosByScenario[key]).filter((v) => isFinite(v));
		const maxAbs = allValues.length ? Math.max(...allValues.map((v) => Math.abs(clampMos(v)))) : 0;
		const axisBound = Math.max(25, Math.ceil(maxAbs / 25) * 25);

		const price = this.num("price");
		const priceStr = price > 0 ? formatCurrency(price) : "—";

		this.stockMosChart = new Chart(canvas, {
			type: "bar",
			data: { labels, datasets },
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
								const key = SCENARIO_KEYS[ctx.datasetIndex];
								const idx = ctx.dataIndex;
								const mos = mosByScenario[key][idx];
								const iv = ivByScenario[key][idx];
								const mosStr = isFinite(mos) ? formatPercent(mos) : "—";
								const ivStr = isFinite(iv) ? formatCurrency(iv) : "—";
								return `${labels[idx]} (${SCENARIO_LABELS[key]}): ${mosStr} (IV ${ivStr}, Price ${priceStr})`;
							},
						},
					},
				},
			},
		});
	}

	// Header/caption/legend shell for one sensitivity grid, nested under the
	// shared "Sensitivity" section above. Returns the (initially empty)
	// container the caller renders its Tabulator instance into.
	private renderSensitivityGridShell(parent: HTMLElement, methodLabel: string, caption: string): HTMLElement {
		const wrap = parent.createDiv({ cls: "sv-sensitivity-grid" });
		wrap.createEl("h4", { text: `${methodLabel} sensitivity` });
		wrap.createEl("p", { cls: "sv-chart-caption", text: caption });
		const legend = wrap.createDiv({ cls: "sv-grid-legend" });
		const legendItem = (color: string, text: string) => {
			const item = legend.createSpan({ cls: "sv-grid-legend-item" });
			const swatch = item.createSpan({ cls: "sv-grid-legend-swatch" });
			swatch.setCssStyles({ boxShadow: `inset 0 0 0 2px ${color}` });
			item.createSpan({ text });
		};
		const scenarioColors = this.scenarioColors(wrap);
		for (const key of SCENARIO_KEYS) {
			legendItem(scenarioColors[key], `${SCENARIO_LABELS[key]}'s current inputs`);
		}
		legendItem(this.nearestPriceColor(wrap), "What the market is implying (nearest to today's price)");
		return wrap.createDiv();
	}

	// The bull/base/bear tab strip on the form screen — switches which
	// scenario's fields are shown/edited. See switchScenario().
	private renderScenarioTabs(container: HTMLElement): void {
		const tabs = container.createDiv({ cls: "sv-scenario-tabs" });
		for (const key of SCENARIO_KEYS) {
			const tab = tabs.createEl("button", {
				text: SCENARIO_LABELS[key],
				cls: `sv-scenario-tab sv-scenario-tab-${key}${key === this.activeScenario ? " is-active" : ""}`,
			});
			setTooltip(tab, SCENARIO_TOOLTIPS[key]);
			tab.addEventListener("click", () => this.switchScenario(key));
		}
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
		// On Bull/Bear, make the handful of fields you can actually edit here
		// (the growth assumptions) visually pop against the read-only,
		// inherited-from-Base majority — colored to match the active tab.
		if (this.activeScenario !== "base" && SCENARIO_SPECIFIC_FIELDS.has(key)) {
			wrap.addClass("sv-field-editable-scenario");
			wrap.addClass(`sv-field-editable-${this.activeScenario}`);
		}
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
			input.placeholder = `${this.plugin.data.settings.taxRate} (Settings default)`;
		}

		input.value = isFormattedNumber ? formatWithCommas(this.state[key]) : this.state[key];

		// Shared facts (everything but the growth assumptions) are only
		// editable from the Base tab — on Bull/Bear they're shown read-only,
		// inherited live from whatever Base holds (kept in sync by
		// setStateField, so the value here is already correct).
		const inherited = this.activeScenario !== "base" && !SCENARIO_SPECIFIC_FIELDS.has(key);

		if (options?.readOnly || inherited) {
			// No focus/blur/input wiring at all — just a live display that
			// recalculate() (computed fields) or setStateField() (inherited
			// fields) keeps in sync.
			input.readOnly = true;
			input.tabIndex = -1;
			input.addClass("sv-readonly-field");
			setTooltip(
				input,
				options?.readOnly
					? "Computed as price × shares — not an input you can edit."
					: "Shared across every scenario — edit it from the Base tab."
			);
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
				this.setStateField(key, cleaned);
			} else if (type === "text") {
				const upper = input.value.toUpperCase();
				if (upper !== input.value) input.value = upper;
				this.setStateField(key, upper);
			} else {
				this.setStateField(key, input.value);
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
	// Money/share scale is shared across all three scenarios (it's not a
	// bull/base/bear assumption), so every scenario's typed values need
	// rescaling here, not just the one on screen — otherwise a scale switch
	// silently leaves the other two tabs' numbers off by the old ratio.
	private rescaleFields(keys: ReadonlySet<keyof FormState>, oldScale: ScaleUnit, newScale: ScaleUnit): void {
		if (oldScale === newScale) return;
		const ratio = SCALE_MULTIPLIERS[oldScale] / SCALE_MULTIPLIERS[newScale];
		for (const scenario of Object.values(this.scenarios)) {
			for (const key of keys) {
				const raw = scenario.state[key];
				const parsed = parseFloat(raw);
				if (raw.trim() === "" || isNaN(parsed)) continue;
				scenario.state[key] = this.roundForField(parsed * ratio);
			}
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
		return numFromState(this.state, key, this.moneyScale, this.sharesScale, this.plugin.data.settings.taxRate);
	}

	// Like num(), but for a named scenario instead of always the active one —
	// used by the sensitivity grids, which now read every scenario's inputs at
	// once regardless of which tab is on screen (see renderDcfSensitivityGrid
	// etc.).
	private numOf(key: ScenarioKey, field: keyof FormState): number {
		return numFromState(this.scenarios[key].state, field, this.moneyScale, this.sharesScale, this.plugin.data.settings.taxRate);
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

	// The single entry point for pulling in outside data: price and the
	// risk-free rate from Yahoo Finance, everything else from SEC EDGAR.
	// Always talks to the network through fetchQuotePrice / secHttpGet (both
	// wrap Obsidian's requestUrl), which works the same way on mobile as on
	// desktop — unlike a browser fetch(), it isn't blocked by CORS or the
	// mobile webview. Every field it touches follows the same blank-or-zero
	// rule as isBlankOrZero — see also the legend text above the form and
	// this button's tooltip. RFR's cache still forces a fresh fetch when
	// "Refresh prices" (the table button, not this one) is clicked — see
	// refreshAllPrices.
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
					this.setStateField("price", this.roundForField(price));
					filled.push("Current price");
				} else {
					unavailable.push("Current price (Yahoo Finance)");
				}
			} else {
				keptExisting.push("Current price");
			}

			if (this.isBlankOrZero("rfr")) {
				const rfr = await this.plugin.data.refreshRiskFreeRate();
				this.setStateField("rfr", this.roundForField(rfr));
				filled.push("Risk-free rate");
			} else {
				keptExisting.push("Risk-free rate");
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
					this.setStateField(key, this.roundForField(scaled));
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
				apply("TTM dividends per share", "dps", result.dps, "perShare");

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
					["TTM dividends per share", result.dps],
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

	// Refreshes the price and the risk-free rate for every saved valuation
	// (table button, not the per-ticker form) — no other fundamentals are
	// touched. Everything price/RFR-derived is recomputed: MoS and Ten Cap
	// yield always; market cap too (price × shares), which along with RFR
	// moves WACC and DCF IV. Graham and Ten Cap IV don't depend on WACC/market
	// cap, so those stay fixed. Also appends a history entry per ticker (see
	// buildHistoryEntry) — MoS/IV moving with price is exactly what the
	// history timeline exists to track, and appendHistoryEntry's same-day
	// dedup means refreshing repeatedly in one sitting still only ever keeps
	// one entry for that day.
	private async refreshAllPrices(btn: HTMLButtonElement, label: HTMLElement): Promise<void> {
		const tickers = this.plugin.data.tickers().sort();
		if (tickers.length === 0 || this.priceRefreshInFlight) return;
		this.priceRefreshInFlight = true;

		const originalText = label.textContent ?? "Refresh prices";
		btn.disabled = true;
		label.setText("Refreshing…");

		const updated: string[] = [];
		const failed: string[] = [];

		// RFR isn't per-ticker — fetched (or forced-refreshed from Yahoo, bypassing
		// the 24h cache since this is an explicit manual refresh) once outside the
		// loop below and applied to every saved valuation.
		const rfr = this.roundForField(await this.plugin.data.refreshRiskFreeRate(true));

		try {
			for (const ticker of tickers) {
				const record = this.plugin.data.getValuation(ticker);
				if (!record) continue;
				const price = await fetchQuotePrice(ticker);
				if (price === null) {
					failed.push(ticker);
					continue;
				}
				// Applies to every scenario, not just base — right now all three
				// hold identical inputs (no scenario editor yet), so a price
				// refresh keeps them in sync rather than silently desyncing them.
				for (const scenario of Object.values(record.scenarios)) {
					scenario.state.price = this.roundForField(price);
					scenario.state.rfr = rfr;
					scenario.results = computeResultsForState(
						scenario.state,
						record.moneyScale,
						record.sharesScale,
						this.plugin.data.settings.taxRate
					);
				}
				record.lastPriceRefreshAt = Date.now();
				const historyEntry = buildHistoryEntry(record.lastPriceRefreshAt, record.scenarios);
				const history = appendHistoryEntry(record.history, historyEntry);
				if (history.length > 0) record.history = history;
				updated.push(ticker);
			}
		} finally {
			btn.disabled = false;
			label.setText(originalText);
			this.priceRefreshInFlight = false;
		}

		// Only the tickers whose price (and so history) actually changed get
		// their history note rewritten — a failed fetch leaves its note alone.
		if (updated.length > 0) {
			void this.plugin.data.persistValuations(updated);
		}
		this.render();

		const parts = [`Updated ${updated.length} of ${tickers.length} price${tickers.length === 1 ? "" : "s"}.`];
		if (failed.length > 0) parts.push(`Couldn't fetch: ${failed.join(", ")}.`);
		new Notice(parts.join(" "), 10000);
	}

	// Called on every keystroke in the form. Recomputes the active scenario's
	// results and rebuilds everything derived from the scenarios (the Summary
	// panel, the MoS chart, the sensitivity grids) — unlike switchScenario(),
	// which only changes *which* scenario is on screen without changing any
	// scenario's data, so it skips the chart/grids entirely (see
	// renderFormBody/switchScenario).
	private recalculate(): void {
		// All three scenarios, not just the active one: an edit to a shared
		// fact on Base (setStateField) also changes Bull/Bear's inputs, and the
		// MoS chart and the grids' "does any case have a value" check read all
		// three. Mutates each state's mktCap as a side effect — see
		// computeResultsForState. this.state is the same object as
		// this.scenarios[activeScenario].state, but results is a fresh object
		// each call, so this.results is re-pointed afterwards.
		for (const key of SCENARIO_KEYS) {
			this.scenarios[key].results = computeResultsForState(
				this.scenarios[key].state,
				this.moneyScale,
				this.sharesScale,
				this.plugin.data.settings.taxRate
			);
		}
		this.results = this.scenarios[this.activeScenario].results;
		this.refreshResultsDisplay();
		this.renderStockMosChart();
		this.renderDcfSensitivityGrid();
		this.renderGrahamSensitivityGrid();
		this.renderTenCapSensitivityGrid();
		this.renderDdmSensitivityGrid();
		this.updateSensitivityVisibility();
	}

	// Refreshes just the Summary panel + validation state for whichever
	// scenario is currently active — called after recalculate() rebuilds
	// this.results, and again at the end of renderFormBody() (which creates a
	// fresh resultsEl/mktCapInput/validationErrorsEl to populate).
	private refreshResultsDisplay(): void {
		this.mktCapInput.value = formatWithCommas(this.state.mktCap);
		this.renderResults();
		this.updateValidation();
	}

	// Runs every cross-scenario rule (see scenarioValidation.ts — currently
	// just bear/base/bull growth ordering, but written to grow) against the
	// three in-progress scenarios, disabling Save and listing what's wrong
	// when any rule fails. Called on every keystroke via recalculate(), so
	// the button's state always matches what's currently on screen.
	private updateValidation(): void {
		const errors = validateScenarios(this.scenarios);
		this.validationErrorsEl.empty();
		for (const error of errors) {
			this.validationErrorsEl.createEl("p", { text: error, cls: "sv-validation-error" });
		}
		this.saveBtn.disabled = errors.length > 0;
		if (errors.length > 0) {
			setTooltip(this.saveBtn, "Fix the highlighted inputs before saving.");
		} else {
			this.saveBtn.removeAttribute("aria-label");
		}
	}

	private renderResults(): void {
		const r = this.results;
		const price = this.num("price");

		this.heroTickerEl.setText(this.state.ticker || "New valuation");
		this.heroPriceEl.setText(price > 0 ? formatCurrency(price) : "");

		this.resultsEl.empty();

		// helpKey, when given, adds a "?" tooltip/click-for-Notice icon next to
		// the cell's label (same widget as the form's per-field help buttons) —
		// for rows like Reverse DCF whose name alone doesn't explain what the
		// number means.
		const labelCell = (parent: HTMLElement, name: string, helpKey?: string) => {
			const td = parent.createEl("td");
			const helpText = helpKey ? HELP_TEXT[helpKey] : undefined;
			if (!helpText) {
				td.setText(name);
				return;
			}
			const group = td.createDiv({ cls: "sv-field-label-group" });
			group.createSpan({ text: name });
			const helpBtn = group.createSpan({ cls: "sv-help-btn", text: "?" });
			helpBtn.setAttr("role", "button");
			helpBtn.setAttr("tabindex", "0");
			setTooltip(helpBtn, helpText, { placement: "top" });
			const showHelp = (e: Event) => {
				e.preventDefault();
				new Notice(helpText, 8000);
			};
			helpBtn.addEventListener("click", showHelp);
			helpBtn.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") showHelp(e);
			});
		};

		// Valuation methods only — every row here has both a fair value and a
		// margin of safety against today's price. WACC, Reverse DCF, and Ten
		// Cap's owner-earnings yield are inputs/derived stats, not valuations,
		// so they live in the plain metrics table below instead of forcing a
		// meaningless "—" into this table's MoS column.
		this.resultsEl.createEl("h4", { text: "Margin of safety", cls: "sv-results-subhead" });
		const mosTable = this.resultsEl.createEl("table");
		const mosHead = mosTable.createEl("tr");
		["Method", "Value", "MoS"].forEach((h) => mosHead.createEl("th", { text: h }));

		const mosRow = (name: string, val: string, mos: number) => {
			const tr = mosTable.createEl("tr");
			labelCell(tr, name);
			tr.createEl("td", { text: val, cls: "sv-num" });
			const mosCell = tr.createEl("td", { cls: "sv-num sv-mos" });
			if (!isFinite(mos)) {
				mosCell.setText("—");
			} else {
				mosCell.createSpan({ cls: mos >= 0 ? "sv-dot sv-dot-pos" : "sv-dot sv-dot-neg" });
				mosCell.createSpan({ text: formatPercent(mos) });
			}
		};

		mosRow("DCF", formatCurrency(r.dcfIv), r.dcfMos);
		mosRow("Graham", formatCurrency(r.grahamIv), r.grahamMos);
		mosRow("Ten Cap", formatCurrency(r.tenCapIv), r.tenCapMos);
		mosRow("DDM", formatCurrency(r.ddmIv), r.ddmMos);

		// Everything else: real numbers worth showing, but not a fair value
		// with a margin of safety attached — no MoS column to fake one for them.
		this.resultsEl.createEl("h4", { text: "Other metrics", cls: "sv-results-subhead" });
		const metricsTable = this.resultsEl.createEl("table");
		const metricsHead = metricsTable.createEl("tr");
		["Metric", "Value"].forEach((h) => metricsHead.createEl("th", { text: h }));

		// tone, when given, adds the same colored dot the MoS column uses —
		// only Payback Time has bands worth coloring (see paybackTone).
		const metricRow = (name: string, val: string, helpKey?: string, tone?: PaybackTone | null) => {
			const tr = metricsTable.createEl("tr");
			labelCell(tr, name, helpKey);
			const td = tr.createEl("td", { cls: tone ? "sv-num sv-mos" : "sv-num" });
			if (tone) td.createSpan({ cls: `sv-dot sv-dot-${tone}` });
			td.createSpan({ text: val });
		};

		metricRow("WACC", formatPercent(r.wacc * 100));
		metricRow("Cost of equity (DDM discount rate)", formatPercent(r.costOfEquity * 100), "costOfEquity");
		metricRow("Reverse DCF (implied growth)", formatPercent(r.impliedGrowth * 100), "impliedGrowth");
		metricRow("Ten Cap owner-earnings yield", formatPercent(r.tenCapYield));
		metricRow("Payback Time", formatYears(r.paybackYears), "paybackYears", paybackTone(r.paybackYears));
	}

	// DCF fair value across a fixed grid: WACC (columns) × growth yrs 1-5
	// (rows), the two inputs calcDcf is most exposed to. Every other DCF
	// input the grid holds fixed (netDebt/shares/growth6to10/terminalGrowth/
	// fcf) is read from the Base scenario specifically, not whichever tab is
	// active — WACC and growth6to10/terminalGrowth can otherwise differ by
	// scenario, and the grid needs one fixed basis so it stays identical
	// across tab switches (see calcDcfGrid, switchScenario). Rebuilt on every
	// keystroke from recalculate() — its own Tabulator instance
	// (this.dcfSensitivityTabulator), separate from the ticker table on the
	// table screen.
	private renderDcfSensitivityGrid(): void {
		this.dcfSensitivityTabulator?.destroy();
		this.dcfSensitivityTabulator = null;
		if (!this.showSensitivityGridIfValued(this.dcfSensitivityWrapEl, "dcfIv")) return;

		const dcfInputs: DcfInputs = {
			netDebt: this.numOf("base", "netDebt"),
			shares: this.numOf("base", "shares"),
			growth1to5: this.numOf("base", "growth1to5"),
			growth6to10: this.numOf("base", "growth6to10"),
			terminalGrowth: this.numOf("base", "terminalGrowth"),
			wacc: this.scenarios.base.results.wacc,
			fcf: this.numOf("base", "fcf"),
		};
		const { waccValues, growthValues, grid } = calcDcfGrid(dcfInputs);

		// growth1to5 is scenario-specific, so each case's "current inputs"
		// marker can land on a different row; WACC depends only on shared
		// facts, so the column is the same for all three.
		const currentByScenario: Record<ScenarioKey, GridMarker> = {} as Record<ScenarioKey, GridMarker>;
		for (const key of SCENARIO_KEYS) {
			currentByScenario[key] = {
				row: nearestIndex(growthValues, this.numOf(key, "growth1to5")),
				col: nearestIndex(waccValues, this.scenarios[key].results.wacc),
			};
		}

		this.dcfSensitivityTabulator = this.buildSensitivityGrid(
			this.dcfSensitivityWrapEl,
			growthValues,
			waccValues,
			grid,
			currentByScenario,
			this.num("price"),
			"Growth (yrs 1-5)",
			(v) => formatPercent(v * 100, 2),
			(v) => `WACC ${formatPercent(v * 100, 2)}`
		);
	}

	// Graham fair value across a fixed grid: AAA bond yield (columns) ×
	// expected EPS growth (rows) — the formula's only two judgment calls; eps
	// (the only other input) is read from Base, same reasoning as the DCF
	// grid above. Same rebuild-on-every-keystroke lifecycle as the DCF grid.
	private renderGrahamSensitivityGrid(): void {
		this.grahamSensitivityTabulator?.destroy();
		this.grahamSensitivityTabulator = null;
		if (!this.showSensitivityGridIfValued(this.grahamSensitivityWrapEl, "grahamIv")) return;

		const grahamInputs: GrahamInputs = {
			eps: this.numOf("base", "eps"),
			growth: this.numOf("base", "grahamGrowth"),
			aaaYield: this.numOf("base", "aaaYield"),
		};
		const { yieldValues, growthValues, grid } = calcGrahamGrid(grahamInputs);

		// grahamGrowth is scenario-specific (rows); aaaYield is a shared fact,
		// so the column is the same for all three.
		const currentByScenario: Record<ScenarioKey, GridMarker> = {} as Record<ScenarioKey, GridMarker>;
		for (const key of SCENARIO_KEYS) {
			currentByScenario[key] = {
				row: nearestIndex(growthValues, this.numOf(key, "grahamGrowth")),
				col: nearestIndex(yieldValues, this.numOf(key, "aaaYield")),
			};
		}

		this.grahamSensitivityTabulator = this.buildSensitivityGrid(
			this.grahamSensitivityWrapEl,
			growthValues,
			yieldValues,
			grid,
			currentByScenario,
			this.num("price"),
			"EPS growth",
			(v) => formatPercent(v * 100, 2),
			(v) => `AAA ${formatPercent(v * 100, 2)}`
		);
	}

	// Ten Cap fair value across a fixed grid: capex, as a multiplier on the
	// ticker's own reported capex (columns) × maintenance-capex split (rows)
	// — the method's real judgment call, crossed with how much reported capex
	// itself might swing; ocf/shares (read from Base, though shared facts
	// make this the same as any scenario) stay fixed. Ten Cap has no
	// scenario-specific input at all, so all three cases' markers always
	// coincide on the same cell. Same rebuild-on-every-keystroke lifecycle as
	// the other two grids above.
	private renderTenCapSensitivityGrid(): void {
		this.tenCapSensitivityTabulator?.destroy();
		this.tenCapSensitivityTabulator = null;
		if (!this.showSensitivityGridIfValued(this.tenCapSensitivityWrapEl, "tenCapIv")) return;

		const tenCapInputs: TenCapInputs = {
			ocf: this.numOf("base", "ocf"),
			capex: this.numOf("base", "capex"),
			mainPct: this.numOf("base", "mainPct"),
			shares: this.numOf("base", "shares"),
		};
		const { capexMultipliers, mainPctValues, grid } = calcTenCapGrid(tenCapInputs);

		const marker: GridMarker = {
			row: nearestIndex(mainPctValues, tenCapInputs.mainPct),
			col: nearestIndex(capexMultipliers, 1),
		};
		const currentByScenario: Record<ScenarioKey, GridMarker> = { bull: marker, base: marker, bear: marker };

		// Column headers show the actual capex dollar amount each multiplier
		// implies (in whatever Money scale is currently selected — same
		// convention as the Capital expenditures field itself), not the bare
		// multiplier — "80%" on its own doesn't say 80% of what.
		const moneyDivisor = SCALE_MULTIPLIERS[this.moneyScale];
		this.tenCapSensitivityTabulator = this.buildSensitivityGrid(
			this.tenCapSensitivityWrapEl,
			mainPctValues,
			capexMultipliers,
			grid,
			currentByScenario,
			this.num("price"),
			"Maintenance %",
			(v) => formatPercent(v * 100, 2),
			(mult) => `Capex ${formatCurrency((tenCapInputs.capex * mult) / moneyDivisor, 2)}`
		);
	}

	// DDM fair value across a fixed grid: cost of equity (columns) × dividend
	// growth (rows) — the model's two judgment calls; dps is read from Base,
	// same reasoning as the DCF grid. Cost of equity depends only on shared
	// facts (CAPM inputs), so every case's column marker is the same; dividend
	// growth is scenario-specific, so rows can differ. Same
	// rebuild-on-every-keystroke lifecycle as the other grids.
	private renderDdmSensitivityGrid(): void {
		this.ddmSensitivityTabulator?.destroy();
		this.ddmSensitivityTabulator = null;
		if (!this.showSensitivityGridIfValued(this.ddmSensitivityWrapEl, "ddmIv")) return;

		const ddmInputs: DdmInputs = {
			dps: this.numOf("base", "dps"),
			growth: this.numOf("base", "ddmGrowth"),
			costOfEquity: this.scenarios.base.results.costOfEquity,
		};
		const { keValues, growthValues, grid } = calcDdmGrid(ddmInputs);

		const currentByScenario: Record<ScenarioKey, GridMarker> = {} as Record<ScenarioKey, GridMarker>;
		for (const key of SCENARIO_KEYS) {
			currentByScenario[key] = {
				row: nearestIndex(growthValues, this.numOf(key, "ddmGrowth")),
				col: nearestIndex(keValues, this.scenarios[key].results.costOfEquity),
			};
		}

		this.ddmSensitivityTabulator = this.buildSensitivityGrid(
			this.ddmSensitivityWrapEl,
			growthValues,
			keValues,
			grid,
			currentByScenario,
			this.num("price"),
			"Dividend growth",
			(v) => formatPercent(v * 100, 2),
			(v) => `kₑ ${formatPercent(v * 100, 2)}`
		);
	}

	// A method's sensitivity grid (its whole block — heading, caption, legend,
	// grid) only shows when at least one of Bull/Base/Bear has an intrinsic
	// value for it (see hasIntrinsicValue) — a grid of "—" or $0 for a method
	// with nothing entered, or a non-payer's DDM, is just noise. Returns
	// whether the caller should go on to build the grid.
	private showSensitivityGridIfValued(wrapEl: HTMLElement, ivKey: "dcfIv" | "grahamIv" | "tenCapIv" | "ddmIv"): boolean {
		const show = hasIntrinsicValue(SCENARIO_KEYS.map((key) => this.scenarios[key].results[ivKey]));
		wrapEl.parentElement?.toggleClass("sv-hidden", !show);
		return show;
	}

	// Hides the whole "Sensitivity" section (heading + shared intro) when
	// every grid in it is hidden — e.g. a brand-new, still-blank valuation.
	private updateSensitivityVisibility(): void {
		const anyShown = [
			this.dcfSensitivityTabulator,
			this.grahamSensitivityTabulator,
			this.tenCapSensitivityTabulator,
			this.ddmSensitivityTabulator,
		].some((t) => t !== null);
		this.sensitivitySectionEl.toggleClass("sv-hidden", !anyShown);
	}

	// Shared renderer for every sensitivity grid: one row per rowValues
	// entry, one column per colValues entry, cell = grid[ri][ci] (null ->
	// "—"). Marks, in that case's own color, whichever cell is nearest each
	// scenario's actual current inputs (currentByScenario — all three always
	// shown, unlike the old single "current inputs" marker), plus the cell
	// whose value is closest to today's price in a color of its own. When
	// several markers land on the same cell, each draws its own inset ring at
	// a different radius so every color stays visible rather than one
	// overwriting another.
	private buildSensitivityGrid(
		wrapEl: HTMLElement,
		rowValues: number[],
		colValues: number[],
		grid: (number | null)[][],
		currentByScenario: Record<ScenarioKey, GridMarker>,
		price: number,
		rowHeaderTitle: string,
		rowLabelOf: (v: number) => string,
		colTitleOf: (v: number) => string
	): Tabulator {
		let nearestRi = -1;
		let nearestCi = -1;
		if (price > 0) {
			let minDiff = Infinity;
			grid.forEach((row, ri) =>
				row.forEach((iv, ci) => {
					if (iv === null) return;
					const diff = Math.abs(iv - price);
					if (diff < minDiff) {
						minDiff = diff;
						nearestRi = ri;
						nearestCi = ci;
					}
				})
			);
		}

		const scenarioColors = this.scenarioColors(wrapEl);
		const nearestColor = this.nearestPriceColor(wrapEl);

		interface GridRow {
			rowLabel: string;
			ri: number;
			[colField: string]: string | number;
		}
		const data: GridRow[] = rowValues.map((rv, ri) => {
			const row: GridRow = { rowLabel: rowLabelOf(rv), ri };
			colValues.forEach((_cv, ci) => {
				row[`c${ci}`] = grid[ri][ci] ?? NaN;
			});
			return row;
		});

		const cellFormatter = (ci: number) => (cell: CellComponent): string => {
			const value = cell.getValue() as number;
			const row = cell.getData() as GridRow;
			const el = cell.getElement();

			const scenariosHere = SCENARIO_KEYS.filter(
				(key) => currentByScenario[key].row === row.ri && currentByScenario[key].col === ci
			);
			const isNearest = row.ri === nearestRi && ci === nearestCi;

			if (scenariosHere.length > 0 || isNearest) {
				const rings: string[] = [];
				let radius = 2;
				for (const key of scenariosHere) {
					rings.push(`inset 0 0 0 ${radius}px ${scenarioColors[key]}`);
					radius += 2;
				}
				if (isNearest) rings.push(`inset 0 0 0 ${radius}px ${nearestColor}`);
				const color =
					scenariosHere.length === 1 && !isNearest
						? scenarioColors[scenariosHere[0]]
						: scenariosHere.length === 0 && isNearest
							? nearestColor
							: "";
				el.setCssStyles({
					boxShadow: rings.join(", "),
					borderRadius: "var(--radius-s)",
					fontWeight: "600",
					color,
				});
			} else {
				el.setCssStyles({ boxShadow: "", fontWeight: "", color: "" });
			}

			return isFinite(value) ? formatCurrency(value, 2) : "—";
		};

		const columns: ColumnDefinition[] = [
			{
				title: rowHeaderTitle,
				field: "rowLabel",
				headerSort: false,
				hozAlign: "left",
				headerHozAlign: "left",
				cssClass: "sv-grid-row-label",
			},
			...colValues.map(
				(cv, ci): ColumnDefinition => ({
					title: colTitleOf(cv),
					field: `c${ci}`,
					headerSort: false,
					hozAlign: "right",
					formatter: cellFormatter(ci),
				})
			),
		];

		return new Tabulator(wrapEl, { data, columns, layout: "fitColumns" });
	}

}
