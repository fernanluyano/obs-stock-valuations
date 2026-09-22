import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroupItem, TFolder } from "obsidian";
import type StockValuationsPlugin from "./main";
import { SCALE_LABELS, SCALE_OPTIONS, ScaleUnit } from "./units";

// Vault folder paths never carry a trailing slash — "investing" and
// "investing/" refer to the same folder, but Vault.getAbstractFileByPath()
// treats them as different strings, so a trailing slash would otherwise
// read as "doesn't exist" even when it does.
function normalizeFolderPath(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

type NumberSettingKey = "riskFreeRate" | "marketRiskPremium" | "taxRate" | "maintenanceCapexPct" | "aaaBondYield";

type ScaleSettingKey = "defaultMoneyScale" | "defaultSharesScale";

// Macro-level assumptions that rarely change between stocks. Per-stock numbers
// (beta, EPS, FCF, shares, debt, price, ...) are entered fresh on every run.
// All rates below are stored and entered as percentages (4 means 4%), matching how
// they're normally quoted — not as decimals. The calculator divides by 100 internally.
export interface StockValuationsSettings {
	riskFreeRate: number; // 10-year Treasury yield, %
	marketRiskPremium: number; // %
	taxRate: number; // effective tax rate, used as a WACC fallback if never fetched or typed, %
	maintenanceCapexPct: number; // Ten Cap's MainPct, %
	aaaBondYield: number; // Graham's Y, %
	defaultMoneyScale: ScaleUnit; // default scale for dollar aggregates (debt, FCF, OCF, ...)
	defaultSharesScale: ScaleUnit; // default scale for share counts
	valuationsNotePath: string; // vault path to the auto-generated summary note

	// Optional features — off by default, this being the first. Each one is a
	// self-contained toggle; add more here rather than growing new top-level
	// settings sections per feature.
	enableResearchLinks: boolean; // shows a Research link column/cell; the linked note's format is never read or required
	researchNotesFolder: string; // vault folder new research notes are created in; required (no default) to activate the link above
}

export const DEFAULT_SETTINGS: StockValuationsSettings = {
	riskFreeRate: 4.5,
	marketRiskPremium: 5,
	taxRate: 21,
	maintenanceCapexPct: 50,
	aaaBondYield: 5,
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	valuationsNotePath: "Stock Valuations/Stock Valuations.md",
	enableResearchLinks: false,
	researchNotesFolder: "",
};

// The research-links feature needs both the toggle on and a folder to create
// notes in — there's no shipped default folder, so the toggle alone isn't
// enough. Shared by the table view and the vault summary note so both agree
// on when the Research column is actually showing.
export function researchLinksActive(settings: StockValuationsSettings): boolean {
	return settings.enableResearchLinks && settings.researchNotesFolder.trim().length > 0;
}

export class StockValuationsSettingTab extends PluginSettingTab {
	plugin: StockValuationsPlugin;

	constructor(app: App, plugin: StockValuationsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Vault summary note").setHeading();
		new Setting(containerEl)
			.setName("Note path")
			.setDesc(
				"Vault path to the auto-generated summary table (folders are created automatically). Rewritten in full on every save or delete — don't hand-edit it, changes there won't stick."
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.valuationsNotePath)
					.setValue(this.plugin.settings.valuationsNotePath)
					.onChange(async (value) => {
						this.plugin.settings.valuationsNotePath = value.trim() || DEFAULT_SETTINGS.valuationsNotePath;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default units")
			.setDesc(
				"The scale your dollar figures and share counts are typically entered in. Overridable per calculation; price and EPS are always actual per-share dollars."
			)
			.setHeading();

		this.scaleSetting(
			"Money scale",
			"Applies to debt, market cap, FCF, OCF, capex, interest expense, net debt.",
			"defaultMoneyScale"
		);
		this.scaleSetting("Share count scale", "Applies to diluted shares outstanding.", "defaultSharesScale");

		new Setting(containerEl)
			.setName("Default assumptions")
			.setDesc(
				"Pre-filled into the valuation calculator, except Tax rate — that field is left blank so \"Fetch data\" can always fill it in from SEC EDGAR; this value is used only as a fallback if you leave it blank and never fetch. Per-stock numbers (beta, EPS, shares, debt, price, ...) are always entered fresh."
			)
			.setHeading();

		this.numberSetting(
			"Risk-free rate (RFR, %)",
			"10-year US Treasury yield, as a percentage (e.g. 4 = 4%).",
			"riskFreeRate"
		);
		this.numberSetting(
			"Market risk premium (MRP, %)",
			"As a percentage (e.g. 5 = 5%).",
			"marketRiskPremium"
		);
		this.numberSetting(
			"Tax rate (%)",
			"Effective tax rate used in the WACC after-tax cost of debt, as a percentage.",
			"taxRate"
		);
		this.numberSetting(
			"Maintenance capex (%)",
			"Share of total capex treated as maintenance (vs. growth) capex, as a percentage, for the Ten Cap owner earnings calc.",
			"maintenanceCapexPct"
		);
		this.numberSetting(
			"AAA corporate bond yield (%)",
			"Current AAA corporate bond yield, as a percentage, for the Graham formula.",
			"aaaBondYield"
		);

		new Setting(containerEl)
			.setName("Optional features")
			.setDesc("Off by default. This is the first entry — a home for future opt-in additions too.")
			.setHeading();

		new Setting(containerEl)
			.setName("Link research notes")
			.setDesc(
				"Adds a Research link to each saved valuation, pointing at any vault note you choose. Nothing about the note's contents or format is read or required."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableResearchLinks).onChange(async (value) => {
					this.plugin.settings.enableResearchLinks = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.enableResearchLinks) {
			new Setting(containerEl)
				.setName("Research notes folder")
				.setDesc(
					"Vault folder new research notes are created in. Required to activate the Research column above — left blank, the column stays hidden rather than falling back to a guessed location."
				)
				.addText((text) =>
					text
						.setPlaceholder("e.g. investing/research")
						.setValue(this.plugin.settings.researchNotesFolder)
						.onChange(async (value) => {
							const trimmed = normalizeFolderPath(value);
							this.plugin.settings.researchNotesFolder = trimmed;
							await this.plugin.saveSettings();
							this.warnAboutResearchFolder(trimmed);
						})
				);
		}
	}

	// Debounced so this doesn't fire a Notice on every keystroke — both
	// settings surfaces call onChange/setControlValue per keystroke, and the
	// check is only meaningful once the user pauses.
	private researchFolderWarnTimer: number | undefined;

	private warnAboutResearchFolder(path: string): void {
		if (this.researchFolderWarnTimer !== undefined) {
			window.clearTimeout(this.researchFolderWarnTimer);
		}
		this.researchFolderWarnTimer = window.setTimeout(() => {
			const warning = this.researchFolderWarning(path);
			if (warning) new Notice(warning, 8000);
		}, 600);
	}

	// Not a hard gate — createAndLinkResearchNote() (view.ts) creates the
	// folder if it's missing when you actually add a note, same as the vault
	// summary note path always has. This just flags a likely typo early.
	private researchFolderWarning(path: string): string | undefined {
		if (!path) return undefined;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFolder)) {
			return `"${path}" exists in the vault, but it's a file, not a folder.`;
		}
		if (!existing) {
			return `"${path}" doesn't exist yet — it'll be created automatically the first time you add a note there.`;
		}
		return undefined;
	}

	// ---------------------------------------------------------------------
	// Declarative settings API (Obsidian 1.13.0+) — makes these settings
	// searchable from the global settings search. Ignored entirely by older
	// Obsidian versions, which fall back to display() above unchanged.
	// ---------------------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Vault summary note",
				items: [
					{
						name: "Note path",
						desc: "Vault path to the auto-generated summary table (folders are created automatically). Rewritten in full on every save or delete — don't hand-edit it, changes there won't stick.",
						control: {
							type: "text",
							key: "valuationsNotePath",
							placeholder: DEFAULT_SETTINGS.valuationsNotePath,
							defaultValue: DEFAULT_SETTINGS.valuationsNotePath,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Default units",
				items: [
					this.scaleDefinition(
						"Money scale",
						"Applies to debt, market cap, FCF, OCF, capex, interest expense, net debt.",
						"defaultMoneyScale"
					),
					this.scaleDefinition(
						"Share count scale",
						"Applies to diluted shares outstanding.",
						"defaultSharesScale"
					),
				],
			},
			{
				type: "group",
				heading: "Default assumptions",
				items: [
					this.numberDefinition(
						"Risk-free rate (RFR, %)",
						"10-year US Treasury yield, as a percentage (e.g. 4 = 4%).",
						"riskFreeRate"
					),
					this.numberDefinition(
						"Market risk premium (MRP, %)",
						"As a percentage (e.g. 5 = 5%).",
						"marketRiskPremium"
					),
					this.numberDefinition(
						"Tax rate (%)",
						"Effective tax rate used in the WACC after-tax cost of debt, as a percentage.",
						"taxRate"
					),
					this.numberDefinition(
						"Maintenance capex (%)",
						"Share of total capex treated as maintenance (vs. growth) capex, as a percentage, for the Ten Cap owner earnings calc.",
						"maintenanceCapexPct"
					),
					this.numberDefinition(
						"AAA corporate bond yield (%)",
						"Current AAA corporate bond yield, as a percentage, for the Graham formula.",
						"aaaBondYield"
					),
				],
			},
			{
				type: "group",
				heading: "Optional features",
				items: [
					{
						name: "Link research notes",
						desc: "Adds a Research link to each saved valuation, pointing at any vault note you choose. Nothing about the note's contents or format is read or required.",
						control: {
							type: "toggle",
							key: "enableResearchLinks",
							defaultValue: DEFAULT_SETTINGS.enableResearchLinks,
						},
					},
					{
						name: "Research notes folder",
						desc: "Vault folder new research notes are created in. Required to activate the Research column above — left blank, the column stays hidden rather than falling back to a guessed location.",
						visible: () => this.plugin.settings.enableResearchLinks,
						control: {
							type: "text",
							key: "researchNotesFolder",
							placeholder: "e.g. investing/research",
							defaultValue: DEFAULT_SETTINGS.researchNotesFolder,
						},
					},
				],
			},
		];
	}

	// Explicit overrides (rather than relying on the framework defaults) so
	// persistence always goes through saveSettings() — this plugin's data.json
	// stores { settings, valuations } together, not settings alone.
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	setControlValue(key: string, value: unknown): void {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "valuationsNotePath") {
			const trimmed = typeof value === "string" ? value.trim() : "";
			settings[key] = trimmed || DEFAULT_SETTINGS.valuationsNotePath;
		} else if (key === "researchNotesFolder") {
			const trimmed = typeof value === "string" ? normalizeFolderPath(value) : "";
			settings[key] = trimmed;
			this.warnAboutResearchFolder(trimmed);
		} else {
			settings[key] = value;
		}
		void this.plugin.saveSettings();
	}

	private numberDefinition(name: string, desc: string, key: NumberSettingKey): SettingGroupItem {
		return {
			name,
			desc,
			control: {
				type: "number",
				key,
				placeholder: String(DEFAULT_SETTINGS[key]),
				defaultValue: DEFAULT_SETTINGS[key],
			},
		};
	}

	private scaleDefinition(name: string, desc: string, key: ScaleSettingKey): SettingGroupItem {
		return {
			name,
			desc,
			control: {
				type: "dropdown",
				key,
				options: Object.fromEntries(SCALE_OPTIONS.map((opt) => [opt, SCALE_LABELS[opt]])),
				defaultValue: DEFAULT_SETTINGS[key],
			},
		};
	}

	private numberSetting(name: string, desc: string, key: NumberSettingKey): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS[key]))
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						if (!isNaN(parsed)) {
							this.plugin.settings[key] = parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	private scaleSetting(name: string, desc: string, key: ScaleSettingKey): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dropdown) => {
				for (const opt of SCALE_OPTIONS) {
					dropdown.addOption(opt, SCALE_LABELS[opt]);
				}
				dropdown.setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value as ScaleUnit;
					await this.plugin.saveSettings();
				});
			});
	}
}
