import { App, TFile } from "obsidian";
import { parseProps } from "../notes/frontmatter";
import { isInFolder } from "../notes/paths";
import { ensureFolderExists } from "../noteSync";
import type { VaultNote, VaultPort } from "./VaultPort";

// The only place that touches Obsidian's vault API. Properties are parsed from the note text on
// every listing rather than read from the metadataCache: the cache updates asynchronously after a
// write (and may not be ready at startup), and a stale read would show wrong data.
export class ObsidianVault implements VaultPort {
	constructor(private app: App) {}

	// Only the plugin's own folder is read, so the cost does not grow with the rest of the vault.
	async listNotes(folder: string): Promise<VaultNote[]> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => isInFolder(file.path, folder));
		return Promise.all(
			files.map(async (file) => ({
				path: file.path,
				props: parseProps(await this.app.vault.read(file)),
			})),
		);
	}

	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.read(file) : null;
	}

	exists(path: string): boolean {
		return this.app.vault.getFileByPath(path) !== null;
	}

	async create(path: string, content: string): Promise<void> {
		await ensureFolderExists(this.app, path);
		await this.app.vault.create(path, content);
	}

	async modify(path: string, fn: (content: string) => string): Promise<string> {
		return this.app.vault.process(this.require(path), fn);
	}

	async trash(path: string): Promise<void> {
		await this.app.fileManager.trashFile(this.require(path));
	}

	private require(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`No such file: ${path}`);
		return file;
	}
}
