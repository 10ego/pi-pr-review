import { describe, expect, test } from "bun:test";
import { ReviewCandidateDispositionRegistry } from "../lib/pr-review-candidates.ts";

describe("review candidate disposition registry", () => {
	test("requires exact one-shot coverage and valid duplicate targets", () => {
		const registry = new ReviewCandidateDispositionRegistry();
		expect(registry.markCandidates("s", 1, [
			{ id: "gap:1", laneKey: "gap", finding: { title: "[P1] Canonical", severity: "P1", body: "impact", code_location: null } },
			{ id: "delta:1", laneKey: "delta", finding: { title: "[P1] Duplicate", severity: "P1", body: "impact", code_location: null } },
		])).toBeTrue();
		expect(registry.recordFinalization("s", 1, [{ candidateId: "gap:1", disposition: "accepted" }], [], "overview", "verification")).toEqual({ ok: false, error: "decisions must cover every registered candidate exactly once" });
		expect(registry.recordFinalization("s", 1, [
			{ candidateId: "gap:1", disposition: "accepted" },
			{ candidateId: "delta:1", disposition: "duplicate", duplicateOf: "missing" },
		], [], "overview", "verification")).toEqual({ ok: false, error: "duplicate decisions must reference another registered candidate" });
		const accepted = registry.recordFinalization("s", 1, [
			{ candidateId: "gap:1", disposition: "accepted" },
			{ candidateId: "delta:1", disposition: "duplicate", duplicateOf: "gap:1" },
		], [{ title: "[P2] Parent added", severity: "P2", body: "validated", code_location: null }], "overview", "verification");
		expect(accepted.ok).toBeTrue();
		expect(registry.acceptedFindings("s", 1)?.map((finding) => finding.title)).toEqual(["[P1] Canonical", "[P2] Parent added"]);
		expect(registry.recordFinalization("s", 1, [], [], "overview", "verification")).toEqual({ ok: false, error: "candidate finalization was already recorded for this invocation" });
	});
});
