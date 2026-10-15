import { formatRow } from "./cells";
import type { ParsedTable } from "./types";

// Refuses a table with unreadable rows so a broken table is never overwritten with a guess.
export function serializeTable(table: ParsedTable): string {
	if (table.issues.length > 0) {
		throw new Error(`Refusing to write a table with ${table.issues.length} unreadable row(s)`);
	}
	return render(table);
}

function render(table: ParsedTable): string {
	const body = table.rows.map((r) => r.raw ?? formatRow(r.cells));
	return table.before + [table.headerRaw, table.separatorRaw, ...body].join("\n") + table.after;
}
