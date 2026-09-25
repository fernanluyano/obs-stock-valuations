// Cross-scenario validation: checks that a valuation's bull/base/bear inputs
// are internally consistent with each other, beyond what any single field's
// own parsing/range checks can catch. Kept pure and Obsidian-free, like
// valuationCalc.ts, so it can be unit tested directly — see
// tests/scenarioValidation.test.ts. view.ts wires the result into the form
// (disabling Save, showing the message).
import { FormState, Scenario, ScenarioKey } from "./valuationStore";

// The only fields that actually differ between bull/base/bear — everything
// else is a shared company/market fact, edited only on the Base tab. Kept in
// sync with the identical set in view.ts (SCENARIO_SPECIFIC_FIELDS), which
// governs which fields the form itself lets Bull/Bear edit.
export const SCENARIO_SPECIFIC_FIELDS: ReadonlySet<keyof FormState> = new Set([
	"growth1to5",
	"growth6to10",
	"terminalGrowth",
	"grahamGrowth",
]);

// Display labels for SCENARIO_SPECIFIC_FIELDS, reused in violation messages
// so they read like the form rather than the raw field key.
export const SCENARIO_FIELD_LABELS: Partial<Record<keyof FormState, string>> = {
	growth1to5: "FCF growth, yrs 1-5",
	growth6to10: "FCF growth, yrs 6-10",
	terminalGrowth: "Terminal growth rate",
	grahamGrowth: "Expected EPS growth, 7-10yr",
};

// One cross-scenario check. Returns every violation message it finds (empty
// when the rule is satisfied) — not just the first — so the form can surface
// all of them at once instead of a fix-one-find-the-next cycle. Add future
// rules to SCENARIO_VALIDATORS below.
type ScenarioValidator = (scenarios: Record<ScenarioKey, Scenario>) => string[];

// Bull/base/bear represent optimistic -> expected -> pessimistic assumptions,
// so every scenario-specific growth input must stay ordered bear <= base <=
// bull. Blank/unparseable fields are skipped rather than flagged — this rule
// only applies once all three sides of the comparison are actual numbers.
function scenarioOrderingRule(scenarios: Record<ScenarioKey, Scenario>): string[] {
	const errors: string[] = [];
	for (const key of SCENARIO_SPECIFIC_FIELDS) {
		const bear = parseFloat(scenarios.bear.state[key]);
		const base = parseFloat(scenarios.base.state[key]);
		const bull = parseFloat(scenarios.bull.state[key]);
		if (isNaN(bear) || isNaN(base) || isNaN(bull)) continue;
		if (!(bear <= base && base <= bull)) {
			const label = SCENARIO_FIELD_LABELS[key] ?? key;
			errors.push(`${label}: expected Bear ≤ Base ≤ Bull, got ${bear}% / ${base}% / ${bull}%.`);
		}
	}
	return errors;
}

const SCENARIO_VALIDATORS: ScenarioValidator[] = [scenarioOrderingRule];

// Runs every registered cross-scenario rule and returns all violation
// messages found — empty when the three scenarios are internally consistent.
export function validateScenarios(scenarios: Record<ScenarioKey, Scenario>): string[] {
	return SCENARIO_VALIDATORS.flatMap((rule) => rule(scenarios));
}
