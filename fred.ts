// Pure parsing for FRED's public CSV download (fredgraph.csv) — kept
// Obsidian-free so it's directly unit testable; the actual request lives in
// priceProvider.ts. See tests/fred.test.ts.

// The latest numeric observation in a `date,value` CSV, or null if there is
// none. FRED leaves the value empty on days with no data (holidays), and
// writes "." in some downloads, so both are skipped rather than read as 0.
export function parseLatestFredValue(csv: string): number | null {
	const lines = csv.trim().split(/\r?\n/);
	for (let i = lines.length - 1; i >= 1; i--) {
		const raw = lines[i].split(",")[1]?.trim();
		if (!raw || raw === ".") continue;
		const value = Number(raw);
		if (Number.isFinite(value) && value > 0) return value;
	}
	return null;
}

export interface FredPoint {
	date: string; // YYYY-MM-DD
	value: number;
}

// Every numeric observation in a `date,value` CSV, ascending by date. Same
// skipping rules as parseLatestFredValue (empty and "." rows are no data).
export function parseFredSeries(csv: string): FredPoint[] {
	const points: FredPoint[] = [];
	for (const line of csv.trim().split(/\r?\n/).slice(1)) {
		const [date, raw] = line.split(",").map((s) => s.trim());
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !raw || raw === ".") continue;
		const value = Number(raw);
		if (Number.isFinite(value) && value > 0) points.push({ date, value });
	}
	return points.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The last observation on or before `date` (YYYY-MM-DD), or null if the series
// starts after it. Handles weekends and holidays, which have no row.
export function fredValueAsOf(series: FredPoint[], date: string): number | null {
	let found: number | null = null;
	for (const p of series) {
		if (p.date > date) break;
		found = p.value;
	}
	return found;
}
