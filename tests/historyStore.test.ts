import { describe, expect, it } from "vitest";
import {
	appendHistoryEntry,
	buildHistoryEntry,
	buildSyntheticHistory,
	cappedDdmGrowth,
	compactHistory,
	DDM_GROWTH_MARGIN_PP,
	deleteHistoryEntry,
	entryLinePoints,
	mergeSyntheticHistory,
	monthlyCloses,
	removeSyntheticHistory,
	usesDdm,
} from "../historyStore";
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
		pegRatio: 1.5,
		...overrides,
	};
}

function fixtureScenarios(overrides: Partial<Record<ScenarioKey, Scenario>> = {}): Record<ScenarioKey, Scenario> {
	return {
		bear: { state: fixtureState(), results: fixtureResults({ dcfIv: 40, grahamIv: 45, ddmIv: 30 }) },
		base: { state: fixtureState(), results: fixtureResults({ dcfIv: 60, grahamIv: 55, ddmIv: 50, tenCapIv: 45, impliedGrowth: 0.07 }) },
		bull: { state: fixtureState(), results: fixtureResults({ dcfIv: 80, grahamIv: 65, ddmIv: 70 }) },
		...overrides,
	};
}

describe("buildHistoryEntry", () => {
	it("maps each scenario's DCF/Graham/DDM IV into its Bear/Base/Bull field", () => {
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
				ddmBearIv: 30,
				ddmBaseIv: 50,
				ddmBullIv: 70,
			})
		);
	});

	it("records a non-payer's DDM as NaN in every scenario", () => {
		const scenarios = fixtureScenarios({
			bear: { state: fixtureState(), results: fixtureResults() },
			base: { state: fixtureState(), results: fixtureResults() },
			bull: { state: fixtureState(), results: fixtureResults() },
		});
		const entry = buildHistoryEntry(Date.now(), scenarios);
		expect(entry.ddmBearIv).toBeNaN();
		expect(entry.ddmBaseIv).toBeNaN();
		expect(entry.ddmBullIv).toBeNaN();
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

describe("entryLinePoints", () => {
	const first = at(2024, 0, 1);
	const mid = at(2024, 3, 1);
	const last = at(2024, 5, 1);
	const times = [first, mid, last];

	it("is empty without a usable entry", () => {
		expect(entryLinePoints(undefined, "2024-02-01", times)).toEqual([]);
		expect(entryLinePoints(0, "2024-02-01", times)).toEqual([]);
		expect(entryLinePoints(42, undefined, [])).toEqual([]);
	});

	it("has a point at every history time when there is no date, so the tooltip finds it anywhere", () => {
		expect(entryLinePoints(42, undefined, times)).toEqual([
			{ x: first, y: 42 },
			{ x: mid, y: 42 },
			{ x: last, y: 42 },
		]);
	});

	it("starts at the entry date, then every later history time", () => {
		const entry = new Date(2024, 2, 1).getTime();
		expect(entryLinePoints(42, "2024-03-01", times).map((p) => p.x)).toEqual([entry, mid, last]);
	});

	it("clamps an entry date before the chart start", () => {
		expect(entryLinePoints(42, "2020-01-01", times)[0].x).toBe(first);
	});

	it("is empty when the entry date is after the newest point", () => {
		expect(entryLinePoints(42, "2025-01-01", times)).toEqual([]);
	});
});

const syn = (y: number, m: number, d: number, price = 10) => fixtureEntry({ at: at(y, m, d, 0), price, synthetic: true });

describe("monthlyCloses", () => {
	const now = at(2026, 9, 27);

	it("dates each close the last day of its month at local midnight", () => {
		const out = monthlyCloses([{ t: at(2026, 1, 1, 0), v: 10 }], now);
		expect(out).toEqual([{ at: new Date(2026, 1, 28).getTime(), price: 10 }]);
		expect(monthlyCloses([{ t: at(2024, 1, 1, 0), v: 10 }], now)[0].at).toBe(new Date(2024, 1, 29).getTime());
	});

	it("skips the current month, including the trailing live-quote row", () => {
		const out = monthlyCloses(
			[
				{ t: at(2026, 8, 1, 0), v: 9 },
				{ t: at(2026, 9, 1, 0), v: 10 },
				{ t: at(2026, 9, 27, 0), v: 11 },
			],
			now
		);
		expect(out).toEqual([{ at: new Date(2026, 8, 30).getTime(), price: 9 }]);
	});

	it("keeps one entry per month, the later row winning, sorted ascending", () => {
		const out = monthlyCloses(
			[
				{ t: at(2026, 2, 1, 0), v: 3 },
				{ t: at(2026, 0, 1, 0), v: 1 },
				{ t: at(2026, 0, 20, 0), v: 2 },
			],
			now
		);
		expect(out.map((c) => c.price)).toEqual([2, 3]);
	});

	it("ignores non-positive or non-finite closes", () => {
		expect(monthlyCloses([{ t: at(2026, 0, 1, 0), v: 0 }, { t: at(2026, 1, 1, 0), v: NaN }], now)).toEqual([]);
	});
});

describe("buildSyntheticHistory", () => {
	// A recompute stub that exposes the price it was given, so the test can see it was swapped in.
	const recompute = (state: FormState) => fixtureResults({ dcfIv: Number(state.price) * 2 });

	it("builds one synthetic entry per close at that close's price, using the recomputed results", () => {
		const closes = [
			{ at: at(2026, 0, 31, 0), price: 20 },
			{ at: at(2026, 1, 28, 0), price: 30 },
		];
		const out = buildSyntheticHistory(closes, fixtureScenarios(), recompute);
		expect(out.map((e) => [e.at, e.price, e.dcfBaseIv, e.synthetic])).toEqual([
			[closes[0].at, 20, 40, true],
			[closes[1].at, 30, 60, true],
		]);
	});

	it("sets the price on every scenario and never mutates the saved scenarios", () => {
		const scenarios = fixtureScenarios();
		const out = buildSyntheticHistory([{ at: at(2026, 0, 31, 0), price: 20 }], scenarios, recompute);
		expect([out[0].dcfBearIv, out[0].dcfBaseIv, out[0].dcfBullIv]).toEqual([40, 40, 40]);
		expect(scenarios.base.state.price).toBe("50");
		expect(scenarios.base.results.dcfIv).toBe(60);
	});

	it("keeps fundamentals fixed: methods that ignore price carry today's values", () => {
		const stable = () => fixtureResults({ grahamIv: 55, tenCapIv: 45 });
		const out = buildSyntheticHistory(
			[{ at: at(2026, 0, 31, 0), price: 20 }, { at: at(2026, 1, 28, 0), price: 80 }],
			fixtureScenarios(),
			stable
		);
		expect(out.map((e) => e.grahamBaseIv)).toEqual([55, 55]);
		expect(out.map((e) => e.tenCapIv)).toEqual([45, 45]);
	});

	it("returns nothing for no closes", () => {
		expect(buildSyntheticHistory([], fixtureScenarios(), recompute)).toEqual([]);
	});
});

describe("mergeSyntheticHistory", () => {
	it("adds synthetic entries before the first real one, sorted ascending", () => {
		const real = fixtureEntry({ at: at(2026, 5, 10) });
		const out = mergeSyntheticHistory([real], [syn(2026, 1, 28), syn(2026, 0, 31)]);
		expect(out.map((e) => e.at)).toEqual([at(2026, 0, 31, 0), at(2026, 1, 28, 0), real.at]);
	});

	it("works with no existing history", () => {
		expect(mergeSyntheticHistory(undefined, [syn(2026, 0, 31)])).toHaveLength(1);
	});

	it("drops a synthetic entry in a month that already has a real one", () => {
		const real = fixtureEntry({ at: at(2026, 1, 5) });
		const out = mergeSyntheticHistory([real], [syn(2026, 0, 31), syn(2026, 1, 28)]);
		expect(out).toEqual([syn(2026, 0, 31), real]);
	});

	it("drops synthetic entries on or after the first real entry", () => {
		const real = fixtureEntry({ at: at(2026, 1, 5) });
		const out = mergeSyntheticHistory([real], [syn(2026, 2, 31), syn(2026, 5, 30)]);
		expect(out).toEqual([real]);
	});

	it("never alters or replaces a real entry", () => {
		const real = fixtureEntry({ at: at(2026, 1, 28, 0), price: 77 });
		const out = mergeSyntheticHistory([real], [syn(2026, 1, 28, 1)]);
		expect(out).toEqual([real]);
		expect(out[0].synthetic).toBeUndefined();
	});

	it("replaces the previous synthetic set on a re-run", () => {
		const real = fixtureEntry({ at: at(2026, 5, 10) });
		const first = mergeSyntheticHistory([real], [syn(2026, 0, 31, 1), syn(2026, 1, 28, 2)]);
		const second = mergeSyntheticHistory(first, [syn(2026, 1, 28, 9)]);
		expect(second).toEqual([syn(2026, 1, 28, 9), real]);
	});

	it("is a no-op for real data when given no synthetic entries", () => {
		const real = [fixtureEntry({ at: at(2026, 0, 10) }), fixtureEntry({ at: at(2026, 3, 10) })];
		expect(mergeSyntheticHistory([...real, syn(2025, 0, 31)], [])).toEqual(real);
	});

	it("keeps real entries when everything synthetic is blocked", () => {
		const real = fixtureEntry({ at: at(2025, 0, 10) });
		expect(mergeSyntheticHistory([real], [syn(2025, 0, 31), syn(2026, 0, 31)])).toEqual([real]);
	});
});

describe("removeSyntheticHistory", () => {
	it("removes only synthetic entries", () => {
		const real = fixtureEntry({ at: at(2026, 5, 10) });
		expect(removeSyntheticHistory([syn(2026, 0, 31), real])).toEqual([real]);
		expect(removeSyntheticHistory(undefined)).toEqual([]);
	});
});

describe("synthetic entries alongside real ones", () => {
	it("a real save the same day replaces a synthetic entry", () => {
		const real = fixtureEntry({ at: at(2026, 0, 31, 15) });
		const out = appendHistoryEntry([syn(2026, 0, 31)], real);
		expect(out).toEqual([real]);
	});

	it("a real save on another day of the month keeps both", () => {
		const real = fixtureEntry({ at: at(2026, 0, 10) });
		expect(appendHistoryEntry([syn(2026, 0, 31)], real)).toHaveLength(2);
	});

	it("compaction keeps the real entry over a synthetic one in the same month, even if the synthetic is later", () => {
		const real = fixtureEntry({ at: at(2024, 0, 10) });
		const out = compactHistory([real, syn(2024, 0, 31)], at(2026, 0, 1));
		expect(out).toEqual([real]);
	});

	it("compaction keeps a lone synthetic entry marked synthetic", () => {
		const out = compactHistory([syn(2024, 0, 15), syn(2024, 0, 31)], at(2026, 0, 1));
		expect(out).toEqual([syn(2024, 0, 31)]);
	});
});

describe("cappedDdmGrowth", () => {
	// fixtureState: rfr 4, beta 1.2, mrp 5 -> cost of equity 10%, so the cap is 8 (10 - 2).
	const growth = (ddmGrowth: string, overrides: Partial<FormState> = {}) => cappedDdmGrowth(fixtureState({ ddmGrowth, ...overrides }));

	it("holds growth to the margin below the cost of equity when it is higher", () => {
		expect(DDM_GROWTH_MARGIN_PP).toBe(2);
		expect(growth("9")).toBe("8");
		expect(growth("12")).toBe("8"); // already above the cost of equity: still bounded, never blows up
	});

	it("leaves growth at or below the cap alone", () => {
		expect(growth("8")).toBe("8");
		expect(growth("5")).toBe("5");
		expect(growth("7.5")).toBe("7.5");
	});

	it("follows the month's risk-free rate", () => {
		expect(growth("8", { rfr: "3" })).toBe("7"); // cost of equity 9
		expect(growth("8", { rfr: "6" })).toBe("8"); // cost of equity 12, cap 10
	});

	it("returns blank or unreadable inputs as they are", () => {
		expect(growth("")).toBe("");
		expect(growth("abc")).toBe("abc");
		expect(growth("9", { rfr: "" })).toBe("9");
	});
});

describe("buildSyntheticHistory: capped DDM growth", () => {
	const seen: string[] = [];
	const spy = (state: FormState) => {
		seen.push(state.ddmGrowth);
		return fixtureResults();
	};
	const scenarios = (growth: string) =>
		fixtureScenarios({
			bear: { state: fixtureState({ ddmGrowth: growth }), results: fixtureResults() },
			base: { state: fixtureState({ ddmGrowth: growth }), results: fixtureResults() },
			bull: { state: fixtureState({ ddmGrowth: growth }), results: fixtureResults() },
		});

	it("caps each month's growth against that month's own cost of equity, without touching the saved scenarios", () => {
		seen.length = 0;
		const saved = scenarios("9");
		buildSyntheticHistory(
			[
				{ at: at(2026, 0, 31, 0), price: 20, rfr: 4 }, // cost of equity 10 -> cap 8
				{ at: at(2026, 1, 28, 0), price: 20, rfr: 3 }, // cost of equity 9 -> cap 7
				{ at: at(2026, 2, 31, 0), price: 20, rfr: 6 }, // cost of equity 12 -> cap 10, 9 stays
			],
			saved,
			spy
		);
		expect(seen).toEqual(["8", "8", "8", "7", "7", "7", "9", "9", "9"]);
		expect(saved.base.state.ddmGrowth).toBe("9");
	});

	it("keeps the capped DDM bounded where the uncapped one would be blank or enormous", () => {
		// Stand-in for the real DDM: dps * (1 + g) / (ke - g), percent inputs, blank when g >= ke.
		const ddm = (state: FormState) => {
			const ke = Number(state.rfr) + Number(state.beta) * Number(state.mrp);
			const g = Number(state.ddmGrowth);
			return fixtureResults({ ddmIv: g >= ke ? NaN : (4 * (1 + g / 100)) / ((ke - g) / 100) });
		};
		const [out] = buildSyntheticHistory([{ at: at(2026, 0, 31, 0), price: 20, rfr: 4, dps: 4 }], scenarios("9.5"), ddm);
		// growth 9.5 against a cost of equity of 10 would give about 800; capped to 8 it is about 216
		expect(out.ddmBaseIv).toBeCloseTo((4 * 1.08) / 0.02);
	});

	it("leaves a blank growth blank", () => {
		seen.length = 0;
		buildSyntheticHistory([{ at: at(2026, 0, 31, 0), price: 20, rfr: 4 }], scenarios(""), spy);
		expect(seen).toEqual(["", "", ""]);
	});
});

describe("usesDdm", () => {
	const withGrowth = (bear: string, base: string, bull: string) =>
		fixtureScenarios({
			bear: { state: fixtureState({ ddmGrowth: bear }), results: fixtureResults() },
			base: { state: fixtureState({ ddmGrowth: base }), results: fixtureResults() },
			bull: { state: fixtureState({ ddmGrowth: bull }), results: fixtureResults() },
		});

	it("is false when no scenario has a dividend growth", () => {
		expect(usesDdm(withGrowth("", "", ""))).toBe(false);
		expect(usesDdm(withGrowth(" ", "", ""))).toBe(false);
	});

	it("is true when any scenario has one", () => {
		expect(usesDdm(withGrowth("", "8", ""))).toBe(true);
		expect(usesDdm(withGrowth("6", "", ""))).toBe(true);
	});
});

describe("buildSyntheticHistory: Graham's historical EPS and yield", () => {
	// Stand-in for calcGraham: IV = eps * 10 / yield, so each input visibly moves the result.
	const graham = (state: FormState) => fixtureResults({ grahamIv: (Number(state.eps) * 10) / Number(state.aaaYield) });
	const when = at(2026, 0, 31, 0);

	it("uses each month's own EPS and yield in all three scenarios", () => {
		const out = buildSyntheticHistory(
			[
				{ at: when, price: 20, eps: 4, aaaYield: 5 },
				{ at: at(2026, 1, 28, 0), price: 20, eps: 6, aaaYield: 3 },
			],
			fixtureScenarios(),
			graham
		);
		expect(out.map((e) => [e.grahamBearIv, e.grahamBaseIv, e.grahamBullIv])).toEqual([
			[8, 8, 8],
			[20, 20, 20],
		]);
	});

	it("keeps today's input when a value is undefined, and replaces only the one given", () => {
		// fixtureState has eps "5" and aaaYield "4.4"
		const [onlyEps, onlyYield] = buildSyntheticHistory(
			[
				{ at: when, price: 20, eps: 4 },
				{ at: when, price: 20, aaaYield: 5 },
			],
			fixtureScenarios(),
			graham
		);
		expect(onlyEps.grahamBaseIv).toBeCloseTo((4 * 10) / 4.4);
		expect(onlyYield.grahamBaseIv).toBeCloseTo((5 * 10) / 5);
	});

	it("leaves Graham blank, not guessed, when EPS or yield is unknown that month", () => {
		const out = buildSyntheticHistory(
			[
				{ at: when, price: 20, eps: null, aaaYield: 5 },
				{ at: at(2026, 1, 28, 0), price: 20, eps: 4, aaaYield: null },
			],
			fixtureScenarios(),
			graham
		);
		for (const e of out) {
			expect([e.grahamBearIv, e.grahamBaseIv, e.grahamBullIv].every(Number.isNaN)).toBe(true);
			expect(e.dcfBaseIv).toBe(60); // other methods unaffected
		}
	});

	it("uses each month's own Ten Cap value, keeps today's when undefined, and blanks it when null", () => {
		const out = buildSyntheticHistory(
			[
				{ at: when, price: 20, tenCapIv: 33 },
				{ at: at(2026, 1, 28, 0), price: 20 },
				{ at: at(2026, 2, 31, 0), price: 20, tenCapIv: null },
			],
			fixtureScenarios(),
			graham
		);
		expect(out[0].tenCapIv).toBe(33);
		expect(out[1].tenCapIv).toBe(45); // fixtureResults default, i.e. today's
		expect(Number.isNaN(out[2].tenCapIv)).toBe(true);
		expect(out[2].grahamBaseIv).not.toBeNaN(); // blanking Ten Cap leaves Graham alone
	});

	describe("DCF inputs", () => {
		// Stand-in for the DCF: (fcf - netDebt) / shares, with the risk-free rate added on so it's visible.
		const dcf = (state: FormState) =>
			fixtureResults({
				dcfIv: (Number(state.fcf) - Number(state.netDebt)) / Number(state.shares) + Number(state.rfr),
				dcfMos: 0.2,
				impliedGrowth: 0.07,
			});

		it("uses each month's free cash flow, net debt, shares and risk-free rate in every scenario", () => {
			const out = buildSyntheticHistory([{ at: when, price: 20, fcf: 900, netDebt: 100, shares: 50, rfr: 3 }], fixtureScenarios(), dcf);
			expect([out[0].dcfBearIv, out[0].dcfBaseIv, out[0].dcfBullIv]).toEqual([19, 19, 19]); // 800 / 50 + 3
		});

		it("keeps today's value for anything undefined", () => {
			// fixtureState: fcf 500, netDebt 500, shares 100, rfr 4
			const out = buildSyntheticHistory([{ at: when, price: 20, fcf: 900 }], fixtureScenarios(), dcf);
			expect(out[0].dcfBaseIv).toBe((900 - 500) / 100 + 4);
		});

		it("leaves the DCF and the reverse DCF blank when free cash flow, net debt or shares is unknown", () => {
			const out = buildSyntheticHistory(
				[
					{ at: when, price: 20, fcf: null },
					{ at: at(2026, 1, 28, 0), price: 20, netDebt: null },
					{ at: at(2026, 2, 31, 0), price: 20, shares: null },
				],
				fixtureScenarios(),
				dcf
			);
			for (const e of out) {
				expect([e.dcfBearIv, e.dcfBaseIv, e.dcfBullIv, e.impliedGrowth].every(Number.isNaN)).toBe(true);
				expect(e.grahamBaseIv).not.toBeNaN(); // other methods unaffected
				expect(e.tenCapIv).toBe(45);
			}
		});

		it("leaves the DCF, the reverse DCF and the DDM blank when the risk-free rate is unknown", () => {
			const stub = () => fixtureResults({ ddmIv: 50, ddmMos: 0.1 });
			const [e] = buildSyntheticHistory([{ at: when, price: 20, rfr: null }], fixtureScenarios(), stub);
			expect([e.dcfBaseIv, e.impliedGrowth, e.ddmBearIv, e.ddmBaseIv, e.ddmBullIv].every(Number.isNaN)).toBe(true);
			expect(e.grahamBaseIv).toBe(55);
			expect(e.tenCapIv).toBe(45);
		});

		it("uses each month's dividend for the DDM, and blanks only the DDM when it is unknown", () => {
			const ddm = (state: FormState) => fixtureResults({ ddmIv: Number(state.dps) * 20 });
			const out = buildSyntheticHistory(
				[
					{ at: when, price: 20, dps: 1.5 },
					{ at: at(2026, 1, 28, 0), price: 20, dps: null },
					{ at: at(2026, 2, 31, 0), price: 20 }, // undefined keeps today's (fixtureState has dps "")
				],
				fixtureScenarios(),
				ddm
			);
			expect([out[0].ddmBearIv, out[0].ddmBaseIv, out[0].ddmBullIv]).toEqual([30, 30, 30]);
			expect([out[1].ddmBearIv, out[1].ddmBaseIv, out[1].ddmBullIv].every(Number.isNaN)).toBe(true);
			expect(out[1].dcfBaseIv).toBe(60); // DCF untouched by a missing dividend
			expect(out[2].ddmBaseIv).toBe(0);
		});

		it("does not change growth assumptions, which stay as saved in every scenario", () => {
			let seen: string[] = [];
			buildSyntheticHistory([{ at: when, price: 20, fcf: 1, netDebt: 1, shares: 1, rfr: 1 }], fixtureScenarios(), (state) => {
				seen.push(`${state.growth1to5}/${state.growth6to10}/${state.terminalGrowth}/${state.mrp}/${state.beta}`);
				return fixtureResults();
			});
			expect(seen).toEqual(["8/4/2/5/1.2", "8/4/2/5/1.2", "8/4/2/5/1.2"]);
		});
	});

	it("does not mutate the saved scenarios", () => {
		const scenarios = fixtureScenarios();
		buildSyntheticHistory([{ at: when, price: 20, eps: 9, aaaYield: 9 }], scenarios, graham);
		expect(scenarios.base.state.eps).toBe("5");
		expect(scenarios.base.state.aaaYield).toBe("4.4");
	});
});
