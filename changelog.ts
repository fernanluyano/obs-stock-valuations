// Hand-maintained "What's new" copy, one entry per released version — same
// manual-upkeep approach as docs.ts. Add a new entry (newest first) whenever
// a version is released via `make release`; nothing here bumps itself.
export interface ChangelogEntry {
	version: string;
	highlights: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
	{
		version: "0.4.0",
		highlights: [
			'🔄 New "Refresh prices" button on the table — updates every ticker\'s price in one click, and the vault summary note along with it',
			"🧮 Market cap is now always computed as price × shares, so it — and WACC, and DCF IV — stay accurate automatically instead of needing a manual edit",
			"📱 Fixed action icons (edit, delete, research links) not rendering on mobile",
			"✨ This \"What's new\" screen — shows once after an update, same as what you're reading right now",
		],
	},
	{
		version: "0.3.0",
		highlights: [
			"🔗 Link a research note to any ticker straight from the table",
			"⚙️ Release automation and a CI test step, so every release is tested before it ships",
		],
	},
	{
		version: "0.2.1",
		highlights: [
			"📊 The margin-of-safety chart now caps at −100% and stays centered on zero, so one outlier ticker can't blow out the scale for the rest",
		],
	},
	{
		version: "0.2.0",
		highlights: [
			'📥 "Fetch data" now pulls fundamentals (EPS, cash flow, debt, shares, tax rate) from SEC EDGAR, alongside price from Yahoo Finance',
			"✨ Various calculator UI improvements",
		],
	},
	{
		version: "0.1.3",
		highlights: ["🐛 Fixed a compatibility issue opening the calculator on older Obsidian versions"],
	},
	{
		version: "0.1.2",
		highlights: ["🐛 Fixed remaining community-plugin health-check issues"],
	},
	{
		version: "0.1.1",
		highlights: ["📝 Cleaned up the plugin description for the community plugin directory"],
	},
	{
		version: "0.1.0",
		highlights: [
			"🎉 Initial release — WACC, DCF, Graham, and Ten Cap intrinsic value calculators, tracked in a vault summary note",
		],
	},
];

export function getChangelogEntry(version: string): ChangelogEntry | undefined {
	return CHANGELOG.find((e) => e.version === version);
}
