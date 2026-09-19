export const HELP_TEXT: Record<string, string> = {
	ticker: "The stock's ticker symbol. Used for labeling and to fetch the current price.",
	price: "Current market price per share, in actual dollars — never scaled.",
	shares: "Diluted shares outstanding — includes the effect of options, RSUs, and convertibles.",

	rfr: "Risk-free rate (RFR): the 10-year US Treasury yield. Used as the base return in the cost-of-equity (CAPM) calculation.",
	mrp: "Market risk premium (MRP): the extra return investors expect from stocks over the risk-free rate, typically ~5%.",
	beta: "Beta: the stock's price volatility relative to the overall market. 1.0 = moves with the market; >1.0 = more volatile.",
	intExp: "Interest expense: the company's total interest paid on debt over the trailing twelve months.",
	totDebt: "Total debt: all interest-bearing debt (short- and long-term) on the balance sheet.",
	taxRate: "Effective tax rate: the company's actual tax rate, used for the after-tax cost of debt.",
	mktCap: "Market capitalization: share price × total shares outstanding.",

	netDebt: "Net debt: total debt minus cash and cash equivalents. Subtracted from enterprise value to get equity value.",
	growth1to5: "Expected free cash flow growth rate for years 1 through 5 of the DCF projection.",
	growth6to10: "Expected free cash flow growth rate for years 6 through 10 of the DCF projection, typically lower than years 1-5.",
	terminalGrowth: "Terminal growth rate: the perpetual growth rate assumed after year 10, used in the Gordon Growth terminal value. Should be conservative (near long-run GDP growth).",
	fcf: "Trailing twelve month free cash flow — the base year cash flow the DCF projection compounds forward from.",

	eps: "Trailing twelve month diluted earnings per share.",
	grahamGrowth: "Expected annual EPS growth rate over the next 7-10 years, per Graham's original formula.",
	aaaYield: "Current AAA corporate bond yield — Graham's formula scales the multiple down as this rises above its historical ~4.4% baseline.",

	ocf: "Operating cash flow over the trailing twelve months.",
	capex: "Total capital expenditures over the trailing twelve months.",
	mainPct: "Maintenance capex %: the share of total capex that merely sustains the existing business (vs. funding growth). Used to isolate owner earnings.",
};
