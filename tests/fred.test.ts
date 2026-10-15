import { describe, expect, it } from "vitest";
import { parseLatestFredValue } from "../fred";

describe("parseLatestFredValue", () => {
	it("returns the last numeric row", () => {
		expect(parseLatestFredValue("observation_date,DAAA\n2026-10-13,6.17\n2026-10-14,6.15\n")).toBe(6.15);
	});

	it("skips trailing empty and '.' rows", () => {
		expect(parseLatestFredValue("observation_date,DAAA\n2026-10-13,6.17\n2026-10-14,\n2026-10-15,.")).toBe(6.17);
	});

	it("handles CRLF line endings", () => {
		expect(parseLatestFredValue("date,DAAA\r\n2026-10-13,6.17\r\n")).toBe(6.17);
	});

	it("returns null when there is no data", () => {
		expect(parseLatestFredValue("observation_date,DAAA\n")).toBeNull();
		expect(parseLatestFredValue("")).toBeNull();
		expect(parseLatestFredValue("<html>error</html>")).toBeNull();
	});
});
