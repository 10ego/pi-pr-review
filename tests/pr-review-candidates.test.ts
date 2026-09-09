import { describe, expect, test } from "bun:test";
import { ReviewCandidateDispositionRegistry } from "../lib/pr-review-candidates.ts";

describe("review candidate disposition registry", () => {
	test("requires exact one-shot coverage and valid duplicate targets", () => {
		const registry = new ReviewCandidateDispositionRegistry();
		expect(registry.markCandidates("s", 1, [
			{ id: "gap:1", laneKey: "gap", title: "Canonical", severity: "P1", location: "src/a.ts:1 RIGHT" },
			{ id: "delta:1", laneKey: "delta", title: "Duplicate", severity: "P1", location: "src/a.ts:1 RIGHT" },
		])).toBeTrue();
		expect(registry.recordDecisions("s", 1, [{ candidateId: "gap:1", disposition: "accepted" }])).toEqual({ ok: false, error: "decisions must cover every registered candidate exactly once" });
		expect(registry.recordDecisions("s", 1, [
			{ candidateId: "gap:1", disposition: "accepted" },
			{ candidateId: "delta:1", disposition: "duplicate", duplicateOf: "missing" },
		])).toEqual({ ok: false, error: "duplicate decisions must reference another registered candidate" });
		const accepted = registry.recordDecisions("s", 1, [
			{ candidateId: "gap:1", disposition: "accepted" },
			{ candidateId: "delta:1", disposition: "duplicate", duplicateOf: "gap:1" },
		]);
		expect(accepted.ok).toBeTrue();
		expect(registry.recordDecisions("s", 1, [])).toEqual({ ok: false, error: "candidate dispositions were already recorded for this invocation" });
	});
});
