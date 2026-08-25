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
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c" },
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
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a" },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: { findingsExtracted: 0, findingsRejectedProvenance: 0 } },
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c" },
			{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(4), source: "d" },
			{ outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(5), source: "e" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 5);
		assert.equal(metrics.succeeded, 2);
		assert.equal(metrics.successRate, 0.4);
	});

	test("published terminal entries complete their own run and merge earlier outcomes", () => {
		const counts = { ...MIRROR_COUNTS };
		const reasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 1000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts, provenanceRejectionReasons: reasons, inputBytes: 900, elapsedMs: 1000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
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
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", elapsedMs: 9000 },
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
			{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", elapsedMs: 9000 },
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
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", elapsedMs: 8000 },
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
			{ outcome: "merged", schemaVersion: 2, attemptId: "g7-aaaa", source: "s1.jsonl" },
			{ outcome: "failed", schemaVersion: 2, attemptId: "g7-bbbb", source: "s1.jsonl" },
		]);
		assert.equal(runs.length, 2);
		// Same attempt identity in two different sources: two runs (coalescing is
		// keyed on source + attemptId, never attemptId alone).
		const { runs: acrossSources } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: "g7-aaaa", source: "s1.jsonl" },
			{ outcome: "failed", schemaVersion: 2, attemptId: "g7-aaaa", source: "s2.jsonl" },
		]);
		assert.equal(acrossSources.length, 2);
	});

	test("provenance rates use every provenance-checked candidate, not accepted findings only", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 5000,
				counts: { findingsExtracted: 6, findingsRejectedProvenance: 2, provenanceChecked: 8 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			},
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", counts: { findingsExtracted: 0, findingsRejectedProvenance: 0, provenanceChecked: 0 } },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.findingsExtracted, 6);
		// The true denominator is accepted + rejected candidates (6 + 2), never
		// the accepted-only findingsExtracted (the old 2/6 understated the rate).
		assert.equal(metrics.provenanceChecked, 8);
		assert.equal(metrics.provenanceRejectionRate, 2 / 8);
		assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 });
		assert.equal(metrics.provenanceReasonsPartitioned, true);
		assert.equal(metrics.p50ElapsedMs, 5000);
	});

	test("a missing provenanceChecked count falls back to the derived accepted+rejected denominator", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
				counts: { findingsExtracted: 6, findingsRejectedProvenance: 2 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 2, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			},
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.provenanceChecked, 8);
		assert.equal(metrics.provenanceRejectionRate, 2 / 8);
	});

	test("19 empty successes plus one all-rejected failure fails the provenance gate", () => {
		const entries = [
			...Array.from({ length: 19 }, (_, index) => ({
				outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: "s1.jsonl",
				counts: { findingsExtracted: 0, findingsRejectedProvenance: 0, provenanceChecked: 0 },
			})),
			{
				outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(20), source: "s1.jsonl",
				counts: { findingsExtracted: 0, findingsRejectedProvenance: 6, provenanceChecked: 6 },
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

	test("malformed negative or non-integer telemetry fails safely", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
				counts: { findingsExtracted: 4, findingsRejectedProvenance: 2, provenanceChecked: -3 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			},
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b",
				counts: { findingsExtracted: 1.5, findingsRejectedProvenance: 1, provenanceChecked: 2.5 },
			},
		]);
		const metrics = computeGateMetrics(runs);
		assert.ok(Number.isFinite(metrics.provenanceRejectionRate));
		assert.ok(Number.isFinite(metrics.provenanceChecked));
		assert.equal(metrics.malformedCounts, 3);
		assert.equal(metrics.provenanceCheckedExact, false);
		// The conservative derived accepted+rejected denominator is always used.
		assert.equal(metrics.provenanceChecked, 6 + 1);
		assert.equal(metrics.provenanceRejectionRate, 3 / 7);
		// Attempt 2 has no reason counts; its rejects are flagged non-partitioned.
		assert.equal(metrics.provenanceReasonsPartitioned, false);
		assert.equal(metrics.gateValid, false);
	});

	test("per-reason counts that do not partition the aggregate are never trusted", () => {
		const { runs } = tallyRuns([
			{
				outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
				counts: { findingsExtracted: 0, findingsRejectedProvenance: 2, provenanceChecked: 2 },
				// Reasons sum to 5 but only 2 candidates were rejected: malformed.
				provenanceRejectionReasons: { sourceQuoteAbsent: 3, locationQuoteAbsent: 2, locationQuotePathMismatch: 0 },
			},
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.provenanceReasonsPartitioned, false);
		assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 });
		assert.equal(metrics.provenanceRejectionRate, 1);
	});

	test("an oversized claimed provenanceChecked denominator is never accepted", () => {
		const { runs } = tallyRuns([
			{
				// accepted 1 + rejected 1 = 2 checked, but the record claims 100: the
				// true 50% rejection rate must not dilute to 1%.
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 1000,
				counts: { findingsExtracted: 1, findingsRejectedProvenance: 1, provenanceChecked: 100 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			},
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.provenanceChecked, 2);
		assert.equal(metrics.provenanceRejectionRate, 0.5);
		assert.equal(metrics.provenanceCheckedExact, false);
		assert.equal(metrics.malformedCounts, 1);
		assert.equal(metrics.gateValid, false);
		// An undersized claim is equally malformed.
		const undersized = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b", elapsedMs: 1000,
				counts: { findingsExtracted: 1, findingsRejectedProvenance: 1, provenanceChecked: 1 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			},
		]);
		const undersizedMetrics = computeGateMetrics(undersized.runs);
		assert.equal(undersizedMetrics.provenanceChecked, 2);
		assert.equal(undersizedMetrics.provenanceCheckedExact, false);
	});

	test("valid exact provenanceChecked and partitioned reason counters keep the gate valid", () => {
		const { runs } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, elapsedMs: 3000,
			counts: { findingsExtracted: 4, findingsMerged: 4, findingsRejectedProvenance: 1, provenanceChecked: 5 },
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

	test("string, negative, fractional, and nonfinite reason counters are untrusted", () => {
		const run = (reasons) => ({
			outcome: "rejected", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 1000,
			counts: { findingsExtracted: 0, findingsRejectedProvenance: 2, provenanceChecked: 2 },
			provenanceRejectionReasons: reasons,
		});
		for (const reasons of [
			{ sourceQuoteAbsent: "1", locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: -1, locationQuoteAbsent: 3, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: 0.5, locationQuoteAbsent: 1.5, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: Infinity, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
			{ sourceQuoteAbsent: NaN, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 },
		]) {
			const metrics = computeGateMetrics([run(reasons)]);
			assert.equal(metrics.provenanceReasonsPartitioned, false, JSON.stringify(reasons));
			assert.equal(metrics.malformedCounts, 1, JSON.stringify(reasons));
			assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 });
			assert.equal(metrics.gateValid, false);
		}
	});

	test("latency completeness: 15 successful attempts without elapsedMs cannot pass the gate", () => {
		const { runs } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`,
			counts: { findingsExtracted: 0, findingsRejectedProvenance: 0, provenanceChecked: 0 },
		})));
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.succeeded, 15);
		assert.equal(metrics.successRate, 1);
		assert.equal(metrics.p50ElapsedMs, 0);
		// Missing latency marks telemetry incomplete and blocks the default-on gate.
		assert.equal(metrics.latencyComplete, false);
		assert.equal(metrics.latencyMissing, 15);
		assert.equal(metrics.latencyMeasured, 0);
		assert.equal(metrics.gateValid, false);
		const text = formatScoreboard(runs, metrics);
		assert.match(text, /latency measurements\s+: 0\/15 complete/);
		assert.match(text, /Gate telemetry validity\s+: INVALID/);
	});

	test("a legitimate zero elapsedMs counts in the p50 and keeps latency complete", () => {
		const { runs } = tallyRuns(Array.from({ length: 15 }, (_, index) => ({
			outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, elapsedMs: 0,
			counts: { findingsExtracted: 0, findingsRejectedProvenance: 0, provenanceChecked: 0 },
		})));
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.latencyComplete, true);
		assert.equal(metrics.latencyMeasured, 15);
		assert.equal(metrics.p50ElapsedMs, 0);
		assert.equal(metrics.gateValid, true);
	});

	test("negative, nonnumeric, nonfinite, and conflicting latency are gate-invalid", () => {
		const { runs: negative } = tallyRuns([
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: -5 },
		]);
		assert.equal(computeGateMetrics(negative).latencyMalformed, 1);
		assert.equal(computeGateMetrics(negative).latencyComplete, false);
		assert.equal(computeGateMetrics(negative).gateValid, false);
		const { runs: nonnumeric } = tallyRuns([
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: "fast" },
		]);
		assert.equal(computeGateMetrics(nonnumeric).latencyMalformed, 1);
		const { runs: nonfinite } = tallyRuns([
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: Infinity },
		]);
		assert.equal(computeGateMetrics(nonfinite).latencyMalformed, 1);
		const { runs: nan } = tallyRuns([
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: NaN },
		]);
		assert.equal(computeGateMetrics(nan).latencyMalformed, 1);
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

	test("mixed complete and incomplete latency keeps the gate invalid", () => {
		const { runs } = tallyRuns([
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", elapsedMs: 2000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.latencyMeasured, 1);
		assert.equal(metrics.latencyMissing, 1);
		assert.equal(metrics.p50ElapsedMs, 2000);
		assert.equal(metrics.latencyComplete, false);
		assert.equal(metrics.gateValid, false);
		// Excluded not_run decisions need no latency at all.
		const withExcluded = computeGateMetrics(runs, [
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(3), source: "c" },
		]);
		assert.equal(withExcluded.latencyMissing, 1);
	});

	test("merged metrics stay authoritative through published: malformed merged + favorable published fails", () => {
		// Fifteen attempts whose MERGED telemetry is malformed (oversized claimed
		// checked denominator) while every published mirror looks exact and
		// favorable. The gate must stay invalid on the merged side.
		const malformedCounts = { findingsExtracted: 1, findingsMerged: 1, findingsDeduped: 0, findingsRejectedProvenance: 1, findingsDroppedOverflow: 0, provenanceChecked: 100 };
		const entries = [];
		for (let index = 0; index < 15; index++) {
			entries.push({ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: malformedCounts, provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }, inputBytes: 900, elapsedMs: 3000 });
			entries.push({ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `s${index}`, counts: malformedCounts, provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 }, inputBytes: 900, elapsedMs: 3000 });
		}
		const { runs, invalid } = tallyRuns(entries);
		assert.equal(invalid.length, 0);
		assert.equal(runs.length, 15);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.sufficientSample, true);
		assert.equal(metrics.successRate, 1);
		// The merged-authoritative counts expose the malformed denominator.
		assert.equal(metrics.provenanceCheckedExact, false);
		assert.equal(metrics.malformedCounts, 15);
		assert.equal(metrics.provenanceChecked, 15 * 2);
		assert.equal(metrics.provenanceRejectionRate, 15 / 30);
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
		// Favorable published counts claiming the all-rejected merge actually merged findings.
		let result = tallyRuns([base(), published({ counts: { findingsExtracted: 6, findingsMerged: 6, findingsDeduped: 0, findingsRejectedProvenance: 0, findingsDroppedOverflow: 0, provenanceChecked: 6 } })]);
		assert.equal(result.runs.length, 0);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_counts");
		// Favorable published reason counters erasing the rejects.
		result = tallyRuns([base(), published({ provenanceRejectionReasons: EMPTY_REASONS })]);
		assert.equal(result.invalid[0].invalidReason, "published_divergent_provenanceRejectionReasons");
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

	test("the gate requires 15 eligible current-cohort attempts", () => {
		const fourteen = Array.from({ length: 14 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(index + 1), source: `run-${index}`,
		}));
		const { runs } = tallyRuns([
			...fourteen,
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, attemptId: ATTEMPT(90), source: "excluded-1" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.sufficientSample, false);
		const fifteen = [...fourteen, { outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(15), source: "run-15" }];
		assert.equal(computeGateMetrics(fifteen).sufficientSample, true);
	});

	test("the scoreboard prints checked candidates, excluded counts, and cohort framing", () => {
		const { runs, excluded } = tallyRuns([
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a" },
			{ outcome: "not_run", reason: "empty_input", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
		]);
		const text = formatScoreboard(runs, computeGateMetrics(runs, excluded));
		assert.match(text, /schemaVersion 2 with attempt IDs/);
		assert.match(text, /Excluded not-run decisions\s+: 1\s+\(empty_input: 1\)/);
		assert.match(text, /never count toward sample volume|Insufficient sample: 1\/15/);
		assert.match(text, /extractor success rate/);
		assert.match(text, /checked candidates\s+: 0/);
	});

	test("the scoreboard warns about malformed counts and non-partitioning reason breakdowns", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a",
				counts: { findingsExtracted: 1, findingsRejectedProvenance: 1, provenanceChecked: "many" },
			},
		]);
		const metrics = computeGateMetrics(runs);
		const text = formatScoreboard(runs, metrics);
		assert.match(text, /WARNING: 1 attempt\(s\) carry malformed count telemetry/);
		assert.match(text, /per-reason counts do not partition the aggregate reject count/);
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
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 4000, inputBytes: 2000 },
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
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), elapsedMs: 8000 },
			]);
			// failure → success in another file
			writeSession(dir, "--private-tmp-eval--", "fs.jsonl", [
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(3), elapsedMs: 9000 },
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
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 2, findingsMerged: 2 }, provenanceRejectionReasons: EMPTY_REASONS, inputBytes: 950, elapsedMs: 3000 },
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
				{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(3), counts: { findingsExtracted: 0, findingsRejectedProvenance: 0, provenanceChecked: 0 }, elapsedMs: 2000 },
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
	});
});
