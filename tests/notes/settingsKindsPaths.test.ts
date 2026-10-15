import { describe, expect, it } from "vitest";
import { parseProps } from "../../notes/frontmatter";
import { hasTag, kindOf, stateOf } from "../../notes/kinds";
import { dirname, isInFolder, normalizeFolder, settingsNotePath, valuationNotePath } from "../../notes/paths";
import { buildSettingsNote, parseSettingsProps, patchSettingsNote, type PortableSettings } from "../../notes/settingsNote";

const DEFAULTS: PortableSettings = {
	marketRiskPremium: 5,
	taxRate: 21,
	maintenanceCapexPct: 50,
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	enableResearchLinks: false,
	researchNotesFolder: "",
};

describe("settings note", () => {
	it("round-trips every portable setting", () => {
		const settings: PortableSettings = {
			marketRiskPremium: 5.5,
			taxRate: 18,
			maintenanceCapexPct: 40,
			defaultMoneyScale: "billions",
			defaultSharesScale: "thousands",
			enableResearchLinks: true,
			researchNotesFolder: "Investing/Research",
		};
		const content = buildSettingsNote(settings);
		expect(kindOf(parseProps(content))).toBe("settings");
		expect(parseSettingsProps(parseProps(content), DEFAULTS)).toEqual(settings);
	});

	it("falls back to the defaults for anything missing or unreadable", () => {
		const props = parseProps("---\ntaxRate: lots\ndefaultMoneyScale: dozens\nmarketRiskPremium: ''\n---\n");
		expect(parseSettingsProps(props, DEFAULTS)).toEqual(DEFAULTS);
	});

	it("reads numbers stored as text", () => {
		const props = parseProps('---\ntaxRate: "30"\n---\n');
		expect(parseSettingsProps(props, DEFAULTS).taxRate).toBe(30);
	});

	it("patching changes the settings and keeps unrelated lines", () => {
		const content = buildSettingsNote(DEFAULTS).replace("state: current", "state: current\nmine: yes");
		const patched = patchSettingsNote(content, { ...DEFAULTS, taxRate: 33 });
		expect(patched).toContain("mine: yes");
		expect(parseSettingsProps(parseProps(patched), DEFAULTS).taxRate).toBe(33);
	});
});

describe("kinds", () => {
	it("finds the kind from the tags list, with or without a leading hash", () => {
		expect(kindOf(parseProps("---\ntags: [stockvaluations/valuation]\n---\n"))).toBe("valuation");
		expect(kindOf(parseProps("---\ntags: [\"#stockvaluations/settings\"]\n---\n"))).toBe("settings");
		expect(kindOf(parseProps("---\ntags: [other]\n---\n"))).toBeNull();
		expect(hasTag(parseProps("---\ntags: a, stockvaluations/valuation\n---\n"), "stockvaluations/valuation")).toBe(true);
	});

	it("reads a missing or unknown state as current", () => {
		expect(stateOf(parseProps("---\nstate: in_transit\n---\n"))).toBe("in_transit");
		expect(stateOf(parseProps("---\nstate: current\n---\n"))).toBe("current");
		expect(stateOf(parseProps("---\nstate: weird\n---\n"))).toBe("current");
		expect(stateOf(parseProps("---\n---\n"))).toBe("current");
	});
});

describe("paths", () => {
	it("normalizes folders", () => {
		expect(normalizeFolder("  Investing/Notes/ ")).toBe("Investing/Notes");
		expect(normalizeFolder("   ")).toBe("");
	});

	it("builds note paths, with a blank folder meaning the vault root", () => {
		expect(valuationNotePath("Stock Valuations", "ADBE")).toBe("Stock Valuations/ADBE.md");
		expect(valuationNotePath("", "ADBE")).toBe("ADBE.md");
		expect(settingsNotePath("Stock Valuations/")).toBe("Stock Valuations/Settings.md");
		expect(settingsNotePath("")).toBe("Settings.md");
	});

	it("scopes folders: any depth under a folder, top level only at the root", () => {
		expect(isInFolder("Stock Valuations/ADBE.md", "Stock Valuations")).toBe(true);
		expect(isInFolder("Stock Valuations/sub/ADBE.md", "Stock Valuations")).toBe(true);
		expect(isInFolder("Stock Valuations 2/ADBE.md", "Stock Valuations")).toBe(false);
		expect(isInFolder("ADBE.md", "")).toBe(true);
		expect(isInFolder("Other/ADBE.md", "")).toBe(false);
	});

	it("dirname", () => {
		expect(dirname("a/b/c.md")).toBe("a/b");
		expect(dirname("c.md")).toBe("");
	});
});
