// The portable settings <-> <folder>/Settings.md. historyNotesFolder is deliberately not here: it
// says where this note lives, so it stays in the device-local data.json.
import type { StockValuationsSettings } from "../settings";
import { bool, buildNote, patchProps, str, type Props, type RawProps } from "./frontmatter";
import { NOTE_TAGS } from "./kinds";
import { SCALE_OPTIONS, type ScaleUnit } from "../units";

export type PortableSettings = Omit<StockValuationsSettings, "historyNotesFolder">;

function num(props: RawProps, key: string): number | undefined {
	const v = props[key];
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

function scale(props: RawProps, key: string): ScaleUnit | undefined {
	const v = str(props, key);
	return SCALE_OPTIONS.find((o) => o === v);
}

// Anything missing or unreadable falls back to the default, so a hand-damaged value never blocks loading.
export function parseSettingsProps(props: RawProps, defaults: PortableSettings): PortableSettings {
	return {
		marketRiskPremium: num(props, "marketRiskPremium") ?? defaults.marketRiskPremium,
		taxRate: num(props, "taxRate") ?? defaults.taxRate,
		maintenanceCapexPct: num(props, "maintenanceCapexPct") ?? defaults.maintenanceCapexPct,
		defaultMoneyScale: scale(props, "defaultMoneyScale") ?? defaults.defaultMoneyScale,
		defaultSharesScale: scale(props, "defaultSharesScale") ?? defaults.defaultSharesScale,
		enableResearchLinks: bool(props, "enableResearchLinks") ?? defaults.enableResearchLinks,
		researchNotesFolder: str(props, "researchNotesFolder") ?? defaults.researchNotesFolder,
	};
}

function settingsProps(settings: PortableSettings): Props {
	return {
		marketRiskPremium: settings.marketRiskPremium,
		taxRate: settings.taxRate,
		maintenanceCapexPct: settings.maintenanceCapexPct,
		defaultMoneyScale: settings.defaultMoneyScale,
		defaultSharesScale: settings.defaultSharesScale,
		enableResearchLinks: settings.enableResearchLinks,
		researchNotesFolder: settings.researchNotesFolder,
	};
}

export function buildSettingsNote(settings: PortableSettings): string {
	return buildNote({ tags: [NOTE_TAGS.settings], state: "current", ...settingsProps(settings) }, "");
}

export function patchSettingsNote(content: string, settings: PortableSettings): string {
	return patchProps(content, settingsProps(settings));
}
