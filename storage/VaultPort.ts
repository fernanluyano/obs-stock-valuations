import type { RawProps } from "../notes/frontmatter";

export interface VaultNote {
	path: string;
	props: RawProps;
}

// Everything the plugin needs from the vault, so the logic above it runs against an in-memory
// fake in tests. The Obsidian adapter is the only implementation that touches the real API.
export interface VaultPort {
	// Every markdown note under `folder` (the vault root when blank, top level only) with its
	// properties; callers filter by tag. Nothing outside the folder is ever read.
	listNotes(folder: string): Promise<VaultNote[]>;
	read(path: string): Promise<string | null>;
	// A path lookup only, never a file read — cheap enough to call on every startup.
	exists(path: string): boolean;
	// Creates missing folders; throws if the file already exists.
	create(path: string, content: string): Promise<void>;
	// Atomic read-modify-write; returns the new content.
	modify(path: string, fn: (content: string) => string): Promise<string>;
	// Moves to the trash rather than deleting for good.
	trash(path: string): Promise<void>;
}
