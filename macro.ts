import { requestUrl } from "obsidian";

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
	tenYearYield: number | null;
	sp500: number | null;
	realPrice: number | null;
}

interface ShillerDataRow {
	date_string?: string;
	cape?: number | null;
	tr_cape?: number | null;
	Yield?: number | null;
	long_interest_rate?: number | null;
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
				tenYearYield: r.long_interest_rate ?? null,
				sp500: r.sp500 ?? null,
				realPrice: r.real_price ?? null,
			}));
	} catch {
		return null;
	}
}
