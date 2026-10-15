export function splitCells(line: string): string[] {
	const trimmed = line.trim();
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			cell += "|";
			i++;
		} else if (ch === "|") {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell.trim());
	// The leading and trailing pipes produce an empty cell at each end.
	if (trimmed.startsWith("|")) cells.shift();
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) cells.pop();
	return cells;
}

export function formatRow(cells: string[]): string {
	return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

const SEPARATOR_CELL_RE = /^:?-+:?$/;

export function isSeparator(line: string): boolean {
	if (!line.trim().startsWith("|")) return false;
	const cells = splitCells(line);
	return cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c));
}
