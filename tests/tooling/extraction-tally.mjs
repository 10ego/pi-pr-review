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

/** Outcomes that terminate an extraction attempt's event sequence. */
const TERMINAL_OUTCOMES = new Set(["merged", "empty", "failed", "timeout", "rejected", "aborted"]);

/**
 * Ordered per-attempt event state machine, evaluated in session-log order.
 *
 * A valid attempt is exactly one of:
 *   - a single terminal outcome (`merged`, `empty`, `failed`, `timeout`,
 *     `rejected`, `aborted`), or
 *   - `merged` immediately followed (in the attempt's own event order, so
 *     another attempt's records may be interleaved between them) by exactly
 *     one `published` decoration for that same attempt.
 *
 * `published` without a preceding same-attempt `merged` is an orphan and
 * invalid. Any conflicting or repeated terminal sequence — success then
 * failure, failure then success, `merged` then an unrelated terminal, a
 * terminal then `merged`, `published` then anything — is an invalid attempt:
 * the tally never picks the favorable record, it fails closed. In the valid
 * merged→published sequence, `merged` stays AUTHORITATIVE for every
 * gate-affecting field; BOTH sides must independently be schema-valid
 * against the runtime contract (counts with the exact expected integer
 * fields, exact per-reason integer counters, nonnegative integer inputBytes,
 * nonnegative finite elapsedMs) and `published` must mirror counts,
 * `provenanceRejectionReasons`, `inputBytes`, and `elapsedMs` exactly. Any
 * mismatch, promised-field omission, malformed value on either side, or extra
 * favorable override invalidates the attempt — equality of two identically
 * malformed records never legitimizes them, and published is decoration only
 * that can never replace, repair, or erase merged metrics. Invalid
 * attempts are returned separately, count against execution success and
 * sample volume in the metrics, and invalidate gate validity; they are never
 * silently dropped. `not_run` entries are excluded decision events, never part
 * of an attempt sequence.
 */
/** Gate-affecting fields the runtime contract promises the `published` event repeats from its `merged` attempt. */
const PUBLISHED_MIRRORED_FIELDS = ["counts", "provenanceRejectionReasons", "inputBytes", "elapsedMs"];

/** Exact required integer fields of the runtime `counts` contract (provenanceChecked optional; its accepted+rejected consistency is validated by the metrics, not the schema). */
const COUNTS_REQUIRED_INTEGER_FIELDS = [
	"findingsExtracted",
	"findingsMerged",
	"findingsDeduped",
	"findingsRejectedProvenance",
	"findingsDroppedOverflow",
];

/** Exact per-check provenance rejection reason counters the runtime contract emits. */
const PROVENANCE_REASON_FIELDS = ["sourceQuoteAbsent", "locationQuoteAbsent", "locationQuotePathMismatch"];

const isNonNegativeFiniteInteger = (value) => Number.isInteger(value) && value >= 0;
const isNonNegativeFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Exact-shape plain record of finite nonnegative integers: every present key
 * must be expected, every required key must be present, nulls, arrays,
 * strings, NaN/Infinity, negatives, and fractions are all rejected.
 */
function isExactIntegerRecord(value, requiredFields, optionalFields = []) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const key of Object.keys(value)) {
		if (!requiredFields.includes(key) && !optionalFields.includes(key)) return false;
		if (!isNonNegativeFiniteInteger(value[key])) return false;
	}
	return requiredFields.every((field) => Object.hasOwn(value, field));
}

/**
 * Independent schema validity of one gate/runtime-contract record (the
 * authoritative `merged` event or its `published` mirror) against the exact
 * runtime contract: counts with the exact expected integer fields (the
 * optional provenanceChecked must itself be a nonnegative integer; its
 * accepted+rejected consistency stays with metric validation), exact
 * per-reason integer counters, nonnegative integer inputBytes, and
 * nonnegative finite elapsedMs. Returns the first malformed gate field, or
 * undefined when the record is schema-valid.
 */
function gateFieldMalformation(event) {
	if (!isExactIntegerRecord(event.counts, COUNTS_REQUIRED_INTEGER_FIELDS, ["provenanceChecked"])) return "counts";
	if (!isExactIntegerRecord(event.provenanceRejectionReasons, PROVENANCE_REASON_FIELDS)) return "provenanceRejectionReasons";
	if (!isNonNegativeFiniteInteger(event.inputBytes)) return "inputBytes";
	if (!isNonNegativeFiniteNumber(event.elapsedMs)) return "elapsedMs";
	return undefined;
}

/** Structural deep equality over plain JSON-like values; exotic values never compare equal. */
function deepEqual(left, right) {
	if (left === right) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (!Object.hasOwn(right, key)) return false;
		if (!deepEqual(left[key], right[key])) return false;
	}
	return true;
}

/**
 * Decoration rule for the only valid two-event sequence merged→published:
 * `merged` is AUTHORITATIVE for every gate-affecting field (counts,
 * provenanceChecked, reason counters, elapsedMs, inputBytes). BOTH sides must
 * independently be schema-valid against the runtime contract first — two
 * identically malformed records never pass — and then the `published` event
 * must mirror each promised field exactly; any mismatch, promised-field
 * omission, malformed value on either side, or extra favorable override makes
 * the attempt invalid — published can never replace, repair, or erase merged
 * metrics.
 */
function publishedDivergence(merged, published) {
	for (const field of PUBLISHED_MIRRORED_FIELDS) {
		if (published[field] === undefined) return `published_missing_${field}`;
		if (merged[field] === undefined) return `published_extra_${field}`;
	}
	const mergedMalformed = gateFieldMalformation(merged);
	if (mergedMalformed !== undefined) return `merged_malformed_${mergedMalformed}`;
	const publishedMalformed = gateFieldMalformation(published);
	if (publishedMalformed !== undefined) return `published_malformed_${publishedMalformed}`;
	for (const field of PUBLISHED_MIRRORED_FIELDS) {
		if (!deepEqual(merged[field], published[field])) return `published_divergent_${field}`;
	}
	return undefined;
}

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
	const invalid = [];
	for (const attemptEntries of byAttempt.values()) {
		// Ordered scan of this attempt's events only.
		let terminal = undefined;
		let invalidReason = undefined;
		let mergedEvent = undefined; // authoritative metrics source for merged→published
		let publishedEvent = undefined;
		for (const entry of attemptEntries) {
			if (entry.outcome === "published") {
				// Valid only as the immediate decoration of this attempt's `merged`,
				// and only when it mirrors every gate-affecting field of that merge.
				if (terminal === "merged" && mergedEvent !== undefined) {
					const divergence = publishedDivergence(mergedEvent, entry);
					if (divergence !== undefined) invalidReason ??= divergence;
					else {
						terminal = "published";
						publishedEvent = entry;
					}
				} else invalidReason ??= terminal === undefined ? "orphan_published" : "published_after_terminal";
				continue;
			}
			if (!TERMINAL_OUTCOMES.has(entry.outcome)) {
				invalidReason ??= "unknown_outcome";
				continue;
			}
			if (terminal === undefined) {
				terminal = entry.outcome;
				if (entry.outcome === "merged") mergedEvent = entry;
			} else invalidReason ??= terminal === "published" ? "terminal_after_published" : "conflicting_terminal_sequence";
		}
		if (invalidReason !== undefined || terminal === undefined) {
			invalid.push({ ...attemptEntries.at(-1), invalidReason: invalidReason ?? "no_terminal_outcome" });
			continue;
		}
		// Terminal representative: outcome may display `published`, but every
		// gate-affecting metric comes from the authoritative merged event.
		const representative = terminal === "published" && mergedEvent
			? { ...mergedEvent, outcome: "published", ...(publishedEvent?.inlineComments !== undefined ? { inlineComments: publishedEvent.inlineComments } : {}), ...(publishedEvent?.publishStatus !== undefined ? { publishStatus: publishedEvent.publishStatus } : {}) }
			: attemptEntries.at(-1);
		// Latency completeness: every event's elapsedMs must agree on exactly one
		// finite nonnegative measurement (legitimate 0 counts).
		const elapsedValues = new Set();
		let elapsedMalformed = false;
		for (const entry of attemptEntries) {
			if (entry.elapsedMs === undefined) continue;
			if (typeof entry.elapsedMs !== "number" || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0) {
				elapsedMalformed = true;
				continue;
			}
			elapsedValues.add(entry.elapsedMs);
		}
		runs.push({
			...representative,
			attemptEventCount: attemptEntries.length,
			attemptElapsedMs: !elapsedMalformed && elapsedValues.size === 1 ? elapsedValues.values().next().value : undefined,
			attemptElapsedMissing: elapsedValues.size === 0 && !elapsedMalformed,
			attemptElapsedConflicting: elapsedValues.size > 1,
			attemptElapsedMalformed: elapsedMalformed,
		});
	}
	return { runs, invalid, excluded };
}

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Compute the §9 gate metrics from terminal per-attempt outcomes over one
 * current cohort. `empty` counts as extractor execution success: on the current
 * cohort it can only mean a schema-valid {"findings":[]} answer for eligible
 * lane evidence. Attempts whose event sequence failed the state machine
 * (`invalid`) count in the sample and against execution success — an invalid
 * attempt is never a success — and invalidate gate validity.
 *
 * Provenance denominator: every candidate subjected to provenance verification
 * (accepted + rejected), never the accepted-only `findingsExtracted`. When a
 * `provenanceChecked` count is present it must equal accepted + rejected
 * EXACTLY; any mismatch (including an oversized claimed denominator such as
 * checked=100 for 1 accepted + 1 rejected) marks the telemetry malformed and
 * gate-invalid, and the conservative derived denominator is used instead. The
 * per-reason counters must each be finite nonnegative integers summing exactly
 * to the attempt's aggregate rejects before the breakdown is trusted; invalid
 * or missing values are untrusted (partitioned=false) and block gate validity
 * rather than being normalized into a trusted partition.
 *
 * Latency completeness: every eligible current attempt must carry exactly one
 * finite nonnegative elapsedMs terminal measurement (legitimate 0 counts in
 * the p50). Missing, negative, nonnumeric, nonfinite, or conflicting latency
 * marks telemetry/gate invalid and cannot pass the default-on gate.
 */
export function computeGateMetrics(runs, excluded = [], invalid = []) {
	const total = runs.length + invalid.length;
	const succeeded = runs.filter((run) => SUCCESS_OUTCOMES.has(run.outcome)).length;
	let provenanceRejected = 0;
	let extractedTotal = 0;
	let checkedTotal = 0;
	let malformedCounts = 0;
	let provenanceCheckedExact = true;
	let reasonsPartitioned = true;
	const provenanceReasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
	for (const run of runs) {
		const counts = run.counts ?? {};
		const rejectedRaw = counts.findingsRejectedProvenance;
		const extractedRaw = counts.findingsExtracted;
		const checkedRaw = counts.provenanceChecked;
		const rejectedValue = nonNegativeInteger(rejectedRaw);
		const extractedValue = nonNegativeInteger(extractedRaw);
		if (
			(rejectedRaw !== undefined && rejectedValue === undefined) ||
			(extractedRaw !== undefined && extractedValue === undefined)
		) malformedCounts++;
		const rejected = rejectedValue ?? 0;
		const extracted = extractedValue ?? 0;
		const derived = extracted + rejected;
		// Exactness: a present provenanceChecked must equal accepted + rejected;
		// the derived denominator is always used so an oversized claim can never
		// dilute the rejection rate.
		if (checkedRaw !== undefined) {
			if (nonNegativeInteger(checkedRaw) === undefined || checkedRaw !== derived) {
				malformedCounts++;
				provenanceCheckedExact = false;
			}
		}
		provenanceRejected += rejected;
		extractedTotal += extracted;
		checkedTotal += derived;
		const reasons = run.provenanceRejectionReasons;
		if (!reasons) {
			if (rejected > 0) reasonsPartitioned = false;
			continue;
		}
		const parts = {
			sourceQuoteAbsent: reasons.sourceQuoteAbsent,
			locationQuoteAbsent: reasons.locationQuoteAbsent,
			locationQuotePathMismatch: reasons.locationQuotePathMismatch,
		};
		const values = Object.values(parts);
		if (values.some((value) => nonNegativeInteger(value) === undefined)) {
			// Invalid (negative, fractional, string, nonfinite) reason counters are
		// untrusted, never normalized into a partition.
			malformedCounts++;
			reasonsPartitioned = false;
			continue;
		}
		if (values.reduce((sum, value) => sum + value, 0) !== rejected) {
			reasonsPartitioned = false;
			continue;
		}
		provenanceReasons.sourceQuoteAbsent += parts.sourceQuoteAbsent;
		provenanceReasons.locationQuoteAbsent += parts.locationQuoteAbsent;
		provenanceReasons.locationQuotePathMismatch += parts.locationQuotePathMismatch;
	}
	// Latency completeness over every eligible valid attempt.
	const latencyMeasured = runs.filter((run) => run.attemptElapsedMs !== undefined);
	const latencyMissing = runs.filter((run) => run.attemptElapsedMissing).length;
	const latencyConflicting = runs.filter((run) => run.attemptElapsedConflicting).length;
	const latencyMalformed = runs.filter((run) => run.attemptElapsedMalformed).length;
	const latencyComplete = runs.length === 0 || latencyMeasured.length === runs.length;
	const elapsed = latencyMeasured.map((run) => run.attemptElapsedMs).sort((a, b) => a - b);
	const p50 = elapsed.length > 0 ? elapsed[Math.floor((elapsed.length - 1) / 2)] : 0;
	const excludedByReason = {};
	for (const entry of excluded) excludedByReason[entry.reason ?? "unknown"] = (excludedByReason[entry.reason ?? "unknown"] ?? 0) + 1;
	const invalidByReason = {};
	for (const entry of invalid) invalidByReason[entry.invalidReason ?? "unknown"] = (invalidByReason[entry.invalidReason ?? "unknown"] ?? 0) + 1;
	const gateValid = invalid.length === 0 && malformedCounts === 0 && reasonsPartitioned &&
		provenanceCheckedExact && latencyComplete;
	return {
		total,
		succeeded,
		successRate: total > 0 ? succeeded / total : 0,
		invalidAttempts: invalid.length,
		invalidByReason,
		provenanceRejectionRate: checkedTotal > 0 ? provenanceRejected / checkedTotal : 0,
		provenanceChecked: checkedTotal,
		provenanceCheckedExact,
		findingsExtracted: extractedTotal,
		findingsMerged: runs.reduce((total, run) => total + (nonNegativeInteger(run.counts?.findingsMerged) ?? 0), 0),
		p50ElapsedMs: p50,
		latencyComplete,
		latencyMeasured: latencyMeasured.length,
		latencyMissing,
		latencyConflicting,
		latencyMalformed,
		provenanceReasons,
		provenanceReasonsPartitioned: reasonsPartitioned,
		malformedCounts,
		gateValid,
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
		`  invalid attempt sequences    : ${metrics.invalidAttempts}${Object.keys(metrics.invalidByReason).length ? `  (${Object.entries(metrics.invalidByReason).map(([r, c]) => `${r}: ${c}`).join(", ")})` : ""}`,
		`Excluded not-run decisions     : ${metrics.excludedCount}${Object.keys(metrics.excludedByReason).length ? `  (${Object.entries(metrics.excludedByReason).map(([r, c]) => `${r}: ${c}`).join(", ")})` : ""}`,
		`Provenance rejection rate      : ${pct(metrics.provenanceRejectionRate)}  (gate < ${pct(GATE.provenanceRejectionRate)})`,
		`  checked candidates           : ${metrics.provenanceChecked}  (accepted + provenance-rejected, exact)`,
		`  rejection reasons            : sourceQuoteAbsent ${metrics.provenanceReasons.sourceQuoteAbsent}, locationQuoteAbsent ${metrics.provenanceReasons.locationQuoteAbsent}, locationQuotePathMismatch ${metrics.provenanceReasons.locationQuotePathMismatch}`,
		`Findings extracted / merged    : ${metrics.findingsExtracted} / ${metrics.findingsMerged}`,
		`Extraction elapsed p50         : ${(metrics.p50ElapsedMs / 1000).toFixed(1)}s  (gate <= ${GATE.overheadP50Ms / 1000}s)`,
		`  latency measurements         : ${metrics.latencyMeasured}/${metrics.total - metrics.invalidAttempts} complete  (missing ${metrics.latencyMissing}, conflicting ${metrics.latencyConflicting}, malformed ${metrics.latencyMalformed})`,
		`Gate telemetry validity        : ${metrics.gateValid ? "valid" : "INVALID"}`,
		"",
	];
	if (metrics.malformedCounts > 0) {
		lines.push(
			`WARNING: ${metrics.malformedCounts} attempt(s) carry malformed count telemetry; affected counts degrade to the conservative derived values.`,
			"",
		);
	}
	if (!metrics.provenanceCheckedExact) {
		lines.push(
			"WARNING: provenanceChecked does not exactly equal accepted + rejected",
			"on every attempt; the derived accepted+rejected denominator is used and",
			"the gate stays invalid until exact telemetry accumulates.",
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
	if (!metrics.latencyComplete) {
		lines.push(
			"WARNING: latency telemetry is incomplete (missing " + metrics.latencyMissing +
			", conflicting " + metrics.latencyConflicting + ", malformed " + metrics.latencyMalformed + ");",
			"the overhead p50 cannot support the default-on gate until every eligible",
			"attempt carries exactly one finite nonnegative elapsedMs measurement.",
			"",
		);
	}
	if (metrics.invalidAttempts > 0) {
		lines.push(
			`WARNING: ${metrics.invalidAttempts} attempt(s) failed the per-attempt event state machine;`,
			"they count against success and sample volume and keep the gate invalid.",
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
	const { runs, invalid, excluded } = tallyRuns(current);
	const metrics = computeGateMetrics(runs, excluded, invalid);
	console.log(`Scanned ${filesScanned} session logs in ${sessionDir}`);
	console.log(formatScoreboard(runs, metrics));
	if (ambiguous.length > 0) {
		console.log();
		console.log(formatAmbiguousSummary(ambiguous));
	}
	console.log();
	console.log(formatLegacySummary(legacy));
}
