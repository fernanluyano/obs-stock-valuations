import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReloadScheduler } from "../../storage/reloadScheduler";

describe("createReloadScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("runs once after the delay", async () => {
		const run = vi.fn(async () => {});
		const scheduler = createReloadScheduler(run, 500);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(499);
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces a burst of notifications into one run", async () => {
		const run = vi.fn(async () => {});
		const scheduler = createReloadScheduler(run, 500);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(300);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(300);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(500);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("queues exactly one more run for changes that arrive mid-reload", async () => {
		let release: () => void = () => {};
		const run = vi.fn(
			() => new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const scheduler = createReloadScheduler(run, 100);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(1);

		scheduler.notify();
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(1);

		release();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("keeps working after a failed run", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
		const scheduler = createReloadScheduler(run, 100);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(100);
		expect(error).toHaveBeenCalledTimes(1);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("cancel drops a pending run and ignores later notifications", async () => {
		const run = vi.fn(async () => {});
		const scheduler = createReloadScheduler(run, 100);
		scheduler.notify();
		scheduler.cancel();
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).not.toHaveBeenCalled();
	});

	it("cancel during a run stops the queued follow-up", async () => {
		let release: () => void = () => {};
		const run = vi.fn(
			() => new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const scheduler = createReloadScheduler(run, 100);
		scheduler.notify();
		await vi.advanceTimersByTimeAsync(100);
		scheduler.notify();
		scheduler.cancel();
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
