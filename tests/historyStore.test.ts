import { describe, expect, it } from "vitest";
import { appendHistoryEntry, buildHistoryEntry, compactHistory, deleteHistoryEntry } from "../historyStore";
import type { FormState, HistoryEntry, Results, Scenario, ScenarioKey } from "../valuationStore";

// All timestamps built via local Date components (not raw epoch literals) so
// the tests reason about calendar days/months the same way historyStore.ts
// does, regardless of the machine's timezone.
function at(year: number, month: number, day: number, hour = 12): number {
	return new Date(year, month, day, hour).getTime();
}

function fixtureEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		at: at(2024, 0, 15),
		price: 50,
		dcfBearIv: 40,
		dcfBaseIv: 60,
		dcfBullIv: 80,
		grahamBearIv: 45,
		grahamBaseIv: 55,
		grahamBullIv: 65,
		tenCapIv: 45,
		impliedGrowth: 0.07,
		...overrides,
	};
}

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

function fixtureScenarios(overrides: Partial<Record<ScenarioKey, Scenario>> = {}): Record<ScenarioKey, Scenario> {
	return {
		bear: { state: fixtureState(), results: fixtureResults({ dcfIv: 40, grahamIv: 45 }) },
		base: { state: fixtureState(), results: fixtureResults({ dcfIv: 60, grahamIv: 55, tenCapIv: 45, impliedGrowth: 0.07 }) },
		bull: { state: fixtureState(), results: fixtureResults({ dcfIv: 80, grahamIv: 65 }) },
		...overrides,
	};
}

describe("buildHistoryEntry", () => {
	it("maps each scenario's DCF/Graham IV into its Bear/Base/Bull field", () => {
		const entry = buildHistoryEntry(at(2024, 0, 15), fixtureScenarios());

		expect(entry).toEqual(
			fixtureEntry({
				at: at(2024, 0, 15),
				price: 50,
				dcfBearIv: 40,
				dcfBaseIv: 60,
				dcfBullIv: 80,
				grahamBearIv: 45,
				grahamBaseIv: 55,
				grahamBullIv: 65,
				tenCapIv: 45,
				impliedGrowth: 0.07,
			})
		);
	});

	it("reads price, Ten Cap IV, and implied growth off Base, ignoring Bear/Bull for those", () => {
		const scenarios = fixtureScenarios({
			base: { state: fixtureState({ price: "123.45" }), results: fixtureResults({ tenCapIv: 99, impliedGrowth: 0.11 }) },
		});
		const entry = buildHistoryEntry(Date.now(), scenarios);

		expect(entry.price).toBe(123.45);
		expect(entry.tenCapIv).toBe(99);
		expect(entry.impliedGrowth).toBe(0.11);
	});

	it("falls back to 0 for an unparseable base price", () => {
		const scenarios = fixtureScenarios({ base: { state: fixtureState({ price: "" }), results: fixtureResults() } });
		expect(buildHistoryEntry(Date.now(), scenarios).price).toBe(0);
	});

	it("uses the given timestamp verbatim", () => {
		const t = at(2024, 5, 1);
		expect(buildHistoryEntry(t, fixtureScenarios()).at).toBe(t);
	});
});

describe("appendHistoryEntry", () => {
	it("starts a new timeline from undefined history", () => {
		const entry = fixtureEntry();
		expect(appendHistoryEntry(undefined, entry)).toEqual([entry]);
	});

	it("appends an entry from a new calendar day, keeping both", () => {
		const day1 = fixtureEntry({ at: at(2024, 0, 15), price: 50 });
		const day2 = fixtureEntry({ at: at(2024, 0, 16), price: 52 });
		expect(appendHistoryEntry([day1], day2)).toEqual([day1, day2]);
	});

	it("replaces same-day entries instead of duplicating them", () => {
		const morning = fixtureEntry({ at: at(2024, 0, 15, 9), price: 50 });
		const evening = fixtureEntry({ at: at(2024, 0, 15, 21), price: 53 });
		const result = appendHistoryEntry([morning], evening);
		expect(result).toEqual([evening]);
	});

	it("only touches the entry matching the new one's day, leaving other days alone", () => {
		const day1 = fixtureEntry({ at: at(2024, 0, 14), price: 48 });
		const day2Old = fixtureEntry({ at: at(2024, 0, 15, 9), price: 50 });
		const day2New = fixtureEntry({ at: at(2024, 0, 15, 21), price: 53 });
		const day3 = fixtureEntry({ at: at(2024, 0, 16), price: 55 });

		const result = appendHistoryEntry([day1, day2Old, day3], day2New);
		expect(result).toEqual([day1, day2New, day3]);
	});

	it("returns entries sorted ascending by time regardless of insertion order", () => {
		const earlier = fixtureEntry({ at: at(2024, 0, 10) });
		const later = fixtureEntry({ at: at(2024, 0, 20) });
		const result = appendHistoryEntry([later], earlier);
		expect(result.map((h) => h.at)).toEqual([earlier.at, later.at]);
	});
});

describe("deleteHistoryEntry", () => {
	it("removes the entry with the matching timestamp", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		const b = fixtureEntry({ at: at(2024, 0, 11) });
		expect(deleteHistoryEntry([a, b], a.at)).toEqual([b]);
	});

	it("is a no-op when no entry matches", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		expect(deleteHistoryEntry([a], at(2024, 0, 11))).toEqual([a]);
	});

	it("leaves every other entry untouched", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		const b = fixtureEntry({ at: at(2024, 0, 11) });
		const c = fixtureEntry({ at: at(2024, 0, 12) });
		expect(deleteHistoryEntry([a, b, c], b.at)).toEqual([a, c]);
	});
});

describe("compactHistory", () => {
	it("leaves entries from the last ~6 months untouched, even several per month", () => {
		const now = at(2024, 6, 1); // Jul 1, 2024
		const recent1 = fixtureEntry({ at: at(2024, 5, 1) }); // Jun 1 — within 6mo
		const recent2 = fixtureEntry({ at: at(2024, 5, 15) }); // Jun 15 — same month, both kept
		expect(compactHistory([recent1, recent2], now)).toEqual([recent1, recent2]);
	});

	it("collapses entries older than ~6 months to the latest one per calendar month", () => {
		const now = at(2024, 6, 1); // Jul 1, 2024 — cutoff is ~Jan 1, 2024
		const janEarly = fixtureEntry({ at: at(2023, 11, 5), price: 40 }); // Dec 2023
		const janLate = fixtureEntry({ at: at(2023, 11, 28), price: 44 }); // Dec 2023, later
		const febOnly = fixtureEntry({ at: at(2024, 0, 10), price: 46 }); // Jan 2024

		const result = compactHistory([janEarly, janLate, febOnly], now);

		expect(result).toEqual([janLate, febOnly]);
	});

	it("combines a compacted old tail with an untouched recent head, in chronological order", () => {
		const now = at(2024, 6, 1);
		const oldA = fixtureEntry({ at: at(2023, 11, 5), price: 40 });
		const oldB = fixtureEntry({ at: at(2023, 11, 20), price: 42 });
		const recent = fixtureEntry({ at: at(2024, 5, 20), price: 60 });

		const result = compactHistory([oldA, oldB, recent], now);

		expect(result).toEqual([oldB, recent]);
	});

	it("is idempotent — compacting an already-compacted history changes nothing", () => {
		const now = at(2024, 6, 1);
		const oldA = fixtureEntry({ at: at(2023, 11, 5), price: 40 });
		const oldB = fixtureEntry({ at: at(2023, 11, 20), price: 42 });
		const recent = fixtureEntry({ at: at(2024, 5, 20), price: 60 });

		const once = compactHistory([oldA, oldB, recent], now);
		const twice = compactHistory(once, now);

		expect(twice).toEqual(once);
	});

	it("returns an empty array for empty input", () => {
		expect(compactHistory([], at(2024, 6, 1))).toEqual([]);
	});
});
