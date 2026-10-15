import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRow, splitCells } from "../../table/cells";
import { addRow, removeRow, updateCell } from "../../table/edit";
import { parseTable } from "../../table/parse";
import { serializeTable } from "../../table/serialize";

const NOTE = `---
tags: [nestegg/category]
name: Food
---

Some prose above.

| Subcategory   |
|---------------|
| Groceries     |
|  Restaurants  |
| Food - Misc   |

Notes below the table, with a | pipe.
`;

const parse = (content: string) => {
	const table = parseTable(content, "Subcategory");
	if (!table) throw new Error("table not found");
	return table;
};

describe("cells", () => {
	it("splits on unescaped pipes and trims", () => {
		expect(splitCells("|  a | b  |")).toEqual(["a", "b"]);
	});

	it("keeps empty cells", () => {
		expect(splitCells("| a |  | c |")).toEqual(["a", "", "c"]);
	});

	it("unescapes and re-escapes a pipe inside a name", () => {
		expect(splitCells("| Food \\| Drink | 5 |")).toEqual(["Food | Drink", "5"]);
		expect(formatRow(["Food | Drink", "5"])).toBe("| Food \\| Drink | 5 |");
	});
});

describe("parseTable", () => {
	it("reads rows through extra spaces and ignores prose around the table", () => {
		const table = parse(NOTE);
		expect(table.rows.map((r) => r.cells[0])).toEqual(["Groceries", "Restaurants", "Food - Misc"]);
		expect(table.issues).toEqual([]);
	});

	it("returns null when no table has the expected header", () => {
		expect(parseTable(NOTE, "Date")).toBeNull();
	});

	it("reports an unreadable row instead of dropping it", () => {
		const table = parse(NOTE.replace("| Groceries     |", "| Groceries | extra |"));
		expect(table.issues).toHaveLength(1);
		expect(table.issues[0].line).toBe(10);
		expect(table.rows).toHaveLength(3);
	});
});

describe("round trip", () => {
	it("gives back the same text for a note with prose and padded cells", () => {
		expect(serializeTable(parse(NOTE))).toBe(NOTE);
	});

	it("is stable when the table is the last thing in the file", () => {
		const note = "| Subcategory |\n|---|\n| A |";
		expect(serializeTable(parse(note))).toBe(note);
	});

	it("preserves a table with no body and CRLF line endings", () => {
		const empty = "| Subcategory |\n|---|\n";
		expect(serializeTable(parse(empty))).toBe(empty);
		const crlf = "x\r\n| Subcategory |\r\n|---|\r\n| A |\r\n";
		expect(serializeTable(parse(crlf))).toBe(crlf);
	});
});

describe("edits leave the rest of the file untouched", () => {
	it("adds a row", () => {
		const table = parse(NOTE);
		addRow(table, ["Coffee"]);
		expect(serializeTable(table)).toBe(NOTE.replace("| Food - Misc   |\n", "| Food - Misc   |\n| Coffee |\n"));
	});

	it("rejects a row with the wrong cell count", () => {
		expect(() => addRow(parse(NOTE), ["a", "b"])).toThrow();
	});

	it("renames a cell, rewriting only that row", () => {
		const table = parse(NOTE);
		updateCell(table, 0, 0, "Supermarket");
		expect(serializeTable(table)).toBe(NOTE.replace("| Groceries     |", "| Supermarket |"));
	});

	it("removes a row", () => {
		const table = parse(NOTE);
		removeRow(table, 1);
		expect(serializeTable(table)).toBe(NOTE.replace("|  Restaurants  |\n", ""));
	});
});

// Captured from Obsidian with the Advanced Tables plugin after it formatted the table (padded
// cells, widened separator, blank line added above the table) and rows were added and moved.
describe("a note edited through the Advanced Tables plugin", () => {
	const edited = readFileSync(join(__dirname, "fixtures/advanced-tables-edited.md"), "utf8");

	it("still parses, in the order the editor left the rows", () => {
		const table = parse(edited);
		expect(table.issues).toEqual([]);
		expect(table.rows.map((r) => r.cells[0])).toEqual(["Restaurants", "Groceries", "Food - Misc", "Coffee"]);
	});

	it("round-trips byte for byte", () => {
		expect(serializeTable(parse(edited))).toBe(edited);
	});

	it("keeps the escaped pipe in the prose below the table", () => {
		expect(parse(edited).after).toContain("with a \\| pipe.");
	});

	it("adds a row without reformatting the editor's padding", () => {
		const table = parse(edited);
		addRow(table, ["Snacks"]);
		expect(serializeTable(table)).toBe(edited.replace("| Coffee      |\n", "| Coffee      |\n| Snacks |\n"));
	});
});

describe("write safety", () => {
	it("refuses to write a table that has unreadable rows", () => {
		const table = parse(NOTE.replace("| Groceries     |", "| Groceries | extra |"));
		expect(() => serializeTable(table)).toThrow(/unreadable/);
	});
});
