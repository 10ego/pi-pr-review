import { describe, expect, test } from "bun:test";
import {
	DEFAULT_REVIEW_DEADLINES,
	activateReviewBatch,
	attemptDeadline,
	createReviewBudget,
	fallbackBudget,
	resolveReviewDeadlines,
} from "../lib/pr-review-deadlines.ts";

const configured = {
	attemptMs: { light: 30_000, medium: 40_000, heavy: 50_000 },
	fallbackAttemptMs: 30_000,
	batchMs: 80_000,
	synthesisMs: 10_000,
	totalMs: 120_000,
	terminationGraceMs: 100,
	cleanupReserveMs: 1_000,
	minimumFallbackMs: 10_000,
};

describe("review deadline configuration", () => {
	test("provides a finite hard cap below thirty minutes with twelve-minute heavy attempts", () => {
		expect(DEFAULT_REVIEW_DEADLINES.attemptMs.heavy).toBe(12 * 60_000);
		expect(DEFAULT_REVIEW_DEADLINES.totalMs).toBeLessThan(30 * 60_000);
		const budget = createReviewBudget(resolveReviewDeadlines(undefined), () => 7);
		expect(budget.totalDeadlineMs).toBe(7 + DEFAULT_REVIEW_DEADLINES.totalMs);
		expect(budget.batchDeadlineMs).toBeLessThan(budget.totalDeadlineMs);
	});

	test("accepts opt-in fifteen-minute heavy attempts and batch windows", () => {
		const fifteenMinutes = {
			...configured,
			attemptMs: { ...configured.attemptMs, heavy: 15 * 60_000 },
			batchMs: 15 * 60_000,
			totalMs: 20 * 60_000,
		};
		const resolved = resolveReviewDeadlines(fifteenMinutes);
		expect(resolved.source).toBe("user");
		expect(resolved.config.attemptMs.heavy).toBe(15 * 60_000);
		expect(resolved.config.batchMs).toBe(15 * 60_000);
		expect(resolved.warnings).toEqual([]);
	});

	test("accepts only complete bounded overlays and lets a valid project replace user settings", () => {
		const user = { ...configured, totalMs: 130_000 };
		const project = { ...configured, totalMs: 140_000 };
		const resolved = resolveReviewDeadlines(user, project);
		expect(resolved.source).toBe("project");
		expect(resolved.config.totalMs).toBe(140_000);
		expect(resolved.warnings).toEqual([]);
	});

	test("rejects malformed, partial, unbounded, and inconsistent overlays as units", () => {
		for (const raw of [
			{ totalMs: Infinity },
			{ ...configured, totalMs: 30 * 60_000 },
			{ ...configured, totalMs: 120_000, batchMs: 120_000 },
			{
				...configured,
				batchMs: 109_000,
				synthesisMs: 10_000,
				totalMs: 120_000,
				terminationGraceMs: 15_000,
				cleanupReserveMs: 1_000,
			},
		]) {
			const resolved = resolveReviewDeadlines(raw);
			expect(resolved.source).toBe("default");
			expect(resolved.config.totalMs).toBe(DEFAULT_REVIEW_DEADLINES.totalMs);
			expect(resolved.warnings.length).toBe(1);
		}
	});
});

describe("review budget arithmetic", () => {
	test("uses monotonic absolute attempt, batch, and total bounds", () => {
		let monotonicMs = 1_000;
		const budget = createReviewBudget(resolveReviewDeadlines(configured), () => monotonicMs);
		expect(budget.startedAtMs).toBe(1_000);
		expect(budget.batchDeadlineMs).toBe(81_000);
		expect(budget.totalDeadlineMs).toBe(121_000);
		expect(attemptDeadline(budget, "light", false, () => monotonicMs)).toBe(31_000);
		monotonicMs = 75_000;
		expect(attemptDeadline(budget, "heavy", false, () => monotonicMs)).toBe(budget.batchDeadlineMs);
		expect(budget.startedAtMs).toBeLessThanOrEqual(budget.batchDeadlineMs);
		expect(budget.batchDeadlineMs).toBeLessThan(budget.totalDeadlineMs);
	});

	test("activates the batch window once at first reviewer dispatch without extending the total cap", () => {
		const budget = createReviewBudget(resolveReviewDeadlines(configured), () => 1_000);
		const activated = activateReviewBatch(budget, () => 75_000);
		expect(activated.startedAtMs).toBe(1_000);
		expect(activated.batchStartedAtMs).toBe(75_000);
		expect(activated.batchDeadlineMs).toBe(109_900);
		expect(activated.totalDeadlineMs).toBe(121_000);
		expect(attemptDeadline(activated, "heavy", false, () => 75_000)).toBe(109_900);
		expect(activateReviewBatch(budget, () => 90_000)).toBe(activated);
		expect(activateReviewBatch(activated, () => 90_000)).toBe(activated);
	});

	test("reserves grace and cleanup in an adversarial 109s batch budget", () => {
		const resolution = {
			source: "user" as const,
			warnings: [],
			config: {
				...configured,
				batchMs: 109_000,
				synthesisMs: 10_000,
				totalMs: 120_000,
				terminationGraceMs: 15_000,
				cleanupReserveMs: 1_000,
			},
		};
		const budget = createReviewBudget(resolution, () => 5_000);
		expect(budget.batchDeadlineMs).toBe(99_000);
		expect(budget.totalDeadlineMs).toBe(125_000);
		expect(attemptDeadline(budget, "heavy", false, () => 95_000)).toBe(99_000);
		expect(fallbackBudget(budget, () => 73_000)).toEqual({ allowed: true, availableMs: 10_000 });
		expect(fallbackBudget(budget, () => 73_001)).toEqual({
			allowed: false,
			availableMs: 9_999,
			reason: "insufficient_budget",
		});
	});

	test("rejects fallback unless minimum useful runtime, termination grace, and cleanup remain", () => {
		const budget = createReviewBudget(resolveReviewDeadlines(configured), () => 0);
		expect(fallbackBudget(budget, () => 68_900)).toEqual({ allowed: true, availableMs: 10_000 });
		expect(fallbackBudget(budget, () => 68_901)).toEqual({
			allowed: false,
			availableMs: 9_999,
			reason: "insufficient_budget",
		});
	});
});
