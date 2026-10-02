import { PAYBACK_MAX_YEARS } from "./calculations";

// Strips a typed value down to a plain numeric string (digits, one leading "-",
// one ".") — used while an input is focused, so raw typing isn't fighting comma
// insertion mid-keystroke.
export function sanitizeNumericInput(raw: string): string {
	let s = raw.replace(/[^0-9.-]/g, "");
	const neg = s.startsWith("-");
	s = s.replace(/-/g, "");
	const firstDot = s.indexOf(".");
	if (firstDot !== -1) {
		s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
	}
	return (neg ? "-" : "") + s;
}

// Inserts thousands separators into a raw numeric string for display (e.g. on
// blur), without touching precision — "13182.5" -> "13,182.5".
export function formatWithCommas(raw: string): string {
	if (!raw) return raw;
	const neg = raw.startsWith("-");
	const unsigned = neg ? raw.slice(1) : raw;
	const [intPart, fracPart] = unsigned.split(".");
	if (!intPart) return raw;
	const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return (neg ? "-" : "") + formattedInt + (fracPart !== undefined ? "." + fracPart : "");
}

// The formatters below check with Number.isFinite, never the global
// isFinite: the global one coerces first, so isFinite(null) is true (null ->
// 0), and a null that slipped in from JSON (where NaN is stored as null)
// would get past it and crash on null.toLocaleString(). Number.isFinite is
// false for anything that isn't already a real, finite number.

// Comma-formats a computed number for display (results table, inserted note).
export function formatCurrency(value: number, decimals = 2): string {
	if (!Number.isFinite(value)) return "—";
	return `$${value.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})}`;
}

export function formatPercent(value: number, decimals = 2): string {
	if (!Number.isFinite(value)) return "—";
	return `${value.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})}%`;
}

// Payback Time display: NaN (no positive FCF to pay anything back) is "—";
// Infinity means it never paid back within PAYBACK_MAX_YEARS, shown as a
// floor ("> 30 yrs") rather than a made-up number.
export function formatYears(value: number, decimals = 1): string {
	if (value === Infinity) return `> ${PAYBACK_MAX_YEARS} yrs`;
	if (!Number.isFinite(value)) return "—";
	return `${value.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})} yrs`;
}
