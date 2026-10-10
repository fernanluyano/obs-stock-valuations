// Pure types and derivations for the Macro screen's Yahoo-sourced market
// data. No Obsidian imports on purpose — the fetching lives in macro.ts, and
// keeping this file runtime-free lets tests exercise it directly.

export interface SeriesPoint {
	t: number; // epoch ms
	v: number;
}

export const YIELD_MATURITIES = ["3M", "5Y", "10Y", "30Y"] as const;
export type YieldMaturity = (typeof YIELD_MATURITIES)[number];

// Yahoo's CBOE yield indices; each regularMarketPrice is already a percentage.
export const YIELD_SYMBOLS: Record<YieldMaturity, string> = {
	"3M": "^IRX",
	"5Y": "^FVX",
	"10Y": "^TNX",
	"30Y": "^TYX",
};

export const QUOTE_KEYS = ["vix", "gold", "silver", "oil"] as const;
export type QuoteKey = (typeof QUOTE_KEYS)[number];

export const QUOTE_SYMBOLS: Record<QuoteKey, string> = {
	vix: "^VIX",
	gold: "GC=F",
	silver: "SI=F",
	oil: "CL=F",
};

export interface YieldReading {
	latest: number | null;
	yearAgo: number | null;
}

export interface QuoteReading {
	price: number | null;
	// % change vs. the close 5 trading days earlier; null without enough history.
	weekChangePct: number | null;
}

export interface MarketSnapshot {
	yields: Record<YieldMaturity, YieldReading>;
	// 10y minus 3M, in percentage points, oldest first. Empty if either leg is missing.
	spread: SeriesPoint[];
	quotes: Record<QuoteKey, QuoteReading>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_AGO_TOLERANCE_MS = 14 * DAY_MS;
const TRADING_DAYS_PER_WEEK = 5;

// The last point at or before `target`, as long as it's within tolerance of
// it — a series that doesn't reach back a year yields null, not a stale value.
export function valueNear(points: SeriesPoint[], target: number): number | null {
	let best: SeriesPoint | null = null;
	for (const p of points) {
		if (p.t <= target && (best === null || p.t > best.t)) best = p;
	}
	return best !== null && target - best.t <= YEAR_AGO_TOLERANCE_MS ? best.v : null;
}

// Long minus short, matched by calendar day (the two symbols' weekly bars
// don't always carry the identical timestamp), oldest first.
export function spreadSeries(long: SeriesPoint[], short: SeriesPoint[]): SeriesPoint[] {
	const shortByDay = new Map(short.map((p) => [Math.floor(p.t / DAY_MS), p.v]));
	return long
		.flatMap((p) => {
			const s = shortByDay.get(Math.floor(p.t / DAY_MS));
			return s === undefined ? [] : [{ t: p.t, v: p.v - s }];
		})
		.sort((a, b) => a.t - b.t);
}

// Latest price vs. the close five bars before the last one (daily bars, so
// one trading week). Null when the history is too short or the base is not
// positive.
export function weekChangePct(latest: number | null, dailyHistory: SeriesPoint[]): number | null {
	if (latest === null || dailyHistory.length < TRADING_DAYS_PER_WEEK + 1) return null;
	const base = dailyHistory[dailyHistory.length - 1 - TRADING_DAYS_PER_WEEK].v;
	return base > 0 ? ((latest - base) / base) * 100 : null;
}

export interface YieldSeries {
	latest: number | null;
	history: SeriesPoint[];
}

export interface QuoteSeries {
	latest: number | null;
	history: SeriesPoint[]; // daily bars
}

export function buildSnapshot(
	yields: Record<YieldMaturity, YieldSeries>,
	quotes: Record<QuoteKey, QuoteSeries>,
	now: number
): MarketSnapshot {
	const yearAgo = now - 365 * DAY_MS;
	const reading = (s: YieldSeries): YieldReading => ({ latest: s.latest, yearAgo: valueNear(s.history, yearAgo) });
	const quote = (q: QuoteSeries): QuoteReading => ({ price: q.latest, weekChangePct: weekChangePct(q.latest, q.history) });
	return {
		yields: {
			"3M": reading(yields["3M"]),
			"5Y": reading(yields["5Y"]),
			"10Y": reading(yields["10Y"]),
			"30Y": reading(yields["30Y"]),
		},
		spread: spreadSeries(yields["10Y"].history, yields["3M"].history),
		quotes: {
			vix: quote(quotes.vix),
			gold: quote(quotes.gold),
			silver: quote(quotes.silver),
			oil: quote(quotes.oil),
		},
	};
}

// ---------------------------------------------------------------------------
// Status tiers for the Macro cards. Cut points and the "lower is better"
// shape are the ones used by the personal trading dashboard's market cards
// (VIX 20/30, 10y 4/5, oil 70/100, CAPE 20/30, gold/silver 5-day trend 1%/4%).
// The curve-spread cuts are this plugin's own. Fixed, not user settings.
// ---------------------------------------------------------------------------

export type Tier = "green" | "yellow" | "red";

export interface Status {
	tier: Tier;
	label: string;
}

function lowerBetter(value: number, lowMax: number, elevatedMax: number, labels: [string, string, string]): Status {
	if (value <= lowMax) return { tier: "green", label: labels[0] };
	if (value <= elevatedMax) return { tier: "yellow", label: labels[1] };
	return { tier: "red", label: labels[2] };
}

export const capeStatus = (cape: number): Status => lowerBetter(cape, 20, 30, ["CHEAP", "FAIR", "EXPENSIVE"]);
export const tenYearStatus = (yieldPct: number): Status => lowerBetter(yieldPct, 4, 5, ["LOW", "ELEVATED", "HIGH"]);
export const vixStatus = (vix: number): Status => lowerBetter(vix, 20, 30, ["LOW", "ELEVATED", "HIGH"]);
export const oilStatus = (price: number): Status => lowerBetter(price, 70, 100, ["LOW", "ELEVATED", "HIGH"]);

// 5-day move for gold/silver: how fast the price is climbing, not whether
// the level is high or low.
export function trendStatus(changePct: number): Status {
	if (changePct < 1) return { tier: "green", label: "FLAT / FALLING" };
	if (changePct < 4) return { tier: "yellow", label: "RISING" };
	return { tier: "red", label: "SURGING" };
}

// 10y − 3M in percentage points. Inverted (below zero) is the classic
// recession warning; a thin positive spread is a flat curve.
export function spreadStatus(pp: number): Status {
	if (pp < 0) return { tier: "red", label: "INVERTED" };
	if (pp < 0.5) return { tier: "yellow", label: "FLAT" };
	return { tier: "green", label: "NORMAL" };
}
