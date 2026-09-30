import type { StockValuationsSettings } from "./settings";
import { CURRENT_SCHEMA_VERSION, LegacySavedValuation, migrateValuationsToV2 } from "./migrations";
import type { SavedValuation, ValuationTable } from "./valuationStore";
import type { MacroRow } from "./macro";

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

// The Shiller-derived dataset only moves when the upstream fork's GitHub
// Action is manually re-run (see plan.md) — same 24h TTL as the RFR cache is
// generous, not load-bearing precision.
const MACRO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface MacroCache {
	rows: MacroRow[];
	fetchedAt: number;
}

// Everything persisted to Obsidian's plugin data.json in one blob — settings
// and valuations share a single load/save round trip, not two independent
// stores.
export interface PluginData {
	settings: StockValuationsSettings;
	valuations: ValuationTable;
	schemaVersion?: number;
	lastSeenVersion?: string;
	rfrCache?: RfrCache;
	macroCache?: MacroCache;
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

// Regenerates the vault summary note from the current valuations table.
// Injected instead of imported directly so DataRepository never needs a real
// Obsidian App/Vault to be unit tested.
export type NoteSyncFn = (valuations: ValuationTable) => Promise<void>;

// Fetches the current risk-free rate (10-year Treasury yield), or null on
// failure. Injected rather than importing priceProvider.ts directly — that
// module imports Obsidian's requestUrl at the value level, which would drag a
// real Obsidian runtime into DataRepository's otherwise Obsidian-free tests.
export type FetchRfrFn = () => Promise<number | null>;

// Fetches the rolling window of Shiller CAPE/macro rows, or null on failure.
// Injected rather than importing macro.ts directly — same reasoning as
// FetchRfrFn above (that module imports Obsidian's requestUrl at the value
// level).
export type FetchMacroDataFn = () => Promise<MacroRow[] | null>;

// Owns every read/write of the plugin's persisted state: settings and the
// per-ticker valuation table. main.ts wires this to the real Obsidian plugin
// (which already implements PluginDataAdapter) and the vault note sync;
// view.ts and settings.ts talk to this instead of reaching into
// plugin.valuations / plugin.settings directly.
export class DataRepository {
	settings: StockValuationsSettings;
	lastSeenVersion: string | undefined;
	private valuations: ValuationTable = {};
	private schemaVersion: number = CURRENT_SCHEMA_VERSION;
	private rfrCache: RfrCache | undefined;
	private macroCache: MacroCache | undefined;

	constructor(
		private readonly adapter: PluginDataAdapter,
		private readonly defaultSettings: StockValuationsSettings,
		private readonly syncNote: NoteSyncFn,
		private readonly onNoteSyncError: (error: unknown) => void = () => {},
		private readonly fetchRfr: FetchRfrFn = () => Promise.resolve(null),
		private readonly fetchMacro: FetchMacroDataFn = () => Promise.resolve(null)
	) {
		this.settings = defaultSettings;
	}

	// Loads settings + valuations from disk, migrating the valuation table to
	// the current schema if needed. Call once, before reading or writing
	// anything else.
	async load(): Promise<void> {
		const data = ((await this.adapter.loadData()) ?? {}) as Partial<PluginData> & {
			valuations?: Record<string, LegacySavedValuation> | ValuationTable;
		};
		this.settings = Object.assign({}, this.defaultSettings, data.settings);
		this.lastSeenVersion = data.lastSeenVersion;
		this.rfrCache = data.rfrCache;
		this.macroCache = data.macroCache;

		// Missing schemaVersion means the old single-scenario shape. Fast path
		// (already migrated) is a single number comparison — no loop, no
		// per-record shape checks — so every load after the first migration
		// stays cheap.
		const schemaVersion = data.schemaVersion ?? 1;
		if (schemaVersion >= CURRENT_SCHEMA_VERSION) {
			this.valuations = (data.valuations as ValuationTable) ?? {};
			this.schemaVersion = schemaVersion;
			return;
		}

		this.valuations = migrateValuationsToV2((data.valuations as Record<string, LegacySavedValuation>) ?? {});
		this.schemaVersion = CURRENT_SCHEMA_VERSION;
		// Persist right away so data.json and the vault summary note both move
		// to the new shape immediately — a vault that's only ever viewed, never
		// edited, still ends up migrated instead of stuck on the old shape.
		await this.persistValuations();
	}

	// Writes settings (and everything else in the blob, unchanged) to disk. No
	// vault note resync — the note only ever reflects valuations, which
	// haven't changed.
	async saveSettings(): Promise<void> {
		await this.writeToDisk();
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
			await this.writeToDisk();
		}
		return this.getCachedRiskFreeRate();
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
			await this.writeToDisk();
		}
		return this.getCachedMacroData();
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

	// Replaces (or creates) one ticker's record wholesale and persists — the
	// calculator form's Save button.
	async saveValuation(ticker: string, record: SavedValuation): Promise<void> {
		this.valuations[ticker] = record;
		await this.persistValuations();
	}

	async deleteValuation(ticker: string): Promise<void> {
		delete this.valuations[ticker];
		await this.persistValuations();
	}

	// Writes the current valuations table to disk and resyncs the vault
	// summary note. saveValuation()/deleteValuation() call this internally;
	// call it directly after mutating a record obtained from getValuation() in
	// place (history edits, research-note linking) or after a batch of such
	// mutations (price refresh).
	async persistValuations(): Promise<void> {
		await this.writeToDisk();
		try {
			await this.syncNote(this.valuations);
		} catch (e) {
			console.error("Stock Valuations: failed to write summary note", e);
			this.onNoteSyncError(e);
		}
	}

	private async writeToDisk(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			valuations: this.valuations,
			schemaVersion: this.schemaVersion,
			lastSeenVersion: this.lastSeenVersion,
			rfrCache: this.rfrCache,
			macroCache: this.macroCache,
		};
		await this.adapter.saveData(data);
	}
}
