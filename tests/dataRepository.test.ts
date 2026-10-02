import { describe, expect, it, vi } from "vitest";
import { DataRepository, PluginDataAdapter } from "../dataRepository";
import type { FormState, Results, SavedValuation, ValuationTable } from "../valuationStore";
import type { LegacySavedValuation } from "../migrations";
import { computeResultsForState } from "../valuationCalc";

// A minimal stand-in for settings.ts's StockValuationsSettings/DEFAULT_SETTINGS
// — settings.ts itself imports real Obsidian classes (Notice,
// PluginSettingTab, ...) at the value level, which has no runtime outside
// Obsidian (see historyStore.ts's comment for the same reasoning), so tests
// can't import it directly.
interface FixtureSettings {
	marketRiskPremium: number;
	taxRate: number;
	maintenanceCapexPct: number;
	aaaBondYield: number;
	defaultMoneyScale: "millions";
	defaultSharesScale: "millions";
	historyNotesFolder: string;
	enableResearchLinks: boolean;
	researchNotesFolder: string;
}

const DEFAULT_SETTINGS: FixtureSettings = {
	marketRiskPremium: 5,
	taxRate: 21,
	maintenanceCapexPct: 50,
	aaaBondYield: 5,
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	historyNotesFolder: "Stock Valuations",
	enableResearchLinks: false,
	researchNotesFolder: "",
};

function fixtureState(overrides: Partial<FormState> = {}): FormState {
	return {
		ticker: "ACME",
		price: "50",
		shares: "100",

		rfr: "4",
		mrp: "5",
		beta: "1.2",
		intExp: "100",
		totDebt: "1000",
		taxRate: "25",
		mktCap: "5000",

		netDebt: "500",
		growth1to5: "8",
		growth6to10: "4",
		terminalGrowth: "2",
		fcf: "500",

		eps: "5",
		grahamGrowth: "8",
		aaaYield: "4.4",

		ocf: "1000",
		capex: "400",
		mainPct: "50",

		dps: "",
		ddmGrowth: "",
		...overrides,
	};
}

function fixtureResults(overrides: Partial<Results> = {}): Results {
	return {
		wacc: 0.09,
		dcfIv: 60,
		dcfMos: 0.2,
		impliedGrowth: 0.07,
		grahamIv: 55,
		grahamMos: 0.1,
		tenCapIv: 45,
		tenCapYield: 0.08,
		tenCapMos: -0.1,
		ddmIv: NaN,
		ddmMos: NaN,
		costOfEquity: 0.1,
		paybackYears: 7,
		...overrides,
	};
}

function fixtureValuation(overrides: Partial<SavedValuation> = {}): SavedValuation {
	const scenario = { state: fixtureState(), results: fixtureResults() };
	return {
		scenarios: { bull: scenario, base: scenario, bear: scenario },
		moneyScale: "millions",
		sharesScale: "millions",
		updatedAt: 1700000000000,
		...overrides,
	};
}

function legacyRecord(overrides: Partial<LegacySavedValuation> = {}): LegacySavedValuation {
	return {
		state: fixtureState(),
		results: fixtureResults(),
		moneyScale: "millions",
		sharesScale: "millions",
		updatedAt: 1700000000000,
		...overrides,
	};
}

// In-memory stand-in for Obsidian's Plugin.loadData()/saveData() — the real
// "obsidian" package ships type declarations only, no runtime, so a fake
// adapter is what makes DataRepository constructible in a test at all.
function fakeAdapter(initial: unknown = null): PluginDataAdapter & { current: unknown } {
	return {
		current: initial,
		async loadData() {
			return this.current;
		},
		async saveData(data: unknown) {
			this.current = data;
		},
	};
}

// Like fakeAdapter, but "disk" is real JSON text, the way Obsidian's own
// loadData/saveData persist data.json — so NaN really becomes null on save,
// every load parses a fresh copy, and a test can compare the exact bytes on
// disk before and after to prove nothing was written.
function jsonAdapter(initial: unknown): PluginDataAdapter & { disk: string } {
	return {
		disk: JSON.stringify(initial),
		async loadData() {
			return JSON.parse(this.disk);
		},
		async saveData(data: unknown) {
			this.disk = JSON.stringify(data);
		},
	};
}

function fixtureSettings(overrides: Partial<FixtureSettings> = {}): FixtureSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("DataRepository.load", () => {
	it("starts from the default settings and an empty table on a fresh install", async () => {
		const adapter = fakeAdapter(null);
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.settings).toEqual(fixtureSettings());
		expect(repo.getAllValuations()).toEqual({});
		expect(repo.tickers()).toEqual([]);
	});

	it("merges saved settings over the defaults", async () => {
		const adapter = fakeAdapter({
			settings: { taxRate: 30 },
			valuations: {},
			schemaVersion: 2,
		});
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.settings.taxRate).toBe(30);
		expect(repo.settings.maintenanceCapexPct).toBe(DEFAULT_SETTINGS.maintenanceCapexPct);
	});

	it("restores lastSeenVersion", async () => {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2, lastSeenVersion: "1.2.3" });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.lastSeenVersion).toBe("1.2.3");
	});

	it("loads an already-migrated table's inputs as-is, without writing back to disk", async () => {
		const table: ValuationTable = { ACME: fixtureValuation() };
		const adapter = jsonAdapter({ settings: {}, valuations: table, schemaVersion: 2 });
		const syncNote = vi.fn().mockResolvedValue(undefined);
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote);

		const diskBefore = adapter.disk;
		await repo.load();

		expect(repo.getValuation("ACME")!.scenarios.base.state).toEqual(table.ACME.scenarios.base.state);
		expect(adapter.disk).toBe(diskBefore); // no re-save of an already-current table
		expect(syncNote).not.toHaveBeenCalled();
	});

	it("rebuilds every scenario's results from its saved inputs, ignoring the results that were saved", async () => {
		// Deliberately wrong/stale saved results — including the nulls JSON
		// turns NaN into — must not survive the load.
		const stale = fixtureResults({ dcfIv: 12345, ddmIv: null as unknown as number, ddmMos: null as unknown as number });
		const record = fixtureValuation({
			scenarios: {
				bull: { state: fixtureState({ dps: "2", ddmGrowth: "4" }), results: stale },
				base: { state: fixtureState({ dps: "2", ddmGrowth: "3" }), results: stale },
				bear: { state: fixtureState(), results: stale }, // non-payer
			},
		});
		const adapter = jsonAdapter({ settings: { taxRate: 21 }, valuations: { ACME: record }, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		const loaded = repo.getValuation("ACME")!;
		for (const key of ["bull", "base", "bear"] as const) {
			const expected = computeResultsForState({ ...record.scenarios[key].state }, "millions", "millions", 21);
			expect(loaded.scenarios[key].results).toEqual(expected);
		}
		expect(loaded.scenarios.base.results.dcfIv).not.toBe(12345);
		// A non-payer's DDM comes back as NaN (no value), never null.
		expect(loaded.scenarios.bear.results.ddmIv).toBeNaN();
		expect(loaded.scenarios.bear.results.ddmIv).not.toBeNull();
	});

	it("never changes the saved inputs while recomputing — not even the derived mktCap", async () => {
		const state = fixtureState({ mktCap: "999" }); // stale vs. price × shares
		const record = fixtureValuation({ scenarios: { bull: { state, results: fixtureResults() }, base: { state, results: fixtureResults() }, bear: { state, results: fixtureResults() } } });
		const adapter = jsonAdapter({ settings: {}, valuations: { ACME: record }, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		const loaded = repo.getValuation("ACME")!;
		for (const key of ["bull", "base", "bear"] as const) {
			expect(loaded.scenarios[key].state).toEqual(state);
		}
	});

	it("leaves history entries exactly as saved, nulls included", async () => {
		const history = [
			{ at: 1, price: 50, dcfBearIv: 40, dcfBaseIv: 60, dcfBullIv: 80, grahamBearIv: 45, grahamBaseIv: 55, grahamBullIv: 65, tenCapIv: 45, impliedGrowth: null, ddmBearIv: null, ddmBaseIv: null, ddmBullIv: null },
		];
		const adapter = jsonAdapter({ settings: {}, valuations: { ACME: fixtureValuation({ history }) }, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.getValuation("ACME")!.history).toEqual(history);
	});

	it("round-trips a NaN result through save and reload as NaN (JSON stores it as null)", async () => {
		const adapter = jsonAdapter({ settings: {}, valuations: {}, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn().mockResolvedValue(undefined));
		await repo.load();

		const state = fixtureState(); // no dividend -> DDM is NaN
		const results = computeResultsForState({ ...state }, "millions", "millions", 21);
		expect(results.ddmIv).toBeNaN();
		await repo.saveValuation("ACME", fixtureValuation({ scenarios: { bull: { state, results }, base: { state, results }, bear: { state, results } } }));
		expect(adapter.disk).toContain('"ddmIv":null'); // what JSON actually wrote

		const reloaded = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await reloaded.load();
		expect(reloaded.getValuation("ACME")!.scenarios.base.results.ddmIv).toBeNaN();
	});

	it("migrates a legacy (pre-scenario) table and persists the result immediately", async () => {
		const legacy = { ACME: legacyRecord() };
		const adapter = fakeAdapter({ settings: {}, valuations: legacy }); // no schemaVersion => legacy
		const syncNote = vi.fn().mockResolvedValue(undefined);
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote);

		await repo.load();

		const migrated = repo.getValuation("ACME");
		expect(migrated?.scenarios.base.state).toEqual(legacy.ACME.state);
		expect(migrated?.scenarios.bull.state).toEqual(legacy.ACME.state);
		expect(adapter.current).toMatchObject({ schemaVersion: 2 });
		// Loading never writes notes — only a ticker's own save/refresh/edit does.
		expect(syncNote).not.toHaveBeenCalled();
	});

	it("seeds historyNotesFolder from the retired valuationsNotePath setting's folder, and drops the old key", async () => {
		const adapter = fakeAdapter({
			settings: { valuationsNotePath: "Investing/Valuations/Summary.md" },
			valuations: {},
			schemaVersion: 2,
		});
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.settings.historyNotesFolder).toBe("Investing/Valuations");
		expect("valuationsNotePath" in repo.settings).toBe(false);
	});

	it("keeps an explicitly-set historyNotesFolder over the retired valuationsNotePath", async () => {
		const adapter = fakeAdapter({
			settings: { valuationsNotePath: "Old/Summary.md", historyNotesFolder: "New" },
			valuations: {},
			schemaVersion: 2,
		});
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.settings.historyNotesFolder).toBe("New");
	});

	it("uses the vault root when the retired summary note sat at the root", async () => {
		const adapter = fakeAdapter({ settings: { valuationsNotePath: "Summary.md" }, valuations: {}, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.settings.historyNotesFolder).toBe("");
	});

	it("treats a missing table as legacy-empty rather than throwing", async () => {
		const adapter = fakeAdapter({ settings: {} }); // no valuations key at all
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn().mockResolvedValue(undefined));

		await expect(repo.load()).resolves.not.toThrow();
		expect(repo.getAllValuations()).toEqual({});
	});
});

describe("DataRepository valuation CRUD", () => {
	async function loadedRepo(syncNote = vi.fn().mockResolvedValue(undefined)) {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote);
		await repo.load();
		return { adapter, repo, syncNote };
	}

	it("saveValuation upserts the record, keyed by the given ticker, and persists it", async () => {
		const { adapter, repo, syncNote } = await loadedRepo();
		const record = fixtureValuation();

		await repo.saveValuation("ACME", record);

		expect(repo.getValuation("ACME")).toBe(record);
		expect(adapter.current).toMatchObject({ valuations: { ACME: record } });
		expect(syncNote).toHaveBeenCalledWith("ACME", record);
	});

	it("saveValuation rewrites only the saved ticker's history note, never the others'", async () => {
		const { repo, syncNote } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		await repo.saveValuation("GLOB", fixtureValuation());
		syncNote.mockClear();

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 2 }));

		expect(syncNote).toHaveBeenCalledTimes(1);
		expect(syncNote).toHaveBeenCalledWith("ACME", expect.anything());
	});

	it("deleteValuation writes no note — the deleted ticker's history note is left in the vault", async () => {
		const { repo, syncNote } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		syncNote.mockClear();

		await repo.deleteValuation("ACME");

		expect(syncNote).not.toHaveBeenCalled();
	});

	it("keeps going when one ticker's note fails, reporting that ticker", async () => {
		const syncNote = vi.fn().mockImplementation((ticker: string) =>
			ticker === "GLOB" ? Promise.reject(new Error("nope")) : Promise.resolve()
		);
		const onNoteSyncError = vi.fn();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const adapter = fakeAdapter({ settings: {}, valuations: { ACME: fixtureValuation(), GLOB: fixtureValuation(), ZETA: fixtureValuation() }, schemaVersion: 2 });
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote, onNoteSyncError);
		await repo.load();

		await repo.persistValuations(["GLOB", "ZETA"]);

		expect(syncNote.mock.calls.map((c) => c[0])).toEqual(["GLOB", "ZETA"]);
		expect(onNoteSyncError).toHaveBeenCalledTimes(1);
		expect(onNoteSyncError).toHaveBeenCalledWith(expect.any(Error), "GLOB");
		consoleError.mockRestore();
	});

	it("persistValuations rewrites exactly the named tickers' notes, skipping any that no longer exist", async () => {
		const { repo, syncNote } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		await repo.saveValuation("GLOB", fixtureValuation());
		await repo.saveValuation("ZETA", fixtureValuation());
		syncNote.mockClear();

		await repo.persistValuations(["ACME", "ZETA", "GONE"]);

		expect(syncNote.mock.calls.map((c) => c[0])).toEqual(["ACME", "ZETA"]);
	});

	it("saveValuation overwrites an existing record for the same ticker", async () => {
		const { repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 1 }));
		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 2 }));

		expect(repo.getValuation("ACME")?.updatedAt).toBe(2);
	});

	it("deleteValuation removes the record and persists", async () => {
		const { adapter, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());

		await repo.deleteValuation("ACME");

		expect(repo.getValuation("ACME")).toBeUndefined();
		expect(adapter.current).toMatchObject({ valuations: {} });
	});

	it("deleteValuation on a ticker that was never saved is a harmless no-op", async () => {
		const { repo } = await loadedRepo();
		await expect(repo.deleteValuation("NOPE")).resolves.not.toThrow();
	});

	it("tickers() and getAllValuations() reflect every saved ticker", async () => {
		const { repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		await repo.saveValuation("GLOB", fixtureValuation());

		expect(repo.tickers().sort()).toEqual(["ACME", "GLOB"]);
		expect(Object.keys(repo.getAllValuations()).sort()).toEqual(["ACME", "GLOB"]);
	});

	it("persistValuations flushes an in-place mutation to a record obtained from getValuation", async () => {
		const { adapter, repo, syncNote } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		syncNote.mockClear();

		const live = repo.getValuation("ACME")!;
		live.researchNotePath = "Research/ACME.md";
		await repo.persistValuations([]);

		expect((adapter.current as { valuations: ValuationTable }).valuations.ACME.researchNotePath).toBe(
			"Research/ACME.md"
		);
		expect(syncNote).not.toHaveBeenCalled(); // research links aren't in the history note
	});
});

describe("DataRepository.saveSettings", () => {
	it("writes settings to disk without syncing the vault note", async () => {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2 });
		const syncNote = vi.fn().mockResolvedValue(undefined);
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote);
		await repo.load();

		repo.settings.taxRate = 33;
		await repo.saveSettings();

		expect((adapter.current as { settings: FixtureSettings }).settings.taxRate).toBe(33);
		expect(syncNote).not.toHaveBeenCalled();
	});
});

describe("DataRepository macro data caching", () => {
	const macroRows = [{ month: "2026-09-01", cape: 40, trCape: 43, dividendYield: 0.01, tenYearYield: 4.6, sp500: 7600, realPrice: 7600 }];

	async function loadedRepo(fetchMacro = vi.fn().mockResolvedValue(macroRows)) {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2 });
		const repo = new DataRepository(
			adapter,
			fixtureSettings(),
			vi.fn().mockResolvedValue(undefined),
			() => {},
			() => Promise.resolve(null),
			fetchMacro
		);
		await repo.load();
		return { adapter, repo, fetchMacro };
	}

	it("getCachedMacroData is null until a fetch has ever succeeded", async () => {
		const { repo } = await loadedRepo();
		expect(repo.getCachedMacroData()).toBeNull();
	});

	it("refreshMacroData fetches, caches, and persists on first call", async () => {
		const { adapter, repo, fetchMacro } = await loadedRepo();

		const rows = await repo.refreshMacroData();

		expect(rows).toEqual(macroRows);
		expect(fetchMacro).toHaveBeenCalledTimes(1);
		expect(repo.getCachedMacroData()).toEqual(macroRows);
		expect(adapter.current).toMatchObject({ macroCache: { rows: macroRows } });
	});

	it("does not refetch within the 24h TTL", async () => {
		const { repo, fetchMacro } = await loadedRepo();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMacroData();
		now.mockReturnValue(1_700_000_000_000 + 60 * 60 * 1000); // 1h later
		const rows = await repo.refreshMacroData();

		expect(fetchMacro).toHaveBeenCalledTimes(1);
		expect(rows).toEqual(macroRows);
		now.mockRestore();
	});

	it("refetches once the TTL has elapsed", async () => {
		const { repo, fetchMacro } = await loadedRepo();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMacroData();
		now.mockReturnValue(1_700_000_000_000 + 25 * 60 * 60 * 1000); // 25h later
		await repo.refreshMacroData();

		expect(fetchMacro).toHaveBeenCalledTimes(2);
		now.mockRestore();
	});

	it("a failed fetch falls back to whatever's already cached, without clearing it", async () => {
		const fetchMacro = vi.fn().mockResolvedValueOnce(macroRows).mockResolvedValueOnce(null);
		const { repo } = await loadedRepo(fetchMacro);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMacroData();
		now.mockReturnValue(1_700_000_000_000 + 25 * 60 * 60 * 1000); // past the TTL, forces a refetch
		const rows = await repo.refreshMacroData();

		expect(rows).toEqual(macroRows);
		expect(repo.getCachedMacroData()).toEqual(macroRows);
		now.mockRestore();
	});

	it("a failed fetch with nothing ever cached returns null", async () => {
		const { repo } = await loadedRepo(vi.fn().mockResolvedValue(null));

		const rows = await repo.refreshMacroData();

		expect(rows).toBeNull();
		expect(repo.getCachedMacroData()).toBeNull();
	});
});

describe("DataRepository note-sync failure handling", () => {
	it("still persists to disk, logs, and reports the error via onNoteSyncError when the note sync throws", async () => {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2 });
		const error = new Error("vault write failed");
		const syncNote = vi.fn().mockRejectedValue(error);
		const onNoteSyncError = vi.fn();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const repo = new DataRepository(adapter, fixtureSettings(), syncNote, onNoteSyncError);
		await repo.load();

		await repo.saveValuation("ACME", fixtureValuation());

		expect(repo.getValuation("ACME")).toBeDefined();
		expect((adapter.current as { valuations: ValuationTable }).valuations.ACME).toBeDefined();
		expect(onNoteSyncError).toHaveBeenCalledWith(error, "ACME");
		expect(consoleError).toHaveBeenCalled();

		consoleError.mockRestore();
	});
});
