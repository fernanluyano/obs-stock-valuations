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

export function calcWacc(i: WaccInputs): number {
	const costOfEquity = i.rfr + i.beta * i.mrp; // CAPM
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
