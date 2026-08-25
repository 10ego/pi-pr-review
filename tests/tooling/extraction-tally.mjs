#!/usr/bin/env node
/**
 * Development-only §9 extraction gate tally.
 *
 * Scans Pi session logs for `pr-review-extraction` entries and prints the
 * live Phase 2 scoreboard. NOT shipped to end users: this file lives under
 * tests/tooling/ (excluded from the npm package) and is invoked by
 * maintainers during development, never registered as a Pi command.
 *
 * Cohort semantics: only entries carrying `schemaVersion: 2` use the current
 * extraction semantics (host-authoritative eligibility, valid `empty` counted
 * as extraction success, `not_run` excluded from every denominator, per-reason
 * provenance counts). Entries without the field are legacy and are printed
 * separately for context only — never combined with current-cohort metrics.
 * The 18-run 1.15.7 campaign proved the legacy denominator mixes incompatible
 * outcome semantics, so the default-on decision must evaluate exactly one
 * homogeneous current cohort with >= 15 eligible real attempts.
 *
 * Usage: node tests/tooling/extraction-tally.mjs [sessionDir]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sessionDir = process.argv[2] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
const GATE = { successRate: 0.95, provenanceRejectionRate: 0.05, overheadP50Ms: 20_000, minimumAttempts: 15 };
const CURRENT_SCHEMA_VERSION = 2;
/** Outcomes that mean the extractor child executed successfully on an eligible attempt. */
const SUCCESS_OUTCOMES = new Set(["merged", "published", "empty"]);

/** Collect pr-review-extraction entries across every session log. */
export function collectExtractionEntries(dir = sessionDir) {
	const entries = [];
	let filesScanned = 0;
	if (!fs.existsSync(dir)) return { entries, filesScanned };
	for (const project of fs.readdirSync(dir)) {
		const projectDir = path.join(dir, project);
		if (!fs.statSync(projectDir).isDirectory()) continue;
		for (const file of fs.readdirSync(projectDir)) {
			if (!file.endsWith(".jsonl")) continue;
			filesScanned++;
			const filePath = path.join(projectDir, file);
			let text;
			try {
				text = fs.readFileSync(filePath, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line.includes('"pr-review-extraction"')) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed?.type === "custom" && parsed?.customType === "pr-review-extraction") {
						entries.push({ ...parsed.data, timestamp: parsed.timestamp, source: filePath });
					}
				} catch {
					/* skip malformed lines */
				}
			}
		}
	}
	return { entries, filesScanned };
}

/**
 * Split entries into the current telemetry cohort and the legacy cohort.
 * An entry belongs to the current cohort exactly when it carries the current
 * schemaVersion; anything else (including unknown future versions) stays out
 * so the default-on decision never mixes semantics.
 */
export function partitionCohorts(entries, currentVersion = CURRENT_SCHEMA_VERSION) {
	const current = [];
	const legacy = [];
	for (const entry of entries) {
		if (entry.schemaVersion === currentVersion) current.push(entry);
		else legacy.push(entry);
	}
	return { current, legacy };
}

/**
 * Merge current-cohort entries into one run each: the terminal outcome wins
 * over intermediate ones. `not_run` decisions are excluded events, not runs:
 * they are returned separately and never enter any attempt denominator.
 */
export function tallyRuns(entries) {
	const byRun = new Map();
	const excluded = [];
	for (const entry of entries) {
		if (entry.outcome === "not_run") {
			excluded.push(entry);
			continue;
		}
		const mergedRuns = byRun.get(entry.source) ?? [];
		mergedRuns.push(entry);
		byRun.set(entry.source, mergedRuns);
	}
	const runs = [];
	for (const runEntries of byRun.values()) {
		const terminal = runEntries.findLast((entry) => entry.outcome === "published")
			?? runEntries.findLast((entry) => entry.outcome === "merged")
			?? runEntries.findLast((entry) => entry.outcome !== "not_run")
			?? runEntries.at(-1);
		runs.push(terminal);
	}
	return { runs, excluded };
}

/**
 * Compute the §9 gate metrics from terminal per-run outcomes over one cohort.
 * `empty` counts as extractor execution success: on the current cohort it can
 * only mean a schema-valid {"findings":[]} answer for eligible lane evidence.
 */
export function computeGateMetrics(runs, excluded = []) {
	const total = runs.length;
	const succeeded = runs.filter((run) => SUCCESS_OUTCOMES.has(run.outcome)).length;
	const provenanceRejected = runs.reduce((total, run) => total + (run.counts?.findingsRejectedProvenance ?? 0), 0);
	const extractedTotal = runs.reduce((total, run) => total + (run.counts?.findingsExtracted ?? 0), 0);
	const mergedTotal = runs.reduce((total, run) => total + (run.counts?.findingsMerged ?? 0), 0);
	const elapsed = runs.map((run) => run.elapsedMs ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
	const p50 = elapsed.length > 0 ? elapsed[Math.floor((elapsed.length - 1) / 2)] : 0;
	const provenanceReasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
	for (const run of runs) {
		const reasons = run.provenanceRejectionReasons;
		if (!reasons) continue;
		provenanceReasons.sourceQuoteAbsent += reasons.sourceQuoteAbsent ?? 0;
		provenanceReasons.locationQuoteAbsent += reasons.locationQuoteAbsent ?? 0;
		provenanceReasons.locationQuotePathMismatch += reasons.locationQuotePathMismatch ?? 0;
	}
	const excludedByReason = {};
	for (const entry of excluded) excludedByReason[entry.reason ?? "unknown"] = (excludedByReason[entry.reason ?? "unknown"] ?? 0) + 1;
	return {
		total,
		succeeded,
		successRate: total > 0 ? succeeded / total : 0,
		provenanceRejectionRate: extractedTotal > 0 ? provenanceRejected / extractedTotal : 0,
		findingsExtracted: extractedTotal,
		findingsMerged: mergedTotal,
		p50ElapsedMs: p50,
		provenanceReasons,
		excludedCount: excluded.length,
		excludedByReason,
		sufficientSample: total >= GATE.minimumAttempts,
	};
}

export function formatScoreboard(runs, metrics) {
	const pct = (value) => `${(value * 100).toFixed(0)}%`;
	const lines = [
		"Extraction §9 gate scoreboard (current cohort, schemaVersion 2)",
		"===============================================================",
		`Eligible attempts (terminal)   : ${metrics.total}  (gate needs >= ${GATE.minimumAttempts})`,
		`  extractor success            : ${metrics.succeeded}  (merged/published/correct-empty)`,
		`  extractor success rate       : ${pct(metrics.successRate)}  (gate >= ${pct(GATE.successRate)})`,
		`Excluded not-run decisions     : ${metrics.excludedCount}${Object.keys(metrics.excludedByReason).length ? `  (${Object.entries(metrics.excludedByReason).map(([r, c]) => `${r}: ${c}`).join(", ")})` : ""}`,
		`Provenance rejection rate      : ${pct(metrics.provenanceRejectionRate)}  (gate < ${pct(GATE.provenanceRejectionRate)})`,
		`  rejection reasons            : sourceQuoteAbsent ${metrics.provenanceReasons.sourceQuoteAbsent}, locationQuoteAbsent ${metrics.provenanceReasons.locationQuoteAbsent}, locationQuotePathMismatch ${metrics.provenanceReasons.locationQuotePathMismatch}`,
		`Findings extracted / merged    : ${metrics.findingsExtracted} / ${metrics.findingsMerged}`,
		`Extraction elapsed p50         : ${(metrics.p50ElapsedMs / 1000).toFixed(1)}s  (gate <= ${GATE.overheadP50Ms / 1000}s)`,
		"",
	];
	if (!metrics.sufficientSample) {
		lines.push(
			`Insufficient sample: ${metrics.total}/${GATE.minimumAttempts} eligible current-cohort attempts.`,
			"Excluded not-run decisions never count toward sample volume. Keep the",
			"flag on and let eligible degraded reviews accumulate before the Phase 2",
			"default-on decision.",
			"",
		);
	}
	const byOutcome = new Map();
	for (const run of runs) byOutcome.set(run.outcome, (byOutcome.get(run.outcome) ?? 0) + 1);
	lines.push("Outcomes (eligible attempts):", ...[...byOutcome.entries()].sort().map(([outcome, count]) => `  ${outcome.padEnd(10)} ${count}`));
	return lines.join("\n");
}

/** Context-only summary of the legacy cohort; never part of the gate decision. */
export function formatLegacySummary(entries) {
	const byRun = new Map();
	for (const entry of entries) {
		const mergedRuns = byRun.get(entry.source) ?? [];
		mergedRuns.push(entry);
		byRun.set(entry.source, mergedRuns);
	}
	const terminal = [...byRun.values()].map((runEntries) =>
		runEntries.findLast((entry) => entry.outcome === "published")
		?? runEntries.findLast((entry) => entry.outcome === "merged")
		?? runEntries.at(-1));
	const outcomes = new Map();
	for (const run of terminal) outcomes.set(run.outcome, (outcomes.get(run.outcome) ?? 0) + 1);
	const lines = [
		"Legacy cohort (pre-schemaVersion-2 mixed semantics; context only)",
		"================================================================",
		`Runs: ${terminal.length}  outcomes: ${[...outcomes.entries()].sort().map(([o, c]) => `${o} ${c}`).join(", ") || "none"}`,
		"These runs mixed absent-synthesis, skip-notice, and correct-empty",
		"outcomes in one denominator. They are permanently excluded from the",
		"default-on decision; no backfilling or rewriting of session logs.",
	];
	return lines.join("\n");
}

// CLI entry point (development use only).
if (import.meta.url === `file://${process.argv[1]}`) {
	const { entries, filesScanned } = collectExtractionEntries();
	const { current, legacy } = partitionCohorts(entries);
	const { runs, excluded } = tallyRuns(current);
	const metrics = computeGateMetrics(runs, excluded);
	console.log(`Scanned ${filesScanned} session logs in ${sessionDir}`);
	console.log(formatScoreboard(runs, metrics));
	console.log();
	console.log(formatLegacySummary(legacy));
}
