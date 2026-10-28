import { describe, expect, it } from "vitest";
import { fredValueAsOf, parseFredSeries } from "../fred";
import {
	fcfAsOf,
	netDebtAsOf,
	plausibleShares,
	sharesAsOf,
	ttmAsOf,
	type HistoricalFacts,
	type SecFact,
} from "../fundamentalsProvider";

describe("parseFredSeries", () => {
	it("reads numeric rows ascending and skips empty, '.' and junk rows", () => {
		const csv = "observation_date,DAAA\n2026-01-03,5.1\n2026-01-01,\n2026-01-02,.\n2026-01-05,5.3\nnot,a row\r\n";
		expect(parseFredSeries(csv)).toEqual([
			{ date: "2026-01-03", value: 5.1 },
			{ date: "2026-01-05", value: 5.3 },
		]);
	});

	it("is empty for an error page or no data", () => {
		expect(parseFredSeries("<html>error</html>")).toEqual([]);
		expect(parseFredSeries("")).toEqual([]);
	});
});

describe("fredValueAsOf", () => {
	const series = [
		{ date: "2026-01-02", value: 5 },
		{ date: "2026-01-05", value: 6 },
	];

	it("uses the last observation on or before the date (weekends have no row)", () => {
		expect(fredValueAsOf(series, "2026-01-03")).toBe(5);
		expect(fredValueAsOf(series, "2026-01-05")).toBe(6);
		expect(fredValueAsOf(series, "2026-02-01")).toBe(6);
	});

	it("is null before the series starts", () => {
		expect(fredValueAsOf(series, "2026-01-01")).toBeNull();
	});
});

const fact = (start: string, end: string, val: number, filed: string): SecFact => ({
	start,
	end,
	val,
	fy: Number(end.slice(0, 4)),
	fp: "FY",
	form: "10-K",
	filed,
});

describe("ttmAsOf", () => {
	const facts = [
		fact("2022-01-01", "2022-12-31", 3, "2023-02-10"),
		fact("2023-01-01", "2023-03-31", 0.8, "2023-05-05"),
		fact("2023-01-01", "2023-12-31", 4, "2024-02-10"),
		fact("2023-01-01", "2023-03-31", 0.8, "2024-05-05"), // comparative re-filed a year later
		fact("2024-01-01", "2024-03-31", 1.2, "2024-05-05"),
	];

	it("rolls forward to a true TTM once the interim filing is out", () => {
		expect(ttmAsOf(facts, "2024-06-30")).toBeCloseTo(4.4);
	});

	it("does not use a period before it was filed", () => {
		expect(ttmAsOf(facts, "2024-03-31")).toBe(4); // Q1 2024 not filed yet
		expect(ttmAsOf(facts, "2024-01-31")).toBe(3); // FY2023 not filed yet
	});

	it("is null before any fiscal year had been filed, or with no facts", () => {
		expect(ttmAsOf(facts, "2022-06-01")).toBeNull();
		expect(ttmAsOf(null, "2024-06-30")).toBeNull();
		expect(ttmAsOf([], "2024-06-30")).toBeNull();
	});

	it("takes the latest restated value of a period (stock splits) but only once the period was first filed", () => {
		const split = [fact("2023-01-01", "2023-12-31", 4, "2024-02-10"), fact("2023-01-01", "2023-12-31", 2, "2025-03-01")];
		expect(ttmAsOf(split, "2024-03-31")).toBe(2);
		expect(ttmAsOf(split, "2024-01-31")).toBeNull();
	});
});

describe("sharesAsOf", () => {
	const q = (end: string, val: number, filed: string) => fact(`${end.slice(0, 7)}-01`, end, val, filed);
	const start = "2024-01-01";
	const quarters = [
		fact(start, "2024-03-31", 100, "2024-05-05"),
		fact("2024-04-01", "2024-06-30", 102, "2024-08-05"),
	];

	it("uses the latest share count known on the date", () => {
		expect(sharesAsOf(quarters, "2024-06-30")).toBe(100);
		expect(sharesAsOf(quarters, "2024-09-01")).toBe(102);
	});

	it("is null before any count was filed, or with no facts", () => {
		expect(sharesAsOf(quarters, "2024-04-01")).toBeNull();
		expect(sharesAsOf(null, "2024-09-01")).toBeNull();
		expect(sharesAsOf([], "2024-09-01")).toBeNull();
	});

	it("is null before a jump that looks like a split nobody restated, and fine after it", () => {
		const unrestated = [q("2023-12-31", 100, "2024-02-10"), q("2024-03-31", 200, "2024-05-05")];
		expect(sharesAsOf(unrestated, "2024-03-01")).toBeNull();
		expect(sharesAsOf(unrestated, "2024-06-01")).toBe(200);
	});

	it("trusts a split that later filings restated, because there is no jump left", () => {
		const restated = [q("2023-12-31", 100, "2024-02-10"), q("2023-12-31", 200, "2025-03-01"), q("2024-03-31", 200, "2024-05-05")];
		expect(sharesAsOf(restated, "2024-03-01")).toBe(200);
	});

	it("treats a reverse split the same way", () => {
		const reverse = [q("2023-12-31", 100, "2024-02-10"), q("2024-03-31", 50, "2024-05-05")];
		expect(sharesAsOf(reverse, "2024-03-01")).toBeNull();
		expect(sharesAsOf(reverse, "2024-06-01")).toBe(50);
	});

	it("does not mistake ordinary buybacks or dilution for a split", () => {
		const drift = [q("2023-12-31", 100, "2024-02-10"), q("2024-03-31", 97, "2024-05-05"), q("2024-06-30", 120, "2024-08-05")];
		expect(sharesAsOf(drift, "2024-03-01")).toBe(100);
		expect(sharesAsOf(drift, "2024-09-01")).toBe(120);
	});
});

// A balance-sheet snapshot: no start date.
const snapshot = (end: string, val: number, filed: string): SecFact => ({ end, val, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", filed });
const noFacts: HistoricalFacts = {
	eps: null,
	ocf: null,
	capex: null,
	shares: null,
	dps: null,
	interestExpense: null,
	ltNoncurrent: null,
	ltCurrent: null,
	cash: null,
};

describe("trailing dividends per share", () => {
	// Quarterly payer: four 0.25 dividends in FY2023, plus 0.30 in Q1 2024.
	const dividends = [
		fact("2023-01-01", "2023-12-31", 1, "2024-02-10"),
		fact("2023-01-01", "2023-03-31", 0.25, "2023-05-05"),
		fact("2024-01-01", "2024-03-31", 0.3, "2024-05-05"),
	];

	it("rolls forward like any other flow, and only with what was filed by then", () => {
		expect(ttmAsOf(dividends, "2024-03-31")).toBe(1);
		expect(ttmAsOf(dividends, "2024-06-30")).toBeCloseTo(1.05); // 1 + 0.30 - 0.25
	});

	it("is null for a filer that reports no dividends", () => {
		expect(ttmAsOf(null, "2024-06-30")).toBeNull();
	});
});

describe("plausibleShares", () => {
	it("keeps a count close to the saved one", () => {
		expect(plausibleShares(118e6, 117.1e6)).toBe(118e6);
		expect(plausibleShares(430e6, 407e6)).toBe(430e6);
		expect(plausibleShares(200e6, 100e6)).toBe(200e6); // 2x is still plausible
	});

	it("rejects a count wildly different from the saved one: Berkshire's Class A count against Class B equivalents", () => {
		expect(plausibleShares(1.6e6, 2140e6)).toBeNull();
		expect(plausibleShares(2140e6, 1.6e6)).toBeNull();
		expect(plausibleShares(400e6, 100e6)).toBeNull(); // 4x
	});

	it("is null for an unknown or non-positive count", () => {
		expect(plausibleShares(null, 100e6)).toBeNull();
		expect(plausibleShares(0, 100e6)).toBeNull();
		expect(plausibleShares(-5, 100e6)).toBeNull();
	});

	it("cannot check without a saved count, and then accepts the filing's", () => {
		expect(plausibleShares(100e6, 0)).toBe(100e6);
		expect(plausibleShares(100e6, NaN)).toBe(100e6);
	});
});

describe("fcfAsOf", () => {
	const facts: HistoricalFacts = {
		...noFacts,
		ocf: [fact("2023-01-01", "2023-12-31", 1000, "2024-02-10")],
		capex: [fact("2023-01-01", "2023-12-31", 300, "2024-02-10")],
	};

	it("is operating cash flow minus capex once both are known", () => {
		expect(fcfAsOf(facts, "2024-06-30")).toBe(700);
	});

	it("is null before the filing, or when either part is missing", () => {
		expect(fcfAsOf(facts, "2024-01-31")).toBeNull();
		expect(fcfAsOf({ ...facts, capex: null }, "2024-06-30")).toBeNull();
		expect(fcfAsOf({ ...facts, ocf: null }, "2024-06-30")).toBeNull();
	});
});

describe("netDebtAsOf", () => {
	const facts: HistoricalFacts = {
		...noFacts,
		ltNoncurrent: [snapshot("2023-12-31", 900, "2024-02-10"), snapshot("2024-06-30", 800, "2024-08-05")],
		ltCurrent: [snapshot("2023-12-31", 100, "2024-02-10"), snapshot("2024-06-30", 100, "2024-08-05")],
		cash: [snapshot("2023-12-31", 300, "2024-02-10"), snapshot("2024-06-30", 500, "2024-08-05")],
	};

	it("is debt (noncurrent + current) minus cash, from the latest snapshots filed by then", () => {
		expect(netDebtAsOf(facts, "2024-03-31")).toBe(700); // 900 + 100 - 300
		expect(netDebtAsOf(facts, "2024-09-30")).toBe(400); // 800 + 100 - 500
	});

	it("never uses a snapshot before it was filed", () => {
		expect(netDebtAsOf(facts, "2024-07-31")).toBe(700); // the June snapshot is filed in August
	});

	it("is null before anything was filed, or when cash is missing", () => {
		expect(netDebtAsOf(facts, "2024-01-31")).toBeNull();
		expect(netDebtAsOf({ ...facts, cash: null }, "2024-09-30")).toBeNull();
	});

	it("is blank for a filer with no debt tag and no evidence it is debt-free", () => {
		expect(netDebtAsOf({ ...facts, ltNoncurrent: null, ltCurrent: null }, "2024-09-30")).toBeNull();
	});

	describe("a filer with no recent debt tag (Trade Desk's shape)", () => {
		const base: HistoricalFacts = {
			...noFacts,
			cash: [snapshot("2025-12-31", 1000, "2026-02-10")],
			ocf: [fact("2025-01-01", "2025-12-31", 1000, "2026-02-10")],
		};
		const asOf = "2026-06-30";

		it("is net cash (debt zero) when interest expense isn't reported", () => {
			expect(netDebtAsOf(base, asOf)).toBe(-1000);
		});

		it("is net cash when interest is tiny against operating cash flow (0.3%)", () => {
			const interest = [fact("2025-01-01", "2025-12-31", 3, "2026-02-10")];
			expect(netDebtAsOf({ ...base, interestExpense: interest }, asOf)).toBe(-1000);
		});

		it("is blank when interest is material (2%): the debt is probably under an unusual tag (Evercore's shape)", () => {
			const interest = [fact("2025-01-01", "2025-12-31", 20, "2026-02-10")];
			expect(netDebtAsOf({ ...base, interestExpense: interest }, asOf)).toBeNull();
		});

		it("ignores interest expense that stopped being reported long ago", () => {
			const stale = [fact("2018-01-01", "2018-12-31", 300, "2019-02-10")];
			expect(netDebtAsOf({ ...base, interestExpense: stale }, asOf)).toBe(-1000);
		});

		it("ignores a debt tag that stopped being reported over 2 years ago", () => {
			const old = { ...base, ltNoncurrent: [snapshot("2019-12-31", 500, "2020-02-10")] };
			expect(netDebtAsOf(old, asOf)).toBe(-1000);
		});

		it("is blank without cash, or without positive operating cash flow to compare interest against", () => {
			expect(netDebtAsOf({ ...base, cash: null }, asOf)).toBeNull();
			expect(netDebtAsOf({ ...base, ocf: null }, asOf)).toBeNull();
			expect(netDebtAsOf({ ...base, ocf: [fact("2025-01-01", "2025-12-31", -50, "2026-02-10")] }, asOf)).toBeNull();
		});

		it("still uses a recent debt tag the normal way", () => {
			const withDebt = { ...base, ltNoncurrent: [snapshot("2025-12-31", 300, "2026-02-10")] };
			expect(netDebtAsOf(withDebt, asOf)).toBe(300 - 1000);
		});
	});
});
