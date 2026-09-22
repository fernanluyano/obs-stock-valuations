import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { StockValuationsView, VIEW_TYPE_STOCK_VALUATIONS } from "./view";
import {
	DEFAULT_SETTINGS,
	researchLinksActive,
	StockValuationsSettings,
	StockValuationsSettingTab,
} from "./settings";
import { ValuationTable } from "./valuationStore";
import { syncValuationsNote } from "./noteSync";

interface PluginData {
	settings: StockValuationsSettings;
	valuations: ValuationTable;
	lastSeenVersion?: string;
}

export default class StockValuationsPlugin extends Plugin {
	settings!: StockValuationsSettings;
	valuations!: ValuationTable;
	private lastSeenVersion: string | undefined;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.registerView(
			VIEW_TYPE_STOCK_VALUATIONS,
			(leaf) => new StockValuationsView(leaf, this)
		);

		this.addRibbonIcon("landmark", "Stock valuations", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-valuation-calculator",
			name: "Open calculator",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "open-valuation-docs",
			name: "Open help & methodology",
			callback: async () => {
				const view = await this.activateView();
				view.openDocs();
			},
		});

		this.addSettingTab(new StockValuationsSettingTab(this.app, this));

		// Deferred to onLayoutReady rather than run inline here — opening a new
		// leaf while Obsidian is still restoring the workspace on startup can
		// fight with that restoration.
		this.app.workspace.onLayoutReady(() => {
			void this.maybeShowChangelog();
		});
	}

	// Shows the current version's release notes exactly once, the first time
	// the plugin loads after an update — never on first install, and never
	// the full history, just whatever version was just landed on.
	private async maybeShowChangelog(): Promise<void> {
		const currentVersion = this.manifest.version;
		const isUpdate = this.lastSeenVersion !== undefined && this.lastSeenVersion !== currentVersion;

		if (this.lastSeenVersion !== currentVersion) {
			this.lastSeenVersion = currentVersion;
			await this.persist();
		}

		if (isUpdate) {
			const view = await this.activateView();
			view.openChangelog(currentVersion);
		}
	}

	async activateView(): Promise<StockValuationsView> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_STOCK_VALUATIONS);
		const leaf: WorkspaceLeaf =
			existing.length > 0 ? existing[0] : workspace.getLeaf(true);

		if (existing.length === 0) {
			await leaf.setViewState({ type: VIEW_TYPE_STOCK_VALUATIONS, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view as StockValuationsView;
	}

	async loadPluginData(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
		this.valuations = data.valuations ?? {};
		this.lastSeenVersion = data.lastSeenVersion;
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	async saveValuations(): Promise<void> {
		await this.persist();
		try {
			await syncValuationsNote(
				this.app,
				this.settings.valuationsNotePath,
				this.valuations,
				researchLinksActive(this.settings)
			);
		} catch (e) {
			console.error("Stock Valuations: failed to write summary note", e);
			new Notice("Saved, but couldn't update the vault summary note — check the note path in settings.");
		}
	}

	private async persist(): Promise<void> {
		const data: PluginData = { settings: this.settings, valuations: this.valuations, lastSeenVersion: this.lastSeenVersion };
		await this.saveData(data);
	}
}
