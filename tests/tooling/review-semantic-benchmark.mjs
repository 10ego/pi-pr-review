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
const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 });
const LANE_STATES = new Set(["complete", "partial", "timed_out", "failed"]);
const PUBLICATION_ARTIFACTS = new Set(["canonical", "degraded", "raw_body_only"]);
const GATE_INELIGIBLE_CORPORA = new Set(["pi-pr-review-semantic-v5"]);
const MODE_TOPOLOGIES = Object.freeze({
	balanced: { passIds: ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 5 },
	full: { passIds: ["overview", "conventions-maintainability", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 6 },
	"major-only": { passIds: ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 5 },
	deep: { passIds: ["deep-review"], maxParallel: 1 },
});
const PASS_LENSES = Object.freeze({ overview: "overview", "conventions-maintainability": "conventions-maintainability", correctness: "correctness", "correctness-contracts": "correctness-contracts", "security-performance": "security-performance", "performance-resources": "performance-resources", "deep-review": "deep-review" });
const EXPLICIT_NON_FINDING = [
	/\bno (?:issue|finding|bug|defect|problem)(?: exists| here| with this)?\b/iu,
	/\b(?:is|are|remains?|appears?) (?:safe|correct|valid)\b/iu,
	/\bnot (?:broken|a bug|an issue|a problem|a defect)\b/iu,
	/\bfalse positive\b/iu,
	/\b(?:needs?|requires?) no (?:change|fix)\b/iu,
	/\bno changes? (?:are|is) (?:needed|required)\b/iu,
	/\b(?:cannot|can not|could not|does not) (?:be )?(?:abused|exploited|triggered)\b/iu,
	/\b(?:breakage|exploitation|failure|injection|issue|vulnerability) (?:is|are) (?:absent|impossible|not possible)\b/iu,
	/\bpresents? no risk\b/iu,
	/\b(?:branch|input) (?:is|are) (?:already )?(?:escaped|quoted|sanitized|validated).{0,80}\b(?:eliminat(?:e|es|ing)|mitigat(?:e|es|ing)|prevent(?:s|ed|ing)?)\b/iu,
];
const MULTIPLICATIVE_COMPLEXITY = /\bO\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s*[×*]\s*[\p{L}_][\p{L}\p{N}_]*|[\p{L}_][\p{L}\p{N}_]*\s*(?:\^\s*2|²))\s*\)/iu;
const DEFECT_CUE = /\b(?:accumulat(?:e|es|ing|ion)|arbitrary|attack|break(?:s|ing)?|broken|crash(?:es)?|defect|disclos(?:e|es|ure)|duplicat(?:e|es|ing|ion)|enable[sd]?|error|exploit|fail(?:s|ure)?|incorrect|invalid|inject(?:ion)?|leak|missing|quadratic|regression|removed|retain(?:s|ed|ing)|retention|throws?|unauthori[sz]ed|violat(?:e|es|ion)|vulnerab(?:le|ility))\b|passes? (?:the )?(?:cached )?object.{0,40}JSON\.parse|(?:guard|check|validation).{0,30}does not (?:block|fail|reject)|\bO\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s*[×*]\s*[\p{L}_][\p{L}\p{N}_]*|[\p{L}_][\p{L}\p{N}_]*\s*(?:\^\s*2|²))\s*\)/iu;
function expandNegations(text) {
	const replacements = { "can't": "cannot", "can’t": "cannot", "couldn't": "could not", "couldn’t": "could not", "doesn't": "does not", "doesn’t": "does not", "isn't": "is not", "isn’t": "is not", "aren't": "are not", "aren’t": "are not", "wasn't": "was not", "wasn’t": "was not", "weren't": "were not", "weren’t": "were not", "won't": "will not", "won’t": "will not" };
	Object.assign(replacements, { "don't": "do not", "don’t": "do not", "hasn't": "has not", "hasn’t": "has not", "haven't": "have not", "haven’t": "have not", "hadn't": "had not", "hadn’t": "had not", "didn't": "did not", "didn’t": "did not", "shouldn't": "should not", "shouldn’t": "should not", "wouldn't": "would not", "wouldn’t": "would not", "mustn't": "must not", "mustn’t": "must not", "mightn't": "might not", "mightn’t": "might not", "needn't": "need not", "needn’t": "need not" });
	return text.replace(/\b(?:can[’']t|couldn[’']t|doesn[’']t|isn[’']t|aren[’']t|wasn[’']t|weren[’']t|won[’']t|don[’']t|hasn[’']t|haven[’']t|hadn[’']t|didn[’']t|shouldn[’']t|wouldn[’']t|mustn[’']t|mightn[’']t|needn[’']t)\b/giu, (match) => replacements[match.toLocaleLowerCase("en-US")]);
}
function hasPositiveDefectCue(text) {
	text = expandNegations(text);
	for (const match of text.matchAll(new RegExp(DEFECT_CUE.source, "giu"))) {
		const start = match.index ?? 0, end = start + match[0].length, before = text.slice(Math.max(0, start - 40), start), localBefore = before.split(/[,;:]|\b(?:and|but|while|yet)\b/iu).at(-1) ?? before, after = text.slice(end, Math.min(text.length, end + 40));
		if (/(?:\b(?:addressed|addresses|cannot|eliminates|fixed|fixes|never|no|not|prevents|remediated|removes|resolved|resolves|without)\b|does not|rather than (?:an? )?|\b(?:fix|guard|patch)\s+(?:addresses|eliminates|fixes|prevents|removes|resolves)\b|\b(?:eliminat(?:e|es|ing)|mitigat(?:e|es|ing)|prevent(?:s|ed|ing)?)\b)\s*[^.!?\n]{0,30}$/iu.test(localBefore)) continue;
		if (/^[^.!?\n]{0,30}(?:\b(?:absent|acceptable|addressed|eliminated|fixed|impossible|mitigated|not possible|prevented|remediated|resolved|safe)\b|\bremoved by (?:this )?(?:change|fix|patch)\b|\bby (?:this )?(?:change|fix|patch)\b)/iu.test(after)) continue;
		return true;
	}
	return false;
}
const SHA256 = /^[0-9a-f]{64}$/;
export const SCORER_SHA256 = sha256(fs.readFileSync(new URL(import.meta.url)));
const SEMANTIC_FINDINGS = Symbol("semanticFindings");
const FALLBACK_FINDING_LIMIT = 50;

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
	const files = [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => {
		invariant(match[1] === match[2], `rename diffs are not supported in corpus: ${match[1]} -> ${match[2]}`);
		return match[1];
	});
	const lines = text.split("\n"); let hunks = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
		if (!match) continue;
		hunks++; let oldCount = 0, newCount = 0; index++;
		for (; index < lines.length && !lines[index].startsWith("diff --git ") && !lines[index].startsWith("@@ "); index++) {
			const line = lines[index];
			if (line === "" && index === lines.length - 1) break;
			if (line.startsWith("\\ No newline at end of file")) continue;
			invariant(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"), `malformed unified diff line: ${line}`);
			if (!line.startsWith("+")) oldCount++;
			if (!line.startsWith("-")) newCount++;
		}
		index--;
		const expectedOld = match[2] === undefined ? 1 : Number(match[2]), expectedNew = match[4] === undefined ? 1 : Number(match[4]);
		invariant(oldCount === expectedOld && newCount === expectedNew, `unified diff hunk count mismatch: expected ${expectedOld}/${expectedNew}, got ${oldCount}/${newCount}`);
	}
	invariant(files.length > 0 && hunks >= files.length, "corpus diff must contain at least one hunk per changed file");
	return files;
}
function changedDiffLines(text) {
	const changed = new Map(); let file = null, oldLine = 0, newLine = 0;
	for (const line of text.split("\n")) {
		const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line); if (fileMatch) { file = fileMatch[1]; changed.set(file, { LEFT: new Set(), RIGHT: new Set() }); continue; }
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line); if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
		if (!file || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ") || line.startsWith("\\ No newline")) continue;
		if (line.startsWith("-")) { changed.get(file).LEFT.add(oldLine); oldLine++; } else if (line.startsWith("+")) { changed.get(file).RIGHT.add(newLine); newLine++; } else if (line.startsWith(" ")) { oldLine++; newLine++; }
	}
	return changed;
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
		invariant(exactKeys(item, ["id", "title", "diff", "diffSha256", "diffBytes", "changedFiles", "cleanControl", "crossFile", "expectedFindings"]), "case schema");
		invariant(typeof item.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && !ids.has(item.id), `case id ${item.id}`); ids.add(item.id);
		invariant(typeof item.title === "string" && item.title.length >= 8 && item.title.length <= 120, `case ${item.id} title`);
		invariant(typeof item.cleanControl === "boolean" && typeof item.crossFile === "boolean", `case ${item.id} flags`);
		invariant(Array.isArray(item.changedFiles) && item.changedFiles.length > 0 && new Set(item.changedFiles).size === item.changedFiles.length, `case ${item.id} changedFiles`);
		item.changedFiles.forEach((filePath) => safeRelative(filePath, `case ${item.id} changed file`));
		const diffFile = resolveContainedRegular(root, item.diff, `case ${item.id} diff`), diffBytes = fs.readFileSync(diffFile), diffText = diffBytes.toString("utf8"), changedLines = changedDiffLines(diffText);
		invariant(SHA256.test(item.diffSha256) && sha256(diffBytes) === item.diffSha256 && Number.isSafeInteger(item.diffBytes) && item.diffBytes === diffBytes.length, `case ${item.id} diff hash/bytes`);
		invariant(diffText.length > 0 && !diffText.includes(item.id), `case ${item.id} reviewer-visible diff leaks its benchmark id`);
		invariant(JSON.stringify(parseDiffFiles(diffText)) === JSON.stringify(item.changedFiles), `case ${item.id} changedFiles differ from diff`);
		invariant(Array.isArray(item.expectedFindings), `case ${item.id} expectedFindings`);
		invariant(item.cleanControl === (item.expectedFindings.length === 0), `case ${item.id} clean-control partition`);
		if (item.cleanControl) cleanControls++;
		for (const expected of item.expectedFindings) {
			invariant(exactKeys(expected, ["id", "targetSeverity", "allowedSeverities", "acceptableLocations", "rationale", "lenses", "blocking", "crossFile", "requiredConcepts", "assertionPatterns", "contradictionPatterns"]), `expected finding schema in ${item.id}`);
			invariant(typeof expected.id === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(expected.id) && !expectedIds.has(expected.id), `expected finding id ${expected.id}`); expectedIds.add(expected.id);
			invariant(SEVERITIES.has(expected.targetSeverity) && Array.isArray(expected.allowedSeverities) && expected.allowedSeverities.length > 0 && new Set(expected.allowedSeverities).size === expected.allowedSeverities.length && expected.allowedSeverities.includes(expected.targetSeverity) && expected.allowedSeverities.every((severity) => SEVERITIES.has(severity)), `expected ${expected.id} severities`);
			invariant(typeof expected.blocking === "boolean" && typeof expected.crossFile === "boolean" && typeof expected.rationale === "string" && expected.rationale.length >= 20, `expected ${expected.id} metadata`);
			invariant(expected.blocking === (expected.targetSeverity === "P0" || expected.targetSeverity === "P1"), `expected ${expected.id} blocking policy`);
			invariant(Array.isArray(expected.lenses) && expected.lenses.length > 0 && expected.lenses.every((lens) => value.lenses.includes(lens)), `expected ${expected.id} lenses`);
			invariant(Array.isArray(expected.requiredConcepts) && expected.requiredConcepts.length > 0 && expected.requiredConcepts.every((group) => Array.isArray(group) && group.length > 0 && group.every((term) => typeof term === "string" && term.length > 0)), `expected ${expected.id} concepts`);
			const validPattern = (pattern) => { if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 500) return false; try { new RegExp(pattern, "iu"); return true; } catch { return false; } };
			invariant(Array.isArray(expected.assertionPatterns) && expected.assertionPatterns.length > 0 && expected.assertionPatterns.every((group) => Array.isArray(group) && group.length > 0 && group.every(validPattern)), `expected ${expected.id} assertion patterns`);
			invariant(Array.isArray(expected.contradictionPatterns) && expected.contradictionPatterns.length > 0 && expected.contradictionPatterns.every(validPattern), `expected ${expected.id} contradiction patterns`);
			invariant(Array.isArray(expected.acceptableLocations) && expected.acceptableLocations.length > 0, `expected ${expected.id} locations`);
			for (const location of expected.acceptableLocations) {
				invariant(exactKeys(location, ["path", "side", "start", "end"]), `expected ${expected.id} location schema`);
				safeRelative(location.path, `expected ${expected.id} location`);
				invariant(item.changedFiles.includes(location.path) && (location.side === "RIGHT" || location.side === "LEFT") && Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) && location.start > 0 && location.end >= location.start && [...changedLines.get(location.path)[location.side]].some((line) => line >= location.start && line <= location.end), `expected ${expected.id} location must overlap a changed line`);
			}
			if (expected.crossFile) crossFileExpected++;
		}
	}
	invariant(cleanControls >= 2, "corpus requires at least two clean controls");
	invariant(crossFileExpected >= 1, "corpus requires cross-file expected findings");
	for (const lens of value.lenses) invariant(value.cases.some((item) => item.expectedFindings.some((finding) => finding.lenses.includes(lens))), `lens ${lens} has no seeded finding`);
	return { corpus: value, corpusFile, root, sha256: sha256(bytes), bytes: bytes.length };
}

export function validatePlan(plan, corpusInfo) {
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

export function expectedModeTopology(mode, item) {
	invariant(MODES.has(mode), `unknown mode ${mode}`);
	invariant(item && Number.isSafeInteger(item.diffBytes) && Array.isArray(item.changedFiles), "topology requires a validated corpus case");
	const base = MODE_TOPOLOGIES[mode], shardCount = mode === "deep" ? 1 : item.diffBytes >= 400_000 && item.changedFiles.length >= 3 ? 3 : item.diffBytes >= 200_000 && item.changedFiles.length >= 2 ? 2 : 1;
	const passIds = shardCount === 1 ? [...base.passIds] : base.passIds.flatMap((id) => Array.from({ length: shardCount }, (_, index) => `${id}-shard-${index + 1}`));
	return { passIds, shardCount, maxParallel: base.maxParallel * shardCount };
}

export function createPlan(corpusInfo, modes, repetitions) {
	invariant(Array.isArray(modes) && modes.length > 0 && new Set(modes).size === modes.length && modes.every((mode) => MODES.has(mode)), "requested modes");
	invariant(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 100, "requested repetitions");
	const entries = [];
	// Interleave modes per case and rotate the first mode across repetitions/cases.
	// This avoids running an entire mode during one provider/time window.
	for (let repetition = 1; repetition <= repetitions; repetition++) for (let caseIndex = 0; caseIndex < corpusInfo.corpus.cases.length; caseIndex++) {
		const item = corpusInfo.corpus.cases[caseIndex], offset = (repetition - 1 + caseIndex) % modes.length;
		for (let modeIndex = 0; modeIndex < modes.length; modeIndex++) {
			const mode = modes[(offset + modeIndex) % modes.length], key = `${corpusInfo.sha256}\0${mode}\0${repetition}\0${item.id}`;
			entries.push({ entryId: sha256(Buffer.from(key)).slice(0, 24), caseId: item.id, mode, repetition });
		}
	}
	const identity = { schemaVersion: 1, corpusId: corpusInfo.corpus.corpusId, corpusSha256: corpusInfo.sha256, modes, repetitions, entries };
	return { ...identity, planId: sha256(Buffer.from(canonical(identity))) };
}

function validateArtifact(reference, bundleRoot, run) {
	const runLabel = `run ${run.planEntryId}`;
	invariant(exactKeys(reference, ["kind", "path", "sha256", "bytes"]), `${runLabel} artifact schema`);
	invariant(reference.kind === "lane-artifacts" || reference.kind === "canonical-review", `${runLabel} artifact kind`);
	invariant(SHA256.test(reference.sha256) && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= 100 * 1024 * 1024, `${runLabel} artifact metadata`);
	const file = resolveContainedRegular(bundleRoot, reference.path, `${runLabel} artifact`), data = fs.readFileSync(file);
	invariant(data.length === reference.bytes && sha256(data) === reference.sha256, `${runLabel} artifact bytes/hash`);
	let payload; try { payload = JSON.parse(data.toString("utf8")); } catch { invariant(false, `${runLabel} artifact JSON`); }
	if (reference.kind === "lane-artifacts") {
		const raw = payload?.raw;
		invariant(exactKeys(payload, ["schemaVersion", "planEntryId", "lanes", "raw"]) && payload.schemaVersion === 1 && payload.planEntryId === run.planEntryId && canonical(payload.lanes) === canonical(run.lanes) && exactKeys(raw, ["laneArtifacts", "telemetry", "resolvedReview", "ghAudit", "auditValid", "process", "session"]), `${runLabel} lane artifact binding`);
		invariant(Array.isArray(raw.laneArtifacts) && (raw.telemetry === null || plain(raw.telemetry)) && (raw.resolvedReview === null || plain(raw.resolvedReview)) && Array.isArray(raw.ghAudit) && typeof raw.auditValid === "boolean" && raw.auditValid === (raw.ghAudit.length > 0 && raw.ghAudit.every((record) => plain(record) && record.allowed === true && record.write === false)), `${runLabel} raw lane/audit evidence`);
		invariant(exactKeys(raw.process, ["stdout", "stderr", "exitCode", "signal", "error"], ["elapsedMs"]) && typeof raw.process.stdout === "string" && typeof raw.process.stderr === "string" && (raw.process.exitCode === null || Number.isInteger(raw.process.exitCode)) && (raw.process.signal === null || typeof raw.process.signal === "string") && (raw.process.error === null || typeof raw.process.error === "string") && (!Object.hasOwn(raw.process, "elapsedMs") || finiteNonnegative(raw.process.elapsedMs)), `${runLabel} raw process evidence`);
		invariant(exactKeys(raw.session, ["sha256", "bytes", "recordCount", "contentBase64"]) && (raw.session.sha256 === null || SHA256.test(raw.session.sha256)) && Number.isSafeInteger(raw.session.bytes) && raw.session.bytes >= 0 && Number.isSafeInteger(raw.session.recordCount) && raw.session.recordCount >= 0 && (raw.session.bytes === 0) === (raw.session.sha256 === null) && (raw.session.contentBase64 === null) === (raw.session.bytes === 0), `${runLabel} raw session evidence`);
		if (raw.session.contentBase64 !== null) { const sessionBytes = Buffer.from(raw.session.contentBase64, "base64"); invariant(sessionBytes.toString("base64") === raw.session.contentBase64 && sessionBytes.length === raw.session.bytes && sha256(sessionBytes) === raw.session.sha256 && sessionBytes.toString("utf8").split("\n").filter(Boolean).length === raw.session.recordCount, `${runLabel} retained session bytes`); }
		const normalized = new Map(run.lanes.map((lane) => [lane.id, lane])), expectedRawIds = new Set();
		for (const lane of raw.laneArtifacts) { invariant(plain(lane) && typeof lane.passId === "string" && lane.passId.length > 0 && LANE_STATES.has(lane.lifecycle), `${runLabel} raw lane lifecycle binding`); const target = normalized.get(lane.passId); if (target) { invariant(!expectedRawIds.has(lane.passId) && lane.lifecycle === target.status, `${runLabel} raw lane lifecycle binding`); expectedRawIds.add(lane.passId); } }
		invariant(run.lanes.every((lane) => lane.status === "failed" || expectedRawIds.has(lane.id)), `${runLabel} normalized non-failed lane lacks raw evidence`);
		invariant(raw.laneArtifacts.length > 0 || raw.process.stdout.length > 0 || raw.process.stderr.length > 0 || raw.session.bytes > 0 || raw.process.exitCode !== null && raw.process.exitCode !== 0 || raw.process.signal !== null || raw.process.error !== null, `${runLabel} raw evidence is empty`);
	} else {
		invariant(exactKeys(payload, ["schemaVersion", "planEntryId", "publication", "findings", "markdown"]) && payload.schemaVersion === 1 && payload.planEntryId === run.planEntryId && canonical(payload.publication) === canonical(run.publication) && canonical(payload.findings) === canonical(run.findings) && typeof payload.markdown === "string" && payload.markdown.trim().length > 0 && run.findings.every((finding) => payload.markdown.includes(finding.title)), `${runLabel} canonical artifact binding`);
	}
	return payload;
}
function normalizePersistedFindings(review) {
	if (!Array.isArray(review?.findings)) return [];
	return review.findings.map((finding) => { const location = finding?.code_location, range = location?.line_range; return { title: String(finding?.title ?? ""), body: String(finding?.body ?? ""), severity: String(finding?.severity ?? ""), location: location && typeof location.absolute_file_path === "string" && Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) && (location.side === "RIGHT" || location.side === "LEFT") ? { path: location.absolute_file_path, side: location.side, start: range.start, end: range.end } : null }; });
}
function parseVisibleFallbackFindings(markdown) {
	if (typeof markdown !== "string" || markdown.length > 2 * 1024 * 1024) return [];
	// Fail closed rather than mistake headings inside CommonMark containers for
	// visible findings. Fallbacks containing fenced or raw-HTML blocks remain
	// measured as fallbacks but contribute no recovered semantic candidates.
	if (/^ {0,3}(?:`{3,}|~{3,}|<)/mu.test(markdown)) return [];
	const headings = [...markdown.matchAll(/^## Findings\s*$/gmu)];
	if (headings.length !== 1) return [];
	const findings = [], section = /(?:^|\n)## Findings\s*\n([\s\S]*?)(?=\n## (?!#)|$)/u.exec(markdown)?.[1] ?? "";
	const candidate = /^### \[(P0|P1|P2|P3|nit)\] ([^\n]{1,300})\n([\s\S]*?)(?=^### \[|(?![\s\S]))/gmu;
	for (const match of section.matchAll(candidate)) {
		if (findings.length >= FALLBACK_FINDING_LIMIT) return [];
		const severity = match[1], block = match[3], labels = [...block.matchAll(/^\*\*(Severity|Rationale|Location):\*\*/gmu)], expectedLabels = labels.length === 2 ? ["Severity", "Rationale"] : labels.length === 3 ? ["Severity", "Rationale", "Location"] : [];
		if (expectedLabels.length === 0 || labels.some((label, index) => label[1] !== expectedLabels[index])) continue;
		const severityMatch = /^\*\*Severity:\*\* (P0|P1|P2|P3|nit)\s*$/mu.exec(block), rationaleMatch = /^\*\*Rationale:\*\* ([\s\S]*?)(?=^\*\*Location:\*\*|(?![\s\S]))/mu.exec(block), locationMatch = expectedLabels.length === 3 ? /^\*\*Location:\*\* `([^`\n]+)`\s*$/mu.exec(block) : null;
		if (!severityMatch || !rationaleMatch || severityMatch[1] !== severity || severityMatch.index !== labels[0].index || rationaleMatch.index !== labels[1].index || (expectedLabels.length === 3 && (!locationMatch || locationMatch.index !== labels[2].index || block.slice(locationMatch.index + locationMatch[0].length).trim() !== ""))) continue;
		const rationale = rationaleMatch[1].trim();
		if (!rationale || rationale.length > 20_000) continue;
		let location = null;
		if (locationMatch) {
			const parsed = /^(.*):(\d+)(?:-(\d+))? (RIGHT|LEFT)$/u.exec(locationMatch[1]);
			if (!parsed) continue;
			const start = Number(parsed[2]), end = Number(parsed[3] ?? parsed[2]), file = parsed[1];
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end > 10_000_000 || file.length === 0 || file.length > 300 || file.includes("\\") || path.posix.isAbsolute(file) || file.split("/").some((part) => part === "" || part === "." || part === "..")) continue;
			location = { path: file, side: parsed[4], start, end };
		}
		findings.push({ title: `[${severity}] ${match[2]}`, body: rationale, severity, location });
	}
	return findings;
}
function splitModelSpec(value) { if (typeof value !== "string" || !value.includes("/")) return null; const index = value.indexOf("/"); return { provider: value.slice(0, index), model: value.slice(index + 1).replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") }; }
export function resolvedTierModelIdentities(config, tier, parentModel) {
	const order = { light: ["light", "medium", "heavy"], medium: ["medium", "heavy", "light"], heavy: ["heavy", "medium", "light"] }, specs = [], primary = config.tiers?.[tier];
	if (typeof primary === "string" && primary.length > 0) specs.push(primary); else { const nearest = order[tier].map((candidate) => config.tiers?.[candidate]).find((spec) => typeof spec === "string" && spec.length > 0); specs.push(nearest ?? parentModel); }
	if (Array.isArray(config.fallbacks?.[tier])) specs.push(...config.fallbacks[tier]);
	const seen = new Set(); return specs.map(splitModelSpec).filter((identity) => identity && !seen.has(`${identity.provider}\0${identity.model}`) && seen.add(`${identity.provider}\0${identity.model}`));
}
function normalizeRawLane(lane, parentModel) { const attempts = Array.isArray(lane?.attempts) ? lane.attempts : [], attempt = [...attempts].reverse().find((candidate) => typeof candidate?.observedModel === "string"), observed = lane?.observedModel ?? attempt?.observedModel, requested = attempt?.requestedModel ?? lane?.requestedModel ?? parentModel, requestedIdentity = splitModelSpec(requested), identity = splitModelSpec(observed) ?? (typeof observed === "string" && observed.length > 0 && requestedIdentity ? { provider: requestedIdentity.provider, model: observed } : null); let elapsedMs = null; if (Number.isFinite(lane?.startOffsetMs) && Number.isFinite(lane?.endOffsetMs)) elapsedMs = Math.max(0, lane.endOffsetMs - lane.startOffsetMs); else { const timed = attempts.filter((attempt) => Number.isFinite(attempt?.elapsedMs)); if (timed.length > 0) elapsedMs = timed.reduce((sum, attempt) => sum + attempt.elapsedMs, 0); } return { id: lane?.passId, lens: String(lane?.passId ?? "").replace(/-shard-[123]$/, ""), status: ["complete", "partial", "timed_out", "failed"].includes(lane?.lifecycle) ? lane.lifecycle : "failed", elapsedMs, provider: identity?.provider ?? null, model: identity?.model ?? null }; }
function validateSessionBindings(lanePayload, reviewPayload, run, label, effectiveConfig) {
	const raw = lanePayload.raw, sessionBytes = raw.session.contentBase64 === null ? null : Buffer.from(raw.session.contentBase64, "base64"), records = sessionBytes ? sessionBytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [], completed = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-completed"), telemetry = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-telemetry" && record.data?.completion === "terminal_response"), processFailed = raw.process.exitCode !== null && raw.process.exitCode !== 0 || raw.process.signal !== null || raw.process.error !== null, failedRun = run.publication.artifact === "raw_body_only" && run.findings.length === 0 && run.lanes.every((lane) => lane.status === "failed") && raw.resolvedReview === null && raw.telemetry === null;
	if (!failedRun) {
		invariant(raw.process.exitCode === 0 && !processFailed && raw.auditValid, `${label} successful run has operational failure`);
		invariant(completed.length === 1 && telemetry.length === 1, `${label} session completion/telemetry cardinality`);
		const headers = records.filter((record) => record?.type === "session" && record.version === 3), assistants = records.filter((record) => record?.type === "message" && record.message?.role === "assistant");
		invariant(headers.length === 1 && typeof headers[0].cwd === "string" && path.isAbsolute(headers[0].cwd) && assistants.length > 0 && assistants.at(-1).message?.stopReason === "stop", `${label} retained session lifecycle`);
		const terminalAssistantText = Array.isArray(assistants.at(-1).message?.content) ? assistants.at(-1).message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "", data = completed[0].data, terminalTelemetry = telemetry[0].data, modelChanges = records.filter((record) => record?.type === "model_change"), thinkingChanges = records.filter((record) => record?.type === "thinking_level_change");
		invariant(terminalAssistantText.length > 0 && plain(data) && canonical(data.laneArtifacts) === canonical(raw.laneArtifacts) && canonical(terminalTelemetry) === canonical(raw.telemetry) && data.rawText === terminalAssistantText && data.rawText === reviewPayload.markdown, `${label} session artifact binding`);
		invariant(finiteNonnegative(terminalTelemetry?.totalWallMs) && terminalTelemetry.totalWallMs === run.elapsedMs && finiteNonnegative(terminalTelemetry?.phases?.aggregateOrchestration?.elapsedMs) && terminalTelemetry.phases.aggregateOrchestration.elapsedMs === run.timing.parentValidationSynthesisMs && terminalTelemetry.phases.aggregateOrchestration.elapsedMs <= terminalTelemetry.totalWallMs, `${label} retained latency binding`);
		invariant(modelChanges.length >= 1 && modelChanges.at(-1).provider === run.configuration.provider && modelChanges.at(-1).modelId === run.configuration.model && thinkingChanges.length >= 1 && thinkingChanges.at(-1).thinkingLevel === run.configuration.thinking, `${label} session parent model/thinking binding`);
		const canonicalPublication = data.synthesisQuality === "fully_parsed" && data.completeness === "complete" && run.lanes.every((lane) => lane.status === "complete"), rawPublication = data.synthesisQuality === "raw";
		invariant(run.publication.artifact === (canonicalPublication ? "canonical" : rawPublication ? "raw_body_only" : "degraded"), `${label} session publication binding`);
		invariant(plain(raw.resolvedReview) && canonical(normalizePersistedFindings(raw.resolvedReview)) === canonical(run.findings), `${label} resolved finding binding`);
		if (plain(data.review)) invariant(canonical(data.review) === canonical(raw.resolvedReview), `${label} persisted/resolved review binding`);
		const rawById = new Map(raw.laneArtifacts.map((lane) => [lane.passId, normalizeRawLane(lane, `${run.configuration.provider}/${run.configuration.model}`)])); for (const lane of run.lanes) if (rawById.has(lane.id)) { invariant(canonical(rawById.get(lane.id)) === canonical(lane), `${label} normalized raw lane binding`); const base = lane.id.replace(/-shard-[123]$/, ""), tier = base === "overview" ? "light" : base === "conventions-maintainability" ? "medium" : "heavy", configured = resolvedTierModelIdentities(effectiveConfig, tier, `${run.configuration.provider}/${run.configuration.model}`); if (lane.provider !== null && lane.model !== null) invariant(configured.some((identity) => identity.provider === lane.provider && identity.model === lane.model), `${label} lane model is outside effective config`); }
	} else {
		invariant(raw.resolvedReview === null && raw.telemetry === null && run.timing.parentValidationSynthesisMs === run.elapsedMs && (processFailed || !raw.auditValid || completed.length !== 1 || telemetry.length !== 1), `${label} failed-session binding`);
		const hasProcessElapsed = Object.hasOwn(raw.process, "elapsedMs");
		let latencyBound = hasProcessElapsed && run.elapsedMs > 0 && raw.process.elapsedMs > 0 && raw.process.elapsedMs === run.elapsedMs;
		if (hasProcessElapsed) invariant(latencyBound, `${label} authoritative failed-run process latency binding`);
		if (!hasProcessElapsed && raw.process.error === "collector-hard-timeout") {
			const totalMs = effectiveConfig?.deadlines?.totalMs, hardTimeoutMs = Number.isSafeInteger(totalMs) && totalMs >= 120_000 && totalMs <= 1_200_000 ? totalMs + 30_000 : null;
			latencyBound = hardTimeoutMs !== null && run.elapsedMs > 0 && run.elapsedMs >= hardTimeoutMs - 1_000 && run.elapsedMs <= hardTimeoutMs + 10_000;
		}
		if (!hasProcessElapsed && !latencyBound) {
			const timestamps = records.map((record) => Date.parse(record?.timestamp)).filter(Number.isFinite);
			if (timestamps.length >= 2) { const sessionSpanMs = Math.max(...timestamps) - Math.min(...timestamps); latencyBound = sessionSpanMs > 0 && run.elapsedMs > 0 && run.elapsedMs >= sessionSpanMs && run.elapsedMs <= sessionSpanMs + 5_000; }
		}
		invariant(latencyBound, `${label} retained failed-run latency binding`);
	}
}

function validateRun(run, planEntry, bundleRoot, item, effectiveConfig) {
	const label = `run ${planEntry.entryId}`;
	invariant(exactKeys(run, ["schemaVersion", "planEntryId", "caseId", "mode", "repetition", "startedAtUtc", "elapsedMs", "timing", "configuration", "lanes", "publication", "findings", "artifacts"]), `${label} schema`);
	invariant(run.schemaVersion === 1 && run.planEntryId === planEntry.entryId && run.caseId === planEntry.caseId && run.mode === planEntry.mode && run.repetition === planEntry.repetition, `${label} plan binding`);
	invariant(typeof run.startedAtUtc === "string" && Number.isFinite(Date.parse(run.startedAtUtc)), `${label} timestamp`);
	invariant(finiteNonnegative(run.elapsedMs), `${label} elapsedMs`);
	invariant(exactKeys(run.timing, ["parentValidationSynthesisMs"]) && finiteNonnegative(run.timing.parentValidationSynthesisMs), `${label} parent timing`);
	invariant(exactKeys(run.configuration, ["provider", "model", "thinking", "toolPolicy", "reviewVersion", "piVersion", "piSha256", "piRuntimeSha256", "nodeVersion", "nodeSha256", "collectorRuntimeVersion", "collectorRuntimeSha256", "reviewConfigSha256", "extensionSha256", "promptSha256", "collectorSha256", "topology"]), `${label} configuration schema`);
	for (const key of ["provider", "model", "thinking", "toolPolicy", "reviewVersion", "piVersion", "nodeVersion", "collectorRuntimeVersion"]) invariant(typeof run.configuration[key] === "string" && run.configuration[key].length > 0 && run.configuration[key].length <= 200, `${label} configuration ${key}`);
	for (const key of ["piSha256", "piRuntimeSha256", "nodeSha256", "collectorRuntimeSha256", "reviewConfigSha256", "extensionSha256", "promptSha256", "collectorSha256"]) invariant(typeof run.configuration[key] === "string" && SHA256.test(run.configuration[key]), `${label} configuration ${key}`);
	const topology = run.configuration.topology, expectedTopology = expectedModeTopology(run.mode, item);
	invariant(exactKeys(topology, ["passIds", "shardCount", "maxParallel"]) && Array.isArray(topology.passIds) && topology.passIds.length > 0 && topology.passIds.every((id) => typeof id === "string" && id.length > 0) && Number.isSafeInteger(topology.shardCount) && topology.shardCount >= 1 && topology.shardCount <= 20 && Number.isSafeInteger(topology.maxParallel) && topology.maxParallel >= 1 && topology.maxParallel <= 100, `${label} topology`);
	invariant(JSON.stringify(topology.passIds) === JSON.stringify(expectedTopology.passIds) && topology.shardCount === expectedTopology.shardCount && topology.maxParallel === expectedTopology.maxParallel, `${label} topology does not match ${run.mode}`);
	invariant(Array.isArray(run.lanes) && run.lanes.length > 0, `${label} lanes`);
	const laneIds = new Set();
	for (const lane of run.lanes) {
		invariant(exactKeys(lane, ["id", "lens", "status", "elapsedMs", "provider", "model"]), `${label} lane schema`);
		invariant(typeof lane.id === "string" && lane.id.length > 0 && !laneIds.has(lane.id), `${label} lane id`); laneIds.add(lane.id);
		invariant(typeof lane.lens === "string" && lane.lens.length > 0 && LANE_STATES.has(lane.status) && (lane.elapsedMs === null || finiteNonnegative(lane.elapsedMs)) && (lane.provider === null || typeof lane.provider === "string" && lane.provider.length > 0) && (lane.model === null || typeof lane.model === "string" && lane.model.length > 0) && (lane.status !== "complete" || lane.elapsedMs !== null && lane.provider !== null && lane.model !== null), `${label} lane metadata`);
		const basePassId = lane.id.replace(/-shard-[123]$/, "");
		invariant(PASS_LENSES[basePassId] === lane.lens, `${label} lane ${lane.id} lens`);
	}
	invariant(run.lanes.length === expectedTopology.passIds.length && expectedTopology.passIds.every((id) => laneIds.has(id)), `${label} required lane set`);
	invariant(exactKeys(run.publication, ["artifact", "fallback"]) && PUBLICATION_ARTIFACTS.has(run.publication.artifact) && typeof run.publication.fallback === "boolean" && run.publication.fallback === (run.publication.artifact !== "canonical") && (run.publication.artifact !== "canonical" || run.lanes.every((lane) => lane.status === "complete")), `${label} publication`);
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
	invariant(Array.isArray(run.artifacts) && run.artifacts.length === 2 && new Set(run.artifacts.map((item) => item.kind)).size === 2 && new Set(run.artifacts.map((item) => item.path)).size === 2, `${label} artifacts`);
	const payloads = run.artifacts.map((artifact) => [artifact.kind, validateArtifact(artifact, bundleRoot, run)]), lanePayload = payloads.find(([kind]) => kind === "lane-artifacts")[1], reviewPayload = payloads.find(([kind]) => kind === "canonical-review")[1]; validateSessionBindings(lanePayload, reviewPayload, run, label, effectiveConfig);
	const visibleFallbackFindings = run.publication.fallback ? parseVisibleFallbackFindings(reviewPayload.markdown) : [], semanticFindings = [...run.findings], seenFindings = new Set(run.findings.map(canonical));
	for (const finding of visibleFallbackFindings) if (!seenFindings.has(canonical(finding))) { seenFindings.add(canonical(finding)); semanticFindings.push(finding); }
	Object.defineProperty(run, SEMANTIC_FINDINGS, { value: semanticFindings, enumerable: false });
	return run;
}

function locationMatches(actual, acceptable) {
	if (actual === null || actual.path !== acceptable.path || !["LEFT", "RIGHT"].includes(actual.side) || !Number.isSafeInteger(actual.start) || !Number.isSafeInteger(actual.end) || actual.start <= 0 || actual.end < actual.start || actual.start < acceptable.start - 1 || actual.end > acceptable.end + 1) return false;
	const overlapsWithContextTolerance = actual.end >= acceptable.start - 1 && actual.start <= acceptable.end + 1;
	// Reviewers may anchor a replacement hunk on either the removed line (LEFT)
	// or its adjacent added line (RIGHT). Keep the cross-side tolerance to one
	// line; wider or unrelated anchors remain rejected.
	return overlapsWithContextTolerance;
}
function containsConcept(text, term) {
	const normalized = term.toLocaleLowerCase("en-US");
	if (["quadratic", "o(n"].includes(normalized) && MULTIPLICATIVE_COMPLEXITY.test(text)) return true;
	if (["access", "authorization", "other"].includes(normalized) && /\b(?:cross[- ]tenant|ownership)\b/iu.test(text)) return true;
	if (!/^[\p{L}\p{N}_]+$/u.test(normalized)) return text.includes(normalized);
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), variant = normalized.endsWith("e") ? `(?:${escaped}(?:s|d)?|${escaped.slice(0, -1)}ing)` : `${escaped}(?:s|es|ed|ing|ion|ions)?`;
	return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${variant}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}
function maskEmbeddedConcepts(text, groups) {
	const terms = groups.flat().filter((term) => /^[\p{L}\p{N}_]+$/u.test(term));
	return text.replace(/[\p{L}\p{N}_]+/gu, (token) => {
		if ((token.includes("_") || /\p{Ll}\p{Lu}/u.test(token)) && !terms.some((term) => containsConcept(token.toLocaleLowerCase("en-US"), term))) return "¤".repeat(token.length);
		let masked = token;
		for (const term of terms) {
			if (containsConcept(token.toLocaleLowerCase("en-US"), term)) continue;
			const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			masked = masked.replace(new RegExp(escaped, "giu"), (embedded) => "¤".repeat(embedded.length));
		}
		return masked;
	});
}
function contrastivePositiveDefectClause(expected, finding) {
	const clauses = [finding.title, ...finding.body.split(/\b(?:but|however|yet)\b|[.;]\s+/iu)].map((clause) => clause.trim()).filter(Boolean);
	let lastContradiction = -1;
	for (let index = 0; index < clauses.length; index++) { const polarity = expandNegations(clauses[index]); if (EXPLICIT_NON_FINDING.some((pattern) => pattern.test(polarity)) || expected.contradictionPatterns.some((pattern) => new RegExp(pattern, "iu").test(polarity))) lastContradiction = index; }
	return lastContradiction >= 0 ? clauses.slice(lastContradiction + 1).find((clause) => hasPositiveDefectCue(clause)) ?? null : null;
}
function expectedMatchesFinding(expected, finding) {
	if (!expected.allowedSeverities.includes(finding.severity)) return false;
	if (!expected.acceptableLocations.some((location) => locationMatches(finding.location, location))) return false;
	const rawText = `${finding.title}\n${finding.body}`, polarityText = expandNegations(rawText), contradictory = EXPLICIT_NON_FINDING.some((pattern) => pattern.test(polarityText)) || expected.contradictionPatterns.some((pattern) => new RegExp(pattern, "iu").test(polarityText)), contrastiveClause = contradictory ? contrastivePositiveDefectClause(expected, finding) : null;
	if (contradictory && contrastiveClause === null) return false;
	const semanticText = contradictory ? contrastiveClause : rawText, semanticBody = contradictory ? contrastiveClause : finding.body, text = semanticText.toLocaleLowerCase("en-US"), conceptMatches = expected.requiredConcepts.map((group) => group.some((term) => containsConcept(text, term))), matchedConcepts = conceptMatches.filter(Boolean).length, allConceptsMatched = matchedConcepts === conceptMatches.length, positiveDefect = hasPositiveDefectCue(semanticBody);
	if (allConceptsMatched) return positiveDefect;
	// The first assertion group may compensate for one genuinely missing concept
	// group. Token-aware concepts prevent identifiers such as showBranch or
	// userId from independently satisfying branch or id.
	const assertionText = maskEmbeddedConcepts(semanticText, expected.requiredConcepts), coreAssertionMatched = expected.assertionPatterns[0].some((pattern) => new RegExp(pattern, "iu").test(assertionText));
	return positiveDefect && coreAssertionMatched && matchedConcepts >= Math.ceil(conceptMatches.length * 2 / 3);
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

export function scoreRun(item, run, findings = run.findings) {
	const expected = item.expectedFindings;
	const edges = findings.map((finding) => expected.map((candidate, index) => expectedMatchesFinding(candidate, finding) ? index : -1).filter((index) => index >= 0));
	const assignedFinding = maximumMatching(edges, expected.length), matchedFindingIndices = new Set(assignedFinding.filter((index) => index >= 0));
	const matchedExpectedIds = expected.filter((_, index) => assignedFinding[index] >= 0).map((candidate) => candidate.id), underclassifiedExpectedIds = [], overclassifiedExpectedIds = [];
	for (let index = 0; index < expected.length; index++) if (assignedFinding[index] >= 0) { const actual = findings[assignedFinding[index]].severity, target = expected[index].targetSeverity; if (SEVERITY_RANK[actual] > SEVERITY_RANK[target]) underclassifiedExpectedIds.push(expected[index].id); else if (SEVERITY_RANK[actual] < SEVERITY_RANK[target]) overclassifiedExpectedIds.push(expected[index].id); }
	let duplicates = 0, unmatchedFindings = 0;
	for (let index = 0; index < findings.length; index++) {
		if (matchedFindingIndices.has(index)) continue;
		if (edges[index].some((expectedIndex) => assignedFinding[expectedIndex] >= 0)) duplicates++;
		else unmatchedFindings++;
	}
	return { matchedExpectedIds, missedExpectedIds: expected.filter((candidate) => !matchedExpectedIds.includes(candidate.id)).map((candidate) => candidate.id), underclassifiedExpectedIds, overclassifiedExpectedIds, duplicateFindings: duplicates, unmatchedFindings, falsePositiveFindings: item.cleanControl ? unmatchedFindings : 0, cleanControlHadFinding: item.cleanControl && findings.length > 0 };
}

function ratio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }
function percentile(values, percentileValue) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b), index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[index];
}
function distribution(values) {
	if (values.length === 0) return { mean: null, standardDeviation: null, minimum: null, maximum: null };
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return { mean, standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), minimum: Math.min(...values), maximum: Math.max(...values) };
}
function metricPair(opportunities, matched) { return { matched, opportunities, recall: ratio(matched, opportunities) }; }

export function aggregateScores(corpusInfo, plan, runs) {
	const caseById = new Map(corpusInfo.corpus.cases.map((item) => [item.id, item]));
	const scores = runs.map((run) => { const findings = run[SEMANTIC_FINDINGS] ?? run.findings; return { run, findings, visibleFallbackFindings: Math.max(0, findings.length - run.findings.length), item: caseById.get(run.caseId), score: scoreRun(caseById.get(run.caseId), run, findings) }; });
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
		const laneTotal = Object.values(laneStates).reduce((a, b) => a + b, 0), allFindings = group.reduce((sum, { findings }) => sum + findings.length, 0), matchedFindings = group.reduce((sum, { score }) => sum + score.matchedExpectedIds.length, 0), underclassified = group.reduce((sum, { score }) => sum + score.underclassifiedExpectedIds.length, 0), overclassified = group.reduce((sum, { score }) => sum + score.overclassifiedExpectedIds.length, 0), unmatched = group.reduce((sum, { score }) => sum + score.unmatchedFindings, 0), duplicates = group.reduce((sum, { score }) => sum + score.duplicateFindings, 0), falsePositives = group.reduce((sum, { score }) => sum + score.falsePositiveFindings, 0), fallbackRuns = group.filter(({ run }) => run.publication.fallback).length, visibleFallbackFindings = group.reduce((sum, entry) => sum + entry.visibleFallbackFindings, 0);
		return {
			runs: group.length,
			p0p1: select((expected) => expected.targetSeverity === "P0" || expected.targetSeverity === "P1"),
			p2: select((expected) => expected.targetSeverity === "P2"),
			crossFile: select((expected) => expected.crossFile),
			perLens,
			cleanControls: { runs: clean.length, runsWithFindings: clean.filter(({ score }) => score.cleanControlHadFinding).length, caseFalsePositiveRate: ratio(clean.filter(({ score }) => score.cleanControlHadFinding).length, clean.length) },
			findings: { total: allFindings, matched: matchedFindings, underclassified, overclassified, exactSeverityRate: ratio(matchedFindings - underclassified - overclassified, matchedFindings), unmatched, falsePositives, duplicates, falsePositiveRate: ratio(falsePositives, allFindings), duplicateRate: ratio(duplicates, allFindings) },
			lanes: { total: laneTotal, ...laneStates, completeRate: ratio(laneStates.complete, laneTotal), partialRate: ratio(laneStates.partial, laneTotal), timedOutRate: ratio(laneStates.timed_out, laneTotal), failedRate: ratio(laneStates.failed, laneTotal) },
			publication: { fallbackRuns, fallbackRate: ratio(fallbackRuns, group.length), visibleFallbackFindings },
			latencyMs: { p50: percentile(group.map(({ run }) => run.elapsedMs), 0.5), p95: percentile(group.map(({ run }) => run.elapsedMs), 0.95), ...distribution(group.map(({ run }) => run.elapsedMs)), parentValidationSynthesisP50: percentile(group.map(({ run }) => run.timing.parentValidationSynthesisMs), 0.5) },
		};
	};
	return { overall: aggregateGroup(scores), modes: Object.fromEntries(plan.modes.map((mode) => [mode, aggregateGroup(scores.filter(({ run }) => run.mode === mode))])), runs: scores.map(({ run, score }) => ({ planEntryId: run.planEntryId, caseId: run.caseId, mode: run.mode, repetition: run.repetition, ...score })) };
}

function evaluateGates(metrics, gates, corpusInfo, plan, environmentFingerprint, baselineReport) {
	if (!gates) return { status: "baseline_required", passed: false, failures: ["No accepted baseline gate file was supplied; metrics are diagnostic only."] };
	invariant(!GATE_INELIGIBLE_CORPORA.has(corpusInfo.corpus.corpusId), `corpus ${corpusInfo.corpus.corpusId} is explicitly gate-ineligible`);
	invariant(exactKeys(gates, ["schemaVersion", "corpusId", "corpusSha256", "acceptedAtUtc", "rationale", "baseline", "thresholds"]), "gate file schema");
	invariant(gates.schemaVersion === 1 && gates.corpusId === corpusInfo.corpus.corpusId && gates.corpusSha256 === corpusInfo.sha256 && Number.isFinite(Date.parse(gates.acceptedAtUtc)) && typeof gates.rationale === "string" && gates.rationale.length >= 20, "gate file identity");
	invariant(exactKeys(gates.baseline, ["reportSha256", "planId", "environmentFingerprint", "scorerSha256"]) && SHA256.test(gates.baseline.reportSha256) && gates.baseline.planId === plan.planId && gates.baseline.environmentFingerprint === environmentFingerprint && gates.baseline.scorerSha256 === SCORER_SHA256, "gate baseline binding");
	invariant(baselineReport && baselineReport.sha256 === gates.baseline.reportSha256 && plain(baselineReport.value) && baselineReport.value.schemaVersion === 1 && baselineReport.value.corpusId === corpusInfo.corpus.corpusId && baselineReport.value.corpusSha256 === corpusInfo.sha256 && baselineReport.value.planId === plan.planId && baselineReport.value.environmentFingerprint === environmentFingerprint && baselineReport.value.scorerSha256 === SCORER_SHA256 && baselineReport.value.resultCount === plan.entries.length, "gate baseline report content/hash binding");
	invariant(exactKeys(gates.thresholds, ["modes"]) && plain(gates.thresholds.modes) && JSON.stringify(Object.keys(gates.thresholds.modes).sort()) === JSON.stringify([...plan.modes].sort()), "gate per-mode threshold partition");
	const thresholdKeys = ["minimumP0P1Recall", "minimumP2Recall", "minimumCrossFileRecall", "minimumPerLensRecall", "minimumExactSeverityRate", "maximumCleanControlCaseFalsePositiveRate", "maximumDuplicateRate", "minimumLaneCompleteRate", "maximumPublicationFallbackRate", "maximumP50LatencyMs", "maximumP95LatencyMs"];
	const failures = [], checkMin = (label, actual, expected) => { if (actual === null || actual < expected) failures.push(`${label} ${actual ?? "n/a"} < ${expected}`); }, checkMax = (label, actual, expected) => { if (actual === null || actual > expected) failures.push(`${label} ${actual ?? "n/a"} > ${expected}`); };
	for (const mode of plan.modes) {
		const t = gates.thresholds.modes[mode], m = metrics.modes[mode];
		invariant(exactKeys(t, thresholdKeys), `gate thresholds schema for ${mode}`);
		for (const key of thresholdKeys.filter((key) => key !== "minimumPerLensRecall" && !key.endsWith("LatencyMs"))) { const value = t[key]; invariant(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, `gate threshold ${mode}.${key}`); }
		invariant(plain(t.minimumPerLensRecall) && JSON.stringify(Object.keys(t.minimumPerLensRecall).sort()) === JSON.stringify([...corpusInfo.corpus.lenses].sort()) && Object.values(t.minimumPerLensRecall).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1), `gate per-lens thresholds ${mode}`);
		for (const key of ["maximumP50LatencyMs", "maximumP95LatencyMs"]) invariant(typeof t[key] === "number" && Number.isFinite(t[key]) && t[key] >= 0, `gate threshold ${mode}.${key}`);
		checkMin(`${mode} P0/P1 recall`, m.p0p1.recall, t.minimumP0P1Recall); checkMin(`${mode} P2 recall`, m.p2.recall, t.minimumP2Recall); checkMin(`${mode} cross-file recall`, m.crossFile.recall, t.minimumCrossFileRecall); for (const lens of corpusInfo.corpus.lenses) checkMin(`${mode} ${lens} recall`, m.perLens[lens].recall, t.minimumPerLensRecall[lens]); checkMin(`${mode} exact-severity rate`, m.findings.exactSeverityRate, t.minimumExactSeverityRate); checkMax(`${mode} clean-control false-positive rate`, m.cleanControls.caseFalsePositiveRate, t.maximumCleanControlCaseFalsePositiveRate); checkMax(`${mode} duplicate rate`, m.findings.duplicateRate, t.maximumDuplicateRate); checkMin(`${mode} lane complete rate`, m.lanes.completeRate, t.minimumLaneCompleteRate); checkMax(`${mode} publication fallback rate`, m.publication.fallbackRate, t.maximumPublicationFallbackRate); checkMax(`${mode} p50 latency`, m.latencyMs.p50, t.maximumP50LatencyMs); checkMax(`${mode} p95 latency`, m.latencyMs.p95, t.maximumP95LatencyMs);
	}
	return { status: failures.length === 0 ? "passed" : "failed", passed: failures.length === 0, failures };
}

function comparableConfiguration(run) {
	return { provider: run.configuration.provider, model: run.configuration.model, thinking: run.configuration.thinking, toolPolicy: run.configuration.toolPolicy, reviewVersion: run.configuration.reviewVersion, piVersion: run.configuration.piVersion, piSha256: run.configuration.piSha256, piRuntimeSha256: run.configuration.piRuntimeSha256, nodeVersion: run.configuration.nodeVersion, nodeSha256: run.configuration.nodeSha256, collectorRuntimeVersion: run.configuration.collectorRuntimeVersion, collectorRuntimeSha256: run.configuration.collectorRuntimeSha256, reviewConfigSha256: run.configuration.reviewConfigSha256, extensionSha256: run.configuration.extensionSha256, promptSha256: run.configuration.promptSha256, collectorSha256: run.configuration.collectorSha256 };
}
function comparableEnvironment(run) {
	const configuration = comparableConfiguration(run); delete configuration.extensionSha256; delete configuration.promptSha256; return configuration;
}

export function scoreBundle({ corpusInfo, plan, resultsDirectory, gates = null, baselineReport = null }) {
	validatePlan(plan, corpusInfo);
	const bundleRoot = fs.realpathSync(path.resolve(resultsDirectory)), runDir = path.join(bundleRoot, "runs");
	invariant(fs.lstatSync(runDir).isDirectory(), "result bundle requires runs/ directory");
	const files = fs.readdirSync(runDir, { withFileTypes: true }), effectiveConfigBytes = fs.readFileSync(resolveContainedRegular(bundleRoot, "effective-review-config.json", "effective review config")); let effectiveConfig; try { effectiveConfig = JSON.parse(effectiveConfigBytes.toString("utf8")); } catch { invariant(false, "effective review config JSON"); } invariant(plain(effectiveConfig), "effective review config schema");
	invariant(files.every((entry) => entry.isFile() && entry.name.endsWith(".json")), "runs/ may contain only JSON files");
	const entryById = new Map(plan.entries.map((entry) => [entry.entryId, entry])), caseById = new Map(corpusInfo.corpus.cases.map((item) => [item.id, item])), seen = new Set(), runs = [];
	for (const entry of files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
		const run = readJson(path.join(runDir, entry.name)).value, planEntry = entryById.get(run?.planEntryId);
		invariant(planEntry && !seen.has(planEntry.entryId), `unknown or duplicate plan entry in ${entry.name}`); seen.add(planEntry.entryId);
		runs.push(validateRun(run, planEntry, bundleRoot, caseById.get(planEntry.caseId), effectiveConfig));
	}
	invariant(runs.length === plan.entries.length, `result bundle is incomplete: ${runs.length}/${plan.entries.length} runs`);
	invariant(sha256(effectiveConfigBytes) === runs[0].configuration.reviewConfigSha256, "effective review config hash differs from run configuration");
	const configuration = comparableConfiguration(runs[0]), configurationCanonical = canonical(configuration), configurationFingerprint = sha256(Buffer.from(configurationCanonical)), environmentCanonical = canonical(comparableEnvironment(runs[0])), environmentFingerprint = sha256(Buffer.from(environmentCanonical));
	invariant(runs.every((run) => canonical(comparableConfiguration(run)) === configurationCanonical), "runs use incomparable provider/model/thinking/tool/version configuration");
	const laneModels = new Map();
	for (const run of runs) for (const lane of run.lanes) {
		if (lane.provider === null || lane.model === null) continue;
		const identity = `${lane.provider}\0${lane.model}`;
		invariant(!laneModels.has(lane.id) || laneModels.get(lane.id) === identity, `lane ${lane.id} changed provider/model within the comparison`);
		laneModels.set(lane.id, identity);
	}
	const metrics = aggregateScores(corpusInfo, plan, runs), gate = evaluateGates(metrics, gates, corpusInfo, plan, environmentFingerprint, baselineReport);
	return { schemaVersion: 1, corpusId: corpusInfo.corpus.corpusId, corpusSha256: corpusInfo.sha256, planId: plan.planId, scorerSha256: SCORER_SHA256, configurationFingerprint, environmentFingerprint, resultCount: runs.length, gate, metrics };
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
	const allowed = command === "plan" ? new Set(["--corpus", "--modes", "--repetitions", "--output"]) : new Set(["--corpus", "--plan", "--results", "--output", "--gates", "--baseline-report"]);
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
	const plan = readJson(path.resolve(options["--plan"])).value, gates = options["--gates"] ? readJson(path.resolve(options["--gates"])).value : null; invariant(!gates || options["--baseline-report"], "--gates requires --baseline-report"); const baselineRead = options["--baseline-report"] ? readJson(path.resolve(options["--baseline-report"])) : null, baselineReport = baselineRead ? { sha256: sha256(baselineRead.bytes), value: baselineRead.value } : null;
	const report = scoreBundle({ corpusInfo, plan, resultsDirectory: options["--results"], gates, baselineReport }); writeExclusive(options["--output"], report);
	console.log(`Scored ${report.resultCount} runs; gate ${report.gate.status}.`);
	if (report.gate.status === "failed") process.exitCode = 1;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
