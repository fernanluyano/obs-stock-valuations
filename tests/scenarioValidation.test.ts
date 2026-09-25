import { describe, expect, it } from "vitest";
import { validateScenarios } from "../scenarioValidation";
import type { FormState, Results, Scenario, ScenarioKey } from "../valuationStore";

// Minimal fixture — validateScenarios only reads the four growth fields, so
// everything else can stay blank. Mirrors the fixture style in
// valuationCalc.test.ts.
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

const blankResults: Results = {
	wacc: 0,
	dcfIv: 0,
	dcfMos: 0,
	grahamIv: 0,
	grahamMos: 0,
	tenCapIv: 0,
	tenCapYield: 0,
	tenCapMos: 0,
};

function scenario(stateOverrides: Partial<FormState> = {}): Scenario {
	return { state: fixtureState(stateOverrides), results: blankResults };
}

// Bear/base/bull growth fixtures consistent with bear <= base <= bull for
// all four scenario-specific fields, then overridden per test.
function fixtureScenarios(overrides: Partial<Record<ScenarioKey, Partial<FormState>>> = {}): Record<ScenarioKey, Scenario> {
	return {
		bear: scenario({ growth1to5: "2", growth6to10: "1", terminalGrowth: "1", grahamGrowth: "2", ...overrides.bear }),
		base: scenario({ growth1to5: "8", growth6to10: "4", terminalGrowth: "2", grahamGrowth: "8", ...overrides.base }),
		bull: scenario({ growth1to5: "15", growth6to10: "8", terminalGrowth: "3", grahamGrowth: "15", ...overrides.bull }),
	};
}

describe("validateScenarios", () => {
	it("passes when every scenario-specific field is ordered bear <= base <= bull", () => {
		expect(validateScenarios(fixtureScenarios())).toEqual([]);
	});

	it("passes when a field is tied across scenarios (bear == base == bull)", () => {
		const scenarios = fixtureScenarios({
			bear: { growth1to5: "5" },
			base: { growth1to5: "5" },
			bull: { growth1to5: "5" },
		});
		expect(validateScenarios(scenarios)).toEqual([]);
	});

	it("flags FCF growth yrs 1-5 when bear exceeds base", () => {
		const scenarios = fixtureScenarios({ bear: { growth1to5: "9" } });
		const errors = validateScenarios(scenarios);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("FCF growth, yrs 1-5");
	});

	it("flags FCF growth yrs 6-10 when bull is below base", () => {
		const scenarios = fixtureScenarios({ bull: { growth6to10: "3" } });
		const errors = validateScenarios(scenarios);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("FCF growth, yrs 6-10");
	});

	it("flags terminal growth rate when out of order", () => {
		const scenarios = fixtureScenarios({ bear: { terminalGrowth: "4" } });
		const errors = validateScenarios(scenarios);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Terminal growth rate");
	});

	it("flags EPS growth when out of order", () => {
		const scenarios = fixtureScenarios({ bull: { grahamGrowth: "1" } });
		const errors = validateScenarios(scenarios);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Expected EPS growth, 7-10yr");
	});

	it("reports one violation per offending field, not just the first", () => {
		const scenarios = fixtureScenarios({
			bear: { growth1to5: "20", terminalGrowth: "9" },
		});
		const errors = validateScenarios(scenarios);
		expect(errors).toHaveLength(2);
	});

	it("skips fields that are blank or unparseable in any of the three scenarios", () => {
		const scenarios = fixtureScenarios({
			bear: { growth1to5: "" },
			bull: { grahamGrowth: "n/a" },
		});
		expect(validateScenarios(scenarios)).toEqual([]);
	});

	it("allows negative growth as long as ordering still holds", () => {
		const scenarios = fixtureScenarios({
			bear: { growth1to5: "-5" },
			base: { growth1to5: "0" },
			bull: { growth1to5: "5" },
		});
		expect(validateScenarios(scenarios)).toEqual([]);
	});
});
