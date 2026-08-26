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
 * Outcome-specific runtime schemas: before ANY terminal representative enters
 * `runs`, it must independently match the exact emission contract of its own
 * outcome, derived from the production emitters (extensions/review-table.ts).
 * Every eligible terminal event carries attemptId, schemaVersion, a nonnegative
 * integer inputBytes, and a finite nonnegative elapsedMs; merged, empty,
 * counts-bearing rejected, and published additionally carry the exact counts
 * record — whose provenanceChecked denominator is REQUIRED and must equal
 * findingsExtracted + findingsRejectedProvenance exactly — plus the exact
 * per-reason provenance records, whose three counters must sum exactly to
 * findingsRejectedProvenance (an empty must be all-zero); failed, timeout,
 * and aborted never carry counts or provenance telemetry, and rejected is an
 * explicit EXCLUSIVE union of that bare variant and the counts-bearing variant.
 * A terminal representative that violates its outcome schema becomes an invalid
 * attempt — it counts against execution success and sample volume and keeps
 * the gate invalid — so a merged-only attempt can never bypass validation
 * merely because publishing stayed off and no published mirror exists to
 * cross-check it against.
 *
 * Exact top-level shapes: every record may carry only the keys its outcome/
 * variant actually emits — common runtime identity/input/latency fields,
 * optional effectiveModel, counts-bearing counts/provenanceRejectionReasons,
 * published-only inlineComments/publishStatus with real publisher value
 * domains — plus the collector's source/timestamp metadata; fabricated
 * decorations, the not_run-only reason key, and arbitrary payloads fail
 * closed. computeGateMetrics additionally applies outcome-aware defense-in-
 * depth over DIRECT runs: schema-violating runs are untrusted (sample volume
 * only) and visibly keep the gate invalid instead of normalizing favorably.
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
 * against the runtime contract (counts with the exact expected integer fields
 * including the mandatory provenanceChecked denominator and the exact
 * accepted+rejected partition, per-reason counters partitioning the aggregate
 * rejects exactly, nonnegative integer inputBytes, nonnegative finite
 * elapsedMs) and `published` must mirror counts,
 * `provenanceRejectionReasons`, `inputBytes`, and `elapsedMs` exactly. Any
 * mismatch, promised-field omission, malformed value on either side, or extra
 * favorable override invalidates the attempt — equality of two identically
 * malformed records never legitimizes them, and published is decoration only
 * that can never replace, repair, or erase merged metrics. Invalid
 * attempts are returned separately, count against execution success and
 * sample volume in the metrics, and invalidate gate validity; they are never
 * silently dropped. Independently of the event ORDER, every terminal
 * representative must also satisfy its outcome-specific runtime emission
 * schema (`terminalRepresentativeMalformation`): merged-only terminals are
 * held to exactly the same contract as the merged side of a merged→published
 * pair, so a missing published mirror (publishing is default-off) never waives
 * validation. `not_run` entries are excluded decision events, never part
 * of an attempt sequence.
 */
/** Gate-affecting fields the runtime contract promises the `published` event repeats from its `merged` attempt. */
const PUBLISHED_MIRRORED_FIELDS = ["counts", "provenanceRejectionReasons", "inputBytes", "elapsedMs"];

/** Outcomes whose producer contract ALWAYS emits the exact counts and per-reason provenance records (with mandatory provenanceChecked and exact partitions). */
const PRODUCER_COUNTS_OUTCOMES = new Set(["merged", "empty", "published"]);
/** Outcomes whose producer contract NEVER emits counts or provenance telemetry (identity + input/elapsed only). */
const PRODUCER_BARE_OUTCOMES = new Set(["failed", "timeout", "aborted"]);
// `rejected` is modeled separately as an explicit EXCLUSIVE union of two real
// producer variants: the bare parse-rejection record (no counts/reasons) and
// the counts-bearing rejection record (full counts + reasons + partitions).

/** PublishStatus values the telemetry actually records: "posted" and "posted_degraded" are exactly the statuses for which the producer OMITS the publishStatus field. */
const PUBLISH_STATUS_TELEMETRY_VALUES = new Set(["skipped_duplicate", "failed", "indeterminate"]);

/** Collector metadata that collectExtractionEntries wraps around the producer payload; never emitted by the extension itself. */
const COLLECTOR_METADATA_KEYS = new Set(["source", "timestamp"]);
/** Runtime keys every eligible terminal producer record carries; effectiveModel is optional wherever the producer may emit it. */
const COMMON_RUNTIME_KEYS = new Set(["outcome", "attemptId", "schemaVersion", "inputBytes", "elapsedMs", "effectiveModel"]);
/** Top-level keys only counts-bearing variants add. */
const PRODUCER_COUNTS_KEYS = new Set(["counts", "provenanceRejectionReasons"]);
/** Publication decoration keys only the `published` decoration adds. */
const PUBLISHED_DECORATION_KEYS = new Set(["inlineComments", "publishStatus"]);

/** Exact allowed top-level key set for one terminal outcome, derived from the production emitters and the collector. */
function allowedTopLevelKeys(outcome) {
	const allowed = new Set(COMMON_RUNTIME_KEYS);
	if (PRODUCER_COUNTS_OUTCOMES.has(outcome) || outcome === "rejected") {
		for (const key of PRODUCER_COUNTS_KEYS) allowed.add(key);
	}
	if (outcome === "published") {
		for (const key of PUBLISHED_DECORATION_KEYS) allowed.add(key);
	}
	return allowed;
}

/** First top-level key on one producer record that its outcome/variant never emits, or undefined. */
function forbiddenTopLevelKey(entry) {
	const allowed = allowedTopLevelKeys(entry.outcome);
	for (const key of Object.keys(entry)) {
		if (!allowed.has(key) && !COLLECTOR_METADATA_KEYS.has(key)) return key;
	}
	return undefined;
}

/** Exact required integer fields of the runtime `counts` contract, including the MANDATORY provenanceChecked denominator (its exact accepted+rejected partition is validated by the schema, not deferred to metrics). */
const COUNTS_REQUIRED_INTEGER_FIELDS = [
	"findingsExtracted",
	"findingsMerged",
	"findingsDeduped",
	"findingsRejectedProvenance",
	"findingsDroppedOverflow",
	"provenanceChecked",
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
function isExactIntegerRecord(value, requiredFields) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const key of Object.keys(value)) {
		if (!requiredFields.includes(key)) return false;
		if (!isNonNegativeFiniteInteger(value[key])) return false;
	}
	return requiredFields.every((field) => Object.hasOwn(value, field));
}

/** Sum of the three per-check provenance rejection reason counters. */
const provenanceReasonSum = (reasons) =>
	reasons.sourceQuoteAbsent + reasons.locationQuoteAbsent + reasons.locationQuotePathMismatch;

/**
 * Independent schema validity of one counts-bearing gate/runtime-contract
 * record (the authoritative `merged` event, its `published` mirror, an `empty`,
 * or a counts-bearing `rejected`) against the exact runtime contract: counts
 * with the exact expected integer fields INCLUDING the mandatory
 * provenanceChecked denominator, exact per-reason integer counters, nonnegative
 * integer inputBytes, and nonnegative finite elapsedMs — and, before admission,
 * the exact producer partitions: provenanceChecked === findingsExtracted +
 * findingsRejectedProvenance, and the three reason counters summing exactly to
 * findingsRejectedProvenance. Contradictions are never deferred to a later
 * favorable computation. Returns the first malformed gate field, or undefined
 * when the record is schema-valid.
 */
function gateFieldMalformation(event) {
	if (!isExactIntegerRecord(event.counts, COUNTS_REQUIRED_INTEGER_FIELDS)) return "counts";
	if (!isExactIntegerRecord(event.provenanceRejectionReasons, PROVENANCE_REASON_FIELDS)) return "provenanceRejectionReasons";
	if (!isNonNegativeFiniteInteger(event.inputBytes)) return "inputBytes";
	if (!isNonNegativeFiniteNumber(event.elapsedMs)) return "elapsedMs";
	if (event.counts.provenanceChecked !== event.counts.findingsExtracted + event.counts.findingsRejectedProvenance) {
		return "provenanceCheckedPartition";
	}
	if (provenanceReasonSum(event.provenanceRejectionReasons) !== event.counts.findingsRejectedProvenance) {
		return "provenanceReasonPartition";
	}
	return undefined;
}

/**
 * Outcome-specific runtime schema for a terminal representative, mirroring
 * exactly what the production emitters in extensions/review-table.ts emit for
 * each outcome:
 *
 *  - EVERY eligible terminal event (`recordOutcome`) always carries the
 *    attempt identity fields (current `schemaVersion`, explicit nonempty
 *    `attemptId`), a finite nonnegative integer `inputBytes` (the assembled
 *    payload size, always present), and a finite nonnegative `elapsedMs`
 *    (always present).
 *  - `merged`, `empty`, and the `published` decoration always carry the exact
 *    counts record — including the MANDATORY `provenanceChecked` denominator —
 *    and the exact three-counter `provenanceRejectionReasons` record, with the
 *    exact producer partitions (checked === accepted + rejected; reasons sum
 *    === rejected) enforced before admission.
 *  - `rejected` is an explicit EXCLUSIVE union of two real producer variants:
 *    the bare parse-rejection record (malformed/fenced/oversized/structural
 *    output: no counts, no reasons, optional effectiveModel only) and the
 *    counts-bearing rejection record (all candidates provenance-rejected, or
 *    canonical merge/publication validation rejection: the exact complete
 *    counts schema including `provenanceChecked` plus exact reason counters
 *    and partitions). One-sided, fabricated, or malformed variants invalidate.
 *  - `failed`, `timeout`, and `aborted` never carry counts or provenance
 *    telemetry; presence of either contradicts the producer, so fabricated
 *    gate fields can never enter the provenance or latency denominators.
 *
 * Returns the first violated field name, or undefined when the record matches
 * its own outcome's runtime emission contract. Applied to EVERY terminal
 * representative before it enters `runs`, not only to merged→published pairs.
 */
function terminalRepresentativeMalformation(entry) {
	if (entry.schemaVersion !== CURRENT_SCHEMA_VERSION) return "schemaVersion";
	if (typeof entry.attemptId !== "string" || !entry.attemptId) return "attemptId";
	if (!isNonNegativeFiniteInteger(entry.inputBytes)) return "inputBytes";
	if (!isNonNegativeFiniteNumber(entry.elapsedMs)) return "elapsedMs";
	if (PRODUCER_COUNTS_OUTCOMES.has(entry.outcome)) {
		const malformation = gateFieldMalformation(entry);
		if (malformation !== undefined) return malformation;
		if (entry.outcome === "empty") {
			// The producer emits `empty` ONLY for a clean {"findings":[]} answer
			// with no rejected candidates, so every count must be zero.
			const countsAllZero = Object.values(entry.counts).every((value) => value === 0);
			const reasonsAllZero = Object.values(entry.provenanceRejectionReasons).every((value) => value === 0);
			if (!countsAllZero || !reasonsAllZero) return "inconsistent_empty_counts";
		}
		if (entry.outcome === "published") {
			// Decoration value domains mirror actual publisher output, not merely
			// key names: the inline comment count is emitted only when > 0, and
			// publishStatus is emitted only for non-posted outcomes ("posted" and
			// "posted_degraded" are exactly the statuses for which the producer
			// omits the field).
			if (entry.inlineComments !== undefined && !(isNonNegativeFiniteInteger(entry.inlineComments) && entry.inlineComments >= 1)) return "inlineComments";
			if (entry.publishStatus !== undefined && !PUBLISH_STATUS_TELEMETRY_VALUES.has(entry.publishStatus)) return "publishStatus";
		}
		return undefined;
	}
	if (PRODUCER_BARE_OUTCOMES.has(entry.outcome)) {
		if (entry.counts !== undefined) return "unexpected_counts";
		if (entry.provenanceRejectionReasons !== undefined) return "unexpected_provenanceRejectionReasons";
		return undefined;
	}
	// `rejected`: exclusive union dispatch over its two real producer variants.
	const hasCounts = entry.counts !== undefined;
	const hasReasons = entry.provenanceRejectionReasons !== undefined;
	if (!hasCounts && !hasReasons) return undefined; // bare parse-rejection variant
	if (!hasCounts) return "rejectedMissingCounts"; // one-sided: reasons without counts
	if (!hasReasons) return "rejectedMissingReasons"; // one-sided: counts without reasons
	return gateFieldMalformation(entry); // counts-bearing variant: full schema + partitions
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
			// Exact top-level producer shapes: any field the producer never emits
			// for this outcome/variant (fabricated publication decorations on
			// non-published records, the not_run-only reason key, arbitrary
			// payloads) fails closed before the sequence state machine runs.
			// Collector metadata (source/timestamp) is not payload.
			const forbiddenKey = forbiddenTopLevelKey(entry);
			if (forbiddenKey !== undefined) {
				invalidReason ??= `forbidden_field_${forbiddenKey}`;
				continue;
			}
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
		// Outcome-specific runtime schema: EVERY terminal representative must
		// independently match the exact emission contract of its own outcome
		// before it may enter `runs` — merged-only terminals included. A
		// representative missing or malforming any producer-required field
		// (counts, per-reason provenance counters, inputBytes, elapsedMs), an
		// empty claiming nonzero findings, or a bare failure fabricating counts
		// becomes an invalid attempt: it counts against success and sample
		// volume and keeps the gate invalid; it is never silently dropped or
		// counted favorably. Absence of a published mirror never waives this
		// validation (publishing is default-off).
		const representativeMalformation = terminalRepresentativeMalformation(representative);
		if (representativeMalformation !== undefined) {
			invalid.push({ ...representative, invalidReason: `terminal_malformed_${representativeMalformation}` });
			continue;
		}
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
 *
 * The outcome-specific runtime schemas are enforced TWICE: at tally admission
 * (every terminal representative; contradictions become invalid attempts) and
 * again at this boundary for DIRECT callers via `directRunMalformation` — a
 * run violating its outcome schema is UNTRUSTED: it stays in sample volume,
 * is excluded from execution success and provenance aggregates, increments
 * visible untrusted-run diagnostics, and keeps gate validity false rather
 * than being normalized favorably to zeros. The count/reason consistency
 * fallbacks below therefore only ever see admitted, schema-valid runs and
 * remain conservative should they ever fire.
 */
/**
 * Outcome-aware defense-in-depth for DIRECT computeGateMetrics callers. Every
 * run object handed to the metrics boundary must be a legitimate current-v2
 * tally run: current `schemaVersion`, a nonempty string `attemptId`, valid
 * outcome-specific runtime fields, a finite nonnegative integer `inputBytes`,
 * a finite nonnegative raw `elapsedMs` on every outcome, and the exact self-
 * consistent tally latency representation — finite nonnegative `attemptElapsedMs`
 * equal to the raw authoritative measurement, with `attemptElapsedMissing`,
 * `attemptElapsedConflicting`, and `attemptElapsedMalformed` each exactly the
 * boolean `false`, and a positive-integer `attemptEventCount` matching the only
 * valid state-machine shapes (1 for an ordinary terminal record, 2 for a
 * published decoration). Counts-bearing merged/empty/published runs need the
 * exact counts record (mandatory provenanceChecked, exact checked partition,
 * exact reason partition); bare rejected/failed/timeout/aborted runs must stay
 * bare; rejected follows its exclusive union. Violations make the run UNTRUSTED
 * — it stays in sample volume but can never support execution success,
 * provenance aggregates, or the p50 — instead of being normalized favorably to
 * zeros. Internal tally fields are expected here and are not treated as payload.
 */
function directRunMalformation(run) {
	if (!TERMINAL_OUTCOMES.has(run.outcome) && run.outcome !== "published") return "unknown_outcome";
	if (run.schemaVersion !== CURRENT_SCHEMA_VERSION) return "schemaVersion";
	if (typeof run.attemptId !== "string" || !run.attemptId) return "attemptId";
	if (!isNonNegativeFiniteInteger(run.inputBytes)) return "inputBytes";
	if (!isNonNegativeFiniteNumber(run.elapsedMs)) return "elapsedMs";
	if (!isNonNegativeFiniteNumber(run.attemptElapsedMs) || run.attemptElapsedMs !== run.elapsedMs) return "elapsed_measurement";
	if (run.attemptElapsedMissing !== false || run.attemptElapsedConflicting !== false || run.attemptElapsedMalformed !== false) return "latency_flags";
	if (!isNonNegativeFiniteInteger(run.attemptEventCount) || run.attemptEventCount < 1 ||
		(run.outcome === "published" ? run.attemptEventCount !== 2 : run.attemptEventCount !== 1)) return "attempt_event_count";
	if (PRODUCER_COUNTS_OUTCOMES.has(run.outcome)) {
		const malformation = gateFieldMalformation(run);
		if (malformation !== undefined) return malformation;
		if (run.outcome === "empty") {
			const allZero = (record) => Object.values(record).every((value) => value === 0);
			return !allZero(run.counts) || !allZero(run.provenanceRejectionReasons) ? "inconsistent_empty_counts" : undefined;
		}
		return undefined;
	}
	if (PRODUCER_BARE_OUTCOMES.has(run.outcome)) {
		if (run.counts !== undefined) return "unexpected_counts";
		if (run.provenanceRejectionReasons !== undefined) return "unexpected_provenanceRejectionReasons";
		return undefined;
	}
	// `rejected`: exclusive union dispatch over its two real producer variants.
	const hasCounts = run.counts !== undefined;
	const hasReasons = run.provenanceRejectionReasons !== undefined;
	if (!hasCounts && !hasReasons) return undefined;
	if (!hasCounts) return "rejectedMissingCounts";
	if (!hasReasons) return "rejectedMissingReasons";
	return gateFieldMalformation(run);
}

export function computeGateMetrics(runs, excluded = [], invalid = []) {
	const total = runs.length + invalid.length;
	// Outcome-aware boundary validation: untrusted runs remain in sample volume
	// but are excluded from every favorable aggregate and keep the gate invalid.
	let succeeded = 0;
	let untrustedRuns = 0;
	const untrustedByReason = {};
	const admitted = [];
	for (const run of runs) {
		const violation = directRunMalformation(run);
		if (violation !== undefined) {
			untrustedRuns++;
			untrustedByReason[violation] = (untrustedByReason[violation] ?? 0) + 1;
			continue;
		}
		admitted.push(run);
		if (SUCCESS_OUTCOMES.has(run.outcome)) succeeded++;
	}
	let provenanceRejected = 0;
	let extractedTotal = 0;
	let checkedTotal = 0;
	let malformedCounts = 0;
	let provenanceCheckedExact = true;
	let reasonsPartitioned = true;
	const provenanceReasons = { sourceQuoteAbsent: 0, locationQuoteAbsent: 0, locationQuotePathMismatch: 0 };
	for (const run of admitted) {
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
	const latencyMeasured = admitted.filter((run) => run.attemptElapsedMs !== undefined);
	const latencyMissing = admitted.filter((run) => run.attemptElapsedMissing).length;
	const latencyConflicting = admitted.filter((run) => run.attemptElapsedConflicting).length;
	const latencyMalformed = admitted.filter((run) => run.attemptElapsedMalformed).length;
	const latencyComplete = admitted.length === 0 || latencyMeasured.length === admitted.length;
	const elapsed = latencyMeasured.map((run) => run.attemptElapsedMs).sort((a, b) => a - b);
	const p50 = elapsed.length > 0 ? elapsed[Math.floor((elapsed.length - 1) / 2)] : 0;
	const excludedByReason = {};
	for (const entry of excluded) excludedByReason[entry.reason ?? "unknown"] = (excludedByReason[entry.reason ?? "unknown"] ?? 0) + 1;
	const invalidByReason = {};
	for (const entry of invalid) invalidByReason[entry.invalidReason ?? "unknown"] = (invalidByReason[entry.invalidReason ?? "unknown"] ?? 0) + 1;
	const gateValid = untrustedRuns === 0 && invalid.length === 0 && malformedCounts === 0 && reasonsPartitioned &&
		provenanceCheckedExact && latencyComplete;
	return {
		total,
		succeeded,
		successRate: total > 0 ? succeeded / total : 0,
		invalidAttempts: invalid.length,
		invalidByReason,
		untrustedRuns,
		untrustedByReason,
		provenanceRejectionRate: checkedTotal > 0 ? provenanceRejected / checkedTotal : 0,
		provenanceChecked: checkedTotal,
		provenanceCheckedExact,
		findingsExtracted: extractedTotal,
		findingsMerged: admitted.reduce((sum, run) => sum + (nonNegativeInteger(run.counts?.findingsMerged) ?? 0), 0),
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
			`WARNING: ${metrics.invalidAttempts} attempt(s) failed the per-attempt event state machine or their outcome-specific runtime schema;`,
			"they count against success and sample volume and keep the gate invalid.",
			"",
		);
	}
	if (metrics.untrustedRuns > 0) {
		lines.push(
			`WARNING: ${metrics.untrustedRuns} run(s) violate their outcome-specific runtime schema at the direct-metrics boundary (${Object.entries(metrics.untrustedByReason).map(([reason, count]) => `${reason}: ${count}`).join(", ")});`,
			"they cannot support execution success or provenance aggregates and keep the gate invalid.",
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
