import { describe, expect, it, vi } from "vitest";
import { DataRepository, PluginDataAdapter } from "../dataRepository";
import type { SavedValuation } from "../valuationStore";
import type { LegacySavedValuation } from "../migrations";
import { computeResultsForState } from "../valuationCalc";
import { compactHistory, deleteHistoryEntry } from "../historyStore";
import { parseProps } from "../notes/frontmatter";
import { buildSettingsNote } from "../notes/settingsNote";
import { buildValuationNote } from "../notes/valuationNote";
import { MemoryVault } from "./helpers/memoryVault";
import { fixtureHistory, fixtureResults, fixtureState, fixtureValuation } from "./helpers/valuationFixtures";

// A minimal stand-in for settings.ts's StockValuationsSettings/DEFAULT_SETTINGS
// — settings.ts itself imports real Obsidian classes (Notice,
// PluginSettingTab, ...) at the value level, which has no runtime outside
// Obsidian (see historyStore.ts's comment for the same reasoning), so tests
// can't import it directly.
interface FixtureSettings {
	marketRiskPremium: number;
	taxRate: number;
	maintenanceCapexPct: number;
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
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	historyNotesFolder: "Stock Valuations",
	enableResearchLinks: false,
	researchNotesFolder: "",
};

const FOLDER = "Stock Valuations";

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
// loadData/saveData persist data.json, so a test can compare the exact bytes
// on disk before and after to prove nothing was written.
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

function newRepo(vault: MemoryVault, adapter: PluginDataAdapter = fakeAdapter(null), onNoteError: (e: unknown, s: string) => void = () => {}) {
	return new DataRepository(adapter, fixtureSettings(), vault, onNoteError);
}

function seed(vault: MemoryVault, ticker: string, record: SavedValuation, path = `${FOLDER}/${ticker}.md`): void {
	vault.files.set(path, buildValuationNote(ticker, record));
}

function silenceConsole() {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("DataRepository AAA yield", () => {
	const noMacro = () => Promise.resolve(null);

	function repoWithAaa(fetchAaa: () => Promise<number | null>) {
		return new DataRepository(fakeAdapter(null), fixtureSettings(), new MemoryVault(), () => {}, noMacro, noMacro, noMacro, fetchAaa);
	}

	it("falls back to a placeholder until something has been fetched", () => {
		expect(repoWithAaa(() => Promise.resolve(null)).getCachedAaaYield()).toBe(5.5);
	});

	it("fetches once and serves the cache within the TTL", async () => {
		const fetchAaa = vi.fn().mockResolvedValue(6.15);
		const repo = repoWithAaa(fetchAaa);
		expect(await repo.refreshAaaYield()).toBe(6.15);
		expect(await repo.refreshAaaYield()).toBe(6.15);
		expect(fetchAaa).toHaveBeenCalledTimes(1);
	});

	it("force bypasses the cache", async () => {
		const fetchAaa = vi.fn().mockResolvedValueOnce(6.15).mockResolvedValueOnce(6.2);
		const repo = repoWithAaa(fetchAaa);
		await repo.refreshAaaYield();
		expect(await repo.refreshAaaYield(true)).toBe(6.2);
	});

	it("keeps the cached value when a fetch fails", async () => {
		const fetchAaa = vi.fn().mockResolvedValueOnce(6.15).mockResolvedValueOnce(null);
		const repo = repoWithAaa(fetchAaa);
		await repo.refreshAaaYield();
		expect(await repo.refreshAaaYield(true)).toBe(6.15);
	});
});

describe("DataRepository.reloadNotes", () => {
	it("picks up notes added, changed and removed on disk since load", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation({ lastPriceRefreshAt: 1 }));
		seed(vault, "OLD", fixtureValuation({}, "OLD"));
		const repo = newRepo(vault);
		await repo.load();

		seed(vault, "ACME", fixtureValuation({ lastPriceRefreshAt: 2 }));
		seed(vault, "NEW", fixtureValuation({}, "NEW"));
		vault.files.delete(`${FOLDER}/OLD.md`);
		await repo.reloadNotes();

		expect(repo.tickers().sort()).toEqual(["ACME", "NEW"]);
		expect(repo.getValuation("ACME")!.lastPriceRefreshAt).toBe(2);
	});

	it("waits for pending local writes before reading", async () => {
		const vault = new MemoryVault();
		const repo = newRepo(vault);
		await repo.load();

		const saving = repo.saveValuation("ACME", fixtureValuation({ lastPriceRefreshAt: 7 }));
		await repo.reloadNotes();
		await saving;

		expect(repo.getValuation("ACME")!.lastPriceRefreshAt).toBe(7);
	});
});

describe("DataRepository.load from notes", () => {
	it("starts from the default settings and an empty table on a fresh install", async () => {
		const repo = newRepo(new MemoryVault());
		await repo.load();

		expect(repo.settings).toEqual(fixtureSettings());
		expect(repo.getAllValuations()).toEqual({});
		expect(repo.tickers()).toEqual([]);
	});

	it("restores lastSeenVersion and the notes folder from data.json", async () => {
		const vault = new MemoryVault();
		const repo = newRepo(vault, fakeAdapter({ lastSeenVersion: "1.2.3", notesFolder: "Elsewhere/" }));
		await repo.load();

		expect(repo.lastSeenVersion).toBe("1.2.3");
		expect(repo.settings.historyNotesFolder).toBe("Elsewhere");
	});

	it("loads each ticker's inputs, scales and history from its note", async () => {
		const vault = new MemoryVault();
		const record = fixtureValuation({ history: fixtureHistory, researchNotePath: "R/ACME.md", lastPriceRefreshAt: 5 });
		seed(vault, "ACME", record);
		seed(vault, "GLOB", fixtureValuation({}, "GLOB"));
		const repo = newRepo(vault);
		await repo.load();

		expect(repo.tickers().sort()).toEqual(["ACME", "GLOB"]);
		const loaded = repo.getValuation("ACME")!;
		for (const key of ["bull", "base", "bear"] as const) {
			expect(loaded.scenarios[key].state).toEqual(record.scenarios[key].state);
		}
		expect(loaded.history).toEqual(fixtureHistory);
		expect(loaded.researchNotePath).toBe("R/ACME.md");
		expect(loaded.lastPriceRefreshAt).toBe(5);
	});

	it("applies Settings.md over the defaults", async () => {
		const vault = new MemoryVault({
			[`${FOLDER}/Settings.md`]: buildSettingsNote({ ...fixtureSettings(), taxRate: 30, researchNotesFolder: "R" }),
		});
		const repo = newRepo(vault);
		await repo.load();

		expect(repo.settings.taxRate).toBe(30);
		expect(repo.settings.researchNotesFolder).toBe("R");
		expect(repo.settings.maintenanceCapexPct).toBe(DEFAULT_SETTINGS.maintenanceCapexPct);
		expect(repo.settings.historyNotesFolder).toBe(FOLDER);
	});

	it("rebuilds every scenario's results from its saved inputs", async () => {
		const vault = new MemoryVault();
		const record = fixtureValuation({
			scenarios: {
				bull: { state: fixtureState({ dps: "2", ddmGrowth: "4" }), results: fixtureResults() },
				base: { state: fixtureState({ dps: "2", ddmGrowth: "3" }), results: fixtureResults() },
				bear: { state: fixtureState(), results: fixtureResults() }, // non-payer
			},
		});
		seed(vault, "ACME", record);
		const repo = newRepo(vault);
		await repo.load();

		const loaded = repo.getValuation("ACME")!;
		for (const key of ["bull", "base", "bear"] as const) {
			const expected = computeResultsForState({ ...record.scenarios[key].state }, "millions", "millions", 21);
			expect(loaded.scenarios[key].results).toEqual(expected);
		}
		expect(loaded.scenarios.bear.results.ddmIv).toBeNaN();
	});

	it("never changes the saved inputs while recomputing — not even the derived mktCap", async () => {
		const vault = new MemoryVault();
		const state = fixtureState({ mktCap: "999" }); // stale vs. price × shares
		const scenario = { state, results: fixtureResults() };
		seed(vault, "ACME", fixtureValuation({ scenarios: { bull: scenario, base: scenario, bear: scenario } }));
		const repo = newRepo(vault);
		await repo.load();

		for (const key of ["bull", "base", "bear"] as const) {
			expect(repo.getValuation("ACME")!.scenarios[key].state).toEqual(state);
		}
	});

	it("reinstall: a fresh plugin with an empty data.json reads everything back from the notes", async () => {
		const vault = new MemoryVault();
		const first = newRepo(vault);
		await first.load();
		await first.saveValuation("ACME", fixtureValuation({ history: fixtureHistory }));
		first.settings.taxRate = 33;
		await first.saveSettings();

		const second = newRepo(vault, fakeAdapter(null));
		await second.load();

		expect(second.getValuation("ACME")!.history).toEqual(fixtureHistory);
		expect(second.getValuation("ACME")!.scenarios.bull.state.growth1to5).toBe("12");
		expect(second.settings.taxRate).toBe(33);
	});

	it("ignores in_transit copies", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation());
		vault.files.set(`${FOLDER}/ACME (staged).md`, vault.files.get(`${FOLDER}/ACME.md`)!.replace("state: current", "state: in_transit"));
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();

		expect(repo.tickers()).toEqual(["ACME"]);
		expect(onNoteError).not.toHaveBeenCalled();
	});

	it("reports an unreadable note and still loads the others", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation());
		vault.files.set(`${FOLDER}/Broken.md`, "---\ntags: [stockvaluations/valuation]\n---\n");
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();

		expect(repo.tickers()).toEqual(["ACME"]);
		expect(onNoteError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing ticker property" }), `${FOLDER}/Broken.md`);
	});

	it("keeps the first of two notes for the same ticker and reports the other", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation({ updatedAt: 1 }));
		seed(vault, "ACME", fixtureValuation({ updatedAt: 2 }), `${FOLDER}/ACME2.md`);
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();

		expect(repo.getValuation("ACME")!.updatedAt).toBe(1);
		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), `${FOLDER}/ACME2.md`);
	});

	it("reports unreadable history rows but still loads the note", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation({ history: fixtureHistory }));
		vault.files.set(`${FOLDER}/ACME.md`, vault.files.get(`${FOLDER}/ACME.md`)!.replace("| 1700000000000 |", "| 1700000000000 | extra |"));
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();

		expect(repo.getValuation("ACME")).toBeDefined();
		expect(onNoteError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("unreadable row") }), `${FOLDER}/ACME.md`);
	});

	it("finds a note the user moved within the folder, by its ticker property, and writes back in place", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation(), `${FOLDER}/archive/anything.md`);
		const repo = newRepo(vault);
		await repo.load();
		expect(repo.getValuation("ACME")).toBeDefined();

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 9 }));

		expect(vault.modified).toEqual([`${FOLDER}/archive/anything.md`]);
		expect(vault.created).toEqual([]);
	});

	it("only reads the notes folder", async () => {
		const vault = new MemoryVault({ "Elsewhere/ACME.md": buildValuationNote("ACME", fixtureValuation()) });
		const repo = newRepo(vault);
		await repo.load();
		expect(repo.tickers()).toEqual([]);
		expect(vault.readCalls).toBe(0);
	});
});

describe("DataRepository startup cost of the one-time import", () => {
	it("a normal startup (no legacy keys in data.json) never asks the vault whether to import", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation());
		const adapter = jsonAdapter({ notesFolder: FOLDER, lastSeenVersion: "2.0.0" });
		const diskBefore = adapter.disk;
		const repo = newRepo(vault, adapter);
		await repo.load();

		expect(vault.existsCalls).toBe(0);
		expect(vault.listCalls).toBe(1);
		expect(vault.created).toEqual([]);
		expect(adapter.disk).toBe(diskBefore); // nothing written either
	});

	it("legacy keys with Settings.md already in place cost one path lookup and no import", async () => {
		const vault = new MemoryVault({ [`${FOLDER}/Settings.md`]: buildSettingsNote(fixtureSettings()) });
		seed(vault, "ACME", fixtureValuation());
		const adapter = jsonAdapter({ settings: {}, valuations: { OLD: legacyRecord() }, schemaVersion: 2 });
		const repo = newRepo(vault, adapter);
		await repo.load();

		expect(vault.existsCalls).toBe(1);
		expect(vault.created).toEqual([]);
		expect(repo.tickers()).toEqual(["ACME"]); // the notes win, the legacy table is not re-imported
		expect(JSON.parse(adapter.disk)).not.toHaveProperty("valuations");
	});
});

describe("DataRepository legacy data.json import", () => {
	it("imports a v1 (pre-scenario) table into notes, Settings.md last, then drops the legacy keys", async () => {
		const legacy = { ACME: legacyRecord(), GLOB: legacyRecord({ state: fixtureState({ ticker: "GLOB" }) }) };
		const adapter = jsonAdapter({ settings: { taxRate: 30 }, valuations: legacy, lastSeenVersion: "1.2.0" }); // no schemaVersion => v1
		const vault = new MemoryVault();
		const repo = newRepo(vault, adapter);
		await repo.load();

		expect(vault.created).toEqual([`${FOLDER}/ACME.md`, `${FOLDER}/GLOB.md`, `${FOLDER}/Settings.md`]);
		const migrated = repo.getValuation("ACME")!;
		expect(migrated.scenarios.base.state).toEqual(legacy.ACME.state);
		expect(migrated.scenarios.bull.state).toEqual(legacy.ACME.state);
		expect(repo.settings.taxRate).toBe(30);
		const disk = JSON.parse(adapter.disk);
		expect(disk).toEqual({ notesFolder: FOLDER, lastSeenVersion: "1.2.0" });
	});

	it("imports an already-v2 table with its history", async () => {
		const adapter = jsonAdapter({ settings: {}, valuations: { ACME: fixtureValuation({ history: fixtureHistory }) }, schemaVersion: 2 });
		const repo = newRepo(new MemoryVault(), adapter);
		await repo.load();

		expect(repo.getValuation("ACME")!.history).toEqual(fixtureHistory);
	});

	it("imports research links, refresh times and every scenario's inputs exactly as stored — even a link that no longer resolves", async () => {
		const stale = "investing/ACME-research.md"; // the file may since have moved; the import must not rewrite or drop it
		const record = fixtureValuation({ researchNotePath: stale, lastPriceRefreshAt: 1700000005000, history: fixtureHistory });
		const adapter = jsonAdapter({ settings: { enableResearchLinks: true, researchNotesFolder: "investing" }, valuations: { ACME: record }, schemaVersion: 2 });
		const vault = new MemoryVault();
		await newRepo(vault, adapter).load();

		const reloaded = newRepo(vault, fakeAdapter(null)); // reinstall-style: notes only
		await reloaded.load();
		const loaded = reloaded.getValuation("ACME")!;

		expect(loaded.researchNotePath).toBe(stale);
		expect(loaded.lastPriceRefreshAt).toBe(1700000005000);
		for (const key of ["bull", "base", "bear"] as const) {
			expect(loaded.scenarios[key].state).toEqual(record.scenarios[key].state);
		}
		expect(loaded.history).toEqual(fixtureHistory);
		expect(reloaded.settings.enableResearchLinks).toBe(true);
		expect(reloaded.settings.researchNotesFolder).toBe("investing");
	});

	it("imports into the folder the legacy settings named, or the retired summary note's folder", async () => {
		const vault = new MemoryVault();
		const named = newRepo(vault, fakeAdapter({ settings: { historyNotesFolder: "Inv" }, valuations: { ACME: fixtureValuation() }, schemaVersion: 2 }));
		await named.load();
		expect(vault.created).toContain("Inv/ACME.md");
		expect(named.settings.historyNotesFolder).toBe("Inv");

		const fromSummary = new MemoryVault();
		const repo = newRepo(
			fromSummary,
			fakeAdapter({ settings: { valuationsNotePath: "Investing/Valuations/Summary.md" }, valuations: { ACME: fixtureValuation() }, schemaVersion: 2 })
		);
		await repo.load();
		expect(fromSummary.created).toContain("Investing/Valuations/ACME.md");
		expect("valuationsNotePath" in repo.settings).toBe(false);
	});

	it("keeps an explicitly-set historyNotesFolder over the retired valuationsNotePath, and uses the root for a root summary note", async () => {
		const repo = newRepo(new MemoryVault(), fakeAdapter({ settings: { valuationsNotePath: "Old/Summary.md", historyNotesFolder: "New" }, schemaVersion: 2 }));
		await repo.load();
		expect(repo.settings.historyNotesFolder).toBe("New");

		const root = newRepo(new MemoryVault(), fakeAdapter({ settings: { valuationsNotePath: "Summary.md" }, schemaVersion: 2 }));
		await root.load();
		expect(root.settings.historyNotesFolder).toBe("");
	});

	it("treats legacy keys without a valuations table as empty", async () => {
		const vault = new MemoryVault();
		const repo = newRepo(vault, fakeAdapter({ settings: {} }));
		await expect(repo.load()).resolves.not.toThrow();
		expect(repo.getAllValuations()).toEqual({});
		expect(vault.created).toEqual([`${FOLDER}/Settings.md`]);
	});

	it("never overwrites a file that is already there: a foreign TICKER.md gets a sibling note", async () => {
		const vault = new MemoryVault({ [`${FOLDER}/ACME.md`]: "my own note about ACME" });
		const repo = newRepo(vault, fakeAdapter({ settings: {}, valuations: { ACME: fixtureValuation() }, schemaVersion: 2 }));
		await repo.load();

		expect(vault.files.get(`${FOLDER}/ACME.md`)).toBe("my own note about ACME");
		expect(vault.created).toContain(`${FOLDER}/ACME (valuation).md`);
		expect(repo.getValuation("ACME")).toBeDefined();
	});

	it("leaves the old TICKER-history.md files exactly as they were", async () => {
		const old = "# ACME — valuation history\n\n| Date | Price |\n|---|---:|\n| 2026-01-01 | $50 |\n";
		const vault = new MemoryVault({ [`${FOLDER}/ACME-history.md`]: old });
		const repo = newRepo(vault, fakeAdapter({ settings: {}, valuations: { ACME: fixtureValuation() }, schemaVersion: 2 }));
		await repo.load();

		expect(vault.files.get(`${FOLDER}/ACME-history.md`)).toBe(old);
		expect(vault.modified).toEqual([]);
		expect(vault.trashed).toEqual([]);
	});

	it("a failure before the marker keeps the legacy data, runs from it, and retries cleanly on the next start", async () => {
		const consoleError = silenceConsole();
		const adapter = jsonAdapter({ settings: { taxRate: 30 }, valuations: { ACME: fixtureValuation(), GLOB: fixtureValuation({}, "GLOB") }, schemaVersion: 2 });
		const vault = new MemoryVault();
		vault.failOn("create", `${FOLDER}/Settings.md`);
		const onNoteError = vi.fn();
		const first = newRepo(vault, adapter, onNoteError);
		await first.load();

		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "Settings");
		expect(vault.files.has(`${FOLDER}/Settings.md`)).toBe(false); // no marker
		expect(first.tickers().sort()).toEqual(["ACME", "GLOB"]); // still usable this session
		expect(JSON.parse(adapter.disk)).toHaveProperty("valuations"); // legacy kept for the retry

		const second = newRepo(vault, adapter);
		await second.load();

		expect(vault.created.filter((p) => p === `${FOLDER}/ACME.md`)).toHaveLength(1); // not duplicated
		expect(vault.files.has(`${FOLDER}/Settings.md`)).toBe(true);
		expect(second.tickers().sort()).toEqual(["ACME", "GLOB"]);
		expect(second.settings.taxRate).toBe(30);
		expect(JSON.parse(adapter.disk)).not.toHaveProperty("valuations");
		consoleError.mockRestore();
	});

	it("a ticker note that can't be written blocks the marker and is reported", async () => {
		const consoleError = silenceConsole();
		const adapter = fakeAdapter({ settings: {}, valuations: { ACME: fixtureValuation(), GLOB: fixtureValuation({}, "GLOB") }, schemaVersion: 2 });
		const vault = new MemoryVault();
		vault.failOn("create", `${FOLDER}/GLOB.md`);
		const onNoteError = vi.fn();
		const repo = newRepo(vault, adapter, onNoteError);
		await repo.load();

		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "GLOB");
		expect(vault.files.has(`${FOLDER}/Settings.md`)).toBe(false);
		expect(adapter.current).toHaveProperty("valuations");
		consoleError.mockRestore();
	});
});

describe("DataRepository valuation CRUD", () => {
	async function loadedRepo(onNoteError: (e: unknown, s: string) => void = () => {}) {
		const vault = new MemoryVault();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();
		return { vault, repo };
	}

	it("saveValuation creates the ticker's note, then updates the same note", async () => {
		const { vault, repo } = await loadedRepo();
		const record = fixtureValuation();

		await repo.saveValuation("ACME", record);
		expect(repo.getValuation("ACME")).toBe(record);
		expect(vault.created).toEqual([`${FOLDER}/ACME.md`]);

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 2 }));
		expect(vault.created).toHaveLength(1);
		expect(vault.modified).toEqual([`${FOLDER}/ACME.md`]);
		expect(repo.getValuation("ACME")?.updatedAt).toBe(2);
	});

	it("writes a note other plugins can find by tag", async () => {
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		const props = parseProps(vault.files.get(`${FOLDER}/ACME.md`)!);
		expect(props.tags).toEqual(["stockvaluations/valuation"]);
		expect(props.ticker).toBe("ACME");
	});

	it("saveValuation rewrites only the saved ticker's note, never the others'", async () => {
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		await repo.saveValuation("GLOB", fixtureValuation({}, "GLOB"));
		vault.modified.length = 0;

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 2 }));

		expect(vault.modified).toEqual([`${FOLDER}/ACME.md`]);
	});

	it("two quick saves of a brand-new ticker create its note once", async () => {
		const { vault, repo } = await loadedRepo();
		await Promise.all([repo.saveValuation("ACME", fixtureValuation()), repo.saveValuation("ACME", fixtureValuation({ updatedAt: 2 }))]);

		expect(vault.created).toEqual([`${FOLDER}/ACME.md`]);
		expect(vault.modified).toEqual([`${FOLDER}/ACME.md`]);
	});

	it("a new ticker whose default path is taken by another file gets a sibling note", async () => {
		const vault = new MemoryVault({ [`${FOLDER}/ACME.md`]: "someone else's note" });
		const repo = newRepo(vault);
		await repo.load();
		await repo.saveValuation("ACME", fixtureValuation());

		expect(vault.files.get(`${FOLDER}/ACME.md`)).toBe("someone else's note");
		expect(vault.created).toEqual([`${FOLDER}/ACME (valuation).md`]);
	});

	it("reports when both candidate paths are taken, instead of overwriting", async () => {
		const consoleError = silenceConsole();
		const vault = new MemoryVault({ [`${FOLDER}/ACME.md`]: "a", [`${FOLDER}/ACME (valuation).md`]: "b" });
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();
		await repo.saveValuation("ACME", fixtureValuation());

		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "ACME");
		expect(vault.files.get(`${FOLDER}/ACME.md`)).toBe("a");
		consoleError.mockRestore();
	});

	it("deleteValuation sends the ticker's note to the trash and forgets the record", async () => {
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());

		await repo.deleteValuation("ACME");

		expect(repo.getValuation("ACME")).toBeUndefined();
		expect(vault.trashed).toEqual([`${FOLDER}/ACME.md`]);
		const reloaded = newRepo(vault);
		await reloaded.load();
		expect(reloaded.tickers()).toEqual([]);
	});

	it("deleteValuation on a ticker that was never saved is a harmless no-op", async () => {
		const { vault, repo } = await loadedRepo();
		await expect(repo.deleteValuation("NOPE")).resolves.not.toThrow();
		expect(vault.trashed).toEqual([]);
	});

	it("deleteValuation reports a failed trash", async () => {
		const consoleError = silenceConsole();
		const onNoteError = vi.fn();
		const { vault, repo } = await loadedRepo(onNoteError);
		await repo.saveValuation("ACME", fixtureValuation());
		vault.failOn("trash", `${FOLDER}/ACME.md`);

		await repo.deleteValuation("ACME");

		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "ACME");
		consoleError.mockRestore();
	});

	it("keeps going when one ticker's note fails, reporting that ticker", async () => {
		const consoleError = silenceConsole();
		const onNoteError = vi.fn();
		const { vault, repo } = await loadedRepo(onNoteError);
		for (const t of ["ACME", "GLOB", "ZETA"]) await repo.saveValuation(t, fixtureValuation({}, t));
		vault.modified.length = 0;
		vault.failOn("modify", `${FOLDER}/GLOB.md`);

		await repo.persistValuations(["GLOB", "ZETA"]);

		expect(vault.modified).toEqual([`${FOLDER}/ZETA.md`]);
		expect(onNoteError).toHaveBeenCalledTimes(1);
		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "GLOB");
		consoleError.mockRestore();
	});

	it("persistValuations rewrites exactly the named tickers' notes, skipping any that no longer exist", async () => {
		const { vault, repo } = await loadedRepo();
		for (const t of ["ACME", "GLOB", "ZETA"]) await repo.saveValuation(t, fixtureValuation({}, t));
		vault.modified.length = 0;

		await repo.persistValuations(["ACME", "ZETA", "GONE"]);

		expect(vault.modified).toEqual([`${FOLDER}/ACME.md`, `${FOLDER}/ZETA.md`]);
	});

	it("persistValuations flushes an in-place mutation (a research link) into the note", async () => {
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());

		repo.getValuation("ACME")!.researchNotePath = "Research/ACME.md";
		await repo.persistValuations(["ACME"]);

		const reloaded = newRepo(vault);
		await reloaded.load();
		expect(reloaded.getValuation("ACME")!.researchNotePath).toBe("Research/ACME.md");
	});

	it("compacting or deleting history entries shrinks the note's table, and a reload sees the shorter history", async () => {
		const DAY = 24 * 60 * 60 * 1000;
		const now = Date.UTC(2026, 9, 15, 12);
		const entry = (at: number) => ({ ...fixtureHistory[0], at });
		// Three old entries in one January and two in one February (all > 6 months ago), plus two recent ones.
		const history = [
			entry(Date.UTC(2026, 0, 5, 12)),
			entry(Date.UTC(2026, 0, 12, 12)),
			entry(Date.UTC(2026, 0, 20, 12)),
			entry(Date.UTC(2026, 1, 3, 12)),
			entry(Date.UTC(2026, 1, 17, 12)),
			entry(now - 10 * DAY),
			entry(now - 2 * DAY),
		];
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation({ history }));

		const live = repo.getValuation("ACME")!;
		live.history = compactHistory(live.history!, now);
		await repo.persistValuations(["ACME"]);

		const afterCompact = newRepo(vault);
		await afterCompact.load();
		const compacted = afterCompact.getValuation("ACME")!.history!;
		expect(compacted).toHaveLength(4); // one for January, one for February, two recent
		expect(compacted.map((e) => e.at)).toEqual(live.history!.map((e) => e.at));

		const first = afterCompact.getValuation("ACME")!;
		first.history = deleteHistoryEntry(first.history!, now - 2 * DAY);
		await afterCompact.persistValuations(["ACME"]);
		const afterDelete = newRepo(vault);
		await afterDelete.load();
		expect(afterDelete.getValuation("ACME")!.history).toHaveLength(3);

		// Deleting the last entries leaves a note with an empty table, still readable.
		const last = afterDelete.getValuation("ACME")!;
		delete last.history;
		await afterDelete.persistValuations(["ACME"]);
		const afterEmpty = newRepo(vault);
		await afterEmpty.load();
		expect(afterEmpty.getValuation("ACME")).toBeDefined();
		expect(afterEmpty.getValuation("ACME")!.history).toBeUndefined();
	});

	it("tickers() and getAllValuations() reflect every saved ticker", async () => {
		const { repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		await repo.saveValuation("GLOB", fixtureValuation({}, "GLOB"));

		expect(repo.tickers().sort()).toEqual(["ACME", "GLOB"]);
		expect(Object.keys(repo.getAllValuations()).sort()).toEqual(["ACME", "GLOB"]);
	});

	it("refuses to overwrite a note with an unreadable history row, and says so", async () => {
		const consoleError = silenceConsole();
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation({ history: fixtureHistory }));
		const damaged = vault.files.get(`${FOLDER}/ACME.md`)!.replace("| 1700000000000 |", "| 1700000000000 | extra |");
		vault.files.set(`${FOLDER}/ACME.md`, damaged);
		const onNoteError = vi.fn();
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();
		onNoteError.mockClear();

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 99 }));

		expect(vault.files.get(`${FOLDER}/ACME.md`)).toBe(damaged);
		expect(onNoteError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("unreadable row") }), "ACME");
		consoleError.mockRestore();
	});

	it("keeps the user's own prose and properties in a note across saves", async () => {
		const { vault, repo } = await loadedRepo();
		await repo.saveValuation("ACME", fixtureValuation());
		vault.files.set(`${FOLDER}/ACME.md`, vault.files.get(`${FOLDER}/ACME.md`)!.replace("state: current", "state: current\nmine: yes") + "\nMy thoughts.\n");

		await repo.saveValuation("ACME", fixtureValuation({ updatedAt: 5 }));

		const text = vault.files.get(`${FOLDER}/ACME.md`)!;
		expect(text).toContain("mine: yes");
		expect(text).toContain("My thoughts.");
		expect(text).toContain("updatedAt: 5");
	});
});

describe("DataRepository settings", () => {
	it("saveSettings creates Settings.md on first save, then updates it, without touching ticker notes", async () => {
		const vault = new MemoryVault();
		const repo = newRepo(vault);
		await repo.load();
		await repo.saveValuation("ACME", fixtureValuation());
		vault.modified.length = 0;

		repo.settings.taxRate = 33;
		await repo.saveSettings();
		repo.settings.taxRate = 34;
		await repo.saveSettings();

		expect(vault.created).toContain(`${FOLDER}/Settings.md`);
		expect(vault.modified).toEqual([`${FOLDER}/Settings.md`]);
		const reloaded = newRepo(vault);
		await reloaded.load();
		expect(reloaded.settings.taxRate).toBe(34);
	});

	it("keeps the notes folder out of Settings.md", async () => {
		const vault = new MemoryVault();
		const repo = newRepo(vault);
		await repo.load();
		await repo.saveSettings();
		expect(vault.files.get(`${FOLDER}/Settings.md`)).not.toContain("historyNotesFolder");
	});

	it("reports a settings write that fails", async () => {
		const consoleError = silenceConsole();
		const onNoteError = vi.fn();
		const vault = new MemoryVault();
		vault.failOn("create", `${FOLDER}/Settings.md`);
		const repo = newRepo(vault, fakeAdapter(null), onNoteError);
		await repo.load();

		await repo.saveSettings();

		expect(onNoteError).toHaveBeenCalledWith(expect.any(Error), "Settings");
		consoleError.mockRestore();
	});

	it("setNotesFolder loads from the new folder, remembers it in data.json, and leaves the old notes alone", async () => {
		const vault = new MemoryVault();
		seed(vault, "ACME", fixtureValuation());
		seed(vault, "GLOB", fixtureValuation({}, "GLOB"), "Other/GLOB.md");
		const adapter = fakeAdapter(null);
		const repo = newRepo(vault, adapter);
		await repo.load();
		expect(repo.tickers()).toEqual(["ACME"]);

		await repo.setNotesFolder("Other/");

		expect(repo.settings.historyNotesFolder).toBe("Other");
		expect(repo.tickers()).toEqual(["GLOB"]);
		expect((adapter.current as { notesFolder: string }).notesFolder).toBe("Other");
		expect(vault.files.has(`${FOLDER}/ACME.md`)).toBe(true);
		expect(vault.created).toEqual([]); // nothing written just by switching
	});

	it("saveLocalState writes only data.json", async () => {
		const vault = new MemoryVault();
		const adapter = fakeAdapter(null);
		const repo = newRepo(vault, adapter);
		await repo.load();
		repo.lastSeenVersion = "2.0.0";

		await repo.saveLocalState();

		expect(adapter.current).toMatchObject({ lastSeenVersion: "2.0.0", notesFolder: FOLDER });
		expect(vault.created).toEqual([]);
	});
});

describe("DataRepository macro data caching", () => {
	const macroRows = [{ month: "2026-09-01", cape: 40, trCape: 43, dividendYield: 0.01, sp500: 7600, realPrice: 7600 }];

	async function loadedRepo(fetchMacro = vi.fn().mockResolvedValue(macroRows)) {
		const adapter = fakeAdapter(null);
		const repo = new DataRepository(adapter, fixtureSettings(), new MemoryVault(), () => {}, () => Promise.resolve(null), fetchMacro);
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

describe("DataRepository market data caching", () => {
	const reading = (latest: number) => ({ latest, yearAgo: null });
	const snapshot = {
		yields: { "3M": reading(4), "5Y": reading(5), "10Y": reading(5.2), "30Y": reading(5.6) },
		spread: [{ t: 1_700_000_000_000, v: 1.2 }],
		quotes: {
			vix: { price: 18, weekChangePct: 2 },
			gold: { price: 2000, weekChangePct: 0.5 },
			silver: { price: 25, weekChangePct: -1 },
			oil: { price: 80, weekChangePct: 3 },
		},
	};

	async function loadedRepo(fetchMarket = vi.fn().mockResolvedValue(snapshot), initial: object = {}) {
		const adapter = fakeAdapter({ ...initial });
		const repo = new DataRepository(
			adapter,
			fixtureSettings(),
			new MemoryVault(),
			() => {},
			() => Promise.resolve(null),
			() => Promise.resolve(null),
			fetchMarket
		);
		await repo.load();
		return { adapter, repo, fetchMarket };
	}

	it("getCachedMarketData is null until a fetch has ever succeeded", async () => {
		const { repo } = await loadedRepo();
		expect(repo.getCachedMarketData()).toBeNull();
	});

	it("refreshMarketData fetches, caches, and persists on first call", async () => {
		const { adapter, repo, fetchMarket } = await loadedRepo();

		const result = await repo.refreshMarketData();

		expect(result).toEqual(snapshot);
		expect(fetchMarket).toHaveBeenCalledTimes(1);
		expect(repo.getCachedMarketData()).toEqual(snapshot);
		expect(adapter.current).toMatchObject({ marketCache: { snapshot } });
	});

	it("does not refetch within the 24h TTL", async () => {
		const { repo, fetchMarket } = await loadedRepo();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMarketData();
		now.mockReturnValue(1_700_000_000_000 + 23 * 60 * 60 * 1000); // 23h later
		await repo.refreshMarketData();

		expect(fetchMarket).toHaveBeenCalledTimes(1);
		now.mockRestore();
	});

	it("refetches once the TTL has elapsed", async () => {
		const { repo, fetchMarket } = await loadedRepo();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMarketData();
		now.mockReturnValue(1_700_000_000_000 + 25 * 60 * 60 * 1000); // 25h later
		await repo.refreshMarketData();

		expect(fetchMarket).toHaveBeenCalledTimes(2);
		now.mockRestore();
	});

	it("a failed fetch falls back to whatever's already cached, without clearing it", async () => {
		const fetchMarket = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(null);
		const { repo } = await loadedRepo(fetchMarket);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await repo.refreshMarketData();
		now.mockReturnValue(1_700_000_000_000 + 25 * 60 * 60 * 1000); // past the TTL, forces a refetch
		const result = await repo.refreshMarketData();

		expect(result).toEqual(snapshot);
		expect(repo.getCachedMarketData()).toEqual(snapshot);
		now.mockRestore();
	});

	it("a failed fetch with nothing ever cached returns null", async () => {
		const { repo } = await loadedRepo(vi.fn().mockResolvedValue(null));

		expect(await repo.refreshMarketData()).toBeNull();
		expect(repo.getCachedMarketData()).toBeNull();
	});

	it("drops a persisted cache from before snapshots had quotes, and refetches", async () => {
		const { repo, fetchMarket } = await loadedRepo(undefined, {
			marketCache: { snapshot: { yields: {}, spread: [], vix: 18 }, fetchedAt: Date.now() },
		});

		expect(repo.getCachedMarketData()).toBeNull();
		await repo.refreshMarketData();

		expect(fetchMarket).toHaveBeenCalledTimes(1);
	});

	it("loads a previously persisted cache and serves it without fetching", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const { repo, fetchMarket } = await loadedRepo(undefined, {
			marketCache: { snapshot, fetchedAt: 1_700_000_000_000 - 10 * 60 * 1000 },
		});

		expect(repo.getCachedMarketData()).toEqual(snapshot);
		await repo.refreshMarketData();

		expect(fetchMarket).not.toHaveBeenCalled();
		now.mockRestore();
	});
});
