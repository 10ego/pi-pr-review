import { monotonicNow, type MonotonicNow } from "./pr-review-telemetry.ts";

export type ReviewTier = "light" | "medium" | "heavy";

/** Which host invocation deadline (total or synthesis) ended review work. */
export type ReviewDeadlineKind = "total" | "synthesis";

export interface ReviewDeadlineConfig {
	attemptMs: Record<ReviewTier, number>;
	fallbackAttemptMs: number;
	batchMs: number;
	synthesisMs: number;
	totalMs: number;
	terminationGraceMs: number;
	cleanupReserveMs: number;
	minimumFallbackMs: number;
}

/** Conservative initial caps; the 15 minute invocation cap makes 30 minute reviews impossible. */
export const DEFAULT_REVIEW_DEADLINES: Readonly<ReviewDeadlineConfig> = Object.freeze({
	attemptMs: Object.freeze({ light: 180_000, medium: 360_000, heavy: 480_000 }),
	fallbackAttemptMs: 180_000,
	batchMs: 720_000,
	synthesisMs: 60_000,
	totalMs: 900_000,
	terminationGraceMs: 5_000,
	cleanupReserveMs: 5_000,
	minimumFallbackMs: 30_000,
});

const LIMITS = {
	attemptMs: [30_000, 720_000],
	fallbackAttemptMs: [30_000, 360_000],
	batchMs: [60_000, 840_000],
	synthesisMs: [10_000, 120_000],
	totalMs: [120_000, 1_200_000],
	terminationGraceMs: [100, 15_000],
	cleanupReserveMs: [1_000, 30_000],
	minimumFallbackMs: [10_000, 120_000],
} as const;

export interface DeadlineResolution {
	config: ReviewDeadlineConfig;
	source: "default" | "user" | "project";
	warnings: string[];
}

function validInteger(value: unknown, limits: readonly [number, number]): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= limits[0] && value <= limits[1];
}

/**
 * Resolve a complete deadline object. A malformed overlay is rejected as a unit
 * rather than partially applying surprising or unbounded values.
 */
export function resolveReviewDeadlines(user: unknown, project?: unknown): DeadlineResolution {
	let config: ReviewDeadlineConfig = {
		...DEFAULT_REVIEW_DEADLINES,
		attemptMs: { ...DEFAULT_REVIEW_DEADLINES.attemptMs },
	};
	let source: DeadlineResolution["source"] = "default";
	const warnings: string[] = [];
	for (const [label, raw] of [["user", user], ["project", project]] as const) {
		if (raw === undefined) continue;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warnings.push(`${label} deadline configuration was malformed and was ignored`);
			continue;
		}
		const value = raw as Record<string, unknown>;
		const attempt = value.attemptMs;
		const candidate: ReviewDeadlineConfig = {
			attemptMs: {
				light: (attempt as Record<string, unknown> | undefined)?.light as number,
				medium: (attempt as Record<string, unknown> | undefined)?.medium as number,
				heavy: (attempt as Record<string, unknown> | undefined)?.heavy as number,
			},
			fallbackAttemptMs: value.fallbackAttemptMs as number,
			batchMs: value.batchMs as number,
			synthesisMs: value.synthesisMs as number,
			totalMs: value.totalMs as number,
			terminationGraceMs: value.terminationGraceMs as number,
			cleanupReserveMs: value.cleanupReserveMs as number,
			minimumFallbackMs: value.minimumFallbackMs as number,
		};
		const valid = attempt && typeof attempt === "object" && !Array.isArray(attempt) &&
			(["light", "medium", "heavy"] as const).every((tier) => validInteger(candidate.attemptMs[tier], LIMITS.attemptMs)) &&
			validInteger(candidate.fallbackAttemptMs, LIMITS.fallbackAttemptMs) &&
			validInteger(candidate.batchMs, LIMITS.batchMs) &&
			validInteger(candidate.synthesisMs, LIMITS.synthesisMs) &&
			validInteger(candidate.totalMs, LIMITS.totalMs) &&
			validInteger(candidate.terminationGraceMs, LIMITS.terminationGraceMs) &&
			validInteger(candidate.cleanupReserveMs, LIMITS.cleanupReserveMs) &&
			validInteger(candidate.minimumFallbackMs, LIMITS.minimumFallbackMs) &&
			candidate.minimumFallbackMs <= candidate.fallbackAttemptMs &&
			candidate.batchMs + candidate.synthesisMs + candidate.terminationGraceMs + candidate.cleanupReserveMs <= candidate.totalMs;
		if (!valid) {
			warnings.push(`${label} deadline configuration was out of range or internally inconsistent and was ignored`);
			continue;
		}
		config = candidate;
		source = label;
	}
	return { config, source, warnings };
}

export interface ReviewBudget {
	readonly startedAtMs: number;
	readonly totalDeadlineMs: number;
	readonly batchDeadlineMs: number;
	readonly config: ReviewDeadlineConfig;
	readonly source: DeadlineResolution["source"];
	readonly warnings: readonly string[];
}

export function createReviewBudget(
	resolution: DeadlineResolution,
	now: MonotonicNow = monotonicNow,
): ReviewBudget {
	const startedAtMs = now();
	return Object.freeze({
		startedAtMs,
		totalDeadlineMs: startedAtMs + resolution.config.totalMs,
		batchDeadlineMs: startedAtMs + Math.min(
			resolution.config.batchMs,
			resolution.config.totalMs - resolution.config.synthesisMs - resolution.config.terminationGraceMs - resolution.config.cleanupReserveMs,
		),
		config: resolution.config,
		source: resolution.source,
		warnings: [...resolution.warnings],
	});
}

export function attemptDeadline(
	budget: ReviewBudget,
	tier: ReviewTier,
	fallback: boolean,
	now: MonotonicNow = monotonicNow,
): number {
	const runtime = fallback ? budget.config.fallbackAttemptMs : budget.config.attemptMs[tier];
	const terminationReserveMs = budget.config.terminationGraceMs + budget.config.cleanupReserveMs;
	return Math.min(now() + runtime, budget.batchDeadlineMs, budget.totalDeadlineMs - terminationReserveMs);
}

export function fallbackBudget(
	budget: ReviewBudget,
	now: MonotonicNow = monotonicNow,
): { allowed: boolean; availableMs: number; reason?: "insufficient_budget" } {
	const terminationReserveMs = budget.config.terminationGraceMs + budget.config.cleanupReserveMs;
	const availableMs = Math.max(0, Math.min(budget.batchDeadlineMs, budget.totalDeadlineMs) - now() - terminationReserveMs);
	return availableMs >= budget.config.minimumFallbackMs
		? { allowed: true, availableMs }
		: { allowed: false, availableMs, reason: "insufficient_budget" };
}
