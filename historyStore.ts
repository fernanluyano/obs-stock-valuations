// Pure logic for a saved valuation's history timeline (see HistoryEntry in
// valuationStore.ts) — building an entry, append-with-dedupe, manual
// single-entry delete, and compaction. Kept Obsidian-free so it's directly
// unit testable.
import type { HistoryEntry, Scenario, ScenarioKey } from "./valuationStore";

const DAY_MS = 24 * 60 * 60 * 1000;
// Approximate — exact calendar-month boundaries aren't the point, "roughly
// half a year of full detail" is. Avoids the edge cases of real calendar-month
// subtraction (Jan 31 minus 6 months, etc.) for a threshold nothing hinges on
// being exact.
const COMPACT_AFTER_MS = 182 * DAY_MS;

// Local calendar day/month, not UTC — dedupe and compaction should follow the
// day the user actually saved on, not a UTC offset from it.
function dayKey(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function monthKey(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${d.getMonth()}`;
}

// Builds the point-in-time snapshot appended to a ticker's history — the
// numbers that matter for "fair value vs. price over time", Bear/Base/Bull
// for DCF, Graham, and DDM like everywhere else in the plugin. Shared by an
// explicit form Save and a price refresh: a refresh only ever changes price
// and everything derived from it (MoS, IV), never fundamentals, but that's
// exactly what this timeline is tracking, so it earns a history point same as
// a Save does. Price and Ten Cap/growth are read off Base — every scenario
// shares the same price, and Ten Cap/Reverse DCF have no scenario lever.
export function buildHistoryEntry(at: number, scenarios: Record<ScenarioKey, Scenario>): HistoryEntry {
	const { bear, base, bull } = scenarios;
	return {
		at,
		price: parseFloat(base.state.price) || 0,
		dcfBearIv: bear.results.dcfIv,
		dcfBaseIv: base.results.dcfIv,
		dcfBullIv: bull.results.dcfIv,
		grahamBearIv: bear.results.grahamIv,
		grahamBaseIv: base.results.grahamIv,
		grahamBullIv: bull.results.grahamIv,
		tenCapIv: base.results.tenCapIv,
		impliedGrowth: base.results.impliedGrowth,
		ddmBearIv: bear.results.ddmIv,
		ddmBaseIv: base.results.ddmIv,
		ddmBullIv: bull.results.ddmIv,
	};
}

// Appends `entry`, replacing any existing entry from the same calendar day —
// multiple saves in one sitting collapse to the last one, so the timeline
// reflects "state as of a given day," not how many times the form was saved
// that day. Returns entries sorted ascending by time.
export function appendHistoryEntry(history: HistoryEntry[] | undefined, entry: HistoryEntry): HistoryEntry[] {
	const key = dayKey(entry.at);
	const kept = (history ?? []).filter((h) => dayKey(h.at) !== key);
	return [...kept, entry].sort((a, b) => a.at - b.at);
}

// Removes the entry with this exact timestamp. A no-op if no entry matches.
export function deleteHistoryEntry(history: HistoryEntry[], at: number): HistoryEntry[] {
	return history.filter((h) => h.at !== at);
}

// Collapses anything older than ~6 months down to one entry (the latest that
// month) per calendar month; the last ~6 months are left at full detail. A
// real entry always beats a synthetic one in the same month, whichever is
// later. Irreversible — callers must confirm with the user before calling
// this. Idempotent: compacting an already-compacted history is a no-op.
export function compactHistory(history: HistoryEntry[], now: number): HistoryEntry[] {
	const cutoff = now - COMPACT_AFTER_MS;
	const recent = history.filter((h) => h.at >= cutoff);
	const old = [...history.filter((h) => h.at < cutoff)].sort((a, b) => a.at - b.at);

	const lastPerMonth = new Map<string, HistoryEntry>();
	for (const entry of old) {
		const kept = lastPerMonth.get(monthKey(entry.at));
		if (kept && !kept.synthetic && entry.synthetic) continue; // never let synthetic displace real
		lastPerMonth.set(monthKey(entry.at), entry); // ascending order, so last write per month wins
	}

	return [...lastPerMonth.values(), ...recent].sort((a, b) => a.at - b.at);
}

// Local midnight of a YYYY-MM-DD entry date, or NaN if it isn't one.
export function parseEntryDate(date: string | undefined): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
	if (!m) return NaN;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

// The flat "your entry" line for a history chart whose points are at `times`
// (ascending): the entry date (clamped to the chart start; the whole span when
// there's no date) followed by one point at every history time after it. A
// point per history time, not just the two ends, because the chart's
// index-mode tooltip only lists a dataset that has a point at the hovered x.
// Computed on the fly, never stored per history entry. Empty when there's no
// usable entry, or the entry date is after the newest history point (nothing
// to draw it against yet).
export function entryLinePoints(
	avgEntry: number | undefined,
	entryDate: string | undefined,
	times: number[]
): { x: number; y: number }[] {
	if (avgEntry === undefined || !Number.isFinite(avgEntry) || avgEntry <= 0 || times.length === 0) return [];
	const firstAt = times[0];
	const lastAt = times[times.length - 1];
	const dated = parseEntryDate(entryDate);
	const from = Number.isNaN(dated) ? firstAt : Math.max(dated, firstAt);
	if (from > lastAt) return [];
	const xs = [from, ...times.filter((t) => t > from)];
	return xs.map((x) => ({ x, y: avgEntry }));
}

// Last day of the month `t` falls in, at local midnight — the date a monthly
// close is attributed to (Yahoo stamps the bar on the 1st, but the value is
// that month's close).
function monthEnd(t: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
}

// Turns raw monthly closes into one price per finished calendar month, dated
// the last day of that month, ascending. The month `now` falls in is skipped
// (no close yet — this also drops Yahoo's trailing live-quote row), and when
// two rows share a month the later one wins.
export function monthlyCloses(prices: { t: number; v: number }[], now: number): { at: number; price: number }[] {
	const current = monthKey(now);
	const perMonth = new Map<string, { t: number; v: number }>();
	for (const p of prices) {
		if (!Number.isFinite(p.v) || p.v <= 0) continue;
		const key = monthKey(p.t);
		if (key === current) continue;
		const kept = perMonth.get(key);
		if (!kept || p.t > kept.t) perMonth.set(key, p);
	}
	return [...perMonth.values()].map((p) => ({ at: monthEnd(p.t), price: p.v })).sort((a, b) => a.at - b.at);
}

// One synthetic entry per monthly close: today's saved inputs replayed at that
// month's price. `recompute` redoes a scenario's results for a state with the
// price swapped in (valuationCalc.computeResultsForState, injected to keep this
// file free of scale/tax settings). The scenarios passed in are never mutated.
//
// A close may also carry what was known that month for Graham's two time-varying
// inputs: `eps` (trailing-twelve-month, per share) and `aaaYield` (percent, e.g.
// 4.4). undefined keeps today's saved input; a number replaces it in every
// scenario (both are facts, shared by all three); null means unknown that
// month, so Graham is left blank for the entry rather than guessed.
//
// `tenCapIv` is that month's Ten Cap value, worked out by the caller from the
// month's own cash flow, capex and share count: undefined keeps the one
// recomputed from today's inputs, a number replaces it, null leaves it blank.
// It's passed as a finished value (not as inputs) because the share count
// can't go through the saved state without also moving the DCF.
//
// DCF's time-varying inputs, in the record's own display units (what the form
// fields hold, i.e. already divided by the money/shares scale): `fcf`,
// `netDebt` and `shares` follow the same rule (undefined keeps today's, a
// number replaces it in every scenario, null means unknown that month and
// leaves the DCF, and the reverse DCF built on it, blank), and `rfr` is the
// risk-free rate in percent (null blanks the DCF, the reverse DCF and the DDM,
// since it feeds both the WACC and the cost of equity). `dps` is the trailing
// dividend per share (null blanks the DDM). Growth, terminal growth, market
// risk premium, beta and the cost of debt always stay as saved.
export interface SyntheticClose {
	at: number;
	price: number;
	eps?: number | null;
	aaaYield?: number | null;
	tenCapIv?: number | null;
	fcf?: number | null;
	netDebt?: number | null;
	shares?: number | null;
	rfr?: number | null;
	dps?: number | null;
}

export function buildSyntheticHistory(
	closes: SyntheticClose[],
	scenarios: Record<ScenarioKey, Scenario>,
	recompute: (state: Scenario["state"]) => Scenario["results"]
): HistoryEntry[] {
	return closes.map(({ at, price, eps, aaaYield, tenCapIv, fcf, netDebt, shares, rfr, dps }) => {
		const replayed = {} as Record<ScenarioKey, Scenario>;
		for (const key of ["bear", "base", "bull"] as ScenarioKey[]) {
			const state = { ...scenarios[key].state, price: String(price) };
			if (typeof eps === "number") state.eps = String(eps);
			if (typeof aaaYield === "number") state.aaaYield = String(aaaYield);
			if (typeof fcf === "number") state.fcf = String(fcf);
			if (typeof netDebt === "number") state.netDebt = String(netDebt);
			if (typeof shares === "number") state.shares = String(shares);
			if (typeof rfr === "number") state.rfr = String(rfr);
			if (typeof dps === "number") state.dps = String(dps);
			state.ddmGrowth = cappedDdmGrowth(state);
			const results = recompute(state);
			if (fcf === null || netDebt === null || shares === null || rfr === null) {
				results.dcfIv = NaN;
				results.dcfMos = NaN;
				results.impliedGrowth = NaN;
			}
			if (dps === null || rfr === null) {
				results.ddmIv = NaN;
				results.ddmMos = NaN;
			}
			if (eps === null || aaaYield === null) {
				results.grahamIv = NaN;
				results.grahamMos = NaN;
			}
			if (tenCapIv !== undefined) {
				results.tenCapIv = tenCapIv ?? NaN;
				results.tenCapMos = NaN;
			}
			replayed[key] = { state, results };
		}
		return { ...buildHistoryEntry(at, replayed), synthetic: true };
	});
}

// How far below the cost of equity (percentage points) a backfilled DDM's growth
// is held. The DDM divides by (cost of equity - growth), so growth at or near
// the cost of equity makes the value explode, and the month-to-month moves in
// the Treasury yield then swing it wildly. This bounds the denominator at 2
// points, which keeps a backfilled DDM within about 50x the dividend.
export const DDM_GROWTH_MARGIN_PP = 2;

// The scenario's dividend growth (percent string), limited to
// DDM_GROWTH_MARGIN_PP below that month's cost of equity (rfr + beta x MRP, all
// percent) when it is higher. Blank or unreadable inputs are returned as they
// are, and a growth already below the cap is untouched.
export function cappedDdmGrowth(state: Scenario["state"]): string {
	const growth = parseFloat(state.ddmGrowth);
	const ke = parseFloat(state.rfr) + parseFloat(state.beta) * parseFloat(state.mrp);
	if (!Number.isFinite(growth) || !Number.isFinite(ke)) return state.ddmGrowth;
	return growth > ke - DDM_GROWTH_MARGIN_PP ? String(ke - DDM_GROWTH_MARGIN_PP) : state.ddmGrowth;
}

// Whether the user values this ticker with the DDM at all: at least one
// scenario has a dividend growth entered. Without one the DDM is blank in every
// real entry, so the backfill must not invent one from SEC dividends.
export function usesDdm(scenarios: Record<ScenarioKey, Scenario>): boolean {
	return (["bear", "base", "bull"] as ScenarioKey[]).some((k) => scenarios[k].state.ddmGrowth.trim() !== "");
}

// Drops every synthetic entry, leaving real ones untouched.
export function removeSyntheticHistory(history: HistoryEntry[] | undefined): HistoryEntry[] {
	return (history ?? []).filter((h) => !h.synthetic);
}

// Replaces all previous synthetic entries with `synthetic`. Real entries always
// win: a synthetic entry is dropped if it falls on or after the first real
// entry, or in a month/day that already has a real one. Returns ascending.
export function mergeSyntheticHistory(history: HistoryEntry[] | undefined, synthetic: HistoryEntry[]): HistoryEntry[] {
	const real = removeSyntheticHistory(history);
	const firstReal = real.length > 0 ? Math.min(...real.map((h) => h.at)) : Infinity;
	const realMonths = new Set(real.map((h) => monthKey(h.at)));
	const realDays = new Set(real.map((h) => dayKey(h.at)));
	const usable = synthetic.filter(
		(s) => s.at < firstReal && !realMonths.has(monthKey(s.at)) && !realDays.has(dayKey(s.at))
	);
	return [...real, ...usable.map((s) => ({ ...s, synthetic: true }))].sort((a, b) => a.at - b.at);
}
