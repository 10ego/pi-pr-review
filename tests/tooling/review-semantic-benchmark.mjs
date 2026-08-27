#!/usr/bin/env node
/**
 * Deterministic semantic-recall benchmark planner and scorer.
 *
 * Development tooling only: no provider, Pi, GitHub, subprocess, or write API is
 * invoked. Real review runs are collected separately and supplied as immutable
 * result bundles.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const MODES = new Set(["balanced", "full", "major-only", "deep"]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3", "nit"]);
const LANE_STATES = new Set(["complete", "partial", "timed_out", "failed"]);
const PUBLICATION_ARTIFACTS = new Set(["canonical", "degraded", "raw_body_only"]);
const SHA256 = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
	if (!condition) throw new Error(`Semantic benchmark invalid: ${message}`);
}
function plain(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, required, optional = []) {
	if (!plain(value)) return false;
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function finiteNonnegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function readJson(file) {
	const stat = fs.lstatSync(file);
	invariant(stat.isFile() && !stat.isSymbolicLink(), `${file} must be a regular non-symlink file`);
	const bytes = fs.readFileSync(file);
	return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}
function safeRelative(value, label) {
	invariant(typeof value === "string" && value.length > 0 && value.length <= 300, `${label} path`);
	const normalized = value.replaceAll("\\", "/");
	invariant(normalized === value && !path.posix.isAbsolute(value) && !value.split("/").some((part) => part === "" || part === "." || part === ".."), `${label} unsafe path`);
	return value;
}
function resolveContained(root, relative, label) {
	const safe = safeRelative(relative, label);
	const resolved = path.resolve(root, safe), fromRoot = path.relative(root, resolved);
	invariant(fromRoot !== "" && !fromRoot.startsWith(`..${path.sep}`) && fromRoot !== "..", `${label} escapes root`);
	return resolved;
}
function resolveContainedRegular(root, relative, label) {
	const resolved = resolveContained(root, relative, label), parts = path.relative(root, resolved).split(path.sep);
	let current = root;
	for (const part of parts) {
		current = path.join(current, part);
		const stat = fs.lstatSync(current);
		invariant(!stat.isSymbolicLink(), `${label} contains a symlink`);
	}
	invariant(fs.lstatSync(resolved).isFile(), `${label} must be a regular file`);
	return resolved;
}
function parseDiffFiles(text) {
	return [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => {
		invariant(match[1] === match[2], `rename diffs are not supported in corpus: ${match[1]} -> ${match[2]}`);
		return match[1];
	});
}

export function loadCorpus(file) {
	const corpusFile = path.resolve(file), root = path.dirname(corpusFile), { bytes, value } = readJson(corpusFile);
	invariant(exactKeys(value, ["schemaVersion", "corpusId", "description", "lenses", "cases"]), "corpus schema");
	invariant(value.schemaVersion === 1 && typeof value.corpusId === "string" && value.corpusId.length > 0, "corpus identity");
	invariant(Array.isArray(value.lenses) && value.lenses.length > 0 && new Set(value.lenses).size === value.lenses.length && value.lenses.every((lens) => typeof lens === "string" && lens.length > 0), "corpus lenses");
	invariant(Array.isArray(value.cases) && value.cases.length > 0, "corpus cases");
	const ids = new Set(), expectedIds = new Set();
	let cleanControls = 0, crossFileExpected = 0;
	for (const item of value.cases) {
		invariant(exactKeys(item, ["id", "title", "diff", "diffSha256", "changedFiles", "cleanControl", "crossFile", "expectedFindings"]), "case schema");
		invariant(typeof item.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && !ids.has(item.id), `case id ${item.id}`); ids.add(item.id);
		invariant(typeof item.title === "string" && item.title.length >= 8 && item.title.length <= 120, `case ${item.id} title`);
		invariant(typeof item.cleanControl === "boolean" && typeof item.crossFile === "boolean", `case ${item.id} flags`);
		invariant(Array.isArray(item.changedFiles) && item.changedFiles.length > 0 && new Set(item.changedFiles).size === item.changedFiles.length, `case ${item.id} changedFiles`);
		item.changedFiles.forEach((filePath) => safeRelative(filePath, `case ${item.id} changed file`));
		const diffFile = resolveContainedRegular(root, item.diff, `case ${item.id} diff`), diffBytes = fs.readFileSync(diffFile), diffText = diffBytes.toString("utf8");
		invariant(SHA256.test(item.diffSha256) && sha256(diffBytes) === item.diffSha256, `case ${item.id} diff hash`);
		invariant(diffText.length > 0 && !diffText.includes(item.id), `case ${item.id} reviewer-visible diff leaks its benchmark id`);
		invariant(JSON.stringify(parseDiffFiles(diffText)) === JSON.stringify(item.changedFiles), `case ${item.id} changedFiles differ from diff`);
		invariant(Array.isArray(item.expectedFindings), `case ${item.id} expectedFindings`);
		invariant(item.cleanControl === (item.expectedFindings.length === 0), `case ${item.id} clean-control partition`);
		if (item.cleanControl) cleanControls++;
		for (const expected of item.expectedFindings) {
			invariant(exactKeys(expected, ["id", "allowedSeverities", "acceptableLocations", "rationale", "lenses", "blocking", "crossFile", "requiredConcepts"]), `expected finding schema in ${item.id}`);
			invariant(typeof expected.id === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(expected.id) && !expectedIds.has(expected.id), `expected finding id ${expected.id}`); expectedIds.add(expected.id);
			invariant(Array.isArray(expected.allowedSeverities) && expected.allowedSeverities.length > 0 && expected.allowedSeverities.every((severity) => SEVERITIES.has(severity)), `expected ${expected.id} severities`);
			invariant(typeof expected.blocking === "boolean" && typeof expected.crossFile === "boolean" && typeof expected.rationale === "string" && expected.rationale.length >= 20, `expected ${expected.id} metadata`);
			invariant(expected.blocking === expected.allowedSeverities.every((severity) => severity === "P0" || severity === "P1"), `expected ${expected.id} blocking policy`);
			invariant(Array.isArray(expected.lenses) && expected.lenses.length > 0 && expected.lenses.every((lens) => value.lenses.includes(lens)), `expected ${expected.id} lenses`);
			invariant(Array.isArray(expected.requiredConcepts) && expected.requiredConcepts.length > 0 && expected.requiredConcepts.every((group) => Array.isArray(group) && group.length > 0 && group.every((term) => typeof term === "string" && term.length > 0)), `expected ${expected.id} concepts`);
			invariant(Array.isArray(expected.acceptableLocations) && expected.acceptableLocations.length > 0, `expected ${expected.id} locations`);
			for (const location of expected.acceptableLocations) {
				invariant(exactKeys(location, ["path", "side", "start", "end"]), `expected ${expected.id} location schema`);
				safeRelative(location.path, `expected ${expected.id} location`);
				invariant(item.changedFiles.includes(location.path) && (location.side === "RIGHT" || location.side === "LEFT") && Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) && location.start > 0 && location.end >= location.start, `expected ${expected.id} location`);
			}
			if (expected.crossFile) crossFileExpected++;
		}
	}
	invariant(cleanControls >= 2, "corpus requires at least two clean controls");
	invariant(crossFileExpected >= 1, "corpus requires cross-file expected findings");
	for (const lens of value.lenses) invariant(value.cases.some((item) => item.expectedFindings.some((finding) => finding.lenses.includes(lens))), `lens ${lens} has no seeded finding`);
	return { corpus: value, corpusFile, root, sha256: sha256(bytes), bytes: bytes.length };
}

function validatePlan(plan, corpusInfo) {
	invariant(exactKeys(plan, ["schemaVersion", "planId", "corpusId", "corpusSha256", "modes", "repetitions", "entries"]), "plan schema");
	invariant(plan.schemaVersion === 1 && plan.corpusId === corpusInfo.corpus.corpusId && plan.corpusSha256 === corpusInfo.sha256 && SHA256.test(plan.planId), "plan identity");
	invariant(Array.isArray(plan.modes) && plan.modes.length > 0 && new Set(plan.modes).size === plan.modes.length && plan.modes.every((mode) => MODES.has(mode)), "plan modes");
	invariant(Number.isSafeInteger(plan.repetitions) && plan.repetitions >= 1 && plan.repetitions <= 100, "plan repetitions");
	const expectedCount = corpusInfo.corpus.cases.length * plan.modes.length * plan.repetitions;
	invariant(Array.isArray(plan.entries) && plan.entries.length === expectedCount, "plan entry count");
	const ids = new Set(), tuples = new Set();
	for (const entry of plan.entries) {
		invariant(exactKeys(entry, ["entryId", "caseId", "mode", "repetition"]), "plan entry schema");
		invariant(typeof entry.entryId === "string" && /^[0-9a-f]{24}$/.test(entry.entryId) && !ids.has(entry.entryId), `plan entry id ${entry.entryId}`); ids.add(entry.entryId);
		invariant(corpusInfo.corpus.cases.some((item) => item.id === entry.caseId) && plan.modes.includes(entry.mode) && Number.isSafeInteger(entry.repetition) && entry.repetition >= 1 && entry.repetition <= plan.repetitions, `plan entry ${entry.entryId}`);
		const tuple = `${entry.mode}\0${entry.repetition}\0${entry.caseId}`;
		invariant(!tuples.has(tuple), `duplicate plan tuple ${entry.mode}/${entry.repetition}/${entry.caseId}`); tuples.add(tuple);
	}
	for (const mode of plan.modes) for (let repetition = 1; repetition <= plan.repetitions; repetition++) for (const item of corpusInfo.corpus.cases) invariant(tuples.has(`${mode}\0${repetition}\0${item.id}`), `missing plan tuple ${mode}/${repetition}/${item.id}`);
	const identity = { schemaVersion: plan.schemaVersion, corpusId: plan.corpusId, corpusSha256: plan.corpusSha256, modes: plan.modes, repetitions: plan.repetitions, entries: plan.entries };
	invariant(sha256(Buffer.from(canonical(identity))) === plan.planId, "planId does not bind canonical plan");
	return plan;
}

export function createPlan(corpusInfo, modes, repetitions) {
	invariant(Array.isArray(modes) && modes.length > 0 && new Set(modes).size === modes.length && modes.every((mode) => MODES.has(mode)), "requested modes");
	invariant(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 100, "requested repetitions");
	const entries = [];
	for (const mode of modes) for (let repetition = 1; repetition <= repetitions; repetition++) for (const item of corpusInfo.corpus.cases) {
		const key = `${corpusInfo.sha256}\0${mode}\0${repetition}\0${item.id}`;
		entries.push({ entryId: sha256(Buffer.from(key)).slice(0, 24), caseId: item.id, mode, repetition });
	}
	const identity = { schemaVersion: 1, corpusId: corpusInfo.corpus.corpusId, corpusSha256: corpusInfo.sha256, modes, repetitions, entries };
	return { ...identity, planId: sha256(Buffer.from(canonical(identity))) };
}

function validateArtifact(reference, bundleRoot, runLabel) {
	invariant(exactKeys(reference, ["kind", "path", "sha256", "bytes"]), `${runLabel} artifact schema`);
	invariant(reference.kind === "lane-artifacts" || reference.kind === "canonical-review", `${runLabel} artifact kind`);
	invariant(SHA256.test(reference.sha256) && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= 100 * 1024 * 1024, `${runLabel} artifact metadata`);
	const file = resolveContainedRegular(bundleRoot, reference.path, `${runLabel} artifact`), data = fs.readFileSync(file);
	invariant(data.length === reference.bytes && sha256(data) === reference.sha256, `${runLabel} artifact bytes/hash`);
	return reference;
}

function validateRun(run, planEntry, bundleRoot) {
	const label = `run ${planEntry.entryId}`;
	invariant(exactKeys(run, ["schemaVersion", "planEntryId", "caseId", "mode", "repetition", "startedAtUtc", "elapsedMs", "timing", "configuration", "lanes", "publication", "findings", "artifacts"]), `${label} schema`);
	invariant(run.schemaVersion === 1 && run.planEntryId === planEntry.entryId && run.caseId === planEntry.caseId && run.mode === planEntry.mode && run.repetition === planEntry.repetition, `${label} plan binding`);
	invariant(typeof run.startedAtUtc === "string" && Number.isFinite(Date.parse(run.startedAtUtc)), `${label} timestamp`);
	invariant(finiteNonnegative(run.elapsedMs), `${label} elapsedMs`);
	invariant(exactKeys(run.timing, ["parentValidationMs", "parentSynthesisMs"]) && finiteNonnegative(run.timing.parentValidationMs) && finiteNonnegative(run.timing.parentSynthesisMs), `${label} parent timing`);
	invariant(exactKeys(run.configuration, ["provider", "model", "thinking", "toolPolicy", "reviewVersion", "topology"]), `${label} configuration schema`);
	for (const key of ["provider", "model", "thinking", "toolPolicy", "reviewVersion"]) invariant(typeof run.configuration[key] === "string" && run.configuration[key].length > 0 && run.configuration[key].length <= 200, `${label} configuration ${key}`);
	const topology = run.configuration.topology;
	invariant(exactKeys(topology, ["passIds", "shardCount", "maxParallel"]) && Array.isArray(topology.passIds) && topology.passIds.length > 0 && topology.passIds.every((id) => typeof id === "string" && id.length > 0) && Number.isSafeInteger(topology.shardCount) && topology.shardCount >= 1 && topology.shardCount <= 20 && Number.isSafeInteger(topology.maxParallel) && topology.maxParallel >= 1 && topology.maxParallel <= 100, `${label} topology`);
	invariant(Array.isArray(run.lanes) && run.lanes.length > 0, `${label} lanes`);
	const laneIds = new Set();
	for (const lane of run.lanes) {
		invariant(exactKeys(lane, ["id", "lens", "status", "elapsedMs", "provider", "model"]), `${label} lane schema`);
		invariant(typeof lane.id === "string" && lane.id.length > 0 && !laneIds.has(lane.id), `${label} lane id`); laneIds.add(lane.id);
		invariant(typeof lane.lens === "string" && lane.lens.length > 0 && LANE_STATES.has(lane.status) && finiteNonnegative(lane.elapsedMs) && typeof lane.provider === "string" && lane.provider.length > 0 && typeof lane.model === "string" && lane.model.length > 0, `${label} lane metadata`);
	}
	invariant(exactKeys(run.publication, ["artifact", "fallback"]) && PUBLICATION_ARTIFACTS.has(run.publication.artifact) && typeof run.publication.fallback === "boolean" && run.publication.fallback === (run.publication.artifact !== "canonical"), `${label} publication`);
	invariant(Array.isArray(run.findings) && run.findings.length <= 200, `${label} findings`);
	for (const finding of run.findings) {
		invariant(exactKeys(finding, ["title", "body", "severity", "location"]), `${label} finding schema`);
		invariant(typeof finding.title === "string" && finding.title.length > 0 && finding.title.length <= 500 && typeof finding.body === "string" && finding.body.length > 0 && finding.body.length <= 20_000 && SEVERITIES.has(finding.severity), `${label} finding metadata`);
		if (finding.location !== null) {
			invariant(exactKeys(finding.location, ["path", "side", "start", "end"]), `${label} finding location schema`);
			safeRelative(finding.location.path, `${label} finding location`);
			invariant((finding.location.side === "RIGHT" || finding.location.side === "LEFT") && Number.isSafeInteger(finding.location.start) && Number.isSafeInteger(finding.location.end) && finding.location.start > 0 && finding.location.end >= finding.location.start, `${label} finding location`);
		}
	}
	invariant(Array.isArray(run.artifacts) && run.artifacts.length === 2 && new Set(run.artifacts.map((item) => item.kind)).size === 2, `${label} artifacts`);
	run.artifacts.forEach((artifact) => validateArtifact(artifact, bundleRoot, label));
	return run;
}

function locationMatches(actual, acceptable) {
	return actual !== null && actual.path === acceptable.path && actual.side === acceptable.side && actual.end >= acceptable.start && actual.start <= acceptable.end;
}
function expectedMatchesFinding(expected, finding) {
	if (!expected.allowedSeverities.includes(finding.severity)) return false;
	if (!expected.acceptableLocations.some((location) => locationMatches(finding.location, location))) return false;
	const text = `${finding.title}\n${finding.body}`.toLocaleLowerCase("en-US");
	return expected.requiredConcepts.every((group) => group.some((term) => text.includes(term.toLocaleLowerCase("en-US"))));
}
function maximumMatching(edges, expectedCount) {
	const assignedFinding = Array(expectedCount).fill(-1);
	function assign(findingIndex, seen) {
		for (const expectedIndex of edges[findingIndex]) {
			if (seen.has(expectedIndex)) continue;
			seen.add(expectedIndex);
			if (assignedFinding[expectedIndex] === -1 || assign(assignedFinding[expectedIndex], seen)) { assignedFinding[expectedIndex] = findingIndex; return true; }
		}
		return false;
	}
	for (let findingIndex = 0; findingIndex < edges.length; findingIndex++) assign(findingIndex, new Set());
	return assignedFinding;
}

export function scoreRun(item, run) {
	const expected = item.expectedFindings;
	const edges = run.findings.map((finding) => expected.map((candidate, index) => expectedMatchesFinding(candidate, finding) ? index : -1).filter((index) => index >= 0));
	const assignedFinding = maximumMatching(edges, expected.length), matchedFindingIndices = new Set(assignedFinding.filter((index) => index >= 0));
	const matchedExpectedIds = expected.filter((_, index) => assignedFinding[index] >= 0).map((candidate) => candidate.id);
	let duplicates = 0, falsePositives = 0;
	for (let index = 0; index < run.findings.length; index++) {
		if (matchedFindingIndices.has(index)) continue;
		if (edges[index].some((expectedIndex) => assignedFinding[expectedIndex] >= 0)) duplicates++;
		else falsePositives++;
	}
	return { matchedExpectedIds, missedExpectedIds: expected.filter((candidate) => !matchedExpectedIds.includes(candidate.id)).map((candidate) => candidate.id), duplicateFindings: duplicates, falsePositiveFindings: falsePositives, cleanControlHadFinding: item.cleanControl && run.findings.length > 0 };
}

function ratio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }
function percentile(values, percentileValue) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b), index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[index];
}
function metricPair(opportunities, matched) { return { matched, opportunities, recall: ratio(matched, opportunities) }; }

export function aggregateScores(corpusInfo, plan, runs) {
	const caseById = new Map(corpusInfo.corpus.cases.map((item) => [item.id, item]));
	const scores = runs.map((run) => ({ run, item: caseById.get(run.caseId), score: scoreRun(caseById.get(run.caseId), run) }));
	const aggregateGroup = (group) => {
		const expectedOpportunities = group.flatMap(({ item }) => item.expectedFindings);
		const matchedIds = new Set(group.flatMap(({ run, score }) => score.matchedExpectedIds.map((id) => `${run.planEntryId}\0${id}`)));
		const select = (predicate) => {
			let opportunities = 0, matched = 0;
			for (const { run, item } of group) for (const expected of item.expectedFindings) if (predicate(expected)) { opportunities++; if (matchedIds.has(`${run.planEntryId}\0${expected.id}`)) matched++; }
			return metricPair(opportunities, matched);
		};
		const perLens = Object.fromEntries(corpusInfo.corpus.lenses.map((lens) => [lens, select((expected) => expected.lenses.includes(lens))]));
		const clean = group.filter(({ item }) => item.cleanControl), laneStates = Object.fromEntries([...LANE_STATES].map((state) => [state, group.reduce((sum, { run }) => sum + run.lanes.filter((lane) => lane.status === state).length, 0)]));
		const laneTotal = Object.values(laneStates).reduce((a, b) => a + b, 0), allFindings = group.reduce((sum, { run }) => sum + run.findings.length, 0), duplicates = group.reduce((sum, { score }) => sum + score.duplicateFindings, 0), falsePositives = group.reduce((sum, { score }) => sum + score.falsePositiveFindings, 0), fallbackRuns = group.filter(({ run }) => run.publication.fallback).length;
		return {
			runs: group.length,
			p0p1: select((expected) => expected.allowedSeverities[0] === "P0" || expected.allowedSeverities[0] === "P1"),
			p2: select((expected) => expected.allowedSeverities[0] === "P2"),
			crossFile: select((expected) => expected.crossFile),
			perLens,
			cleanControls: { runs: clean.length, runsWithFindings: clean.filter(({ score }) => score.cleanControlHadFinding).length, caseFalsePositiveRate: ratio(clean.filter(({ score }) => score.cleanControlHadFinding).length, clean.length) },
			findings: { total: allFindings, falsePositives, duplicates, falsePositiveRate: ratio(falsePositives, allFindings), duplicateRate: ratio(duplicates, allFindings) },
			lanes: { total: laneTotal, ...laneStates, completeRate: ratio(laneStates.complete, laneTotal), partialRate: ratio(laneStates.partial, laneTotal), timedOutRate: ratio(laneStates.timed_out, laneTotal), failedRate: ratio(laneStates.failed, laneTotal) },
			publication: { fallbackRuns, fallbackRate: ratio(fallbackRuns, group.length) },
			latencyMs: { p50: percentile(group.map(({ run }) => run.elapsedMs), 0.5), p95: percentile(group.map(({ run }) => run.elapsedMs), 0.95), parentValidationP50: percentile(group.map(({ run }) => run.timing.parentValidationMs), 0.5), parentSynthesisP50: percentile(group.map(({ run }) => run.timing.parentSynthesisMs), 0.5) },
		};
	};
	return { overall: aggregateGroup(scores), modes: Object.fromEntries(plan.modes.map((mode) => [mode, aggregateGroup(scores.filter(({ run }) => run.mode === mode))])), runs: scores.map(({ run, score }) => ({ planEntryId: run.planEntryId, caseId: run.caseId, mode: run.mode, repetition: run.repetition, ...score })) };
}

function evaluateGates(metrics, gates, corpusInfo) {
	if (!gates) return { status: "baseline_required", passed: false, failures: ["No accepted baseline gate file was supplied; metrics are diagnostic only."] };
	invariant(exactKeys(gates, ["schemaVersion", "corpusId", "corpusSha256", "acceptedAtUtc", "rationale", "thresholds"]), "gate file schema");
	invariant(gates.schemaVersion === 1 && gates.corpusId === corpusInfo.corpus.corpusId && gates.corpusSha256 === corpusInfo.sha256 && Number.isFinite(Date.parse(gates.acceptedAtUtc)) && typeof gates.rationale === "string" && gates.rationale.length >= 20, "gate file identity");
	const t = gates.thresholds;
	invariant(exactKeys(t, ["minimumP0P1Recall", "minimumP2Recall", "minimumCrossFileRecall", "maximumCleanControlCaseFalsePositiveRate", "maximumDuplicateRate", "minimumLaneCompleteRate", "maximumPublicationFallbackRate"]), "gate thresholds schema");
	for (const [key, value] of Object.entries(t)) invariant(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, `gate threshold ${key}`);
	const failures = [], checkMin = (label, actual, expected) => { if (actual === null || actual < expected) failures.push(`${label} ${actual ?? "n/a"} < ${expected}`); }, checkMax = (label, actual, expected) => { if (actual === null || actual > expected) failures.push(`${label} ${actual ?? "n/a"} > ${expected}`); };
	checkMin("P0/P1 recall", metrics.overall.p0p1.recall, t.minimumP0P1Recall); checkMin("P2 recall", metrics.overall.p2.recall, t.minimumP2Recall); checkMin("cross-file recall", metrics.overall.crossFile.recall, t.minimumCrossFileRecall); checkMax("clean-control false-positive rate", metrics.overall.cleanControls.caseFalsePositiveRate, t.maximumCleanControlCaseFalsePositiveRate); checkMax("duplicate rate", metrics.overall.findings.duplicateRate, t.maximumDuplicateRate); checkMin("lane complete rate", metrics.overall.lanes.completeRate, t.minimumLaneCompleteRate); checkMax("publication fallback rate", metrics.overall.publication.fallbackRate, t.maximumPublicationFallbackRate);
	return { status: failures.length === 0 ? "passed" : "failed", passed: failures.length === 0, failures };
}

export function scoreBundle({ corpusInfo, plan, resultsDirectory, gates = null }) {
	validatePlan(plan, corpusInfo);
	const bundleRoot = fs.realpathSync(path.resolve(resultsDirectory)), runDir = path.join(bundleRoot, "runs");
	invariant(fs.lstatSync(runDir).isDirectory(), "result bundle requires runs/ directory");
	const files = fs.readdirSync(runDir, { withFileTypes: true });
	invariant(files.every((entry) => entry.isFile() && entry.name.endsWith(".json")), "runs/ may contain only JSON files");
	const entryById = new Map(plan.entries.map((entry) => [entry.entryId, entry])), seen = new Set(), runs = [];
	for (const entry of files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
		const run = readJson(path.join(runDir, entry.name)).value, planEntry = entryById.get(run?.planEntryId);
		invariant(planEntry && !seen.has(planEntry.entryId), `unknown or duplicate plan entry in ${entry.name}`); seen.add(planEntry.entryId);
		runs.push(validateRun(run, planEntry, bundleRoot));
	}
	invariant(runs.length === plan.entries.length, `result bundle is incomplete: ${runs.length}/${plan.entries.length} runs`);
	const metrics = aggregateScores(corpusInfo, plan, runs), gate = evaluateGates(metrics, gates, corpusInfo);
	return { schemaVersion: 1, corpusId: corpusInfo.corpus.corpusId, corpusSha256: corpusInfo.sha256, planId: plan.planId, resultCount: runs.length, gate, metrics };
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	invariant(command === "plan" || command === "score", "command must be plan or score");
	const options = {};
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index], value = rest[index + 1];
		invariant(/^--[a-z-]+$/.test(key ?? "") && value !== undefined && !value.startsWith("--") && options[key] === undefined, `invalid argument near ${key ?? "end"}`);
		options[key] = value;
	}
	const allowed = command === "plan" ? new Set(["--corpus", "--modes", "--repetitions", "--output"]) : new Set(["--corpus", "--plan", "--results", "--output", "--gates"]);
	invariant(Object.keys(options).every((key) => allowed.has(key)), "unknown argument");
	for (const required of command === "plan" ? ["--corpus", "--modes", "--repetitions", "--output"] : ["--corpus", "--plan", "--results", "--output"]) invariant(options[required] !== undefined, `missing ${required}`);
	return { command, options };
}
function writeExclusive(file, value) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2)), corpusInfo = loadCorpus(options["--corpus"]);
	if (command === "plan") {
		const repetitions = Number(options["--repetitions"]), modes = options["--modes"].split(",");
		const plan = createPlan(corpusInfo, modes, repetitions); writeExclusive(options["--output"], plan);
		console.log(`Wrote ${plan.entries.length}-run semantic benchmark plan ${plan.planId}.`); return;
	}
	const plan = readJson(path.resolve(options["--plan"])).value, gates = options["--gates"] ? readJson(path.resolve(options["--gates"])).value : null;
	const report = scoreBundle({ corpusInfo, plan, resultsDirectory: options["--results"], gates }); writeExclusive(options["--output"], report);
	console.log(`Scored ${report.resultCount} runs; gate ${report.gate.status}.`);
	if (report.gate.status === "failed") process.exitCode = 1;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
