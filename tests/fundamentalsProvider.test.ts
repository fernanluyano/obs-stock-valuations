import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetTickerMapCacheForTests,
	computeTtm,
	deriveFundamentals,
	fetchCompanyFactsJson,
	fetchFundamentals,
	HttpGet,
	HttpResponse,
	isFundamentalsError,
	latestDuration,
	latestFiscalYear,
	latestInstant,
	pickConceptFacts,
	resolveCik,
	SecCompanyFacts,
	SecConcept,
	SecFact,
} from "../fundamentalsProvider";

// ---------------------------------------------------------------------------
// Fixture data. The OCF figures below are Adobe's real reported values
// (fiscal year ending Nov 2025, verified against SEC EDGAR directly) so the
// TTM rollforward test is checked against a real filing, not an invented one.
// ---------------------------------------------------------------------------

function fact(partial: Partial<SecFact> & { end: string; val: number }): SecFact {
	return { fy: 2025, fp: "FY", form: "10-K", filed: "2025-01-01", ...partial };
}

const ADOBE_OCF: SecFact[] = [
	// Noise: earlier fiscal year's quarters, shouldn't affect the latest TTM.
	fact({ start: "2023-12-02", end: "2024-03-01", val: 1174000000, fp: "Q1", form: "10-Q", filed: "2024-03-27" }),
	fact({ start: "2023-12-02", end: "2024-11-29", val: 8056000000, fp: "FY", form: "10-K", filed: "2025-01-13" }),
	// Latest fiscal year.
	fact({ start: "2024-11-30", end: "2025-02-28", val: 2482000000, fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-03-26" }),
	// Prior-year-same-window YTD (needed to roll the FY forward to a TTM).
	fact({ start: "2024-11-30", end: "2025-05-30", val: 4673000000, fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-06-25" }),
	fact({ start: "2024-11-30", end: "2025-08-29", val: 6871000000, fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-09-24" }),
	fact({ start: "2024-11-30", end: "2025-11-28", val: 10031000000, fy: 2025, fp: "FY", form: "10-K", filed: "2026-01-15" }),
	// Current fiscal year's interim data.
	fact({ start: "2025-11-29", end: "2026-02-27", val: 2958000000, fy: 2026, fp: "Q1", form: "10-Q", filed: "2026-03-25" }),
	fact({ start: "2025-11-29", end: "2026-05-29", val: 5123000000, fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-06-15" }),
];
const ADOBE_OCF_TTM = 10031000000 + 5123000000 - 4673000000; // 10,481,000,000

function concept(facts: SecFact[], unit = "USD"): SecConcept {
	return { units: { [unit]: facts } };
}

// ---------------------------------------------------------------------------
// pickConceptFacts
// ---------------------------------------------------------------------------

describe("pickConceptFacts", () => {
	const gaap = {
		Primary: concept([fact({ end: "2025-01-01", val: 1 })]),
		Fallback: concept([fact({ end: "2025-01-01", val: 2 })]),
	};

	it("returns the primary tag's facts when present", () => {
		expect(pickConceptFacts(gaap, ["Primary", "Fallback"], "USD")).toEqual(gaap.Primary.units.USD);
	});

	it("falls back to the next tag when the primary is absent", () => {
		expect(pickConceptFacts(gaap, ["Missing", "Fallback"], "USD")).toEqual(gaap.Fallback.units.USD);
	});

	it("returns null when no tag in the chain is present", () => {
		expect(pickConceptFacts(gaap, ["Missing", "AlsoMissing"], "USD")).toBeNull();
	});

	it("returns null when the concept exists but not in the requested unit", () => {
		expect(pickConceptFacts(gaap, ["Primary"], "shares")).toBeNull();
	});

	it("returns null when concepts is undefined", () => {
		expect(pickConceptFacts(undefined, ["Primary"], "USD")).toBeNull();
	});

	it("prefers whichever tag has the more recent data, not just the first one listed with any data (Boston Scientific's real shape)", () => {
		// BSX stopped reporting LongTermDebtCurrent after 2017 and reports
		// DebtCurrent instead today. Naively taking the first non-empty tag
		// would lock onto the frozen, years-stale LongTermDebtCurrent figure.
		const gaap = {
			LongTermDebtCurrent: concept([
				fact({ end: "2016-09-30", val: 0 }),
				fact({ end: "2016-12-31", val: 250000000 }),
				fact({ end: "2017-03-31", val: 0 }),
			]),
			DebtCurrent: concept([fact({ end: "2025-12-31", val: 299000000 }), fact({ end: "2026-06-30", val: 1709000000 })]),
		};
		const result = pickConceptFacts(gaap, ["LongTermDebtCurrent", "LongTermDebtCurrentMaturities", "DebtCurrent"], "USD");
		expect(result).toEqual(gaap.DebtCurrent.units.USD);
	});
});

// ---------------------------------------------------------------------------
// latestInstant / latestDuration
// ---------------------------------------------------------------------------

describe("latestInstant", () => {
	it("picks the entry with the latest end date", () => {
		const facts = [fact({ end: "2025-01-01", val: 1 }), fact({ end: "2025-06-01", val: 2 }), fact({ end: "2025-03-01", val: 3 })];
		expect(latestInstant(facts)?.val).toBe(2);
	});

	it("ignores duration facts (those with a start date)", () => {
		const facts = [fact({ start: "2025-01-01", end: "2025-12-01", val: 99 }), fact({ end: "2025-06-01", val: 2 })];
		expect(latestInstant(facts)?.val).toBe(2);
	});

	it("prefers the most recently filed entry when two share the same end date", () => {
		const facts = [
			fact({ end: "2025-06-01", val: 1, filed: "2025-06-05" }),
			fact({ end: "2025-06-01", val: 2, filed: "2025-09-01" }), // restated later
		];
		expect(latestInstant(facts)?.val).toBe(2);
	});

	it("returns null for null or empty input", () => {
		expect(latestInstant(null)).toBeNull();
		expect(latestInstant([])).toBeNull();
	});
});

describe("latestDuration", () => {
	it("picks the duration entry with the latest end date, ignoring instants", () => {
		const facts = [
			fact({ end: "2025-06-01", val: 99 }), // instant, ignored
			fact({ start: "2025-01-01", end: "2025-03-01", val: 1 }),
			fact({ start: "2025-04-01", end: "2025-06-01", val: 2 }),
		];
		expect(latestDuration(facts)?.val).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// computeTtm — the core, accuracy-critical algorithm.
// ---------------------------------------------------------------------------

describe("computeTtm", () => {
	it("computes an exact TTM via FY + current YTD - prior YTD, matching Adobe's real filings", () => {
		const result = computeTtm(ADOBE_OCF);
		expect(result.basis).toBe("ttm");
		expect(result.value).toBe(ADOBE_OCF_TTM);
		expect(result.asOf).toBe("2026-05-29");
	});

	it("falls back to the latest fiscal year when there's no more recent interim filing", () => {
		const facts = [
			fact({ start: "2023-01-01", end: "2023-12-31", val: 100, fp: "FY" }),
			fact({ start: "2024-01-01", end: "2024-12-31", val: 120, fp: "FY" }),
		];
		const result = computeTtm(facts);
		expect(result.basis).toBe("fiscal-year");
		expect(result.value).toBe(120);
		expect(result.note).toMatch(/no more recent interim filing/);
	});

	it("falls back to the latest fiscal year when no matching prior-year YTD period exists", () => {
		const facts = [
			fact({ start: "2024-01-01", end: "2024-12-31", val: 100, fp: "FY" }),
			// current-year interim data, but no comparable period from the year before
			fact({ start: "2025-01-01", end: "2025-06-30", val: 60, fp: "Q2" }),
		];
		const result = computeTtm(facts);
		expect(result.basis).toBe("fiscal-year");
		expect(result.value).toBe(100);
		expect(result.note).toMatch(/couldn't find a matching year-ago interim period/);
	});

	it("returns a missing field when the tag has no duration data at all", () => {
		expect(computeTtm(null).value).toBeNull();
		expect(computeTtm([fact({ end: "2025-01-01", val: 1 })]).value).toBeNull(); // instant only
	});

	it("returns a missing field when there's no fiscal-year-length filing to anchor to", () => {
		const facts = [fact({ start: "2025-01-01", end: "2025-03-31", val: 10, fp: "Q1" })];
		const result = computeTtm(facts);
		expect(result.value).toBeNull();
		expect(result.note).toMatch(/no fiscal-year-length filing/i);
	});

	it("uses the most recently filed version of a restated period", () => {
		const facts = [
			fact({ start: "2023-01-01", end: "2023-12-31", val: 100, fp: "FY", filed: "2024-01-15" }),
			fact({ start: "2024-01-01", end: "2024-12-31", val: 200, fp: "FY", filed: "2025-01-15" }),
			fact({ start: "2024-01-01", end: "2024-12-31", val: 999, fp: "FY", filed: "2025-06-01" }), // restated
		];
		const result = computeTtm(facts);
		expect(result.value).toBe(999);
	});
});

describe("latestFiscalYear", () => {
	it("returns the most recent fiscal-year-length figure, ignoring any interim data", () => {
		const facts = [
			fact({ start: "2024-01-01", end: "2024-12-31", val: 100, fp: "FY" }),
			fact({ start: "2025-01-01", end: "2025-03-31", val: 999, fp: "Q1" }), // interim, must be ignored
		];
		const result = latestFiscalYear(facts);
		expect(result.value).toBe(100);
		expect(result.basis).toBe("fiscal-year");
	});

	it("doesn't roll forward into a TTM even when current and year-ago interim data both exist", () => {
		// Same shape as the Adobe OCF fixture, where computeTtm would roll
		// forward to a blended TTM — latestFiscalYear must not do that.
		const result = latestFiscalYear(ADOBE_OCF);
		expect(result.value).toBe(10031000000); // the FY2025 figure alone
		expect(result.basis).toBe("fiscal-year");
	});

	it("returns a missing field when there's no fiscal-year-length data", () => {
		expect(latestFiscalYear(null).value).toBeNull();
		expect(latestFiscalYear([fact({ start: "2025-01-01", end: "2025-03-31", val: 10, fp: "Q1" })]).value).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// deriveFundamentals — full pipeline over a synthetic companyfacts payload.
// ---------------------------------------------------------------------------

function makeCompanyFacts(gaap: Record<string, SecConcept>): SecCompanyFacts {
	return { cik: 320193, entityName: "Test Co", facts: { "us-gaap": gaap } };
}

describe("deriveFundamentals", () => {
	it("derives every field when the filer reports the standard tags cleanly", () => {
		const gaap: Record<string, SecConcept> = {
			EarningsPerShareDiluted: concept(
				[
					fact({ start: "2024-01-01", end: "2024-12-31", val: 4, fp: "FY" }),
					fact({ start: "2025-01-01", end: "2025-06-30", val: 3, fp: "Q2" }),
					fact({ start: "2024-01-01", end: "2024-06-30", val: 2, fp: "Q2" }),
				],
				"USD/shares"
			),
			NetCashProvidedByUsedInOperatingActivities: concept(ADOBE_OCF),
			PaymentsToAcquirePropertyPlantAndEquipment: concept([
				fact({ start: "2024-11-30", end: "2025-11-28", val: 179000000, fy: 2025, fp: "FY", filed: "2026-01-15" }),
				fact({ start: "2024-11-30", end: "2025-05-30", val: 73000000, fy: 2025, fp: "Q2", filed: "2025-06-25" }),
				fact({ start: "2025-11-29", end: "2026-05-29", val: 95000000, fy: 2026, fp: "Q2", filed: "2026-06-15" }),
			]),
			WeightedAverageNumberOfDilutedSharesOutstanding: concept(
				[fact({ start: "2025-11-29", end: "2026-05-29", val: 400000000 })],
				"shares"
			),
			LongTermDebtNoncurrent: concept([fact({ end: "2026-05-29", val: 5000000000 })]),
			LongTermDebtCurrent: concept([fact({ end: "2026-05-29", val: 850000000 })]),
			CashAndCashEquivalentsAtCarryingValue: concept([fact({ end: "2026-05-29", val: 2000000000 })]),
			IncomeTaxExpenseBenefit: concept([
				fact({ start: "2024-11-30", end: "2025-11-28", val: 1500000000, fy: 2025, fp: "FY", filed: "2026-01-15" }),
				fact({ start: "2024-11-30", end: "2025-05-30", val: 700000000, fy: 2025, fp: "Q2", filed: "2025-06-25" }),
				fact({ start: "2025-11-29", end: "2026-05-29", val: 800000000, fy: 2026, fp: "Q2", filed: "2026-06-15" }),
			]),
			IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: concept([
				fact({ start: "2024-11-30", end: "2025-11-28", val: 6000000000, fy: 2025, fp: "FY", filed: "2026-01-15" }),
				fact({ start: "2024-11-30", end: "2025-05-30", val: 2800000000, fy: 2025, fp: "Q2", filed: "2025-06-25" }),
				fact({ start: "2025-11-29", end: "2026-05-29", val: 3200000000, fy: 2026, fp: "Q2", filed: "2026-06-15" }),
			]),
		};

		const result = deriveFundamentals(makeCompanyFacts(gaap), "adbe");

		expect(result.ticker).toBe("ADBE");
		expect(result.ocf.value).toBe(ADOBE_OCF_TTM);
		expect(result.capex.value).toBe(179000000 + 95000000 - 73000000);
		expect(result.fcf.value).toBe(result.ocf.value! - result.capex.value!);
		expect(result.shares.value).toBe(400000000);
		expect(result.totDebt.value).toBe(5000000000 + 850000000);
		expect(result.netDebt.value).toBe(5000000000 + 850000000 - 2000000000);

		// Tax rate deliberately uses the latest fiscal year alone, not a TTM
		// rollforward (see latestFiscalYear's own comment for why) — so this
		// should ignore the Q2 interim entries entirely.
		expect(result.taxRate.value).toBeCloseTo(1500000000 / 6000000000, 10);

		// intExp wasn't in the fixture at all — must abstain, not invent a number.
		expect(result.intExp.value).toBeNull();
		expect(result.intExp.note).toMatch(/no matching xbrl tag/i);
	});

	it("abstains on tax rate when trailing pre-tax income is zero or negative", () => {
		const gaap: Record<string, SecConcept> = {
			IncomeTaxExpenseBenefit: concept([fact({ start: "2024-01-01", end: "2024-12-31", val: 10, fp: "FY" })]),
			IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: concept([
				fact({ start: "2024-01-01", end: "2024-12-31", val: -50, fp: "FY" }),
			]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "loss");
		expect(result.taxRate.value).toBeNull();
		expect(result.taxRate.note).toMatch(/isn't meaningful/i);
	});

	it("flags total debt as partial when only one of the two debt tags is present", () => {
		const gaap: Record<string, SecConcept> = {
			LongTermDebtNoncurrent: concept([fact({ end: "2025-01-01", val: 1000 })]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "partial");
		expect(result.totDebt.value).toBe(1000);
		expect(result.totDebt.note).toMatch(/no separately tagged current portion/);
	});

	it("leaves total debt (and net debt) unresolved when neither debt tag is present", () => {
		const result = deriveFundamentals(makeCompanyFacts({}), "nodebt");
		expect(result.totDebt.value).toBeNull();
		expect(result.netDebt.value).toBeNull();
	});

	it("falls back to basic EPS and basic shares when a filer doesn't report diluted figures, and discloses it (Berkshire Hathaway's real shape)", () => {
		const gaap: Record<string, SecConcept> = {
			EarningsPerShareBasic: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 12345, fp: "FY" })],
				"USD/shares"
			),
			WeightedAverageNumberOfSharesOutstandingBasic: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 1440000 })],
				"shares"
			),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "brkb");
		expect(result.eps.value).toBe(12345);
		expect(result.eps.note).toMatch(/doesn't report diluted eps separately/i);
		expect(result.shares.value).toBe(1440000);
		expect(result.shares.note).toMatch(/basic weighted-average shares/i);
		expect(result.shares.note).toMatch(/doesn't report a diluted share count/i);
	});

	it("prefers diluted EPS and shares over basic when both are reported", () => {
		const gaap: Record<string, SecConcept> = {
			EarningsPerShareDiluted: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 5, fp: "FY" })],
				"USD/shares"
			),
			EarningsPerShareBasic: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 5.5, fp: "FY" })],
				"USD/shares"
			),
			WeightedAverageNumberOfDilutedSharesOutstanding: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 100 })],
				"shares"
			),
			WeightedAverageNumberOfSharesOutstandingBasic: concept(
				[fact({ start: "2025-01-01", end: "2025-12-31", val: 98 })],
				"shares"
			),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "both");
		expect(result.eps.value).toBe(5);
		expect(result.eps.note).not.toMatch(/basic eps/i);
		expect(result.shares.value).toBe(100);
		expect(result.shares.note).toMatch(/^Diluted/);
	});

	it("falls back to the generic DebtCurrent tag for a filer with no LongTermDebt* tags at all (Accenture's real shape)", () => {
		const gaap: Record<string, SecConcept> = {
			DebtCurrent: concept([fact({ end: "2026-05-31", val: 112816000 })]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "acn");
		expect(result.totDebt.value).toBe(112816000);
		expect(result.totDebt.note).toMatch(/no noncurrent long-term debt tag found/);
	});

	it("picks up debt reported only as a convertible note (Check Point's real numbers)", () => {
		const gaap: Record<string, SecConcept> = {
			ConvertibleLongTermNotesPayable: concept([
				fact({ end: "2024-12-31", val: 0, fp: "FY", form: "20-F" }),
				fact({ end: "2025-12-31", val: 1972100000, fp: "FY", form: "20-F" }),
			]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "chkp");
		expect(result.totDebt.value).toBe(1972100000);
	});

	it("flags a resolved value as stale instead of silently presenting decade-old data as current (Berkshire Hathaway's real shape — EPS/shares are only ever tagged with a required Class A/B dimension SEC's API doesn't expose, so the newest fact this plugin can see is from 2015)", () => {
		const gaap: Record<string, SecConcept> = {
			WeightedAverageNumberOfSharesOutstandingBasic: concept(
				[fact({ start: "2015-01-01", end: "2015-09-30", val: 1643118, fp: "Q3" })],
				"shares"
			),
		};
		const now = new Date("2026-09-20");
		const result = deriveFundamentals(makeCompanyFacts(gaap), "brkb", now);
		expect(result.shares.value).toBe(1643118); // still resolved — not blanked out
		expect(result.shares.note).toMatch(/stale/i);
		expect(result.shares.note).toMatch(/2015-09-30/);
	});

	it("does not flag a recently-reported value as stale", () => {
		const gaap: Record<string, SecConcept> = {
			WeightedAverageNumberOfDilutedSharesOutstanding: concept(
				[fact({ start: "2026-01-01", end: "2026-06-30", val: 100 })],
				"shares"
			),
		};
		const now = new Date("2026-09-20");
		const result = deriveFundamentals(makeCompanyFacts(gaap), "fresh", now);
		expect(result.shares.note).not.toMatch(/stale/i);
	});

	it("doesn't lock onto an abandoned debt tag when a fresher one exists, and picks up noncurrent debt reported only under the lease-bundled tag (Boston Scientific's real numbers)", () => {
		const gaap: Record<string, SecConcept> = {
			// BSX has never used LongTermDebtNoncurrent, and abandoned
			// LongTermDebtCurrent back in 2017 — both must be worked around.
			LongTermDebtCurrent: concept([
				fact({ end: "2016-12-31", val: 250000000 }),
				fact({ end: "2017-03-31", val: 0 }),
			]),
			DebtCurrent: concept([fact({ end: "2026-06-30", val: 1709000000 })]),
			LongTermDebtAndCapitalLeaseObligations: concept([fact({ end: "2026-06-30", val: 10915000000 })]),
			CashAndCashEquivalentsAtCarryingValue: concept([fact({ end: "2026-06-30", val: 539000000 })]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "bsx");
		expect(result.totDebt.value).toBe(10915000000 + 1709000000);
		expect(result.netDebt.value).toBe(10915000000 + 1709000000 - 539000000);
	});

	it("doesn't let a one-time quarterly tax item distort the effective tax rate (Boston Scientific's real numbers)", () => {
		// BSX's FY2025 rate was ~14.6%. A discrete tax benefit in Q1 2026 would
		// drag a TTM-rolled rate down to ~5% — a real, verified case that's
		// exactly why tax rate uses latestFiscalYear instead of computeTtm.
		const gaap: Record<string, SecConcept> = {
			IncomeTaxExpenseBenefit: concept([
				fact({ start: "2025-01-01", end: "2025-12-31", val: 493000000, fp: "FY" }),
				fact({ start: "2025-01-01", end: "2025-06-30", val: 279000000, fp: "Q2" }),
				fact({ start: "2026-01-01", end: "2026-06-30", val: -21000000, fp: "Q2" }),
			]),
			IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: concept([
				fact({ start: "2025-01-01", end: "2025-12-31", val: 3385000000, fp: "FY" }),
				fact({ start: "2025-01-01", end: "2025-06-30", val: 1746000000, fp: "Q2" }),
				fact({ start: "2026-01-01", end: "2026-06-30", val: 2222000000, fp: "Q2" }),
			]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "bsx");
		expect(result.taxRate.value).toBeCloseTo(493000000 / 3385000000, 10); // ~14.57%, not ~5%
	});

	it("flags a same-metric mismatch date instead of silently combining mismatched balance-sheet dates", () => {
		const gaap: Record<string, SecConcept> = {
			LongTermDebtNoncurrent: concept([fact({ end: "2025-01-01", val: 1000 })]),
			LongTermDebtCurrent: concept([fact({ end: "2025-04-01", val: 200 })]),
		};
		const result = deriveFundamentals(makeCompanyFacts(gaap), "mismatch");
		expect(result.totDebt.value).toBe(1200);
		expect(result.totDebt.note).toMatch(/different balance-sheet dates/);
	});
});

// ---------------------------------------------------------------------------
// I/O layer, via an injected fake HttpGet — no real network access and no
// dependency on Obsidian's runtime.
// ---------------------------------------------------------------------------

function fakeGet(responses: Record<string, HttpResponse | "throw">): HttpGet {
	return async (url) => {
		const entry = responses[url];
		if (entry === undefined) throw new Error(`unexpected URL in test: ${url}`);
		if (entry === "throw") throw new Error("network down");
		return entry;
	};
}

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const factsUrl = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const TICKER_MAP_RESPONSE: HttpResponse = {
	status: 200,
	json: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } },
};

beforeEach(() => {
	_resetTickerMapCacheForTests();
});

describe("resolveCik", () => {
	it("resolves a known ticker to its zero-padded CIK", async () => {
		const get = fakeGet({ [TICKERS_URL]: TICKER_MAP_RESPONSE });
		const result = await resolveCik("aapl", get);
		expect(isFundamentalsError(result as never)).toBe(false);
		expect(result).toEqual({ cik: "0000320193", title: "Apple Inc." });
	});

	it("reports not-found for a ticker SEC doesn't know about", async () => {
		const get = fakeGet({ [TICKERS_URL]: TICKER_MAP_RESPONSE });
		const result = await resolveCik("NOTREAL", get);
		expect(result).toMatchObject({ kind: "not-found" });
	});

	it("reports a clear network error when the ticker map can't be fetched", async () => {
		const get = fakeGet({ [TICKERS_URL]: "throw" });
		const result = await resolveCik("AAPL", get);
		expect(result).toMatchObject({ kind: "network" });
		expect((result as { message: string }).message).toMatch(/couldn't reach sec edgar/i);
	});

	it("reports a clear message on rate limiting", async () => {
		const get = fakeGet({ [TICKERS_URL]: { status: 429, json: {} } });
		const result = await resolveCik("AAPL", get);
		expect((result as { message: string }).message).toMatch(/rate-limited/i);
	});
});

describe("fetchCompanyFactsJson", () => {
	it("returns the parsed payload on success", async () => {
		const payload: SecCompanyFacts = { cik: 320193, entityName: "Apple Inc.", facts: {} };
		const get = fakeGet({ [factsUrl("0000320193")]: { status: 200, json: payload } });
		const result = await fetchCompanyFactsJson("0000320193", "Apple Inc.", get);
		expect(result).toEqual(payload);
	});

	it("reports no-data on a 404", async () => {
		const get = fakeGet({ [factsUrl("0000320193")]: { status: 404, json: {} } });
		const result = await fetchCompanyFactsJson("0000320193", "Apple Inc.", get);
		expect(result).toMatchObject({ kind: "no-data" });
	});
});

describe("fetchFundamentals", () => {
	it("resolves ticker -> CIK -> companyfacts -> derived fields end to end", async () => {
		const payload: SecCompanyFacts = {
			cik: 320193,
			entityName: "Apple Inc.",
			facts: {
				"us-gaap": {
					EarningsPerShareDiluted: concept(
						[fact({ start: "2024-01-01", end: "2024-12-31", val: 6, fp: "FY" })],
						"USD/shares"
					),
				},
			},
		};
		const get = fakeGet({
			[TICKERS_URL]: TICKER_MAP_RESPONSE,
			[factsUrl("0000320193")]: { status: 200, json: payload },
		});

		const result = await fetchFundamentals("aapl", get);
		expect(isFundamentalsError(result)).toBe(false);
		if (!isFundamentalsError(result)) {
			expect(result.eps.value).toBe(6);
			expect(result.cik).toBe("0000320193");
		}
	});

	it("returns a friendly error for a blank ticker without making any request", async () => {
		const get = fakeGet({});
		const result = await fetchFundamentals("   ", get);
		expect(result).toMatchObject({ kind: "not-found", message: "Enter a ticker first." });
	});

	it("short-circuits with the CIK-lookup error and never calls the companyfacts endpoint", async () => {
		const get = fakeGet({ [TICKERS_URL]: TICKER_MAP_RESPONSE });
		const result = await fetchFundamentals("NOTREAL", get);
		expect(result).toMatchObject({ kind: "not-found" });
	});
});
