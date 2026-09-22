import { describe, expect, it } from "vitest";
import { computeResultsForState, deriveMarketCap, numFromState } from "../valuationCalc";
import type { FormState } from "../valuationStore";

// A fully-filled, internally consistent fixture — every field a saved
// valuation would actually carry, in "millions" money scale / "ones" shares
// scale, matching what the form would produce for a mid-cap company.
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
		mktCap: "9000",

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

describe("numFromState", () => {
	it("scales money and share fields by the given scale, and percent fields by /100", () => {
		const state = fixtureState({ totDebt: "2", shares: "3", rfr: "6" });
		expect(numFromState(state, "totDebt", "millions", "ones", 21)).toBe(2e6);
		expect(numFromState(state, "shares", "millions", "thousands", 21)).toBe(3e3);
		expect(numFromState(state, "rfr", "millions", "ones", 21)).toBeCloseTo(0.06, 10);
	});

	it("leaves price and other unscaled fields as-is", () => {
		const state = fixtureState({ price: "123.45" });
		expect(numFromState(state, "price", "billions", "billions", 21)).toBeCloseTo(123.45, 10);
	});

	it("falls back to the given default tax rate when taxRate is blank", () => {
		const state = fixtureState({ taxRate: "" });
		expect(numFromState(state, "taxRate", "ones", "ones", 21)).toBeCloseTo(0.21, 10);
	});

	it("treats an unparseable non-taxRate field as 0", () => {
		const state = fixtureState({ fcf: "" });
		expect(numFromState(state, "fcf", "millions", "ones", 21)).toBe(0);
	});
});

describe("computeResultsForState", () => {
	it("produces finite results for a fully-filled fixture", () => {
		const r = computeResultsForState(fixtureState(), "millions", "ones", 21);
		expect(r.wacc).toBeGreaterThan(0);
		expect(r.dcfIv).toBeGreaterThan(0);
		expect(r.grahamIv).toBeGreaterThan(0);
		expect(r.tenCapIv).toBeGreaterThan(0);
	});

	// Market cap is derived (price × shares), never typed in, so it moves with
	// price — and since WACC uses market cap, DCF IV moves too. Graham and Ten
	// Cap don't depend on WACC/market cap at all, so their IV stays fixed.
	// Shares is bumped so market cap (price × shares) lands in the same order
	// of magnitude as totDebt (1000, in millions) — otherwise debt swamps the
	// WACC blend regardless of price and the change in WACC is negligible.
	it("changing only price leaves Graham/Ten Cap IV fixed but moves WACC and DCF IV (via market cap)", () => {
		const before = computeResultsForState(fixtureState({ price: "50", shares: "20000000" }), "millions", "ones", 21);
		const after = computeResultsForState(fixtureState({ price: "80", shares: "20000000" }), "millions", "ones", 21);

		expect(after.grahamIv).toBeCloseTo(before.grahamIv, 10);
		expect(after.tenCapIv).toBeCloseTo(before.tenCapIv, 10);

		expect(after.wacc).not.toBeCloseTo(before.wacc, 5);
		expect(after.dcfIv).not.toBeCloseTo(before.dcfIv, 5);

		expect(after.dcfMos).not.toBeCloseTo(before.dcfMos, 5);
		expect(after.grahamMos).not.toBeCloseTo(before.grahamMos, 5);
		expect(after.tenCapMos).not.toBeCloseTo(before.tenCapMos, 5);
		expect(after.tenCapYield).not.toBeCloseTo(before.tenCapYield, 5);
	});

	it("a higher price lowers margin of safety and Ten Cap yield", () => {
		const cheap = computeResultsForState(fixtureState({ price: "10" }), "millions", "ones", 21);
		const expensive = computeResultsForState(fixtureState({ price: "200" }), "millions", "ones", 21);

		expect(expensive.dcfMos).toBeLessThan(cheap.dcfMos);
		expect(expensive.grahamMos).toBeLessThan(cheap.grahamMos);
		expect(expensive.tenCapMos).toBeLessThan(cheap.tenCapMos);
		expect(expensive.tenCapYield).toBeLessThan(cheap.tenCapYield);
	});

	it("falls back to the default tax rate when taxRate is blank, same as a fetched-but-empty field", () => {
		const withRate = computeResultsForState(fixtureState({ taxRate: "25" }), "millions", "ones", 21);
		const blankRate = computeResultsForState(fixtureState({ taxRate: "" }), "millions", "ones", 25);
		expect(blankRate.wacc).toBeCloseTo(withRate.wacc, 10);
	});

	it("overwrites state.mktCap with price × shares regardless of whatever value was stored there", () => {
		// price 50, shares 100,000 (ones scale) -> $5,000,000 raw -> "5" in millions.
		const state = fixtureState({ price: "50", shares: "100000", mktCap: "999999" });
		computeResultsForState(state, "millions", "ones", 21);
		expect(state.mktCap).toBe("5");
	});
});

describe("deriveMarketCap", () => {
	it("computes price × shares, converted to the given money scale", () => {
		const state = fixtureState({ price: "20", shares: "50" }); // shares in "ones"
		const { raw, scaled } = deriveMarketCap(state, "thousands", "ones");
		expect(raw).toBe(1000); // 20 * 50
		expect(scaled).toBe("1"); // 1000 / 1e3
	});

	it("ignores whatever mktCap was already stored", () => {
		const a = deriveMarketCap(fixtureState({ price: "20", shares: "50", mktCap: "1" }), "ones", "ones");
		const b = deriveMarketCap(fixtureState({ price: "20", shares: "50", mktCap: "999999" }), "ones", "ones");
		expect(a).toEqual(b);
	});
});
