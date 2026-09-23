import { beforeAll, describe, expect, it } from "vitest";
import { buildNoteContent } from "../noteContent";
import type { FormState, Results, SavedValuation, Scenario, ScenarioKey } from "../valuationStore";
import type { ValuationTable } from "../valuationStore";

// buildNoteContent formats the last-updated column via window.moment, which
// Obsidian provides at runtime (a global moment.js) — stub the one method it
// actually calls so this stays a pure-logic test, not an Obsidian integration
// test.
beforeAll(() => {
	(globalThis as { window?: unknown }).window = {
		moment: (ms: number) => ({
			format: () => new Date(ms).toISOString().slice(0, 10),
		}),
	};
});

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
		dcfMos: 20,
		grahamIv: 55,
		grahamMos: 10,
		tenCapIv: 45,
		tenCapYield: 8,
		tenCapMos: -10,
		...overrides,
	};
}

function fixtureScenario(overrides: Partial<Scenario> = {}): Scenario {
	return {
		state: fixtureState(),
		results: fixtureResults(),
		...overrides,
	};
}

function fixtureRecord(scenarios: Partial<Record<ScenarioKey, Scenario>> = {}): SavedValuation {
	return {
		scenarios: {
			bear: fixtureScenario(),
			base: fixtureScenario(),
			bull: fixtureScenario(),
			...scenarios,
		},
		moneyScale: "millions",
		sharesScale: "ones",
		updatedAt: 1700000000000,
	};
}

describe("buildNoteContent", () => {
	it("reports Bear/Base/Bull separately per method, without mixing them up", () => {
		const table: ValuationTable = {
			ACME: fixtureRecord({
				bear: fixtureScenario({ results: fixtureResults({ dcfIv: 40, dcfMos: -5, grahamIv: 45, grahamMos: -2 }) }),
				base: fixtureScenario({ results: fixtureResults({ dcfIv: 60, dcfMos: 20, grahamIv: 55, grahamMos: 10 }) }),
				bull: fixtureScenario({ results: fixtureResults({ dcfIv: 80, dcfMos: 45, grahamIv: 65, grahamMos: 22 }) }),
			}),
		};

		const content = buildNoteContent(table, false);
		const row = content.split("\n").find((line) => line.startsWith("| ACME"));
		expect(row).toBeDefined();

		const cells = row!.split("|").map((c) => c.trim());
		// | ACME | DCF Bear | DCF Base | DCF Bull | Ten Cap | Ten Cap Yield | Graham Bear | Graham Base | Graham Bull | Price | Updated |
		expect(cells[2]).toBe("$40.00/-5.00%");
		expect(cells[3]).toBe("$60.00/20.00%");
		expect(cells[4]).toBe("$80.00/45.00%");
		expect(cells[7]).toBe("$45.00/-2.00%");
		expect(cells[8]).toBe("$55.00/10.00%");
		expect(cells[9]).toBe("$65.00/22.00%");
	});

	it("reads price and Ten Cap figures off the Base scenario, not Bear/Bull", () => {
		const table: ValuationTable = {
			ACME: fixtureRecord({
				bear: fixtureScenario({ state: fixtureState({ price: "999" }) }),
				base: fixtureScenario({ state: fixtureState({ price: "50" }), results: fixtureResults({ tenCapIv: 45, tenCapMos: -10, tenCapYield: 8 }) }),
			}),
		};

		const content = buildNoteContent(table, false);
		const row = content.split("\n").find((line) => line.startsWith("| ACME"))!;
		const cells = row.split("|").map((c) => c.trim());

		expect(cells[5]).toBe("$45.00/-10.00%"); // Ten Cap
		expect(cells[6]).toBe("8.00%"); // Ten Cap Yield
		expect(cells[10]).toBe("$50.00"); // Price
	});

	it("adds a Research column only when includeResearchColumn is true", () => {
		const table: ValuationTable = { ACME: fixtureRecord() };

		const withResearch = buildNoteContent(table, true);
		expect(withResearch).toContain("| Research |");
		expect(withResearch).toContain("—"); // no researchNotePath set

		const withoutResearch = buildNoteContent(table, false);
		expect(withoutResearch).not.toContain("Research");
	});

	it("links to the research note when researchNotePath is set", () => {
		const table: ValuationTable = { ACME: { ...fixtureRecord(), researchNotePath: "Research/ACME.md" } };
		const content = buildNoteContent(table, true);
		expect(content).toContain("[[Research/ACME\\|Research]]");
	});

	it("lists tickers alphabetically regardless of insertion order", () => {
		const table: ValuationTable = { ZTS: fixtureRecord(), ACME: fixtureRecord() };
		const content = buildNoteContent(table, false);
		const acmeIndex = content.indexOf("| ACME");
		const ztsIndex = content.indexOf("| ZTS");
		expect(acmeIndex).toBeGreaterThan(-1);
		expect(acmeIndex).toBeLessThan(ztsIndex);
	});

	it("renders a placeholder message when there are no saved valuations", () => {
		const content = buildNoteContent({}, false);
		expect(content).toContain("_No valuations saved yet._");
	});
});
