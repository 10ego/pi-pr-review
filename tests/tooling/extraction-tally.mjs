#!/usr/bin/env node
/**
 * Development-only §9 extraction gate tally.
 *
 * Scans Pi session logs for `pr-review-extraction` entries and prints the
 * live Phase 2 scoreboard. NOT shipped to end users: this file lives under
 * tests/tooling/ (excluded from the npm package) and is invoked by
 * maintainers during development, never registered as a Pi command.
 *
 * Cohort semantics: only entries carrying `schemaVersion: 2` AND an explicit
 * `attemptId` use the current extraction semantics (host-authoritative
 * eligibility, valid `empty` counted as extraction success, `not_run` excluded
 * from every denominator, per-reason provenance counts, per-attempt event
 * coalescing keyed by source + attemptId). The attemptId is generated only from
 * host state (active lease generation + a per-attempt random nonce), never from
 * PR or model text. v2 entries without an attemptId are ambiguous — multiple
 * attempts in one session cannot be segmented — and are printed separately for
 * context only. Entries without the schemaVersion field are legacy and are
 * printed separately for context only — never combined with current-cohort
 * metrics. The 18-run 1.15.7 campaign proved the legacy denominator mixes
 * incompatible outcome semantics, so the default-on decision must evaluate
 * exactly one homogeneous current cohort with >= 15 eligible real attempts.
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
 * Split entries into the gate-deciding current cohort and context-only cohorts.
 * An entry belongs to the current cohort exactly when it carries the current
 * schemaVersion AND an explicit non-empty `attemptId`: only then can events be
 * unambiguously segmented into attempts. A v2 entry without an attemptId is
 * ambiguous (multiple attempts in one session would collapse into a favorable
 * single run) and is reported separately for context only; anything else,
 * including unknown future versions, is legacy.
 */
export function partitionCohorts(entries, currentVersion = CURRENT_SCHEMA_VERSION) {
	const current = [];
	const ambiguous = [];
	const legacy = [];
	for (const entry of entries) {
		if (entry.schemaVersion !== currentVersion) {
			legacy.push(entry);
			continue;
		}
		if (typeof entry.attemptId === "string" && entry.attemptId) current.push(entry);
		else ambiguous.push(entry);
	}
	return { current, ambiguous, legacy };
}

/**
 * Merge current-cohort entries into one run per (source, attemptId) pair: the
 * terminal outcome wins over intermediate ones within that attempt only.
 * `not_run` decisions are excluded events, not runs: they are returned
 * separately and never enter any attempt denominator. A later independent
 * attempt in the same session keeps its own identity and can never be masked
 * by an earlier attempt's success; `published` decorates only the attempt whose
 * merged event it follows because both carry that attempt's identity.
 */
export function tallyRuns(entries) {
	const byAttempt = new Map();
	const excluded = [];
	for (const entry of entries) {
		if (entry.outcome === "not_run") {
			excluded.push(entry);
			continue;
		}
		const attemptId = typeof entry.attemptId === "string" && entry.attemptId ? entry.attemptId : undefined;
		if (!attemptId) continue; // ambiguous no-ID entries are handled by the cohort partition
		const key = `${entry.source}\u0000${attemptId}`;
		const attemptEntries = byAttempt.get(key) ?? [];
		attemptEntries.push(entry);
		byAttempt.set(key, attemptEntries);
	}
	const runs = [];
	for (const attemptEntries of byAttempt.values()) {
		const terminal = attemptEntries.findLast((entry) => entry.outcome === "published")
			?? attemptEntries.findLast((entry) => entry.outcome === "merged")
			?? attemptEntries.findLast((entry) => entry.outcome !== "not_run")
			?? attemptEntries.at(-1);
		runs.push(terminal);
	}
	return { runs, excluded };
}

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Compute the §9 gate metrics from terminal per-attempt outcomes over one
 * current cohort. `empty` counts as extractor execution success: on the current
 * cohort it can only mean a schema-valid {"findings":[]} answer for eligible
 * lane evidence.
 *
 * Provenance denominator: every candidate subjected to provenance verification
 * (accepted + rejected), never the accepted-only `findingsExtracted`. An
 * all-rejected attempt therefore reports N/N checked, and 19 empty successes
 * plus one all-rejected failure cannot pass the provenance gate. Malformed
 * telemetry (negative or non-integer counts) degrades deterministically:
 * missing/invalid `provenanceChecked` falls back to the derived accepted+
 * rejected sum, the denominator never drops below the reject numerator, and
 * per-reason counts are only trusted when they exactly partition their
 * attempt's aggregate reject count.
 */
export function computeGateMetrics(runs, excluded = []) {
	const total = runs.length;
	const succeeded = runs.filter((run) => SUCCESS_OUTCOMES.has(run.outcome)).length;
	let provenanceRejected = 0;
	let extractedTotal = 0;
	let checkedTotal = 0;
	let malformedCounts = 0;
	let reasonsPartitioned = true;
	const provenanceReasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
	for (const run of runs) {
		const counts = run.counts ?? {};
		const rejectedRaw = counts.findingsRejectedProvenance;
		const extractedRaw = counts.findingsExtracted;
		const checkedRaw = counts.provenanceChecked;
		const rejectedValue = nonNegativeInteger(rejectedRaw);
		const extractedValue = nonNegativeInteger(extractedRaw);
		const checkedValue = nonNegativeInteger(checkedRaw);
		if (
			(rejectedRaw !== undefined && rejectedValue === undefined) ||
			(extractedRaw !== undefined && extractedValue === undefined) ||
			(checkedRaw !== undefined && checkedValue === undefined)
		) malformedCounts++;
		const rejected = rejectedValue ?? 0;
		const extracted = extractedValue ?? 0;
		const derived = extracted + rejected;
		const checked = Math.max(checkedValue ?? derived, derived);
		provenanceRejected += rejected;
		extractedTotal += extracted;
		checkedTotal += checked;
		const reasons = run.provenanceRejectionReasons;
		if (!reasons) {
			if (rejected > 0) reasonsPartitioned = false;
			continue;
		}
		const parts = {
			sourceQuoteAbsent: nonNegativeInteger(reasons.sourceQuoteAbsent) ?? 0,
			locationQuoteAbsent: nonNegativeInteger(reasons.locationQuoteAbsent) ?? 0,
			locationQuotePathMismatch: nonNegativeInteger(reasons.locationQuotePathMismatch) ?? 0,
		};
		if (parts.sourceQuoteAbsent + parts.locationQuoteAbsent + parts.locationQuotePathMismatch !== rejected) {
			// The per-reason breakdown must partition the aggregate reject count;
			// a non-partitioning breakdown is never presented as authoritative.
			reasonsPartitioned = false;
			continue;
		}
		provenanceReasons.sourceQuoteAbsent += parts.sourceQuoteAbsent;
		provenanceReasons.locationQuoteAbsent += parts.locationQuoteAbsent;
		provenanceReasons.locationQuotePathMismatch += parts.locationQuotePathMismatch;
	}
	const elapsed = runs.map((run) => run.elapsedMs ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
	const p50 = elapsed.length > 0 ? elapsed[Math.floor((elapsed.length - 1) / 2)] : 0;
	const excludedByReason = {};
	for (const entry of excluded) excludedByReason[entry.reason ?? "unknown"] = (excludedByReason[entry.reason ?? "unknown"] ?? 0) + 1;
	return {
		total,
		succeeded,
		successRate: total > 0 ? succeeded / total : 0,
		provenanceRejectionRate: checkedTotal > 0 ? provenanceRejected / checkedTotal : 0,
		provenanceChecked: checkedTotal,
		findingsExtracted: extractedTotal,
		findingsMerged: runs.reduce((total, run) => total + (nonNegativeInteger(run.counts?.findingsMerged) ?? 0), 0),
		p50ElapsedMs: p50,
		provenanceReasons,
		provenanceReasonsPartitioned: reasonsPartitioned,
		malformedCounts,
		excludedCount: excluded.length,
		excludedByReason,
		sufficientSample: total >= GATE.minimumAttempts,
	};
}

export function formatScoreboard(runs, metrics) {
	const pct = (value) => `${(value * 100).toFixed(0)}%`;
	const lines = [
		"Extraction §9 gate scoreboard (current cohort, schemaVersion 2 with attempt IDs)",
		"===============================================================",
		`Eligible attempts (terminal)   : ${metrics.total}  (gate needs >= ${GATE.minimumAttempts})`,
		`  extractor success            : ${metrics.succeeded}  (merged/published/correct-empty)`,
		`  extractor success rate       : ${pct(metrics.successRate)}  (gate >= ${pct(GATE.successRate)})`,
		`Excluded not-run decisions     : ${metrics.excludedCount}${Object.keys(metrics.excludedByReason).length ? `  (${Object.entries(metrics.excludedByReason).map(([r, c]) => `${r}: ${c}`).join(", ")})` : ""}`,
		`Provenance rejection rate      : ${pct(metrics.provenanceRejectionRate)}  (gate < ${pct(GATE.provenanceRejectionRate)})`,
		`  checked candidates           : ${metrics.provenanceChecked}  (accepted + provenance-rejected)`,
		`  rejection reasons            : sourceQuoteAbsent ${metrics.provenanceReasons.sourceQuoteAbsent}, locationQuoteAbsent ${metrics.provenanceReasons.locationQuoteAbsent}, locationQuotePathMismatch ${metrics.provenanceReasons.locationQuotePathMismatch}`,
		`Findings extracted / merged    : ${metrics.findingsExtracted} / ${metrics.findingsMerged}`,
		`Extraction elapsed p50         : ${(metrics.p50ElapsedMs / 1000).toFixed(1)}s  (gate <= ${GATE.overheadP50Ms / 1000}s)`,
		"",
	];
	if (metrics.malformedCounts > 0) {
		lines.push(
			`WARNING: ${metrics.malformedCounts} attempt(s) carry malformed count telemetry; affected counts degrade to fail-safe derived values.`,
			"",
		);
	}
	if (!metrics.provenanceReasonsPartitioned) {
		lines.push(
			"WARNING: per-reason counts do not partition the aggregate reject count",
			"(missing or non-partitioning telemetry); the breakdown above is partial.",
			"",
		);
	}
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

/** Deterministic context-only terminal outcome per source for non-gate cohorts. */
function contextTerminals(entries) {
	const byRun = new Map();
	for (const entry of entries) {
		const mergedRuns = byRun.get(entry.source) ?? [];
		mergedRuns.push(entry);
		byRun.set(entry.source, mergedRuns);
	}
	return [...byRun.values()].map((runEntries) =>
		runEntries.findLast((entry) => entry.outcome === "published")
		?? runEntries.findLast((entry) => entry.outcome === "merged")
		?? runEntries.at(-1));
}

/** Context-only summary of the legacy cohort; never part of the gate decision. */
export function formatLegacySummary(entries) {
	const terminal = contextTerminals(entries);
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

/** Context-only summary of v2 entries without an attempt ID; never part of the gate decision. */
export function formatAmbiguousSummary(entries) {
	const terminal = contextTerminals(entries);
	const outcomes = new Map();
	for (const run of terminal) outcomes.set(run.outcome, (outcomes.get(run.outcome) ?? 0) + 1);
	const lines = [
		"Ambiguous v2 cohort (schemaVersion 2 without attemptId; context only)",
		"=====================================================================",
		`Runs: ${terminal.length}  outcomes: ${[...outcomes.entries()].sort().map(([o, c]) => `${o} ${c}`).join(", ") || "none"}`,
		"These events carry the current schema version but no attempt identity,",
		"so multiple attempts in one session cannot be segmented unambiguously.",
		"Exact current-cohort metrics are never claimed from them; they are",
		"permanently excluded from the default-on decision.",
	];
	return lines.join("\n");
}

// CLI entry point (development use only).
if (import.meta.url === `file://${process.argv[1]}`) {
	const { entries, filesScanned } = collectExtractionEntries();
	const { current, ambiguous, legacy } = partitionCohorts(entries);
	const { runs, excluded } = tallyRuns(current);
	const metrics = computeGateMetrics(runs, excluded);
	console.log(`Scanned ${filesScanned} session logs in ${sessionDir}`);
	console.log(formatScoreboard(runs, metrics));
	if (ambiguous.length > 0) {
		console.log();
		console.log(formatAmbiguousSummary(ambiguous));
	}
	console.log();
	console.log(formatLegacySummary(legacy));
}
