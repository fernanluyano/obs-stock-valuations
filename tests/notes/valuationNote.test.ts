import { describe, expect, it } from "vitest";
import { parseProps } from "../../notes/frontmatter";
import { kindOf } from "../../notes/kinds";
import { buildValuationNote, parseValuationNote, patchValuationNote } from "../../notes/valuationNote";
import { fixtureHistory, fixtureValuation } from "../helpers/valuationFixtures";

function parse(content: string) {
	return parseValuationNote(parseProps(content), content);
}

describe("buildValuationNote / parseValuationNote", () => {
	it("tags the note as a valuation, current, with the ticker as a property", () => {
		const props = parseProps(buildValuationNote("ACME", fixtureValuation()));
		expect(kindOf(props)).toBe("valuation");
		expect(props.state).toBe("current");
		expect(props.ticker).toBe("ACME");
	});

	it("round-trips every input of all three scenarios exactly as typed", () => {
		const record = fixtureValuation();
		record.scenarios.base.state.beta = "1.20"; // trailing zero must survive
		record.scenarios.base.state.fcf = ""; // blank stays blank
		record.scenarios.bull.state.price = "0.5";
		const parsed = parse(buildValuationNote("ACME", record));
		if (!parsed.ok) throw new Error(parsed.reason);

		for (const key of ["bull", "base", "bear"] as const) {
			expect(parsed.record.scenarios[key].state).toEqual(record.scenarios[key].state);
		}
		expect(parsed.issues).toEqual([]);
	});

	it("round-trips the record's own fields", () => {
		const record = fixtureValuation({
			moneyScale: "billions",
			sharesScale: "thousands",
			lastPriceRefreshAt: 1700000001234,
			researchNotePath: "Research/ACME-research.md",
		});
		const parsed = parse(buildValuationNote("ACME", record));
		if (!parsed.ok) throw new Error(parsed.reason);

		expect(parsed.ticker).toBe("ACME");
		expect(parsed.record).toMatchObject({
			moneyScale: "billions",
			sharesScale: "thousands",
			updatedAt: 1700000000000,
			lastPriceRefreshAt: 1700000001234,
			researchNotePath: "Research/ACME-research.md",
		});
	});

	it("omits optional fields that are absent", () => {
		const parsed = parse(buildValuationNote("ACME", fixtureValuation()));
		if (!parsed.ok) throw new Error(parsed.reason);
		expect("lastPriceRefreshAt" in parsed.record).toBe(false);
		expect("researchNotePath" in parsed.record).toBe(false);
		expect("history" in parsed.record).toBe(false);
	});

	it("round-trips the history at full precision, with nulls as empty cells, newest first", () => {
		const record = fixtureValuation({ history: fixtureHistory });
		const content = buildValuationNote("ACME", record);
		const parsed = parse(content);
		if (!parsed.ok) throw new Error(parsed.reason);

		expect(parsed.record.history).toEqual(fixtureHistory);
		const dataRows = content.split("\n").filter((l) => /^\| \d{10,}/.test(l));
		expect(dataRows[0].startsWith("| 1700000000000 |")).toBe(true);
		expect(dataRows[1].startsWith("| 1690000000000 |")).toBe(true);
	});

	it("reads the history oldest first even though the note lists it newest first", () => {
		const parsed = parse(buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })));
		if (!parsed.ok) throw new Error(parsed.reason);
		const ats = parsed.record.history!.map((e) => e.at);
		expect(ats).toEqual([...ats].sort((a, b) => a - b));
	});

	it("writes NaN and Infinity as empty cells, read back as null", () => {
		const record = fixtureValuation({
			history: [{ ...fixtureHistory[0], dcfBaseIv: NaN, tenCapIv: Infinity }],
		});
		const parsed = parse(buildValuationNote("ACME", record));
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.record.history![0].dcfBaseIv).toBeNull();
		expect(parsed.record.history![0].tenCapIv).toBeNull();
	});

	it("parse then patch with the same record gives back the same text", () => {
		const record = fixtureValuation({ history: fixtureHistory, researchNotePath: "R/ACME.md" });
		const content = buildValuationNote("ACME", record);
		expect(patchValuationNote(content, "ACME", record)).toBe(content);
	});
});

describe("parseValuationNote failures", () => {
	it("rejects a note with no ticker", () => {
		const parsed = parse("---\ntags: [stockvaluations/valuation]\n---\n");
		expect(parsed).toEqual({ ok: false, reason: "missing ticker property" });
	});

	it("rejects an unknown scale", () => {
		const content = buildValuationNote("ACME", fixtureValuation()).replace("moneyScale: millions", "moneyScale: dozens");
		expect(parse(content)).toEqual({ ok: false, reason: "missing or unknown moneyScale/sharesScale" });
	});

	it("rejects a missing updatedAt", () => {
		const content = buildValuationNote("ACME", fixtureValuation()).replace(/updatedAt: \d+\n/, "");
		expect(parse(content)).toEqual({ ok: false, reason: "missing updatedAt" });
	});

	it("reports a row with the wrong cell count and keeps the good rows", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })).replace(
			/\n(\| 1690000000000 .*)\n/,
			"\n| 1690000000000 | 2023-07-22 | 48 |\n"
		);
		const parsed = parse(content);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.issues).toHaveLength(1);
		expect(parsed.record.history).toHaveLength(1);
	});

	it("reports a row with an unreadable timestamp or price", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })).replace(
			"| 1700000000000 |",
			"| soon |"
		);
		const parsed = parse(content);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.issues).toEqual(["history row 1: unreadable timestamp or price"]);
		expect(parsed.record.history).toHaveLength(1);
	});

	it("reports a non-numeric value cell", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })).replace("| 60 |", "| lots |");
		const parsed = parse(content);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.issues).toEqual(['history row 1: "lots" is not a number']);
	});
});

describe("patchValuationNote", () => {
	it("rewrites only the properties and table, leaving prose and other properties alone", () => {
		const record = fixtureValuation({ history: fixtureHistory });
		let content = buildValuationNote("ACME", record);
		content = content.replace("state: current", "state: current\nmyProp: keep me");
		content += "\nSome notes the user wrote below.\n";

		const next = fixtureValuation({ history: [fixtureHistory[0]], updatedAt: 1800000000000 });
		const patched = patchValuationNote(content, "ACME", next);

		expect(patched).toContain("myProp: keep me");
		expect(patched).toContain("Some notes the user wrote below.");
		expect(patched).toContain("updatedAt: 1800000000000");
		const parsed = parse(patched);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.record.history).toEqual([fixtureHistory[0]]);
	});

	it("removes an optional property that is no longer set", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ researchNotePath: "R/ACME.md" }));
		const patched = patchValuationNote(content, "ACME", fixtureValuation());
		expect(patched).not.toContain("researchNotePath");
	});

	it("appends the history table when the note has none", () => {
		const bare = "---\ntags: [stockvaluations/valuation]\nstate: current\n---\n\nJust prose.\n";
		const patched = patchValuationNote(bare, "ACME", fixtureValuation({ history: fixtureHistory }));
		expect(patched).toContain("Just prose.");
		const parsed = parse(patched);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.record.history).toEqual(fixtureHistory);
	});

	it("refuses to write when a row is unreadable", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })).replace(
			"| 1700000000000 | ",
			"| 1700000000000 | extra | "
		);
		expect(() => patchValuationNote(content, "ACME", fixtureValuation())).toThrow(/unreadable row/);
	});

	it("refuses to write a history table with other columns", () => {
		const content = buildValuationNote("ACME", fixtureValuation({ history: fixtureHistory })).replace("| Price |", "| Cost |");
		expect(() => patchValuationNote(content, "ACME", fixtureValuation())).toThrow(/unexpected columns/);
	});
});
