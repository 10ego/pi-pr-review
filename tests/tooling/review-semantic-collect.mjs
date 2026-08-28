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
function removeTemp(directory) { if (!fs.existsSync(directory)) return; const unlock = (current) => { try { fs.chmodSync(current, 0o700); } catch {} for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const file = path.join(current, entry.name); if (entry.isDirectory()) unlock(file); else try { fs.chmodSync(file, 0o600); } catch {} } }; unlock(directory); fs.rmSync(directory, { recursive: true, force: true }); }
function parseArgs(argv) {
	const options = {}, boolean = new Set(["--acknowledge-real-model-run"]);
	for (let index = 0; index < argv.length;) {
		const key = argv[index++]; invariant(/^--[a-z0-9-]+$/.test(key ?? "") && options[key] === undefined, `invalid argument ${key ?? "end"}`);
		if (boolean.has(key)) { options[key] = true; continue; }
		const value = argv[index++]; invariant(value !== undefined && !value.startsWith("--"), `missing value for ${key}`); options[key] = value;
	}
	const allowed = new Set(["--corpus", "--plan", "--bundle", "--entry", "--pi", "--expected-pi-sha256", "--node", "--expected-node-sha256", "--expected-collector-runtime-sha256", "--model", "--thinking", "--acknowledge-real-model-run"]);
	invariant(Object.keys(options).every((key) => allowed.has(key)), "unknown argument");
	for (const key of ["--corpus", "--plan", "--bundle", "--entry", "--pi", "--expected-pi-sha256", "--node", "--expected-node-sha256", "--expected-collector-runtime-sha256", "--model", "--thinking", "--acknowledge-real-model-run"]) invariant(options[key] !== undefined, `missing ${key}`);
	return options;
}
function run(command, args, options = {}) { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim(); }
function git(cwd, args) { return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } }); }

export function materializeOldFiles(diffText, directory) {
	const lines = diffText.split("\n"); let currentFile, oldLines, hunkSeen = false;
	const flush = () => {
		if (!currentFile) return;
		invariant(hunkSeen, `diff ${currentFile} has no hunks`);
		const file = path.join(directory, currentFile); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${Array.from({ length: oldLines.length }, (_, index) => oldLines[index] ?? "// Existing fixture context.").join("\n")}\n`);
	};
	for (let index = 0; index < lines.length; index++) {
		const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[index]);
		if (fileMatch) { flush(); invariant(fileMatch[1] === fileMatch[2], "fixture renames are unsupported"); currentFile = fileMatch[1]; oldLines = []; hunkSeen = false; continue; }
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(lines[index]);
		if (!hunk) continue;
		invariant(currentFile, "hunk before file header"); hunkSeen = true; let oldLine = Number(hunk[1]);
		if (hunk[5] && oldLine > 1 && oldLines[oldLine - 2] === undefined) oldLines[oldLine - 2] = hunk[5];
		index++;
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
	const repo = path.join(root, "repo"); fs.mkdirSync(repo); git(repo, ["init", "--quiet", "--initial-branch=main"]);
	const diffFile = path.join(corpusInfo.root, item.diff), diffText = fs.readFileSync(diffFile, "utf8"); materializeOldFiles(diffText, repo);
	git(repo, ["add", "."]); git(repo, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "--quiet", "-m", "base"]); git(repo, ["switch", "--quiet", "-c", "benchmark-change"]);
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
	if (typeof value !== "string" || !value.includes("/")) return null;
	const index = value.indexOf("/"); return { provider: value.slice(0, index), model: value.slice(index + 1).replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") };
}
function sourceTreeHash() {
	const files = ["package.json"];
	for (const base of ["extensions", "lib", "prompts"]) { const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(path.relative(REPOSITORY, file).split(path.sep).join("/")); } }; walk(path.join(REPOSITORY, base)); }
	files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); return sha256(Buffer.from(files.map((file) => `${sha256(fs.readFileSync(path.join(REPOSITORY, file)))}  ${file}`).join("\n") + "\n"));
}
function piRuntimeHash(piFile) {
	let root = path.dirname(piFile);
	while (root !== path.dirname(root)) { const manifest = path.join(root, "package.json"); if (fs.existsSync(manifest)) { try { if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") break; } catch {} } root = path.dirname(root); }
	invariant(fs.existsSync(path.join(root, "package.json")) && fs.existsSync(path.join(root, "dist")), "could not resolve Pi package root/dist");
	const files = ["package.json"], walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); invariant(!entry.isSymbolicLink(), "Pi dist contains a symlink"); if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join("/")); } }; walk(path.join(root, "dist")); files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); return sha256(Buffer.from(files.map((file) => `${sha256(fs.readFileSync(path.join(root, file)))}  ${file}`).join("\n") + "\n"));
}
function prepareSourceSnapshot(temp) {
	const root = path.join(temp, "source"); fs.mkdirSync(root);
	for (const name of ["extensions", "lib", "prompts"]) fs.cpSync(path.join(REPOSITORY, name), path.join(root, name), { recursive: true }); fs.copyFileSync(path.join(REPOSITORY, "package.json"), path.join(root, "package.json"));
	const lock = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) lock(file); else fs.chmodSync(file, 0o400); } fs.chmodSync(directory, 0o500); }; lock(root); return root;
}
function prepareIsolatedAgent(temp, parentModel) {
	const sourceAgent = process.env.PI_CODING_AGENT_DIR ? path.resolve(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent"), sourceConfigFile = path.join(sourceAgent, "pr-review.json"), sourceAuthFile = path.join(sourceAgent, "auth.json"), sourceConfig = readJson(sourceConfigFile).value;
	const effectiveConfig = { tiers: sourceConfig.tiers ?? {}, fallbacks: sourceConfig.fallbacks ?? {}, thinkingLevels: sourceConfig.thinkingLevels ?? {}, toolPolicies: sourceConfig.toolPolicies ?? {}, tools: sourceConfig.tools ?? [], deadlines: sourceConfig.deadlines ?? {}, autoPostReviews: false, allowStalePublish: false, allowStaleApprovals: false, approveMaxPriorityLevel: "off", verificationBaselines: {}, extractFindings: false };
	const providers = new Set([providerModel(parentModel)?.provider]); for (const value of Object.values(effectiveConfig.tiers)) providers.add(providerModel(value)?.provider); for (const values of Object.values(effectiveConfig.fallbacks)) if (Array.isArray(values)) for (const value of values) providers.add(providerModel(value)?.provider); providers.delete(null);
	const sourceAuth = readJson(sourceAuthFile).value, auth = Object.fromEntries(Object.entries(sourceAuth).filter(([provider]) => providers.has(provider))); invariant(Object.keys(auth).length === providers.size, "provider auth is missing for a configured benchmark model");
	const home = path.join(temp, "home"), agent = path.join(home, ".pi", "agent"); fs.mkdirSync(agent, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(agent, "settings.json"), "{}\n", { mode: 0o600 }); fs.writeFileSync(path.join(agent, "pr-review.json"), `${JSON.stringify(effectiveConfig, null, 2)}\n`, { mode: 0o600 }); fs.writeFileSync(path.join(agent, "auth.json"), `${JSON.stringify(auth)}\n`, { mode: 0o600 });
	return { home, agent, effectiveConfig, configSha256: sha256(fs.readFileSync(path.join(agent, "pr-review.json"))) };
}
function sanitizedEnvironment(base, additions) {
	const env = { ...base, ...additions }; for (const key of Object.keys(env)) if (/^(?:GH_|GITHUB_|GIT_|SSH_|NPM_TOKEN|NODE_OPTIONS|BUN_OPTIONS)/.test(key)) delete env[key]; return env;
}
function sandboxProfile(temp) {
	invariant(process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec"), "real collection currently requires macOS sandbox-exec");
	const file = path.join(temp, "collector.sb"), source = `(version 1)\n(deny default)\n(deny file-read* (subpath (param \"USER_HOME\")))\n(deny file-write* (subpath (param \"USER_HOME\")))\n(deny file-write* (subpath (param \"BENCH_SOURCE\")))\n(deny process-exec (literal \"/usr/bin/security\"))\n(deny mach-lookup (global-name \"com.apple.securityd\"))\n(deny mach-lookup (global-name \"com.apple.securityd.xpc\"))\n(allow file-read*)\n(allow file-write* (subpath (param \"BENCH_TEMP\")))\n(allow file-write* (literal \"/dev/null\"))\n(allow process*)\n(allow signal (target self))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow network*)\n`;
	fs.writeFileSync(file, source, { mode: 0o500 }); return file;
}
function validSessionLifecycle(records, cwd) {
	const headers = records.filter((record) => record?.type === "session" && record.version === 3), assistants = records.filter((record) => record?.type === "message" && record.message?.role === "assistant");
	return headers.length === 1 && headers[0].cwd === cwd && assistants.length > 0 && assistants.at(-1).message?.stopReason === "stop";
}
function sessionRecords(sessionDirectory) {
	const files = fs.readdirSync(sessionDirectory).filter((name) => name.endsWith(".jsonl")); invariant(files.length === 1, `expected one session file, got ${files.length}`);
	const file = path.join(sessionDirectory, files[0]), bytes = fs.readFileSync(file), records = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); return { file, bytes, records };
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
function observedLane(lane, id, parentModel) {
	const attempt = [...(Array.isArray(lane?.attempts) ? lane.attempts : [])].reverse().find((candidate) => typeof candidate?.observedModel === "string"), observed = lane?.observedModel ?? attempt?.observedModel, requested = attempt?.requestedModel ?? lane?.requestedModel ?? parentModel, requestedIdentity = providerModel(requested), identity = providerModel(observed) ?? (typeof observed === "string" && observed.length > 0 && requestedIdentity ? { provider: requestedIdentity.provider, model: observed } : null);
	return { id, lens: id.replace(/-shard-[123]$/, ""), status: ["complete", "partial", "timed_out", "failed"].includes(lane?.lifecycle) ? lane.lifecycle : "failed", elapsedMs: laneTiming(lane), provider: identity?.provider ?? null, model: identity?.model ?? null };
}

export async function collectSessionResult({ records, entry, item, mode, parentModel = "fixture/parent", elapsedMs, startedAtUtc, stdout, stderr, ghAudit, processOutcome = { code: 0, signal: null, error: null }, sessionEvidence = null, parseReview }) {
	const topology = expectedModeTopology(mode, item), completedEntries = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-completed"), telemetryEntries = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-telemetry" && record.data?.completion === "terminal_response"), auditValid = ghAudit.length > 0 && ghAudit.every((record) => record?.allowed === true && record?.write === false), lifecycleValid = processOutcome.code === 0 && processOutcome.signal === null && processOutcome.error === null && completedEntries.length === 1 && telemetryEntries.length === 1, completed = lifecycleValid && auditValid ? completedEntries[0].data : undefined, telemetry = lifecycleValid && auditValid ? telemetryEntries[0].data : undefined;
	let review, markdown = "", laneArtifacts = [];
	if (plain(completed)) {
		markdown = typeof completed.rawText === "string" ? completed.rawText : stdout.trim(); laneArtifacts = Array.isArray(completed.laneArtifacts) ? completed.laneArtifacts : [];
		review = plain(completed.review) ? completed.review : parseReview(markdown);
	}
	const byId = new Map(laneArtifacts.map((lane) => [lane.passId, lane])), lanes = topology.passIds.map((id) => byId.has(id) ? observedLane(byId.get(id), id, parentModel) : { id, lens: id.replace(/-shard-[123]$/, ""), status: "failed", elapsedMs: null, provider: null, model: null });
	const quality = completed?.synthesisQuality, completeness = completed?.completeness, publication = quality === "fully_parsed" && completeness === "complete" && lanes.every((lane) => lane.status === "complete") ? { artifact: "canonical", fallback: false } : quality === "raw" || !completed ? { artifact: "raw_body_only", fallback: true } : { artifact: "degraded", fallback: true };
	if (!markdown.trim()) markdown = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Review process produced no canonical Markdown.";
	const findings = normalizeFindings(review), parentTiming = Number.isFinite(telemetry?.phases?.aggregateOrchestration?.elapsedMs) ? telemetry.phases.aggregateOrchestration.elapsedMs : elapsedMs, syntheticSessionBytes = records.length > 0 ? Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n") : null, session = sessionEvidence ?? { sha256: syntheticSessionBytes ? sha256(syntheticSessionBytes) : null, bytes: syntheticSessionBytes?.length ?? 0, recordCount: records.length, contentBase64: syntheticSessionBytes?.toString("base64") ?? null };
	return { run: { schemaVersion: 1, planEntryId: entry.entryId, caseId: entry.caseId, mode, repetition: entry.repetition, startedAtUtc, elapsedMs: Number.isFinite(telemetry?.totalWallMs) ? telemetry.totalWallMs : elapsedMs, timing: { parentValidationSynthesisMs: parentTiming }, configuration: null, lanes, publication, findings, artifacts: [] }, laneRaw: { laneArtifacts, telemetry: telemetry ?? null, resolvedReview: review ?? null, ghAudit, auditValid, process: { stdout, stderr, exitCode: processOutcome.code, signal: processOutcome.signal, error: processOutcome.error }, session }, markdown, operationallyValid: lifecycleValid && auditValid };
}

export async function spawnPi(pi, args, options, timeoutMs) {
	const started = Date.now(), outputLimit = 5 * 1024 * 1024; let stdout = "", stderr = "", timedOut = false;
	const append = (current, chunk) => { const next = current + chunk.toString("utf8"); return Buffer.byteLength(next) <= outputLimit ? next : Buffer.from(next).subarray(-outputLimit).toString("utf8"); };
	const child = spawn(pi, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
	let killTimer; const completion = new Promise((resolve) => { child.once("error", (error) => resolve({ code: null, signal: null, error: error.message })); child.once("close", (code, signal) => resolve({ code, signal, error: null })); }), forced = new Promise((resolve) => { const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} child.stdout.destroy(); child.stderr.destroy(); resolve({ code: null, signal: "SIGTERM", error: "collector-hard-timeout" }); }, 5_000); }, timeoutMs); completion.finally(() => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); }); });
	const outcome = await Promise.race([completion, forced]);
	return { ...outcome, ...(timedOut ? { code: null, signal: "SIGTERM", error: "collector-hard-timeout" } : {}), stdout, stderr, elapsedMs: Date.now() - started };
}

async function main() {
	const options = parseArgs(process.argv.slice(2)), corpusInfo = loadCorpus(path.resolve(options["--corpus"])), planFile = path.resolve(options["--plan"]), planRead = readJson(planFile), plan = validatePlan(planRead.value, corpusInfo), entry = plan.entries.find((candidate) => candidate.entryId === options["--entry"]); invariant(entry, "entry is not in plan");
	const item = corpusInfo.corpus.cases.find((candidate) => candidate.id === entry.caseId), bundle = path.resolve(options["--bundle"]), runsDir = path.join(bundle, "runs"), artifactsDir = path.join(bundle, "artifacts"), resultFile = path.join(runsDir, `${entry.entryId}.json`);
	fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 }); invariant(!fs.existsSync(resultFile), "entry was already collected; reruns are forbidden");
	const entryIndex = plan.entries.indexOf(entry); for (let index = 0; index < entryIndex; index++) invariant(fs.existsSync(path.join(runsDir, `${plan.entries[index].entryId}.json`)), `prior plan entry ${plan.entries[index].entryId} is missing`);
	const planCopy = path.join(bundle, "plan.json"); if (!fs.existsSync(planCopy)) writeExclusive(planCopy, planRead.bytes); else invariant(sha256(fs.readFileSync(planCopy)) === sha256(planRead.bytes), "bundle plan differs");
	const pi = fs.realpathSync(options["--pi"]), node = fs.realpathSync(options["--node"]), piBytes = fs.readFileSync(pi), nodeBytes = fs.readFileSync(node), piSha256 = sha256(piBytes), nodeSha256 = sha256(nodeBytes); invariant(path.isAbsolute(pi) && fs.lstatSync(pi).isFile(), "--pi must be a regular file"); invariant(path.isAbsolute(node) && fs.lstatSync(node).isFile() && (fs.lstatSync(node).mode & 0o111) !== 0, "--node must be an executable regular file"); invariant(SHA256.test(options["--expected-pi-sha256"]) && options["--expected-pi-sha256"] === piSha256, "Pi launcher hash differs from --expected-pi-sha256"); invariant(SHA256.test(options["--expected-node-sha256"]) && options["--expected-node-sha256"] === nodeSha256, "Node hash differs from --expected-node-sha256");
	const collectorRuntime = fs.realpathSync(process.execPath), collectorRuntimeSha256 = sha256(fs.readFileSync(collectorRuntime)); invariant(SHA256.test(options["--expected-collector-runtime-sha256"]) && options["--expected-collector-runtime-sha256"] === collectorRuntimeSha256, "collector runtime hash differs from --expected-collector-runtime-sha256");
	const piVersion = run(node, [pi, "--version"]), nodeVersion = run(node, ["--version"]), collectorRuntimeVersion = run(collectorRuntime, ["--version"]), piRuntimeSha256 = piRuntimeHash(pi), extensionSha256 = sourceTreeHash(), promptSha256 = sha256(fs.readFileSync(path.join(REPOSITORY, "prompts/pr-review.md"))), collectorSha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url))), temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-semantic-")));
	let consumedWithFailure = false;
	try {
		const fixture = createFixtureRepository(corpusInfo, item, temp), sourceSnapshot = prepareSourceSnapshot(temp), isolated = prepareIsolatedAgent(temp, options["--model"]), effectiveConfigFile = path.join(bundle, "effective-review-config.json"), effectiveConfigBytes = Buffer.from(`${JSON.stringify(isolated.effectiveConfig, null, 2)}\n`), profile = sandboxProfile(temp), sessionDir = path.join(temp, "sessions"), shimDir = path.join(temp, "bin"), auditFile = path.join(temp, "gh-audit.jsonl"), configFile = path.join(temp, "gh-config.json"); fs.mkdirSync(sessionDir); fs.mkdirSync(shimDir); if (!fs.existsSync(effectiveConfigFile)) writeExclusive(effectiveConfigFile, effectiveConfigBytes); else invariant(sha256(fs.readFileSync(effectiveConfigFile)) === sha256(effectiveConfigBytes), "effective review config changed within bundle"); installGhShim(shimDir); fs.writeFileSync(auditFile, "", { mode: 0o600 });
		const fixtureDiffFile = path.join(temp, "fixture.diff"); fs.writeFileSync(fixtureDiffFile, fixture.diffText, { mode: 0o400 });
		const ghConfig = { diffFile: fixtureDiffFile, login: "benchmark-reviewer", repo: { nameWithOwner: "benchmark-fixture/review-corpus", url: "https://github.com/benchmark-fixture/review-corpus" }, prView: { number: 1, title: "Update implementation", body: "Refine behavior while preserving existing contracts.", state: "OPEN", isDraft: false, author: { login: "benchmark-author", is_bot: false }, baseRefName: "main", headRefName: "benchmark-change", headRefOid: fixture.headSha, mergeable: "MERGEABLE", url: "https://github.com/benchmark-fixture/review-corpus/pull/1", files: item.changedFiles.map((file) => ({ path: file })), comments: [], reviews: [] }, pullApi: { state: "open", draft: false, merged_at: null, title: "Update implementation", head: { sha: fixture.headSha }, user: { login: "benchmark-author" } } }; fs.writeFileSync(configFile, `${JSON.stringify(ghConfig)}\n`, { mode: 0o600 });
		const modeFlag = `--${entry.mode}`, prompt = `/pr-review 1 --no-comment ${modeFlag}`, piArgs = ["--model", options["--model"], "--thinking", options["--thinking"], "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(sourceSnapshot, "extensions/index.ts"), "--no-skills", "--no-prompt-templates", "--prompt-template", path.join(sourceSnapshot, "prompts/pr-review.md"), "--no-context-files", "--no-approve", "-p", prompt], startedAtUtc = new Date().toISOString(), childEnv = sanitizedEnvironment(process.env, { HOME: isolated.home, PI_CODING_AGENT_DIR: isolated.agent, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`, BENCHMARK_GH_CONFIG: configFile, BENCHMARK_GH_AUDIT: auditFile, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(temp, "xdg-config"), XDG_CACHE_HOME: path.join(temp, "xdg-cache") }), sandboxArgs = ["-D", `USER_HOME=${os.homedir()}`, "-D", `BENCH_TEMP=${temp}`, "-D", `BENCH_SOURCE=${sourceSnapshot}`, "-f", profile, node, pi, ...piArgs];
		const { resolveReviewDeadlines } = await import(pathToFileURL(path.join(sourceSnapshot, "lib/pr-review-deadlines.ts")).href), resolvedDeadlines = resolveReviewDeadlines(isolated.effectiveConfig.deadlines);
		const outcome = await spawnPi("/usr/bin/sandbox-exec", sandboxArgs, { cwd: fixture.repo, env: childEnv }, resolvedDeadlines.config.totalMs + 30_000);
		const audit = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { allowed: false, write: null, malformed: true }; } });
		let records = [], sessionEvidence = null, lifecycleError = null;
		if (fs.readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"))) { try { const session = sessionRecords(sessionDir); records = session.records; sessionEvidence = { sha256: sha256(session.bytes), bytes: session.bytes.length, recordCount: records.length, contentBase64: session.bytes.toString("base64") }; if (!validSessionLifecycle(records, fixture.repo)) lifecycleError = "invalid host-authored Pi session lifecycle"; } catch (error) { lifecycleError = String(error); } }
		const processOutcome = lifecycleError ? { code: outcome.code, signal: outcome.signal, error: lifecycleError } : { code: outcome.code, signal: outcome.signal, error: outcome.error }, { parsePublishableReview } = await import("../../lib/pr-review-publish.ts"), parseReview = (markdown) => parsePublishableReview(markdown).review;
		const collected = await collectSessionResult({ records, entry, item, mode: entry.mode, parentModel: options["--model"], elapsedMs: outcome.elapsedMs, startedAtUtc, stdout: outcome.stdout, stderr: outcome.stderr, ghAudit: audit, processOutcome, sessionEvidence, parseReview });
		const parentIdentity = providerModel(options["--model"]); invariant(parentIdentity?.provider && parentIdentity?.model, "--model must be provider/model"); collected.run.configuration = { provider: parentIdentity.provider, model: parentIdentity.model, thinking: options["--thinking"], toolPolicy: "frozen-user-tools-with-host-no-write-overrides", reviewVersion: JSON.parse(fs.readFileSync(path.join(REPOSITORY, "package.json"), "utf8")).version, piVersion, piSha256, piRuntimeSha256, nodeVersion, nodeSha256, collectorRuntimeVersion, collectorRuntimeSha256, reviewConfigSha256: isolated.configSha256, extensionSha256, promptSha256, collectorSha256, topology: expectedModeTopology(entry.mode, item) };
		const lanePath = `artifacts/${entry.entryId}-lane-artifacts.json`, reviewPath = `artifacts/${entry.entryId}-canonical-review.json`, lanePayload = { schemaVersion: 1, planEntryId: entry.entryId, lanes: collected.run.lanes, raw: collected.laneRaw }, reviewPayload = { schemaVersion: 1, planEntryId: entry.entryId, publication: collected.run.publication, findings: collected.run.findings, markdown: collected.markdown }, laneBytes = Buffer.from(`${JSON.stringify(lanePayload, null, 2)}\n`), reviewBytes = Buffer.from(`${JSON.stringify(reviewPayload, null, 2)}\n`);
		writeExclusive(path.join(bundle, lanePath), laneBytes); writeExclusive(path.join(bundle, reviewPath), reviewBytes); collected.run.artifacts = [{ kind: "lane-artifacts", path: lanePath, sha256: sha256(laneBytes), bytes: laneBytes.length }, { kind: "canonical-review", path: reviewPath, sha256: sha256(reviewBytes), bytes: reviewBytes.length }]; writeExclusive(resultFile, collected.run);
		consumedWithFailure = !collected.operationallyValid; console.log(`Collected ${entry.entryId} (${entry.mode}/${entry.caseId}); Pi exit ${outcome.code ?? "error"}, publication suppressed${consumedWithFailure ? ", failed result retained" : ""}.`);
	} finally { removeTemp(temp); }
	if (consumedWithFailure) process.exitCode = 1;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
