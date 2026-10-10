import { requestUrl } from "obsidian";
import {
	buildSnapshot,
	QUOTE_KEYS,
	QUOTE_SYMBOLS,
	YIELD_MATURITIES,
	YIELD_SYMBOLS,
	type MarketSnapshot,
	type QuoteKey,
	type QuoteSeries,
	type YieldMaturity,
	type YieldSeries,
} from "./marketData";
import { fetchQuoteHistory } from "./priceProvider";

// A personal fork of posix4e/shiller_wrapper_data — parses Robert Shiller's
// Yale/shillerdata.com spreadsheet into JSON. Not auto-updating; only moves
// when the fork's GitHub Actions workflow is manually re-run (see plan.md).
const MACRO_DATA_URL = "https://fernanluyano.github.io/shiller_wrapper_data/data/stock_market_data.json";

// Full series goes back to 1871; only the trailing window is relevant here.
// Computed off the current date at fetch time rather than a hardcoded start
// year, so the cutoff never needs bumping as time passes.
const MACRO_HISTORY_YEARS = 40;

export interface MacroRow {
	month: string; // date_string, "YYYY-MM-01"
	cape: number | null;
	trCape: number | null;
	dividendYield: number | null;
	sp500: number | null;
	realPrice: number | null;
}

interface ShillerDataRow {
	date_string?: string;
	cape?: number | null;
	tr_cape?: number | null;
	Yield?: number | null;
	sp500?: number | null;
	real_price?: number | null;
}

interface ShillerDataResponse {
	data?: ShillerDataRow[];
}

export async function fetchMacroData(): Promise<MacroRow[] | null> {
	try {
		const res = await requestUrl({ url: MACRO_DATA_URL, throw: false });
		if (res.status !== 200) return null;

		const payload = res.json as ShillerDataResponse;
		const rows = payload.data;
		if (!Array.isArray(rows)) return null;

		const cutoff = new Date();
		cutoff.setFullYear(cutoff.getFullYear() - MACRO_HISTORY_YEARS);
		const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;

		return rows
			.filter((r) => typeof r.date_string === "string" && r.date_string >= cutoffMonth)
			.map((r) => ({
				month: r.date_string as string,
				cape: r.cape ?? null,
				trCape: r.tr_cape ?? null,
				dividendYield: r.Yield ?? null,
				sp500: r.sp500 ?? null,
				realPrice: r.real_price ?? null,
			}));
	} catch {
		return null;
	}
}

// Weekly bars over 10 years: enough for the 10y-3M spread chart and a
// year-ago point for the curve, without pulling ~2,500 daily bars per symbol.
const YIELD_HISTORY_INTERVAL = "1wk";
const YIELD_HISTORY_RANGE = "10y";

// A month of daily bars per quote: just enough for the 5-trading-day change.
const QUOTE_HISTORY_INTERVAL = "1d";
const QUOTE_HISTORY_RANGE = "1mo";

// Yahoo-sourced market snapshot: the Treasury curve (3M/5Y/10Y/30Y, latest
// plus a year ago), the 10y-3M spread history, and VIX/gold/silver/oil with
// their 5-day change.
// Returns null only when nothing came back at all; individual failures show
// up as null fields instead.
export async function fetchMarketData(): Promise<MarketSnapshot | null> {
	try {
		const [yieldResults, quoteResults] = await Promise.all([
			Promise.all(YIELD_MATURITIES.map((m) => fetchQuoteHistory(YIELD_SYMBOLS[m], YIELD_HISTORY_INTERVAL, YIELD_HISTORY_RANGE))),
			Promise.all(QUOTE_KEYS.map((k) => fetchQuoteHistory(QUOTE_SYMBOLS[k], QUOTE_HISTORY_INTERVAL, QUOTE_HISTORY_RANGE))),
		]);

		const toSeries = (r: Awaited<ReturnType<typeof fetchQuoteHistory>>): YieldSeries => ({
			latest: r?.latest ?? null,
			history: r?.history ?? [],
		});
		const yields = Object.fromEntries(YIELD_MATURITIES.map((m, i) => [m, toSeries(yieldResults[i])])) as Record<
			YieldMaturity,
			YieldSeries
		>;
		const quotes = Object.fromEntries(QUOTE_KEYS.map((k, i) => [k, toSeries(quoteResults[i])])) as Record<
			QuoteKey,
			QuoteSeries
		>;

		const snapshot = buildSnapshot(yields, quotes, Date.now());
		const gotAnything =
			YIELD_MATURITIES.some((m) => snapshot.yields[m].latest !== null) ||
			QUOTE_KEYS.some((k) => snapshot.quotes[k].price !== null);
		return gotAnything ? snapshot : null;
	} catch {
		return null;
	}
}
