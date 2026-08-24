import { describe, expect, test } from "bun:test";
import {
	classifyReviewLane,
	finalAssistantText,
	ReviewLaneArtifactRegistry,
	type ReviewLaneArtifact,
} from "../lib/pr-review-artifacts.ts";

function integratedFraming(forms: "plain" | "bold" | "heading" = "plain", values = {
	overview: "The change integrates the review.",
	strengths: "Focused tests cover the path.",
	riskAreas: "Integration boundaries remain the main risk.",
}): string {
	if (forms === "bold") return `**Overview:** ${values.overview}\n**Strengths:** ${values.strengths}\n**Risk areas:** ${values.riskAreas}`;
	if (forms === "heading") return `## Overview\n${values.overview}\n## Strengths\n${values.strengths}\n## Risk areas\n${values.riskAreas}`;
	return `Overview: ${values.overview}\nStrengths: ${values.strengths}\nRisk areas: ${values.riskAreas}`;
}

function integratedCandidate(why = "The changed path drops a required result.", labels: "plain" | "bold" = "plain"): string {
	const prefix = labels === "bold" ? "- **" : "";
	const suffix = labels === "bold" ? ":**" : ":";
	return [
		`${prefix}title${suffix} [P2] Preserve review evidence`,
		`${prefix}severity${suffix} P2`,
		`${prefix}why${suffix} ${why}`,
		`${prefix}location${suffix} src/a.ts:10-12`,
		`${prefix}side${suffix} RIGHT`,
		`${prefix}in_diff${suffix} yes`,
		`${prefix}pr_related${suffix} yes`,
		`${prefix}confidence${suffix} 0.9`,
	].join("\n");
}

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
	test("requires the exact integrated Markdown contract under a successful terminal stop", () => {
		const clean = `${integratedFraming()}\nNO FINDINGS.`;
		expect(classifyReviewLane({ tier: "heavy", rawText: clean, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming("bold")}\nNO FINDINGS.`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming("heading")}\nNO FINDINGS.`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming()}\n${integratedCandidate()}`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${integratedFraming()}\n${integratedCandidate("The review agent cannot access the repository after chdir, so the new feature fails", "bold")}\n\n${integratedCandidate("The diff was not provided to the downstream worker, so reviews silently ignore new code")}`,
			exitCode: 0, stopReason: "stop", expectedOutput: "nonempty",
		})).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("failed");

		for (const arbitrary of ["1234567890123456", "looks okay", "all good", "Overview: a\nStrengths: b\nRisk areas: c\nNo findings at any severity."]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: arbitrary, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), arbitrary).toBe("partial");
		}
		for (const refusal of [
			integratedFraming("plain", { overview: "I cannot review because repository access is denied.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			integratedFraming("plain", { overview: "Review skipped because source context is missing.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			integratedFraming("plain", { overview: "Internal server error while reading tools.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			integratedFraming("plain", { overview: "Review complete", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			integratedFraming("plain", { overview: "none", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			integratedFraming("plain", { overview: "The change integrates the review.", strengths: "unavailable", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.",
			`${integratedFraming()}\n${integratedCandidate()}\nI cannot complete the review because the model failed.`,
			`I cannot complete the review because repository access is denied.\n${integratedFraming()}\n${integratedCandidate()}`,
			`{"body":${JSON.stringify(`${integratedFraming()}\nNO FINDINGS.`)}}`,
			`> ${integratedFraming().replace(/\n/g, "\n> ")}\n> NO FINDINGS.`,
			"```markdown\n" + integratedFraming() + "\nNO FINDINGS.\n```",
			`${integratedFraming()}\nNo findings.`,
		]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: refusal, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), refusal).toBe("partial");
		}

		for (const malformed of [
			`${integratedFraming()}\n${integratedCandidate().replace("severity: P2", "severity: P9")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("side: RIGHT", "side: MIDDLE")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("in_diff: yes", "in_diff: true")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("confidence: 0.9", "confidence: 1.1")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("why: The changed path drops a required result.", "why: none")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("title: [P2] Preserve review evidence", "title: template")}`,
			`${integratedFraming()}\n## Findings\n${integratedCandidate()}`,
		]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: malformed, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), malformed).toBe("partial");
		}
		expect(classifyReviewLane({ tier: "light", rawText: "Overview: change\nStrengths: clear", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "light", rawText: "Overview:\nStrengths:", exitCode: 0, stopReason: "stop" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "NO FINDINGS.", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: "title:\nseverity:\nwhy:\nlocation:\nside:\nin_diff:\npr_related:\nconfidence:", exitCode: 0, stopReason: "stop" })).toBe("partial");
	});

	test("does not let an empty light section consume the next populated section", () => {
		const fields = ["Overview", "Strengths", "Minor Candidates"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered
				.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`)
				.join("\n");
			expect(classifyReviewLane({ tier: "light", rawText, exitCode: 0, stopReason: "stop", minorHygiene: true }), emptyField).toBe("partial");
		}
		expect(classifyReviewLane({ tier: "light", rawText: fields.map((field) => `${field}: ${field} value`).join("\n"), exitCode: 0, stopReason: "stop", minorHygiene: true })).toBe("complete");
	});

	test("does not let an empty heavy field consume the next populated field", () => {
		const fields = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`).join("\n");
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop" }), emptyField).toBe("partial");
		}
		expect(classifyReviewLane({ tier: "heavy", rawText: fields.map((field) => `${field}: ${field} value`).join("\n"), exitCode: 0, stopReason: "stop" })).toBe("complete");
	});

	test("classifies token limits, timeout, and process failure without erasing raw text", () => {
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 0, stopReason: "length" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, stopReason: "error" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, errorMessage: "request timed out" })).toBe("timed_out");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, errorMessage: 7 as never })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 1, stopReason: "error" })).toBe("failed");
	});
});

describe("invocation lane artifact retention", () => {
	test("preserves fallback attempt history and purges it with the generation", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		const retained = artifact();
		expect(registry.expect(7, [{ key: retained.key, tier: retained.tier, minorHygiene: false, expectedOutput: "nonempty" }])).toBeTrue();
		expect(registry.expect(7, [{ key: retained.key, tier: retained.tier, minorHygiene: false, expectedOutput: "review_lane" }])).toBeFalse();
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
		expect(registry.expect(7, [
			{ key: "call:0", tier: "heavy", minorHygiene: false },
			{ key: "call:1", tier: "heavy", minorHygiene: false },
		])).toBeTrue();
		expect(registry.retain(7, artifact({ key: "unexpected", passId: "unexpected" }))).toBeFalse();
		expect(registry.retain(7, artifact({ key: "call:0", tier: "light" }))).toBeFalse();
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
