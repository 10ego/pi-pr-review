/** Run independent work concurrently while preserving input result order. */
export async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	});
	// The shared session directory must outlive every in-flight reviewer, including
	// siblings of a worker whose progress callback or result processing threw.
	const outcomes = await Promise.allSettled(workers);
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") throw outcome.reason;
	}
	return results;
}
