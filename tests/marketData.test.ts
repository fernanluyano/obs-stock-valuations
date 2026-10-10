import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	capeStatus,
	oilStatus,
	spreadSeries,
	spreadStatus,
	tenYearStatus,
	trendStatus,
	valueNear,
	vixStatus,
	weekChangePct,
	type QuoteSeries,
	type YieldSeries,
} from "../marketData";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("valueNear", () => {
	const points = [
		{ t: NOW - 400 * DAY, v: 1 },
		{ t: NOW - 370 * DAY, v: 2 },
		{ t: NOW - 360 * DAY, v: 3 },
	];

	it("picks the last point at or before the target", () => {
		expect(valueNear(points, NOW - 365 * DAY)).toBe(2);
	});

	it("ignores points after the target", () => {
		expect(valueNear(points, NOW - 390 * DAY)).toBe(1);
	});

	it("returns null when the nearest earlier point is more than 14 days away", () => {
		expect(valueNear(points, NOW - 300 * DAY)).toBeNull();
	});

	it("returns null for an empty series or one that starts after the target", () => {
		expect(valueNear([], NOW)).toBeNull();
		expect(valueNear([{ t: NOW, v: 1 }], NOW - 365 * DAY)).toBeNull();
	});
});

describe("spreadSeries", () => {
	it("subtracts the short leg from the long leg, matched by calendar day", () => {
		const long = [
			{ t: 10 * DAY + 1000, v: 5 },
			{ t: 17 * DAY + 1000, v: 4 },
		];
		// Same days, different intraday timestamps.
		const short = [
			{ t: 10 * DAY + 5000, v: 4 },
			{ t: 17 * DAY + 5000, v: 4.5 },
		];

		expect(spreadSeries(long, short)).toEqual([
			{ t: 10 * DAY + 1000, v: 1 },
			{ t: 17 * DAY + 1000, v: -0.5 },
		]);
	});

	it("skips long-leg points with no short-leg counterpart", () => {
		const long = [
			{ t: 10 * DAY, v: 5 },
			{ t: 17 * DAY, v: 5 },
		];
		const short = [{ t: 17 * DAY, v: 3 }];

		expect(spreadSeries(long, short)).toEqual([{ t: 17 * DAY, v: 2 }]);
	});

	it("is empty when either leg is empty", () => {
		expect(spreadSeries([], [{ t: DAY, v: 1 }])).toEqual([]);
		expect(spreadSeries([{ t: DAY, v: 1 }], [])).toEqual([]);
	});

	it("returns oldest first even if the input is not sorted", () => {
		const long = [
			{ t: 20 * DAY, v: 2 },
			{ t: 10 * DAY, v: 1 },
		];
		const short = [
			{ t: 10 * DAY, v: 0 },
			{ t: 20 * DAY, v: 0 },
		];

		expect(spreadSeries(long, short).map((p) => p.t)).toEqual([10 * DAY, 20 * DAY]);
	});
});

describe("weekChangePct", () => {
	// Six daily closes: 100, 101, ..., 105. The base is five bars before the last.
	const history = [100, 101, 102, 103, 104, 105].map((v, i) => ({ t: NOW + i * DAY, v }));

	it("compares the latest price to the close five bars before the last bar", () => {
		expect(weekChangePct(110, history)).toBeCloseTo(10, 6);
	});

	it("is negative when the price has fallen", () => {
		expect(weekChangePct(90, history)).toBeCloseTo(-10, 6);
	});

	it("is null without enough history", () => {
		expect(weekChangePct(110, history.slice(1))).toBeNull();
		expect(weekChangePct(110, [])).toBeNull();
	});

	it("is null without a latest price", () => {
		expect(weekChangePct(null, history)).toBeNull();
	});

	it("is null when the base close is not positive", () => {
		const zeroBase = [0, 1, 2, 3, 4, 5].map((v, i) => ({ t: NOW + i * DAY, v }));
		expect(weekChangePct(5, zeroBase)).toBeNull();
	});
});

describe("buildSnapshot", () => {
	const yieldSeries = (latest: number | null, yearAgo?: number): YieldSeries => ({
		latest,
		history: yearAgo === undefined ? [] : [{ t: NOW - 365 * DAY, v: yearAgo }],
	});
	const quoteSeries = (latest: number | null): QuoteSeries => ({
		latest,
		history: [100, 100, 100, 100, 100, 100].map((v, i) => ({ t: NOW - (5 - i) * DAY, v })),
	});
	const quotes = {
		vix: quoteSeries(18),
		gold: quoteSeries(2000),
		silver: quoteSeries(25),
		oil: quoteSeries(80),
	};
	const flatYields = {
		"3M": yieldSeries(4),
		"5Y": yieldSeries(5),
		"10Y": yieldSeries(5.2),
		"30Y": yieldSeries(5.6),
	};

	it("carries the latest value and a year-ago value per maturity", () => {
		const snap = buildSnapshot(
			{ "3M": yieldSeries(4, 3), "5Y": yieldSeries(5, 4), "10Y": yieldSeries(5.2, 4.2), "30Y": yieldSeries(5.6, 4.6) },
			quotes,
			NOW
		);

		expect(snap.yields["10Y"]).toEqual({ latest: 5.2, yearAgo: 4.2 });
		expect(snap.yields["3M"]).toEqual({ latest: 4, yearAgo: 3 });
	});

	it("leaves yearAgo null when the history doesn't reach back that far", () => {
		const snap = buildSnapshot(flatYields, quotes, NOW);

		expect(snap.yields["10Y"].yearAgo).toBeNull();
	});

	it("builds the 10y minus 3M spread from the two histories", () => {
		const hist = (v: number): YieldSeries => ({ latest: v, history: [{ t: NOW - 7 * DAY, v }] });
		const snap = buildSnapshot({ "3M": hist(4), "5Y": hist(5), "10Y": hist(5.5), "30Y": hist(5.6) }, quotes, NOW);

		expect(snap.spread).toEqual([{ t: NOW - 7 * DAY, v: 1.5 }]);
	});

	it("has an empty spread when one leg has no history", () => {
		const snap = buildSnapshot(
			{ ...flatYields, "10Y": { latest: 5.2, history: [{ t: NOW, v: 5.2 }] } },
			quotes,
			NOW
		);

		expect(snap.spread).toEqual([]);
	});

	it("carries each quote's price and 5-day change, including nulls", () => {
		const snap = buildSnapshot(
			flatYields,
			{ ...quotes, vix: { latest: null, history: [] }, gold: quoteSeries(2100) },
			NOW
		);

		expect(snap.quotes.vix).toEqual({ price: null, weekChangePct: null });
		expect(snap.quotes.gold.price).toBe(2100);
		expect(snap.quotes.gold.weekChangePct).toBeCloseTo(2000, 6);
		expect(snap.quotes.oil).toEqual({ price: 80, weekChangePct: -20 });
	});
});

describe("status tiers", () => {
	it("capeStatus: cheap up to 20, fair up to 30, expensive above", () => {
		expect(capeStatus(20)).toEqual({ tier: "green", label: "CHEAP" });
		expect(capeStatus(25)).toEqual({ tier: "yellow", label: "FAIR" });
		expect(capeStatus(30)).toEqual({ tier: "yellow", label: "FAIR" });
		expect(capeStatus(30.01)).toEqual({ tier: "red", label: "EXPENSIVE" });
	});

	it("tenYearStatus: low up to 4%, elevated up to 5%, high above", () => {
		expect(tenYearStatus(3.9).tier).toBe("green");
		expect(tenYearStatus(4.5)).toEqual({ tier: "yellow", label: "ELEVATED" });
		expect(tenYearStatus(5.24)).toEqual({ tier: "red", label: "HIGH" });
	});

	it("vixStatus: low up to 20, elevated up to 30, high above", () => {
		expect(vixStatus(18).tier).toBe("green");
		expect(vixStatus(20).tier).toBe("green");
		expect(vixStatus(25).tier).toBe("yellow");
		expect(vixStatus(35)).toEqual({ tier: "red", label: "HIGH" });
	});

	it("oilStatus: low up to $70, elevated up to $100, high above", () => {
		expect(oilStatus(65).tier).toBe("green");
		expect(oilStatus(100).tier).toBe("yellow");
		expect(oilStatus(100.5).tier).toBe("red");
	});

	it("trendStatus: under 1% is calm, 1% to 4% rising, 4% or more surging", () => {
		expect(trendStatus(-6)).toEqual({ tier: "green", label: "FLAT / FALLING" });
		expect(trendStatus(0.99).tier).toBe("green");
		expect(trendStatus(1)).toEqual({ tier: "yellow", label: "RISING" });
		expect(trendStatus(3.99).tier).toBe("yellow");
		expect(trendStatus(4)).toEqual({ tier: "red", label: "SURGING" });
	});

	it("spreadStatus: negative is inverted, under 0.5 pp flat, otherwise normal", () => {
		expect(spreadStatus(-0.1)).toEqual({ tier: "red", label: "INVERTED" });
		expect(spreadStatus(0)).toEqual({ tier: "yellow", label: "FLAT" });
		expect(spreadStatus(0.49).tier).toBe("yellow");
		expect(spreadStatus(0.5)).toEqual({ tier: "green", label: "NORMAL" });
		expect(spreadStatus(1.19).tier).toBe("green");
	});
});
