import { describe, expect, it } from "vitest";
import {
	calcDcf,
	calcDcfGrid,
	calcGraham,
	calcGrahamGrid,
	calcTenCap,
	calcTenCapGrid,
	calcWacc,
	marginOfSafety,
	ownerEarningsYield,
} from "../calculations";

describe("calcWacc", () => {
	it("blends cost of equity and after-tax cost of debt by market weight", () => {
		const wacc = calcWacc({
			rfr: 0.04,
			mrp: 0.05,
			beta: 1.2,
			intExp: 100,
			totDebt: 1000,
			taxRate: 0.25,
			mktCap: 9000,
		});
		// costOfEquity = 0.04 + 1.2*0.05 = 0.1
		// costOfDebt = 100/1000 = 0.1, afterTax = 0.1*0.75 = 0.075
		// weights: equity 0.9, debt 0.1
		// wacc = 0.9*0.1 + 0.1*0.075 = 0.0975
		expect(wacc).toBeCloseTo(0.0975, 10);
	});

	it("returns 0 cost of debt when there is no debt", () => {
		const wacc = calcWacc({
			rfr: 0.04,
			mrp: 0.05,
			beta: 1,
			intExp: 0,
			totDebt: 0,
			taxRate: 0.25,
			mktCap: 1000,
		});
		expect(wacc).toBeCloseTo(0.09, 10);
	});

	it("returns 0 when both market cap and debt are 0", () => {
		const wacc = calcWacc({
			rfr: 0.04,
			mrp: 0.05,
			beta: 1,
			intExp: 0,
			totDebt: 0,
			taxRate: 0.25,
			mktCap: 0,
		});
		expect(wacc).toBe(0);
	});
});

describe("calcDcf", () => {
	it("matches a hand-computed value for simple flat-growth inputs", () => {
		// Flat 0% growth in every phase, wacc 10%, so this reduces to a level
		// perpetuity check on the terminal value piece plus 10 discounted years.
		const iv = calcDcf({
			netDebt: 0,
			shares: 100,
			growth1to5: 0,
			growth6to10: 0,
			terminalGrowth: 0.02,
			wacc: 0.1,
			fcf: 1000,
		});

		let prevFcf = 1000;
		let sumPv = 0;
		let yearFcf = 1000;
		for (let year = 1; year <= 10; year++) {
			yearFcf = prevFcf * 1;
			sumPv += yearFcf / Math.pow(1.1, year);
			prevFcf = yearFcf;
		}
		const terminalValue = (yearFcf * 1.02) / (0.1 - 0.02);
		const pvTerminalValue = terminalValue / Math.pow(1.1, 10);
		const expected = (sumPv + pvTerminalValue - 0) / 100;

		expect(iv).toBeCloseTo(expected, 8);
	});

	it("subtracts net debt from enterprise value before dividing by shares", () => {
		const withoutDebt = calcDcf({
			netDebt: 0,
			shares: 100,
			growth1to5: 0.05,
			growth6to10: 0.03,
			terminalGrowth: 0.02,
			wacc: 0.09,
			fcf: 500,
		});
		const withDebt = calcDcf({
			netDebt: 1000,
			shares: 100,
			growth1to5: 0.05,
			growth6to10: 0.03,
			terminalGrowth: 0.02,
			wacc: 0.09,
			fcf: 500,
		});
		expect(withDebt).toBeCloseTo(withoutDebt - 10, 8); // 1000 / 100 shares
	});

	it("returns NaN when shares is 0", () => {
		const iv = calcDcf({
			netDebt: 0,
			shares: 0,
			growth1to5: 0.05,
			growth6to10: 0.03,
			terminalGrowth: 0.02,
			wacc: 0.09,
			fcf: 500,
		});
		expect(iv).toBeNaN();
	});
});

describe("calcDcfGrid", () => {
	const baseInputs = {
		netDebt: 1000,
		shares: 100,
		growth1to5: 0.1,
		growth6to10: 0.05,
		terminalGrowth: 0.025,
		wacc: 0.08,
		fcf: 500,
	};

	it("computes one calcDcf value per (growth, wacc) cell, matching calcDcf directly", () => {
		const waccValues = [0.06, 0.1];
		const growthValues = [0.05, 0.15];
		const result = calcDcfGrid(baseInputs, waccValues, growthValues);

		expect(result.waccValues).toBe(waccValues);
		expect(result.growthValues).toBe(growthValues);
		growthValues.forEach((g, ri) => {
			waccValues.forEach((w, ci) => {
				const expected = calcDcf({ ...baseInputs, growth1to5: g, wacc: w });
				expect(result.grid[ri][ci]).toBeCloseTo(expected as number, 8);
			});
		});
	});

	it("returns null instead of a nonsense value where wacc <= terminalGrowth", () => {
		const result = calcDcfGrid(baseInputs, [0.02, 0.03, 0.1], [0.05]);
		// terminalGrowth is 0.025, so the 0.02 and 0.03 columns straddle it.
		expect(result.grid[0][0]).toBeNull(); // wacc 0.02 <= terminalGrowth 0.025
		expect(result.grid[0][1]).not.toBeNull(); // wacc 0.03 > terminalGrowth 0.025
		expect(result.grid[0][2]).not.toBeNull();
	});

	it("holds growth6to10/terminalGrowth/netDebt/shares/fcf fixed across the grid", () => {
		const result = calcDcfGrid(baseInputs, [0.1], [0.03, 0.2]);
		// Two rows, one column: only growth1to5 differs between the two cells,
		// so the values shouldn't collapse to the same number.
		expect(result.grid[0][0]).not.toEqual(result.grid[1][0]);
	});
});

describe("calcGraham", () => {
	it("applies the classic Graham formula", () => {
		// IV = EPS * (8.5 + 2g) * 4.4 / Y
		const iv = calcGraham({ eps: 5, growth: 0.08, aaaYield: 0.044 });
		// gPct = 8, yPct = 4.4 -> (8.5 + 16) * 4.4 / 4.4 = 24.5
		expect(iv).toBeCloseTo(5 * 24.5, 10);
	});

	it("returns NaN when the AAA yield is 0 or negative", () => {
		expect(calcGraham({ eps: 5, growth: 0.08, aaaYield: 0 })).toBeNaN();
		expect(calcGraham({ eps: 5, growth: 0.08, aaaYield: -0.01 })).toBeNaN();
	});
});

describe("calcGrahamGrid", () => {
	const baseInputs = { eps: 5, growth: 0.08, aaaYield: 0.044 };

	it("computes one calcGraham value per (growth, yield) cell, matching calcGraham directly", () => {
		const yieldValues = [0.035, 0.05];
		const growthValues = [0.05, 0.15];
		const result = calcGrahamGrid(baseInputs, yieldValues, growthValues);

		expect(result.yieldValues).toBe(yieldValues);
		expect(result.growthValues).toBe(growthValues);
		growthValues.forEach((g, ri) => {
			yieldValues.forEach((y, ci) => {
				const expected = calcGraham({ ...baseInputs, growth: g, aaaYield: y });
				expect(result.grid[ri][ci]).toBeCloseTo(expected, 10);
			});
		});
	});

	it("returns null instead of NaN where yield <= 0", () => {
		const result = calcGrahamGrid(baseInputs, [-0.01, 0, 0.04], [0.05]);
		expect(result.grid[0][0]).toBeNull();
		expect(result.grid[0][1]).toBeNull();
		expect(result.grid[0][2]).not.toBeNull();
	});

	it("holds eps fixed across the grid — higher growth always means higher fair value", () => {
		const result = calcGrahamGrid(baseInputs, [0.04], [0.05, 0.2]);
		expect(result.grid[1][0]!).toBeGreaterThan(result.grid[0][0]!);
	});
});

describe("calcTenCap", () => {
	it("computes owner earnings and 10x intrinsic value per share", () => {
		const result = calcTenCap({ ocf: 1000, capex: 400, mainPct: 0.5, shares: 100 });
		// ownerEarnings = 1000 - 400*0.5 = 800
		// iv = (800/100)*10 = 80
		expect(result.ownerEarnings).toBe(800);
		expect(result.iv).toBe(80);
	});

	it("returns NaN intrinsic value when shares is 0", () => {
		const result = calcTenCap({ ocf: 1000, capex: 400, mainPct: 0.5, shares: 0 });
		expect(result.ownerEarnings).toBe(800);
		expect(result.iv).toBeNaN();
	});
});

describe("calcTenCapGrid", () => {
	const baseInputs = { ocf: 1000, capex: 400, mainPct: 0.5, shares: 100 };

	it("computes one calcTenCap value per (mainPct, capex multiplier) cell, matching calcTenCap directly", () => {
		const capexMultipliers = [0.8, 1.2];
		const mainPctValues = [0.2, 0.8];
		const result = calcTenCapGrid(baseInputs, capexMultipliers, mainPctValues);

		expect(result.capexMultipliers).toBe(capexMultipliers);
		expect(result.mainPctValues).toBe(mainPctValues);
		mainPctValues.forEach((mainPct, ri) => {
			capexMultipliers.forEach((mult, ci) => {
				const expected = calcTenCap({ ...baseInputs, capex: baseInputs.capex * mult, mainPct }).iv;
				expect(result.grid[ri][ci]).toBeCloseTo(expected, 10);
			});
		});
	});

	it("holds ocf/shares fixed — a multiplier of 1 matches the reported capex exactly", () => {
		const result = calcTenCapGrid(baseInputs, [1], [0.5]);
		expect(result.grid[0][0]).toBeCloseTo(calcTenCap(baseInputs).iv, 10);
	});

	it("higher maintenance % or higher capex both push fair value down", () => {
		// mainPct 0 would zero out capex's effect entirely, so use a nonzero
		// baseline (0.5) to isolate each axis's effect independently.
		const result = calcTenCapGrid(baseInputs, [0.6, 1.4], [0.5, 1]);
		// row 0 = mainPct 0.5, row 1 = mainPct 1, both at capex multiplier 0.6
		expect(result.grid[1][0]).toBeLessThan(result.grid[0][0]);
		// col 0 = 0.6x capex, col 1 = 1.4x capex, both at mainPct 0.5
		expect(result.grid[0][1]).toBeLessThan(result.grid[0][0]);
	});
});

describe("marginOfSafety", () => {
	it("computes the % discount of price to intrinsic value", () => {
		expect(marginOfSafety(100, 60)).toBeCloseTo(40, 10);
		expect(marginOfSafety(100, 120)).toBeCloseTo(-20, 10);
	});

	it("returns NaN for a non-finite or zero intrinsic value", () => {
		expect(marginOfSafety(NaN, 60)).toBeNaN();
		expect(marginOfSafety(0, 60)).toBeNaN();
		expect(marginOfSafety(Infinity, 60)).toBeNaN();
	});
});

describe("ownerEarningsYield", () => {
	it("computes owner earnings per share as a % of price", () => {
		// 800 owner earnings / 100 shares / $40 price = 20%
		expect(ownerEarningsYield(800, 100, 40)).toBeCloseTo(20, 10);
	});

	it("returns NaN when shares or price is 0", () => {
		expect(ownerEarningsYield(800, 0, 40)).toBeNaN();
		expect(ownerEarningsYield(800, 100, 0)).toBeNaN();
	});
});
