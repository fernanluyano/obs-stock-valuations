// One ticker's saved valuation <-> its vault note (<folder>/TICKER.md). The note is the source of
// truth: the properties hold every input of the Bull/Base/Bear cases plus the record's own fields,
// the body table holds the history. Results are never stored — they're rebuilt from the inputs on
// load. Pure text in, pure text out, so it's unit tested without Obsidian.
import type { FormState, HistoryEntry, HistoryIv, SavedValuation, Scenario, ScenarioKey } from "../valuationStore";
import { SCALE_OPTIONS, type ScaleUnit } from "../units";
import { formatRow } from "../table/cells";
import { parseTable } from "../table/parse";
import { serializeTable } from "../table/serialize";
import { buildNote, int, patchProps, str, type Props, type RawProps } from "./frontmatter";
import { NOTE_TAGS } from "./kinds";

export const SCENARIO_KEYS: ScenarioKey[] = ["bull", "base", "bear"];

// A Record (not an array) so adding a FormState field without listing it here is a compile error.
const FORM_FIELDS: Record<keyof FormState, true> = {
	ticker: true,
	price: true,
	shares: true,
	rfr: true,
	mrp: true,
	beta: true,
	intExp: true,
	totDebt: true,
	taxRate: true,
	mktCap: true,
	netDebt: true,
	growth1to5: true,
	growth6to10: true,
	terminalGrowth: true,
	fcf: true,
	eps: true,
	grahamGrowth: true,
	aaaYield: true,
	ocf: true,
	capex: true,
	mainPct: true,
	dps: true,
	ddmGrowth: true,
};

// The ticker is the note's own identity (one property), so it isn't repeated per scenario.
const SCENARIO_FIELDS = (Object.keys(FORM_FIELDS) as (keyof FormState)[]).filter((f) => f !== "ticker");

const IV_COLUMNS = [
	["DCF Bear", "dcfBearIv"],
	["DCF Base", "dcfBaseIv"],
	["DCF Bull", "dcfBullIv"],
	["Graham Bear", "grahamBearIv"],
	["Graham Base", "grahamBaseIv"],
	["Graham Bull", "grahamBullIv"],
	["Ten Cap", "tenCapIv"],
	["Reverse DCF", "impliedGrowth"],
	["DDM Bear", "ddmBearIv"],
	["DDM Base", "ddmBaseIv"],
	["DDM Bull", "ddmBullIv"],
] as const;

// "At" (epoch ms) is the exact timestamp the history round-trips on; "Date" is only for reading.
const HISTORY_HEADER = ["At", "Date", "Price", ...IV_COLUMNS.map(([label]) => label)];

export type ParsedValuationNote =
	| { ok: true; ticker: string; record: SavedValuation; issues: string[] }
	| { ok: false; reason: string };

function scenarioKey(scenario: ScenarioKey, field: string): string {
	return `${scenario}_${field}`;
}

function valuationProps(ticker: string, record: SavedValuation): Props {
	const props: Props = {
		ticker,
		moneyScale: record.moneyScale,
		sharesScale: record.sharesScale,
		updatedAt: record.updatedAt,
		lastPriceRefreshAt: record.lastPriceRefreshAt,
		researchNotePath: record.researchNotePath,
	};
	for (const scenario of SCENARIO_KEYS) {
		const state = record.scenarios[scenario].state;
		for (const field of SCENARIO_FIELDS) props[scenarioKey(scenario, field)] = state[field];
	}
	return props;
}

function localDate(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// NaN, Infinity and null all have no value in a table cell; they read back as null.
function numberCell(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function historyRows(record: SavedValuation): string[][] {
	return [...(record.history ?? [])]
		.sort((a, b) => b.at - a.at)
		.map((e) => [String(e.at), localDate(e.at), numberCell(e.price), ...IV_COLUMNS.map(([, key]) => numberCell(e[key]))]);
}

function renderTable(rows: string[][]): string {
	const separator = `|${HISTORY_HEADER.map(() => "---").join("|")}|`;
	return [formatRow(HISTORY_HEADER), separator, ...rows.map(formatRow)].join("\n") + "\n";
}

function newBody(ticker: string, record: SavedValuation): string {
	return [
		"",
		`# ${ticker} — valuation`,
		"",
		"Managed by the Stock Valuations plugin: the properties above hold this ticker's inputs, the table below its history (one row per saved valuation or price refresh, at most one per day, newest first). Edit it through the plugin — rows that can't be read stop the plugin from saving this note.",
		"",
		renderTable(historyRows(record)),
	].join("\n");
}

export function buildValuationNote(ticker: string, record: SavedValuation): string {
	return buildNote({ tags: [NOTE_TAGS.valuation], state: "current", ...valuationProps(ticker, record) }, newBody(ticker, record));
}

// Rewrites only the properties it owns and the history table; prose around them stays as is.
// Throws rather than overwrite a table it can't fully read.
export function patchValuationNote(content: string, ticker: string, record: SavedValuation): string {
	const patched = patchProps(content, valuationProps(ticker, record));
	const table = parseTable(patched, HISTORY_HEADER[0]);
	const rows = historyRows(record);
	if (!table) return patched.replace(/\n*$/, "\n\n") + renderTable(rows);
	if (table.header.join("|") !== HISTORY_HEADER.join("|")) {
		throw new Error("Refusing to write: the history table has unexpected columns");
	}
	table.rows = rows.map((cells) => ({ cells }));
	return serializeTable(table);
}

function emptyResults(): Scenario["results"] {
	return {
		wacc: 0,
		costOfEquity: 0,
		dcfIv: 0,
		dcfMos: 0,
		impliedGrowth: 0,
		grahamIv: 0,
		grahamMos: 0,
		tenCapIv: 0,
		tenCapYield: 0,
		tenCapMos: 0,
		ddmIv: 0,
		ddmMos: 0,
		paybackYears: 0,
	};
}

function parseScenario(props: RawProps, scenario: ScenarioKey, ticker: string): Scenario {
	const state = { ticker } as FormState;
	for (const field of SCENARIO_FIELDS) state[field] = str(props, scenarioKey(scenario, field)) ?? "";
	// Placeholder only: DataRepository rebuilds every scenario's results from its state right after load.
	return { state, results: emptyResults() };
}

function isScale(value: string | undefined): value is ScaleUnit {
	return SCALE_OPTIONS.includes(value as ScaleUnit);
}

function parseHistory(content: string, issues: string[]): HistoryEntry[] {
	const table = parseTable(content, HISTORY_HEADER[0]);
	if (!table) return [];
	for (const issue of table.issues) issues.push(`line ${issue.line}: ${issue.reason}`);
	const entries: HistoryEntry[] = [];
	table.rows.forEach((row, i) => {
		if (row.cells.length !== table.header.length) return;
		const line = i;
		const at = Number(row.cells[0]);
		const price = Number(row.cells[2]);
		if (!Number.isSafeInteger(at) || row.cells[2] === "" || !Number.isFinite(price)) {
			issues.push(`history row ${line + 1}: unreadable timestamp or price`);
			return;
		}
		const entry = { at, price } as Record<string, number | HistoryIv>;
		for (const [j, [, key]] of IV_COLUMNS.entries()) {
			const cell = row.cells[3 + j];
			const value = Number(cell);
			if (cell === "") entry[key] = null;
			else if (Number.isFinite(value)) entry[key] = value;
			else {
				issues.push(`history row ${line + 1}: "${cell}" is not a number`);
				return;
			}
		}
		entries.push(entry as unknown as HistoryEntry);
	});
	return entries;
}

// A note that can't give a ticker and valid scales is skipped and reported by the caller; row-level
// problems still load the good rows and come back as issues (the note then refuses to be rewritten).
export function parseValuationNote(props: RawProps, content: string): ParsedValuationNote {
	const ticker = str(props, "ticker")?.trim();
	if (!ticker) return { ok: false, reason: "missing ticker property" };
	const moneyScale = str(props, "moneyScale");
	const sharesScale = str(props, "sharesScale");
	if (!isScale(moneyScale) || !isScale(sharesScale)) return { ok: false, reason: "missing or unknown moneyScale/sharesScale" };
	const updatedAt = int(props, "updatedAt");
	if (updatedAt === undefined) return { ok: false, reason: "missing updatedAt" };

	const issues: string[] = [];
	const scenarios = {} as Record<ScenarioKey, Scenario>;
	for (const key of SCENARIO_KEYS) scenarios[key] = parseScenario(props, key, ticker);

	const record: SavedValuation = { scenarios, moneyScale, sharesScale, updatedAt };
	const lastPriceRefreshAt = int(props, "lastPriceRefreshAt");
	if (lastPriceRefreshAt !== undefined) record.lastPriceRefreshAt = lastPriceRefreshAt;
	const researchNotePath = str(props, "researchNotePath");
	if (researchNotePath) record.researchNotePath = researchNotePath;
	const history = parseHistory(content, issues);
	if (history.length > 0) record.history = history;
	return { ok: true, ticker, record, issues };
}
