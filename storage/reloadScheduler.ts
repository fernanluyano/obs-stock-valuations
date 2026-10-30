export interface ReloadScheduler {
	notify(): void;
	cancel(): void;
}

// A sync can touch many files in a burst, and the plugin's own writes echo back as vault events,
// so changes are coalesced into one reload. A change arriving mid-reload queues exactly one more,
// so the last state on disk is always the one loaded.
export function createReloadScheduler(run: () => Promise<void>, delayMs: number): ReloadScheduler {
	let timer: number | null = null;
	let running = false;
	let again = false;
	let cancelled = false;

	const fire = async (): Promise<void> => {
		timer = null;
		running = true;
		try {
			await run();
		} catch (e) {
			console.error("Stock Valuations: reload after external change failed", e);
		} finally {
			running = false;
		}
		if (again && !cancelled) {
			again = false;
			schedule();
		}
	};

	const schedule = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			void fire();
		}, delayMs);
	};

	return {
		notify() {
			if (cancelled) return;
			if (running) again = true;
			else schedule();
		},
		cancel() {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		},
	};
}
