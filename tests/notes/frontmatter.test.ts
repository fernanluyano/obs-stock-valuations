import { describe, expect, it } from "vitest";
import {
	bool, buildNote, formatValue, int, list, parseProps, parseScalar, patchProps, str,
} from "../../notes/frontmatter";

describe("parseScalar", () => {
	it("reads booleans, integers and bare strings", () => {
		expect(parseScalar("true")).toBe(true);
		expect(parseScalar("false")).toBe(false);
		expect(parseScalar("-8450")).toBe(-8450);
		expect(parseScalar("2026-10-02")).toBe("2026-10-02");
		expect(parseScalar("Cash Main")).toBe("Cash Main");
	});

	it("keeps unsafe integers as strings", () => {
		expect(parseScalar("99999999999999999999")).toBe("99999999999999999999");
	});

	it("strips trailing comments from bare values only", () => {
		expect(parseScalar("current   # current | in_transit")).toBe("current");
		expect(parseScalar('"a # b"')).toBe("a # b");
	});

	it("reads double and single quoted strings", () => {
		expect(parseScalar('"say \\"hi\\""')).toBe('say "hi"');
		expect(parseScalar("'it''s'")).toBe("it's");
		expect(parseScalar('"2026"')).toBe("2026");
	});

	it("tolerates unterminated quotes and bad escapes", () => {
		expect(parseScalar('"open')).toBe("open");
		expect(parseScalar("'open")).toBe("open");
		expect(parseScalar('"a\\qb"')).toBe("a\\qb");
	});

	it("reads inline lists with quoted items and commas inside quotes", () => {
		expect(parseScalar("[nestegg/account]")).toEqual(["nestegg/account"]);
		expect(parseScalar('[a, "b, c", \'d\']')).toEqual(["a", "b, c", "d"]);
		expect(parseScalar("[]")).toEqual([]);
	});
});

describe("parseProps", () => {
	it("returns nothing without a frontmatter block", () => {
		expect(parseProps("no block\nname: x")).toEqual({});
		expect(parseProps("---\nname: x\nno close")).toEqual({});
	});

	it("reads a block with every value type", () => {
		const text = [
			"---", "tags: [nestegg/account]", "state: current  # note", "name: Cash Main",
			"active: true", "enteredBalanceCents: 200000", "enteredBalanceAsOf: 2026-10-02", "---", "body",
		].join("\n");
		expect(parseProps(text)).toEqual({
			tags: ["nestegg/account"], state: "current", name: "Cash Main", active: true,
			enteredBalanceCents: 200000, enteredBalanceAsOf: "2026-10-02",
		});
	});

	it("reads block lists and ignores lines it does not understand", () => {
		const text = "---\ntags:\n  - one\n  - two\n  garbage line\nname: x\n\n---\n";
		expect(parseProps(text)).toEqual({ tags: ["one", "two"], name: "x" });
	});

	it("reads an empty value as an empty string", () => {
		expect(parseProps("---\nname:\n---\n")).toEqual({ name: "" });
	});

	it("handles CRLF files", () => {
		expect(parseProps("---\r\nname: x\r\ntags: [a]\r\n---\r\nbody")).toEqual({ name: "x", tags: ["a"] });
	});
});

describe("formatValue", () => {
	it("writes plain values bare", () => {
		expect(formatValue("Cash Main")).toBe("Cash Main");
		expect(formatValue("2026-10-02")).toBe("2026-10-02");
		expect(formatValue(5)).toBe("5");
		expect(formatValue(false)).toBe("false");
		expect(formatValue(["nestegg/account", "x"])).toBe("[nestegg/account, x]");
	});

	it("quotes strings that would read back as something else", () => {
		for (const text of ["", "2026", "-5", "1.5", "true", "No", "null", "a: b", "a #b", " lead", "trail ", "#tag", "[x]", "a, b", "ends:"]) {
			const written = formatValue(text);
			expect(written.startsWith('"')).toBe(true);
			expect(parseScalar(written)).toBe(text);
		}
	});

	it("round trips list items that need quotes", () => {
		const items = ["a, b", "plain", "x]y"];
		expect(parseScalar(formatValue(items))).toEqual(items);
	});
});

describe("buildNote", () => {
	it("writes the block, skipping undefined values, then the body", () => {
		expect(buildNote({ name: "Food", skip: undefined, active: true }, "\nbody\n")).toBe("---\nname: Food\nactive: true\n---\n\nbody\n");
	});
});

describe("patchProps", () => {
	const note = "---\ntags: [nestegg/account]\nname: Cash\nbalanceCents: 5   # cache\nextra: keep me\n---\n\n| T |\n";

	it("replaces a key in place and leaves everything else byte for byte", () => {
		expect(patchProps(note, { balanceCents: 10 })).toBe(note.replace("balanceCents: 5   # cache", "balanceCents: 10"));
	});

	it("appends new keys at the end of the block", () => {
		expect(patchProps(note, { transitFor: "a/b.md" })).toBe(note.replace("---\n\n|", "transitFor: a/b.md\n---\n\n|"));
	});

	it("removes a key when the value is undefined", () => {
		expect(patchProps(note, { extra: undefined })).not.toContain("extra");
		expect(patchProps(note, { missing: undefined })).toBe(note);
	});

	it("replaces a block list with the new value", () => {
		const text = "---\ntags:\n  - a\n  - b\nname: x\n---\nbody";
		expect(patchProps(text, { tags: ["c"] })).toBe("---\ntags: [c]\nname: x\n---\nbody");
	});

	it("creates a block when the note has none", () => {
		expect(patchProps("just body", { name: "x" })).toBe("---\nname: x\n---\njust body");
	});

	it("keeps CRLF line endings", () => {
		const crlf = "---\r\nname: a\r\n---\r\nbody\r\n";
		expect(patchProps(crlf, { name: "b" })).toBe("---\r\nname: b\r\n---\r\nbody\r\n");
	});

	it("round trips through parseProps", () => {
		expect(parseProps(patchProps(note, { name: "2026", balanceCents: -3 }))).toMatchObject({ name: "2026", balanceCents: -3 });
	});
});

describe("typed accessors", () => {
	const props = { s: "x", n: 5, ns: " 7 ", b: true, bs: "false", list: ["a", 2], csv: "a, b  c", bad: {} };

	it("str accepts strings and numbers only", () => {
		expect(str(props, "s")).toBe("x");
		expect(str(props, "n")).toBe("5");
		expect(str(props, "b")).toBeUndefined();
		expect(str(props, "none")).toBeUndefined();
	});

	it("int accepts safe integers and numeric strings", () => {
		expect(int(props, "n")).toBe(5);
		expect(int(props, "ns")).toBe(7);
		expect(int({ n: 1.5 }, "n")).toBeUndefined();
		expect(int(props, "s")).toBeUndefined();
		expect(int({ n: "99999999999999999999" }, "n")).toBeUndefined();
	});

	it("bool accepts booleans and their string forms", () => {
		expect(bool(props, "b")).toBe(true);
		expect(bool(props, "bs")).toBe(false);
		expect(bool({ b: "true" }, "b")).toBe(true);
		expect(bool(props, "s")).toBeUndefined();
	});

	it("list accepts arrays and separated strings", () => {
		expect(list(props, "list")).toEqual(["a", "2"]);
		expect(list(props, "csv")).toEqual(["a", "b", "c"]);
		expect(list(props, "bad")).toEqual([]);
		expect(list(props, "none")).toEqual([]);
	});
});
