import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SELF_REVIEW_TOOL_NAME = "self_review_subagent";

const MAX_STATUS_BYTES = 1024 * 1024;
export const MAX_SELF_REVIEW_DELTA_BYTES = 4 * 1024 * 1024;
export const MAX_SELF_REVIEW_FILES = 200;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;

interface SessionBinding {
	readonly id: string;
	readonly startedAt: string;
}

interface PendingTask {
	readonly generation: number;
	readonly cwd: string;
	readonly session: SessionBinding;
}

export interface SelfReviewBaseline {
	readonly cwd: string;
	readonly canonicalCwd: string;
	readonly worktree: string;
	readonly head: string;
}

interface ArmedTask extends PendingTask, SelfReviewBaseline {
	readonly controller: AbortController;
}

export interface SelfReviewPermit extends SelfReviewBaseline {
	readonly generation: number;
	readonly signal: AbortSignal;
}

export type SelfReviewSeverity = "P0" | "P1" | "P2";

export interface SelfReviewFinding {
	readonly title: string;
	readonly severity: SelfReviewSeverity;
	readonly blocking: boolean;
	readonly impact: string;
	readonly trigger: string;
	readonly evidence: string;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly side: "LEFT" | "RIGHT";
	readonly inDiff: true;
	readonly prRelated: true;
	readonly confidence: number;
}

export interface SelfReviewReport {
	readonly findings: readonly SelfReviewFinding[];
}

const SELF_REVIEW_ROOT_KEYS = ["findings"] as const;
const SELF_REVIEW_FINDING_KEYS = [
	"blocking",
	"confidence",
	"endLine",
	"evidence",
	"impact",
	"inDiff",
	"path",
	"prRelated",
	"severity",
	"side",
	"startLine",
	"title",
	"trigger",
] as const;

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} must contain exactly: ${wanted.join(", ")}.`);
	}
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
		throw new Error(`Self-review finding ${field} must be a non-empty trimmed string.`);
	}
	return value;
}

/** Parse and structurally validate the only output accepted from a self-review child. */
export function parseSelfReviewOutput(text: string): SelfReviewReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Self-review output must be strict JSON with no Markdown wrapper.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Self-review output must be a JSON object.");
	}
	const root = parsed as Record<string, unknown>;
	exactObjectKeys(root, SELF_REVIEW_ROOT_KEYS, "Self-review output");
	if (!Array.isArray(root.findings)) throw new Error("Self-review output findings must be an array.");

	const findings = root.findings.map((raw, index): SelfReviewFinding => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`Self-review finding ${index} must be a JSON object.`);
		}
		const finding = raw as Record<string, unknown>;
		exactObjectKeys(finding, SELF_REVIEW_FINDING_KEYS, `Self-review finding ${index}`);
		const severity = finding.severity;
		if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
			throw new Error(`Self-review finding ${index} severity must be P0, P1, or P2.`);
		}
		const title = nonEmptyString(finding.title, "title");
		if (title.length > 80 || !title.startsWith(`[${severity}] `)) {
			throw new Error(`Self-review finding ${index} title must be at most 80 characters and match its severity tag.`);
		}
		if (finding.blocking !== (severity === "P0" || severity === "P1")) {
			throw new Error(`Self-review finding ${index} blocking must match its severity.`);
		}
		const findingPath = nonEmptyString(finding.path, "path");
		if (
			path.posix.isAbsolute(findingPath) ||
			findingPath.includes("\\") ||
			findingPath.includes("\0") ||
			path.posix.normalize(findingPath) !== findingPath ||
			findingPath === "." ||
			findingPath.startsWith("../")
		) {
			throw new Error(`Self-review finding ${index} path must be a normalized repo-relative POSIX path.`);
		}
		if (!Number.isInteger(finding.startLine) || (finding.startLine as number) < 1) {
			throw new Error(`Self-review finding ${index} startLine must be a positive integer.`);
		}
		if (!Number.isInteger(finding.endLine) || (finding.endLine as number) < (finding.startLine as number)) {
			throw new Error(`Self-review finding ${index} endLine must be an integer at or after startLine.`);
		}
		if (finding.side !== "LEFT" && finding.side !== "RIGHT") {
			throw new Error(`Self-review finding ${index} side must be LEFT or RIGHT.`);
		}
		if (finding.inDiff !== true || finding.prRelated !== true) {
			throw new Error(`Self-review finding ${index} must be in-diff and introduced or affected by the task delta.`);
		}
		if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
			throw new Error(`Self-review finding ${index} confidence must be between 0 and 1.`);
		}
		return {
			title,
			severity,
			blocking: finding.blocking as boolean,
			impact: nonEmptyString(finding.impact, "impact"),
			trigger: nonEmptyString(finding.trigger, "trigger"),
			evidence: nonEmptyString(finding.evidence, "evidence"),
			path: findingPath,
			startLine: finding.startLine as number,
			endLine: finding.endLine as number,
			side: finding.side,
			inDiff: true,
			prRelated: true,
			confidence: finding.confidence,
		};
	});
	return { findings };
}

function sessionBinding(ctx: Pick<ExtensionContext, "sessionManager">): SessionBinding | undefined {
	const id = ctx.sessionManager.getSessionId();
	const header = ctx.sessionManager.getHeader();
	return header?.id === id && typeof header.timestamp === "string"
		? { id, startedAt: header.timestamp }
		: undefined;
}

function sameSession(left: SessionBinding, right: SessionBinding | undefined): boolean {
	return !!right && left.id === right.id && left.startedAt === right.startedAt;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface ProcessResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
}

function gitExecutable(): string {
	if (process.platform === "win32" || !fs.existsSync("/usr/bin/git")) {
		throw new Error("Self-review requires the trusted POSIX Git executable at /usr/bin/git.");
	}
	return "/usr/bin/git";
}

function runGit(
	cwd: string,
	args: string[],
	maxStdoutBytes: number,
	signal?: AbortSignal,
	acceptedExitCodes: readonly number[] = [0],
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const proc = spawn(gitExecutable(), [
			"-c", "core.fsmonitor=false",
			"-c", "core.hooksPath=/dev/null",
			...args,
		], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: "/usr/bin:/bin",
				HOME: process.env.HOME,
				LANG: "C",
				LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finishError = (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			proc.kill("SIGKILL");
			reject(error);
		};
		const abort = () => finishError(new Error("Self-review Git inspection was aborted."));
		timer = setTimeout(
			() => finishError(new Error(`Self-review Git inspection exceeded ${GIT_INSPECTION_TIMEOUT_MS}ms.`)),
			GIT_INSPECTION_TIMEOUT_MS,
		);
		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxStdoutBytes) {
				finishError(new Error(`Self-review Git output exceeds the ${maxStdoutBytes}-byte safety limit.`));
				return;
			}
			stdout.push(chunk);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= MAX_GIT_STDERR_BYTES) stderr.push(chunk);
		});
		proc.on("error", (error) => finishError(error));
		proc.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			const code = exitCode ?? 1;
			if (!acceptedExitCodes.includes(code)) {
				reject(new Error(`Git inspection failed (exit ${code}): ${Buffer.concat(stderr).toString("utf8").trim() || "no error output"}`));
				return;
			}
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
		});
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

async function gitHead(worktree: string, signal?: AbortSignal): Promise<string> {
	const result = await runGit(worktree, ["rev-parse", "--verify", "HEAD"], 256, signal);
	const head = result.stdout.toString("utf8").trim().toLowerCase();
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) throw new Error("Self-review could not capture a valid Git HEAD.");
	return head;
}

async function gitStatus(worktree: string, signal?: AbortSignal): Promise<Buffer> {
	return (await runGit(
		worktree,
		["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
		MAX_STATUS_BYTES,
		signal,
	)).stdout;
}

export async function captureCleanSelfReviewBaseline(cwd: string): Promise<SelfReviewBaseline> {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = await fs.promises.realpath(resolvedCwd);
	const rootResult = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"], 16 * 1024);
	const reportedRoot = rootResult.stdout.toString("utf8").trim();
	if (!path.isAbsolute(reportedRoot)) throw new Error("Self-review Git worktree root is not absolute.");
	const worktree = await fs.promises.realpath(reportedRoot);
	if (!isWithin(worktree, canonicalCwd)) throw new Error("Self-review cwd is outside its canonical Git worktree.");

	const headBefore = await gitHead(worktree);
	const status = await gitStatus(worktree);
	const headAfter = await gitHead(worktree);
	if (headBefore !== headAfter) throw new Error("Git HEAD changed while self-review task authority was being prepared.");
	if (status.length > 0) {
		throw new Error("Self-review is available only when the Git worktree is clean at top-level task start.");
	}
	return { cwd: resolvedCwd, canonicalCwd, worktree, head: headBefore };
}

interface StatusEntry {
	readonly code: string;
	readonly path: string;
	readonly originalPath?: string;
}

function afterSpaces(record: string, count: number): string | undefined {
	let offset = 0;
	for (let index = 0; index < count; index++) {
		offset = record.indexOf(" ", offset);
		if (offset < 0) return undefined;
		offset++;
	}
	return record.slice(offset);
}

function statusEntries(status: Buffer): StatusEntry[] {
	const records = status.toString("utf8").split("\0").filter(Boolean);
	const entries: StatusEntry[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (record.startsWith("? ")) {
			const filePath = record.slice(2);
			if (!filePath) throw new Error("Self-review encountered malformed Git status output.");
			entries.push({ code: "??", path: filePath });
			continue;
		}
		const kind = record[0];
		if ((kind !== "1" && kind !== "2" && kind !== "u") || record[1] !== " ") {
			throw new Error("Self-review encountered malformed Git status output.");
		}
		const fields = record.split(" ");
		const code = fields[1];
		const submodule = fields[2];
		if (!code || !submodule || (!submodule.startsWith("N") && !submodule.startsWith("S"))) {
			throw new Error("Self-review encountered malformed Git status output.");
		}
		if (submodule.startsWith("S")) {
			throw new Error("Self-review fails closed when a submodule commit or worktree is changed or dirty.");
		}
		const filePath = afterSpaces(record, kind === "1" ? 8 : kind === "2" ? 9 : 10);
		if (!filePath) throw new Error("Self-review encountered malformed Git status output.");
		if (kind === "2") {
			const originalPath = records[++index];
			if (!originalPath) throw new Error("Self-review encountered an incomplete Git rename status.");
			entries.push({ code, path: filePath, originalPath });
		} else {
			entries.push({ code, path: filePath });
		}
	}
	return entries;
}

async function validateUntrackedPath(worktree: string, relativePath: string): Promise<void> {
	if (!relativePath || path.isAbsolute(relativePath) || !isWithin(worktree, path.resolve(worktree, relativePath))) {
		throw new Error("Self-review encountered an unsafe untracked path.");
	}
	const stat = await fs.promises.lstat(path.join(worktree, relativePath));
	if (!stat.isFile() && !stat.isSymbolicLink()) {
		throw new Error("Self-review supports only regular-file and symbolic-link untracked deltas.");
	}
}

export async function buildSelfReviewDelta(
	permit: SelfReviewPermit,
): Promise<{ delta: string; fileCount: number; bytes: number }> {
	const headBefore = await gitHead(permit.worktree, permit.signal);
	if (headBefore !== permit.head) throw new Error("Git HEAD changed after the top-level task started.");
	const statusBefore = await gitStatus(permit.worktree, permit.signal);
	const entries = statusEntries(statusBefore);
	if (entries.length === 0) throw new Error("There is no Git-visible working-tree delta to self-review.");
	if (entries.length > MAX_SELF_REVIEW_FILES) {
		throw new Error(`Self-review delta exceeds the ${MAX_SELF_REVIEW_FILES}-file safety limit.`);
	}
	const untracked = entries
		.filter((entry) => entry.code === "??")
		.map((entry) => entry.path);
	for (const relativePath of untracked) await validateUntrackedPath(permit.worktree, relativePath);

	const chunks: Buffer[] = [];
	let bytes = 0;
	const append = (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > MAX_SELF_REVIEW_DELTA_BYTES) {
			throw new Error(`Self-review delta exceeds the ${MAX_SELF_REVIEW_DELTA_BYTES}-byte safety limit.`);
		}
		chunks.push(chunk);
	};
	const tracked = await runGit(
		permit.worktree,
		["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", permit.head, "--"],
		MAX_SELF_REVIEW_DELTA_BYTES,
		permit.signal,
	);
	append(tracked.stdout);
	for (const relativePath of untracked) {
		const remaining = MAX_SELF_REVIEW_DELTA_BYTES - bytes;
		const diff = await runGit(
			permit.worktree,
			["diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--", "/dev/null", relativePath],
			remaining,
			permit.signal,
			[0, 1],
		);
		append(diff.stdout);
	}

	const statusAfter = await gitStatus(permit.worktree, permit.signal);
	const headAfter = await gitHead(permit.worktree, permit.signal);
	if (!statusBefore.equals(statusAfter) || headAfter !== permit.head) {
		throw new Error("Git worktree state changed while the self-review delta was being captured.");
	}
	if (bytes === 0) throw new Error("The Git-visible working-tree delta is empty.");
	return { delta: Buffer.concat(chunks).toString("utf8"), fileCount: entries.length, bytes };
}

/** Host-owned one-shot authority for one direct top-level interactive/RPC task. */
export class SelfReviewPermitCoordinator {
	private pending?: PendingTask;
	private armed?: ArmedTask;
	private running?: ArmedTask;
	private nextGeneration = 1;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
		private readonly reviewLoopActive: () => boolean,
	) {}

	private setVisible(visible: boolean): void {
		try {
			const current = this.pi.getActiveTools();
			const next = visible
				? current.includes(SELF_REVIEW_TOOL_NAME) ? current : [...current, SELF_REVIEW_TOOL_NAME]
				: current.filter((name) => name !== SELF_REVIEW_TOOL_NAME);
			if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
				this.pi.setActiveTools(next);
			}
		} catch {
			// Execute-time binding checks remain authoritative.
		}
	}

	noteTopLevelInput(
		source: "interactive" | "rpc" | "extension",
		streamingBehavior: "steer" | "followUp" | undefined,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): boolean {
		this.clear();
		const session = sessionBinding(ctx);
		if ((source !== "interactive" && source !== "rpc") || streamingBehavior !== undefined || !session) return false;
		this.pending = {
			generation: this.nextGeneration++,
			cwd: path.resolve(ctx.cwd),
			session,
		};
		return true;
	}

	async beginTask(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Promise<boolean> {
		const pending = this.pending;
		if (!pending || this.reviewLoopActive()) {
			this.clear();
			return false;
		}
		let baseline: SelfReviewBaseline;
		try {
			baseline = await captureCleanSelfReviewBaseline(ctx.cwd);
		} catch {
			if (this.pending === pending) this.clear();
			return false;
		}
		if (
			this.pending !== pending ||
			this.reviewLoopActive() ||
			pending.cwd !== path.resolve(ctx.cwd) ||
			!sameSession(pending.session, sessionBinding(ctx))
		) {
			if (this.pending === pending) this.clear();
			return false;
		}
		this.pending = undefined;
		this.armed = { ...pending, ...baseline, controller: new AbortController() };
		this.setVisible(true);
		return true;
	}

	async consume(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Promise<SelfReviewPermit | undefined> {
		const armed = this.armed;
		if (!armed) {
			this.setVisible(false);
			return undefined;
		}
		if (this.reviewLoopActive()) {
			this.clear();
			return undefined;
		}
		let canonicalCwd: string;
		let worktree: string;
		try {
			canonicalCwd = await fs.promises.realpath(path.resolve(ctx.cwd));
			const root = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"], 16 * 1024, armed.controller.signal);
			worktree = await fs.promises.realpath(root.stdout.toString("utf8").trim());
		} catch {
			if (this.armed === armed) this.clear();
			return undefined;
		}
		if (
			this.armed !== armed ||
			this.reviewLoopActive() ||
			armed.controller.signal.aborted ||
			armed.cwd !== path.resolve(ctx.cwd) ||
			armed.canonicalCwd !== canonicalCwd ||
			armed.worktree !== worktree ||
			!sameSession(armed.session, sessionBinding(ctx))
		) {
			if (this.armed === armed) this.clear();
			return undefined;
		}

		// This synchronous state transition is the atomic consume point. Concurrent
		// callers that completed the asynchronous binding check cannot both win.
		this.armed = undefined;
		this.running = armed;
		this.setVisible(false);
		return Object.freeze({
			generation: armed.generation,
			cwd: armed.cwd,
			canonicalCwd: armed.canonicalCwd,
			worktree: armed.worktree,
			head: armed.head,
			signal: armed.controller.signal,
		});
	}

	finish(permit: SelfReviewPermit): void {
		if (this.running?.generation !== permit.generation) return;
		this.running = undefined;
		this.setVisible(false);
	}

	clear(): void {
		this.armed?.controller.abort();
		this.running?.controller.abort();
		this.pending = undefined;
		this.armed = undefined;
		this.running = undefined;
		this.setVisible(false);
	}

	hideTool(): void {
		this.setVisible(false);
	}
}

export function selfReviewDeniedResult() {
	return {
		content: [{ type: "text" as const, text: "self_review_subagent has no active one-shot permit for this top-level user task." }],
		isError: true,
		details: { authorized: false },
	};
}
