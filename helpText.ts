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

	rfr: "Risk-free rate (RFR): the 10-year US Treasury yield. Pre-filled from a cached Yahoo Finance (^TNX) quote (refreshed at most once every 24 hours), and can be auto-filled via \"Fetch data\" the same as price — only into a blank/zero field, never overwriting a value you've typed. \"Refresh prices\" (the saved-valuations table button) always force-refreshes it across every saved ticker, unlike \"Fetch data\". Used as the base return in the cost-of-equity (CAPM) calculation.",
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
	impliedGrowth:
		"Reverse DCF: solves backward from today's price for the single flat FCF growth rate the market is already assuming across years 1-10, holding every other DCF input (terminal growth, WACC, net debt, shares, FCF) fixed. Judge this one number against the company's own growth history and guidance — a good gut check when forward growth/WACC assumptions feel too easy to fudge. Shows \"—\" when the current price is outside what a −50% to +100% growth range can produce.",

	eps: "Trailing twelve month diluted earnings per share." + SEC_NOTE,
	grahamGrowth: "Expected annual EPS growth rate over the next 7-10 years, per Graham's original formula.",
	aaaYield: "Current AAA corporate bond yield — Graham's formula scales the multiple down as this rises above its historical ~4.4% baseline.",

	ocf: "Operating cash flow over the trailing twelve months." + SEC_NOTE,
	capex: "Total capital expenditures over the trailing twelve months." + SEC_NOTE,
	mainPct: "Maintenance capex %: the share of total capex that merely sustains the existing business (vs. funding growth). Used to isolate owner earnings.",
	dps:
		"Dividends per share paid over the trailing twelve months, in actual dollars — never scaled. The DDM only applies to dividend payers: leave this blank or 0 for a company that doesn't pay one, and DDM shows \"—\"." +
		SEC_NOTE,
	ddmGrowth:
		"Expected dividend growth rate, held constant forever (Gordon Growth). Must be below the cost of equity — at or above it the model breaks down and DDM shows \"—\". Keep it near long-run GDP/inflation for a mature payer; the closer it gets to cost of equity, the more the value balloons.",
	costOfEquity:
		"Cost of equity (ke): CAPM, risk-free rate + beta × market risk premium — the same figure WACC blends in. The DDM discounts at this rather than WACC, since dividends go to shareholders only, not lenders.",
	paybackYears:
		"Payback Time (Phil Town): how many years of growing free cash flow it takes to add up to what buying the whole business costs today — enterprise value, i.e. market cap plus net debt. FCF compounds at this scenario's DCF growth rates year by year (years 1-5, then 6-10, then terminal growth), undiscounted. Colored green at 8 years or less (Town's buy rule), yellow over 8 up to 10 (10 is Ten Cap's zero-growth payback, and the end of the DCF's explicit forecast), red beyond that. Mostly FCF yield plus your growth assumption restated in years, so it's no independent check on the DCF. Shows \"—\" when FCF isn't positive, and \"> 30 yrs\" when it never pays back within 30 years.",

	cape: "Shiller CAPE (cyclically-adjusted P/E, aka P/E10): the S&P 500's price divided by its average inflation-adjusted earnings over the trailing 10 years, smoothing out the single-year earnings swings (recessions, write-offs) that make an ordinary trailing P/E noisy. A high reading means the market is pricey relative to a decade of normalized earnings — not necessarily overvalued outright.",
	trCape: "Total-return CAPE: the same calculation as CAPE, but with both the price and the trailing-earnings series adjusted as if dividends were reinvested. Plain CAPE is skewed by falling payout ratios over time (companies retaining more earnings instead of paying them out mechanically inflates recent earnings relative to decades ago) — TR-CAPE corrects for that, making it a fairer comparison across eras.",
	dividendYield: "S&P 500 dividend yield for the month: trailing dividends divided by the (inflation-adjusted) price level.",
	tenYearYield: "10-year US Treasury yield for the month, from Shiller's historical dataset — a monthly figure, unlike this plugin's own risk-free rate (RFR) field, which is a live daily Yahoo Finance quote.",
	realPrice: "Nominal is the S&P 500's raw index level. Real (inflation-adjusted) restates it in constant dollars by dividing out CPI, so levels from different decades are actually comparable — the gap between the two lines is inflation, not real growth. Real, not nominal, is what CAPE's own price side is computed from.",
};
