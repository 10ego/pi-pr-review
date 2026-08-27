import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createPlan, expectedModeTopology, loadCorpus, resolvedTierModelIdentities, scoreBundle, scoreRun } from "./review-semantic-benchmark.mjs";
import { collectSessionResult, materializeOldFiles, spawnPi } from "./review-semantic-collect.mjs";

const CORPUS = path.resolve("tests/benchmarks/review-semantic/corpus-v5.json");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function artifact(root, entryId, kind, payload) {
	const relative = `artifacts/${entryId}-${kind}.json`, file = path.join(root, relative), bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
	fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
	return { kind, path: relative, sha256: sha256(bytes), bytes: bytes.length };
}
function findingFor(expected) {
	return {
		title: `[${expected.targetSeverity}] ${expected.requiredConcepts.map((group) => group[0]).join(" ")}`,
		body: expected.rationale,
		severity: expected.targetSeverity,
		location: { ...expected.acceptableLocations[0] },
	};
}
function createBundle({ modes = ["balanced", "full"], repetitions = 1, mutateRun } = {}) {
	const corpusInfo = loadCorpus(CORPUS), plan = createPlan(corpusInfo, modes, repetitions), root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-semantic-")), runDir = path.join(root, "runs"), effectiveConfigBytes = Buffer.from('{"fixture":true}\n'), reviewConfigSha256 = sha256(effectiveConfigBytes); fs.mkdirSync(runDir); fs.writeFileSync(path.join(root, "effective-review-config.json"), effectiveConfigBytes);
	const cases = new Map(corpusInfo.corpus.cases.map((item) => [item.id, item]));
	const runs = [];
	for (const entry of plan.entries) {
		const item = cases.get(entry.caseId), topology = expectedModeTopology(entry.mode, item);
		const run = {
			schemaVersion: 1, planEntryId: entry.entryId, caseId: entry.caseId, mode: entry.mode, repetition: entry.repetition,
			startedAtUtc: "2026-08-28T00:00:00.000Z", elapsedMs: 100 + runs.length,
			timing: { parentValidationSynthesisMs: 15 },
			configuration: { provider: "fixture", model: "fixture-reviewer", thinking: "high", toolPolicy: "configured", reviewVersion: "1.15.8", piVersion: "0.84.3", piSha256: "1".repeat(64), piRuntimeSha256: "7".repeat(64), nodeVersion: "v24.0.0", nodeSha256: "8".repeat(64), collectorRuntimeVersion: "1.3.0", collectorRuntimeSha256: "9".repeat(64), reviewConfigSha256, extensionSha256: "3".repeat(64), promptSha256: "4".repeat(64), collectorSha256: "5".repeat(64), topology: { passIds: topology.passIds, shardCount: topology.shardCount, maxParallel: topology.maxParallel } },
			lanes: topology.passIds.map((id) => ({ id, lens: id.replace(/-shard-[123]$/, ""), status: "complete", elapsedMs: 80, provider: "fixture", model: "fixture-reviewer" })),
			publication: { artifact: "canonical", fallback: false }, findings: item.expectedFindings.map(findingFor), artifacts: [],
		};
		mutateRun?.(run, item, runs.length, root);
		const markdown = run.findings.map((finding) => `${finding.title}\n${finding.body}`).join("\n") || "No findings.", rawLaneArtifacts = run.lanes.filter((lane) => lane.status !== "failed").map((lane) => ({ passId: lane.id, lifecycle: lane.status, requestedModel: lane.provider && lane.model ? `${lane.provider}/${lane.model}` : undefined, observedModel: lane.model ?? undefined, startOffsetMs: 0, endOffsetMs: lane.elapsedMs ?? 0, attempts: [] })), telemetry = { completion: "terminal_response", totalWallMs: run.elapsedMs, phases: { aggregateOrchestration: { elapsedMs: run.timing.parentValidationSynthesisMs } } }, hostFindings = run.findings.map((finding) => ({ title: finding.title, body: finding.body, severity: finding.severity, code_location: finding.location ? { absolute_file_path: finding.location.path, side: finding.location.side, line_range: { start: finding.location.start, end: finding.location.end } } : null })), completed = { review: { findings: hostFindings }, rawText: markdown, laneArtifacts: rawLaneArtifacts, synthesisQuality: run.publication.artifact === "canonical" ? "fully_parsed" : run.publication.artifact === "raw_body_only" ? "raw" : "partially_parsed", completeness: run.lanes.every((lane) => lane.status === "complete") ? "complete" : "incomplete" }, records = [{ type: "session", version: 3, id: entry.entryId, timestamp: run.startedAtUtc, cwd: "/fixture" }, { type: "model_change", provider: run.configuration.provider, modelId: run.configuration.model }, { type: "thinking_level_change", thinkingLevel: run.configuration.thinking }, { type: "custom", customType: "pr-review-completed", data: completed }, { type: "custom", customType: "pr-review-telemetry", data: telemetry }], sessionBytes = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
		run.artifacts = [
			artifact(root, entry.entryId, "lane-artifacts", { schemaVersion: 1, planEntryId: entry.entryId, lanes: run.lanes, raw: { laneArtifacts: rawLaneArtifacts, telemetry, resolvedReview: completed.review, ghAudit: [{ allowed: true, write: false }], auditValid: true, process: { stdout: "fixture output", stderr: "", exitCode: 0, signal: null, error: null }, session: { sha256: sha256(sessionBytes), bytes: sessionBytes.length, recordCount: records.length, contentBase64: sessionBytes.toString("base64") } } }),
			artifact(root, entry.entryId, "canonical-review", { schemaVersion: 1, planEntryId: entry.entryId, publication: run.publication, findings: run.findings, markdown }),
		];
		runs.push(run); fs.writeFileSync(path.join(runDir, `${entry.entryId}.json`), `${JSON.stringify(run, null, 2)}\n`);
	}
	return { corpusInfo, plan, root, runs };
}
function gates(bundle, overrides = {}) {
	const configuration = { ...bundle.runs[0].configuration }; delete configuration.topology;
	const configurationFingerprint = sha256(Buffer.from(canonical(configuration))), threshold = { minimumP0P1Recall: 1, minimumP2Recall: 1, minimumCrossFileRecall: 1, maximumCleanControlCaseFalsePositiveRate: 0, maximumDuplicateRate: 0, minimumLaneCompleteRate: 1, maximumPublicationFallbackRate: 0, ...overrides };
	return { schemaVersion: 1, corpusId: bundle.corpusInfo.corpus.corpusId, corpusSha256: bundle.corpusInfo.sha256, acceptedAtUtc: "2026-08-28T00:00:00.000Z", rationale: "Accepted after repeated baseline runs on the versioned semantic corpus.", baseline: { reportSha256: "a".repeat(64), planId: bundle.plan.planId, configurationFingerprint }, thresholds: { modes: Object.fromEntries(bundle.plan.modes.map((mode) => [mode, { ...threshold }])) } };
}

test("versioned corpus pins every diff, covers all heavy lenses, cross-file findings, and clean controls", () => {
	const info = loadCorpus(CORPUS);
	assert.equal(info.corpus.schemaVersion, 1); assert.equal(info.corpus.cases.length, 12);
	assert.equal(info.corpus.cases.filter((item) => item.cleanControl).length, 2);
	assert.ok(info.corpus.cases.some((item) => item.expectedFindings.some((finding) => finding.crossFile)));
	for (const lens of info.corpus.lenses) assert.ok(info.corpus.cases.some((item) => item.expectedFindings.some((finding) => finding.lenses.includes(lens))), lens);
});

test("plan is deterministic and spans the same corpus for every mode and repetition", () => {
	const info = loadCorpus(CORPUS), one = createPlan(info, ["balanced", "full"], 3), two = createPlan(info, ["balanced", "full"], 3);
	assert.deepEqual(one, two); assert.equal(one.entries.length, 72); assert.equal(new Set(one.entries.map((entry) => entry.entryId)).size, 72);
	for (const mode of one.modes) assert.equal(one.entries.filter((entry) => entry.mode === mode).length, 36);
	assert.notEqual(one.entries[0].mode, one.entries[1].mode);
	assert.ok(one.entries.slice(0, 22).some((entry, index, entries) => index > 0 && entry.mode !== entries[index - 1].mode));
});

test("large multi-file corpus case exercises the production sharding thresholds", () => {
	const info = loadCorpus(CORPUS), item = info.corpus.cases.find((candidate) => candidate.id === "sharded-registry-contract"), balanced = expectedModeTopology("balanced", item), full = expectedModeTopology("full", item), deep = expectedModeTopology("deep", item);
	assert.ok(item.diffBytes >= 200_000 && item.diffBytes < 400_000); assert.equal(item.changedFiles.length, 2);
	assert.equal(balanced.shardCount, 2); assert.equal(balanced.passIds.length, 10); assert.equal(balanced.maxParallel, 10);
	assert.equal(full.shardCount, 2); assert.equal(full.passIds.length, 12); assert.equal(full.maxParallel, 12);
	assert.deepEqual(deep, { passIds: ["deep-review"], shardCount: 1, maxParallel: 1 });
});

test("perfect immutable result bundle emits recall, lifecycle, fallback, and latency metrics", () => {
	const bundle = createBundle(), report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root });
	assert.equal(report.resultCount, 24); assert.equal(report.gate.status, "baseline_required");
	assert.equal(report.metrics.overall.p0p1.recall, 1); assert.equal(report.metrics.overall.p2.recall, 1); assert.equal(report.metrics.overall.crossFile.recall, 1);
	assert.equal(report.metrics.overall.cleanControls.caseFalsePositiveRate, 0); assert.equal(report.metrics.overall.findings.duplicateRate, 0);
	assert.equal(report.metrics.overall.lanes.completeRate, 1); assert.equal(report.metrics.overall.publication.fallbackRate, 0);
	assert.equal(report.metrics.overall.latencyMs.p50, 111); assert.equal(report.metrics.overall.latencyMs.p95, 122); assert.ok(report.metrics.overall.latencyMs.standardDeviation > 0);
	assert.equal(report.metrics.modes.balanced.runs, 12); assert.equal(report.metrics.modes.full.runs, 12);
});

test("accepted explicit baseline gates pass a perfect bundle", () => {
	const bundle = createBundle({ modes: ["balanced"] }), report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root, gates: gates(bundle) });
	assert.deepEqual(report.gate, { status: "passed", passed: true, failures: [] });
});

test("semantic matching requires severity, overlapping anchor, and every concept group", () => {
	const info = loadCorpus(CORPUS), item = info.corpus.cases.find((candidate) => candidate.id === "command-injection"), expected = item.expectedFindings[0], valid = findingFor(expected);
	const base = { findings: [valid] };
	assert.deepEqual(scoreRun(item, base).matchedExpectedIds, [expected.id]);
	const underclassified = scoreRun(item, { findings: [{ ...valid, severity: "P2", title: valid.title.replace("[P1]", "[P2]") }] }); assert.deepEqual(underclassified.matchedExpectedIds, [expected.id]); assert.deepEqual(underclassified.underclassifiedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, location: { ...valid.location, start: 99, end: 99 } }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, title: "[P1] branch shell", body: "No semantic classification." }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, body: "The branch shell command injection is safe and not an issue; no finding exists." }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, body: "The branch shell command cannot lead to injection because argv is used instead of a shell." }] }).missedExpectedIds, [expected.id]);
});

test("defect-polarity negation is not mistaken for a contradictory non-finding", () => {
	const info = loadCorpus(CORPUS), item = info.corpus.cases.find((candidate) => candidate.id === "sharded-registry-contract"), expected = item.expectedFindings[0], finding = findingFor(expected); finding.body += " The payload is not parsed before JSON.parse receives the cached object.";
	assert.deepEqual(scoreRun(item, { findings: [finding] }).matchedExpectedIds, [expected.id]);
});

test("lane model admission mirrors production nearest-tier and fallback resolution", () => {
	const parent = "parent/orchestrator", identity = (provider, model) => ({ provider, model });
	assert.deepEqual(resolvedTierModelIdentities({ tiers: { medium: "tier/medium" }, fallbacks: {} }, "light", parent), [identity("tier", "medium")]);
	assert.deepEqual(resolvedTierModelIdentities({ tiers: { light: "tier/light", medium: "tier/medium", heavy: "tier/heavy" }, fallbacks: { heavy: ["backup/one:high"] } }, "heavy", parent), [identity("tier", "heavy"), identity("backup", "one")]);
	assert.deepEqual(resolvedTierModelIdentities({ tiers: {}, fallbacks: {} }, "heavy", parent), [identity("parent", "orchestrator")]);
});

test("target severity, not allowed-severity order, owns recall denominators", () => {
	const info = loadCorpus(CORPUS), compile = info.corpus.cases.find((item) => item.id === "compile-export-removal"), critical = findingFor(compile.expectedFindings[0]); critical.severity = "P1"; critical.title = "[P1] Restore the removed RequestOptions export"; critical.body = "The module drops the RequestOptions export while it is still imported, so TypeScript compilation fails for every consumer."; assert.deepEqual(scoreRun(compile, { findings: [critical] }).matchedExpectedIds, [compile.expectedFindings[0].id]); const notFailing = { ...critical, body: "The import is safe because TypeScript compilation does not fail and RequestOptions remains available." }, notDropped = { ...critical, body: "RequestOptions was not dropped, so the import resolves and compilation succeeds." }; assert.deepEqual(scoreRun(compile, { findings: [notFailing] }).missedExpectedIds, [compile.expectedFindings[0].id]); assert.deepEqual(scoreRun(compile, { findings: [notDropped] }).missedExpectedIds, [compile.expectedFindings[0].id]);
	const state = info.corpus.cases.find((item) => item.id === "state-cancellation-race"), underclassified = findingFor(state.expectedFindings[0]); underclassified.severity = "P2"; underclassified.title = underclassified.title.replace("[P1]", "[P2]"); const underScore = scoreRun(state, { findings: [underclassified] }); assert.deepEqual(underScore.matchedExpectedIds, [state.expectedFindings[0].id]); assert.deepEqual(underScore.underclassifiedExpectedIds, [state.expectedFindings[0].id]);
	const bundle = createBundle({ modes: ["balanced"] }), resource = bundle.corpusInfo.corpus.cases.find((item) => item.id === "resource-listener-leak").expectedFindings[0];
	assert.equal(resource.targetSeverity, "P2"); assert.deepEqual(resource.allowedSeverities, ["P1", "P2"]);
	const metrics = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }).metrics.overall;
	assert.equal(metrics.p2.opportunities, 3); assert.equal(metrics.p0p1.opportunities, 7);
});

test("duplicate matches and clean-control findings are reported conservatively", () => {
	const bundle = createBundle({ modes: ["balanced"], mutateRun(run, item) {
		if (item.id === "command-injection") run.findings.push({ ...run.findings[0] });
		if (item.cleanControl && item.id === "clean-batched-lookup") run.findings.push({ title: "[P2] Speculative note", body: "This is an unmatched finding.", severity: "P2", location: null });
	} });
	const metrics = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }).metrics.overall;
	assert.equal(metrics.findings.duplicates, 1); assert.equal(metrics.findings.falsePositives, 1); assert.equal(metrics.cleanControls.runsWithFindings, 1); assert.equal(metrics.cleanControls.caseFalsePositiveRate, 0.5);
});

test("incomplete lanes and fallback publication participate in metrics and fail strict gates", () => {
	const bundle = createBundle({ modes: ["balanced"], mutateRun(run, item) {
		if (item.id === "state-cancellation-race") { run.lanes[0].status = "timed_out"; run.publication = { artifact: "degraded", fallback: true }; }
	} });
	const report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root, gates: gates(bundle) });
	assert.equal(report.metrics.overall.lanes.timed_out, 1); assert.equal(report.metrics.overall.publication.fallbackRuns, 1); assert.equal(report.gate.status, "failed");
	assert.ok(report.gate.failures.some((failure) => failure.includes("lane complete rate"))); assert.ok(report.gate.failures.some((failure) => failure.includes("publication fallback rate")));
});

test("mode topology, required lanes, and comparable configuration fail closed", () => {
	for (const mutate of [
		(run) => { run.lanes.pop(); },
		(run) => { run.configuration.topology.passIds = ["fake"]; run.configuration.topology.maxParallel = 1; run.lanes = [{ id: "fake", lens: "fake", status: "complete", elapsedMs: 1, provider: "fixture", model: "fixture-reviewer" }]; },
		(run) => { run.configuration.model = "different-reviewer"; },
	]) {
		const bundle = createBundle({ modes: ["balanced", "full"], mutateRun(run, item, index) { if (index === 0) mutate(run, item); } });
		assert.throws(() => scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }), /required lane set|topology does not match|incomparable|lane model is outside effective config/);
	}
});

test("per-mode baseline gates cannot hide a balanced regression in pooled full metrics", () => {
	const bundle = createBundle({ modes: ["balanced", "full"], mutateRun(run, item) { if (run.mode === "balanced" && item.id === "command-injection") run.findings = []; } });
	const report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root, gates: gates(bundle) });
	assert.equal(report.metrics.modes.full.p0p1.recall, 1); assert.ok(report.metrics.modes.balanced.p0p1.recall < 1);
	assert.equal(report.gate.status, "failed"); assert.ok(report.gate.failures.some((failure) => failure.startsWith("balanced P0/P1 recall")));
});

test("artifact envelopes bind lanes/findings and artifact paths must be distinct", () => {
	const binding = createBundle({ modes: ["balanced"] }), runFile = path.join(binding.root, "runs", `${binding.plan.entries[0].entryId}.json`), run = JSON.parse(fs.readFileSync(runFile)), laneRef = run.artifacts.find((item) => item.kind === "lane-artifacts"), laneFile = path.join(binding.root, laneRef.path), lane = JSON.parse(fs.readFileSync(laneFile)); lane.lanes[0].status = "partial"; const bytes = Buffer.from(`${JSON.stringify(lane, null, 2)}\n`); fs.writeFileSync(laneFile, bytes); laneRef.sha256 = sha256(bytes); laneRef.bytes = bytes.length; fs.writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
	assert.throws(() => scoreBundle({ corpusInfo: binding.corpusInfo, plan: binding.plan, resultsDirectory: binding.root }), /lane artifact binding/);
	const paths = createBundle({ modes: ["balanced"] }), pathRunFile = path.join(paths.root, "runs", `${paths.plan.entries[0].entryId}.json`), pathRun = JSON.parse(fs.readFileSync(pathRunFile)); pathRun.artifacts[1].path = pathRun.artifacts[0].path; fs.writeFileSync(pathRunFile, `${JSON.stringify(pathRun, null, 2)}\n`);
	assert.throws(() => scoreBundle({ corpusInfo: paths.corpusInfo, plan: paths.plan, resultsDirectory: paths.root }), /artifacts/);
	const sparse = createBundle({ modes: ["balanced"] }), sparseRunFile = path.join(sparse.root, "runs", `${sparse.plan.entries[0].entryId}.json`), sparseRun = JSON.parse(fs.readFileSync(sparseRunFile)), sparseRef = sparseRun.artifacts.find((item) => item.kind === "lane-artifacts"), sparseFile = path.join(sparse.root, sparseRef.path), sparsePayload = JSON.parse(fs.readFileSync(sparseFile)); sparsePayload.raw.laneArtifacts.pop(); const sparseBytes = Buffer.from(`${JSON.stringify(sparsePayload, null, 2)}\n`); fs.writeFileSync(sparseFile, sparseBytes); sparseRef.sha256 = sha256(sparseBytes); sparseRef.bytes = sparseBytes.length; fs.writeFileSync(sparseRunFile, `${JSON.stringify(sparseRun, null, 2)}\n`); assert.throws(() => scoreBundle({ corpusInfo: sparse.corpusInfo, plan: sparse.plan, resultsDirectory: sparse.root }), /normalized non-failed lane lacks raw evidence/);
	const forged = createBundle({ modes: ["balanced"] }), forgedRunFile = path.join(forged.root, "runs", `${forged.plan.entries[0].entryId}.json`), forgedRun = JSON.parse(fs.readFileSync(forgedRunFile)), forgedRef = forgedRun.artifacts.find((item) => item.kind === "lane-artifacts"), forgedFile = path.join(forged.root, forgedRef.path), forgedPayload = JSON.parse(fs.readFileSync(forgedFile)); forgedPayload.raw.resolvedReview = { findings: [] }; const forgedRecords = Buffer.from(forgedPayload.raw.session.contentBase64, "base64").toString("utf8").split("\n").filter(Boolean).map(JSON.parse), completedRecord = forgedRecords.find((record) => record.customType === "pr-review-completed"); delete completedRecord.data.review; const forgedSession = Buffer.from(forgedRecords.map((record) => JSON.stringify(record)).join("\n") + "\n"); forgedPayload.raw.session = { sha256: sha256(forgedSession), bytes: forgedSession.length, recordCount: forgedRecords.length, contentBase64: forgedSession.toString("base64") }; const forgedBytes = Buffer.from(`${JSON.stringify(forgedPayload, null, 2)}\n`); fs.writeFileSync(forgedFile, forgedBytes); forgedRef.sha256 = sha256(forgedBytes); forgedRef.bytes = forgedBytes.length; fs.writeFileSync(forgedRunFile, `${JSON.stringify(forgedRun, null, 2)}\n`); assert.throws(() => scoreBundle({ corpusInfo: forged.corpusInfo, plan: forged.plan, resultsDirectory: forged.root }), /resolved finding binding/);
});

test("missing run, duplicate plan tuple, and artifact tampering fail closed", () => {
	const missing = createBundle({ modes: ["balanced"] }); fs.unlinkSync(path.join(missing.root, "runs", `${missing.plan.entries[0].entryId}.json`));
	assert.throws(() => scoreBundle({ corpusInfo: missing.corpusInfo, plan: missing.plan, resultsDirectory: missing.root }), /result bundle is incomplete/);
	const duplicate = createBundle({ modes: ["balanced"] }), badPlan = structuredClone(duplicate.plan); badPlan.entries[1] = { ...badPlan.entries[0], entryId: "f".repeat(24) };
	const identity = { schemaVersion: badPlan.schemaVersion, corpusId: badPlan.corpusId, corpusSha256: badPlan.corpusSha256, modes: badPlan.modes, repetitions: badPlan.repetitions, entries: badPlan.entries }; badPlan.planId = sha256(Buffer.from(canonical(identity)));
	assert.throws(() => scoreBundle({ corpusInfo: duplicate.corpusInfo, plan: badPlan, resultsDirectory: duplicate.root }), /duplicate plan tuple/);
	const tampered = createBundle({ modes: ["balanced"] }), first = tampered.runs[0].artifacts[0]; fs.appendFileSync(path.join(tampered.root, first.path), "tamper");
	assert.throws(() => scoreBundle({ corpusInfo: tampered.corpusInfo, plan: tampered.plan, resultsDirectory: tampered.root }), /artifact bytes\/hash/);
});

test("result schemas reject extra fields, invalid latency, unsafe paths, and symlink artifacts", () => {
	for (const mutate of [
		(run) => { run.untrusted = true; },
		(run) => { run.elapsedMs = Number.NaN; },
		(run) => { run.findings[0].location.path = "../escape"; },
	]) {
		const bundle = createBundle({ modes: ["balanced"], mutateRun(run, item, index) { if (index === 0) mutate(run, item); } });
		assert.throws(() => scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }), /Semantic benchmark invalid/);
	}
	const bundle = createBundle({ modes: ["balanced"] }), reference = bundle.runs[0].artifacts[0], target = path.join(bundle.root, reference.path), real = `${target}.real`; fs.renameSync(target, real); fs.symlinkSync(real, target);
	assert.throws(() => scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }), /non-symlink|artifact/);
});

test("every corpus diff is syntactically applicable to its materialized base", () => {
	const info = loadCorpus(CORPUS);
	for (const item of info.corpus.cases) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-materialize-")), diff = path.join(info.root, item.diff);
		materializeOldFiles(fs.readFileSync(diff, "utf8"), root);
		for (const changed of item.changedFiles) { const source = fs.readFileSync(path.join(root, changed), "utf8"); assert.ok(source.trim().length > 0, `${item.id}/${changed} source context`); if (item.id === "sharded-registry-contract") assert.equal((source.match(/\{/g) ?? []).length, (source.match(/\}/g) ?? []).length, `${item.id}/${changed} braces`); }
		const check = spawnSync("git", ["apply", "--check", diff], { cwd: root, encoding: "utf8" });
		assert.equal(check.status, 0, `${item.id}: ${check.stderr}`);
	}
});

test("session collection maps host lanes, telemetry, findings, and failure fallback", async () => {
	const info = loadCorpus(CORPUS), plan = createPlan(info, ["balanced"], 1), entry = plan.entries[0], item = info.corpus.cases.find((candidate) => candidate.id === entry.caseId), passIds = ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], laneArtifacts = passIds.map((passId) => ({ passId, lifecycle: "complete", requestedModel: "fixture/lane", observedModel: "lane", startOffsetMs: 1, endOffsetMs: 11, attempts: [] })), review = { findings: [{ title: "[P2] Finding", body: "Concrete issue.", severity: "P2", code_location: { absolute_file_path: item.changedFiles[0], side: "RIGHT", line_range: { start: 1, end: 1 } } }] }, records = [
		{ type: "custom", customType: "pr-review-completed", data: { review, rawText: "# PR Review", laneArtifacts, synthesisQuality: "fully_parsed", completeness: "complete" } },
		{ type: "custom", customType: "pr-review-telemetry", data: { completion: "terminal_response", totalWallMs: 99, phases: { aggregateOrchestration: { elapsedMs: 17 } } } },
	];
	const collected = await collectSessionResult({ records, entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ allowed: true, write: false }], parseReview: () => review });
	assert.equal(collected.run.elapsedMs, 99); assert.equal(collected.run.timing.parentValidationSynthesisMs, 17); assert.equal(collected.run.lanes.length, 5); assert.ok(collected.run.lanes.every((lane) => lane.status === "complete" && lane.provider === "fixture" && lane.model === "lane")); assert.equal(collected.run.publication.artifact, "canonical"); assert.equal(collected.run.findings[0].location.path, item.changedFiles[0]);
	const fallbackRecords = structuredClone(records), fallbackLane = fallbackRecords[0].data.laneArtifacts[0]; delete fallbackLane.requestedModel; delete fallbackLane.observedModel; fallbackLane.attempts = [{ requestedModel: "backup/fallback", observedModel: "fallback", elapsedMs: 7 }]; const fallback = await collectSessionResult({ records: fallbackRecords, entry, item, mode: "balanced", parentModel: "fixture/parent", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ allowed: true, write: false }], parseReview: () => review }); assert.equal(fallback.run.lanes[0].provider, "backup"); assert.equal(fallback.run.lanes[0].model, "fallback");
	const unobservedRecords = structuredClone(records), unobservedLane = unobservedRecords[0].data.laneArtifacts[0]; unobservedLane.lifecycle = "failed"; delete unobservedLane.requestedModel; delete unobservedLane.observedModel; unobservedLane.attempts = []; const unobserved = await collectSessionResult({ records: unobservedRecords, entry, item, mode: "balanced", parentModel: "fixture/parent", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ allowed: true, write: false }], parseReview: () => review }); assert.equal(unobserved.run.lanes[0].status, "failed"); assert.equal(unobserved.run.lanes[0].provider, null); assert.equal(unobserved.run.lanes[0].model, null);
	const partialRecords = structuredClone(records); partialRecords[0].data.laneArtifacts[0].lifecycle = "partial"; partialRecords[0].data.synthesisQuality = "partially_parsed"; partialRecords[0].data.completeness = "incomplete"; const partial = await collectSessionResult({ records: partialRecords, entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ allowed: true, write: false }], parseReview: () => review }); assert.equal(partial.run.publication.artifact, "degraded"); assert.equal(partial.run.lanes[0].status, "partial"); assert.equal(partial.operationallyValid, true);
	const missingCompleteness = structuredClone(records); missingCompleteness[0].data.laneArtifacts[0].lifecycle = "timed_out"; delete missingCompleteness[0].data.completeness; const incomplete = await collectSessionResult({ records: missingCompleteness, entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ allowed: true, write: false }], parseReview: () => review }); assert.equal(incomplete.run.publication.artifact, "degraded"); assert.equal(incomplete.run.lanes[0].status, "timed_out");
	const failed = await collectSessionResult({ records: [], entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "provider failed", ghAudit: [{ allowed: true, write: false }], parseReview: () => undefined });
	assert.equal(failed.run.publication.artifact, "raw_body_only"); assert.ok(failed.run.lanes.every((lane) => lane.status === "failed" && lane.elapsedMs === null && lane.provider === null)); assert.match(failed.markdown, /provider failed/);
});

test("collector hard timeout terminates the detached Pi process group", async () => {
	const started = Date.now(), outcome = await spawnPi(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), env: process.env }, 25); assert.equal(outcome.error, "collector-hard-timeout"); assert.equal(outcome.signal, "SIGTERM"); assert.ok(Date.now() - started < 2_000);
});

test("collector executes exactly one next entry through the read-only gh shim", { skip: process.platform !== "darwin" }, () => {
	const info = loadCorpus(CORPUS), plan = createPlan(info, ["balanced"], 1), root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-collector-")), planFile = path.join(root, "plan.json"), bundle = path.join(root, "bundle"), mockPackage = path.join(root, "mock-package"), mockPi = path.join(mockPackage, "dist", "mock-pi.mjs"), agent = path.join(root, "agent"), first = plan.entries[0], realGh = spawnSync("which", ["gh"], { encoding: "utf8" }).stdout.trim(), passIds = ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"];
	fs.mkdirSync(agent); fs.writeFileSync(path.join(agent, "pr-review.json"), JSON.stringify({ tiers: { light: "fixture/lane", heavy: "fixture/lane" }, fallbacks: {}, thinkingLevels: {}, toolPolicies: {}, tools: [], deadlines: { totalMs: 60000 } })); fs.writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-key" } }));
	fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`); fs.mkdirSync(path.dirname(mockPi), { recursive: true }); fs.writeFileSync(path.join(mockPackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
	fs.writeFileSync(mockPi, `import fs from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);if(a.length===1&&a[0]==='--version'){console.log('0.84.3');process.exit(0)}if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.SSH_AUTH_SOCK)process.exit(7);const absoluteGh=spawnSync(${JSON.stringify(realGh)},['auth','status'],{encoding:'utf8'});if(absoluteGh.status===0)process.exit(8);const d=a[a.indexOf('--session-dir')+1],extension=a[a.indexOf('--extension')+1];try{fs.appendFileSync(extension,'tamper');process.exit(6)}catch{}const g=spawnSync('gh',['repo','view','--json','nameWithOwner,url'],{encoding:'utf8'}),diff=spawnSync('gh',['pr','diff','1'],{encoding:'utf8'});if(g.status!==0||diff.status!==0){console.error(JSON.stringify({status:g.status,error:g.error?.message,stderr:g.stderr}));process.exit(9)}fs.mkdirSync(d,{recursive:true});const ids=${JSON.stringify(passIds)};const lanes=ids.map(passId=>({passId,lifecycle:'complete',requestedModel:'fixture/lane',observedModel:'lane',startOffsetMs:1,endOffsetMs:11,attempts:[]}));const records=[{type:'session',version:3,id:'s',timestamp:'2026-08-28T00:00:00Z',cwd:process.cwd()},{type:'model_change',provider:'fixture',modelId:'parent'},{type:'thinking_level_change',thinkingLevel:'high'},{type:'message',message:{role:'assistant',content:[{type:'text',text:'# PR Review'}],stopReason:'stop'}},{type:'custom',customType:'pr-review-completed',data:{review:{findings:[]},rawText:'# PR Review\\n\\nNo findings.',laneArtifacts:lanes,synthesisQuality:'fully_parsed',completeness:'complete'}},{type:'custom',customType:'pr-review-telemetry',data:{completion:'terminal_response',totalWallMs:50,phases:{aggregateOrchestration:{elapsedMs:5}}}}];fs.writeFileSync(d+'/session.jsonl',records.map(JSON.stringify).join('\\n')+'\\n');process.stdout.write('# PR Review\\n\\nNo findings.\\n');\n`);
	const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim(), nodeHash = sha256(fs.readFileSync(process.execPath)); assert.ok(bun);
	const piHash = sha256(fs.readFileSync(mockPi)), collectArgs = [path.resolve("tests/tooling/review-semantic-collect.mjs"), "--corpus", CORPUS, "--plan", planFile, "--bundle", bundle, "--entry", first.entryId, "--pi", mockPi, "--expected-pi-sha256", piHash, "--node", process.execPath, "--expected-node-sha256", nodeHash, "--expected-collector-runtime-sha256", sha256(fs.readFileSync(bun)), "--model", "fixture/parent", "--thinking", "high", "--acknowledge-real-model-run"], collectorEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, GH_TOKEN: "must-be-scrubbed", SSH_AUTH_SOCK: "/tmp/must-be-scrubbed" }, collect = spawnSync(bun, collectArgs, { cwd: process.cwd(), env: collectorEnv, encoding: "utf8", timeout: 30_000 });
	assert.equal(collect.status, 0, collect.stderr); const result = JSON.parse(fs.readFileSync(path.join(bundle, "runs", `${first.entryId}.json`), "utf8")); assert.equal(result.planEntryId, first.entryId); assert.equal(result.publication.artifact, "canonical"); assert.equal(result.configuration.model, "parent"); assert.equal(result.lanes.length, 5);
	const rerun = spawnSync(bun, collectArgs, { cwd: process.cwd(), env: collectorEnv, encoding: "utf8", timeout: 30_000 }); assert.notEqual(rerun.status, 0); assert.match(rerun.stderr, /reruns are forbidden/);
	const failedBundle = path.join(root, "failed-bundle"), failingPackage = path.join(root, "failing-package"), failingPi = path.join(failingPackage, "dist", "failing-pi.mjs"); fs.mkdirSync(path.dirname(failingPi), { recursive: true }); fs.writeFileSync(path.join(failingPackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" })); fs.writeFileSync(failingPi, "if(process.argv[2]==='--version'){console.log('0.84.3');process.exit(0)}console.error('provider startup failed');process.exit(1);\n");
	const failingHash = sha256(fs.readFileSync(failingPi)), failingArgs = [path.resolve("tests/tooling/review-semantic-collect.mjs"), "--corpus", CORPUS, "--plan", planFile, "--bundle", failedBundle, "--entry", first.entryId, "--pi", failingPi, "--expected-pi-sha256", failingHash, "--node", process.execPath, "--expected-node-sha256", nodeHash, "--expected-collector-runtime-sha256", sha256(fs.readFileSync(bun)), "--model", "fixture/parent", "--thinking", "high", "--acknowledge-real-model-run"], failure = spawnSync(bun, failingArgs, { cwd: process.cwd(), env: collectorEnv, encoding: "utf8", timeout: 30_000 }); assert.equal(failure.status, 1); const failedResult = JSON.parse(fs.readFileSync(path.join(failedBundle, "runs", `${first.entryId}.json`), "utf8")); assert.equal(failedResult.publication.artifact, "raw_body_only"); assert.ok(failedResult.lanes.every((lane) => lane.status === "failed")); const failedRerun = spawnSync(bun, failingArgs, { cwd: process.cwd(), env: collectorEnv, encoding: "utf8", timeout: 30_000 }); assert.match(failedRerun.stderr, /reruns are forbidden/);
});
