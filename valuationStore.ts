import type { ScaleUnit } from "./units";

export interface FormState {
	ticker: string;
	price: string;
	shares: string;

	rfr: string;
	mrp: string;
	beta: string;
	intExp: string;
	totDebt: string;
	taxRate: string;
	// Always derived (price × shares), never typed in — computeResultsForState
	// (valuationCalc.ts) is the only writer. Kept as a stored field, same as
	// every other money input, purely so it round-trips in the saved JSON and
	// the summary note like everything else.
	mktCap: string;

	netDebt: string;
	growth1to5: string;
	growth6to10: string;
	terminalGrowth: string;
	fcf: string;

	eps: string;
	grahamGrowth: string;
	aaaYield: string;

	ocf: string;
	capex: string;
	mainPct: string;
}

export interface Results {
	wacc: number;
	dcfIv: number;
	dcfMos: number;
	grahamIv: number;
	grahamMos: number;
	tenCapIv: number;
	tenCapYield: number;
	tenCapMos: number;
}

// A saved row in the plugin's own valuation table — created and edited only
// through the calculator form, never hand-edited.
export interface SavedValuation {
	state: FormState;
	moneyScale: ScaleUnit;
	sharesScale: ScaleUnit;
	results: Results;
	updatedAt: number; // epoch ms

	// Vault path to a linked research note, set only through the table's
	// Research column (never the form) — independent of ticker naming, and
	// nothing about the note's contents or format is read or assumed.
	// Preserved across form saves; removed only by explicitly unlinking it.
	researchNotePath?: string;
}

// Keyed by uppercase ticker.
export type ValuationTable = Record<string, SavedValuation>;
