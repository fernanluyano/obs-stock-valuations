import type { FormState, Results, SavedValuation } from "../../valuationStore";

export function fixtureState(overrides: Partial<FormState> = {}): FormState {
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

export function fixtureResults(overrides: Partial<Results> = {}): Results {
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

export function fixtureValuation(overrides: Partial<SavedValuation> = {}, ticker = "ACME"): SavedValuation {
	const scenario = (growth: string) => ({
		state: fixtureState({ ticker, growth1to5: growth }),
		results: fixtureResults(),
	});
	return {
		scenarios: { bull: scenario("12"), base: scenario("8"), bear: scenario("3") },
		moneyScale: "millions",
		sharesScale: "millions",
		updatedAt: 1700000000000,
		...overrides,
	};
}

// Oldest first, the in-memory order (appendHistoryEntry); the note itself lists newest first.
export const fixtureHistory = [
	{
		at: 1690000000000,
		price: 48,
		dcfBearIv: null,
		dcfBaseIv: 58,
		dcfBullIv: 79,
		grahamBearIv: 44,
		grahamBaseIv: 54,
		grahamBullIv: 64,
		tenCapIv: 44,
		impliedGrowth: null,
		ddmBearIv: 30,
		ddmBaseIv: 35,
		ddmBullIv: 40,
	},
	{
		at: 1700000000000,
		price: 50.25,
		dcfBearIv: 40.1,
		dcfBaseIv: 60,
		dcfBullIv: 80.333333333,
		grahamBearIv: 45,
		grahamBaseIv: 55,
		grahamBullIv: 65,
		tenCapIv: 45,
		impliedGrowth: 0.07,
		ddmBearIv: null,
		ddmBaseIv: null,
		ddmBullIv: null,
	},
];
