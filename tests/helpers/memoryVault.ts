import { parseProps } from "../../notes/frontmatter";
import { isInFolder } from "../../notes/paths";
import type { VaultNote, VaultPort } from "../../storage/VaultPort";

type Op = "create" | "modify" | "trash";

// An in-memory vault whose properties are parsed from content on every listing. `failOn` injects
// a one-shot error to exercise partial-failure paths; the counters let a test prove what a
// startup did (and did not) touch.
export class MemoryVault implements VaultPort {
	files = new Map<string, string>();
	trashed: string[] = [];
	created: string[] = [];
	modified: string[] = [];
	existsCalls = 0;
	listCalls = 0;
	readCalls = 0;
	private failures = new Map<string, Error>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	failOn(op: Op, path: string, error = new Error(`${op} failed: ${path}`)): void {
		this.failures.set(`${op}:${path}`, error);
	}

	private maybeFail(op: Op, path: string): void {
		const key = `${op}:${path}`;
		const error = this.failures.get(key);
		if (!error) return;
		this.failures.delete(key);
		throw error;
	}

	async listNotes(folder: string): Promise<VaultNote[]> {
		this.listCalls++;
		return [...this.files.keys()]
			.filter((p) => p.endsWith(".md") && isInFolder(p, folder))
			.sort()
			.map((path) => ({ path, props: parseProps(this.files.get(path)!) }));
	}

	async read(path: string): Promise<string | null> {
		this.readCalls++;
		return this.files.get(path) ?? null;
	}

	exists(path: string): boolean {
		this.existsCalls++;
		return this.files.has(path);
	}

	async create(path: string, content: string): Promise<void> {
		this.maybeFail("create", path);
		if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
		this.files.set(path, content);
		this.created.push(path);
	}

	async modify(path: string, fn: (content: string) => string): Promise<string> {
		this.maybeFail("modify", path);
		const current = this.files.get(path);
		if (current === undefined) throw new Error(`No such file: ${path}`);
		const next = fn(current);
		this.files.set(path, next);
		this.modified.push(path);
		return next;
	}

	async trash(path: string): Promise<void> {
		this.maybeFail("trash", path);
		if (!this.files.delete(path)) throw new Error(`No such file: ${path}`);
		this.trashed.push(path);
	}
}
