// Scale of the raw numbers a user types in (e.g. "13182" meaning $13,182 thousand
// vs. $13,182 million vs. $13,182 billion). Calculations always run in raw dollars/
// shares internally — the chosen scale is just a multiplier applied on the way in,
// so results are correct regardless of which convention a given filing uses.
export type ScaleUnit = "ones" | "thousands" | "millions" | "billions";

export const SCALE_MULTIPLIERS: Record<ScaleUnit, number> = {
	ones: 1,
	thousands: 1e3,
	millions: 1e6,
	billions: 1e9,
};

export const SCALE_LABELS: Record<ScaleUnit, string> = {
	ones: "Ones",
	thousands: "Thousands",
	millions: "Millions",
	billions: "Billions",
};

export const SCALE_OPTIONS: ScaleUnit[] = ["ones", "thousands", "millions", "billions"];
