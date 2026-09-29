import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { StockValuationsView, VIEW_TYPE_STOCK_VALUATIONS } from "./view";
import {
	DEFAULT_SETTINGS,
	researchLinksActive,
	StockValuationsSettingTab,
} from "./settings";
import { syncValuationsNote } from "./noteSync";
import { DataRepository } from "./dataRepository";

export default class StockValuationsPlugin extends Plugin {
	data!: DataRepository;

	async onload(): Promise<void> {
		this.data = new DataRepository(
			this,
			DEFAULT_SETTINGS,
			(valuations) =>
				syncValuationsNote(
					this.app,
					this.data.settings.valuationsNotePath,
					valuations,
					researchLinksActive(this.data.settings)
				),
			(_e) =>
				new Notice("Saved, but couldn't update the vault summary note — check the note path in settings.")
		);
		await this.data.load();

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
		const isUpdate = this.data.lastSeenVersion !== undefined && this.data.lastSeenVersion !== currentVersion;

		if (this.data.lastSeenVersion !== currentVersion) {
			this.data.lastSeenVersion = currentVersion;
			await this.data.saveSettings();
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
}
