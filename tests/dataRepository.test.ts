import { describe, expect, it, vi } from "vitest";
import { DataRepository, PluginDataAdapter } from "../dataRepository";
import type { FormState, Results, SavedValuation, ValuationTable } from "../valuationStore";
import type { LegacySavedValuation } from "../migrations";

// A minimal stand-in for settings.ts's StockValuationsSettings/DEFAULT_SETTINGS
// — settings.ts itself imports real Obsidian classes (Notice,
// PluginSettingTab, ...) at the value level, which has no runtime outside
// Obsidian (see historyStore.ts's comment for the same reasoning), so tests
// can't import it directly.
interface FixtureSettings {
	riskFreeRate: number;
	marketRiskPremium: number;
	taxRate: number;
	maintenanceCapexPct: number;
	aaaBondYield: number;
	defaultMoneyScale: "millions";
	defaultSharesScale: "millions";
	valuationsNotePath: string;
	enableResearchLinks: boolean;
	researchNotesFolder: string;
}

const DEFAULT_SETTINGS: FixtureSettings = {
	riskFreeRate: 4.5,
	marketRiskPremium: 5,
	taxRate: 21,
	maintenanceCapexPct: 50,
	aaaBondYield: 5,
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	valuationsNotePath: "Stock Valuations/Stock Valuations.md",
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
		expect(repo.settings.riskFreeRate).toBe(DEFAULT_SETTINGS.riskFreeRate);
	});

	it("restores lastSeenVersion", async () => {
		const adapter = fakeAdapter({ settings: {}, valuations: {}, schemaVersion: 2, lastSeenVersion: "1.2.3" });
		const repo = new DataRepository(adapter, fixtureSettings(), vi.fn());
		await repo.load();

		expect(repo.lastSeenVersion).toBe("1.2.3");
	});

	it("loads an already-migrated table as-is, without writing back to disk", async () => {
		const table: ValuationTable = { ACME: fixtureValuation() };
		const adapter = fakeAdapter({ settings: {}, valuations: table, schemaVersion: 2 });
		const syncNote = vi.fn().mockResolvedValue(undefined);
		const repo = new DataRepository(adapter, fixtureSettings(), syncNote);

		const before = adapter.current;
		await repo.load();

		expect(repo.getValuation("ACME")).toEqual(table.ACME);
		expect(adapter.current).toBe(before); // no re-save of an already-current table
		expect(syncNote).not.toHaveBeenCalled();
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
		expect(syncNote).toHaveBeenCalledTimes(1);
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
		expect(syncNote).toHaveBeenCalledWith({ ACME: record });
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
		const { adapter, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());

		const live = repo.getValuation("ACME")!;
		live.researchNotePath = "Research/ACME.md";
		await repo.persistValuations();

		expect((adapter.current as { valuations: ValuationTable }).valuations.ACME.researchNotePath).toBe(
			"Research/ACME.md"
		);
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
		expect(onNoteSyncError).toHaveBeenCalledWith(error);
		expect(consoleError).toHaveBeenCalled();

		consoleError.mockRestore();
	});
});
