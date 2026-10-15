// Pure logic for the table's "Bulk edit" action: changing market-wide inputs
// across several saved valuations at once. Kept Obsidian-free so it's directly
// unit testable — see tests/bulkEdit.test.ts.
import { appendHistoryEntry, buildHistoryEntry } from "./historyStore";
import { computeResultsForState } from "./valuationCalc";
import type { FormState, SavedValuation } from "./valuationStore";

// Only inputs that describe the market, not the company: the same value is
// right for every ticker. Deliberately excludes anything fetched or judged
// per company (beta, tax rate, growth rates, maintenance capex %, ...).
export const BULK_EDITABLE_FIELDS = ["mrp"] as const;
export type BulkField = (typeof BULK_EDITABLE_FIELDS)[number];

export const BULK_FIELD_LABELS: Record<BulkField, string> = {
	mrp: "Market risk premium (%)",
};

// A field absent from `changes` is left alone on every ticker.
export type BulkChanges = Partial<Record<BulkField, string>>;

// Applies `changes` to every scenario of `record` in place, recomputes the
// results, and appends a history entry (same-day entries collapse, as with a
// Save or price refresh). Does not touch lastPriceRefreshAt — no price was
// confirmed. Caller persists.
export function applyBulkChanges(record: SavedValuation, changes: BulkChanges, defaultTaxRatePercent: number, now: number): void {
	for (const scenario of Object.values(record.scenarios)) {
		for (const field of BULK_EDITABLE_FIELDS) {
			const value = changes[field]?.trim();
			if (value) scenario.state[field] = value;
		}
		scenario.results = computeResultsForState(
			scenario.state as FormState,
			record.moneyScale,
			record.sharesScale,
			defaultTaxRatePercent
		);
	}
	record.updatedAt = now;
	record.history = appendHistoryEntry(record.history, buildHistoryEntry(now, record.scenarios));
}
