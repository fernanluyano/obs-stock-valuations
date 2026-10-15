import type { StockValuationsSettings } from "./settings";
import { CURRENT_SCHEMA_VERSION, LegacySavedValuation, migrateValuationsToV2 } from "./migrations";
import type { SavedValuation, ValuationTable } from "./valuationStore";
import type { VaultPort } from "./storage/VaultPort";
import { kindOf, stateOf } from "./notes/kinds";
import { normalizeFolder, settingsNotePath, valuationNotePath } from "./notes/paths";
import { buildValuationNote, parseValuationNote, patchValuationNote } from "./notes/valuationNote";
import { buildSettingsNote, parseSettingsProps, patchSettingsNote, type PortableSettings } from "./notes/settingsNote";
import { computeResultsForState } from "./valuationCalc";
import type { MacroRow } from "./macro";
import type { MarketSnapshot } from "./marketData";

// ^TNX is an end-of-day index snapshot, not a tick-by-tick quote — it only
// moves once per trading day, so refetching more often than this buys
// nothing.
const RFR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Used only when nothing has ever been fetched or cached yet (first run,
// offline) — not a user-editable setting, just a placeholder until the first
// successful fetch lands.
const FALLBACK_RFR = 5.0;

interface RfrCache {
	value: number;
	fetchedAt: number;
}

// FRED's DAAA is a daily series, so the same 24h TTL as the RFR applies.
const AAA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Used only until the first successful fetch lands (first run, offline).
const FALLBACK_AAA_YIELD = 5.5;

interface AaaCache {
	value: number;
	fetchedAt: number;
}

// The Shiller-derived dataset only moves when the upstream fork's GitHub
// Action is manually re-run (see plan.md) — same 24h TTL as the RFR cache is
// generous, not load-bearing precision.
const MACRO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface MacroCache {
	rows: MacroRow[];
	fetchedAt: number;
}

// Yahoo quotes (yield curve, VIX, commodities) move intraday, but the Macro
// screen is a big-picture view — a day keeps API calls rare, same as the RFR
// and Shiller caches.
const MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface MarketCache {
	snapshot: MarketSnapshot;
	fetchedAt: number;
}

// What Obsidian's plugin data.json holds now: device-local state only. The
// valuations and settings live in vault notes (see notes/); losing this file
// costs a refetch of the caches, never any user data. notesFolder is where
// those notes are — it can't live in a note, since it's how the notes are found.
export interface PluginData {
	notesFolder?: string;
	lastSeenVersion?: string;
	rfrCache?: RfrCache;
	aaaCache?: AaaCache;
	macroCache?: MacroCache;
	marketCache?: MarketCache;
}

// The pre-2.0 keys of data.json, when valuations and settings lived there.
// Read once to import them into notes, then dropped from the file.
interface LegacyData {
	settings?: Partial<StockValuationsSettings> & { valuationsNotePath?: unknown };
	valuations?: Record<string, LegacySavedValuation> | ValuationTable;
	schemaVersion?: number;
}

// The slice of Obsidian's Plugin API this repository needs. Duck-typed
// rather than importing Plugin from "obsidian" directly — that package ships
// type declarations only, no runtime (see historyStore.ts for the same
// reasoning) — so DataRepository can be constructed with a fake in tests.
// Obsidian's real Plugin class already satisfies this shape.
export interface PluginDataAdapter {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

// Settings carry-over: the old single summary note setting
// (valuationsNotePath, a file path) became historyNotesFolder (a folder).
// A vault that customized the old path keeps its notes in that same folder.
function folderOfPath(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

// Fetches the current risk-free rate (10-year Treasury yield), or null on
// failure. Injected rather than importing priceProvider.ts directly — that
// module imports Obsidian's requestUrl at the value level, which would drag a
// real Obsidian runtime into DataRepository's otherwise Obsidian-free tests.
export type FetchRfrFn = () => Promise<number | null>;

// Fetches the current AAA corporate bond yield (FRED DAAA), or null on
// failure. Injected for the same reason as FetchRfrFn.
export type FetchAaaYieldFn = () => Promise<number | null>;

// Fetches the rolling window of Shiller CAPE/macro rows, or null on failure.
// Injected rather than importing macro.ts directly — same reasoning as
// FetchRfrFn above (that module imports Obsidian's requestUrl at the value
// level).
export type FetchMacroDataFn = () => Promise<MacroRow[] | null>;

// Fetches the Yahoo-sourced market snapshot (Treasury curve, VIX, gold,
// silver, oil), or null on total failure. Injected for the same reason.
export type FetchMarketDataFn = () => Promise<MarketSnapshot | null>;

// Owns every read/write of the plugin's persisted state. The vault notes are
// the source of truth for settings and the per-ticker valuation table (one
// TICKER.md per ticker plus Settings.md, in the notes folder); data.json only
// keeps device-local state (see PluginData). main.ts wires this to the real
// Obsidian plugin (which already implements PluginDataAdapter) and the vault;
// view.ts and settings.ts talk to this instead of reaching into
// plugin.valuations / plugin.settings directly.
export class DataRepository {
	settings: StockValuationsSettings;
	lastSeenVersion: string | undefined;
	private valuations: ValuationTable = {};
	// Where each loaded ticker's note actually is — properties win over paths,
	// so a note the user moved or renamed is still written back in place.
	private notePaths = new Map<string, string>();
	private settingsPath: string | undefined;
	// Legacy data.json keys, kept (and written back) only while an import into
	// notes hasn't completed, so a failed import loses nothing and retries.
	private legacyKeep: LegacyData | undefined;
	private writeQueue: Promise<void> = Promise.resolve();
	private rfrCache: RfrCache | undefined;
	private aaaCache: AaaCache | undefined;
	private macroCache: MacroCache | undefined;
	private marketCache: MarketCache | undefined;

	constructor(
		private readonly adapter: PluginDataAdapter,
		private readonly defaultSettings: StockValuationsSettings,
		private readonly vault: VaultPort,
		// `subject` names what failed: a ticker, a note path, or "Settings".
		private readonly onNoteError: (error: unknown, subject: string) => void = () => {},
		private readonly fetchRfr: FetchRfrFn = () => Promise.resolve(null),
		private readonly fetchMacro: FetchMacroDataFn = () => Promise.resolve(null),
		private readonly fetchMarket: FetchMarketDataFn = () => Promise.resolve(null),
		private readonly fetchAaa: FetchAaaYieldFn = () => Promise.resolve(null)
	) {
		this.settings = defaultSettings;
	}

	// Loads settings + valuations from the vault notes. Call once, before
	// reading or writing anything else.
	//
	// The import of a pre-2.0 data.json is gated so a normal startup pays
	// nothing for it: no legacy keys is a check on the data already in memory
	// (no vault access at all), and only a file that still has them costs one
	// path lookup for Settings.md — the import's completion marker. Once an
	// import finishes, data.json is rewritten without the legacy keys, so every
	// later start takes the free path.
	async load(): Promise<void> {
		const data = ((await this.adapter.loadData()) ?? {}) as Partial<PluginData> & LegacyData;
		this.lastSeenVersion = data.lastSeenVersion;
		this.rfrCache = data.rfrCache;
		this.aaaCache = data.aaaCache;
		this.macroCache = data.macroCache;
		// A cache from before the snapshot grew `quotes` (price + 5-day change
		// per symbol) is dropped rather than migrated — it's refetched anyway.
		this.marketCache = data.marketCache?.snapshot?.quotes ? data.marketCache : undefined;

		const hasLegacy = data.valuations !== undefined || data.settings !== undefined;
		const legacySettings = this.legacySettings(data);
		const folder = normalizeFolder(data.notesFolder ?? legacySettings.historyNotesFolder);
		this.settings = Object.assign({}, this.defaultSettings, legacySettings, { historyNotesFolder: folder });

		if (hasLegacy && !this.vault.exists(settingsNotePath(folder))) {
			if (!(await this.importLegacy(data))) {
				// Some notes couldn't be written (already reported): run from the
				// legacy data this session and keep it in data.json for a retry.
				this.legacyKeep = { settings: data.settings, valuations: data.valuations, schemaVersion: data.schemaVersion };
				this.valuations = this.legacyValuations(data);
				this.recomputeAllResults();
				await this.writeCache();
				return;
			}
		}
		await this.loadFromNotes();
		this.recomputeAllResults();
		// Drops the legacy keys now that the notes hold everything.
		if (hasLegacy) await this.writeCache();
	}

	// valuationsNotePath is the retired summary-note setting — dropped, but used
	// once to seed historyNotesFolder (see folderOfPath) if that's never been set.
	private legacySettings(data: LegacyData): StockValuationsSettings {
		const { valuationsNotePath, ...saved } = data.settings ?? {};
		const settings = Object.assign({}, this.defaultSettings, saved);
		if (saved.historyNotesFolder === undefined && typeof valuationsNotePath === "string") {
			settings.historyNotesFolder = folderOfPath(valuationsNotePath);
		}
		return settings;
	}

	// Missing schemaVersion means the old single-scenario shape. Already
	// migrated is a single number comparison — no loop, no per-record checks.
	private legacyValuations(data: LegacyData): ValuationTable {
		if ((data.schemaVersion ?? 1) >= CURRENT_SCHEMA_VERSION) return (data.valuations as ValuationTable) ?? {};
		return migrateValuationsToV2((data.valuations as Record<string, LegacySavedValuation>) ?? {});
	}

	// One-time import: a note per ticker, then Settings.md last as the commit
	// marker — a crash before it leaves the marker absent, so the next start
	// retries. Tickers that already have a note (an earlier, interrupted
	// attempt) are skipped; nothing existing is ever overwritten. Returns false
	// if any note couldn't be written, in which case no marker is written.
	private async importLegacy(data: LegacyData): Promise<boolean> {
		const folder = this.settings.historyNotesFolder;
		const have = new Set((await this.scanNotes()).valuations.map((n) => n.ticker));
		let ok = true;
		for (const [ticker, record] of Object.entries(this.legacyValuations(data))) {
			if (have.has(ticker)) continue;
			try {
				const path = this.freeNotePath(ticker);
				await this.vault.create(path, buildValuationNote(ticker, record));
			} catch (e) {
				ok = false;
				console.error(`Stock Valuations: failed to import ${ticker}`, e);
				this.onNoteError(e, ticker);
			}
		}
		if (!ok) return false;
		try {
			await this.vault.create(settingsNotePath(folder), buildSettingsNote(this.portableSettings()));
		} catch (e) {
			console.error("Stock Valuations: failed to import settings", e);
			this.onNoteError(e, "Settings");
			return false;
		}
		return true;
	}

	// Reads every plugin note in the notes folder. Staged (in_transit) copies
	// don't count; a note that can't be read is reported and skipped, never
	// silently dropped; a ticker with two notes keeps the first by path.
	private async scanNotes(): Promise<{
		valuations: { ticker: string; path: string; record: SavedValuation }[];
		settings?: { path: string; props: Record<string, unknown> };
	}> {
		const found = await this.vault.listNotes(this.settings.historyNotesFolder);
		const valuations: { ticker: string; path: string; record: SavedValuation }[] = [];
		let settings: { path: string; props: Record<string, unknown> } | undefined;
		const seen = new Set<string>();
		for (const { path, props } of [...found].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
			const kind = kindOf(props);
			if (!kind || stateOf(props) !== "current") continue;
			if (kind === "settings") {
				settings ??= { path, props };
				continue;
			}
			const parsed = parseValuationNote(props, (await this.vault.read(path)) ?? "");
			if (!parsed.ok) {
				this.onNoteError(new Error(parsed.reason), path);
				continue;
			}
			if (seen.has(parsed.ticker)) {
				this.onNoteError(new Error(`duplicate note for ${parsed.ticker}, ignored`), path);
				continue;
			}
			seen.add(parsed.ticker);
			if (parsed.issues.length > 0) {
				this.onNoteError(new Error(`${parsed.issues.length} unreadable row(s): ${parsed.issues.join("; ")}`), path);
			}
			valuations.push({ ticker: parsed.ticker, path, record: parsed.record });
		}
		return { valuations, settings };
	}

	private async loadFromNotes(): Promise<void> {
		const { valuations, settings } = await this.scanNotes();
		this.valuations = {};
		this.notePaths = new Map();
		for (const { ticker, path, record } of valuations) {
			this.valuations[ticker] = record;
			this.notePaths.set(ticker, path);
		}
		this.settingsPath = settings?.path;
		if (settings) {
			this.settings = {
				...this.settings,
				...parseSettingsProps(settings.props, this.portableSettings()),
			};
		}
	}

	private portableSettings(): PortableSettings {
		const { historyNotesFolder: _folder, ...portable } = this.settings;
		return portable;
	}

	// Default path for a ticker's note, or — when something else already sits
	// there (a user's own TICKER.md, say) — a sibling name; the ticker property,
	// not the filename, is what identifies the note.
	private freeNotePath(ticker: string): string {
		const folder = this.settings.historyNotesFolder;
		const plain = valuationNotePath(folder, ticker);
		if (!this.vault.exists(plain)) return plain;
		const alt = valuationNotePath(folder, `${ticker} (valuation)`);
		if (!this.vault.exists(alt)) return alt;
		throw new Error(`${plain} and ${alt} already exist`);
	}

	// Saved results are a cache of computeResultsForState(state), never the
	// source of truth — so they're rebuilt from each scenario's saved inputs on
	// every load instead of trusted as read. That way the in-memory table can't
	// carry anything JSON couldn't round-trip (NaN, a non-payer's DDM or an
	// unanswerable reverse DCF, is written as null and would otherwise come
	// back as null — which passes the global isFinite() as 0), can't miss a
	// result field added after the record was saved, and picks up any formula
	// fix without a re-save. In memory only — nothing is written back here —
	// and computed from a copy of each state, so the saved inputs themselves
	// (including mktCap, which computeResultsForState otherwise rewrites) are
	// untouched. History entries are snapshots of the past, not derived, so
	// they're left exactly as saved.
	private recomputeAllResults(): void {
		for (const record of Object.values(this.valuations)) {
			for (const scenario of Object.values(record.scenarios)) {
				scenario.results = computeResultsForState(
					{ ...scenario.state },
					record.moneyScale,
					record.sharesScale,
					this.settings.taxRate
				);
			}
		}
	}

	// Writes the portable settings to Settings.md (created on first save). No
	// ticker note is touched. historyNotesFolder isn't part of it — use
	// setNotesFolder for that.
	async saveSettings(): Promise<void> {
		await this.enqueue(async () => {
			try {
				const portable = this.portableSettings();
				const path = this.settingsPath;
				if (path && this.vault.exists(path)) {
					await this.vault.modify(path, (c) => patchSettingsNote(c, portable));
				} else {
					const created = settingsNotePath(this.settings.historyNotesFolder);
					await this.vault.create(created, buildSettingsNote(portable));
					this.settingsPath = created;
				}
			} catch (e) {
				console.error("Stock Valuations: failed to save settings", e);
				this.onNoteError(e, "Settings");
			}
		});
	}

	// Points the plugin at another notes folder and reloads from it. Nothing is
	// moved or deleted: the old folder's notes stay where they are, and a
	// folder with no notes simply loads empty (its Settings.md is only created
	// by the next settings change). Valuations come from the new folder alone.
	async setNotesFolder(folder: string): Promise<void> {
		this.settings.historyNotesFolder = normalizeFolder(folder);
		await this.writeCache();
		await this.loadFromNotes();
		this.recomputeAllResults();
	}

	// Writes only the device-local state (caches, last seen version, notes
	// folder) — no note is touched.
	async saveLocalState(): Promise<void> {
		await this.writeCache();
	}

	// Last fetched/cached risk-free rate, without triggering a fetch — for
	// synchronous prefill (e.g. the calculator form's initial state) before an
	// async refresh has had a chance to run.
	getCachedRiskFreeRate(): number {
		return this.rfrCache?.value ?? FALLBACK_RFR;
	}

	// Returns the current risk-free rate (10-year Treasury yield via ^TNX),
	// refetching from Yahoo Finance only if the cache is missing/stale or
	// `force` is set (the "Refresh prices" button always wants a fresh value).
	// A failed fetch falls back to whatever's already cached, and persists the
	// cache on disk whenever it changes.
	async refreshRiskFreeRate(force = false): Promise<number> {
		const now = Date.now();
		if (!force && this.rfrCache && now - this.rfrCache.fetchedAt < RFR_CACHE_TTL_MS) {
			return this.rfrCache.value;
		}
		const value = await this.fetchRfr();
		if (value !== null) {
			this.rfrCache = { value, fetchedAt: now };
			await this.writeCache();
		}
		return this.getCachedRiskFreeRate();
	}

	// Last fetched/cached AAA corporate bond yield, without triggering a fetch.
	getCachedAaaYield(): number {
		return this.aaaCache?.value ?? FALLBACK_AAA_YIELD;
	}

	// Same contract as refreshRiskFreeRate: refetches (from FRED) only if the
	// cache is missing/stale or `force` is set, and a failed fetch falls back
	// to whatever's already cached.
	async refreshAaaYield(force = false): Promise<number> {
		const now = Date.now();
		if (!force && this.aaaCache && now - this.aaaCache.fetchedAt < AAA_CACHE_TTL_MS) {
			return this.aaaCache.value;
		}
		const value = await this.fetchAaa();
		if (value !== null) {
			this.aaaCache = { value, fetchedAt: now };
			await this.writeCache();
		}
		return this.getCachedAaaYield();
	}

	// Last fetched/cached macro rows, without triggering a fetch — null until
	// the first successful fetch ever lands (unlike the RFR cache, there's no
	// sensible synthetic fallback for a whole historical series).
	getCachedMacroData(): MacroRow[] | null {
		return this.macroCache?.rows ?? null;
	}

	// Returns the cached Shiller CAPE/macro rows, refetching only if the cache
	// is missing/stale — no manual override, unlike refreshRiskFreeRate: this
	// data only ever moves when the upstream fork's GitHub Action is manually
	// re-run, so there's nothing a forced refresh from inside the plugin would
	// actually catch sooner. A failed fetch falls back to whatever's already
	// cached (or null if nothing ever landed), and persists the cache on disk
	// whenever it changes.
	async refreshMacroData(): Promise<MacroRow[] | null> {
		const now = Date.now();
		if (this.macroCache && now - this.macroCache.fetchedAt < MACRO_CACHE_TTL_MS) {
			return this.macroCache.rows;
		}
		const rows = await this.fetchMacro();
		if (rows !== null) {
			this.macroCache = { rows, fetchedAt: now };
			await this.writeCache();
		}
		return this.getCachedMacroData();
	}

	// Last fetched/cached market snapshot, without triggering a fetch — null
	// until the first successful fetch ever lands.
	getCachedMarketData(): MarketSnapshot | null {
		return this.marketCache?.snapshot ?? null;
	}

	// Returns the cached Yahoo market snapshot, refetching only if the cache is
	// missing/stale. A failed fetch falls back to whatever's already cached
	// (or null), and persists the cache on disk whenever it changes.
	async refreshMarketData(): Promise<MarketSnapshot | null> {
		const now = Date.now();
		if (this.marketCache && now - this.marketCache.fetchedAt < MARKET_CACHE_TTL_MS) {
			return this.marketCache.snapshot;
		}
		const snapshot = await this.fetchMarket();
		if (snapshot !== null) {
			this.marketCache = { snapshot, fetchedAt: now };
			await this.writeCache();
		}
		return this.getCachedMarketData();
	}

	getValuation(ticker: string): SavedValuation | undefined {
		return this.valuations[ticker];
	}

	// Live table, keyed by uppercase ticker — callers that iterate every saved
	// valuation (the table screen, the cross-ticker charts) read straight off
	// this rather than a defensive copy.
	getAllValuations(): ValuationTable {
		return this.valuations;
	}

	tickers(): string[] {
		return Object.keys(this.valuations);
	}

	// Replaces (or creates) one ticker's record wholesale and writes its note —
	// the calculator form's Save button.
	async saveValuation(ticker: string, record: SavedValuation): Promise<void> {
		this.valuations[ticker] = record;
		await this.persistValuations([ticker]);
	}

	// The note is the data, so deleting a ticker sends its note to Obsidian's
	// trash (honouring the user's trash setting) — left in place it would come
	// back on the next load.
	async deleteValuation(ticker: string): Promise<void> {
		delete this.valuations[ticker];
		const path = this.notePaths.get(ticker);
		this.notePaths.delete(ticker);
		if (!path) return;
		await this.enqueue(async () => {
			try {
				if (this.vault.exists(path)) await this.vault.trash(path);
			} catch (e) {
				console.error(`Stock Valuations: failed to delete ${ticker}'s note`, e);
				this.onNoteError(e, ticker);
			}
		});
	}

	// Rewrites the note of each ticker in `changedTickers` — and only those;
	// every other note is left alone. saveValuation() calls this internally;
	// call it directly after mutating a record obtained from getValuation() in
	// place, naming every ticker that changed (anything in a record lives in
	// its note, research links included).
	async persistValuations(changedTickers: string[]): Promise<void> {
		for (const ticker of changedTickers) {
			const record = this.valuations[ticker];
			if (record) await this.enqueue(() => this.writeNote(ticker, record));
		}
	}

	// One note write, with failures reported (not thrown). A note whose
	// history table can't be fully read is refused rather than overwritten —
	// that error lands here too.
	private async writeNote(ticker: string, record: SavedValuation): Promise<void> {
		try {
			const path = this.notePaths.get(ticker);
			if (path && this.vault.exists(path)) {
				await this.vault.modify(path, (c) => patchValuationNote(c, ticker, record));
				return;
			}
			const created = this.freeNotePath(ticker);
			await this.vault.create(created, buildValuationNote(ticker, record));
			this.notePaths.set(ticker, created);
		} catch (e) {
			console.error(`Stock Valuations: failed to write ${ticker}'s note`, e);
			this.onNoteError(e, ticker);
		}
	}

	// Writes run one at a time, so two quick saves of a new ticker can't both
	// try to create its note.
	private enqueue(task: () => Promise<void>): Promise<void> {
		this.writeQueue = this.writeQueue.then(task, task);
		return this.writeQueue;
	}

	private async writeCache(): Promise<void> {
		const data: PluginData & LegacyData = {
			notesFolder: this.settings.historyNotesFolder,
			lastSeenVersion: this.lastSeenVersion,
			rfrCache: this.rfrCache,
			aaaCache: this.aaaCache,
			macroCache: this.macroCache,
			marketCache: this.marketCache,
			...this.legacyKeep,
		};
		await this.adapter.saveData(data);
	}
}
