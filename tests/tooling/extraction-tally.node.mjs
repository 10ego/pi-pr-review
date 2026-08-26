import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import {
	collectExtractionEntries,
	computeGateMetrics,
	formatAmbiguousSummary,
	formatLegacySummary,
	formatScoreboard,
	partitionCohorts,
	tallyRuns,
} from "./extraction-tally.mjs";

const ATTEMPT = (ordinal) => `g1-${String(ordinal).padStart(4, "0")}-0000-0000-0000-000000000000`;
const EMPTY_REASONS = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
/** Exact runtime-contract mirror counts: all six emitted fields, provenanceChecked = accepted + rejected. */
const MIRROR_COUNTS = {
	findingsExtracted: 1,
	findingsMerged: 1,
	findingsDeduped: 0,
	findingsRejectedProvenance: 0,
	findingsDroppedOverflow: 0,
	provenanceChecked: 1,
};
/** Exact runtime-contract counts for a correct-empty attempt: every emitted field, all zero. */
const ZERO_COUNTS = {
	findingsExtracted: 0,
	findingsMerged: 0,
	findingsDeduped: 0,
	findingsRejectedProvenance: 0,
	findingsDroppedOverflow: 0,
	provenanceChecked: 0,
};
/** Exact runtime-contract counts for an all-provenance-rejected attempt. */
const REJECTED_COUNTS = (rejected) => ({
	findingsExtracted: 0,
	findingsMerged: 0,
	findingsDeduped: 0,
	findingsRejectedProvenance: rejected,
	findingsDroppedOverflow: 0,
	provenanceChecked: rejected,
});
/** Exact runtime-contract record for the bare parse-rejection producer variant (no counts, no reasons). */
const BARE_REJECTED = (overrides = {}) => ({
	outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
	inputBytes: 400, elapsedMs: 1500, ...overrides,
});

function writeSession(dir, project, file, entries) {
	const projectDir = path.join(dir, project);
	fs.mkdirSync(projectDir, { recursive: true });
	const lines = entries.map((data) => JSON.stringify({
		type: "custom",
		customType: "pr-review-extraction",
		data,
		timestamp: "2026-08-26T00:00:00.000Z",
	}));
	fs.writeFileSync(path.join(projectDir, file), `${lines.join("\n")}\n`, "utf8");
}

function tempSessionDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "extraction-tally-test-"));
}

describe("§9 extraction tally cohort semantics", () => {
	test("partitionCohorts splits unambiguous v2 attempts from ambiguous v2 and legacy", () => {
		const { current, ambiguous, legacy } = partitionCohorts([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1) },
			{ outcome: "merged", schemaVersion: 2 }, // v2 without attempt identity
			{ outcome: "merged" },
			{ outcome: "empty" },
			{ outcome: "merged", schemaVersion: 3, attemptId: ATTEMPT(2) },
		]);
		assert.equal(current.length, 1);
		assert.equal(ambiguous.length, 1);
		assert.equal(legacy.length, 3);
	});

	test("not_run entries are excluded events, never runs or attempts", () => {
		const { runs, excluded } = tallyRuns([
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a" },
			{ outcome: "not_run", reason: "empty_input", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
		]);
		assert.equal(runs.length, 1);
		assert.equal(excluded.length, 2);
		const metrics = computeGateMetrics(runs, excluded);
		assert.equal(metrics.total, 1);
		assert.equal(metrics.excludedCount, 2);
		assert.deepEqual(metrics.excludedByReason, { no_lane_evidence: 1, empty_input: 1 });
	});

	test("counts a valid empty answer as extractor success; child failures stay failures", () => {
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 700, elapsedMs: 2500 },
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c", inputBytes: 600, elapsedMs: 8000 },
			{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(4), source: "d", inputBytes: 600, elapsedMs: 30000 },
			// Both real producer variants of `rejected` in one cohort.
			{ outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(5), source: "e", counts: REJECTED_COUNTS(3), provenanceRejectionReasons: { sourceQuoteAbsent: 3, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }, inputBytes: 600, elapsedMs: 5000 },
			// Bare parse rejection (malformed/fenced/oversized output): no counts, no reasons.
			{ outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(6), source: "f", inputBytes: 600, elapsedMs: 4500 },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 6);
		assert.equal(metrics.succeeded, 2);
		assert.equal(metrics.successRate, 1 / 3);
	});

	test("published terminal entries complete their own run and merge earlier outcomes", () => {
		const counts = { ...MIRROR_COUNTS };
		const reasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 1000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 1000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 700, elapsedMs: 800 },
		]);
		assert.equal(runs.length, 2);
		assert.equal(runs[0].outcome, "published");
		// The representative displays published but keeps merged-authoritative metrics.
		assert.equal(runs[0].counts, counts);
		assert.equal(runs[0].elapsedMs, 1000);
	});

	test("an earlier success cannot mask a later failure in the same session (success → failure)", () => {
		const counts = { ...MIRROR_COUNTS, findingsExtracted: 2, findingsMerged: 2, provenanceChecked: 2 };
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", inputBytes: 850, elapsedMs: 9000 },
		]);
		assert.equal(runs.length, 2);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 2);
		assert.equal(metrics.succeeded, 1);
		assert.equal(metrics.successRate, 0.5);
	});

	test("an earlier failure stays a failure when a later attempt succeeds (failure → success)", () => {
		const counts = { ...MIRROR_COUNTS };
		const { runs } = tallyRuns([
			{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", inputBytes: 840, elapsedMs: 9000 },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
		]);
		assert.equal(runs.length, 2);
		assert.deepEqual(runs.map((run) => run.outcome).sort(), ["published", "timeout"]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.succeeded, 1);
		assert.equal(metrics.successRate, 0.5);
	});

	test("conflicting terminal sequences inside one attempt fail closed as invalid attempts", () => {
		const conflicting = [
			["success then failure", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 2000 },
			]],
			["failure then success", [
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 2000 },
			]],
			["merged then unrelated terminal", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 2000 },
			]],
			["terminal then merged", [
				{ outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 2000 },
			]],
			["repeated merged", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
			]],
			["duplicate published", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
			]],
			["terminal after published", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 2000 },
			]],
			["orphan published", [
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
			]],
			["orphan published after failure", [
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s", elapsedMs: 1000 },
			]],
		];
		for (const [name, entries] of conflicting) {
			const { runs, invalid } = tallyRuns(entries.map((entry) => ({ ...entry, attemptId: `g1-${name}` })));
			assert.equal(runs.length, 0, `${name} must not produce a favorable run`);
			assert.equal(invalid.length, 1, `${name} must be reported invalid`);
			const metrics = computeGateMetrics(runs, [], invalid);
			// Invalid attempts count against success and sample volume, never drop.
			assert.equal(metrics.total, 1);
			assert.equal(metrics.succeeded, 0);
			assert.equal(metrics.successRate, 0);
			assert.equal(metrics.gateValid, false);
			assert.equal(metrics.invalidAttempts, 1);
		}
		// Specific deterministic reasons for the headline cases.
		assert.equal(tallyRuns([{ outcome: "published", schemaVersion: 2, attemptId: "g1-orphan", source: "s" }]).invalid[0].invalidReason, "orphan_published");
		assert.equal(tallyRuns([
				{ outcome: "merged", schemaVersion: 2, attemptId: "g1-x", source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: "g1-x", source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
				{ outcome: "published", schemaVersion: 2, attemptId: "g1-x", source: "s", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 1000 },
		]).invalid[0].invalidReason, "published_after_terminal");
		assert.equal(tallyRuns([
				{ outcome: "merged", schemaVersion: 2, attemptId: "g1-x", source: "s" },
				{ outcome: "failed", schemaVersion: 2, attemptId: "g1-x", source: "s" },
		]).invalid[0].invalidReason, "conflicting_terminal_sequence");
	});

	test("valid merged→published survives interleaving with another attempt's records", () => {
		const counts = { ...MIRROR_COUNTS, findingsExtracted: 2, findingsMerged: 2, provenanceChecked: 2 };
		const { runs, invalid } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", inputBytes: 820, elapsedMs: 8000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
		]);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 2);
		assert.deepEqual(runs.map((run) => [run.outcome, run.attemptId]).sort(), [
			["failed", ATTEMPT(2)],
			["published", ATTEMPT(1)],
		]);
	});

	test("published decorates only its own attempt, never an earlier attempt in the same session", () => {
		const countsA = { ...MIRROR_COUNTS, findingsExtracted: 2, findingsMerged: 2, provenanceChecked: 2 };
		const countsB = { ...MIRROR_COUNTS };
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts: countsA, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 3000 },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: countsB, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 800, elapsedMs: 3500 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: countsB, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 800, elapsedMs: 3500 },
		]);
		assert.equal(runs.length, 2);
		// The first attempt stays merged-only; the published event completes the
		// second attempt, and both remain separate terminal runs.
		assert.deepEqual(runs.map((run) => [run.outcome, run.attemptId]).sort(), [
			["merged", ATTEMPT(1)],
			["published", ATTEMPT(2)],
		]);
		// The published run keeps its own merged-authoritative counts.
		assert.equal(runs.find((run) => run.attemptId === ATTEMPT(2)).counts, countsB);
	});

	test("repeated attempts sharing a generation or session stay separate runs", () => {
		// Same generation, same source, distinct per-attempt nonces.
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: "g7-aaaa", source: "s1.jsonl", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "failed", schemaVersion: 2, attemptId: "g7-bbbb", source: "s1.jsonl", inputBytes: 600, elapsedMs: 9000 },
		]);
		assert.equal(runs.length, 2);
		// Same attempt identity in two different sources: two runs (coalescing is
		// keyed on source + attemptId, never attemptId alone).
		const { runs: acrossSources } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: "g7-aaaa", source: "s1.jsonl", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "failed", schemaVersion: 2, attemptId: "g7-aaaa", source: "s2.jsonl", inputBytes: 610, elapsedMs: 9500 },
		]);
		assert.equal(acrossSources.length, 2);
	});

	test("provenance rates use every provenance-checked candidate, not accepted findings only", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 5000, inputBytes: 1200,
				counts: { findingsExtracted: 6, findingsMerged: 6, findingsDeduped: 0, findingsRejectedProvenance: 2, findingsDroppedOverflow: 0, provenanceChecked: 8 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			},
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 700, elapsedMs: 1500 },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.findingsExtracted, 6);
		// The true denominator is accepted + rejected candidates (6 + 2), never
		// the accepted-only findingsExtracted (the old 2/6 understated the rate).
		assert.equal(metrics.provenanceChecked, 8);
		assert.equal(metrics.provenanceRejectionRate, 2 / 8);
		assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 });
		assert.equal(metrics.provenanceReasonsPartitioned, true);
		// Both runs now carry legitimate elapsed measurements; the p50 is over
		// the sorted pair [empty 1500, merged 5000].
		assert.equal(metrics.p50ElapsedMs, 1500);
	});

	test("P1 regression: 15 merged-only attempts omitting provenanceChecked fail closed", () => {
		// Every current production counts-bearing path receives parser/merge
		// counts carrying provenanceChecked, so a merged-only cohort omitting it
		// contradicts the producer contract: all fifteen fail closed.
		const entries = Array.from({ length: 15 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`,
			elapsedMs: 3000, inputBytes: 900,
			counts: { findingsExtracted: 2, findingsMerged: 2, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0 },
			provenanceRejectionReasons: { ...EMPTY_REASONS },
		}));
		const { runs, invalid } = tallyRuns(entries);
		assert.equal(runs.length, 0);
		assert.equal(invalid.length, 15);
		assert.ok(invalid.every((entry) => entry.invalidReason === "terminal_malformed_counts"));
		const metrics = computeGateMetrics(runs, [], invalid);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.invalidAttempts, 15);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.gateValid, false);
	});

	test("19 empty successes plus one all-rejected failure fails the provenance gate", () => {
		const entries = [
			...Array.from({ length: 19 }, (_, index) => ({
				outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: "s1.jsonl",
				counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 500, elapsedMs: 1000,
			})),
			{
				outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(20), source: "s1.jsonl", inputBytes: 500, elapsedMs: 1200,
				counts: REJECTED_COUNTS(6),
				provenanceRejectionReasons: { sourceQuoteAbsent: 6, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			},
		];
		const { runs } = tallyRuns(entries);
		// All twenty attempts are distinct identities in one session: none collapses.
		assert.equal(runs.length, 20);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 20);
		assert.equal(metrics.succeeded, 19);
		assert.equal(metrics.successRate, 0.95);
		assert.equal(metrics.findingsExtracted, 0);
		// Old denominator (accepted findingsExtracted = 0) reported a 0% rate and
		// passed; the checked-candidate denominator reports the true 100%.
		assert.equal(metrics.provenanceChecked, 6);
		assert.equal(metrics.provenanceRejectionRate, 1);
		assert.ok(metrics.provenanceRejectionRate >= 0.05, "the gate must fail on an all-rejected attempt");
	});

	test("negative or fractional count domains fail closed as invalid merged-only attempts", () => {
		// Under the outcome-specific runtime schema a merged-only representative
		// with an out-of-domain count value is an INVALID attempt (fail closed),
		// never a run whose counts quietly degrade.
		const cases = [
			["negative provenanceChecked", { ...MIRROR_COUNTS, findingsExtracted: 4, findingsMerged: 4, findingsRejectedProvenance: 2, provenanceChecked: -3 }],
			["fractional findingsExtracted", { ...MIRROR_COUNTS, findingsExtracted: 1.5, findingsMerged: 1.5, provenanceChecked: 1.5 }],
		];
		for (const [name, counts] of cases) {
			const { runs, invalid } = tallyRuns([{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
				counts, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 5000,
			}]);
			assert.equal(runs.length, 0, `${name} must not produce a favorable run`);
			assert.equal(invalid.length, 1, `${name} must be reported invalid`);
			assert.equal(invalid[0].invalidReason, "terminal_malformed_counts", name);
			const metrics = computeGateMetrics(runs, [], invalid);
			assert.equal(metrics.total, 1, name);
			assert.equal(metrics.succeeded, 0, name);
			assert.equal(metrics.gateValid, false, name);
		}
	});

	test("mismatched provenanceChecked partitions fail closed on representative and paired paths", () => {
		// An internally shape-valid counts record whose claimed denominator does
		// not equal accepted + rejected contradicts the producer partition and is
		// rejected BEFORE admission — never deferred to a later computation.
		const badCounts = { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: 100 };
		const reasons = { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		// Representative path (merged-only).
		let result = tallyRuns([{
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 5000,
		}]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_provenanceCheckedPartition");
		// Paired path: the malformed authoritative merged side fails first.
		result = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "a", counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 3000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "a", counts: MIRROR_COUNTS, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 900, elapsedMs: 3000 },
		]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "merged_malformed_provenanceCheckedPartition");
		// Paired path: a partition-broken published mirror fails on its own side.
		result = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(3), source: "a", counts: MIRROR_COUNTS, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 900, elapsedMs: 3000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(3), source: "a", counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 3000 },
		]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "published_malformed_provenanceCheckedPartition");
		assert.equal(computeGateMetrics([], [], result.invalid).gateValid, false);
		// Defense-in-depth for direct callers: computeGateMetrics handed such a
		// run object marks it UNTRUSTED (sample volume only) instead of
		// normalizing it through any later favorable computation.
		const direct = computeGateMetrics([{
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(4), source: "a",
			counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 5000,
			attemptEventCount: 1, attemptElapsedMs: 5000, attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
		}]);
		assert.equal(direct.untrustedRuns, 1);
		assert.deepEqual(direct.untrustedByReason, { provenanceCheckedPartition: 1 });
		assert.equal(direct.succeeded, 0);
		assert.equal(direct.gateValid, false);
	});

	test("per-reason counters that do not partition the aggregate fail closed at admission", () => {
		const { runs, invalid } = tallyRuns([
			{
				outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 400, elapsedMs: 1500,
				counts: REJECTED_COUNTS(2),
				// Reasons sum to 5 but only 2 candidates were rejected: the producer
				// partition is violated before admission, never normalized later.
				provenanceRejectionReasons: { sourceQuoteAbsent: 3, locationQuoteAbsent: 2, locationQuotePathMismatch: 0 },
			},
		]);
		assert.equal(runs.length, 0);
		assert.equal(invalid[0].invalidReason, "terminal_malformed_provenanceReasonPartition");
		const metrics = computeGateMetrics(runs, [], invalid);
		assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 });
		assert.equal(metrics.gateValid, false);
	});

	test("oversized or undersized claimed provenanceChecked denominators fail closed at admission", () => {
		// accepted 1 + rejected 1 = 2 checked; any other claim (the old dilution
		// attack checked=100, or an undersized claim) violates the producer
		// partition and is an invalid attempt before it can touch any rate.
		for (const [name, checked] of [["oversized", 100], ["undersized", 1]]) {
			const { runs, invalid } = tallyRuns([{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 1000, inputBytes: 900,
				counts: { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: checked },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			}]);
			assert.equal(runs.length, 0, name);
			assert.equal(invalid[0].invalidReason, "terminal_malformed_provenanceCheckedPartition", name);
			const metrics = computeGateMetrics(runs, [], invalid);
			assert.equal(metrics.total, 1, name);
			assert.equal(metrics.succeeded, 0, name);
			assert.equal(metrics.gateValid, false, name);
		}
	});

	test("valid exact provenanceChecked and partitioned reason counters keep the gate valid", () => {
		const { runs } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, elapsedMs: 3000, inputBytes: 600,
			counts: { findingsExtracted: 4, findingsMerged: 4, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: 5 },
			provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
		})));
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.provenanceCheckedExact, true);
		assert.equal(metrics.provenanceReasonsPartitioned, true);
		assert.equal(metrics.provenanceChecked, 75);
		assert.equal(metrics.provenanceRejectionRate, 15 / 75);
		assert.equal(metrics.malformedCounts, 0);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.gateValid, true);
		assert.equal(metrics.sufficientSample, true);
	});

	test("string, negative, fractional, and nonfinite reason counters fail closed as invalid attempts", () => {
		const attempt = (reasons) => ({
			outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 1000, inputBytes: 400,
			counts: REJECTED_COUNTS(2),
			provenanceRejectionReasons: reasons,
		});
		for (const reasons of [
			{ sourceQuoteAbsent: "1", locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: -1, locationQuoteAbsent: 3, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: 0.5, locationQuoteAbsent: 1.5, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: Infinity, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: NaN, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
		]) {
			const { runs, invalid } = tallyRuns([attempt(reasons)]);
			assert.equal(runs.length, 0, JSON.stringify(reasons));
			assert.equal(invalid.length, 1, JSON.stringify(reasons));
			assert.equal(invalid[0].invalidReason, "terminal_malformed_provenanceRejectionReasons", JSON.stringify(reasons));
			const metrics = computeGateMetrics(runs, [], invalid);
			assert.equal(metrics.total, 1, JSON.stringify(reasons));
			assert.equal(metrics.succeeded, 0, JSON.stringify(reasons));
			assert.equal(metrics.gateValid, false, JSON.stringify(reasons));
		}
	});

	test("fifteen successful attempts without elapsedMs fail closed as schema-invalid", () => {
		// The runtime producer emits elapsedMs on EVERY terminal outcome, so an
		// elapsed-less empty is not merely latency-incomplete: it violates the
		// outcome-specific schema and becomes an invalid attempt that blocks the
		// gate. It can never be a favorable all-success cohort.
		const { runs, invalid } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`,
			counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 300,
		})));
		assert.equal(runs.length, 0);
		assert.equal(invalid.length, 15);
		assert.equal(invalid[0].invalidReason, "terminal_malformed_elapsedMs");
		const metrics = computeGateMetrics(runs, [], invalid);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.invalidAttempts, 15);
		assert.equal(metrics.latencyMeasured, 0);
		assert.equal(metrics.p50ElapsedMs, 0);
		assert.equal(metrics.gateValid, false);
		const text = formatScoreboard(runs, metrics);
		assert.match(text, /invalid attempt sequences\s+: 15/);
		assert.match(text, /Gate telemetry validity\s+: INVALID/);
	});

	test("a legitimate zero elapsedMs counts in the p50 and keeps latency complete", () => {
		const { runs } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, elapsedMs: 0,
			counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 300,
		})));
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.latencyMeasured, 15);
		assert.equal(metrics.p50ElapsedMs, 0);
		assert.equal(metrics.gateValid, true);
	});

	test("negative, nonnumeric, and nonfinite latency fail closed as schema-invalid attempts", () => {
		// The producer always emits a finite nonnegative elapsedMs; any other
		// value violates the outcome schema and makes the attempt invalid.
		for (const bad of [-5, "fast", Infinity, NaN, null, [9000]]) {
			const { runs, invalid } = tallyRuns([
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 512, elapsedMs: bad },
			]);
			assert.equal(runs.length, 0, JSON.stringify(bad));
			assert.equal(invalid.length, 1, JSON.stringify(bad));
			assert.equal(invalid[0].invalidReason, "terminal_malformed_elapsedMs", JSON.stringify(bad));
			const metrics = computeGateMetrics(runs, [], invalid);
			assert.equal(metrics.gateValid, false, JSON.stringify(bad));
		}
		// Divergent elapsedMs inside a merged→published sequence: the published
		// event fails to mirror the authoritative merged measurement, so the whole
		// attempt fails closed as invalid — never a favorable run.
		const { runs: conflicting, invalid: conflictingInvalid } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 5000 },
		]);
		assert.equal(conflicting.length, 0);
		assert.equal(conflictingInvalid.length, 1);
		assert.equal(conflictingInvalid[0].invalidReason, "published_divergent_elapsedMs");
		const conflictingMetrics = computeGateMetrics(conflicting, [], conflictingInvalid);
		assert.equal(conflictingMetrics.invalidAttempts, 1);
		assert.equal(conflictingMetrics.gateValid, false);
	});

	test("schema-valid runs always carry exactly one elapsed measurement; excluded decisions need none", () => {
		const { runs } = tallyRuns([
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 300, elapsedMs: 2000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 310, elapsedMs: 2000 },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.latencyMeasured, 2);
		assert.equal(metrics.latencyMissing, 0);
		assert.equal(metrics.latencyConflicting, 0);
		assert.equal(metrics.latencyMalformed, 0);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.p50ElapsedMs, 2000);
		assert.equal(metrics.gateValid, true);
		// Excluded not_run decisions need no latency at all and never break completeness.
		const withExcluded = computeGateMetrics(runs, [
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c" },
		]);
		assert.equal(withExcluded.latencyComplete, true);
		assert.equal(withExcluded.excludedCount, 1);
	});

	test("merged stays authoritative through publication: 15 identically partition-broken pairs fail closed", () => {
		// Fifteen merged→published pairs whose counts are internally identical on
		// both sides but whose claimed checked denominator contradicts accepted +
		// rejected. Equality never legitimizes them; each attempt fails closed on
		// its authoritative merged side before any favorable computation.
		const badCounts = { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: 100 };
		const reasons = { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		const entries = [];
		for (let index = 0; index < 15; index++) {
			entries.push({ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 3000 });
			entries.push({ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: { ...badCounts }, provenanceRejectionReasons: { ...reasons }, inputBytes: 900, elapsedMs: 3000 });
		}
		const { runs, invalid } = tallyRuns(entries);
		assert.equal(runs.length, 0);
		assert.equal(invalid.length, 15);
		assert.ok(invalid.every((entry) => entry.invalidReason === "merged_malformed_provenanceCheckedPartition"));
		const metrics = computeGateMetrics(runs, [], invalid);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.invalidAttempts, 15);
		assert.equal(metrics.gateValid, false);
	});

	test("published cannot replace merged metrics: mismatches invalidate the attempt", () => {
		const base = (overrides) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { findingsExtracted: 0, findingsMerged: 0, findingsDeduped: 0, findingsRejectedProvenance: 6, findingsDroppedOverflow: 0, provenanceChecked: 6 },
			provenanceRejectionReasons: { sourceQuoteAbsent: 6, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			inputBytes: 900, elapsedMs: 3000, ...overrides,
		});
		const published = (overrides) => ({
			outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { findingsExtracted: 0, findingsMerged: 0, findingsDeduped: 0, findingsRejectedProvenance: 6, findingsDroppedOverflow: 0, provenanceChecked: 6 },
			provenanceRejectionReasons: { sourceQuoteAbsent: 6, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			inputBytes: 900, elapsedMs: 3000, ...overrides,
		});
		// Favorable published counts claiming the all-rejected merge actually
		// merged findings: the fabricated mirror is internally partition-consistent
		// (checked 6 = extracted 6 + rejected 0, zero reasons) yet still diverges
		// from the authoritative merged record.
		let result = tallyRuns([base(), published({ counts: { findingsExtracted: 6, findingsMerged: 6, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 6 }, provenanceRejectionReasons: { ...EMPTY_REASONS } })]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_counts");
		// Favorable published reason counters rewriting (not erasing) the rejects:
		// partition-consistent (4+2+0 = 6) yet divergent from merged.
		result = tallyRuns([base(), published({ provenanceRejectionReasons: { sourceQuoteAbsent: 4, locationQuoteAbsent: 2, locationQuotePathMismatch: 0 } })]);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_provenanceRejectionReasons");
		// An erasing zero mirror against six rejects violates the published side's
		// own producer partition even before divergence is considered.
		result = tallyRuns([base(), published({ provenanceRejectionReasons: { ...EMPTY_REASONS } })]);
		assert.equal(result.invalid[0].invalidReason, "published_malformed_provenanceReasonPartition");
		// Divergent inputBytes and elapsedMs.
		result = tallyRuns([base(), published({ inputBytes: 1 })]);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_inputBytes");
		result = tallyRuns([base(), published({ elapsedMs: 4000 })]);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_elapsedMs");
		// Promised-field omissions on the published event.
		for (const field of ["counts", "provenanceRejectionReasons", "inputBytes", "elapsedMs"]) {
			const { [field]: omitted, ...rest } = published();
			void omitted;
			const omittedResult = tallyRuns([base(), rest]);
			assert.equal(omittedResult.runs.length, 0, field);
			assert.equal(omittedResult.invalid[0].invalidReason, `published_missing_${field}`);
		}
		// A malformed (non-object) published counts value fails the schema, never trusted.
		result = tallyRuns([base(), published({ counts: "6 findings" })]);
		assert.equal(result.invalid[0].invalidReason, "published_malformed_counts");
		// Invalid attempts count against success and sample and block the gate.
		const metrics = computeGateMetrics(result.runs, [], result.invalid);
		assert.equal(metrics.total, 1);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, false);
	});

	test("published cannot erase all-rejected provenance when it mirrors exactly", () => {
		const counts = { findingsExtracted: 0, findingsMerged: 0, findingsDeduped: 0, findingsRejectedProvenance: 6, findingsDroppedOverflow: 0, provenanceChecked: 6 };
		const reasons = { sourceQuoteAbsent: 6, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 3000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 3000 },
		]);
		assert.equal(runs.length, 1);
		// Representative displays published but carries the merged-authoritative
		// all-rejected counts: the provenance rate stays 100%.
		assert.equal(runs[0].outcome, "published");
		assert.equal(runs[0].counts, counts);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.provenanceChecked, 6);
		assert.equal(metrics.provenanceRejectionRate, 1);
	});

	test("identically malformed gate fields on both sides never pass: 15 identical inputBytes strings fail closed", () => {
		// The exact accepted-P2 regression: presence + deep equality alone would
		// accept fifteen attempts whose inputBytes is the same malformed string on
		// the merged AND published sides. Independent schema validation of the
		// authoritative merged record must fail all fifteen.
		const entries = [];
		for (let index = 0; index < 15; index++) {
			entries.push({ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: { ...MIRROR_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: "tiny", elapsedMs: 3000 });
			entries.push({ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: { ...MIRROR_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: "tiny", elapsedMs: 3000 });
		}
		const { runs, invalid } = tallyRuns(entries);
		assert.equal(runs.length, 0);
		assert.equal(invalid.length, 15);
		assert.equal(invalid[0].invalidReason, "merged_malformed_inputBytes");
		const metrics = computeGateMetrics(runs, [], invalid);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.gateValid, false);
	});

	test("identically malformed counts, reasons, and elapsed on both sides fail closed per field", () => {
		const VALID_COUNTS = { ...MIRROR_COUNTS };
		const VALID_REASONS = { ...EMPTY_REASONS };
		/** A merged→published pair sharing one identically malformed field on both sides. */
		const pair = (field, value) => [
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { ...VALID_COUNTS }, provenanceRejectionReasons: { ...VALID_REASONS }, inputBytes: 900, elapsedMs: 3000, [field]: value },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { ...VALID_COUNTS }, provenanceRejectionReasons: { ...VALID_REASONS }, inputBytes: 900, elapsedMs: 3000, [field]: value },
		];
		const cases = [
			// Malformed counts shapes on BOTH sides: equality never legitimizes them.
			["counts missing a required field", "counts", { findingsExtracted: 1, findingsMerged: 1, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 1 }],
			["counts array", "counts", [1, 1, 0, 0, 0, 1]],
			["counts null", "counts", null],
			["counts string", "counts", "1 merged"],
			["counts negative integer", "counts", { ...VALID_COUNTS, findingsExtracted: -1 }],
			["counts fractional integer field", "counts", { ...VALID_COUNTS, findingsMerged: 1.5 }],
			["counts NaN field", "counts", { ...VALID_COUNTS, findingsDeduped: Number.NaN }],
			["counts Infinity field", "counts", { ...VALID_COUNTS, findingsDroppedOverflow: Number.POSITIVE_INFINITY }],
			["counts unexpected extra field", "counts", { ...VALID_COUNTS, findingsHallucinated: 3 }],
			["counts non-integer provenanceChecked", "counts", { ...VALID_COUNTS, provenanceChecked: 1.5 }],
			// Malformed reason-counter shapes on BOTH sides.
			["reasons missing a field", "provenanceRejectionReasons", { sourceQuoteAbsent: 0, locationQuoteAbsent: 0 }],
			["reasons array", "provenanceRejectionReasons", [0, 0, 0]],
			["reasons null", "provenanceRejectionReasons", null],
			["reasons negative counter", "provenanceRejectionReasons", { sourceQuoteAbsent: -1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons fractional counter", "provenanceRejectionReasons", { sourceQuoteAbsent: 0.5, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons string counter", "provenanceRejectionReasons", { sourceQuoteAbsent: "0", locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons unexpected extra field", "provenanceRejectionReasons", { ...EMPTY_REASONS, sourceQuoteAbsentTwice: 1 }],
			// Malformed inputBytes shapes on BOTH sides.
			["inputBytes negative", "inputBytes", -900],
			["inputBytes fractional", "inputBytes", 900.5],
			["inputBytes NaN", "inputBytes", Number.NaN],
			["inputBytes Infinity", "inputBytes", Number.POSITIVE_INFINITY],
			["inputBytes string", "inputBytes", "900"],
			["inputBytes null", "inputBytes", null],
			["inputBytes array", "inputBytes", [900]],
			// Malformed elapsedMs shapes on BOTH sides (nonnegative finite number required).
			["elapsedMs negative", "elapsedMs", -3000],
			["elapsedMs NaN", "elapsedMs", Number.NaN],
			["elapsedMs Infinity", "elapsedMs", Number.POSITIVE_INFINITY],
			["elapsedMs string", "elapsedMs", "3000"],
			["elapsedMs null", "elapsedMs", null],
			["elapsedMs array", "elapsedMs", [3000]],
		];
		for (const [name, field, value] of cases) {
			const { runs, invalid } = tallyRuns(pair(field, value));
			assert.equal(runs.length, 0, `${name} must not produce a favorable run`);
			assert.equal(invalid.length, 1, `${name} must be reported invalid`);
			assert.equal(invalid[0].invalidReason, `merged_malformed_${field}`, name);
		}
		// The malformed side always blocks the gate.
		const metrics = computeGateMetrics([], [], tallyRuns(pair("inputBytes", "900")).invalid);
		assert.equal(metrics.total, 1);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, false);
	});

	test("a schema-invalid published mirror is rejected even against a valid merged record", () => {
		const valid = (outcome) => ({
			outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { ...MIRROR_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 900, elapsedMs: 3000,
		});
		const cases = [
			["counts missing a required field", "counts", { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 0, provenanceChecked: 1 }],
			["counts array", "counts", [1, 1, 0, 0, 0, 1]],
			["counts negative", "counts", { ...MIRROR_COUNTS, findingsExtracted: -1 }],
			["counts unexpected extra field", "counts", { ...MIRROR_COUNTS, findingsHallucinated: 3 }],
			["reasons missing a field", "provenanceRejectionReasons", { sourceQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons negative counter", "provenanceRejectionReasons", { sourceQuoteAbsent: -1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons string counter", "provenanceRejectionReasons", { sourceQuoteAbsent: "0", locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["inputBytes fractional", "inputBytes", 900.5],
			["inputBytes negative", "inputBytes", -1],
			["inputBytes string", "inputBytes", "900"],
			["inputBytes Infinity", "inputBytes", Number.POSITIVE_INFINITY],
			["elapsedMs negative", "elapsedMs", -1],
			["elapsedMs NaN", "elapsedMs", Number.NaN],
			["elapsedMs Infinity", "elapsedMs", Number.POSITIVE_INFINITY],
			["elapsedMs string", "elapsedMs", "3000"],
		];
		for (const [name, field, value] of cases) {
			const { runs, invalid } = tallyRuns([valid("merged"), { ...valid("published"), [field]: value }]);
			assert.equal(runs.length, 0, `${name} must not produce a favorable run`);
			assert.equal(invalid.length, 1, `${name} must be reported invalid`);
			assert.equal(invalid[0].invalidReason, `published_malformed_${field}`, name);
		}
	});

	test("valid zero values and exact valid runtime mirrors pass the schema gate", () => {
		// All-zero legitimate values: zero counts (including optional
		// provenanceChecked), zero reason counters, zero inputBytes, zero elapsedMs.
		const zeroCounts = { findingsExtracted: 0, findingsMerged: 0, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 0 };
		const { runs, invalid } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { ...zeroCounts }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 0, elapsedMs: 0 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { ...zeroCounts }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 0, elapsedMs: 0 },
		]);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].outcome, "published");
		assert.deepEqual(runs[0].counts, zeroCounts);
		const zeroMetrics = computeGateMetrics(runs);
		assert.equal(zeroMetrics.succeeded, 1);
		assert.equal(zeroMetrics.gateValid, true);
		// The exact runtime mirror: the precise record shape the extension emits
		// for a real merged→published publication (byte-equivalent gate fields,
		// fractional elapsedMs allowed as a finite nonnegative number).
		const runtimeCounts = { findingsExtracted: 2, findingsMerged: 1, findingsDeduped: 1, findingsRejectedProvenance: 0, findingsDroppedOverflow: 1, provenanceChecked: 2 };
		const runtimeReasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		const { runs: runtimeRuns, invalid: runtimeInvalid } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: runtimeCounts, provenanceRejectionReasons: runtimeReasons, inputBytes: 12_345, elapsedMs: 3210.5, effectiveModel: "provider/primary" },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: runtimeCounts, provenanceRejectionReasons: runtimeReasons, inputBytes: 12_345, elapsedMs: 3210.5, effectiveModel: "provider/primary", inlineComments: 1 },
		]);
		assert.equal(runtimeInvalid.length, 0);
		assert.equal(runtimeRuns.length, 1);
		assert.equal(runtimeRuns[0].outcome, "published");
		// The representative keeps merged-authoritative metrics and accepts
		// published-only decoration (inlineComments).
		assert.equal(runtimeRuns[0].counts, runtimeCounts);
		assert.equal(runtimeRuns[0].inputBytes, 12_345);
		assert.equal(runtimeRuns[0].elapsedMs, 3210.5);
		assert.equal(runtimeRuns[0].inlineComments, 1);
		const runtimeMetrics = computeGateMetrics(runtimeRuns);
		assert.equal(runtimeMetrics.succeeded, 1);
		assert.equal(runtimeMetrics.gateValid, true);
	});

	test("P1 regression: 15 merged-only attempts missing provenanceRejectionReasons or inputBytes fail closed", () => {
		// Plausible counts and latency but missing the promised provenance and
		// input-size telemetry. With publishing default-off there is no published
		// mirror to cross-check against; before the outcome-specific schemas these
		// fifteen attempts produced sufficientSample=true, gateValid=true, and a
		// perfect success rate. The merged schema must reject every one.
		const mergedOnly = (overrides = {}) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(overrides.ordinal ?? 1),
			source: `s${overrides.ordinal ?? 0}`, elapsedMs: 3000,
			counts: { findingsExtracted: 2, findingsMerged: 2, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 2 },
			...(overrides.entry ?? {}),
		});
		const missingReasons = tallyRuns(Array.from({ length: 15 }, (_, index) =>
			mergedOnly({ ordinal: index + 1, entry: { inputBytes: 900 } })));
		assert.equal(missingReasons.runs.length, 0);
		assert.equal(missingReasons.invalid.length, 15);
		assert.ok(missingReasons.invalid.every((entry) => entry.invalidReason === "terminal_malformed_provenanceRejectionReasons"));
		const missingInput = tallyRuns(Array.from({ length: 15 }, (_, index) =>
			mergedOnly({ ordinal: index + 1, entry: { provenanceRejectionReasons: { ...EMPTY_REASONS } } })));
		assert.equal(missingInput.runs.length, 0);
		assert.equal(missingInput.invalid.length, 15);
		assert.ok(missingInput.invalid.every((entry) => entry.invalidReason === "terminal_malformed_inputBytes"));
		const metrics = computeGateMetrics(missingReasons.runs, [], missingReasons.invalid);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.invalidAttempts, 15);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.gateValid, false);
		const text = formatScoreboard(missingReasons.runs, metrics);
		assert.match(text, /WARNING: 15 attempt\(s\) failed the per-attempt event state machine or their outcome-specific runtime schema/);
		assert.match(text, /Gate telemetry validity\s+: INVALID/);
		// The inputBytes-missing cohort fails closed identically.
		assert.equal(computeGateMetrics(missingInput.runs, [], missingInput.invalid).gateValid, false);
	});

	test("malformed merged-only counts, reasons, input, and elapsed domains fail closed", () => {
		const base = {
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { ...MIRROR_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 900, elapsedMs: 3000,
		};
		const cases = [
			["counts missing a required field", "counts", { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 0, provenanceChecked: 1 }],
			["counts array", "counts", [1, 1, 0, 0, 0, 1]],
			["counts string", "counts", "1 merged"],
			["counts negative field", "counts", { ...MIRROR_COUNTS, findingsMerged: -1 }],
			["counts extra field", "counts", { ...MIRROR_COUNTS, findingsHallucinated: 3 }],
			["reasons missing a field", "provenanceRejectionReasons", { sourceQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["reasons negative", "provenanceRejectionReasons", { ...EMPTY_REASONS, locationQuoteAbsent: -2 }],
			["reasons string", "provenanceRejectionReasons", { sourceQuoteAbsent: "0", locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }],
			["inputBytes negative", "inputBytes", -900],
			["inputBytes fractional", "inputBytes", 900.5],
			["inputBytes string", "inputBytes", "900"],
			["inputBytes nonfinite", "inputBytes", Number.POSITIVE_INFINITY],
			["inputBytes NaN", "inputBytes", Number.NaN],
			["elapsedMs negative", "elapsedMs", -3000],
			["elapsedMs string", "elapsedMs", "3000"],
			["elapsedMs nonfinite", "elapsedMs", Number.POSITIVE_INFINITY],
		];
		for (const [name, field, value] of cases) {
			const { runs, invalid } = tallyRuns([{ ...base, [field]: value }]);
			assert.equal(runs.length, 0, `${name} must not produce a favorable run`);
			assert.equal(invalid.length, 1, `${name} must be reported invalid`);
			assert.equal(invalid[0].invalidReason, `terminal_malformed_${field}`, name);
			const metrics = computeGateMetrics(runs, [], invalid);
			assert.equal(metrics.total, 1, name);
			assert.equal(metrics.succeeded, 0, name);
			assert.equal(metrics.gateValid, false, name);
		}
	});

	test("correct-empty outcomes missing or malforming producer-required fields fail closed", () => {
		const validEmpty = () => ({
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { ...ZERO_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 300, elapsedMs: 1200,
		});
		// Missing any producer-emitted field fails closed.
		for (const field of ["counts", "provenanceRejectionReasons", "inputBytes", "elapsedMs"]) {
			const { [field]: omitted, ...rest } = validEmpty();
			void omitted;
			const { runs, invalid } = tallyRuns([rest]);
			assert.equal(runs.length, 0, field);
			assert.equal(invalid.length, 1, field);
			assert.equal(invalid[0].invalidReason, `terminal_malformed_${field}`, field);
		}
		// Malformed domains fail closed.
		for (const [name, field, value] of [
			["counts string", "counts", "{findings: []}"],
			["reasons negative", "provenanceRejectionReasons", { ...EMPTY_REASONS, sourceQuoteAbsent: -1 }],
			["inputBytes fractional", "inputBytes", 300.5],
			["elapsedMs NaN", "elapsedMs", Number.NaN],
		]) {
			const { runs, invalid } = tallyRuns([{ ...validEmpty(), [field]: value }]);
			assert.equal(runs.length, 0, name);
			assert.equal(invalid[0].invalidReason, `terminal_malformed_${field}`, name);
		}
		// A record claiming extracted or rejected findings contradicts the only
		// producer path that emits `empty` (a clean {"findings":[]} answer).
		const lyingCounts = tallyRuns([{
			...validEmpty(),
			counts: { ...ZERO_COUNTS, findingsExtracted: 2, findingsMerged: 1, provenanceChecked: 2 },
		}]);
		assert.equal(lyingCounts.runs.length, 0);
		assert.equal(lyingCounts.invalid[0].invalidReason, "terminal_malformed_inconsistent_empty_counts");
		const lyingReasons = tallyRuns([{
			...validEmpty(),
			provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
		}]);
		assert.equal(lyingReasons.runs.length, 0);
		// The exact producer partition (reason sum === rejected) fails first.
		assert.equal(lyingReasons.invalid[0].invalidReason, "terminal_malformed_provenanceReasonPartition");
	});

	test("a valid emitted correct-empty record counts as execution success only", () => {
		const { runs, invalid } = tallyRuns([{
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			counts: { ...ZERO_COUNTS }, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 300, elapsedMs: 1200,
		}]);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 1);
		const metrics = computeGateMetrics(runs);
		// Execution success only: an exactly-zero empty record enters the
		// extractor-success numerator while claiming nothing about the review
		// being clean — no extracted findings, no merged findings, no approval.
		assert.equal(metrics.succeeded, 1);
		assert.equal(metrics.findingsExtracted, 0);
		assert.equal(metrics.findingsMerged, 0);
		assert.equal(metrics.provenanceChecked, 0);
		assert.equal(metrics.provenanceRejectionRate, 0);
		assert.equal(metrics.gateValid, true);
	});

	test("failed/timeout/aborted require exactly their producer-emitted fields", () => {
		// A bare failure carrying only identity, input size, and latency is the
		// exact runtime shape and remains an ordinary failure run.
		for (const outcome of ["failed", "timeout", "aborted"]) {
			const { runs, invalid } = tallyRuns([
				{ outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 512, elapsedMs: 8000 },
			]);
			assert.equal(invalid.length, 0, outcome);
			assert.equal(runs.length, 1, outcome);
			assert.equal(computeGateMetrics(runs).succeeded, 0, outcome);
		}
		const base = { outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 512, elapsedMs: 8000 };
		// Missing or malforming either always-emitted field fails closed.
		for (const [field, value] of [
			["inputBytes", undefined], ["inputBytes", -1], ["inputBytes", "512"],
			["elapsedMs", undefined], ["elapsedMs", -1], ["elapsedMs", "fast"],
		]) {
			const entry = { ...base };
			if (value === undefined) delete entry[field];
			else entry[field] = value;
			const { runs, invalid } = tallyRuns([entry]);
			assert.equal(runs.length, 0, `${field}=${JSON.stringify(value)}`);
			assert.equal(invalid[0].invalidReason, `terminal_malformed_${field}`, `${field}=${JSON.stringify(value)}`);
		}
		// Fabricated gate fields the producer never emits on bare failures are
		// forbidden at the exact top-level key layer.
		for (const [field, value] of [
			["counts", { ...MIRROR_COUNTS }],
			["provenanceRejectionReasons", { ...EMPTY_REASONS }],
		]) {
			const { runs, invalid } = tallyRuns([{ ...base, [field]: value }]);
			assert.equal(runs.length, 0, field);
			assert.equal(invalid[0].invalidReason, `forbidden_field_${field}`, field);
			assert.equal(computeGateMetrics(runs, [], invalid).gateValid, false, field);
		}
	});

	test("bare parse-rejection variant carries exactly identity, input, latency, optional model", () => {
		// Real producer path (extensions/review-table.ts settlePendingExtraction):
		// oversized/malformed/fenced/structural parse rejection invokes
		// recordOutcome("rejected", undefined, effectiveModel) — no counts,
		// no reasons.
		const { runs, invalid } = tallyRuns([BARE_REJECTED()]);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].outcome, "rejected");
		// The effectiveModel decoration is part of the real emission.
		const decorated = tallyRuns([BARE_REJECTED({ effectiveModel: "provider/light" })]);
		assert.equal(decorated.invalid.length, 0);
		assert.equal(decorated.runs.length, 1);
		// A genuine rejection stays an ordinary failed extraction attempt: in the
		// sample, never an execution success, and never gate-invalidating by itself.
		const metrics = computeGateMetrics(decorated.runs);
		assert.equal(metrics.total, 1);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.gateValid, true);
	});

	test("one-sided rejected variants fail closed as invalid attempts", () => {
		const base = BARE_REJECTED();
		// Counts-bearing variant stripped of its reason counters.
		let result = tallyRuns([{ ...base, counts: REJECTED_COUNTS(2) }]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_rejectedMissingReasons");
		// Bare variant fabricating reason counters without counts.
		result = tallyRuns([{ ...base, provenanceRejectionReasons: { ...EMPTY_REASONS } }]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_rejectedMissingCounts");
		const metrics = computeGateMetrics([], [], result.invalid);
		assert.equal(metrics.total, 1);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, false);
	});

	test("counts-bearing rejected requires the exact complete counts schema and both partitions", () => {
		const valid = () => ({
			outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 400, elapsedMs: 1500,
			counts: REJECTED_COUNTS(2),
			provenanceRejectionReasons: { sourceQuoteAbsent: 2, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
		});
		// Real producer paths (all candidates provenance-rejected, or canonical
		// merge/publication validation rejection) keep the full parser counts shape.
		let result = tallyRuns([valid()]);
		assert.equal(result.invalid.length, 0);
		assert.equal(result.runs.length, 1);
		let metrics = computeGateMetrics(result.runs);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, true);
		// Malformed counts shape (missing required fields).
		result = tallyRuns([{ ...valid(), counts: { findingsExtracted: 0, findingsRejectedProvenance: 2, provenanceChecked: 2 } }]);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_counts");
		// Mismatched checked denominator.
		result = tallyRuns([{ ...valid(), counts: { ...REJECTED_COUNTS(2), provenanceChecked: 99 } }]);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_provenanceCheckedPartition");
		// Non-partitioning reason counters.
		result = tallyRuns([{ ...valid(), provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 } }]);
		assert.equal(result.invalid[0].invalidReason, "terminal_malformed_provenanceReasonPartition");
		metrics = computeGateMetrics([], [], result.invalid);
		assert.equal(metrics.gateValid, false);
	});

	test("mixed real rejected variants stay trustworthy separate attempts in one cohort", () => {
		const { runs, invalid } = tallyRuns([
			BARE_REJECTED({ attemptId: ATTEMPT(1), source: "s1.jsonl" }),
			{ outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", inputBytes: 400, elapsedMs: 1600, counts: REJECTED_COUNTS(3), provenanceRejectionReasons: { sourceQuoteAbsent: 3, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 } },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(3), source: "s1.jsonl", counts: MIRROR_COUNTS, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 900, elapsedMs: 3000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(4), source: "s1.jsonl", counts: ZERO_COUNTS, provenanceRejectionReasons: { ...EMPTY_REASONS }, inputBytes: 700, elapsedMs: 2000 },
		]);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 4);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 4);
		// Only merged + empty are extractor successes; both rejections stay failures.
		assert.equal(metrics.succeeded, 2);
		assert.equal(metrics.successRate, 0.5);
		// Provenance aggregates come only from the two counts-bearing records
		// (rejected 3 + merged 1); the bare variant contributes nothing it never emitted.
		assert.equal(metrics.provenanceChecked, 4);
		assert.equal(metrics.provenanceRejectionRate, 3 / 4);
		// Real rejections do not invalidate an otherwise trustworthy cohort.
		assert.equal(metrics.gateValid, true);
	});

	test("direct computeGateMetrics fails closed: 15 fabricated merged runs without counts/checked/reasons are untrusted", () => {
		// The exact accepted P2 attack: plausible identity/input/latency with NO
		// required telemetry used to normalize favorably to gateValid=true, a
		// perfect success rate, and a 0% rejection rate.
		const fabricated = Array.from({ length: 15 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`,
			inputBytes: 900, elapsedMs: 3000,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
		}));
		const metrics = computeGateMetrics(fabricated);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.untrustedRuns, 15);
		assert.deepEqual(metrics.untrustedByReason, { counts: 15 });
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.provenanceChecked, 0);
		assert.equal(metrics.latencyMeasured, 0);
		assert.equal(metrics.gateValid, false);
	});

	test("contradictory and latency-less direct runs are untrusted per violation", () => {
		const base = () => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 3000,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
		});
		// Oversized claimed checked denominator.
		let metrics = computeGateMetrics([{ ...base(), counts: { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: 100 }, provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 } }]);
		assert.deepEqual(metrics.untrustedByReason, { provenanceCheckedPartition: 1 });
		// Non-partitioning reason counters.
		metrics = computeGateMetrics([{ ...base(), counts: { findingsExtracted: 0, findingsMerged: 0, findingsDeduped: 0, findingsRejectedProvenance: 2, findingsDroppedOverflow: 0, provenanceChecked: 2 }, provenanceRejectionReasons: { sourceQuoteAbsent: 5, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 } }]);
		assert.deepEqual(metrics.untrustedByReason, { provenanceReasonPartition: 1 });
		// Missing represented latency measurement at this boundary.
		metrics = computeGateMetrics([{
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", inputBytes: 900, elapsedMs: 3000,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
		}]);
		assert.deepEqual(metrics.untrustedByReason, { elapsed_measurement: 1 });
		assert.equal(metrics.untrustedRuns, 1);
		assert.equal(metrics.gateValid, false);
	});

	test("valid direct counts-bearing runs stay trusted across all variants", () => {
		const run = (outcome, counts, reasons) => ({
			outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 400, elapsedMs: 1200,
			attemptEventCount: 1, attemptElapsedMs: 1200,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			counts, provenanceRejectionReasons: reasons,
		});
		const metrics = computeGateMetrics([
			run("merged", MIRROR_COUNTS, EMPTY_REASONS),
			// A published decoration is a two-event merged→published sequence.
			{ ...run("published", MIRROR_COUNTS, EMPTY_REASONS), attemptEventCount: 2 },
			run("empty", ZERO_COUNTS, EMPTY_REASONS),
			run("rejected", REJECTED_COUNTS(2), { sourceQuoteAbsent: 2, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }),
		]);
		assert.equal(metrics.untrustedRuns, 0);
		assert.equal(metrics.succeeded, 3); // merged + published + empty only
		assert.equal(metrics.findingsExtracted, 2);
		assert.equal(metrics.provenanceChecked, 4);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.gateValid, true);
	});

	test("valid direct bare rejected/failure runs need no counts; fabricated ones are untrusted", () => {
		const bare = (outcome, overrides = {}) => ({
			outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 400, elapsedMs: 1500,
			attemptEventCount: 1, attemptElapsedMs: 1500,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			...overrides,
		});
		const metrics = computeGateMetrics([bare("rejected"), bare("failed"), bare("timeout", { effectiveModel: "provider/light" })]);
		assert.equal(metrics.untrustedRuns, 0);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, true);
		// A fabricated bare failure carrying counts is untrusted, never normalized.
		const fabricated = computeGateMetrics([bare("failed", { counts: REJECTED_COUNTS(2) })]);
		assert.deepEqual(fabricated.untrustedByReason, { unexpected_counts: 1 });
		assert.equal(fabricated.succeeded, 0);
		assert.equal(fabricated.gateValid, false);
	});

	test("direct runs with contradictory tally latency flags are untrusted", () => {
		// The exact accepted P2 attack: a present attemptElapsedMs plus a
		// contradictory flag used to yield a valid favorable gate.
		const run = (overrides = {}) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 3000,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
			...overrides,
		});
		const conflicting = Array.from({ length: 15 }, (_, index) =>
			run({ attemptId: ATTEMPT(index + 1), source: `s${index}`, attemptElapsedConflicting: true }));
		let metrics = computeGateMetrics(conflicting);
		assert.equal(metrics.untrustedRuns, 15);
		assert.deepEqual(metrics.untrustedByReason, { latency_flags: 15 });
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.successRate, 0);
		assert.equal(metrics.p50ElapsedMs, 0);
		assert.equal(metrics.gateValid, false);
		// Each flag must be exactly the boolean false: true, missing, and wrong types all fail.
		for (const [flag, value] of [
			["attemptElapsedMissing", true], ["attemptElapsedMissing", undefined], ["attemptElapsedMissing", "no"],
			["attemptElapsedConflicting", true], ["attemptElapsedConflicting", undefined], ["attemptElapsedConflicting", 0],
			["attemptElapsedMalformed", true], ["attemptElapsedMalformed", undefined], ["attemptElapsedMalformed", null],
		]) {
			metrics = computeGateMetrics([run({ [flag]: value })]);
			assert.equal(metrics.untrustedRuns, 1, `${flag}=${JSON.stringify(value)}`);
			assert.deepEqual(metrics.untrustedByReason, { latency_flags: 1 }, `${flag}=${JSON.stringify(value)}`);
			assert.equal(metrics.gateValid, false, `${flag}=${JSON.stringify(value)}`);
		}
	});

	test("direct runs need raw elapsedMs present, well-formed, and equal to the represented measurement", () => {
		const run = (elapsedMs, overrides = {}) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
			...overrides,
		});
		// Missing or malformed raw elapsedMs on the record itself.
		let metrics = computeGateMetrics([run(undefined)]);
		assert.deepEqual(metrics.untrustedByReason, { elapsedMs: 1 });
		metrics = computeGateMetrics([run("3000")]);
		assert.deepEqual(metrics.untrustedByReason, { elapsedMs: 1 });
		metrics = computeGateMetrics([run(-3000)]);
		assert.deepEqual(metrics.untrustedByReason, { elapsedMs: 1 });
		// Divergent represented measurement (attemptElapsedMs != authoritative elapsedMs).
		metrics = computeGateMetrics([run(3000, { attemptElapsedMs: 4000 })]);
		assert.deepEqual(metrics.untrustedByReason, { elapsed_measurement: 1 });
		assert.equal(metrics.gateValid, false);
	});

	test("direct runs need legitimate current-v2 tally identity fields", () => {
		const run = (overrides = {}) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 3000,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
			...overrides,
		});
		for (const [name, overrides] of [
			["missing schemaVersion", { schemaVersion: undefined }],
			["future schemaVersion", { schemaVersion: 3 }],
			["string schemaVersion", { schemaVersion: "2" }],
			["missing attemptId", { attemptId: undefined }],
			["empty attemptId", { attemptId: "" }],
			["nonstring attemptId", { attemptId: 42 }],
		]) {
			const metrics = computeGateMetrics([run(overrides)]);
			const reason = Object.keys(metrics.untrustedByReason)[0];
			assert.ok(reason === "schemaVersion" || reason === "attemptId", `${name}: ${reason}`);
			assert.equal(metrics.untrustedRuns, 1, name);
			assert.equal(metrics.succeeded, 0, name);
			assert.equal(metrics.gateValid, false, name);
		}
		// Bare outcomes get the same identity + raw latency requirements.
		const bareFailed = {
			outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "a",
			inputBytes: 512, elapsedMs: 8000,
			attemptEventCount: 1, attemptElapsedMs: 8000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
		};
		assert.equal(computeGateMetrics([bareFailed]).gateValid, true);
		assert.equal(computeGateMetrics([{ ...bareFailed, elapsedMs: undefined }]).untrustedByReason.elapsedMs, 1);
		assert.equal(computeGateMetrics([{ ...bareFailed, schemaVersion: undefined }]).untrustedByReason.schemaVersion, 1);
	});

	test("direct attemptEventCount must be positive and match the valid state-machine shape", () => {
		const base = (outcome) => ({
			outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 3000,
			attemptEventCount: 1, attemptElapsedMs: 3000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
		});
		// Ordinary terminal records are exactly one event; published decoration is two.
		assert.equal(computeGateMetrics([base("merged")]).untrustedRuns, 0);
		assert.equal(computeGateMetrics([{ ...base("published"), attemptEventCount: 2 }]).untrustedRuns, 0);
		for (const [name, outcome, count] of [
			["missing", "merged", undefined],
			["zero", "merged", 0],
			["negative", "merged", -1],
			["fractional", "merged", 1.5],
			["nonnumeric", "merged", "1"],
			["two on an ordinary terminal", "merged", 2],
			["one on a published decoration", "published", 1],
			["three on a published decoration", "published", 3],
		]) {
			const metrics = computeGateMetrics([{ ...base(outcome), attemptEventCount: count }]);
			assert.deepEqual(metrics.untrustedByReason, { attempt_event_count: 1 }, name);
			assert.equal(metrics.gateValid, false, name);
		}
	});

	test("valid direct representatives exist for every outcome under the full contract", () => {
		const run = (outcome, eventCount, extra = {}) => ({
			outcome, schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 400, elapsedMs: 1500,
			attemptEventCount: eventCount, attemptElapsedMs: 1500,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
			...extra,
		});
		const countsBearing = { counts: REJECTED_COUNTS(2), provenanceRejectionReasons: { sourceQuoteAbsent: 2, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 } };
		const metrics = computeGateMetrics([
			run("merged", 1, { counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS }),
			run("published", 2, { counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS }),
			run("empty", 1, { counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS }),
			run("rejected", 1, countsBearing),
			run("rejected", 1),
			run("failed", 1),
			run("timeout", 1),
			run("aborted", 1),
		]);
		assert.equal(metrics.total, 8);
		assert.equal(metrics.untrustedRuns, 0);
		assert.equal(metrics.succeeded, 3); // merged + published + empty only
		assert.equal(metrics.latencyMeasured, 8);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.gateValid, true);
	});

	test("fabricated publication decorations on non-published outcomes fail closed", () => {
		const mergedWithComments = tallyRuns([{
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 3000, counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
			inlineComments: 2,
		}]);
		assert.equal(mergedWithComments.runs.length, 0);
		assert.equal(mergedWithComments.invalid[0].invalidReason, "forbidden_field_inlineComments");
		const emptyWithStatus = tallyRuns([{
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "a",
			inputBytes: 300, elapsedMs: 1200, counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS,
			publishStatus: "failed",
		}]);
		assert.equal(emptyWithStatus.invalid[0].invalidReason, "forbidden_field_publishStatus");
		const rejectedCountsBearingWithComments = tallyRuns([{
			outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(3), source: "a",
			inputBytes: 400, elapsedMs: 1500, counts: REJECTED_COUNTS(2),
			provenanceRejectionReasons: { sourceQuoteAbsent: 2, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			inlineComments: 1,
		}]);
		assert.equal(rejectedCountsBearingWithComments.invalid[0].invalidReason, "forbidden_field_inlineComments");
	});

	test("bare rejected rejects every fabricated field the producer never emits", () => {
		// Counts keys belong to the union's other variant: a bare rejected record
		// carrying only one of them fails as one-sided (covered below), so here we
		// assert the truly forbidden arbitrary/publication/internal fields.
		for (const [field, value] of [
			["inlineComments", 3],
			["publishStatus", "failed"],
			["reason", "no_lane_evidence"],
			["payload", { hostile: true }],
			["attemptEventCount", 1],
		]) {
			const { runs, invalid } = tallyRuns([BARE_REJECTED({ [field]: value })]);
			assert.equal(runs.length, 0, field);
			assert.equal(invalid[0].invalidReason, `forbidden_field_${field}`, field);
		}
	});

	test("published validates arbitrary payload keys and real decoration value domains", () => {
		const merged = { outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 900, elapsedMs: 3000, counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS };
		const publishedBase = { outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", inputBytes: 900, elapsedMs: 3000, counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS };
		// Valid real decoration domains pass.
		let result = tallyRuns([merged, { ...publishedBase, inlineComments: 2, publishStatus: "skipped_duplicate" }]);
		assert.equal(result.invalid.length, 0);
		assert.equal(result.runs.length, 1);
		result = tallyRuns([merged, { ...publishedBase, publishStatus: "indeterminate" }]);
		assert.equal(result.invalid.length, 0);
		// Arbitrary payload on the published event fails closed.
		result = tallyRuns([merged, { ...publishedBase, payload: { hostile: true } }]);
		assert.equal(result.invalid[0].invalidReason, "forbidden_field_payload");
		// The not_run-only reason key is forbidden everywhere else.
		result = tallyRuns([merged, { ...publishedBase, reason: "empty_input" }]);
		assert.equal(result.invalid[0].invalidReason, "forbidden_field_reason");
		// Decoration domains mirror actual publisher output:
		// the inline comment count is emitted only when > 0.
		for (const bad of [0, -1, 1.5, "three"]) {
			result = tallyRuns([merged, { ...publishedBase, inlineComments: bad }]);
			assert.equal(result.runs.length, 0, JSON.stringify(bad));
			assert.equal(result.invalid[0].invalidReason, "terminal_malformed_inlineComments", JSON.stringify(bad));
		}
		// publishStatus is emitted only for non-posted outcomes.
		for (const bad of ["posted", "posted_degraded", "", "draft", 42]) {
			result = tallyRuns([merged, { ...publishedBase, publishStatus: bad }]);
			assert.equal(result.runs.length, 0, JSON.stringify(bad));
			assert.equal(result.invalid[0].invalidReason, "terminal_malformed_publishStatus", JSON.stringify(bad));
		}
	});

	test("valid merged-only runtime records remain fully eligible", () => {
		// Publishing is default-off, so real v2 cohorts are mostly merged-only.
		// A complete merged-only record satisfies the exact runtime contract and
		// is a full citizen of every gate metric.
		const entries = Array.from({ length: 15 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`,
			counts: { ...MIRROR_COUNTS, findingsRejectedProvenance: 1, provenanceChecked: 2 },
			provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			inputBytes: 12_345, elapsedMs: 3000 + index, effectiveModel: "provider/light",
		}));
		const { runs, invalid } = tallyRuns(entries);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 15);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 15);
		assert.equal(metrics.succeeded, 15);
		assert.equal(metrics.successRate, 1);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.provenanceCheckedExact, true);
		assert.equal(metrics.provenanceReasonsPartitioned, true);
		assert.equal(metrics.provenanceChecked, 30);
		assert.equal(metrics.provenanceRejectionRate, 0.5);
		assert.equal(metrics.p50ElapsedMs, 3007);
		assert.equal(metrics.gateValid, true);
	});

	test("the gate requires 15 eligible current-cohort attempts", () => {
		const mergedRun = (index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index), source: `run-${index}`,
			counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 3000,
		});
		const fourteen = Array.from({ length: 14 }, (_, index) => mergedRun(index + 1));
		const { runs } = tallyRuns([
			...fourteen,
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(90), source: "excluded-1" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.sufficientSample, false);
		const fifteen = tallyRuns([...fourteen, mergedRun(15)]);
		assert.equal(computeGateMetrics(fifteen.runs).sufficientSample, true);
	});

	test("the scoreboard prints checked candidates, excluded counts, and cohort framing", () => {
		const { runs, excluded } = tallyRuns([
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 300, elapsedMs: 1200 },
			{ outcome: "not_run", reason: "empty_input", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
		]);
		const text = formatScoreboard(runs, computeGateMetrics(runs, excluded));
		assert.match(text, /schemaVersion 2 with attempt IDs/);
		assert.match(text, /Excluded not-run decisions\s+: 1\s+\(empty_input: 1\)/);
		assert.match(text, /never count toward sample volume|Insufficient sample: 1\/15/);
		assert.match(text, /extractor success rate/);
		assert.match(text, /checked candidates\s+: 0/);
	});

	test("the scoreboard warns when computeGateMetrics directly receives schema-violating runs", () => {
		// Admission-time schemas keep contradictory records out of tallyRuns
		// output entirely; at the direct boundary such runs are visibly reported
		// as untrusted and cannot support success or provenance aggregates.
		const runs = [{
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
			inputBytes: 900, elapsedMs: 1000,
			counts: { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 2, findingsDroppedOverflow: 0, provenanceChecked: 99 },
			provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			attemptEventCount: 1, attemptElapsedMs: 1000,
			attemptElapsedMissing: false, attemptElapsedConflicting: false, attemptElapsedMalformed: false,
		}];
		const metrics = computeGateMetrics(runs);
		const text = formatScoreboard(runs, metrics);
		assert.match(text, /WARNING: 1 run\(s\) violate their outcome-specific runtime schema at the direct-metrics boundary \(provenanceCheckedPartition: 1\)/);
		assert.match(text, /they cannot support execution success or provenance aggregates and keep the gate invalid\./);
		assert.equal(metrics.untrustedRuns, 1);
		assert.equal(metrics.succeeded, 0);
		assert.equal(metrics.gateValid, false);
	});

	test("legacy runs print as context only and never enter current metrics", () => {
		const legacyText = formatLegacySummary([
			{ outcome: "empty", source: "old-a" },
			{ outcome: "merged", source: "old-b" },
		]);
		assert.match(legacyText, /Legacy cohort/);
		assert.match(legacyText, /context only/);
		assert.match(legacyText, /Runs: 2/);
		const { current, legacy } = partitionCohorts([
			{ outcome: "merged", source: "old" },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "new" },
		]);
		assert.equal(current.length, 1);
		assert.equal(legacy.length, 1);
	});

	test("ambiguous v2 events without attemptId print as context only, never gate metrics", () => {
		const ambiguousText = formatAmbiguousSummary([
			{ outcome: "merged", schemaVersion: 2, source: "old-a" },
			{ outcome: "failed", schemaVersion: 2, source: "old-a" },
		]);
		assert.match(ambiguousText, /Ambiguous v2 cohort/);
		assert.match(ambiguousText, /context only/);
		assert.match(ambiguousText, /never claimed/);
		// Deterministic terminal-wins-per-source context summary.
		assert.match(ambiguousText, /Runs: 1/);
		const { current, ambiguous } = partitionCohorts([
			{ outcome: "merged", schemaVersion: 2, source: "ambiguous" },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "new" },
		]);
		assert.equal(current.length, 1);
		assert.equal(ambiguous.length, 1);
		// Even if ambiguous events are (incorrectly) handed to tallyRuns, they
		// produce no runs: exact metrics are never claimed from them.
		assert.equal(tallyRuns(ambiguous).runs.length, 0);
	});

	describe("real session-log scan", () => {
		const dir = tempSessionDir();
		after(() => fs.rmSync(dir, { recursive: true, force: true }));

		test("collects v2 and legacy entries from jsonl session files", () => {
			writeSession(dir, "--private-tmp-eval--", "s1.jsonl", [
				{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(1) },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), counts: { findingsExtracted: 2, findingsMerged: 2, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 2 }, provenanceRejectionReasons: EMPTY_REASONS, elapsedMs: 4000, inputBytes: 2000 },
			]);
			writeSession(dir, "--private-tmp-eval--", "s2.jsonl", [
				{ outcome: "empty" },
			]);
			const { entries, filesScanned } = collectExtractionEntries(dir);
			assert.equal(filesScanned, 2);
			assert.equal(entries.length, 3);
			const { current, ambiguous, legacy } = partitionCohorts(entries);
			assert.equal(current.length, 2);
			assert.equal(ambiguous.length, 0);
			assert.equal(legacy.length, 1);
			const { runs, excluded } = tallyRuns(current);
			const metrics = computeGateMetrics(runs, excluded);
			assert.equal(metrics.total, 1);
			assert.equal(metrics.succeeded, 1);
			assert.equal(metrics.excludedCount, 1);
			// Non-extraction custom lines and malformed lines are ignored.
			fs.writeFileSync(path.join(dir, "--private-tmp-eval--", "s3.jsonl"), [
				JSON.stringify({ type: "custom", customType: "pr-review-completed", data: {} }),
				"{ malformed",
				"",
			].join("\n"), "utf8");
			assert.equal(collectExtractionEntries(dir).entries.length, 3);
		});

		test("two attempts in one jsonl session stay separate gate runs in both orders", () => {
			// success → failure in one file
			writeSession(dir, "--private-tmp-eval--", "sf.jsonl", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 3000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 3000 },
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), inputBytes: 800, elapsedMs: 8000 },
			]);
			// failure → success in another file
			writeSession(dir, "--private-tmp-eval--", "fs.jsonl", [
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(3), inputBytes: 850, elapsedMs: 9000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(4), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(4), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 900, elapsedMs: 4000 },
			]);
			const { entries } = collectExtractionEntries(dir);
			const { current } = partitionCohorts(entries.filter((entry) =>
				entry.source.endsWith("sf.jsonl") || entry.source.endsWith("fs.jsonl")));
			const { runs, excluded } = tallyRuns(current);
			assert.equal(runs.length, 4);
			assert.equal(excluded.length, 0);
			const metrics = computeGateMetrics(runs);
			assert.equal(metrics.total, 4);
			assert.equal(metrics.succeeded, 2);
			assert.equal(metrics.successRate, 0.5);
			const outcomes = runs.map((run) => run.outcome).sort();
			assert.deepEqual(outcomes, ["failed", "failed", "published", "published"]);
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "sf.jsonl"));
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "fs.jsonl"));
		});

		test("a published event associates with its own merged attempt across the jsonl boundary", () => {
			writeSession(dir, "--private-tmp-eval--", "assoc.jsonl", [
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 2, findingsMerged: 2, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 2 }, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 950, elapsedMs: 3000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 800, elapsedMs: 3500 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), counts: MIRROR_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 800, elapsedMs: 3500 },
			]);
			const { entries } = collectExtractionEntries(dir);
			const { current } = partitionCohorts(entries.filter((entry) => entry.source.endsWith("assoc.jsonl")));
			const { runs, invalid } = tallyRuns(current);
			assert.equal(invalid.length, 0);
			assert.equal(runs.length, 2);
			const published = runs.find((run) => run.outcome === "published");
			assert.equal(published.attemptId, ATTEMPT(2));
			const mergedOnly = runs.find((run) => run.outcome === "merged");
			assert.equal(mergedOnly.attemptId, ATTEMPT(1));
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "assoc.jsonl"));
		});

		test("invalid attempt sequences in a real jsonl log fail closed and block gate validity", () => {
			writeSession(dir, "--private-tmp-eval--", "invalid.jsonl", [
				// Orphan published: no preceding same-attempt merged.
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 3000 },
				// Success then failure inside one attempt identity.
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 4000 },
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), elapsedMs: 9000 },
				// A healthy third attempt for contrast.
				{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(3), counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 700, elapsedMs: 2000 },
			]);
			const { entries } = collectExtractionEntries(dir);
			const { current } = partitionCohorts(entries.filter((entry) => entry.source.endsWith("invalid.jsonl")));
			const { runs, invalid } = tallyRuns(current);
			assert.equal(runs.length, 1);
			assert.equal(runs[0].outcome, "empty");
			assert.equal(invalid.length, 2);
			assert.deepEqual(invalid.map((entry) => entry.invalidReason).sort(), ["conflicting_terminal_sequence", "orphan_published"]);
			const metrics = computeGateMetrics(runs, [], invalid);
			// Invalid attempts count against success and sample; the gate stays invalid.
			assert.equal(metrics.total, 3);
			assert.equal(metrics.succeeded, 1);
			assert.equal(metrics.successRate, 1 / 3);
			assert.equal(metrics.gateValid, false);
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "invalid.jsonl"));
		});

		test("collector source/timestamp stay accepted; future-version junk stays context-only", () => {
			writeSession(dir, "--private-tmp-eval--", "meta.jsonl", [
				// A future schema version with arbitrary junk fields is legacy context.
				{ outcome: "empty", schemaVersion: 99, attemptId: ATTEMPT(9), arbitraryPayload: { x: 1 } },
				{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(10), counts: ZERO_COUNTS, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 300, elapsedMs: 1200 },
			]);
			const { entries } = collectExtractionEntries(dir);
			const scoped = entries.filter((entry) => entry.source.endsWith("meta.jsonl"));
			const { current, legacy } = partitionCohorts(scoped);
			assert.equal(current.length, 1);
			assert.equal(legacy.length, 1);
			// Collector-added source/timestamp are metadata, never forbidden payload.
			assert.ok(scoped.every((entry) => typeof entry.source === "string" && typeof entry.timestamp === "string"));
			const { runs, invalid } = tallyRuns(current);
			assert.equal(invalid.length, 0);
			assert.equal(runs.length, 1);
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "meta.jsonl"));
		});
	});
});
