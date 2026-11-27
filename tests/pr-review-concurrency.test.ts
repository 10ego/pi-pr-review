import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "../lib/pr-review-concurrency.ts";

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 50; attempts++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
}

describe("bounded review-pass scheduling", () => {
	test("waits for active siblings before releasing a failed batch", async () => {
		let release!: () => void;
		const sibling = new Promise<void>(resolve => { release = resolve; });
		let finished = false;
		const batch = runWithConcurrency([0, 1], 2, async item => {
			if (item === 0) throw new Error("observer failed");
			await sibling;
		}).catch(error => { finished = true; return error.message; });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(finished).toBeFalse();
		release();
		expect(await batch).toBe("observer failed");
	});

	test("starts independent workers in parallel without exceeding the concurrency cap", async () => {
		const started: number[] = [];
		const releases = new Map<number, () => void>();
		let active = 0;
		let peakActive = 0;

		const batch = runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
			started.push(item);
			active++;
			peakActive = Math.max(peakActive, active);
			await new Promise<void>((resolve) => releases.set(item, resolve));
			active--;
			return item * 10;
		});

		expect(started).toEqual([0, 1]);
		expect(peakActive).toBe(2);

		releases.get(0)!();
		await waitFor(() => started.length === 3);
		expect(started).toEqual([0, 1, 2]);
		expect(active).toBe(2);

		releases.get(1)!();
		await waitFor(() => started.length === 4);
		expect(started).toEqual([0, 1, 2, 3]);
		expect(peakActive).toBe(2);

		releases.get(2)!();
		releases.get(3)!();
		expect(await batch).toEqual([0, 10, 20, 30]);
	});
});
