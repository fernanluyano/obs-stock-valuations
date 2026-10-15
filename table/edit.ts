import type { ParsedTable } from "./types";

export function addRow(table: ParsedTable, cells: string[]): void {
	if (cells.length !== table.header.length) {
		throw new Error(`Row has ${cells.length} cells, table has ${table.header.length} columns`);
	}
	table.rows.push({ cells });
}

export function removeRow(table: ParsedTable, index: number): void {
	table.rows.splice(index, 1);
}

export function updateCell(table: ParsedTable, index: number, column: number, value: string): void {
	const cells = table.rows[index].cells.slice();
	cells[column] = value;
	table.rows[index] = { cells };
}


export function replaceRow(table: ParsedTable, index: number, cells: string[]): void {
	if (cells.length !== table.header.length) {
		throw new Error(`Row has ${cells.length} cells, table has ${table.header.length} columns`);
	}
	table.rows[index] = { cells };
}
