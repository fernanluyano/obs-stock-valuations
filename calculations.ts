// Direct ports of the Excel VBA macros (WACC, ValDcf, GrahamIV, 10 Cap).
// All rates are decimals (e.g. 0.05 = 5%), all money values share one currency unit.

export interface WaccInputs {
	rfr: number; // risk-free rate (10-year Treasury yield)
	mrp: number; // market risk premium
	beta: number; // stock's price volatility vs. the market
	intExp: number; // interest expense
	totDebt: number; // total debt
	taxRate: number; // effective tax rate
	mktCap: number; // market capitalization
}

// CAPM. Exposed on its own (not just inside calcWacc) because the DDM
// discounts at cost of equity, not WACC — dividends go to shareholders only.
export function calcCostOfEquity(rfr: number, beta: number, mrp: number): number {
	return rfr + beta * mrp;
}

export function calcWacc(i: WaccInputs): number {
	const costOfEquity = calcCostOfEquity(i.rfr, i.beta, i.mrp);
	const costOfDebt = i.totDebt === 0 ? 0 : i.intExp / i.totDebt;
	const afterTaxCostOfDebt = costOfDebt * (1 - i.taxRate);

	const totalValue = i.mktCap + i.totDebt;
	const equityWeight = totalValue === 0 ? 0 : i.mktCap / totalValue;
	const debtWeight = totalValue === 0 ? 0 : i.totDebt / totalValue;

	return equityWeight * costOfEquity + debtWeight * afterTaxCostOfDebt;
}

export interface DcfInputs {
	netDebt: number;
	shares: number; // diluted shares outstanding
	growth1to5: number; // FCF growth rate, years 1-5
	growth6to10: number; // FCF growth rate, years 6-10
	terminalGrowth: number; // terminal growth rate, used past year 10
	wacc: number; // discount rate
	fcf: number; // trailing twelve month free cash flow (base year)
}

export function calcDcf(i: DcfInputs): number {
	let prevFcf = i.fcf;
	let sumPv = 0;
	let yearFcf = i.fcf;

	for (let year = 1; year <= 10; year++) {
		const g = year <= 5 ? i.growth1to5 : i.growth6to10;
		yearFcf = prevFcf * (1 + g); // compounds off prior year's FCF
		const pv = yearFcf / Math.pow(1 + i.wacc, year); // discount back to today
		sumPv += pv;
		prevFcf = yearFcf;
	}

	// Gordon growth terminal value, off Year 10 FCF
	const terminalValue = (yearFcf * (1 + i.terminalGrowth)) / (i.wacc - i.terminalGrowth);
	const pvTerminalValue = terminalValue / Math.pow(1 + i.wacc, 10);

	const enterpriseValue = sumPv + pvTerminalValue;
	const equityValue = enterpriseValue - i.netDebt;

	return i.shares === 0 ? NaN : equityValue / i.shares;
}

// Solves for one flat growth rate applied to both years 1-5 and years 6-10
// (the classic reverse-DCF convention — see e.g. Mauboussin's Expectations
// Investing), holding terminal growth/WACC/net debt/shares/FCF at the form's
// values. growth1to5 and growth6to10 on `inputs` are both overwritten by the
// solve; only the other fields matter.
export function calcImpliedGrowth(inputs: DcfInputs, price: number, lo = -0.5, hi = 1.0, tolerance = 1e-6): number {
	const f = (g: number) => calcDcf({ ...inputs, growth1to5: g, growth6to10: g }) - price;

	if (f(lo) > 0 || f(hi) < 0) return NaN;

	for (let i = 0; i < 100; i++) {
		const mid = (lo + hi) / 2;
		const fm = f(mid);
		if (Math.abs(fm) < tolerance) return mid;
		if (fm > 0) hi = mid;
		else lo = mid;
	}
	return (lo + hi) / 2;
}

// Fixed, recognizable round-number axes for the DCF sensitivity grid —
// deliberately not centered on whatever the user happens to have typed, so
// the grid reads as "the plausible range for any stock" rather than a tight
// epsilon band around one number.
export const DCF_GRID_WACC_VALUES = [0.06, 0.08, 0.1, 0.12, 0.15];
export const DCF_GRID_GROWTH_VALUES = [0, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2];

export interface DcfGrid {
	waccValues: number[];
	growthValues: number[]; // growth1to5, one row per value
	// grid[rowIdx][colIdx] = calcDcf(...) fair value for that (growth, wacc)
	// pair, holding growth6to10/terminalGrowth/netDebt/shares/fcf at inputs'
	// current values. null where wacc <= terminalGrowth (calcDcf's terminal
	// value divides by that difference).
	grid: (number | null)[][];
}

// 2D sensitivity read on the two inputs calcDcf is most exposed to: the
// discount rate and the near-term growth assumption. growth6to10 and
// terminalGrowth stay fixed at their current form values.
export function calcDcfGrid(
	inputs: DcfInputs,
	waccValues: number[] = DCF_GRID_WACC_VALUES,
	growthValues: number[] = DCF_GRID_GROWTH_VALUES
): DcfGrid {
	const grid = growthValues.map((g) =>
		waccValues.map((w) => {
			if (w <= inputs.terminalGrowth) return null;
			return calcDcf({ ...inputs, growth1to5: g, wacc: w });
		})
	);
	return { waccValues, growthValues, grid };
}

export interface GrahamInputs {
	eps: number; // trailing twelve month diluted EPS
	growth: number; // expected annual EPS growth over next 7-10 years
	aaaYield: number; // current AAA corporate bond yield
}

const GRAHAM_BASE_PE = 8.5; // base P/E for a no-growth company
const GRAHAM_BASE_YIELD = 4.4; // avg AAA bond yield when Graham calibrated the formula

export function calcGraham(i: GrahamInputs): number {
	const gPct = i.growth * 100;
	const yPct = i.aaaYield * 100;

	if (yPct <= 0) return NaN;

	return (i.eps * (GRAHAM_BASE_PE + 2 * gPct) * GRAHAM_BASE_YIELD) / yPct;
}

// Fixed, recognizable round-number axes for the Graham sensitivity grid —
// same reasoning as DCF_GRID_*: a plausible range for any stock, not an
// epsilon band around whatever's currently typed.
export const GRAHAM_GRID_YIELD_VALUES = [0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06];
export const GRAHAM_GRID_GROWTH_VALUES = [0, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2];

export interface GrahamGrid {
	yieldValues: number[];
	growthValues: number[]; // one row per value
	// grid[rowIdx][colIdx] = calcGraham(...) fair value for that (growth,
	// yield) pair, holding eps at inputs' current value. null where yield <= 0
	// (calcGraham's own guard — never hit with the default axis, only if a
	// caller passes a custom yieldValues array).
	grid: (number | null)[][];
}

// 2D sensitivity read on Graham's two judgment-call inputs — eps is a fact,
// not an assumption, so it stays fixed at its current form value.
export function calcGrahamGrid(
	inputs: GrahamInputs,
	yieldValues: number[] = GRAHAM_GRID_YIELD_VALUES,
	growthValues: number[] = GRAHAM_GRID_GROWTH_VALUES
): GrahamGrid {
	const grid = growthValues.map((g) =>
		yieldValues.map((y) => {
			if (y <= 0) return null;
			return calcGraham({ ...inputs, growth: g, aaaYield: y });
		})
	);
	return { yieldValues, growthValues, grid };
}

export interface TenCapInputs {
	ocf: number; // operating cash flow
	capex: number; // capital expenditures
	mainPct: number; // maintenance capex as a % of total capex
	shares: number; // diluted shares outstanding
}

export interface TenCapResult {
	ownerEarnings: number;
	iv: number; // intrinsic value per share
}

export function calcTenCap(i: TenCapInputs): TenCapResult {
	const ownerEarnings = i.ocf - i.capex * i.mainPct;
	const iv = i.shares === 0 ? NaN : (ownerEarnings / i.shares) * 10;
	return { ownerEarnings, iv };
}

// Fixed axis for the maintenance-capex split — it's a share of total capex,
// so 0-100% is a real, universal bound (unlike capex itself, see below).
export const TEN_CAP_GRID_MAIN_PCT_VALUES = [0, 0.2, 0.4, 0.6, 0.8, 1];

// Capex has no universal round-number range the way a rate does — a $10M
// company and a $10B company need completely different absolute axes — so
// this grid varies it as a multiplier on the ticker's own reported capex
// instead (1 = reported capex, unchanged).
export const TEN_CAP_GRID_CAPEX_MULTIPLIERS = [0.6, 0.8, 1, 1.2, 1.4];

export interface TenCapGrid {
	capexMultipliers: number[];
	mainPctValues: number[]; // one row per value
	// grid[rowIdx][colIdx] = calcTenCap(...).iv for that (mainPct, capex
	// multiplier) pair, holding ocf/shares at inputs' current values. No
	// invalid-combination guard here (unlike the DCF/Graham grids) — every
	// (mainPct, multiplier) pair is a valid input to calcTenCap.
	grid: number[][];
}

// 2D sensitivity read on Ten Cap's real judgment call (the maintenance-capex
// split) crossed with how much reported capex itself might swing — capex is
// a fact today, but a noisy one (lumpy one-off projects, M&A), and it feeds
// straight into owner earnings alongside the maintenance-% guess.
export function calcTenCapGrid(
	inputs: TenCapInputs,
	capexMultipliers: number[] = TEN_CAP_GRID_CAPEX_MULTIPLIERS,
	mainPctValues: number[] = TEN_CAP_GRID_MAIN_PCT_VALUES
): TenCapGrid {
	const grid = mainPctValues.map((mainPct) =>
		capexMultipliers.map((mult) => calcTenCap({ ...inputs, capex: inputs.capex * mult, mainPct }).iv)
	);
	return { capexMultipliers, mainPctValues, grid };
}

export interface DdmInputs {
	dps: number; // trailing twelve month dividends per share (D0)
	growth: number; // expected dividend growth rate, held constant forever
	costOfEquity: number; // ke, the discount rate
}

// Gordon Growth dividend discount model: D1 / (ke − g), with D1 = D0 × (1+g).
// NaN for a non-payer (D0 ≤ 0) — the model has nothing to value — and when
// g ≥ ke, where the formula stops meaning anything (infinite or negative).
export function calcDdm(i: DdmInputs): number {
	if (!(i.dps > 0)) return NaN;
	if (i.growth >= i.costOfEquity) return NaN;
	return (i.dps * (1 + i.growth)) / (i.costOfEquity - i.growth);
}

// Fixed, recognizable round-number axes for the DDM sensitivity grid — same
// reasoning as DCF_GRID_*. The axes overlap on purpose: cells where g ≥ ke
// show as "—", which itself shows where the model breaks down.
export const DDM_GRID_KE_VALUES = [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12];
export const DDM_GRID_GROWTH_VALUES = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08];

export interface DdmGrid {
	keValues: number[];
	growthValues: number[]; // one row per value
	// grid[rowIdx][colIdx] = calcDdm(...) fair value for that (growth, ke)
	// pair, holding dps at inputs' current value. null wherever calcDdm has
	// no answer — g ≥ ke, or a non-payer (every cell).
	grid: (number | null)[][];
}

// 2D sensitivity read on the DDM's two judgment calls: the discount rate and
// the perpetual dividend growth rate. dps is a fact, so it stays fixed.
export function calcDdmGrid(
	inputs: DdmInputs,
	keValues: number[] = DDM_GRID_KE_VALUES,
	growthValues: number[] = DDM_GRID_GROWTH_VALUES
): DdmGrid {
	const grid = growthValues.map((g) =>
		keValues.map((ke) => {
			const v = calcDdm({ ...inputs, growth: g, costOfEquity: ke });
			return isNaN(v) ? null : v;
		})
	);
	return { keValues, growthValues, grid };
}

// Whether a method has an intrinsic value worth showing anything more for
// (e.g. a sensitivity grid) — true if any of the given IVs (typically one per
// scenario) is a real, non-zero number. 0 counts as "nothing entered": a
// blank form computes $0 for Graham (EPS 0), Ten Cap (no cash flow), etc.
export function hasIntrinsicValue(ivs: number[]): boolean {
	return ivs.some((v) => isFinite(v) && v !== 0);
}

// Margin of safety: how far below intrinsic value the current price trades, as a %.
export function marginOfSafety(intrinsicValue: number, price: number): number {
	if (!isFinite(intrinsicValue) || intrinsicValue === 0) return NaN;
	return ((intrinsicValue - price) / intrinsicValue) * 100;
}

// Owner-earnings yield at the current price (used alongside Ten Cap's IV).
export function ownerEarningsYield(ownerEarnings: number, shares: number, price: number): number {
	if (shares === 0 || price === 0) return NaN;
	return (ownerEarnings / shares / price) * 100;
}

export interface PaybackInputs {
	fcf: number; // trailing twelve month free cash flow (base year)
	growth1to5: number; // FCF growth rate, years 1-5
	growth6to10: number; // FCF growth rate, years 6-10
	terminalGrowth: number; // FCF growth rate past year 10
	mktCap: number;
	netDebt: number;
}

// Past this, "how many years" stops being a meaningful answer — reported as
// Infinity (shown as "> 30 yrs") rather than looping toward a huge number.
export const PAYBACK_MAX_YEARS = 30;

// Payback color bands. 8 is Phil Town's own buy rule. 10 isn't Town's
// payback rule but his Ten Cap one — 10x owner earnings is a 10-year payback
// at zero growth — and also where the DCF's explicit 10-year projection
// hands off to terminal growth, so a payback past it leans on cash the
// growth inputs never actually forecast.
export const PAYBACK_GOOD_YEARS = 8;
export const PAYBACK_OK_YEARS = 10;

export type PaybackTone = "pos" | "warn" | "neg";

// null when there's no payback to judge (FCF ≤ 0); Infinity (never within
// PAYBACK_MAX_YEARS) is just a very long payback, so "neg".
export function paybackTone(years: number): PaybackTone | null {
	if (isNaN(years)) return null;
	if (years <= PAYBACK_GOOD_YEARS) return "pos";
	if (years <= PAYBACK_OK_YEARS) return "warn";
	return "neg";
}

// Phil Town's Payback Time: years of growing FCF it takes to add up to what
// buying the whole business costs today. Undiscounted by design (that's the
// method), but measured against enterprise value (market cap + net debt)
// rather than Town's market cap alone, so debt you'd also be taking on isn't
// ignored. Growth follows the DCF's own stages year by year — g1-5, then
// g6-10, then terminal growth — so it stays consistent with the DCF and gets
// a value per scenario. The final, partial year is interpolated linearly
// (cash assumed to arrive evenly through the year). NaN when base FCF isn't
// positive (no payback to speak of); 0 when EV is already ≤ 0 (net cash
// covers the market cap).
export function calcPaybackTime(i: PaybackInputs): number {
	if (!(i.fcf > 0)) return NaN;
	const target = i.mktCap + i.netDebt;
	if (target <= 0) return 0;

	let cumulative = 0;
	let yearFcf = i.fcf;
	for (let year = 1; year <= PAYBACK_MAX_YEARS; year++) {
		const g = year <= 5 ? i.growth1to5 : year <= 10 ? i.growth6to10 : i.terminalGrowth;
		yearFcf *= 1 + g;
		if (yearFcf > 0 && cumulative + yearFcf >= target) {
			return year - 1 + (target - cumulative) / yearFcf;
		}
		cumulative += yearFcf;
	}
	return Infinity;
}
