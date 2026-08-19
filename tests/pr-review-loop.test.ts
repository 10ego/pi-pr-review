import { describe, expect, test } from "bun:test";
import {
	reviewDeadlineError,
	reviewDeadlineKindOf,
	REVIEW_LOOP_TOOL_NAMES,
	ReviewLoopCoordinator,
} from "../lib/pr-review-loop.ts";
import {
	parsePublishMode,
	resolveAutoPostSetting,
} from "../lib/pr-review-publish.ts";

const autoOff = resolveAutoPostSetting({ autoPostReviews: false });

function harness() {
	let activeTools = ["read", "bash", ...REVIEW_LOOP_TOOL_NAMES];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
	};
	const session = {
		id: "session-1",
		startedAt: "2026-07-13T00:00:00.000Z",
	};
	const ctx = {
		cwd: "/tmp/repo",
		sessionManager: {
			getSessionId: () => session.id,
			getHeader: () => ({ id: session.id, timestamp: session.startedAt }),
		},
	};
	const coordinator = new ReviewLoopCoordinator(pi as any);
	return {
		coordinator,
		ctx,
		session,
		activeTools: () => [...activeTools],
	};
}

describe("review-loop authority", () => {
	test("hides only reserved tools while idle and exposes them for a trusted command", () => {
		const h = harness();
		h.coordinator.hideTools();
		expect(h.activeTools()).toEqual(["read", "bash"]);

		const started = h.coordinator.begin(
			parsePublishMode("/pr-review 7"),
			autoOff,
			"interactive",
			h.ctx as any,
		);
		expect(started).toEqual({ accepted: true });
		expect(h.activeTools()).toEqual(["read", "bash", ...REVIEW_LOOP_TOOL_NAMES]);
		expect(h.coordinator.acquire(h.ctx as any)).toBeDefined();
	});

	test("suspends every tool for output repair and restores only base tools", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		const lease = h.coordinator.acquire(h.ctx as any)!;

		expect(h.coordinator.suspendToolsForRepair()).toBeTrue();
		expect(h.activeTools()).toEqual([]);
		expect(h.coordinator.acquire(h.ctx as any)).toBeUndefined();
		expect(h.coordinator.isLeaseActive(lease, h.ctx as any)).toBeFalse();
		expect(lease.signal.aborted).toBeFalse();
		expect(h.coordinator.suspendToolsForRepair()).toBeFalse();

		expect(h.coordinator.consume()?.prNumber).toBe(7);
		expect(lease.signal.aborted).toBeTrue();
		expect(h.activeTools()).toEqual(["read", "bash"]);

		h.coordinator.begin(parsePublishMode("/pr-review 8"), autoOff, "interactive", h.ctx as any);
		expect(h.coordinator.suspendToolsForRepair()).toBeTrue();
		h.coordinator.clear();
		expect(h.activeTools()).toEqual(["read", "bash"]);
		expect(h.coordinator.suspendToolsForRepair()).toBeFalse();
	});

	test("never authorizes extension-originated commands", () => {
		const h = harness();
		h.coordinator.hideTools();
		const started = h.coordinator.begin(
			parsePublishMode("/pr-review 7"),
			autoOff,
			"extension",
			h.ctx as any,
		);
		expect(started.accepted).toBeFalse();
		expect(started.error).toContain("interactive or RPC user");
		expect(h.coordinator.acquire(h.ctx as any)).toBeUndefined();
		expect(h.activeTools()).toEqual(["read", "bash"]);
	});

	test("shares one generation across parallel calls and revokes stale leases", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "rpc", h.ctx as any);
		const first = h.coordinator.acquire(h.ctx as any)!;
		const second = h.coordinator.acquire(h.ctx as any)!;
		expect(second.generation).toBe(first.generation);
		expect(h.coordinator.isLeaseActive(first, h.ctx as any)).toBeTrue();

		h.coordinator.clear();
		expect(first.signal.aborted).toBeTrue();
		expect(h.coordinator.isLeaseActive(first, h.ctx as any)).toBeFalse();
		expect(h.activeTools()).toEqual(["read", "bash"]);
	});

	test("suspends tools for non-open confirmation and trusts only user confirmation", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		expect(h.coordinator.markAwaitingConfirmation()).toBeTrue();
		expect(h.activeTools()).toEqual(["read", "bash"]);
		expect(h.coordinator.acquire(h.ctx as any)).toBeUndefined();

		expect(h.coordinator.resolveConfirmationInput("yes", "interactive", h.ctx as any)).toBe("confirmed");
		expect(h.coordinator.acquire(h.ctx as any)).toBeDefined();
		expect(h.activeTools()).toEqual(["read", "bash", ...REVIEW_LOOP_TOOL_NAMES]);

		h.coordinator.clear();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		h.coordinator.markAwaitingConfirmation();
		expect(h.coordinator.resolveConfirmationInput("yes", "extension", h.ctx as any)).toBe("cleared");
		expect(h.coordinator.acquire(h.ctx as any)).toBeUndefined();
	});

	test("binds focus publishers and subscribers to the active generation", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		const publisher = h.coordinator.createFocusPublisher(lease, h.ctx as any, {
			key: "call-1:pass-1",
			label: "correctness",
			tier: "heavy",
		})!;
		publisher.publish({ type: "attempt_started", attempt: 1, model: "provider/model" });
		publisher.publish({ type: "assistant_snapshot", text: "live output" });
		expect(h.coordinator.focusSnapshot(h.ctx as any)?.passes[0]?.assistantText).toBe("live output");

		let closed = false;
		h.coordinator.subscribeFocus(h.ctx as any, (snapshot) => {
			if (!snapshot) closed = true;
		});
		h.coordinator.clear();
		expect(closed).toBeTrue();
		expect(publisher.publish({ type: "assistant_delta", text: "late" })).toBeFalse();
		expect(h.coordinator.focusSnapshot(h.ctx as any)).toBeUndefined();
	});

	test("binds raw lane artifacts to the active generation and purges them on revocation", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		const expected = [
			{ key: "call-1:0", tier: "heavy" as const, minorHygiene: false },
			{ key: "call-1:1", tier: "heavy" as const, minorHygiene: false },
		];
		expect(h.coordinator.registerExpectedArtifacts(lease, expected, h.ctx as any)).toBeTrue();
		expect(h.coordinator.expectedArtifactCount(h.ctx as any)).toBe(2);
		expect(h.coordinator.expectedArtifactDescriptors(h.ctx as any)).toEqual(expected);
		const publisher = h.coordinator.createArtifactPublisher(lease, h.ctx as any)!;
		expect(publisher.retain({
			generation: lease.generation,
			key: "call-1:0",
			passId: "correctness",
			tier: "heavy",
			rawText: "partial evidence",
			exitCode: 1,
			stopReason: "error",
			lifecycle: "partial",
			attempts: [],
			fallbackUsed: false,
			elapsedMs: 10,
			toolElapsedMs: 0,
			toolCallCount: 0,
		})).toBeTrue();
		expect(h.coordinator.artifactSnapshot(h.ctx as any)?.[0]?.rawText).toBe("partial evidence");

		h.coordinator.clear();
		expect(publisher.retain({} as any)).toBeFalse();
		expect(h.coordinator.artifactSnapshot(h.ctx as any)).toBeUndefined();
		expect(h.coordinator.expectedArtifactCount(h.ctx as any)).toBeUndefined();
		expect(h.coordinator.expectedArtifactDescriptors(h.ctx as any)).toBeUndefined();
	});

	test("expires the total budget, aborts work, and preserves artifacts until partial synthesis consumes them", async () => {
		const h = harness();
		let deadlineCallbacks = 0;
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 10, medium: 10, heavy: 10 }, fallbackAttemptMs: 10,
					batchMs: 15, synthesisMs: 5, totalMs: 30, terminationGraceMs: 2,
					cleanupReserveMs: 5, minimumFallbackMs: 5,
				},
			},
			() => deadlineCallbacks++,
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.registerExpectedArtifacts(lease, [
			{ key: "call:0", tier: "heavy", minorHygiene: false },
		], h.ctx as any)).toBeTrue();
		const publisher = h.coordinator.createArtifactPublisher(lease, h.ctx as any)!;
		publisher.retain({
			generation: lease.generation, key: "call:0", passId: "security", tier: "heavy",
			rawText: "partial security evidence", exitCode: 1, lifecycle: "partial", attempts: [],
			fallbackUsed: false, elapsedMs: 10, toolElapsedMs: 0, toolCallCount: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(deadlineCallbacks).toBe(1);
		expect(h.coordinator.totalDeadlineExpired()).toBeTrue();
		expect(lease.signal.aborted).toBeTrue();
		expect(h.coordinator.isLeaseActive(lease, h.ctx as any)).toBeFalse();
		expect(h.coordinator.artifactSnapshot(h.ctx as any)?.[0]?.rawText).toBe("partial security evidence");
		expect(publisher.retain({} as any)).toBeFalse();
		expect(h.coordinator.consume()?.prNumber).toBe(7);
		expect(h.coordinator.artifactSnapshot(h.ctx as any)).toBeUndefined();
	});

	test("enforces the synthesis cap from early batch completion instead of the total deadline", async () => {
		const h = harness();
		let deadlineCallbacks = 0;
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 40, medium: 40, heavy: 40 }, fallbackAttemptMs: 40,
					batchMs: 100, synthesisMs: 20, totalMs: 1_000, terminationGraceMs: 10,
					cleanupReserveMs: 10, minimumFallbackMs: 10,
				},
			},
			() => deadlineCallbacks++,
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(deadlineCallbacks).toBe(1);
		expect(h.coordinator.synthesisDeadlineExpired()).toBeTrue();
		expect(h.coordinator.totalDeadlineExpired()).toBeFalse();
		expect(h.coordinator.deadlineExpired()).toBeTrue();
		expect(lease.signal.aborted).toBeTrue();
		expect(String(lease.signal.reason)).toContain("review synthesis deadline expired");
		h.coordinator.clear();
	});

	test("accepts timed-out evidence during only the monotonic termination and cleanup window", async () => {
		const h = harness();
		const lifecycleStartedAt = performance.now();
		let deadlineCallbackAt = 0;
		let retainedAfterExpiry = false;
		let publisher: { retain(artifact: any): boolean };
		let resolveExpired!: () => void;
		const expired = new Promise<void>((resolve) => { resolveExpired = resolve; });
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 20, medium: 20, heavy: 20 }, fallbackAttemptMs: 20,
					batchMs: 20, synthesisMs: 10, totalMs: 80, terminationGraceMs: 20,
					cleanupReserveMs: 10, minimumFallbackMs: 5,
				},
			},
			() => {
				deadlineCallbackAt = performance.now();
				retainedAfterExpiry = publisher.retain({
					generation: lease.generation, key: "call:0", passId: "security-performance-shard-2", tier: "heavy",
					rawText: "partial evidence flushed after timeout", exitCode: 1, stopReason: "timeout",
					lifecycle: "timed_out", attempts: [], fallbackUsed: false, elapsedMs: 50,
					toolElapsedMs: 0, toolCallCount: 0, startOffsetMs: 0, endOffsetMs: 50,
				});
				resolveExpired();
			},
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.registerExpectedArtifacts(lease, [
			{ key: "call:0", tier: "heavy", minorHygiene: false },
		], h.ctx as any)).toBeTrue();
		publisher = h.coordinator.createArtifactPublisher(lease, h.ctx as any)!;
		await expired;
		expect(retainedAfterExpiry).toBeTrue();
		expect(deadlineCallbackAt).toBeGreaterThanOrEqual(lifecycleStartedAt);
		expect(deadlineCallbackAt - lifecycleStartedAt).toBeGreaterThanOrEqual(40);
		expect(lease.signal.aborted).toBeTrue();
		expect(h.coordinator.artifactSnapshot(h.ctx as any)?.[0]).toMatchObject({
			passId: "security-performance-shard-2",
			lifecycle: "timed_out",
			startOffsetMs: 0,
			endOffsetMs: 50,
		});
		await new Promise((resolve) => setTimeout(resolve, 45));
		expect(publisher.retain({})).toBeFalse();
		h.coordinator.clear();
	});

	test("defers an armed synthesis cap while review work runs again and re-arms from the new turn end", async () => {
		const h = harness();
		let deadlineCallbacks = 0;
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 200, medium: 200, heavy: 200 }, fallbackAttemptMs: 200,
					batchMs: 500, synthesisMs: 25, totalMs: 2_000, terminationGraceMs: 10,
					cleanupReserveMs: 10, minimumFallbackMs: 10,
				},
			},
			() => deadlineCallbacks++,
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		// First review-tool turn ends: the synthesis cap arms with a 25ms window.
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		// Review work resumes before expiry (turn start / review tool start).
		expect(h.coordinator.deferSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(deadlineCallbacks).toBe(0);
		expect(h.coordinator.synthesisDeadlineExpired()).toBeFalse();
		expect(lease.signal.aborted).toBeFalse();
		// The follow-up turn ends: the cap re-arms with a fresh window and still expires.
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(deadlineCallbacks).toBe(1);
		expect(h.coordinator.synthesisDeadlineExpired()).toBeTrue();
		expect(reviewDeadlineKindOf(lease.signal.reason)).toBe("synthesis");
		h.coordinator.clear();
	});

	test("a deferral inside the immediate-expiry window cancels the pending cap", async () => {
		const h = harness();
		let deadlineCallbacks = 0;
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 500, medium: 500, heavy: 500 }, fallbackAttemptMs: 500,
					batchMs: 500, synthesisMs: 0, totalMs: 2_000, terminationGraceMs: 10,
					cleanupReserveMs: 10, minimumFallbackMs: 10,
				},
			},
			() => deadlineCallbacks++,
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		// The cap is scheduled on a microtask; deferring first must win the race.
		expect(h.coordinator.deferSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(deadlineCallbacks).toBe(0);
		expect(lease.signal.aborted).toBeFalse();
		h.coordinator.clear();
	});

	test("deferSynthesis rejects never-armed, foreign, and expired bindings", () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.deferSynthesis(lease.generation, h.ctx as any)).toBeFalse();
		expect(h.coordinator.deferSynthesis(lease.generation + 1, h.ctx as any)).toBeFalse();
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		expect(h.coordinator.deferSynthesis(lease.generation + 1, h.ctx as any)).toBeFalse();
		h.coordinator.clear();
	});

	test("deferActiveSynthesis never clears an expired binding so retained artifacts survive", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any,
			true, false, "off", undefined,
			{
				source: "default", warnings: [],
				config: {
					attemptMs: { light: 500, medium: 500, heavy: 500 }, fallbackAttemptMs: 500,
					batchMs: 500, synthesisMs: 10, totalMs: 2_000, terminationGraceMs: 10,
					cleanupReserveMs: 10, minimumFallbackMs: 10,
				},
			},
		);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		expect(h.coordinator.registerExpectedArtifacts(lease, [
				{ key: "call:0", tier: "heavy", minorHygiene: false },
		], h.ctx as any)).toBeTrue();
		const publisher = h.coordinator.createArtifactPublisher(lease, h.ctx as any)!;
		publisher.retain({
			generation: lease.generation, key: "call:0", passId: "correctness", tier: "heavy",
			rawText: "partial correctness evidence", exitCode: 1, stopReason: "timeout",
			lifecycle: "timed_out", attempts: [], fallbackUsed: false, elapsedMs: 40,
			toolElapsedMs: 0, toolCallCount: 0, deadlineExpired: "synthesis",
		});
		expect(h.coordinator.beginSynthesis(lease.generation, h.ctx as any)).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(h.coordinator.synthesisDeadlineExpired()).toBeTrue();
		// A turn starting after expiry must not destroy the reserved artifacts.
		expect(h.coordinator.deferActiveSynthesis(h.ctx as any)).toBeUndefined();
		expect(h.coordinator.deadlineExpired()).toBeTrue();
		expect(h.coordinator.artifactSnapshot(h.ctx as any)?.[0]?.rawText).toBe("partial correctness evidence");
		h.coordinator.clear();
	});

	test("typed deadline aborts disclose their kind without relying on message text", () => {
		expect(reviewDeadlineKindOf(reviewDeadlineError("total"))).toBe("total");
		expect(reviewDeadlineKindOf(reviewDeadlineError("synthesis"))).toBe("synthesis");
		expect(reviewDeadlineKindOf(new Error("review SYNTHESIS deadline expired"))).toBe("synthesis");
		expect(reviewDeadlineKindOf(new Error("unrelated abort"))).toBeUndefined();
		expect(reviewDeadlineKindOf("review synthesis deadline expired")).toBeUndefined();
		expect(reviewDeadlineKindOf(undefined)).toBeUndefined();
	});

	test("fails closed when the session identity or cwd changes", () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7"), autoOff, "interactive", h.ctx as any);
		const lease = h.coordinator.acquire(h.ctx as any)!;
		const publisher = h.coordinator.createFocusPublisher(lease, h.ctx as any, {
			key: "call-1:pass-1",
			label: "security",
			tier: "heavy",
		})!;
		h.session.startedAt = "2026-07-14T00:00:00.000Z";
		expect(h.coordinator.isLeaseActive(lease, h.ctx as any)).toBeFalse();
		expect(lease.signal.aborted).toBeTrue();
		expect(publisher.publish({ type: "assistant_delta", text: "late" })).toBeFalse();
		expect(h.coordinator.focusSnapshot(h.ctx as any)).toBeUndefined();
		expect(h.activeTools()).toEqual(["read", "bash"]);
	});
});
