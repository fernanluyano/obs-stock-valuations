import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, LegacySavedValuation, migrateValuationsToV2 } from "../migrations";
import type { FormState, Results } from "../valuationStore";

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
		grahamIv: 55,
		grahamMos: 0.1,
		tenCapIv: 45,
		tenCapYield: 0.08,
		tenCapMos: -0.1,
		...overrides,
	};
}

function legacyRecord(overrides: Partial<LegacySavedValuation> = {}): LegacySavedValuation {
	return {
		state: fixtureState(),
		results: fixtureResults(),
		moneyScale: "millions",
		sharesScale: "ones",
		updatedAt: 1700000000000,
		...overrides,
	};
}

describe("migrateValuationsToV2", () => {
	it("wraps a legacy record's single state/results into identical bull/base/bear scenarios", () => {
		const legacy = { ACME: legacyRecord() };
		const migrated = migrateValuationsToV2(legacy);

		const record = migrated.ACME;
		expect(record.scenarios.base.state).toEqual(legacy.ACME.state);
		expect(record.scenarios.bull.state).toEqual(legacy.ACME.state);
		expect(record.scenarios.bear.state).toEqual(legacy.ACME.state);
		expect(record.scenarios.base.results).toEqual(legacy.ACME.results);
		expect(record.scenarios.bull.results).toEqual(legacy.ACME.results);
		expect(record.scenarios.bear.results).toEqual(legacy.ACME.results);
	});

	it("carries over the top-level fields unchanged", () => {
		const legacy = {
			ACME: legacyRecord({ moneyScale: "billions", sharesScale: "thousands", updatedAt: 42 }),
		};
		const migrated = migrateValuationsToV2(legacy);

		expect(migrated.ACME.moneyScale).toBe("billions");
		expect(migrated.ACME.sharesScale).toBe("thousands");
		expect(migrated.ACME.updatedAt).toBe(42);
	});

	it("preserves researchNotePath when present, and omits it when absent", () => {
		const withLink = migrateValuationsToV2({
			ACME: legacyRecord({ researchNotePath: "Research/ACME.md" }),
		});
		expect(withLink.ACME.researchNotePath).toBe("Research/ACME.md");

		const withoutLink = migrateValuationsToV2({ ACME: legacyRecord() });
		expect(withoutLink.ACME.researchNotePath).toBeUndefined();
		expect("researchNotePath" in withoutLink.ACME).toBe(false);
	});

	it("clones state and results per scenario so mutating one can't affect another", () => {
		const legacy = { ACME: legacyRecord() };
		const migrated = migrateValuationsToV2(legacy);

		migrated.ACME.scenarios.bull.state.price = "999";
		migrated.ACME.scenarios.bull.results.dcfIv = 999;

		expect(migrated.ACME.scenarios.base.state.price).toBe("50");
		expect(migrated.ACME.scenarios.bear.state.price).toBe("50");
		expect(migrated.ACME.scenarios.base.results.dcfIv).toBe(60);
		expect(migrated.ACME.scenarios.bear.results.dcfIv).toBe(60);

		// The original legacy record is untouched too.
		expect(legacy.ACME.state.price).toBe("50");
		expect(legacy.ACME.results.dcfIv).toBe(60);
	});

	it("migrates every ticker in the table independently", () => {
		const legacy = {
			ACME: legacyRecord({ state: fixtureState({ ticker: "ACME", price: "50" }) }),
			GLOB: legacyRecord({ state: fixtureState({ ticker: "GLOB", price: "80" }) }),
		};
		const migrated = migrateValuationsToV2(legacy);

		expect(Object.keys(migrated).sort()).toEqual(["ACME", "GLOB"]);
		expect(migrated.ACME.scenarios.base.state.price).toBe("50");
		expect(migrated.GLOB.scenarios.base.state.price).toBe("80");
	});

	it("returns an empty table for an empty input", () => {
		expect(migrateValuationsToV2({})).toEqual({});
	});

	it("exposes the current schema version as 2", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(2);
	});
});
