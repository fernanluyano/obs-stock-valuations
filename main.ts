import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { StockValuationsView, VIEW_TYPE_STOCK_VALUATIONS } from "./view";
import { DEFAULT_SETTINGS, StockValuationsSettingTab } from "./settings";
import { ObsidianVault } from "./storage/ObsidianVault";
import { DataRepository } from "./dataRepository";
import { fetchAaaYield, fetchRiskFreeRate } from "./priceProvider";
import { fetchMacroData, fetchMarketData } from "./macro";
import { isInFolder } from "./notes/paths";
import { createReloadScheduler } from "./storage/reloadScheduler";

const RELOAD_DELAY_MS = 500;

export default class StockValuationsPlugin extends Plugin {
	data!: DataRepository;
	// False until the notes have been read at startup (see onload); views show
	// a loading state meanwhile instead of an empty list.
	dataLoaded = false;

	async onload(): Promise<void> {
		this.data = new DataRepository(
			this,
			DEFAULT_SETTINGS,
			new ObsidianVault(this.app),
			// The failure isn't necessarily the path — any error while reading
			// or writing a note lands here — so say what failed and include the
			// actual error rather than guessing at a cause. The note is the
			// data, so unlike before this isn't a "saved anyway" case.
			(e, subject) =>
				new Notice(
					`Stock Valuations: problem with ${subject}: ${e instanceof Error ? e.message : String(e)}`,
					10000
				),
			fetchRiskFreeRate,
			fetchMacroData,
			fetchMarketData,
			fetchAaaYield
		);
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

		// Deferred to onLayoutReady rather than run inline here. The notes are the
		// data, and on a cold start (mobile especially) the vault isn't indexed
		// yet while onload runs, so reading them here finds nothing. Also, opening
		// a new leaf while Obsidian is still restoring the workspace on startup
		// can fight with that restoration.
		this.app.workspace.onLayoutReady(() => {
			void this.loadDataAndRefreshViews();
		});
	}

	private async loadDataAndRefreshViews(): Promise<void> {
		try {
			await this.data.load();
		} catch (e) {
			console.error("Stock Valuations: failed to load data", e);
			new Notice(
				`Stock Valuations: failed to load data: ${e instanceof Error ? e.message : String(e)}`,
				10000
			);
			return;
		}
		this.dataLoaded = true;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_STOCK_VALUATIONS)) {
			if (leaf.view instanceof StockValuationsView) leaf.view.onDataLoaded();
		}
		this.watchExternalChanges();
		await this.maybeShowChangelog();
	}

	// Edits synced in from another device arrive as ordinary file events, so the
	// notes are re-read from disk. Registered only after the first load: before
	// that Obsidian emits a create event for every file in the vault.
	private watchExternalChanges(): void {
		const scheduler = createReloadScheduler(async () => {
			await this.data.reloadNotes();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_STOCK_VALUATIONS)) {
				if (leaf.view instanceof StockValuationsView) leaf.view.onExternalChange();
			}
		}, RELOAD_DELAY_MS);
		const touch = (...paths: string[]): void => {
			const folder = this.data.settings.historyNotesFolder;
			if (paths.some((p) => isInFolder(p, folder))) scheduler.notify();
		};
		const { vault } = this.app;
		this.registerEvent(vault.on("modify", (f) => touch(f.path)));
		this.registerEvent(vault.on("create", (f) => touch(f.path)));
		this.registerEvent(vault.on("delete", (f) => touch(f.path)));
		this.registerEvent(vault.on("rename", (f, oldPath) => touch(f.path, oldPath)));
		this.register(() => scheduler.cancel());
	}

	// Shows the current version's release notes exactly once, the first time
	// the plugin loads after an update — never on first install, and never
	// the full history, just whatever version was just landed on.
	private async maybeShowChangelog(): Promise<void> {
		const currentVersion = this.manifest.version;
		const isUpdate = this.data.lastSeenVersion !== undefined && this.data.lastSeenVersion !== currentVersion;

		if (this.data.lastSeenVersion !== currentVersion) {
			this.data.lastSeenVersion = currentVersion;
			await this.data.saveLocalState();
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
