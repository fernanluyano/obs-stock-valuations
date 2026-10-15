export interface TableRow {
	cells: string[];
	// Set only for rows read from the file; edited and new rows have none and are formatted on write.
	raw?: string;
}

export interface TableIssue {
	line: number;
	reason: string;
	text: string;
}

export interface ParsedTable {
	before: string;
	headerRaw: string;
	separatorRaw: string;
	header: string[];
	rows: TableRow[];
	after: string;
	issues: TableIssue[];
}
