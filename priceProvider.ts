import { requestUrl } from "obsidian";
import { parseLatestFredValue } from "./fred";

// Same Yahoo Finance chart endpoint (and two-host fallback) used by the Stonks
// plugin. requestUrl runs the request from Obsidian's main process, sidestepping
// the CORS restrictions a normal fetch() would hit against this endpoint.
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

interface YahooChartResult {
	meta?: {
		regularMarketPrice?: number;
	};
	timestamp?: number[];
	indicators?: {
		quote?: Array<{ close?: Array<number | null> }>;
	};
}

interface YahooChartResponse {
	chart?: {
		result?: YahooChartResult[];
	};
}

async function fetchChart(symbol: string, interval: string, range: string): Promise<YahooChartResult | null> {
	for (const host of YAHOO_HOSTS) {
		try {
			const res = await requestUrl({
				url: `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
				throw: false,
			});
			if (res.status !== 200) continue;
			const result = (res.json as YahooChartResponse).chart?.result?.[0];
			if (result) return result;
		} catch {
			continue;
		}
	}
	return null;
}

export async function fetchQuotePrice(ticker: string): Promise<number | null> {
	const symbol = ticker.trim().toUpperCase();
	if (!symbol) return null;

	const price = (await fetchChart(symbol, "1d", "1d"))?.meta?.regularMarketPrice;
	return typeof price === "number" ? price : null;
}

// Latest price plus a close-price history (epoch ms), for the Macro screen's
// charts. Days Yahoo has no close for (null entries) are dropped.
export async function fetchQuoteHistory(
	ticker: string,
	interval: string,
	range: string
): Promise<{ latest: number | null; history: { t: number; v: number }[] } | null> {
	const symbol = ticker.trim().toUpperCase();
	if (!symbol) return null;

	const result = await fetchChart(symbol, interval, range);
	if (!result) return null;

	const closes = result.indicators?.quote?.[0]?.close ?? [];
	const history = (result.timestamp ?? []).flatMap((ts, i) => {
		const v = closes[i];
		return typeof v === "number" ? [{ t: ts * 1000, v }] : [];
	});
	const price = result.meta?.regularMarketPrice;
	return { latest: typeof price === "number" ? price : null, history };
}

// ^TNX is Yahoo's ticker for the CBOE 10-Year Treasury Note Yield index, and
// its regularMarketPrice is already the yield as a percentage (e.g. 4.52
// means 4.52%) — the same shape the risk-free rate is used in throughout this
// plugin, so no conversion is needed on the result.
export function fetchRiskFreeRate(): Promise<number | null> {
	return fetchQuotePrice("^TNX");
}

// Moody's Seasoned Aaa Corporate Bond Yield (FRED series DAAA), as a
// percentage like ^TNX — Graham's Y. FRED's public CSV download needs no API
// key; only the last ~60 days are requested, since only the latest
// observation is used (holidays leave empty rows, hence the window).
export async function fetchAaaYield(): Promise<number | null> {
	const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	try {
		const res = await requestUrl({
			url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DAAA&cosd=${since}`,
			throw: false,
		});
		if (res.status !== 200) return null;
		return parseLatestFredValue(res.text);
	} catch {
		return null;
	}
}
