import { App, TFile } from "obsidian";
import { SavedValuation } from "./valuationStore";
import { buildHistoryNoteContent, historyNotePath } from "./noteContent";

// Regenerates one ticker's history note from scratch — the vault-visible
// mirror of that ticker's own data, not something meant to be hand-edited.
// Only ever called for the ticker that actually changed, never the whole
// table.
export async function syncHistoryNote(app: App, folder: string, ticker: string, record: SavedValuation): Promise<void> {
	const path = historyNotePath(folder, ticker);
	const content = buildHistoryNoteContent(ticker, record);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return;
	}
	await ensureFolderExists(app, path);
	await app.vault.create(path, content);
}

// Shared with view.ts's "create a new research note" flow, so both places
// that create vault files use the same parent-folder handling.
export async function ensureFolderExists(app: App, filePath: string): Promise<void> {
	const folderPath = filePath.split("/").slice(0, -1).join("/");
	if (!folderPath) return;
	if (app.vault.getAbstractFileByPath(folderPath)) return;
	await app.vault.createFolder(folderPath).catch(() => {
		// Already exists or created concurrently — fine either way.
	});
}
