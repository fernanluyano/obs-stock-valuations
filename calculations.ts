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
