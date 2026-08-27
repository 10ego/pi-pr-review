#!/usr/bin/env bun
/**
 * Explicit real-model semantic benchmark collector.
 *
 * Runs exactly one next plan entry against a local fixture repository and a
 * read-only gh shim. It never contacts or writes GitHub. Provider/model calls
 * are real and therefore require --acknowledge-real-model-run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectedModeTopology, loadCorpus, validatePlan } from "./review-semantic-benchmark.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "../..");
const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function invariant(condition, message) { if (!condition) throw new Error(`Semantic collector refused: ${message}`); }
function readJson(file) { const bytes = fs.readFileSync(file); return { bytes, value: JSON.parse(bytes.toString("utf8")) }; }
function writeExclusive(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
function parseArgs(argv) {
	const options = {}, boolean = new Set(["--acknowledge-real-model-run"]);
	for (let index = 0; index < argv.length;) {
		const key = argv[index++]; invariant(/^--[a-z-]+$/.test(key ?? "") && options[key] === undefined, `invalid argument ${key ?? "end"}`);
		if (boolean.has(key)) { options[key] = true; continue; }
		const value = argv[index++]; invariant(value !== undefined && !value.startsWith("--"), `missing value for ${key}`); options[key] = value;
	}
	const allowed = new Set(["--corpus", "--plan", "--bundle", "--entry", "--pi", "--model", "--thinking", "--acknowledge-real-model-run"]);
	invariant(Object.keys(options).every((key) => allowed.has(key)), "unknown argument");
	for (const key of ["--corpus", "--plan", "--bundle", "--entry", "--pi", "--model", "--thinking", "--acknowledge-real-model-run"]) invariant(options[key] !== undefined, `missing ${key}`);
	return options;
}
function run(command, args, options = {}) { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim(); }
function git(cwd, args) { return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } }); }

export function materializeOldFiles(diffText, directory) {
	const lines = diffText.split("\n"); let currentFile, oldLines, hunkSeen = false;
	const flush = () => {
		if (!currentFile) return;
		invariant(hunkSeen, `diff ${currentFile} has no hunks`);
		const file = path.join(directory, currentFile); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${oldLines.map((line) => line ?? "// Existing fixture context.").join("\n")}\n`);
	};
	for (let index = 0; index < lines.length; index++) {
		const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[index]);
		if (fileMatch) { flush(); invariant(fileMatch[1] === fileMatch[2], "fixture renames are unsupported"); currentFile = fileMatch[1]; oldLines = []; hunkSeen = false; continue; }
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
		if (!hunk) continue;
		invariant(currentFile, "hunk before file header"); hunkSeen = true; let oldLine = Number(hunk[1]); index++;
		for (; index < lines.length && !lines[index].startsWith("diff --git ") && !lines[index].startsWith("@@ "); index++) {
			const line = lines[index]; if (line === "" && index === lines.length - 1) break; if (line.startsWith("\\ No newline")) continue;
			if (line.startsWith("+") && !line.startsWith("+++")) continue;
			invariant(line.startsWith(" ") || line.startsWith("-"), `malformed hunk content ${line}`);
			oldLines[oldLine - 1] = line.slice(1); oldLine++;
		}
		index--;
	}
	flush();
}

function createFixtureRepository(corpusInfo, item, root) {
	const repo = path.join(root, "repo"); fs.mkdirSync(repo); git(repo, ["init", "--quiet"]);
	const diffFile = path.join(corpusInfo.root, item.diff), diffText = fs.readFileSync(diffFile, "utf8"); materializeOldFiles(diffText, repo);
	git(repo, ["add", "."]); git(repo, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "--quiet", "-m", "base"]);
	run("git", ["-c", "core.hooksPath=/dev/null", "apply", "--whitespace=nowarn", diffFile], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
	git(repo, ["add", "."]); git(repo, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "--quiet", "-m", "head"]);
	git(repo, ["remote", "add", "origin", "https://github.com/benchmark-fixture/review-corpus.git"]);
	return { repo, diffText, headSha: git(repo, ["rev-parse", "HEAD"]), baseSha: git(repo, ["rev-parse", "HEAD^"]) };
}

function installGhShim(directory) {
	const script = path.join(directory, "gh-shim.mjs"), wrapper = path.join(directory, "gh");
	fs.writeFileSync(script, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst a=process.argv.slice(2), c=JSON.parse(fs.readFileSync(process.env.BENCHMARK_GH_CONFIG,"utf8"));\nconst write=a.includes("--method")&&!a.some((v,i)=>v==="--method"&&a[i+1]==="GET")||["review","comment","merge","close","reopen","edit","create","delete"].some(x=>a.includes(x));\nconst done=(allowed,value,code=0)=>{fs.appendFileSync(process.env.BENCHMARK_GH_AUDIT,JSON.stringify({argv:a,allowed,write})+"\\n");if(value)process.stdout.write(typeof value==="string"?value:JSON.stringify(value));process.exit(code)};\nif(write)done(false,"write command rejected\\n",64);\nconst jq=a[a.indexOf("--jq")+1];\nif(a[0]==="pr"&&a[1]==="diff"&&a[2]==="1")done(true,fs.readFileSync(c.diffFile,"utf8"));\nif(a[0]==="pr"&&a[1]==="view"&&a[2]==="1")done(true,c.prView);\nif(a[0]==="repo"&&a[1]==="view"){if(jq===".url")done(true,c.repo.url+"\\n");if(jq===".nameWithOwner")done(true,c.repo.nameWithOwner+"\\n");done(true,c.repo)}\nif(a[0]==="api"){const endpoint=a.filter((v,i)=>!(["--hostname","--jq"].includes(a[i-1])||["api","--hostname","--jq","--paginate","--slurp"].includes(v))).at(-1);if(endpoint==="user")done(true,jq===".login"?c.login+"\\n":{login:c.login});if(endpoint===\`repos/\${c.repo.nameWithOwner}/pulls/1\`)done(true,c.pullApi);if(endpoint?.includes("/reviews?")||endpoint?.includes("/comments?"))done(true,a.includes("--slurp")?[[]]:[])}\ndone(false,"unsupported read command\\n",65);\n`);
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o700 }); fs.chmodSync(script, 0o500); return wrapper;
}

function providerModel(value) {
	if (typeof value !== "string" || !value.includes("/")) return { provider: null, model: null };
	const index = value.indexOf("/"); return { provider: value.slice(0, index), model: value.slice(index + 1).replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") };
}
function sessionRecords(sessionDirectory) {
	const files = fs.readdirSync(sessionDirectory).filter((name) => name.endsWith(".jsonl")); invariant(files.length === 1, `expected one session file, got ${files.length}`);
	const file = path.join(sessionDirectory, files[0]), records = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); return { file, records };
}
function assistantText(message) { return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : ""; }
function normalizeFindings(review) {
	if (!Array.isArray(review?.findings)) return [];
	return review.findings.map((finding) => {
		const location = finding?.code_location, range = location?.line_range;
		return { title: String(finding?.title ?? ""), body: String(finding?.body ?? ""), severity: String(finding?.severity ?? ""), location: location && typeof location.absolute_file_path === "string" && Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) && (location.side === "RIGHT" || location.side === "LEFT") ? { path: location.absolute_file_path, side: location.side, start: range.start, end: range.end } : null };
	});
}
function laneTiming(lane) {
	if (Number.isFinite(lane?.startOffsetMs) && Number.isFinite(lane?.endOffsetMs)) return Math.max(0, lane.endOffsetMs - lane.startOffsetMs);
	const attempts = Array.isArray(lane?.attempts) ? lane.attempts.filter((attempt) => Number.isFinite(attempt?.elapsedMs)) : [];
	return attempts.length > 0 ? attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) : null;
}
function observedLane(lane, id) {
	const observed = lane?.observedModel ?? [...(Array.isArray(lane?.attempts) ? lane.attempts : [])].reverse().find((attempt) => typeof attempt?.observedModel === "string")?.observedModel, identity = providerModel(observed);
	return { id, lens: id, status: ["complete", "partial", "timed_out", "failed"].includes(lane?.lifecycle) ? lane.lifecycle : "failed", elapsedMs: laneTiming(lane), provider: identity.provider, model: identity.model };
}

export async function collectSessionResult({ records, entry, item, mode, elapsedMs, startedAtUtc, stdout, stderr, ghAudit, parseReview }) {
	const topology = expectedModeTopology(mode), completed = [...records].reverse().find((record) => record?.type === "custom" && record.customType === "pr-review-completed")?.data, telemetry = [...records].reverse().find((record) => record?.type === "custom" && record.customType === "pr-review-telemetry" && record.data?.completion === "terminal_response")?.data;
	let review, markdown = "", laneArtifacts = [];
	if (plain(completed)) {
		markdown = typeof completed.rawText === "string" ? completed.rawText : stdout.trim(); laneArtifacts = Array.isArray(completed.laneArtifacts) ? completed.laneArtifacts : [];
		review = plain(completed.review) ? completed.review : parseReview(markdown);
	}
	const byId = new Map(laneArtifacts.map((lane) => [lane.passId, lane])), lanes = topology.passIds.map((id) => byId.has(id) ? observedLane(byId.get(id), id) : { id, lens: id, status: "failed", elapsedMs: null, provider: null, model: null });
	const quality = completed?.synthesisQuality, completeness = completed?.completeness, publication = quality === "fully_parsed" && completeness !== "incomplete" ? { artifact: "canonical", fallback: false } : quality === "raw" || !completed ? { artifact: "raw_body_only", fallback: true } : { artifact: "degraded", fallback: true };
	if (!markdown.trim()) markdown = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Review process produced no canonical Markdown.";
	const findings = normalizeFindings(review), parentTiming = Number.isFinite(telemetry?.phases?.aggregateOrchestration?.elapsedMs) ? telemetry.phases.aggregateOrchestration.elapsedMs : elapsedMs;
	return { run: { schemaVersion: 1, planEntryId: entry.entryId, caseId: entry.caseId, mode, repetition: entry.repetition, startedAtUtc, elapsedMs: Number.isFinite(telemetry?.totalWallMs) ? telemetry.totalWallMs : elapsedMs, timing: { parentValidationSynthesisMs: parentTiming }, configuration: null, lanes, publication, findings, artifacts: [] }, laneRaw: { laneArtifacts, telemetry: telemetry ?? null, ghAudit, process: { stdout, stderr } }, markdown };
}

async function spawnPi(pi, args, options) {
	const started = Date.now(); let stdout = "", stderr = "";
	const child = spawn(pi, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
	const outcome = await new Promise((resolve) => { child.once("error", (error) => resolve({ code: null, signal: null, error: error.message })); child.once("close", (code, signal) => resolve({ code, signal, error: null })); });
	return { ...outcome, stdout, stderr, elapsedMs: Date.now() - started };
}

async function main() {
	const options = parseArgs(process.argv.slice(2)), corpusInfo = loadCorpus(path.resolve(options["--corpus"])), planFile = path.resolve(options["--plan"]), planRead = readJson(planFile), plan = validatePlan(planRead.value, corpusInfo), entry = plan.entries.find((candidate) => candidate.entryId === options["--entry"]); invariant(entry, "entry is not in plan");
	const item = corpusInfo.corpus.cases.find((candidate) => candidate.id === entry.caseId), bundle = path.resolve(options["--bundle"]), runsDir = path.join(bundle, "runs"), artifactsDir = path.join(bundle, "artifacts"), resultFile = path.join(runsDir, `${entry.entryId}.json`);
	fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 }); invariant(!fs.existsSync(resultFile), "entry was already collected; reruns are forbidden");
	const entryIndex = plan.entries.indexOf(entry); for (let index = 0; index < entryIndex; index++) invariant(fs.existsSync(path.join(runsDir, `${plan.entries[index].entryId}.json`)), `prior plan entry ${plan.entries[index].entryId} is missing`);
	const planCopy = path.join(bundle, "plan.json"); if (!fs.existsSync(planCopy)) writeExclusive(planCopy, planRead.bytes); else invariant(sha256(fs.readFileSync(planCopy)) === sha256(planRead.bytes), "bundle plan differs");
	const pi = fs.realpathSync(options["--pi"]); invariant(path.isAbsolute(pi) && fs.lstatSync(pi).isFile() && (fs.lstatSync(pi).mode & 0o111) !== 0, "--pi must be an executable regular file");
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-semantic-"));
	try {
		const fixture = createFixtureRepository(corpusInfo, item, temp), sessionDir = path.join(temp, "sessions"), shimDir = path.join(temp, "bin"), auditFile = path.join(temp, "gh-audit.jsonl"), configFile = path.join(temp, "gh-config.json"); fs.mkdirSync(sessionDir); fs.mkdirSync(shimDir); installGhShim(shimDir); fs.writeFileSync(auditFile, "", { mode: 0o600 });
		const ghConfig = { diffFile: path.join(corpusInfo.root, item.diff), login: "benchmark-reviewer", repo: { nameWithOwner: "benchmark-fixture/review-corpus", url: "https://github.com/benchmark-fixture/review-corpus" }, prView: { number: 1, title: "Update implementation", body: "Refine behavior while preserving existing contracts.", state: "OPEN", isDraft: false, author: { login: "benchmark-author", is_bot: false }, baseRefName: "main", headRefName: "benchmark-change", headRefOid: fixture.headSha, mergeable: "MERGEABLE", url: "https://github.com/benchmark-fixture/review-corpus/pull/1", files: item.changedFiles.map((file) => ({ path: file })), comments: [], reviews: [] }, pullApi: { state: "open", draft: false, merged_at: null, title: "Update implementation", head: { sha: fixture.headSha }, user: { login: "benchmark-author" } } }; fs.writeFileSync(configFile, `${JSON.stringify(ghConfig)}\n`, { mode: 0o600 });
		const modeFlag = `--${entry.mode}`, prompt = `/pr-review 1 --no-comment ${modeFlag}`, args = ["--model", options["--model"], "--thinking", options["--thinking"], "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(REPOSITORY, "extensions/index.ts"), "--no-skills", "--no-prompt-templates", "--prompt-template", path.join(REPOSITORY, "prompts/pr-review.md"), "--no-context-files", "--no-approve", "-p", prompt], startedAtUtc = new Date().toISOString();
		const outcome = await spawnPi(pi, args, { cwd: fixture.repo, env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`, BENCHMARK_GH_CONFIG: configFile, BENCHMARK_GH_AUDIT: auditFile } }), audit = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(JSON.parse); invariant(audit.length > 0 && audit.every((record) => record.allowed === true && record.write === false), "gh shim observed a rejected/unknown/write command");
		let records = []; if (fs.readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"))) records = sessionRecords(sessionDir).records;
		const { parsePublishableReview } = await import("../../lib/pr-review-publish.ts"), parseReview = (markdown) => parsePublishableReview(markdown).review;
		const collected = await collectSessionResult({ records, entry, item, mode: entry.mode, elapsedMs: outcome.elapsedMs, startedAtUtc, stdout: outcome.stdout, stderr: outcome.stderr, ghAudit: audit, parseReview });
		const parentIdentity = providerModel(options["--model"]); invariant(parentIdentity.provider && parentIdentity.model, "--model must be provider/model"); collected.run.configuration = { provider: parentIdentity.provider, model: parentIdentity.model, thinking: options["--thinking"], toolPolicy: "mode-contract", reviewVersion: JSON.parse(fs.readFileSync(path.join(REPOSITORY, "package.json"), "utf8")).version, topology: expectedModeTopology(entry.mode) };
		const lanePath = `artifacts/${entry.entryId}-lane-artifacts.json`, reviewPath = `artifacts/${entry.entryId}-canonical-review.json`, lanePayload = { schemaVersion: 1, planEntryId: entry.entryId, lanes: collected.run.lanes, raw: collected.laneRaw }, reviewPayload = { schemaVersion: 1, planEntryId: entry.entryId, publication: collected.run.publication, findings: collected.run.findings, markdown: collected.markdown }, laneBytes = Buffer.from(`${JSON.stringify(lanePayload, null, 2)}\n`), reviewBytes = Buffer.from(`${JSON.stringify(reviewPayload, null, 2)}\n`);
		writeExclusive(path.join(bundle, lanePath), laneBytes); writeExclusive(path.join(bundle, reviewPath), reviewBytes); collected.run.artifacts = [{ kind: "lane-artifacts", path: lanePath, sha256: sha256(laneBytes), bytes: laneBytes.length }, { kind: "canonical-review", path: reviewPath, sha256: sha256(reviewBytes), bytes: reviewBytes.length }]; writeExclusive(resultFile, collected.run);
		console.log(`Collected ${entry.entryId} (${entry.mode}/${entry.caseId}); Pi exit ${outcome.code ?? "error"}, publication suppressed.`);
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
