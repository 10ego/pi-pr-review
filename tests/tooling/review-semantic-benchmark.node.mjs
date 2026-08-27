import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createPlan, loadCorpus, scoreBundle, scoreRun } from "./review-semantic-benchmark.mjs";
import { collectSessionResult, materializeOldFiles } from "./review-semantic-collect.mjs";

const CORPUS = path.resolve("tests/benchmarks/review-semantic/corpus-v1.json");
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
	const corpusInfo = loadCorpus(CORPUS), plan = createPlan(corpusInfo, modes, repetitions), root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-semantic-")), runDir = path.join(root, "runs"); fs.mkdirSync(runDir);
	const cases = new Map(corpusInfo.corpus.cases.map((item) => [item.id, item]));
	const runs = [];
	for (const entry of plan.entries) {
		const item = cases.get(entry.caseId), topologyByMode = {
			balanced: { passIds: ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 5 },
			full: { passIds: ["overview", "conventions-maintainability", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 6 },
			"major-only": { passIds: ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], maxParallel: 5 }, deep: { passIds: ["deep-review"], maxParallel: 1 },
		}, topology = topologyByMode[entry.mode];
		const run = {
			schemaVersion: 1, planEntryId: entry.entryId, caseId: entry.caseId, mode: entry.mode, repetition: entry.repetition,
			startedAtUtc: "2026-08-28T00:00:00.000Z", elapsedMs: 100 + runs.length,
			timing: { parentValidationSynthesisMs: 15 },
			configuration: { provider: "fixture", model: "fixture-reviewer", thinking: "high", toolPolicy: "configured", reviewVersion: "1.15.8", topology: { passIds: topology.passIds, shardCount: 1, maxParallel: topology.maxParallel } },
			lanes: topology.passIds.map((id) => ({ id, lens: id, status: "complete", elapsedMs: 80, provider: "fixture", model: "fixture-reviewer" })),
			publication: { artifact: "canonical", fallback: false }, findings: item.expectedFindings.map(findingFor), artifacts: [],
		};
		mutateRun?.(run, item, runs.length, root);
		run.artifacts = [
			artifact(root, entry.entryId, "lane-artifacts", { schemaVersion: 1, planEntryId: entry.entryId, lanes: run.lanes, raw: { retained: true } }),
			artifact(root, entry.entryId, "canonical-review", { schemaVersion: 1, planEntryId: entry.entryId, publication: run.publication, findings: run.findings, markdown: item.expectedFindings.map((expected) => expected.rationale).join("\n") || "No findings." }),
		];
		runs.push(run); fs.writeFileSync(path.join(runDir, `${entry.entryId}.json`), `${JSON.stringify(run, null, 2)}\n`);
	}
	return { corpusInfo, plan, root, runs };
}
function gates(bundle, overrides = {}) {
	const configurationFingerprint = sha256(Buffer.from(canonical({ provider: "fixture", model: "fixture-reviewer", thinking: "high", toolPolicy: "configured", reviewVersion: "1.15.8" }))), threshold = { minimumP0P1Recall: 1, minimumP2Recall: 1, minimumCrossFileRecall: 1, maximumCleanControlCaseFalsePositiveRate: 0, maximumDuplicateRate: 0, minimumLaneCompleteRate: 1, maximumPublicationFallbackRate: 0, ...overrides };
	return { schemaVersion: 1, corpusId: bundle.corpusInfo.corpus.corpusId, corpusSha256: bundle.corpusInfo.sha256, acceptedAtUtc: "2026-08-28T00:00:00.000Z", rationale: "Accepted after repeated baseline runs on the versioned semantic corpus.", baseline: { reportSha256: "a".repeat(64), planId: bundle.plan.planId, configurationFingerprint }, thresholds: { modes: Object.fromEntries(bundle.plan.modes.map((mode) => [mode, { ...threshold }])) } };
}

test("versioned corpus pins every diff, covers all heavy lenses, cross-file findings, and clean controls", () => {
	const info = loadCorpus(CORPUS);
	assert.equal(info.corpus.schemaVersion, 1); assert.equal(info.corpus.cases.length, 11);
	assert.equal(info.corpus.cases.filter((item) => item.cleanControl).length, 2);
	assert.ok(info.corpus.cases.some((item) => item.expectedFindings.some((finding) => finding.crossFile)));
	for (const lens of info.corpus.lenses) assert.ok(info.corpus.cases.some((item) => item.expectedFindings.some((finding) => finding.lenses.includes(lens))), lens);
});

test("plan is deterministic and spans the same corpus for every mode and repetition", () => {
	const info = loadCorpus(CORPUS), one = createPlan(info, ["balanced", "full"], 3), two = createPlan(info, ["balanced", "full"], 3);
	assert.deepEqual(one, two); assert.equal(one.entries.length, 66); assert.equal(new Set(one.entries.map((entry) => entry.entryId)).size, 66);
	for (const mode of one.modes) assert.equal(one.entries.filter((entry) => entry.mode === mode).length, 33);
	assert.notEqual(one.entries[0].mode, one.entries[1].mode);
	assert.ok(one.entries.slice(0, 22).some((entry, index, entries) => index > 0 && entry.mode !== entries[index - 1].mode));
});

test("perfect immutable result bundle emits recall, lifecycle, fallback, and latency metrics", () => {
	const bundle = createBundle(), report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root });
	assert.equal(report.resultCount, 22); assert.equal(report.gate.status, "baseline_required");
	assert.equal(report.metrics.overall.p0p1.recall, 1); assert.equal(report.metrics.overall.p2.recall, 1); assert.equal(report.metrics.overall.crossFile.recall, 1);
	assert.equal(report.metrics.overall.cleanControls.caseFalsePositiveRate, 0); assert.equal(report.metrics.overall.findings.duplicateRate, 0);
	assert.equal(report.metrics.overall.lanes.completeRate, 1); assert.equal(report.metrics.overall.publication.fallbackRate, 0);
	assert.equal(report.metrics.overall.latencyMs.p50, 110); assert.equal(report.metrics.overall.latencyMs.p95, 120); assert.ok(report.metrics.overall.latencyMs.standardDeviation > 0);
	assert.equal(report.metrics.modes.balanced.runs, 11); assert.equal(report.metrics.modes.full.runs, 11);
});

test("accepted explicit baseline gates pass a perfect bundle", () => {
	const bundle = createBundle({ modes: ["balanced"] }), report = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root, gates: gates(bundle) });
	assert.deepEqual(report.gate, { status: "passed", passed: true, failures: [] });
});

test("semantic matching requires severity, overlapping anchor, and every concept group", () => {
	const info = loadCorpus(CORPUS), item = info.corpus.cases.find((candidate) => candidate.id === "command-injection"), expected = item.expectedFindings[0], valid = findingFor(expected);
	const base = { findings: [valid] };
	assert.deepEqual(scoreRun(item, base).matchedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, severity: "P2" }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, location: { ...valid.location, start: 99, end: 99 } }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, title: "[P1] branch shell", body: "No semantic classification." }] }).missedExpectedIds, [expected.id]);
	assert.deepEqual(scoreRun(item, { findings: [{ ...valid, body: "The branch shell command injection is safe and not an issue; no finding exists." }] }).missedExpectedIds, [expected.id]);
});

test("target severity, not allowed-severity order, owns recall denominators", () => {
	const bundle = createBundle({ modes: ["balanced"] }), resource = bundle.corpusInfo.corpus.cases.find((item) => item.id === "resource-listener-leak").expectedFindings[0];
	assert.equal(resource.targetSeverity, "P2"); assert.deepEqual(resource.allowedSeverities, ["P1", "P2"]);
	const metrics = scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }).metrics.overall;
	assert.equal(metrics.p2.opportunities, 3); assert.equal(metrics.p0p1.opportunities, 6);
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
		assert.throws(() => scoreBundle({ corpusInfo: bundle.corpusInfo, plan: bundle.plan, resultsDirectory: bundle.root }), /required lane set|topology does not match|incomparable/);
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
		const check = spawnSync("git", ["apply", "--check", diff], { cwd: root, encoding: "utf8" });
		assert.equal(check.status, 0, `${item.id}: ${check.stderr}`);
	}
});

test("session collection maps host lanes, telemetry, findings, and failure fallback", async () => {
	const info = loadCorpus(CORPUS), plan = createPlan(info, ["balanced"], 1), entry = plan.entries[0], item = info.corpus.cases.find((candidate) => candidate.id === entry.caseId), passIds = ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"], laneArtifacts = passIds.map((passId) => ({ passId, lifecycle: "complete", observedModel: "fixture/lane", startOffsetMs: 1, endOffsetMs: 11, attempts: [] })), review = { findings: [{ title: "[P2] Finding", body: "Concrete issue.", severity: "P2", code_location: { absolute_file_path: item.changedFiles[0], side: "RIGHT", line_range: { start: 1, end: 1 } } }] }, records = [
		{ type: "custom", customType: "pr-review-completed", data: { review, rawText: "# PR Review", laneArtifacts, synthesisQuality: "fully_parsed", completeness: "complete" } },
		{ type: "custom", customType: "pr-review-telemetry", data: { completion: "terminal_response", totalWallMs: 99, phases: { aggregateOrchestration: { elapsedMs: 17 } } } },
	];
	const collected = await collectSessionResult({ records, entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "", ghAudit: [{ write: false }], parseReview: () => review });
	assert.equal(collected.run.elapsedMs, 99); assert.equal(collected.run.timing.parentValidationSynthesisMs, 17); assert.equal(collected.run.lanes.length, 5); assert.ok(collected.run.lanes.every((lane) => lane.status === "complete" && lane.provider === "fixture" && lane.model === "lane")); assert.equal(collected.run.publication.artifact, "canonical"); assert.equal(collected.run.findings[0].location.path, item.changedFiles[0]);
	const failed = await collectSessionResult({ records: [], entry, item, mode: "balanced", elapsedMs: 120, startedAtUtc: "2026-08-28T00:00:00Z", stdout: "", stderr: "provider failed", ghAudit: [{ write: false }], parseReview: () => undefined });
	assert.equal(failed.run.publication.artifact, "raw_body_only"); assert.ok(failed.run.lanes.every((lane) => lane.status === "failed" && lane.elapsedMs === null && lane.provider === null)); assert.match(failed.markdown, /provider failed/);
});

test("collector executes exactly one next entry through the read-only gh shim", () => {
	const info = loadCorpus(CORPUS), plan = createPlan(info, ["balanced"], 1), root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-collector-")), planFile = path.join(root, "plan.json"), bundle = path.join(root, "bundle"), mockPi = path.join(root, "mock-pi.mjs"), first = plan.entries[0], passIds = ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"];
	fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
	fs.writeFileSync(mockPi, `#!/usr/bin/env node\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2),d=a[a.indexOf('--session-dir')+1];const g=spawnSync('gh',['repo','view','--json','nameWithOwner,url'],{encoding:'utf8'});if(g.status!==0)process.exit(9);fs.mkdirSync(d,{recursive:true});const ids=${JSON.stringify(passIds)};const lanes=ids.map(passId=>({passId,lifecycle:'complete',observedModel:'fixture/lane',startOffsetMs:1,endOffsetMs:11,attempts:[]}));const records=[{type:'session',version:3,id:'s',timestamp:'2026-08-28T00:00:00Z',cwd:process.cwd()},{type:'custom',customType:'pr-review-completed',data:{review:{findings:[]},rawText:'# PR Review\\n\\nNo findings.',laneArtifacts:lanes,synthesisQuality:'fully_parsed',completeness:'complete'}},{type:'custom',customType:'pr-review-telemetry',data:{completion:'terminal_response',totalWallMs:50,phases:{aggregateOrchestration:{elapsedMs:5}}}}];fs.writeFileSync(d+'/session.jsonl',records.map(JSON.stringify).join('\\n')+'\\n');process.stdout.write('# PR Review\\n\\nNo findings.\\n');\n`, { mode: 0o700 });
	const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim(); assert.ok(bun);
	const collect = spawnSync(bun, [path.resolve("tests/tooling/review-semantic-collect.mjs"), "--corpus", CORPUS, "--plan", planFile, "--bundle", bundle, "--entry", first.entryId, "--pi", mockPi, "--model", "fixture/parent", "--thinking", "high", "--acknowledge-real-model-run"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
	assert.equal(collect.status, 0, collect.stderr); const result = JSON.parse(fs.readFileSync(path.join(bundle, "runs", `${first.entryId}.json`), "utf8")); assert.equal(result.planEntryId, first.entryId); assert.equal(result.publication.artifact, "canonical"); assert.equal(result.configuration.model, "parent"); assert.equal(result.lanes.length, 5);
	const rerun = spawnSync(bun, [path.resolve("tests/tooling/review-semantic-collect.mjs"), "--corpus", CORPUS, "--plan", planFile, "--bundle", bundle, "--entry", first.entryId, "--pi", mockPi, "--model", "fixture/parent", "--thinking", "high", "--acknowledge-real-model-run"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }); assert.notEqual(rerun.status, 0); assert.match(rerun.stderr, /reruns are forbidden/);
});
