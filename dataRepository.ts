import type { StockValuationsSettings } from "./settings";
import { CURRENT_SCHEMA_VERSION, LegacySavedValuation, migrateValuationsToV2 } from "./migrations";
import type { SavedValuation, ValuationTable } from "./valuationStore";

// Everything persisted to Obsidian's plugin data.json in one blob — settings
// and valuations share a single load/save round trip, not two independent
// stores.
export interface PluginData {
	settings: StockValuationsSettings;
	valuations: ValuationTable;
	schemaVersion?: number;
	lastSeenVersion?: string;
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

	constructor(
		private readonly adapter: PluginDataAdapter,
		private readonly defaultSettings: StockValuationsSettings,
		private readonly syncNote: NoteSyncFn,
		private readonly onNoteSyncError: (error: unknown) => void = () => {}
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
		};
		await this.adapter.saveData(data);
	}
}
