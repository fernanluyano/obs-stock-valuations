// Content for the in-plugin documentation view (view.ts: renderDocs). Kept separate
// from the UI so the formulas/sources/suitability notes can be reviewed on their own.

export interface DocSource {
	label: string;
	url: string;
}

export interface MethodDoc {
	title: string;
	formula: string;
	body: string[];
	goodFor: string;
	useCaution: string;
	sources: DocSource[];
}

export interface OtherMethod {
	title: string;
	oneLiner: string;
	url: string;
}

export interface DataSourceDoc {
	title: string;
	body: string[];
}

// Rendered near the top of the docs screen, above the per-method breakdowns —
// this plugin fetches data on the user's behalf (price and fundamentals) and
// neither source is a verified, official feed, so this exists to make sure
// that's never mistaken for ground truth.
export const DATA_SOURCES_DOC: DataSourceDoc = {
	title: "Where the data comes from",
	body: [
		"\"Fetch data\" (next to the ticker field) fills in price from Yahoo Finance and fundamentals (EPS, cash flow, debt, shares, tax rate) from SEC EDGAR in one click — but only into fields that are blank or zero; it never overwrites a value you've already typed. Market cap isn't fetched at all — it's always computed live as price × shares.",
		"Yahoo's price comes from its public chart data — free, no account or key needed, but an unofficial, undocumented endpoint. Yahoo can rate-limit it, change its format, or go down without notice, and the quote itself can lag the real market by a few minutes. Cross-check it against a price you trust before relying on it.",
		"Fundamentals come directly from a company's own filings via SEC EDGAR's XBRL data — about as authoritative as free data gets, but not a finished product. Trailing-twelve-month figures are computed from the filings (latest fiscal year + year-to-date − year-ago year-to-date), not copied verbatim. Total debt has no single tag a company is required to file — different companies tag it completely differently, and it's been the single most error-prone field in practice: some filers bundle finance/lease obligations in with it (running the total higher than \"debt\" alone), others don't use a long-term-debt tag at all and would be silently understated without a fallback. Anything that can't be derived reliably is left blank rather than guessed, but \"derived successfully\" still isn't the same as \"exactly what you'd get by reading the 10-K yourself\" — total debt above all is worth checking against the actual balance sheet. Fundamentals only cover US-listed companies that file with the SEC.",
		"Tax rate is a special case: it starts blank specifically so a fetch can fill it in with the company's real effective rate; if you never fetch and leave it blank, the WACC calculation quietly falls back to your Settings default instead.",
		"Every fetched field stays fully editable, and the confirmation message after a fetch spells out exactly what was filled, what was left as-is, and what's worth double-checking — read it. Treat anything this plugin fetches for you as a solid starting point, not a verified fact, and check it against the actual filing or price feed before using it to make a real decision.",
	],
};

export const DOCS_INTRO: string[] = [
	"This plugin runs four independent valuation methods off the same inputs. Each one encodes a different set of assumptions about how a business creates value — none of them is \"the\" right answer, and they will often disagree with each other.",
	"No method here is suitable for every company. It's on you, the user, to judge whether a given method's assumptions actually hold for the business you're valuing before you trust its output — see \"Does this method fit?\" on each one below for pointers, but the judgment call is yours to make. The most useful signal is often agreement (or disagreement) between two or three methods on a company they're each suited to, not any single number in isolation.",
];

export const METHOD_DOCS: MethodDoc[] = [
	{
		title: "WACC — discount rate",
		formula: "WACC = (E/V)×Re + (D/V)×Rd×(1−Tc)\nRe = Rfr + β×MRP   (CAPM)\nRd = IntExp/TotDebt",
		body: [
			"The weighted average cost of capital blends the cost of equity (via CAPM) and the after-tax cost of debt, weighted by market value. It isn't a standalone valuation — it's the discount rate the DCF below uses to bring future cash flows back to today's dollars.",
		],
		goodFor: "Any company with an estimable beta and a normal, disclosed capital structure.",
		useCaution: "Highly volatile or thinly-traded stocks make beta — and therefore WACC — unstable. A company with negligible debt is fine; the formula just degrades to cost of equity alone.",
		sources: [
			{ label: "WACC Guide — Wall Street Prep", url: "https://www.wallstreetprep.com/knowledge/wacc/" },
			{ label: "WACC Formula — Corporate Finance Institute", url: "https://corporatefinanceinstitute.com/resources/valuation/what-is-wacc-formula/" },
		],
	},
	{
		title: "DCF — Discounted Cash Flow",
		formula: "Years 1–10: FCFₙ = FCFₙ₋₁×(1+g)      [g1–5 for years 1–5, g6–10 for years 6–10]\nPV = Σ FCFₙ / (1+WACC)ⁿ\nTerminal value = FCF₁₀×(1+terminalGrowth) / (WACC−terminalGrowth)\nEquity value = ΣPV + PV(terminal value) − net debt",
		body: [
			"A two-stage, 10-year free cash flow projection discounted at WACC, with a Gordon Growth terminal value covering everything past year 10.",
		],
		goodFor: "High-margin, recurring-revenue businesses with a multi-year track record of positive, converting free cash flow.",
		useCaution: "Weak for companies with no single meaningful FCF figure (large financials, insurers, or diversified holding companies where cash flow is swamped by portfolio/segment movements), and for anything where growth or discount-rate assumptions do more work than the underlying cash flow — terminal value alone is typically 60–75% of the result, so a small change to either input swings the output 30–50%+. A reverse DCF (solve backward from today's price for the growth rate the market is already assuming, then judge whether that's reasonable) is a good gut check, especially on higher-multiple names.",
		sources: [
			{ label: "Discounted cash flow — Wikipedia", url: "https://en.wikipedia.org/wiki/Discounted_cash_flow" },
			{ label: "Terminal Value (DCF) — Wall Street Prep", url: "https://www.wallstreetprep.com/knowledge/terminal-value/" },
		],
	},
	{
		title: "Graham Formula",
		formula: "V = EPS × (8.5 + 2g) × 4.4 / Y",
		body: [
			"Benjamin Graham's revised (1974) intrinsic value formula. 8.5 is Graham's base P/E for a no-growth company, 2g adds a multiple for expected EPS growth, and the 4.4/Y term scales the whole thing against today's AAA corporate bond yield relative to the ~4.4% average yield when Graham calibrated it.",
			"Graham himself described this as illustrative of how unrealistic market growth expectations tend to be, not as a formula to rely on literally — worth keeping in mind before treating its output as gospel. Most modern value investors treat it as a rough sanity-check ceiling rather than a primary number.",
		],
		goodFor: "Stable, moderate-growth businesses with EPS that genuinely reflects operating performance year to year, and a growth estimate realistically in the single digits to low teens.",
		useCaution: "Breaks down for companies with negative, erratic, or otherwise noisy GAAP EPS (e.g. large mark-to-market swings from an investment portfolio, or other one-offs) — the formula is linear in EPS, so noisy input means noisy output. Also weak wherever a realistic growth rate is well above what the formula was calibrated for (it wasn't built for 20%+ growth assumptions).",
		sources: [
			{ label: "Understanding The Benjamin Graham Formula Correctly — GrahamValue", url: "https://www.grahamvalue.com/article/understanding-benjamin-graham-formula-correctly" },
			{ label: "Benjamin Graham's Updated Intrinsic Value Formula — GrahamValue", url: "https://www.grahamvalue.com/blog/benjamin-grahams-updated-intrinsic-value-formula" },
		],
	},
	{
		title: "Ten Cap — owner earnings",
		formula: "Owner earnings = OCF − (CapEx × maintenance %)\nIV = (owner earnings / shares) × 10\nYield = owner earnings / shares / price",
		body: [
			"\"Owner earnings\" — cash the business could pay out without harming its competitive position — traces back to Warren Buffett's 1986 Berkshire Hathaway shareholder letter, which defined it as reported earnings plus non-cash charges, minus the capex needed to maintain (not grow) the business. This plugin approximates that as operating cash flow minus maintenance capex, the common practical proxy since OCF already nets out most non-cash charges and working-capital movement.",
			"The 10x multiple (a 10% required return, hence \"Ten Cap\") and the framing of this as a standalone method both come from Phil Town's Rule #1 investing framework, built on top of the owner earnings concept. Mechanically it's close to an FCF yield with a fixed 10% hurdle rate.",
		],
		goodFor: "Low-maintenance-capex, high owner-earnings-conversion businesses, where \"maintenance vs. growth capex\" is a clean, separable concept.",
		useCaution: "The maintenance-capex % is inherently a guess for most companies — it's rarely broken out in filings — and a wrong guess feeds straight into the output. Weak for conglomerates with no single owner-earnings figure, and for capital-intensive or R&D-heavy businesses where maintenance vs. growth capex is more judgment call than clean split, or where a 10% required return isn't realistic to begin with.",
		sources: [
			{ label: "How to Value Companies Using the 10 Cap Stock Valuation Method — StableBread", url: "https://stablebread.com/how-to-value-companies-using-the-10-cap-stock-valuation-method/" },
			{ label: "Chairman's Letter 1986 — Berkshire Hathaway", url: "https://www.berkshirehathaway.com/letters/1986.html" },
			{ label: "Owner earnings — Wikipedia", url: "https://en.wikipedia.org/wiki/Owner_earnings" },
		],
	},
];

export const DOCS_OTHER_INTRO: string =
	"This plugin only computes the four methods above. If a company doesn't fit any of them well — most commonly conglomerates/holding companies, financials and insurers, or non-dividend payers being judged on distributions — these are the standard next tools, worth doing by hand:";

export const OTHER_METHODS: OtherMethod[] = [
	{
		title: "Dividend Discount Model (DDM / Gordon Growth)",
		oneLiner: "Values a stock as the present value of future dividends: V = D₁ / (r − g). Needs a long, stable dividend history that genuinely reflects distributable earnings — fits mature dividend payers (utilities, staples, mature banks), not growth companies or non-payers.",
		url: "https://en.wikipedia.org/wiki/Dividend_discount_model",
	},
	{
		title: "Earnings Power Value (EPV)",
		oneLiner: "EPV = Adjusted NOPAT / WACC. Values the business as if current earnings simply continue forever with zero growth — a floor/sanity check, not a growth valuation. Useful for mature, moderate-growth businesses; radically undervalues anything whose thesis depends on expanding earnings power.",
		url: "https://stablebread.com/earnings-power-value/",
	},
	{
		title: "Residual Income Model (RIM)",
		oneLiner: "Values equity as book value plus the present value of future excess returns: (ROE − cost of equity) × book value. Fits businesses where book value is a real, meaningful measure of capital employed — banks, insurers — and falls apart where book value is mostly intangibles.",
		url: "https://en.wikipedia.org/wiki/Residual_income_valuation",
	},
	{
		title: "Net Asset Value (NAV) / Book Value Multiple",
		oneLiner: "Values the company at its net assets, or a multiple of book value calibrated to historical trading ranges. Needs a balance sheet where the assets are real and marked-to-market — financials, insurers, holding companies, REITs — not intangible-heavy operating companies.",
		url: "https://en.wikipedia.org/wiki/Book_value",
	},
	{
		title: "Sum-of-the-Parts (SOTP)",
		oneLiner: "Values each business segment separately with whichever method fits that segment, then adds them up and adjusts for net debt/holding-company discount. Needs genuinely distinct segments the market would value differently as standalone businesses — the standard approach for conglomerates.",
		url: "https://www.investopedia.com/terms/s/sumofpartsvaluation.asp",
	},
	{
		title: "Comparable Company Analysis (relative valuation)",
		oneLiner: "Applies peer-average multiples (P/E, EV/EBITDA, P/S, P/FCF) to a company's own financials. Needs a set of genuinely comparable public peers — arguably the most-used method in day-to-day practice, but only as good as the comp set.",
		url: "https://en.wikipedia.org/wiki/Relative_valuation",
	},
];
