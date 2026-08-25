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
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { findingsMerged: 1 }, elapsedMs: 1000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "a", counts: { findingsMerged: 1 }, elapsedMs: 1000 },
			{ outcome: "empty", schemaVersion: 2, attemptId: ATTEMPT(2), source: "b" },
		]);
		assert.equal(runs.length, 2);
		assert.equal(runs[0].outcome, "published");
	});

	test("an earlier success cannot mask a later failure in the same session (success → failure)", () => {
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 4000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 4000 },
			{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", elapsedMs: 9000 },
		]);
		assert.equal(runs.length, 2);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 2);
		assert.equal(metrics.succeeded, 1);
		assert.equal(metrics.successRate, 0.5);
	});

	test("an earlier failure stays a failure when a later attempt succeeds (failure → success)", () => {
		const { runs } = tallyRuns([
			{ outcome: "timeout", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", elapsedMs: 9000 },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 4000 },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 4000 },
		]);
		assert.equal(runs.length, 2);
		assert.deepEqual(runs.map((run) => run.outcome).sort(), ["published", "timeout"]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.succeeded, 1);
		assert.equal(metrics.successRate, 0.5);
	});

	test("published decorates only its own attempt, never an earlier attempt in the same session", () => {
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), source: "s1.jsonl", counts: { findingsExtracted: 2, findingsMerged: 2 } },
			{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: { findingsExtracted: 1, findingsMerged: 1 } },
			{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), source: "s1.jsonl", counts: { findingsExtracted: 1, findingsMerged: 1 } },
		]);
		assert.equal(runs.length, 2);
		// The first attempt stays merged-only; the published event completes the
		// second attempt, and both remain separate terminal runs.
		assert.deepEqual(runs.map((run) => [run.outcome, run.attemptId]).sort(), [
			["merged", ATTEMPT(1)],
			["published", ATTEMPT(2)],
		]);
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
		assert.equal(metrics.malformedCounts, 2);
		// A denominator below the reject numerator is clamped up (fail-safe):
		// attempt 1 contributes rejected 2 with a derived floor of 4 + 2 = 6.
		assert.equal(metrics.provenanceChecked, 6 + 1);
		assert.equal(metrics.provenanceRejectionRate, 3 / 7);
		// Attempt 2 has no reason counts; its rejects are flagged non-partitioned.
		assert.equal(metrics.provenanceReasonsPartitioned, false);
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
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 3000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 3000 },
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(2), elapsedMs: 8000 },
			]);
			// failure → success in another file
			writeSession(dir, "--private-tmp-eval--", "fs.jsonl", [
				{ outcome: "failed", schemaVersion: 2, attemptId: ATTEMPT(3), elapsedMs: 9000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(4), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 4000 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(4), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 4000 },
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
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(1), counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 3000 },
				{ outcome: "merged", schemaVersion: 2, attemptId: ATTEMPT(2), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 3500 },
				{ outcome: "published", schemaVersion: 2, attemptId: ATTEMPT(2), counts: { findingsExtracted: 1, findingsMerged: 1 }, elapsedMs: 3500 },
			]);
			const { entries } = collectExtractionEntries(dir);
			const { current } = partitionCohorts(entries.filter((entry) => entry.source.endsWith("assoc.jsonl")));
			const { runs } = tallyRuns(current);
			assert.equal(runs.length, 2);
			const published = runs.find((run) => run.outcome === "published");
			assert.equal(published.attemptId, ATTEMPT(2));
			const mergedOnly = runs.find((run) => run.outcome === "merged");
			assert.equal(mergedOnly.attemptId, ATTEMPT(1));
			fs.rmSync(path.join(dir, "--private-tmp-eval--", "assoc.jsonl"));
		});
	});
});
