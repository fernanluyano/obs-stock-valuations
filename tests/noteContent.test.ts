import { beforeAll, describe, expect, it } from "vitest";
import { buildHistoryNoteContent, historyNotePath } from "../noteContent";
import type { HistoryEntry, SavedValuation } from "../valuationStore";

// buildHistoryNoteContent formats each row's date via window.moment, which
// Obsidian provides at runtime (a global moment.js) — stub the one method it
// actually calls so this stays a pure-logic test, not an Obsidian integration
// test.
beforeAll(() => {
	(globalThis as { window?: unknown }).window = {
		moment: (ms: number) => ({
			format: () => new Date(ms).toISOString().slice(0, 10),
		}),
	};
});

const DAY = 24 * 60 * 60 * 1000;
const JAN_15 = Date.UTC(2026, 0, 15, 12);

function fixtureEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		at: JAN_15,
		price: 50,
		dcfBearIv: 40,
		dcfBaseIv: 60,
		dcfBullIv: 80,
		grahamBearIv: 45,
		grahamBaseIv: 55,
		grahamBullIv: 65,
		tenCapIv: 25,
		impliedGrowth: 0.123,
		ddmBearIv: 30,
		ddmBaseIv: 50,
		ddmBullIv: 70,
		...overrides,
	};
}

// The note reads only `history` — scenarios are irrelevant to it, so a bare
// cast keeps the fixture to what the function actually touches.
function fixtureRecord(history: HistoryEntry[] | undefined): SavedValuation {
	return { history } as SavedValuation;
}

// Cells of the row for a given date, split on the markdown table pipes.
function rowCells(content: string, date: string): string[] {
	const row = content.split("\n").find((line) => line.startsWith(`| ${date}`));
	expect(row).toBeDefined();
	return row!.split("|").map((c) => c.trim());
}

describe("historyNotePath", () => {
	it("is <folder>/<TICKER>-history.md", () => {
		expect(historyNotePath("Stock Valuations", "ADBE")).toBe("Stock Valuations/ADBE-history.md");
	});

	it("ignores a trailing slash and surrounding whitespace on the folder", () => {
		expect(historyNotePath("  Investing/Notes/ ", "ADBE")).toBe("Investing/Notes/ADBE-history.md");
	});

	it("puts the note at the vault root when the folder is blank", () => {
		expect(historyNotePath("", "ADBE")).toBe("ADBE-history.md");
		expect(historyNotePath("   ", "ADBE")).toBe("ADBE-history.md");
	});
});

describe("buildHistoryNoteContent", () => {
	it("titles the note with the ticker", () => {
		const content = buildHistoryNoteContent("ADBE", fixtureRecord([fixtureEntry()]));
		expect(content.split("\n")[0]).toBe("# ADBE — valuation history");
	});

	it("writes one row per history entry, newest first", () => {
		const entries = [
			fixtureEntry({ at: JAN_15 }),
			fixtureEntry({ at: JAN_15 + 2 * DAY }),
			fixtureEntry({ at: JAN_15 + DAY }),
		];
		const content = buildHistoryNoteContent("ADBE", fixtureRecord(entries));
		const dates = content
			.split("\n")
			.filter((line) => /^\| \d{4}-\d{2}-\d{2} /.test(line))
			.map((line) => line.split("|")[1].trim());
		expect(dates).toEqual(["2026-01-17", "2026-01-16", "2026-01-15"]);
	});

	it("doesn't reorder the record's own history array", () => {
		const entries = [fixtureEntry({ at: JAN_15 }), fixtureEntry({ at: JAN_15 + DAY })];
		buildHistoryNoteContent("ADBE", fixtureRecord(entries));
		expect(entries.map((e) => e.at)).toEqual([JAN_15, JAN_15 + DAY]);
	});

	it("puts each method's Bear/Base/Bull IV in its own column, with MoS derived from that entry's price", () => {
		const content = buildHistoryNoteContent("ADBE", fixtureRecord([fixtureEntry()]));
		const cells = rowCells(content, "2026-01-15");
		// | Date | Price | DCF Bear | DCF Base | DCF Bull | Reverse DCF | Ten Cap | Graham Bear | Graham Base | Graham Bull | DDM Bear | DDM Base | DDM Bull |
		expect(cells[2]).toBe("$50.00"); // Price
		expect(cells[3]).toBe("$40.00/-25.00%"); // DCF Bear: (40 − 50) / 40
		expect(cells[4]).toBe("$60.00/16.67%"); // DCF Base
		expect(cells[5]).toBe("$80.00/37.50%"); // DCF Bull
		expect(cells[6]).toBe("12.30%"); // Reverse DCF
		expect(cells[7]).toBe("$25.00/-100.00%"); // Ten Cap
		expect(cells[8]).toBe("$45.00/-11.11%"); // Graham Bear
		expect(cells[9]).toBe("$55.00/9.09%"); // Graham Base
		expect(cells[10]).toBe("$65.00/23.08%"); // Graham Bull
		expect(cells[11]).toBe("$30.00/-66.67%"); // DDM Bear
		expect(cells[12]).toBe("$50.00/0.00%"); // DDM Base
		expect(cells[13]).toBe("$70.00/28.57%"); // DDM Bull
	});

	// What JSON actually hands back for a value recorded as NaN (a non-payer's
	// DDM, an unanswerable reverse DCF) — the crash that started this: the
	// global isFinite(null) is true, so null used to reach toLocaleString().
	it("renders null values as — without throwing", () => {
		const entry = fixtureEntry({ dcfBaseIv: null, impliedGrowth: null, ddmBearIv: null, ddmBaseIv: null, ddmBullIv: null });
		const content = buildHistoryNoteContent("ACN", fixtureRecord([entry]));
		const cells = rowCells(content, "2026-01-15");
		expect(cells[4]).toBe("—/—"); // DCF Base
		expect(cells[6]).toBe("—"); // Reverse DCF
		expect(cells[11]).toBe("—/—");
		expect(cells[12]).toBe("—/—");
		expect(cells[13]).toBe("—/—");
	});

	it("renders DDM as — for entries recorded before the DDM existed (fields missing)", () => {
		const entry = fixtureEntry();
		delete entry.ddmBearIv;
		delete entry.ddmBaseIv;
		delete entry.ddmBullIv;
		const cells = rowCells(buildHistoryNoteContent("ADBE", fixtureRecord([entry])), "2026-01-15");
		expect(cells.slice(11, 14)).toEqual(["—/—", "—/—", "—/—"]);
	});

	it("says there's no history yet (and draws no table) when the record has none", () => {
		for (const history of [undefined, []]) {
			const content = buildHistoryNoteContent("ADBE", fixtureRecord(history));
			expect(content).toContain("_No history yet");
			expect(content).not.toContain("| Date |");
		}
	});
});
