import { requestUrl } from "obsidian";

// Same Yahoo Finance chart endpoint (and two-host fallback) used by the Stonks
// plugin. requestUrl runs the request from Obsidian's main process, sidestepping
// the CORS restrictions a normal fetch() would hit against this endpoint.
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

interface YahooChartResponse {
	chart?: {
		result?: Array<{
			meta?: {
				regularMarketPrice?: number;
			};
		}>;
	};
}

export async function fetchQuotePrice(ticker: string): Promise<number | null> {
	const symbol = ticker.trim().toUpperCase();
	if (!symbol) return null;

	for (const host of YAHOO_HOSTS) {
		try {
			const res = await requestUrl({
				url: `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
				throw: false,
			});
			if (res.status !== 200) continue;
			const data = res.json as YahooChartResponse;
			const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
			if (typeof price === "number") return price;
		} catch {
			continue;
		}
	}
	return null;
}

// ^TNX is Yahoo's ticker for the CBOE 10-Year Treasury Note Yield index, and
// its regularMarketPrice is already the yield as a percentage (e.g. 4.52
// means 4.52%) — the same shape the risk-free rate is used in throughout this
// plugin, so no conversion is needed on the result.
export function fetchRiskFreeRate(): Promise<number | null> {
	return fetchQuotePrice("^TNX");
}
