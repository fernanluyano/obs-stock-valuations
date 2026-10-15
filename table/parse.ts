import { isSeparator, splitCells } from "./cells";
import type { ParsedTable, TableIssue, TableRow } from "./types";

// Finds the first table whose header's first cell is `firstHeaderCell`, so other tables or prose
// in the note are never mistaken for the data. Returns null if there is no such table.
export function parseTable(content: string, firstHeaderCell: string): ParsedTable | null {
	const lines = content.split("\n");
	const start = findTableStart(lines, firstHeaderCell);
	if (start < 0) return null;

	const header = splitCells(lines[start]);
	const rows: TableRow[] = [];
	const issues: TableIssue[] = [];
	let i = start + 2;
	// A line that doesn't start with a pipe ends the table, so prose below is never parsed as rows.
	for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
		const cells = splitCells(lines[i]);
		if (cells.length !== header.length) {
			issues.push({
				line: i + 1,
				reason: `expected ${header.length} cells, found ${cells.length}`,
				text: lines[i],
			});
		}
		rows.push({ cells, raw: lines[i] });
	}

	return {
		before: lines.slice(0, start).map((l) => l + "\n").join(""),
		headerRaw: lines[start],
		separatorRaw: lines[start + 1],
		header,
		rows,
		// Keeps its leading newline so "table is the last line" and "table ends in a newline" differ.
		after: i < lines.length ? "\n" + lines.slice(i).join("\n") : "",
		issues,
	};
}

function findTableStart(lines: string[], firstHeaderCell: string): number {
	for (let i = 0; i < lines.length - 1; i++) {
		if (
			lines[i].trim().startsWith("|") &&
			splitCells(lines[i])[0] === firstHeaderCell &&
			isSeparator(lines[i + 1])
		) {
			return i;
		}
	}
	return -1;
}
