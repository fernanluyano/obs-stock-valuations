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
