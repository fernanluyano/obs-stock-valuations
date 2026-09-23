import { App, TFile } from "obsidian";
import { ValuationTable } from "./valuationStore";
import { buildNoteContent } from "./noteContent";

// Regenerates the whole note from scratch on every call — this is the vault-
// visible mirror of the plugin's own data, not something meant to be hand-edited.
export async function syncValuationsNote(
	app: App,
	path: string,
	valuations: ValuationTable,
	includeResearchColumn: boolean
): Promise<void> {
	const content = buildNoteContent(valuations, includeResearchColumn);
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
