// State -> Results glue: converts a saved/in-progress form's scaled string
// fields into real numbers and runs them through the calculations.ts
// formulas. Kept pure and Obsidian-free so it can be unit tested directly —
// see tests/valuationCalc.test.ts.
import { calcDcf, calcGraham, calcTenCap, calcWacc, marginOfSafety, ownerEarningsYield } from "./calculations";
import { SCALE_MULTIPLIERS, ScaleUnit } from "./units";
import { FormState, Results } from "./valuationStore";

export const MONEY_KEYS = new Set<keyof FormState>([
	"intExp",
	"totDebt",
	"netDebt",
	"fcf",
	"ocf",
	"capex",
]);
export const SHARE_KEYS = new Set<keyof FormState>(["shares"]);
export const PERCENT_KEYS = new Set<keyof FormState>([
	"rfr",
	"mrp",
	"taxRate",
	"growth1to5",
	"growth6to10",
	"terminalGrowth",
	"grahamGrowth",
	"aaaYield",
	"mainPct",
]);

// Converts one form field to its real-world numeric value, undoing whichever
// money/shares scale it's currently displayed in.
export function numFromState(
	state: FormState,
	key: keyof FormState,
	moneyScale: ScaleUnit,
	sharesScale: ScaleUnit,
	defaultTaxRatePercent: number
): number {
	const parsed = parseFloat(state[key]);
	if (isNaN(parsed)) {
		// taxRate is deliberately left blank in the form itself so "Fetch data"
		// can always fill it in from SEC EDGAR — but an untouched, unfetched
		// field should still behave sensibly in the WACC calc, so fall back to
		// the Settings default here rather than silently computing with 0%.
		if (key === "taxRate") return defaultTaxRatePercent / 100;
		return 0;
	}
	if (MONEY_KEYS.has(key)) return parsed * SCALE_MULTIPLIERS[moneyScale];
	if (SHARE_KEYS.has(key)) return parsed * SCALE_MULTIPLIERS[sharesScale];
	if (PERCENT_KEYS.has(key)) return parsed / 100;
	return parsed;
}

// Market cap is never typed in — it's always price × shares. Returned as a
// raw dollar number (for the WACC calc) and as a rounded string already
// converted to moneyScale (for storing back into state.mktCap, the same way
// every other money field is stored).
export function deriveMarketCap(
	state: FormState,
	moneyScale: ScaleUnit,
	sharesScale: ScaleUnit
): { raw: number; scaled: string } {
	const raw = numFromState(state, "price", moneyScale, sharesScale, 0) * numFromState(state, "shares", moneyScale, sharesScale, 0);
	const scaled = String(Math.round((raw / SCALE_MULTIPLIERS[moneyScale]) * 100) / 100);
	return { raw, scaled };
}

// Pure state -> Results, with one side effect: state.mktCap is overwritten
// with the freshly-derived market cap (see deriveMarketCap) every time this
// runs, so it can never drift from price × shares or be hand-edited. Shared
// by the live form and by refreshAllPrices, which recomputes a saved
// record's IV/MoS after updating just its price — same math, no fundamentals
// touched, so Graham/Ten Cap IV are unchanged; DCF IV and WACC do move,
// since market cap (and so WACC) is itself price-derived.
export function computeResultsForState(
	state: FormState,
	moneyScale: ScaleUnit,
	sharesScale: ScaleUnit,
	defaultTaxRatePercent: number
): Results {
	const n = (key: keyof FormState) => numFromState(state, key, moneyScale, sharesScale, defaultTaxRatePercent);

	const mktCap = deriveMarketCap(state, moneyScale, sharesScale);
	state.mktCap = mktCap.scaled;

	const wacc = calcWacc({
		rfr: n("rfr"),
		mrp: n("mrp"),
		beta: n("beta"),
		intExp: n("intExp"),
		totDebt: n("totDebt"),
		taxRate: n("taxRate"),
		mktCap: mktCap.raw,
	});

	const dcfIv = calcDcf({
		netDebt: n("netDebt"),
		shares: n("shares"),
		growth1to5: n("growth1to5"),
		growth6to10: n("growth6to10"),
		terminalGrowth: n("terminalGrowth"),
		wacc,
		fcf: n("fcf"),
	});

	const grahamIv = calcGraham({
		eps: n("eps"),
		growth: n("grahamGrowth"),
		aaaYield: n("aaaYield"),
	});

	const tenCap = calcTenCap({
		ocf: n("ocf"),
		capex: n("capex"),
		mainPct: n("mainPct"),
		shares: n("shares"),
	});

	const price = n("price");
	return {
		wacc,
		dcfIv,
		dcfMos: marginOfSafety(dcfIv, price),
		grahamIv,
		grahamMos: marginOfSafety(grahamIv, price),
		tenCapIv: tenCap.iv,
		tenCapYield: ownerEarningsYield(tenCap.ownerEarnings, n("shares"), price),
		tenCapMos: marginOfSafety(tenCap.iv, price),
	};
}
