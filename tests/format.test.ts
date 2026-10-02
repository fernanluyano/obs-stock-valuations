import { describe, expect, it } from "vitest";
import { formatCurrency, formatPercent, formatWithCommas, formatYears, sanitizeNumericInput } from "../format";

describe("sanitizeNumericInput", () => {
	it("strips non-numeric characters", () => {
		expect(sanitizeNumericInput("$13,182.5abc")).toBe("13182.5");
	});

	it("keeps only a single leading minus sign", () => {
		expect(sanitizeNumericInput("-13-182")).toBe("-13182");
		expect(sanitizeNumericInput("1-3")).toBe("13");
	});

	it("keeps only the first decimal point", () => {
		expect(sanitizeNumericInput("1.2.3")).toBe("1.23");
	});

	it("combines a leading minus with a single decimal point", () => {
		expect(sanitizeNumericInput("-1,234.5.6")).toBe("-1234.56");
	});

	it("returns an empty string unchanged", () => {
		expect(sanitizeNumericInput("")).toBe("");
	});
});

describe("formatWithCommas", () => {
	it("inserts thousands separators", () => {
		expect(formatWithCommas("13182.5")).toBe("13,182.5");
		expect(formatWithCommas("1234567")).toBe("1,234,567");
	});

	it("preserves a negative sign", () => {
		expect(formatWithCommas("-13182.5")).toBe("-13,182.5");
	});

	it("leaves numbers under 1000 unchanged", () => {
		expect(formatWithCommas("182.5")).toBe("182.5");
	});

	it("passes through empty or integer-less strings unchanged", () => {
		expect(formatWithCommas("")).toBe("");
		expect(formatWithCommas(".5")).toBe(".5");
	});
});

describe("formatCurrency", () => {
	it("formats a positive number with a $ prefix and 2 decimals by default", () => {
		expect(formatCurrency(1234.5)).toBe(
			`$${(1234.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
		);
	});

	it("respects a custom decimals argument", () => {
		expect(formatCurrency(1234.5, 0)).toBe(
			`$${(1234.5).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
		);
	});

	it("renders an em dash for non-finite values", () => {
		expect(formatCurrency(NaN)).toBe("—");
		expect(formatCurrency(Infinity)).toBe("—");
	});

	// JSON stores NaN as null; the global isFinite(null) is true (null -> 0),
	// which used to let null through to null.toLocaleString() and crash the
	// vault note write.
	it("renders an em dash for null/undefined instead of throwing", () => {
		expect(formatCurrency(null as unknown as number)).toBe("—");
		expect(formatCurrency(undefined as unknown as number)).toBe("—");
	});
});

describe("formatPercent", () => {
	it("formats a number with a trailing % and 2 decimals by default", () => {
		expect(formatPercent(12.5)).toBe(
			`${(12.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
		);
	});

	it("renders an em dash for non-finite values", () => {
		expect(formatPercent(NaN)).toBe("—");
		expect(formatPercent(-Infinity)).toBe("—");
	});

	it("renders an em dash for null/undefined instead of throwing", () => {
		expect(formatPercent(null as unknown as number)).toBe("—");
		expect(formatPercent(undefined as unknown as number)).toBe("—");
	});
});

describe("formatYears", () => {
	it("formats to one decimal with a yrs suffix", () => {
		expect(formatYears(7.444)).toBe("7.4 yrs");
		expect(formatYears(0)).toBe("0.0 yrs");
	});

	it("shows a floor for Infinity (never paid back within the cap)", () => {
		expect(formatYears(Infinity)).toBe("> 30 yrs");
	});

	it("shows an em dash for NaN (no positive FCF)", () => {
		expect(formatYears(NaN)).toBe("—");
	});

	it("shows an em dash for null/undefined and -Infinity, never the > 30 yrs floor", () => {
		expect(formatYears(null as unknown as number)).toBe("—");
		expect(formatYears(undefined as unknown as number)).toBe("—");
		expect(formatYears(-Infinity)).toBe("—");
	});
});
