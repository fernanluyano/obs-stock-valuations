// Pure logic for a saved valuation's history timeline (see HistoryEntry in
// valuationStore.ts) — append-with-dedupe, manual single-entry delete, and
// compaction. Kept Obsidian-free so it's directly unit testable.
import type { HistoryEntry } from "./valuationStore";

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
// month) per calendar month; the last ~6 months are left at full detail.
// Irreversible — callers must confirm with the user before calling this.
// Idempotent: compacting an already-compacted history is a no-op.
export function compactHistory(history: HistoryEntry[], now: number): HistoryEntry[] {
	const cutoff = now - COMPACT_AFTER_MS;
	const recent = history.filter((h) => h.at >= cutoff);
	const old = [...history.filter((h) => h.at < cutoff)].sort((a, b) => a.at - b.at);

	const lastPerMonth = new Map<string, HistoryEntry>();
	for (const entry of old) {
		lastPerMonth.set(monthKey(entry.at), entry); // ascending order, so last write per month wins
	}

	return [...lastPerMonth.values(), ...recent].sort((a, b) => a.at - b.at);
}
