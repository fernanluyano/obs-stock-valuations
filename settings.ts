import { App, PluginSettingTab, Setting } from "obsidian";
import type StockValuationsPlugin from "./main";
import { SCALE_LABELS, SCALE_OPTIONS, ScaleUnit } from "./units";

// Macro-level assumptions that rarely change between stocks. Per-stock numbers
// (beta, EPS, FCF, shares, debt, price, ...) are entered fresh on every run.
// All rates below are stored and entered as percentages (4 means 4%), matching how
// they're normally quoted — not as decimals. The calculator divides by 100 internally.
export interface StockValuationsSettings {
	riskFreeRate: number; // 10-year Treasury yield, %
	marketRiskPremium: number; // %
	taxRate: number; // effective tax rate, used as a WACC default, %
	maintenanceCapexPct: number; // Ten Cap's MainPct, %
	terminalGrowthRate: number; // DCF terminal growth, %, also used as a Year 6-10 growth default
	aaaBondYield: number; // Graham's Y, %
	defaultMoneyScale: ScaleUnit; // default scale for dollar aggregates (debt, FCF, OCF, ...)
	defaultSharesScale: ScaleUnit; // default scale for share counts
	valuationsNotePath: string; // vault path to the auto-generated summary note
}

export const DEFAULT_SETTINGS: StockValuationsSettings = {
	riskFreeRate: 4.5,
	marketRiskPremium: 5,
	taxRate: 21,
	maintenanceCapexPct: 50,
	terminalGrowthRate: 2.5,
	aaaBondYield: 5,
	defaultMoneyScale: "millions",
	defaultSharesScale: "millions",
	valuationsNotePath: "Stock Valuations/Stock Valuations.md",
};

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
				"Pre-filled into the valuation calculator. Per-stock numbers (beta, EPS, shares, debt, price, ...) are always entered fresh."
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
			"Terminal growth rate (%)",
			"DCF terminal growth rate (used past year 10), as a percentage. Also pre-fills the Year 6-10 growth field.",
			"terminalGrowthRate"
		);
		this.numberSetting(
			"AAA corporate bond yield (%)",
			"Current AAA corporate bond yield, as a percentage, for the Graham formula.",
			"aaaBondYield"
		);
	}

	private numberSetting(
		name: string,
		desc: string,
		key:
			| "riskFreeRate"
			| "marketRiskPremium"
			| "taxRate"
			| "maintenanceCapexPct"
			| "terminalGrowthRate"
			| "aaaBondYield"
	): void {
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

	private scaleSetting(
		name: string,
		desc: string,
		key: "defaultMoneyScale" | "defaultSharesScale"
	): void {
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
