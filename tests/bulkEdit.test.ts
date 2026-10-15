import { describe, expect, it } from "vitest";
import { applyBulkChanges, BULK_EDITABLE_FIELDS } from "../bulkEdit";
import { computeResultsForState } from "../valuationCalc";
import type { FormState, SavedValuation, ScenarioKey } from "../valuationStore";

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
		mktCap: "",
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
		dps: "1",
		ddmGrowth: "3",
		...overrides,
	};
}

function fixtureRecord(): SavedValuation {
	const scenarios = {} as SavedValuation["scenarios"];
	for (const key of ["bear", "base", "bull"] as ScenarioKey[]) {
		const state = fixtureState();
		scenarios[key] = { state, results: computeResultsForState(state, "millions", "millions", 21) };
	}
	return { scenarios, moneyScale: "millions", sharesScale: "millions", updatedAt: 1 };
}

const DAY = 24 * 60 * 60 * 1000;

describe("applyBulkChanges", () => {
	it("only allows market-wide fields", () => {
		expect([...BULK_EDITABLE_FIELDS].sort()).toEqual(["mrp"]);
	});

	it("sets the changed fields on every scenario and leaves others untouched", () => {
		const record = fixtureRecord();
		applyBulkChanges(record, { mrp: "6" }, 21, 5 * DAY);
		for (const s of Object.values(record.scenarios)) {
			expect(s.state.mrp).toBe("6");
			expect(s.state.rfr).toBe("4");
			expect(s.state.beta).toBe("1.2");
		}
	});

	it("trims values", () => {
		const record = fixtureRecord();
		applyBulkChanges(record, { mrp: " 6 " }, 21, 5 * DAY);
		expect(record.scenarios.base.state.mrp).toBe("6");
	});

	it("ignores blank values", () => {
		const record = fixtureRecord();
		applyBulkChanges(record, { mrp: "  " }, 21, 5 * DAY);
		expect(record.scenarios.base.state.mrp).toBe("5");
	});

	it("recomputes results with the new inputs", () => {
		const record = fixtureRecord();
		const before = record.scenarios.base.results.costOfEquity;
		applyBulkChanges(record, { mrp: "6" }, 21, 5 * DAY);
		// Re = rfr + beta × mrp = 4% + 1.2 × 6% = 11.2%
		expect(record.scenarios.base.results.costOfEquity).toBeCloseTo(0.112, 6);
		expect(record.scenarios.base.results.costOfEquity).not.toBe(before);
	});

	it("appends a history entry, bumps updatedAt, and keeps lastPriceRefreshAt", () => {
		const record = fixtureRecord();
		record.lastPriceRefreshAt = 2;
		applyBulkChanges(record, { mrp: "6" }, 21, 5 * DAY);
		expect(record.history).toHaveLength(1);
		expect(record.history![0].at).toBe(5 * DAY);
		expect(record.updatedAt).toBe(5 * DAY);
		expect(record.lastPriceRefreshAt).toBe(2);
	});
});
