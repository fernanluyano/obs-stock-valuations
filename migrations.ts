import type { FormState, Results, SavedValuation, ScenarioKey, ValuationTable } from "./valuationStore";
import type { ScaleUnit } from "./units";

// Bump whenever ValuationTable's on-disk shape changes. Read once on load
// (main.ts's loadPluginData) to decide whether migration is needed at all —
// keep that check a single number comparison, not a per-record shape probe,
// so every load after the first migration stays cheap.
export const CURRENT_SCHEMA_VERSION = 2;

// The on-disk shape before schema v2: one state/results pair per ticker,
// instead of one per scenario. Only ever read during migration.
export interface LegacySavedValuation {
	state: FormState;
	results: Results;
	moneyScale: ScaleUnit;
	sharesScale: ScaleUnit;
	updatedAt: number;
	researchNotePath?: string;
}

const SCENARIO_KEYS: ScenarioKey[] = ["bull", "base", "bear"];

// v1 -> v2: wraps each ticker's single state/results pair into identical
// bull/base/bear scenarios, so every saved ticker keeps showing exactly what
// it showed before, just filed under all three scenarios. Clones state and
// results per scenario (never shares references) so editing one scenario
// later can't mutate another.
export function migrateValuationsToV2(
	valuations: Record<string, LegacySavedValuation>
): ValuationTable {
	const migrated: ValuationTable = {};

	for (const [ticker, record] of Object.entries(valuations)) {
		const scenarios = {} as Record<ScenarioKey, { state: FormState; results: Results }>;
		for (const key of SCENARIO_KEYS) {
			scenarios[key] = {
				state: { ...record.state },
				results: { ...record.results },
			};
		}

		const migratedRecord: SavedValuation = {
			scenarios,
			moneyScale: record.moneyScale,
			sharesScale: record.sharesScale,
			updatedAt: record.updatedAt,
		};
		if (record.researchNotePath !== undefined) {
			migratedRecord.researchNotePath = record.researchNotePath;
		}
		migrated[ticker] = migratedRecord;
	}

	return migrated;
}
