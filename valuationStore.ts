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
	// every other money input, purely so it round-trips in the saved JSON like
	// everything else.
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

	dps: string; // dividends per share, actual $/share — never scaled, like price/eps
	ddmGrowth: string;
}

export interface Results {
	wacc: number;
	costOfEquity: number; // CAPM — the DDM's discount rate
	dcfIv: number;
	dcfMos: number;
	impliedGrowth: number;
	grahamIv: number;
	grahamMos: number;
	tenCapIv: number;
	tenCapYield: number;
	tenCapMos: number;
	ddmIv: number;
	ddmMos: number;
	paybackYears: number; // Payback Time — NaN (FCF ≤ 0) / Infinity (> PAYBACK_MAX_YEARS) are meaningful
}

export type ScenarioKey = "bull" | "base" | "bear";

export interface Scenario {
	state: FormState;
	results: Results;
}

// One point in a ticker's saved-over-time timeline — a bare snapshot of the
// numbers that matter for "fair value vs. price over months/years", not the
// full FormState (see historyStore.ts). Bear/Base/Bull for DCF, Graham, and
// DDM (the methods with a scenario-specific input), same split as the home
// table and the ticker's history note; Ten Cap and Reverse DCF stay single values,
// matching how those are already shown everywhere else in the plugin. `at`
// doubles as the dedupe key (one entry per calendar day) and the x-axis value
// wherever this gets charted.
//
// Unlike Results, these are snapshots of the past — never recomputed on
// load — so the type says what actually comes back from data.json: a value
// that was NaN when recorded (no answer, e.g. a non-payer's DDM) is written
// by JSON as null and read back as null. Readers must handle null (see
// historyIv); writers can still pass NaN.
export type HistoryIv = number | null;

export interface HistoryEntry {
	at: number; // epoch ms
	price: number; // always a real number (parseFloat(...) || 0 when recorded)
	dcfBearIv: HistoryIv;
	dcfBaseIv: HistoryIv;
	dcfBullIv: HistoryIv;
	grahamBearIv: HistoryIv;
	grahamBaseIv: HistoryIv;
	grahamBullIv: HistoryIv;
	tenCapIv: HistoryIv;
	impliedGrowth: HistoryIv;
	// Optional too: entries recorded before the DDM existed don't have them.
	ddmBearIv?: HistoryIv;
	ddmBaseIv?: HistoryIv;
	ddmBullIv?: HistoryIv;
}

// A stored history value as a plain number for math/display: missing or
// null (see HistoryIv) becomes NaN, which every formatter and
// marginOfSafety already treat as "no value".
export function historyIv(v: HistoryIv | undefined): number {
	return v ?? NaN;
}

// A saved row in the plugin's own valuation table — created and edited only
// through the calculator form, never hand-edited.
export interface SavedValuation {
	scenarios: Record<ScenarioKey, Scenario>;
	moneyScale: ScaleUnit;
	sharesScale: ScaleUnit;
	updatedAt: number; // epoch ms

	// epoch ms of the last time this ticker's price was actually confirmed
	// current — set only by the table's "Refresh prices" action, never by an
	// ordinary form save (which may not have touched the price at all).
	// Optional so older/never-refreshed records skip a schema migration;
	// missing means "never refreshed", not "assume it's fine" — readers treat
	// it as infinitely stale rather than falling back to updatedAt.
	lastPriceRefreshAt?: number;

	// Vault path to a linked research note, set only through the table's
	// Research column (never the form) — independent of ticker naming, and
	// nothing about the note's contents or format is read or assumed.
	// Preserved across form saves; removed only by explicitly unlinking it.
	researchNotePath?: string;

	// Saved-over-time timeline, appended to on every form Save and every price
	// refresh — see buildHistoryEntry() in historyStore.ts. Omitted rather than
	// an empty array once nothing's left, same convention as the optional
	// fields above. Mirrored, whole, to this ticker's TICKER-history.md vault
	// note (noteContent.ts: buildHistoryNoteContent) — the only thing that note
	// reads.
	history?: HistoryEntry[];
}

// Keyed by uppercase ticker.
export type ValuationTable = Record<string, SavedValuation>;
