// Properties come from two places: Obsidian's metadataCache (already parsed, untyped) and our own
// reader over note text. Accessors take `unknown` values so both feed the same code.
export type PropValue = string | number | boolean | string[];
export type Props = Record<string, PropValue | undefined>;
export type RawProps = Record<string, unknown>;

interface Split {
	lines: string[];
	rest: string;
	eol: string;
}

const KEY_LINE_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const LIST_ITEM_RE = /^[ \t]+-[ \t]+(.*)$/;
const INTEGER_RE = /^-?\d+$/;
const NEEDS_QUOTES_RE = /^[-?:,[\]{}#&*!|>'"%@`\s]|: | #|:$|\s$|[,\]]/;
const RESERVED_RE = /^(true|false|null|yes|no|on|off|~)$/i;
const NUMERIC_LOOKING_RE = /^-?\d+(\.\d+)?$/;

function split(content: string): Split | null {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(eol);
	if (lines[0].trimEnd() !== "---") return null;
	const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
	if (close < 0) return null;
	return { lines: lines.slice(1, close), rest: lines.slice(close + 1).join(eol), eol };
}

export function parseScalar(raw: string): PropValue {
	const text = raw.trim();
	if (text.startsWith('"')) {
		const end = closingQuote(text);
		const inner = text.slice(1, end < 0 ? undefined : end);
		try {
			return JSON.parse(`"${inner}"`) as string;
		} catch {
			return inner;
		}
	}
	if (text.startsWith("'")) {
		const end = closingSingleQuote(text);
		return text.slice(1, end < 0 ? undefined : end).replace(/''/g, "'");
	}
	const uncommented = text.replace(/\s+#.*$/, "");
	if (uncommented.startsWith("[") && uncommented.endsWith("]")) return parseInlineList(uncommented.slice(1, -1));
	if (uncommented === "true") return true;
	if (uncommented === "false") return false;
	if (INTEGER_RE.test(uncommented) && Number.isSafeInteger(Number(uncommented))) return Number(uncommented);
	return uncommented;
}

function closingQuote(text: string): number {
	for (let i = 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === '"') return i;
	}
	return -1;
}

// A doubled quote inside single quotes is an escaped quote, not the end of the string.
function closingSingleQuote(text: string): number {
	for (let i = 1; i < text.length; i++) {
		if (text[i] !== "'") continue;
		if (text[i + 1] === "'") i++;
		else return i;
	}
	return -1;
}

function parseInlineList(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const ch of inner) {
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
		} else if (ch === ",") {
			items.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	items.push(current);
	return items.map((i) => String(parseScalar(i))).filter((i) => i !== "");
}

export function parseProps(content: string): RawProps {
	const parts = split(content);
	if (!parts) return {};
	const props: RawProps = {};
	for (let i = 0; i < parts.lines.length; i++) {
		const m = KEY_LINE_RE.exec(parts.lines[i].replace(/\r$/, ""));
		if (!m) continue;
		const [, key, value] = m;
		if (value !== "") {
			props[key] = parseScalar(value);
			continue;
		}
		const items: string[] = [];
		while (i + 1 < parts.lines.length && LIST_ITEM_RE.test(parts.lines[i + 1])) {
			i++;
			items.push(String(parseScalar(LIST_ITEM_RE.exec(parts.lines[i])![1])));
		}
		props[key] = items.length > 0 ? items : "";
	}
	return props;
}

function formatString(text: string): string {
	const risky = text === "" || NEEDS_QUOTES_RE.test(text) || RESERVED_RE.test(text) || NUMERIC_LOOKING_RE.test(text);
	return risky ? JSON.stringify(text) : text;
}

export function formatValue(value: PropValue): string {
	if (Array.isArray(value)) return `[${value.map(formatString).join(", ")}]`;
	if (typeof value === "string") return formatString(value);
	return String(value);
}

function formatLines(props: Props): string[] {
	return Object.entries(props)
		.filter((e): e is [string, PropValue] => e[1] !== undefined)
		.map(([key, value]) => `${key}: ${formatValue(value)}`);
}

export function buildNote(props: Props, body: string): string {
	return `---\n${formatLines(props).join("\n")}\n---\n${body}`;
}

// Edits only the keys in `patch`, in place; every other line, in and out of the block, stays as is.
// An undefined value removes the key.
export function patchProps(content: string, patch: Props): string {
	const parts = split(content);
	if (!parts) return buildNote(patch, content);

	const lines = [...parts.lines];
	for (const [key, value] of Object.entries(patch)) {
		const at = lines.findIndex((l) => KEY_LINE_RE.exec(l.replace(/\r$/, ""))?.[1] === key);
		const replacement = value === undefined ? [] : [`${key}: ${formatValue(value)}`];
		if (at < 0) {
			lines.push(...replacement);
			continue;
		}
		let end = at + 1;
		while (end < lines.length && LIST_ITEM_RE.test(lines[end])) end++;
		lines.splice(at, end - at, ...replacement);
	}
	return ["---", ...lines, "---", parts.rest].join(parts.eol);
}

export function str(props: RawProps, key: string): string | undefined {
	const v = props[key];
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	return undefined;
}

export function int(props: RawProps, key: string): number | undefined {
	const v = props[key];
	if (typeof v === "number" && Number.isSafeInteger(v)) return v;
	if (typeof v === "string" && INTEGER_RE.test(v.trim()) && Number.isSafeInteger(Number(v))) return Number(v);
	return undefined;
}

export function bool(props: RawProps, key: string): boolean | undefined {
	const v = props[key];
	if (typeof v === "boolean") return v;
	if (v === "true") return true;
	if (v === "false") return false;
	return undefined;
}

// Obsidian can hand back `tags` as a list or as one comma/space separated string.
export function list(props: RawProps, key: string): string[] {
	const v = props[key];
	if (Array.isArray(v)) return v.map(String);
	if (typeof v === "string") return v.split(/[,\s]+/).filter((s) => s !== "");
	return [];
}
