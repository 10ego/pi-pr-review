import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import {
	collectExtractionEntries,
	computeGateMetrics,
	formatLegacySummary,
	formatScoreboard,
	partitionCohorts,
	tallyRuns,
} from "./extraction-tally.mjs";

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
	test("partitionCohorts splits schemaVersion 2 from legacy and unknown versions", () => {
		const { current, legacy } = partitionCohorts([
			{ outcome: "merged", schemaVersion: 2 },
			{ outcome: "merged" },
			{ outcome: "empty" },
			{ outcome: "merged", schemaVersion: 3 },
		]);
		assert.equal(current.length, 1);
		assert.equal(legacy.length, 3);
	});

	test("not_run entries are excluded events, never runs or attempts", () => {
		const { runs, excluded } = tallyRuns([
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, source: "a" },
			{ outcome: "not_run", reason: "empty_input", schemaVersion: 2, source: "b" },
			{ outcome: "merged", schemaVersion: 2, source: "c" },
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
			{ outcome: "merged", schemaVersion: 2, source: "a" },
			{ outcome: "empty", schemaVersion: 2, source: "b", counts: { findingsExtracted: 0, findingsRejectedProvenance: 0 } },
			{ outcome: "failed", schemaVersion: 2, source: "c" },
			{ outcome: "timeout", schemaVersion: 2, source: "d" },
			{ outcome: "rejected", schemaVersion: 2, source: "e" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.total, 5);
		assert.equal(metrics.succeeded, 2);
		assert.equal(metrics.successRate, 0.4);
	});

	test("published terminal entries complete a run and merge earlier outcomes", () => {
		const { runs } = tallyRuns([
			{ outcome: "merged", schemaVersion: 2, source: "a", counts: { findingsMerged: 1 }, elapsedMs: 1000 },
			{ outcome: "published", schemaVersion: 2, source: "a", counts: { findingsMerged: 1 }, elapsedMs: 1000 },
			{ outcome: "empty", schemaVersion: 2, source: "b" },
		]);
		assert.equal(runs.length, 2);
		assert.equal(runs[0].outcome, "published");
	});

	test("provenance rates and reasons come only from eligible current attempts", () => {
		const { runs } = tallyRuns([
			{
				outcome: "merged", schemaVersion: 2, source: "a", elapsedMs: 5000,
				counts: { findingsExtracted: 6, findingsRejectedProvenance: 2 },
				provenanceRejectionReasons: { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 },
			},
			{ outcome: "empty", schemaVersion: 2, source: "b", counts: { findingsExtracted: 0, findingsRejectedProvenance: 0 } },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.findingsExtracted, 6);
		assert.equal(metrics.provenanceRejectionRate, 2 / 6);
		assert.deepEqual(metrics.provenanceReasons, { sourceQuoteAbsent: 1, locationQuoteAbsent: 1, locationQuotePathMismatch: 0 });
		assert.equal(metrics.p50ElapsedMs, 5000);
	});

	test("the gate requires 15 eligible current-cohort attempts", () => {
		const fourteen = Array.from({ length: 14 }, (_, index) => ({
			outcome: "merged", schemaVersion: 2, source: `run-${index}`,
		}));
		const { runs } = tallyRuns([
			...fourteen,
			{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2, source: "excluded-1" },
		]);
		const metrics = computeGateMetrics(runs);
		assert.equal(metrics.sufficientSample, false);
		const fifteen = [...fourteen, { outcome: "merged", schemaVersion: 2, source: "run-15" }];
		assert.equal(computeGateMetrics(fifteen).sufficientSample, true);
	});

	test("the scoreboard prints excluded not-run counts and cohort framing", () => {
		const { runs, excluded } = tallyRuns([
			{ outcome: "empty", schemaVersion: 2, source: "a" },
			{ outcome: "not_run", reason: "empty_input", schemaVersion: 2, source: "b" },
		]);
		const text = formatScoreboard(runs, computeGateMetrics(runs, excluded));
		assert.match(text, /current cohort, schemaVersion 2/);
		assert.match(text, /Excluded not-run decisions\s+: 1\s+\(empty_input: 1\)/);
		assert.match(text, /never count toward sample volume|Insufficient sample: 1\/15/);
		assert.match(text, /extractor success rate/);
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
			{ outcome: "merged", schemaVersion: 2, source: "new" },
		]);
		assert.equal(current.length, 1);
		assert.equal(legacy.length, 1);
	});

	describe("real session-log scan", () => {
		const dir = tempSessionDir();
		after(() => fs.rmSync(dir, { recursive: true, force: true }));

		test("collects v2 and legacy entries from jsonl session files", () => {
			writeSession(dir, "--private-tmp-eval--", "s1.jsonl", [
				{ outcome: "not_run", reason: "no_lane_evidence", schemaVersion: 2 },
				{ outcome: "merged", schemaVersion: 2, counts: { findingsExtracted: 2, findingsMerged: 2 }, elapsedMs: 4000, inputBytes: 2000 },
			]);
			writeSession(dir, "--private-tmp-eval--", "s2.jsonl", [
				{ outcome: "empty" },
			]);
			const { entries, filesScanned } = collectExtractionEntries(dir);
			assert.equal(filesScanned, 2);
			assert.equal(entries.length, 3);
			const { current, legacy } = partitionCohorts(entries);
			assert.equal(current.length, 2);
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
	});
});
