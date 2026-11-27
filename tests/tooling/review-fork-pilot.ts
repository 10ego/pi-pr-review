// Run with bun from the repository root. The caller supplies a read-only Pi
// configuration and an evidence directory outside the reviewer-visible tree.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSubagentSystemPrompt, runReviewSubprocess } from "../../extensions/pr-review-subagent.ts";
import { checkpointArgs, compactReviewCheckpoint, FORK_TOOLS, prepareGeneralReview, withCheckpointDirectory, type CheckpointStep } from "../../lib/pr-review-fork.ts";
import { monotonicNow } from "../../lib/pr-review-telemetry.ts";

interface PilotEvent {
	type?: string;
	id?: string;
	success?: boolean;
	message?: { role?: string; model?: string; usage?: unknown };
	data?: { usage?: unknown };
	toolName?: string;
	args?: { path?: string; offset?: number; limit?: number };
}

async function sessionEntries(file: string) {
	return (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
}

async function verifyNativeForks(directory: string, source: string, expected: number) {
	const [header, ...history] = await sessionEntries(source);
	const ids = new Set<string>();
	for (const name of await readdir(directory)) {
		if (!name.endsWith(".jsonl")) continue;
		const [child, ...entries] = await sessionEntries(join(directory, name));
		if (child.parentSession !== source) continue;
		if (child.id === header.id || JSON.stringify(entries.slice(0, history.length)) !== JSON.stringify(history)) {
			throw new Error("Fork did not preserve the complete checkpoint");
		}
		if (entries.length <= history.length) throw new Error("Fork never appended its own turn");
		ids.add(child.id);
	}
	if (ids.size !== expected) throw new Error("Expected a distinct native session for each specialist");
	return { forks: ids.size, inheritedEntries: history.length };
}

const [pi, model, output, order = "AB"] = process.argv.slice(2);
if (order !== "AB" && order !== "BA") throw new Error("Starting order must be AB or BA");
if (!pi || !model || !output || !process.env.PI_CODING_AGENT_DIR) throw new Error("Supply PI_CODING_AGENT_DIR, Pi executable, model and a new output directory");
const agentSettings = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
const keepRecentTokens = agentSettings.compaction?.keepRecentTokens ?? 20_000;
const piVersion = execFileSync(pi, ["--version"], { encoding: "utf8" }).trim();
const evidence = resolve(output);
await mkdir(evidence, { mode: 0o700 });
const modelArgs = ["--model", model, "--thinking", "low", "--tools", FORK_TOOLS.join(",")];
const lenses = ["State transitions, lifecycle and ordering", "API, data and integration contracts"];
for (const [index, revision] of ["3e2753c", "e8339a0"].entries()) {
	const cwd = await mkdtemp(join(tmpdir(), "review-snapshot-"));
	try {
		const archive = execFileSync("git", ["archive", revision], { maxBuffer: 64 << 20 });
		execFileSync("tar", ["-xf", "-", "-C", cwd], { input: archive });
		const diff = execFileSync("git", ["diff", revision + "^", revision], { encoding: "utf8", maxBuffer: 8 << 20 });
		const diffFile = join(cwd, "review.diff");
		await writeFile(diffFile, diff);
		const observations: object[] = [];
		await withCheckpointDirectory(async seed => {
			const step = (label: string): CheckpointStep => async (args, input, responseId) => {
				const start = monotonicNow();
				const usage: unknown[] = [];
				const reads: unknown[] = [];
				const result = await runReviewSubprocess(pi, args, cwd, input, undefined, () => {}, raw => {
					const e = raw as PilotEvent;
					if (e.type === "message_end" && e.message?.role === "assistant") usage.push({ model: e.message.model, usage: e.message.usage });
					if (e.type === "response" && e.id === responseId && e.success) usage.push({ model, usage: e.data?.usage });
					if (e.type === "tool_execution_start") reads.push({ tool: e.toolName, path: e.args?.path, offset: e.args?.offset, limit: e.args?.limit });
				}, { deadlineMs: start + 240_000, terminationGraceMs: 1000, cleanupReserveMs: 1000 }, responseId);
				observations.push({ label, elapsedMs: monotonicNow() - start, usage, reads, output: result.text, stop: result.stopReason, error: result.errorMessage, exit: result.exitCode });
				console.log(revision, label, Math.round((monotonicNow() - start) / 1000) + "s", result.stopReason ?? "rpc", result.errorMessage ?? "");
				return result;
			};
			try {
				await prepareGeneralReview(seed, modelArgs, diff, step("general"));
				const fingerprint = () => readFile(seed.path).then(b => createHash("sha256").update(b).digest("hex"));
				const digest = await fingerprint();
				const directFirst = (index % 2 === 0) === (order === "AB");
				for (const arm of directFirst ? ["direct", "compact"] : ["compact", "direct"]) {
					const start = monotonicNow();
					let checkpoint = seed;
					if (arm === "compact") {
						try {
							checkpoint = await compactReviewCheckpoint(seed, modelArgs, step("compaction"));
						} catch (error) {
							if (!(error instanceof Error) || !/nothing to compact/i.test(error.message)) throw error;
							observations.push({ arm, skipped: error.message, seedSha256: digest });
							continue;
						}
					}
					const results = await Promise.all(lenses.map((lens, i) => step(arm + "-" + i)(
						[...checkpointArgs(checkpoint, true), ...modelArgs],
						buildSubagentSystemPrompt("heavy", true) + "\n\nObjective: " + lens + ". Review the historical change. Original diff available at " + diffFile,
					)));
					if (await fingerprint() !== digest) throw new Error("Specialist changed the shared checkpoint");
					const elapsedMs = monotonicNow() - start;
					const lineage = await verifyNativeForks(seed.directory, checkpoint.path, lenses.length);
					observations.push({ arm, elapsedMs, seedSha256: digest, ...lineage });
					if (results.some(r => r.exitCode !== 0 || r.stopReason !== "stop")) throw new Error("Incomplete specialist run");
				}
			} finally {
				await writeFile(join(evidence, revision + ".json"), JSON.stringify({ revision, model, piVersion, keepRecentTokens, order, observations }, null, 2), { flag: "wx", mode: 0o600 });
			}
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}
