import { describe, expect, test } from "bun:test";
import {
	classifyReviewLane,
	finalAssistantText,
	ReviewLaneArtifactRegistry,
	type ReviewLaneArtifact,
} from "../lib/pr-review-artifacts.ts";

function artifact(overrides: Partial<ReviewLaneArtifact> = {}): ReviewLaneArtifact {
	return {
		generation: 7,
		key: "call:0",
		passId: "correctness-shard-2",
		tier: "heavy",
		requestedModel: "provider/primary",
		observedModel: "provider/fallback",
		rawText: "NO FINDINGS.",
		exitCode: 0,
		stopReason: "stop",
		lifecycle: "complete",
		attempts: [
			{
				ordinal: 1,
				kind: "primary",
				requestedModel: "provider/primary",
				observedModel: "provider/primary",
				rawText: "partial primary evidence",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "429 capacity",
				lifecycle: "partial",
				retryable: true,
				elapsedMs: 20,
				toolElapsedMs: 5,
				toolCallCount: 1,
			},
			{
				ordinal: 2,
				kind: "fallback",
				requestedModel: "provider/fallback",
				observedModel: "provider/fallback",
				rawText: "NO FINDINGS.",
				exitCode: 0,
				stopReason: "stop",
				lifecycle: "complete",
				retryable: false,
				elapsedMs: 30,
				toolElapsedMs: 0,
				toolCallCount: 0,
			},
		],
		fallbackUsed: true,
		elapsedMs: 50,
		toolElapsedMs: 0,
		toolCallCount: 0,
		...overrides,
	};
}

describe("ordinary review-lane reconstruction", () => {
	test("concatenates every text part from the authoritative final assistant message", () => {
		expect(finalAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "stale" }] },
			{ role: "toolResult", content: [] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first\n" },
					{ type: "thinking", text: "ignored" },
					{ type: "text", text: "second" },
					{ type: "text", text: "" },
				],
			},
		])).toBe("first\nsecond");
	});

	test("does not fall back to stale text when the final assistant message is empty", () => {
		expect(finalAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "stale" }] },
			{ role: "assistant", content: [{ type: "thinking", text: "no final output" }] },
		])).toBe("");
	});
});

describe("semantic lane completion", () => {
	test("requires explicit valid output under a successful terminal stop", () => {
		expect(classifyReviewLane({ tier: "heavy", rawText: "NO FINDINGS.", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 0, stopReason: "stop" })).toBe("failed");
		expect(classifyReviewLane({ tier: "heavy", rawText: "looks okay", exitCode: 0, stopReason: "stop" })).toBe("partial");
		expect(classifyReviewLane({ tier: "light", rawText: "Overview: change\nStrengths: clear", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "light", rawText: "Overview:\nStrengths:", exitCode: 0, stopReason: "stop" })).toBe("partial");
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: "title:\nseverity:\nwhy:\nlocation:\nside:\nin_diff:\npr_related:\nconfidence:",
			exitCode: 0,
			stopReason: "stop",
		})).toBe("partial");
		expect(classifyReviewLane({
			tier: "light",
			rawText: '{"body":"format-only output"}',
			exitCode: 0,
			stopReason: "stop",
			expectedOutput: "nonempty",
		})).toBe("complete");
	});

	test("does not let an empty light section consume the next populated section", () => {
		const fields = ["Overview", "Strengths", "Minor Candidates"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered
				.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`)
				.join("\n");
			expect(classifyReviewLane({
				tier: "light",
				rawText,
				exitCode: 0,
				stopReason: "stop",
				minorHygiene: true,
			}), emptyField).toBe("partial");
		}

		expect(classifyReviewLane({
			tier: "light",
			rawText: fields.map((field) => `${field}: ${field} value`).join("\n"),
			exitCode: 0,
			stopReason: "stop",
			minorHygiene: true,
		})).toBe("complete");
	});

	test("does not let an empty heavy field consume the next populated field", () => {
		const fields = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered
				.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`)
				.join("\n");
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop" }), emptyField).toBe("partial");
		}

		expect(classifyReviewLane({
			tier: "heavy",
			rawText: fields.map((field) => `${field}: ${field} value`).join("\n"),
			exitCode: 0,
			stopReason: "stop",
		})).toBe("complete");
	});

	test("classifies token limits, timeout, and process failure without erasing raw text", () => {
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 0, stopReason: "length" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, stopReason: "error" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, errorMessage: "request timed out" })).toBe("timed_out");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 1, stopReason: "error" })).toBe("failed");
	});
});

describe("invocation lane artifact retention", () => {
	test("preserves fallback attempt history and purges it with the generation", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		const retained = artifact();
		expect(registry.expect(7, [retained.key])).toBeTrue();
		expect(registry.retain(7, retained)).toBeTrue();
		const snapshot = registry.snapshot(7)!;
		expect(snapshot[0]?.rawText).toBe("NO FINDINGS.");
		expect(snapshot[0]?.attempts.map((attempt) => ({ lifecycle: attempt.lifecycle, rawText: attempt.rawText }))).toEqual([
			{ lifecycle: "partial", rawText: "partial primary evidence" },
			{ lifecycle: "complete", rawText: "NO FINDINGS." },
		]);
		expect(() => (snapshot as ReviewLaneArtifact[]).push(retained)).toThrow();

		registry.close(7);
		expect(registry.snapshot(7)).toBeUndefined();
		expect(registry.retain(7, retained)).toBeFalse();
	});

	test("snapshots concurrent completions in requested-pass order", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		expect(registry.expect(7, ["call:0", "call:1"])).toBeTrue();
		expect(registry.retain(7, artifact({ key: "unexpected", passId: "unexpected" }))).toBeFalse();
		registry.retain(7, artifact({ key: "call:1", passId: "second", requestedPassOrdinal: 1 }));
		registry.retain(7, artifact({ key: "call:0", passId: "first", requestedPassOrdinal: 0 }));
		expect(registry.snapshot(7)?.map((lane) => lane.passId)).toEqual(["first", "second"]);
	});

	test("rejects stale artifacts after replacement", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		registry.open(8);
		expect(registry.retain(7, artifact())).toBeFalse();
		expect(registry.snapshot(8)).toEqual([]);
	});
});
