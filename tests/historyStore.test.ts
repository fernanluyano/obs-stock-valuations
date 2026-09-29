import { describe, expect, it } from "vitest";
import { appendHistoryEntry, compactHistory, deleteHistoryEntry } from "../historyStore";
import type { HistoryEntry } from "../valuationStore";

// All timestamps built via local Date components (not raw epoch literals) so
// the tests reason about calendar days/months the same way historyStore.ts
// does, regardless of the machine's timezone.
function at(year: number, month: number, day: number, hour = 12): number {
	return new Date(year, month, day, hour).getTime();
}

function fixtureEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		at: at(2024, 0, 15),
		price: 50,
		dcfBearIv: 40,
		dcfBaseIv: 60,
		dcfBullIv: 80,
		grahamBearIv: 45,
		grahamBaseIv: 55,
		grahamBullIv: 65,
		tenCapIv: 45,
		impliedGrowth: 0.07,
		...overrides,
	};
}

describe("appendHistoryEntry", () => {
	it("starts a new timeline from undefined history", () => {
		const entry = fixtureEntry();
		expect(appendHistoryEntry(undefined, entry)).toEqual([entry]);
	});

	it("appends an entry from a new calendar day, keeping both", () => {
		const day1 = fixtureEntry({ at: at(2024, 0, 15), price: 50 });
		const day2 = fixtureEntry({ at: at(2024, 0, 16), price: 52 });
		expect(appendHistoryEntry([day1], day2)).toEqual([day1, day2]);
	});

	it("replaces same-day entries instead of duplicating them", () => {
		const morning = fixtureEntry({ at: at(2024, 0, 15, 9), price: 50 });
		const evening = fixtureEntry({ at: at(2024, 0, 15, 21), price: 53 });
		const result = appendHistoryEntry([morning], evening);
		expect(result).toEqual([evening]);
	});

	it("only touches the entry matching the new one's day, leaving other days alone", () => {
		const day1 = fixtureEntry({ at: at(2024, 0, 14), price: 48 });
		const day2Old = fixtureEntry({ at: at(2024, 0, 15, 9), price: 50 });
		const day2New = fixtureEntry({ at: at(2024, 0, 15, 21), price: 53 });
		const day3 = fixtureEntry({ at: at(2024, 0, 16), price: 55 });

		const result = appendHistoryEntry([day1, day2Old, day3], day2New);
		expect(result).toEqual([day1, day2New, day3]);
	});

	it("returns entries sorted ascending by time regardless of insertion order", () => {
		const earlier = fixtureEntry({ at: at(2024, 0, 10) });
		const later = fixtureEntry({ at: at(2024, 0, 20) });
		const result = appendHistoryEntry([later], earlier);
		expect(result.map((h) => h.at)).toEqual([earlier.at, later.at]);
	});
});

describe("deleteHistoryEntry", () => {
	it("removes the entry with the matching timestamp", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		const b = fixtureEntry({ at: at(2024, 0, 11) });
		expect(deleteHistoryEntry([a, b], a.at)).toEqual([b]);
	});

	it("is a no-op when no entry matches", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		expect(deleteHistoryEntry([a], at(2024, 0, 11))).toEqual([a]);
	});

	it("leaves every other entry untouched", () => {
		const a = fixtureEntry({ at: at(2024, 0, 10) });
		const b = fixtureEntry({ at: at(2024, 0, 11) });
		const c = fixtureEntry({ at: at(2024, 0, 12) });
		expect(deleteHistoryEntry([a, b, c], b.at)).toEqual([a, c]);
	});
});

describe("compactHistory", () => {
	it("leaves entries from the last ~6 months untouched, even several per month", () => {
		const now = at(2024, 6, 1); // Jul 1, 2024
		const recent1 = fixtureEntry({ at: at(2024, 5, 1) }); // Jun 1 — within 6mo
		const recent2 = fixtureEntry({ at: at(2024, 5, 15) }); // Jun 15 — same month, both kept
		expect(compactHistory([recent1, recent2], now)).toEqual([recent1, recent2]);
	});

	it("collapses entries older than ~6 months to the latest one per calendar month", () => {
		const now = at(2024, 6, 1); // Jul 1, 2024 — cutoff is ~Jan 1, 2024
		const janEarly = fixtureEntry({ at: at(2023, 11, 5), price: 40 }); // Dec 2023
		const janLate = fixtureEntry({ at: at(2023, 11, 28), price: 44 }); // Dec 2023, later
		const febOnly = fixtureEntry({ at: at(2024, 0, 10), price: 46 }); // Jan 2024

		const result = compactHistory([janEarly, janLate, febOnly], now);

		expect(result).toEqual([janLate, febOnly]);
	});

	it("combines a compacted old tail with an untouched recent head, in chronological order", () => {
		const now = at(2024, 6, 1);
		const oldA = fixtureEntry({ at: at(2023, 11, 5), price: 40 });
		const oldB = fixtureEntry({ at: at(2023, 11, 20), price: 42 });
		const recent = fixtureEntry({ at: at(2024, 5, 20), price: 60 });

		const result = compactHistory([oldA, oldB, recent], now);

		expect(result).toEqual([oldB, recent]);
	});

	it("is idempotent — compacting an already-compacted history changes nothing", () => {
		const now = at(2024, 6, 1);
		const oldA = fixtureEntry({ at: at(2023, 11, 5), price: 40 });
		const oldB = fixtureEntry({ at: at(2023, 11, 20), price: 42 });
		const recent = fixtureEntry({ at: at(2024, 5, 20), price: 60 });

		const once = compactHistory([oldA, oldB, recent], now);
		const twice = compactHistory(once, now);

		expect(twice).toEqual(once);
	});

	it("returns an empty array for empty input", () => {
		expect(compactHistory([], at(2024, 6, 1))).toEqual([]);
	});
});
