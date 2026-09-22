// Fields "Fetch data" (SEC EDGAR half) can auto-fill get a trailing note to
// that effect — it only ever fills a blank/zero field and the fetch result
// explains exactly what it did, but the number itself is still a best-effort
// derivation from filings, not a verified fact. See the "Where the data
// comes from" section in Help & methodology for the full picture, especially
// before trusting totDebt.
const SEC_NOTE = " Can be auto-filled via \"Fetch data\" (SEC EDGAR) — verify before relying on it.";

export const HELP_TEXT: Record<string, string> = {
	ticker: "The stock's ticker symbol. Used for labeling and to fetch the current price.",
	price: "Current market price per share, in actual dollars — never scaled. Auto-fillable via \"Fetch data\" (Yahoo Finance) — an unofficial feed that can lag the real market; verify before relying on it.",
	shares: "Diluted shares outstanding — includes the effect of options, RSUs, and convertibles." + SEC_NOTE,

	rfr: "Risk-free rate (RFR): the 10-year US Treasury yield. Used as the base return in the cost-of-equity (CAPM) calculation.",
	mrp: "Market risk premium (MRP): the extra return investors expect from stocks over the risk-free rate, typically ~5%.",
	beta: "Beta: the stock's price volatility relative to the overall market. 1.0 = moves with the market; >1.0 = more volatile. Not available from either data source here — enter it manually.",
	intExp: "Interest expense: the company's total interest paid on debt over the trailing twelve months." + SEC_NOTE,
	totDebt:
		"Total debt: all interest-bearing debt (short- and long-term) on the balance sheet. There's no single \"total debt\" figure companies file with the SEC — an auto-filled value is a best-effort sum of the closest standard tags, and depending on how a given filer tags things it can either miss some debt (understating) or bundle in lease obligations (overstating). This is the field most worth double-checking against the actual balance sheet." +
		SEC_NOTE,
	taxRate:
		"Effective tax rate: the company's actual tax rate, used for the after-tax cost of debt. Left blank by default so a fetch can fill it in — if you leave it blank and never fetch, your Settings default is used instead." +
		SEC_NOTE,
	mktCap:
		"Market capitalization: share price × total shares outstanding. Always computed live from those two fields — not an input you can override.",

	netDebt: "Net debt: total debt minus cash and cash equivalents. Subtracted from enterprise value to get equity value." + SEC_NOTE,
	growth1to5: "Expected free cash flow growth rate for years 1 through 5 of the DCF projection.",
	growth6to10: "Expected free cash flow growth rate for years 6 through 10 of the DCF projection, typically lower than years 1-5.",
	terminalGrowth: "Terminal growth rate: the perpetual growth rate assumed after year 10, used in the Gordon Growth terminal value. Should be conservative (near long-run GDP growth).",
	fcf: "Trailing twelve month free cash flow — the base year cash flow the DCF projection compounds forward from." + SEC_NOTE,

	eps: "Trailing twelve month diluted earnings per share." + SEC_NOTE,
	grahamGrowth: "Expected annual EPS growth rate over the next 7-10 years, per Graham's original formula.",
	aaaYield: "Current AAA corporate bond yield — Graham's formula scales the multiple down as this rises above its historical ~4.4% baseline.",

	ocf: "Operating cash flow over the trailing twelve months." + SEC_NOTE,
	capex: "Total capital expenditures over the trailing twelve months." + SEC_NOTE,
	mainPct: "Maintenance capex %: the share of total capex that merely sustains the existing business (vs. funding growth). Used to isolate owner earnings.",
};
