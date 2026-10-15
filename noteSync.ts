import { App } from "obsidian";

// Shared by the vault adapter (ticker/settings notes) and view.ts's "create a new research note"
// flow, so every place that creates vault files uses the same parent-folder handling.
export async function ensureFolderExists(app: App, filePath: string): Promise<void> {
	const folderPath = filePath.split("/").slice(0, -1).join("/");
	if (!folderPath) return;
	if (app.vault.getAbstractFileByPath(folderPath)) return;
	await app.vault.createFolder(folderPath).catch(() => {
		// Already exists or created concurrently — fine either way.
	});
}
