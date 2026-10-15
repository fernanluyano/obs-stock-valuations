import { list, str, type RawProps } from "./frontmatter";

export const NOTE_TAGS = {
	valuation: "stockvaluations/valuation",
	settings: "stockvaluations/settings",
} as const;

export type NoteKind = keyof typeof NOTE_TAGS;

export const NOTE_KINDS = Object.keys(NOTE_TAGS) as NoteKind[];

export type NoteState = "current" | "in_transit";

export function hasTag(props: RawProps, tag: string): boolean {
	return list(props, "tags").some((t) => t.replace(/^#/, "") === tag);
}

export function kindOf(props: RawProps): NoteKind | null {
	return NOTE_KINDS.find((kind) => hasTag(props, NOTE_TAGS[kind])) ?? null;
}

// A missing or unknown state reads as current, so a note without the property still counts.
export function stateOf(props: RawProps): NoteState {
	return str(props, "state") === "in_transit" ? "in_transit" : "current";
}
