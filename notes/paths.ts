// Vault folder paths never carry a trailing slash, and blank means the vault root.
export function normalizeFolder(folder: string): string {
	return folder.trim().replace(/\/+$/, "");
}

function join(folder: string, filename: string): string {
	const base = normalizeFolder(folder);
	return base ? `${base}/${filename}` : filename;
}

export function valuationNotePath(folder: string, ticker: string): string {
	return join(folder, `${ticker}.md`);
}

export function settingsNotePath(folder: string): string {
	return join(folder, "Settings.md");
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

// Notes under a folder, at any depth; a blank folder (the vault root) only covers the top level,
// so a root-level setup never reads the rest of the vault.
export function isInFolder(path: string, folder: string): boolean {
	const base = normalizeFolder(folder);
	return base ? path.startsWith(`${base}/`) : !path.includes("/");
}
