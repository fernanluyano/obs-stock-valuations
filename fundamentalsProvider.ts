// Pulls per-stock fundamentals (EPS, cash flow, debt, shares, tax rate) from the
// SEC's EDGAR XBRL API — the official, free, key-less source for figures a US
// public company has actually filed. It does NOT provide price, beta, or market
// cap; those stay with priceProvider.ts / manual entry.
//
// This file is split into two halves on purpose:
//   - Pure derivation functions (pickConceptFacts, latestInstant, computeTtm,
//     deriveFundamentals, ...) take already-fetched JSON and contain all the
//     actual logic. They're deterministic and fully unit tested.
//   - A thin I/O layer (resolveCik, fetchCompanyFactsJson, fetchFundamentals)
//     that calls Obsidian's requestUrl (works on desktop and mobile, unlike a
//     browser fetch()) and wires the pure functions together.
//
// Every derived field carries its own `note` explaining exactly what was
// computed and from which filings — never a silent guess. A field that can't
// be derived reliably comes back with value: null and a note explaining why,
// rather than a fabricated number.
//
// Deliberately no `import ... from "obsidian"` anywhere in this file, not
// even a dynamic one: Obsidian's package ships type declarations only (no
// runtime JS), and Vite's dependency scanner tries to eagerly resolve it —
// even behind a call-time dynamic import — which breaks `vitest` for every
// test in this file, including ones that never touch the network. Instead,
// every function here talks to a small injectable HttpGet interface. The one
// real implementation (secHttpGet, wrapping Obsidian's requestUrl) lives in
// secHttp.ts, which this file never imports; the view passes it in.

// ---------------------------------------------------------------------------
// Raw SEC XBRL shapes (the subset of https://data.sec.gov/api/xbrl/companyfacts
// we actually read). A "duration" fact has both start and end (covers a
// period — a quarter, a half-year YTD, a fiscal year); an "instant" fact has
// only end (a balance-sheet snapshot).
// ---------------------------------------------------------------------------

export interface SecFact {
	start?: string; // ISO date; present only for duration facts
	end: string; // ISO date
	val: number;
	fy: number;
	fp: string; // "FY" | "Q1" | "Q2" | "Q3" | "Q4"
	form: string; // "10-K" | "10-Q" | ...
	filed: string; // ISO date the filing containing this fact was filed
}

export interface SecConcept {
	label?: string;
	units: Record<string, SecFact[]>;
}

export interface SecCompanyFacts {
	cik: number;
	entityName: string;
	facts: {
		"us-gaap"?: Record<string, SecConcept>;
		dei?: Record<string, SecConcept>;
	};
}

// ---------------------------------------------------------------------------
// Derived field result — always populated, even on failure, so the caller
// never has to guess why a value is missing.
// ---------------------------------------------------------------------------

export type FieldBasis = "ttm" | "fiscal-year" | "instant" | "derived";

export interface FieldResult {
	value: number | null;
	basis: FieldBasis | null;
	asOf: string | null; // the fact's `end` date the value is as-of
	note: string; // provenance on success, reason on failure — always non-empty
}

export interface FundamentalsResult {
	ticker: string;
	cik: string;
	entityName: string;
	eps: FieldResult; // TTM diluted EPS, $/share
	ocf: FieldResult; // TTM operating cash flow, $
	capex: FieldResult; // TTM capital expenditures, $
	fcf: FieldResult; // TTM free cash flow (ocf - capex), $
	intExp: FieldResult; // TTM interest expense, $
	shares: FieldResult; // most recent diluted weighted-average share count
	totDebt: FieldResult; // most recent long-term debt (noncurrent + current), $
	netDebt: FieldResult; // totDebt - cash, $
	taxRate: FieldResult; // TTM effective tax rate, as a decimal fraction (0.21 = 21%)
}

export interface FundamentalsError {
	kind: "not-found" | "network" | "no-data";
	message: string; // user-presentable as-is
}

// Above this age, a resolved value is more likely to mislead than help —
// e.g. Berkshire Hathaway's EPS and shares outstanding are only ever tagged
// with a required Class A/B dimension that SEC's companyfacts API doesn't
// expose at all, so the "most recent" fact this plugin can see for those
// concepts is genuinely from 2015. Silently presenting that as if current
// would be worse than not resolving it at all, so every field gets this
// check applied (see withStaleWarning) rather than just debt/shares.
const STALE_THRESHOLD_DAYS = 730; // ~2 years

function missing(note: string): FieldResult {
	return { value: null, basis: null, asOf: null, note };
}

// ---------------------------------------------------------------------------
// XBRL tag fallback chains. Kept short and deliberately conservative — each
// fallback is a genuine synonym filers use for the same concept, not a
// broader concept that would silently change what's being measured (e.g. we
// don't fall back capex to a tag that also includes intangible purchases).
// ---------------------------------------------------------------------------

const TAGS = {
	// Diluted and basic are kept as separate tag lists, not one fallback
	// chain, because — unlike the debt/cash synonyms below — basic and
	// diluted are genuinely different figures. deriveFundamentals resolves
	// diluted first and only falls back to basic when a filer (e.g. Berkshire
	// Hathaway, which reports EarningsPerShareBasic only) doesn't tag a
	// diluted figure at all, and always discloses in the field's note when
	// that fallback happened.
	epsDiluted: ["EarningsPerShareDiluted"],
	epsBasic: ["EarningsPerShareBasic"],
	ocf: [
		"NetCashProvidedByUsedInOperatingActivities",
		"NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
	],
	capex: ["PaymentsToAcquirePropertyPlantAndEquipment"],
	interestExpense: ["InterestExpense", "InterestExpenseDebt"],
	dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
	basicShares: ["WeightedAverageNumberOfSharesOutstandingBasic"],
	// Ordered from narrowest/purest concept to broadest, each only reached if
	// the filer doesn't use anything earlier in the list:
	//   - LongTermDebtNoncurrent / LongTermDebt: pure long-term debt,
	//     explicitly excludes lease obligations (both confirmed via their
	//     official XBRL definitions).
	//   - LongTermDebtAndCapitalLeaseObligations: confirmed via its official
	//     definition to be noncurrent-only (safe to sum with a current-portion
	//     tag without double-counting), but it bundles in finance/capital
	//     lease obligations — so it can run higher than "pure" debt. Boston
	//     Scientific's real filings report noncurrent debt exclusively under
	//     this tag; without it, every dollar of their long-term debt (~$10.9B)
	//     was silently invisible to this plugin.
	//   - ConvertibleLongTermNotesPayable: confirmed noncurrent-only via its
	//     official definition. Check Point's real filings report their $1.97B
	//     convertible note under this tag rather than any of the above.
	longTermDebtNoncurrent: [
		"LongTermDebtNoncurrent",
		"LongTermDebt",
		"LongTermDebtAndCapitalLeaseObligations",
		"ConvertibleLongTermNotesPayable",
	],
	// DebtCurrent is last on purpose: its official definition ("short-term
	// debt AND current maturity of long-term debt... due within one year")
	// is broader than the other two, so it's only reached for filers who
	// don't use the more specific long-term-debt tags at all — confirmed
	// against Accenture's real filings, which report debt exclusively under
	// this tag and have no LongTermDebtNoncurrent/Current tag whatsoever.
	longTermDebtCurrent: ["LongTermDebtCurrent", "LongTermDebtCurrentMaturities", "DebtCurrent"],
	cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
	pretaxIncome: [
		"IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
		"IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
	],
	taxExpense: ["IncomeTaxExpenseBenefit"],
} as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// SEC pads CIKs to 10 digits in URLs (CIK0000320193) but the companyfacts
// payload's own `cik` field is an unpadded number — normalize both call
// sites through this so `FundamentalsResult.cik` is always the same shape.
export function padCik(raw: number | string): string {
	return String(raw).padStart(10, "0");
}

// Picks whichever tag in the fallback chain the filer is *currently* using —
// not just the first one in the list that has any data at all. Companies
// sometimes abandon an XBRL tag for a newer synonym (e.g. Boston Scientific
// stopped reporting LongTermDebtCurrent in 2017 and reports DebtCurrent
// instead today); naively taking the first non-empty tag would silently lock
// onto that filer's frozen, years-stale figure under the old tag and never
// even look at the one they actually report now. Comparing each candidate
// tag's own most-recent `end` date and keeping the freshest one fixes that,
// while still returning a single tag's full history (never a blend of two
// tags), so computeTtm's FY/YTD-current/YTD-prior math stays internally
// consistent — it never mixes figures from two differently-defined tags.
export function pickConceptFacts(
	concepts: Record<string, SecConcept> | undefined,
	tags: readonly string[],
	unit: string
): SecFact[] | null {
	if (!concepts) return null;
	let best: SecFact[] | null = null;
	let bestLatestEnd = "";
	for (const tag of tags) {
		const facts = concepts[tag]?.units[unit];
		if (!facts || facts.length === 0) continue;
		const latestEnd = facts.reduce((max, f) => (f.end > max ? f.end : max), "");
		if (latestEnd > bestLatestEnd) {
			bestLatestEnd = latestEnd;
			best = facts;
		}
	}
	return best;
}

// Same (start, end) period can appear multiple times across filings (e.g. a
// prior quarter re-reported as a comparative in a later 10-Q). Keep only the
// most recently filed version of each period.
function dedupeByPeriod(facts: SecFact[]): SecFact[] {
	const byPeriod = new Map<string, SecFact>();
	for (const f of facts) {
		const key = `${f.start ?? ""}|${f.end}`;
		const existing = byPeriod.get(key);
		if (!existing || f.filed > existing.filed) byPeriod.set(key, f);
	}
	return [...byPeriod.values()];
}

const MS_PER_DAY = 86_400_000;
function daysBetween(a: string, b: string): number {
	return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / MS_PER_DAY;
}
function durationDays(f: SecFact): number {
	return f.start ? daysBetween(f.start, f.end) : 0;
}

// Most recent balance-sheet snapshot for an instant concept (debt, cash,
// shares outstanding as reported on the cover page).
export function latestInstant(facts: SecFact[] | null): SecFact | null {
	if (!facts) return null;
	const instants = dedupeByPeriod(facts.filter((f) => f.start === undefined));
	if (instants.length === 0) return null;
	return instants.reduce((a, b) => (a.end >= b.end ? a : b));
}

// Most recently reported value for a duration concept, whatever period it
// covers — used for the diluted share count, which we don't TTM-sum (it's a
// count, not a flow), just want the freshest reported figure for.
export function latestDuration(facts: SecFact[] | null): SecFact | null {
	if (!facts) return null;
	const durations = dedupeByPeriod(facts.filter((f) => f.start !== undefined));
	if (durations.length === 0) return null;
	return durations.reduce((a, b) => (a.end >= b.end ? a : b));
}

// Latest fiscal-year value for a duration concept, deliberately *not* rolled
// forward into a TTM the way computeTtm below does. Used only for effective
// tax rate: unlike revenue, cash flow, or EPS, tax expense is often lumpy —
// a single quarter's discrete item (a settlement, a valuation-allowance
// release, a one-time stock-comp windfall) can swing a TTM-blended ratio far
// from the company's real run rate, which is exactly the smoothing a TTM
// rollforward is supposed to provide for a dollar figure but instead
// amplifies for a ratio. Confirmed against Boston Scientific's real
// filings: a one-time Q1 2026 tax benefit drove the TTM-rolled effective
// rate to ~5%, while every external source (and their own latest 10-K)
// reports ~14.6% — the latest-fiscal-year figure this function returns.
export function latestFiscalYear(facts: SecFact[] | null): FieldResult {
	if (!facts) return missing("No matching XBRL tag reported by this filer.");
	const durationFacts = dedupeByPeriod(facts.filter((f) => f.start !== undefined));
	const fyFacts = durationFacts.filter((f) => durationDays(f) >= 340 && durationDays(f) <= 390);
	if (fyFacts.length === 0) {
		return missing("No fiscal-year-length filing found for this tag.");
	}
	const latestFy = fyFacts.reduce((a, b) => (a.end >= b.end ? a : b));
	return {
		value: latestFy.val,
		basis: "fiscal-year",
		asOf: latestFy.end,
		note: `Latest fiscal year (FY${latestFy.fy}, ended ${latestFy.end}).`,
	};
}

// Trailing-twelve-month value for a flow concept (EPS, OCF, capex, interest
// expense, ...), computed the way analysts reconcile 10-K/10-Q data:
//
//   TTM = latest fiscal year + current year-to-date − year-ago year-to-date
//
// This works whether a filer reports discrete quarters or, as SEC filers
// commonly do for cash-flow-statement lines, only cumulative year-to-date
// figures each quarter (a 10-Q's cash flow statement shows YTD columns, not
// a discrete-quarter column) — the algebra is the same either way, since
// FY = Q1+Q2+Q3+Q4 and YTD figures are just partial sums of the same
// quarters. If the year-ago YTD period can't be matched, we fall back to the
// latest fiscal year alone rather than compute a number we can't stand
// behind.
export function computeTtm(facts: SecFact[] | null): FieldResult {
	if (!facts) return missing("No matching XBRL tag reported by this filer.");

	const durationFacts = dedupeByPeriod(facts.filter((f) => f.start !== undefined));
	if (durationFacts.length === 0) {
		return missing("Tag exists but has no period (duration) data — only instant snapshots.");
	}

	// A fiscal year is ~365 days; allow slack for 52/53-week fiscal calendars.
	const fyFacts = durationFacts.filter((f) => durationDays(f) >= 340 && durationDays(f) <= 390).sort((a, b) => (a.end < b.end ? 1 : -1));
	if (fyFacts.length === 0) {
		return missing("No fiscal-year-length filing found for this tag — can't establish a TTM baseline.");
	}
	const latestFy = fyFacts[0];

	const afterFy = durationFacts.filter((f) => f.start! > latestFy.end);
	if (afterFy.length === 0) {
		return {
			value: latestFy.val,
			basis: "fiscal-year",
			asOf: latestFy.end,
			note: `Latest fiscal year (FY${latestFy.fy}, ended ${latestFy.end}) — no more recent interim filing available.`,
		};
	}

	// The current YTD candidate is the longest period after the last fiscal
	// year end (so a cumulative Q2 YTD figure wins over a coincidental
	// discrete quarter that happens to share the same end date).
	afterFy.sort((a, b) => {
		if (a.end !== b.end) return a.end < b.end ? 1 : -1;
		return durationDays(b) - durationDays(a);
	});
	const currentYtd = afterFy[0];
	const targetDuration = durationDays(currentYtd);
	const fyStart = latestFy.start!;

	const priorYtdCandidates = durationFacts.filter((f) => {
		if (f.end === currentYtd.end) return false;
		if (!f.start) return false;
		const startsAtSameFyStart = daysBetween(f.start, fyStart) <= 10;
		const sameLengthAsCurrentYtd = Math.abs(durationDays(f) - targetDuration) <= 20;
		return startsAtSameFyStart && sameLengthAsCurrentYtd;
	});

	if (priorYtdCandidates.length === 0) {
		return {
			value: latestFy.val,
			basis: "fiscal-year",
			asOf: latestFy.end,
			note: `Latest fiscal year (FY${latestFy.fy}, ended ${latestFy.end}) — couldn't find a matching year-ago interim period to roll forward to a true TTM.`,
		};
	}

	const oneYearBeforeCurrentEnd = new Date(currentYtd.end);
	oneYearBeforeCurrentEnd.setFullYear(oneYearBeforeCurrentEnd.getFullYear() - 1);
	const priorYtd = priorYtdCandidates.reduce((best, f) =>
		Math.abs(new Date(f.end).getTime() - oneYearBeforeCurrentEnd.getTime()) <
		Math.abs(new Date(best.end).getTime() - oneYearBeforeCurrentEnd.getTime())
			? f
			: best
	);

	return {
		value: latestFy.val + currentYtd.val - priorYtd.val,
		basis: "ttm",
		asOf: currentYtd.end,
		note: `TTM = FY${latestFy.fy} (ended ${latestFy.end}) + YTD through ${currentYtd.end} − YTD through ${priorYtd.end}.`,
	};
}

function deriveFcf(ocf: FieldResult, capex: FieldResult): FieldResult {
	if (ocf.value === null || capex.value === null) {
		const missingParts = [ocf.value === null && "operating cash flow", capex.value === null && "capex"]
			.filter(Boolean)
			.join(" and ");
		return missing(`Can't derive free cash flow — missing ${missingParts}.`);
	}
	return {
		value: ocf.value - capex.value,
		basis: "derived",
		asOf: ocf.asOf,
		note: `TTM operating cash flow minus TTM capex. OCF: ${ocf.note} Capex: ${capex.note}`,
	};
}

function deriveTotalDebt(ltNoncurrent: SecFact | null, ltCurrent: SecFact | null): FieldResult {
	if (!ltNoncurrent && !ltCurrent) {
		return missing(
			"No long-term debt tag reported — this filer may be debt-free, or debt isn't broken out under the standard tags. Verify against the balance sheet."
		);
	}
	if (ltNoncurrent && !ltCurrent) {
		return {
			value: ltNoncurrent.val,
			basis: "instant",
			asOf: ltNoncurrent.end,
			note: `Long-term debt (noncurrent) only, as of ${ltNoncurrent.end} — no separately tagged current portion found. May understate total debt; verify against the balance sheet.`,
		};
	}
	if (!ltNoncurrent && ltCurrent) {
		return {
			value: ltCurrent.val,
			basis: "instant",
			asOf: ltCurrent.end,
			note: `Current portion of long-term debt only, as of ${ltCurrent.end} — no noncurrent long-term debt tag found. May understate total debt; verify against the balance sheet.`,
		};
	}
	const lt = ltNoncurrent!;
	const cur = ltCurrent!;
	const dateNote =
		lt.end === cur.end
			? `as of ${lt.end}`
			: `noncurrent as of ${lt.end}, current portion as of ${cur.end} (different balance-sheet dates — treat as approximate)`;
	return {
		value: lt.val + cur.val,
		basis: "instant",
		asOf: lt.end,
		note: `Long-term debt, noncurrent + current portion, ${dateNote}. Depending on which XBRL tag this filer uses, the noncurrent figure may bundle in finance/capital lease obligations (pushing the total higher than "debt" alone) or may miss some debt instruments entirely (pushing it lower) — verify against the balance sheet, especially for debt-heavy companies.`,
	};
}

function deriveNetDebt(totDebt: FieldResult, cash: SecFact | null): FieldResult {
	if (totDebt.value === null || !cash) {
		return missing("Can't derive net debt — total debt or cash wasn't resolved.");
	}
	return {
		value: totDebt.value - cash.val,
		basis: "derived",
		asOf: cash.end,
		note: `Total debt minus cash and equivalents as of ${cash.end}. Total debt basis: ${totDebt.note}`,
	};
}

function deriveTaxRate(taxExpense: FieldResult, pretaxIncome: FieldResult): FieldResult {
	if (taxExpense.value === null || pretaxIncome.value === null) {
		return missing("Can't derive effective tax rate — missing latest-fiscal-year tax expense or pre-tax income.");
	}
	if (pretaxIncome.value <= 0) {
		return missing("Effective tax rate isn't meaningful when pre-tax income is zero or negative.");
	}
	return {
		value: taxExpense.value / pretaxIncome.value,
		basis: "derived",
		asOf: pretaxIncome.asOf,
		note: `Latest fiscal year income tax expense ÷ pre-tax income — deliberately not TTM-rolled, since a one-time item in a single quarter can otherwise swing this ratio far from the company's real run rate. ${pretaxIncome.note}`,
	};
}

// Flags a resolved value whose `asOf` date is implausibly old instead of
// silently presenting it as current — see STALE_THRESHOLD_DAYS above. `now`
// is injectable for deterministic tests; production always uses the real
// clock.
function withStaleWarning(field: FieldResult, now: Date): FieldResult {
	if (field.value === null || !field.asOf) return field;
	const ageDays = (now.getTime() - new Date(field.asOf).getTime()) / MS_PER_DAY;
	if (ageDays <= STALE_THRESHOLD_DAYS) return field;
	const years = (ageDays / 365).toFixed(1);
	return {
		...field,
		note: `${field.note} Stale — the most recent value this plugin could find is from ${field.asOf}, about ${years} years ago; this filer likely tags this concept in a way SEC's API doesn't expose. Enter it manually.`,
	};
}

// Orchestrates every field above from one companyfacts payload. Pure — no
// I/O, so it's fully covered by unit tests against fixture data. `now`
// drives the staleness check above; defaults to the real clock.
export function deriveFundamentals(companyFacts: SecCompanyFacts, ticker: string, now: Date = new Date()): FundamentalsResult {
	const gaap = companyFacts.facts["us-gaap"];

	const epsDilutedFacts = pickConceptFacts(gaap, TAGS.epsDiluted, "USD/shares");
	const epsBasicFacts = pickConceptFacts(gaap, TAGS.epsBasic, "USD/shares");
	const epsUsedBasic = !epsDilutedFacts && !!epsBasicFacts;
	const eps = computeTtm(epsDilutedFacts ?? epsBasicFacts);
	if (epsUsedBasic && eps.value !== null) {
		eps.note = `${eps.note} This filer doesn't report diluted EPS separately — this is basic EPS.`;
	}

	const ocf = computeTtm(pickConceptFacts(gaap, TAGS.ocf, "USD"));
	const capex = computeTtm(pickConceptFacts(gaap, TAGS.capex, "USD"));
	const intExp = computeTtm(pickConceptFacts(gaap, TAGS.interestExpense, "USD"));
	const fcf = deriveFcf(ocf, capex);

	const dilutedSharesFacts = pickConceptFacts(gaap, TAGS.dilutedShares, "shares");
	const basicSharesFacts = pickConceptFacts(gaap, TAGS.basicShares, "shares");
	const sharesUsedBasic = !dilutedSharesFacts && !!basicSharesFacts;
	const sharesFact = latestDuration(dilutedSharesFacts ?? basicSharesFacts);
	const shares = sharesFact
		? {
				value: sharesFact.val,
				basis: "instant" as const,
				asOf: sharesFact.end,
				note: sharesUsedBasic
					? `Basic weighted-average shares from the filing covering ${sharesFact.start}–${sharesFact.end}. This filer doesn't report a diluted share count separately.`
					: `Diluted weighted-average shares from the filing covering ${sharesFact.start}–${sharesFact.end}.`,
			}
		: missing("No weighted-average share count tag (diluted or basic) reported by this filer.");

	const ltNoncurrent = latestInstant(pickConceptFacts(gaap, TAGS.longTermDebtNoncurrent, "USD"));
	const ltCurrent = latestInstant(pickConceptFacts(gaap, TAGS.longTermDebtCurrent, "USD"));
	const totDebt = deriveTotalDebt(ltNoncurrent, ltCurrent);

	const cashFact = latestInstant(pickConceptFacts(gaap, TAGS.cash, "USD"));
	const netDebt = deriveNetDebt(totDebt, cashFact);

	const pretaxIncome = latestFiscalYear(pickConceptFacts(gaap, TAGS.pretaxIncome, "USD"));
	const taxExpense = latestFiscalYear(pickConceptFacts(gaap, TAGS.taxExpense, "USD"));
	const taxRate = deriveTaxRate(taxExpense, pretaxIncome);

	return {
		ticker: ticker.toUpperCase(),
		cik: padCik(companyFacts.cik),
		entityName: companyFacts.entityName,
		eps: withStaleWarning(eps, now),
		ocf: withStaleWarning(ocf, now),
		capex: withStaleWarning(capex, now),
		fcf: withStaleWarning(fcf, now),
		intExp: withStaleWarning(intExp, now),
		shares: withStaleWarning(shares, now),
		totDebt: withStaleWarning(totDebt, now),
		netDebt: withStaleWarning(netDebt, now),
		taxRate: withStaleWarning(taxRate, now),
	};
}

// ---------------------------------------------------------------------------
// I/O layer — talks to data.sec.gov. SEC EDGAR requires a descriptive,
// non-empty User-Agent with contact info on every request, or it 403s — this
// identifies the plugin itself, not any individual user, since the same
// build is shared by everyone who installs it.
//
// Two things verified directly against the live API, not just SEC's docs:
//   - The User-Agent must contain an actual email-shaped contact
//     ("name@domain"); a descriptive string with no "@" reliably 403s with
//     "Your Request Originates from an Undeclared Automated Tool", even well
//     under the documented rate limit.
//   - SEC/Akamai's bot filter separately blocklists any User-Agent
//     containing the substring "github.com" — including inside a GitHub
//     noreply email address (e.g. users.noreply.github.com) — regardless of
//     an email also being present. So: no repo URL, and no GitHub noreply
//     alias here, only a plain "name email" string. The address below is a
//     DuckDuckGo Email Protection alias, not a real inbox directly — it
//     forwards without exposing a personal address in distributed source.
const SEC_USER_AGENT = "obs-stock-valuations Obsidian plugin fernanluyano@duck.com";

// Minimal HTTP GET abstraction, injected into every function below instead of
// calling Obsidian directly — lets the request/response handling (status
// codes, error messages) be unit tested with a fake, deterministic
// implementation instead of a real network call. The real implementation
// (secHttpGet, used by the view) lives in secHttp.ts, a deliberately tiny
// file that this one never imports — see that file's header comment for why.
export interface HttpResponse {
	status: number;
	json: unknown;
}
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

interface TickerMapEntry {
	cik: string; // zero-padded to 10 digits
	title: string;
}

// Ticker -> CIK map is ~1MB and rarely changes; fetch it once per Obsidian
// session and reuse it for every subsequent lookup instead of hitting SEC
// again.
let tickerMapCache: Map<string, TickerMapEntry> | null = null;

// Maps a non-200 SEC response to a user-presentable message. Shared by both
// endpoints below so a rate limit, an offline device, or a malformed
// response reads the same way no matter which call hit it.
function httpErrorMessage(status: number, context: string): FundamentalsError {
	if (status === 429) {
		return { kind: "network", message: "SEC EDGAR rate-limited this request — wait a moment and try again." };
	}
	if (status === 403) {
		return { kind: "network", message: "SEC EDGAR rejected this request — it may be temporarily blocking automated traffic. Try again shortly." };
	}
	return { kind: "network", message: `SEC EDGAR returned an unexpected error (status ${status}) ${context}.` };
}

async function loadTickerMap(get: HttpGet): Promise<Map<string, TickerMapEntry> | FundamentalsError> {
	if (tickerMapCache) return tickerMapCache;

	let res: HttpResponse;
	try {
		res = await get("https://www.sec.gov/files/company_tickers.json", { "User-Agent": SEC_USER_AGENT });
	} catch {
		return { kind: "network", message: "Couldn't reach SEC EDGAR — check your internet connection and try again." };
	}
	if (res.status !== 200) return httpErrorMessage(res.status, "while looking up the ticker");

	const raw = res.json as Record<string, { cik_str: number; ticker: string; title: string }> | null;
	if (!raw || typeof raw !== "object") {
		return { kind: "network", message: "SEC EDGAR returned data in an unexpected format — try again shortly." };
	}

	const map = new Map<string, TickerMapEntry>();
	for (const entry of Object.values(raw)) {
		map.set(entry.ticker.toUpperCase(), { cik: padCik(entry.cik_str), title: entry.title });
	}
	tickerMapCache = map;
	return map;
}

export async function resolveCik(ticker: string, get: HttpGet): Promise<TickerMapEntry | FundamentalsError> {
	const map = await loadTickerMap(get);
	if (!(map instanceof Map)) return map; // propagate the error
	const entry = map.get(ticker.toUpperCase());
	if (!entry) {
		return {
			kind: "not-found",
			message: `SEC EDGAR has no record of "${ticker}" — it may not be a US-listed company that files with the SEC.`,
		};
	}
	return entry;
}

export async function fetchCompanyFactsJson(
	cik: string,
	entityTitle: string,
	get: HttpGet
): Promise<SecCompanyFacts | FundamentalsError> {
	let res: HttpResponse;
	try {
		res = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { "User-Agent": SEC_USER_AGENT });
	} catch {
		return { kind: "network", message: "Couldn't reach SEC EDGAR — check your internet connection and try again." };
	}
	if (res.status === 404) {
		return { kind: "no-data", message: `SEC EDGAR has no XBRL filings on record for ${entityTitle} (CIK ${cik}).` };
	}
	if (res.status !== 200) return httpErrorMessage(res.status, "while fetching fundamentals");

	if (!res.json || typeof res.json !== "object") {
		return { kind: "network", message: "SEC EDGAR returned data in an unexpected format — try again shortly." };
	}
	return res.json as SecCompanyFacts;
}

export function isFundamentalsError<T>(x: T | FundamentalsError): x is FundamentalsError {
	return typeof x === "object" && x !== null && "kind" in x;
}

// Entry point used by the UI: ticker in, either a full FundamentalsResult (with
// per-field notes for anything that couldn't be derived) or a single
// FundamentalsError with a message that's ready to show the user as-is.
// `get` has no default on purpose (see the file header) — callers pass
// secHttpGet from secHttp.ts in production, a fake in tests.
export async function fetchFundamentals(
	ticker: string,
	get: HttpGet
): Promise<FundamentalsResult | FundamentalsError> {
	const trimmed = ticker.trim();
	if (!trimmed) return { kind: "not-found", message: "Enter a ticker first." };

	const cikEntry = await resolveCik(trimmed, get);
	if (isFundamentalsError(cikEntry)) return cikEntry;

	const companyFacts = await fetchCompanyFactsJson(cikEntry.cik, cikEntry.title, get);
	if (isFundamentalsError(companyFacts)) return companyFacts;

	return deriveFundamentals(companyFacts, trimmed.toUpperCase());
}

// Test-only escape hatch: the ticker-map cache is module-level so production
// code doesn't refetch a ~1MB file on every call within a session, but that
// same caching would leak state between unit tests. Not used by app code.
export function _resetTickerMapCacheForTests(): void {
	tickerMapCache = null;
}
