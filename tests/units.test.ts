import { describe, expect, it } from "vitest";
import { SCALE_LABELS, SCALE_MULTIPLIERS, SCALE_OPTIONS, type ScaleUnit } from "../units";

describe("SCALE_MULTIPLIERS", () => {
	it("maps each scale to the correct power of ten", () => {
		expect(SCALE_MULTIPLIERS.ones).toBe(1);
		expect(SCALE_MULTIPLIERS.thousands).toBe(1e3);
		expect(SCALE_MULTIPLIERS.millions).toBe(1e6);
		expect(SCALE_MULTIPLIERS.billions).toBe(1e9);
	});
});

describe("SCALE_LABELS and SCALE_OPTIONS", () => {
	it("has a label for every scale option", () => {
		for (const unit of SCALE_OPTIONS) {
			expect(SCALE_LABELS[unit]).toBeTruthy();
		}
	});

	it("has a multiplier for every scale option", () => {
		for (const unit of SCALE_OPTIONS) {
			expect(SCALE_MULTIPLIERS[unit]).toBeTypeOf("number");
		}
	});

	it("keeps SCALE_OPTIONS and SCALE_MULTIPLIERS/SCALE_LABELS in sync", () => {
		const optionSet = new Set<ScaleUnit>(SCALE_OPTIONS);
		expect(optionSet).toEqual(new Set(Object.keys(SCALE_MULTIPLIERS)));
		expect(optionSet).toEqual(new Set(Object.keys(SCALE_LABELS)));
	});
});
