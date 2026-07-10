/**
 * pr-review-subagent
 *
 * Adds configurable, tiered review subagents to the /pr-review workflow.
 *
 * - Config surface: `pr-review.json` (user: ~/.pi/agent, project: <repo>/.pi) maps
 *   the labels `light` / `medium` / `heavy` to whatever models you choose,
 *   plus optional per-tier fallback chains for quota/capacity failures.
 *   No model names are hardcoded here — you configure them.
 * - Tool: `review_subagent` spawns one isolated `pi` subprocess on the model
 *   bound to the requested tier and returns its review report.
 * - Tool: `review_subagents` accepts multiple pass assignments with shared PR
 *   context and runs those isolated subprocesses concurrently with bounded
 *   parallelism, returning deterministic per-pass results.
 * - Command: `/pr-review-config` shows or edits the tier→model mapping.
 *
 * The orchestrating /pr-review prompt dispatches passes by tier label:
 *   light  -> overview / strengths / high-level risk scan
 *   medium -> convention compliance + readability / maintainability
 *   heavy  -> bug + security/logic review
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Tier = "light" | "medium" | "heavy";
const TIERS: Tier[] = ["light", "medium", "heavy"];

const UNSET = "(unset — pi default)";
const TOOLS_PRESETS = ["read,bash,grep,find,ls", "read,grep,find,ls", "read"];
const DEFAULT_BATCH_PARALLEL = 4;
const MAX_BATCH_PARALLEL = 6;
const TIER_PURPOSE: Record<Tier, string> = {
	light: "overview / strengths / high-level risk scan",
	medium: "convention compliance + readability / maintainability",
	heavy: "bug + security/logic review",
};

interface PrReviewConfig {
	/** Tier label -> model spec (e.g. "anthropic/model", "openai/model:high"). */
	tiers: Partial<Record<Tier, string>>;
	/** Tier label -> ordered fallback model specs used for quota/capacity failures. */
	fallbacks: Partial<Record<Tier, string[]>>;
	/** Tools granted to each review subagent process. */
	tools: string[];
}

const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"];
const CONFIG_FILENAME = "pr-review.json";

function userConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILENAME);
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

function readConfigFile(filePath: string): Partial<PrReviewConfig> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return typeof parsed === "object" && parsed ? (parsed as Partial<PrReviewConfig>) : {};
	} catch {
		return {};
	}
}

function normalizeFallbacks(
	raw: Partial<Record<Tier, unknown>> | undefined,
	preserveEmpty = false,
): Partial<Record<Tier, string[]>> {
	const out: Partial<Record<Tier, string[]>> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const tier of TIERS) {
		const value = raw[tier];
		if (value === undefined) continue;
		const list = Array.isArray(value)
			? value.map((v) => String(v).trim()).filter(Boolean)
			: typeof value === "string"
				? value.split(",").map((v) => v.trim()).filter(Boolean)
				: [];
		if (list.length > 0 || preserveEmpty) out[tier] = [...new Set(list)];
	}
	return out;
}

/** User config, overlaid by project config when the project is trusted. */
function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): PrReviewConfig {
	const user = readConfigFile(userConfigPath());
	let project: Partial<PrReviewConfig> = {};
	try {
		if (ctx.isProjectTrusted()) project = readConfigFile(projectConfigPath(ctx.cwd));
	} catch {
		/* trust check unavailable -> user config only */
	}
	return {
		tiers: { ...(user.tiers ?? {}), ...(project.tiers ?? {}) },
		fallbacks: { ...normalizeFallbacks(user.fallbacks, true), ...normalizeFallbacks(project.fallbacks, true) },
		tools: project.tools ?? user.tools ?? DEFAULT_TOOLS,
	};
}

/** User-level config only (the scope the config command edits), with defaults. */
function readUserConfig(): PrReviewConfig {
	const raw = readConfigFile(userConfigPath());
	return {
		tiers: { ...(raw.tiers ?? {}) },
		fallbacks: normalizeFallbacks(raw.fallbacks),
		tools: raw.tools ?? [...DEFAULT_TOOLS],
	};
}

function writeUserConfig(next: PrReviewConfig): string {
	const filePath = userConfigPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

interface ModelAttempt {
	spec?: string;
	usedTier?: Tier;
	kind: "primary" | "fallback" | "nearest" | "default";
	fallbackIndex?: number;
}

const NEAREST_TIER_ORDER: Record<Tier, Tier[]> = {
	light: ["light", "medium", "heavy"],
	medium: ["medium", "heavy", "light"],
	heavy: ["heavy", "medium", "light"],
};

/** Resolve the ordered model attempts for a tier, preserving nearest-tier/default behavior when the tier is unset. */
function resolveModelAttempts(config: PrReviewConfig, tier: Tier): ModelAttempt[] {
	const attempts: ModelAttempt[] = [];
	const seen = new Set<string>();
	const add = (attempt: ModelAttempt) => {
		const key = attempt.spec ?? "__pi_default__";
		if (seen.has(key)) return;
		seen.add(key);
		attempts.push(attempt);
	};

	const primary = config.tiers[tier];
	if (primary) {
		add({ spec: primary, usedTier: tier, kind: "primary" });
	} else {
		let foundNearest = false;
		for (const candidate of NEAREST_TIER_ORDER[tier]) {
			const spec = config.tiers[candidate];
			if (!spec) continue;
			add({ spec, usedTier: candidate, kind: "nearest" });
			foundNearest = true;
			break;
		}
		if (!foundNearest) add({ kind: "default" });
	}

	for (const [index, spec] of (config.fallbacks[tier] ?? []).entries()) {
		add({ spec, usedTier: tier, kind: "fallback", fallbackIndex: index });
	}

	return attempts;
}

// ---------------------------------------------------------------------------
// Subprocess plumbing (mirrors the official subagent example)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

const TIER_GUIDANCE: Record<Tier, string> = {
	light:
		"You are a fast overview reviewer. Produce a concise overview of what the change does and how, list genuine strengths, and note high-level risk areas worth closer specialist review. Do not deep-dive into defects.",
	medium:
		"You are a balanced convention, readability, and maintainability reviewer. Follow the assigned objective exactly: apply only in-scope repository convention files and capture clear maintainability/readability issues without duplicating deep correctness or security analysis.",
	heavy:
		"You are a rigorous specialist reviewer for correctness, security, performance, and logic. Follow the assigned objective exactly, validate each candidate before reporting, and drop anything that is actually correct or that you cannot substantiate.",
};

function buildSubagentSystemPrompt(tier: Tier): string {
	const lines = [
		"You are an isolated code-review subagent invoked by the /pr-review orchestrator.",
		TIER_GUIDANCE[tier],
		"",
		"Stay inside the assigned objective. Within that objective, surface EVERY issue the author would want to know about — from trivial nits up to blocking defects. Do not discard minor issues; classify them by severity instead. Only leave out non-issues: things that are actually correct, unsubstantiated speculation, or subjective preferences with no concrete benefit.",
		"Stay strictly in PR scope: only report issues caused by or directly relevant to this PR's diff (the changed lines and the code they provably affect). Do NOT flag pre-existing issues in untouched code or audit the wider codebase; if a problem existed before this change, leave it out. Reading surrounding files/callers is for context and confirmation only.",
	];
	if (tier === "light") {
		lines.push(
			"Return concise Markdown with two sections:",
			"- 'Overview:' 1-3 short paragraphs on what the PR does and author intent.",
			"- 'Strengths:' a bullet list of genuine strengths (or 'none').",
		);
	} else {
		lines.push(
			"Return your findings as a concise Markdown list. For each finding include, on its own lines:",
			"- title: an imperative summary prefixed with a severity tag [P0]|[P1]|[P2]|[P3]|[nit]",
			"- severity: one of P0, P1, P2, P3, nit (P0/P1 are blocking)",
			"- why: the impact and the exact input/environment needed for it to bite",
			"- location: <repo-relative file path>:<start-end lines exactly as they appear in the diff> (or 'repo-wide')",
			"- side: RIGHT for added/context lines, LEFT for removed lines",
			"- in_diff: yes if those lines are inside the PR diff (so an inline comment can be posted), otherwise no",
			"- pr_related: yes only if this PR introduces or provably affects the issue (drop pre-existing/unrelated issues)",
			"- confidence: a float 0.0-1.0",
			"If there are genuinely no findings at any severity, reply exactly with: NO FINDINGS.",
		);
	}
	lines.push("Do not attempt to post GitHub comments or modify files. Reviewing only.");
	return lines.join("\n");
}

async function writeTempPrompt(tier: Tier, body: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pr-review-"));
	const filePath = path.join(dir, `system-${tier}.md`);
	await fs.promises.writeFile(filePath, body, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

interface RunResult {
	text: string;
	exitCode: number;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

function runReviewSubprocess(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onText: (text: string) => void,
): Promise<RunResult> {
	return new Promise<RunResult>((resolve) => {
		const messages: Message[] = [];
		const result: RunResult = { text: "", exitCode: 0, stderr: "" };
		let buffer = "";
		let aborted = false;

		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				messages.push(event.message);
				if (event.message.role === "assistant") {
					if (event.message.model) result.model = event.message.model;
					if (event.message.stopReason) result.stopReason = event.message.stopReason;
					if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
					const t = finalAssistantText(messages);
					if (t) onText(t);
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.text = finalAssistantText(messages);
			result.exitCode = code ?? 0;
			if (aborted) result.stopReason = "aborted";
			resolve(result);
		});
		proc.on("error", (err) => {
			result.exitCode = 1;
			result.errorMessage = err.message;
			resolve(result);
		});

		if (signal) {
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

interface SubagentPassRequest {
	id?: string;
	tier: Tier;
	objective: string;
	context?: string;
}

interface ModelAttemptReport {
	kind: ModelAttempt["kind"];
	spec?: string;
	usedTier?: Tier;
	model?: string;
	exitCode: number;
	status: "completed" | "failed";
	retryable: boolean;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentPassResult {
	id: string;
	tier: Tier;
	usedTier?: Tier;
	model?: string;
	exitCode: number;
	status: "completed" | "failed";
	notice: string;
	text: string;
	stderr?: string;
	stopReason?: string;
	errorMessage?: string;
	attempts: ModelAttemptReport[];
	fallbackUsed: boolean;
	retryableFailure: boolean;
}

function noticeForAttempt(tier: Tier, attempt: ModelAttempt): string {
	if (!attempt.spec) {
		return `tier=${tier} (no tier configured; using pi default model — run /pr-review-config to set tiers)`;
	}
	if (attempt.kind === "fallback") {
		return `tier=${tier} fallback #${(attempt.fallbackIndex ?? 0) + 1} model=${attempt.spec}`;
	}
	if (attempt.usedTier && attempt.usedTier !== tier) {
		return `tier=${tier} (not configured; using ${attempt.usedTier} model=${attempt.spec})`;
	}
	return `tier=${tier} model=${attempt.spec}`;
}

function noticeForResult(tier: Tier, attempts: ModelAttemptReport[], finalNotice: string): string {
	const failedBeforeSuccess = attempts.filter((a) => a.status === "failed").length;
	if (failedBeforeSuccess > 0 && attempts.some((a) => a.status === "completed")) {
		return `${finalNotice} (after ${failedBeforeSuccess} retry${failedBeforeSuccess === 1 ? "" : "ies"})`;
	}
	return finalNotice;
}

function buildPassTask(objective: string, context: string | undefined): string {
	return context ? `Objective: ${objective}\n\n--- PR context / diff ---\n${context}` : `Objective: ${objective}`;
}

function isRetryableModelFailure(result: RunResult): boolean {
	if (result.stopReason === "aborted") return false;
	const haystack = [result.errorMessage, result.stderr, result.text, result.stopReason]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	if (!haystack) return false;
	return /(?:\b429\b|rate[\s_-]*limit(?:ed)?|too many requests|quota|usage[\s_-]*limit|insufficient[\s_-]*quota|resource[\s_-]*exhausted|out of credits|insufficient credits|credit limit|billing quota|billing hard limit|at capacity|overloaded|temporarily unavailable|model (?:is )?(?:temporarily|currently) unavailable|service unavailable|try again later)/i.test(
		haystack,
	);
}

async function runSubagentAttempt(
	config: PrReviewConfig,
	ctx: Pick<ExtensionContext, "cwd">,
	pass: SubagentPassRequest,
	attempt: ModelAttempt,
	signal: AbortSignal | undefined,
	onText?: (text: string) => void,
): Promise<{ result: RunResult; notice: string }> {
	let tmp: { dir: string; filePath: string } | undefined;
	try {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (attempt.spec) args.push("--model", attempt.spec);
		if (config.tools.length > 0) args.push("--tools", config.tools.join(","));

		tmp = await writeTempPrompt(pass.tier, buildSubagentSystemPrompt(pass.tier));
		args.push("--append-system-prompt", tmp.filePath);
		args.push(buildPassTask(pass.objective, pass.context));

		const invocation = getPiInvocation(args);
		const result = await runReviewSubprocess(invocation.command, invocation.args, ctx.cwd, signal, (text) => {
			onText?.(text);
		});
		return { result, notice: noticeForAttempt(pass.tier, attempt) };
	} catch (e) {
		return {
			result: { text: "", exitCode: 1, stderr: "", errorMessage: errMessage(e) },
			notice: noticeForAttempt(pass.tier, attempt),
		};
	} finally {
		if (tmp) {
			try {
				fs.rmSync(tmp.dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

async function runSubagentPass(
	config: PrReviewConfig,
	ctx: Pick<ExtensionContext, "cwd">,
	pass: SubagentPassRequest,
	signal: AbortSignal | undefined,
	onText?: (text: string) => void,
): Promise<SubagentPassResult> {
	const tier = pass.tier;
	const attempts = resolveModelAttempts(config, tier);
	const reports: ModelAttemptReport[] = [];
	let lastResult: RunResult | undefined;
	let lastNotice = noticeForAttempt(tier, attempts[0]!);

	for (const attempt of attempts) {
		const { result, notice } = await runSubagentAttempt(config, ctx, pass, attempt, signal, onText);
		const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const retryable = failed && isRetryableModelFailure(result);
		lastResult = result;
		lastNotice = notice;
		reports.push({
			kind: attempt.kind,
			spec: attempt.spec,
			usedTier: attempt.usedTier,
			model: result.model ?? attempt.spec,
			exitCode: result.exitCode,
			status: failed ? "failed" : "completed",
			retryable,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
		});

		if (!failed) {
			return {
				id: pass.id ?? tier,
				tier,
				usedTier: attempt.usedTier,
				model: result.model ?? attempt.spec,
				exitCode: result.exitCode,
				status: "completed",
				notice: noticeForResult(tier, reports, notice),
				text: result.text || "NO FINDINGS.",
				stderr: result.stderr || undefined,
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
				attempts: reports,
				fallbackUsed: attempt.kind === "fallback" || reports.length > 1,
				retryableFailure: false,
			};
		}

		if (!retryable || signal?.aborted) break;
	}

	const final = lastResult ?? { text: "", exitCode: 1, stderr: "", errorMessage: "No model attempts were available." };
	return {
		id: pass.id ?? tier,
		tier,
		usedTier: reports.at(-1)?.usedTier,
		model: reports.at(-1)?.model,
		exitCode: final.exitCode,
		status: "failed",
		notice: noticeForResult(tier, reports, lastNotice),
		text: final.text || "",
		stderr: final.stderr || undefined,
		stopReason: final.stopReason,
		errorMessage: final.errorMessage,
		attempts: reports,
		fallbackUsed: reports.length > 1,
		retryableFailure: reports.at(-1)?.retryable ?? false,
	};
}

function normalizeMaxParallel(raw: unknown, count: number): number {
	if (count <= 0) return 0;
	const requested = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH_PARALLEL;
	return Math.max(1, Math.min(count, MAX_BATCH_PARALLEL, requested > 0 ? requested : DEFAULT_BATCH_PARALLEL));
}

async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

function formatAttemptSummary(result: SubagentPassResult): string {
	if (result.attempts.length <= 1) return "";
	return `attempts: ${result.attempts
		.map((a) => `${a.status === "completed" ? "✓" : a.retryable ? "↻" : "✗"} ${a.spec ?? "pi default"}`)
		.join(" → ")}`;
}

function formatBatchResults(results: SubagentPassResult[], maxParallel: number): string {
	const failed = results.filter((r) => r.status === "failed");
	const lines = [
		`Review subagents completed: ${results.length - failed.length}/${results.length} succeeded (max_parallel=${maxParallel}).`,
	];
	if (failed.length) {
		lines.push(
			`WARNING: ${failed.length} pass(es) failed. Treat this as incomplete review evidence unless you rerun or cover the failed pass inline.`,
		);
	}
	for (const result of results) {
		lines.push("", `## Pass: ${result.id}`, `status: ${result.status}`, result.notice);
		const attemptSummary = formatAttemptSummary(result);
		if (attemptSummary) lines.push(attemptSummary);
		if (result.status === "failed") {
			const detail = result.errorMessage || result.stderr || result.text || "(no output)";
			lines.push(`error: ${detail}`);
			continue;
		}
		lines.push(result.text || "NO FINDINGS.");
	}
	return lines.join("\n");
}

function combineContexts(shared: string | undefined, specific: string | undefined): string | undefined {
	const parts: string[] = [];
	if (shared?.trim()) parts.push(shared.trim());
	if (specific?.trim()) parts.push(`--- Pass-specific context ---\n${specific.trim()}`);
	return parts.length ? parts.join("\n\n") : undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const ReviewSubagentParams = Type.Object({
	tier: StringEnum(["light", "medium", "heavy"] as const, {
		description:
			"Model tier / subagent label. light = overview & risk scan; medium = conventions/readability; heavy = correctness/security/performance.",
	}),
	objective: Type.String({
		description: "Precise instruction for this subagent — what to review and what to return.",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"Shared context for the subagent, typically the PR title/description plus the unified diff to review.",
		}),
	),
});

const ReviewSubagentsParams = Type.Object({
	context: Type.Optional(
		Type.String({
			description:
				"Shared PR context for every pass, typically PR title/body/metadata, in-scope convention-file summaries, and the unified diff.",
		}),
	),
	max_parallel: Type.Optional(
		Type.Number({
			description: `Maximum pass subprocesses to run concurrently. Defaults to ${DEFAULT_BATCH_PARALLEL}; capped at ${MAX_BATCH_PARALLEL}.`,
		}),
	),
	passes: Type.Array(
		Type.Object({
			id: Type.Optional(
				Type.String({
					description: "Stable pass label used in the ordered batch result, e.g. overview, conventions, correctness.",
				}),
			),
			tier: StringEnum(["light", "medium", "heavy"] as const, {
				description:
					"Model tier / subagent label. light = overview & risk scan; medium = conventions/readability; heavy = correctness/security/performance.",
			}),
			objective: Type.String({
				description: "Precise instruction for this pass — what to review and what to return.",
			}),
			context: Type.Optional(
				Type.String({
					description: "Optional pass-specific context appended after the shared context.",
				}),
			),
		}),
		{
			description: "Independent review passes to run concurrently. Results are returned in this same order.",
		},
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "review_subagent",
		label: "Review Subagent",
		description: [
			"Delegate one PR-review pass to an isolated subagent running on a configured model tier.",
			"Pass tier (light|medium|heavy) plus an objective and the diff as context.",
			"Model per tier is configured via /pr-review-config (stored in pr-review.json).",
			"Returns the subagent's candidate findings; the orchestrator validates, filters, and emits the final JSON.",
		].join(" "),
		promptSnippet:
			"Run a tiered PR-review pass (light/medium/heavy) in an isolated subagent on the configured model",
		promptGuidelines: [
			"Use review_subagent for a single /pr-review pass when review_subagents is unavailable or when rerunning one failed batch pass.",
			"When calling review_subagent, pass the unified diff and PR title/description in `context` so the subagent does not refetch it.",
		],
		parameters: ReviewSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const tier = params.tier as Tier;
			const result = await runSubagentPass(
				loadConfig(ctx),
				ctx,
				{ tier, objective: params.objective, context: params.context },
				signal,
				(text) => onUpdate?.({ content: [{ type: "text", text }] }),
			);

			if (result.status === "failed") {
				const detail = result.errorMessage || result.stderr || result.text || "(no output)";
				return {
					content: [{ type: "text", text: `Review subagent failed [${result.notice}]: ${detail}` }],
					isError: true,
					details: {
						tier: result.tier,
						usedTier: result.usedTier,
						model: result.model,
						exitCode: result.exitCode,
						fallbackUsed: result.fallbackUsed,
						retryableFailure: result.retryableFailure,
						attempts: result.attempts,
					},
				};
			}

			return {
				content: [{ type: "text", text: `[${result.notice}]\n\n${result.text || "NO FINDINGS."}` }],
				details: {
					tier: result.tier,
					usedTier: result.usedTier,
					model: result.model,
					exitCode: result.exitCode,
					fallbackUsed: result.fallbackUsed,
					attempts: result.attempts,
				},
			};
		},
	});

	pi.registerTool({
		name: "review_subagents",
		label: "Review Subagents Batch",
		description: [
			"Delegate multiple independent PR-review passes to isolated subagents and run them concurrently.",
			"Pass shared PR context once plus ordered pass assignments with tier, objective, and optional pass-specific context.",
			"Each pass uses the configured light/medium/heavy model tier from /pr-review-config.",
			"Returns deterministic ordered per-pass outputs; partial failures are explicit so the orchestrator can rerun or cover them inline.",
		].join(" "),
		promptSnippet:
			"Run independent light/medium/heavy PR-review passes concurrently in isolated subagents with shared PR context",
		promptGuidelines: [
			"Prefer review_subagents over separate review_subagent calls for independent /pr-review passes; it guarantees bounded parallel execution instead of relying on the orchestrator to emit concurrent tool calls.",
			"Fetch PR metadata and the unified diff once, then pass that shared context in `context`; use per-pass `context` only for extra instructions or scoped convention-file excerpts.",
			"If any pass reports status=failed, treat the review evidence as incomplete: rerun that pass or perform it inline before finalizing the JSON.",
		],
		parameters: ReviewSubagentsParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawPasses = Array.isArray(params.passes) ? params.passes : [];
			if (rawPasses.length === 0) {
				return {
					content: [{ type: "text", text: "review_subagents requires at least one pass assignment." }],
					isError: true,
					details: { passCount: 0 },
				};
			}

			const sharedContext = typeof params.context === "string" ? params.context : undefined;
			const passes: SubagentPassRequest[] = rawPasses.map((pass, index) => {
				const tier = pass.tier as Tier;
				return {
					id: typeof pass.id === "string" && pass.id.trim() ? pass.id.trim() : `${index + 1}-${tier}`,
					tier,
					objective: pass.objective,
					context: combineContexts(sharedContext, typeof pass.context === "string" ? pass.context : undefined),
				};
			});
			const maxParallel = normalizeMaxParallel(params.max_parallel, passes.length);
			const config = loadConfig(ctx);

			const results = await runWithConcurrency(passes, maxParallel, async (pass) => {
				const result = await runSubagentPass(config, ctx, pass, signal);
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `review_subagents: pass ${result.id} ${result.status} (${result.notice})`,
						},
					],
				});
				return result;
			});

			const failed = results.filter((r) => r.status === "failed");
			return {
				content: [{ type: "text", text: formatBatchResults(results, maxParallel) }],
				...(failed.length > 0 ? { isError: true } : {}),
				details: {
					maxParallel,
					passCount: results.length,
					failedCount: failed.length,
					results: results.map((r) => ({
						id: r.id,
						tier: r.tier,
						usedTier: r.usedTier,
						model: r.model,
						exitCode: r.exitCode,
						status: r.status,
						stopReason: r.stopReason,
						errorMessage: r.errorMessage,
						fallbackUsed: r.fallbackUsed,
						retryableFailure: r.retryableFailure,
						attempts: r.attempts,
						outputChars: r.text.length,
					})),
				},
			};
		},
	});

	pi.registerCommand("pr-review-config", {
		description: "Open the review-tier settings menu, or show/set light/medium/heavy models and fallbacks for /pr-review",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const parsed = parseConfigArgs(raw);
			if (parsed.errors.length) {
				ctx.ui.notify(`Invalid pr-review config: ${parsed.errors.join("; ")}`, "error");
				return;
			}

			try {
				// Direct set: `/pr-review-config light=... heavy=... heavy_fallbacks=...`
				if (parsed.hasChanges) {
					const next = applyConfigPatch(readUserConfig(), parsed.patch);
					writeUserConfig(next);
					post(ctx, pi, summarizeConfig(next, loadConfig(ctx), ctx, true), { config: next });
					return;
				}

				// Interactive menu: `/pr-review-config` in the TUI.
				if (shouldOpenConfigMenu(raw, ctx)) {
					let available: string[] = [];
					try {
						available = (await ctx.modelRegistry.getAvailable()).map((m) => `${m.provider}/${m.id}`).sort();
					} catch {
						/* fall back to text if models can't be listed */
					}
					if (available.length > 0) {
						const result = await showConfigMenu(pi, ctx, available);
						if (result === "closed") return;
					}
				}

				// Text summary: `/pr-review-config show`, non-TUI, or menu fallback.
				post(ctx, pi, summarizeConfig(readUserConfig(), loadConfig(ctx), ctx, false), {});
			} catch (e) {
				ctx.ui.notify(`pr-review-config failed: ${errMessage(e)}`, "error");
			}
		},
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.toLowerCase();
			const filtered = CONFIG_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(normalized));
			return filtered.length ? filtered : null;
		},
	});
}

/* ----------------------- config command helpers ------------------------- */

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function post(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	markdown: string,
	details: Record<string, unknown>,
): void {
	if (ctx.hasUI) {
		pi.sendMessage({ customType: "pr-review", content: markdown, display: true, details }, { triggerTurn: false });
	} else {
		ctx.ui.notify(markdown, "info");
	}
}

function shouldOpenConfigMenu(args: string, ctx: ExtensionContext): boolean {
	return args.length === 0 && ctx.mode === "tui" && typeof ctx.ui.custom === "function";
}

const CONFIG_COMPLETIONS: Array<{ value: string; label: string }> = [
	...TIERS.map((t) => ({ value: `${t}=`, label: `${t}=<model> — ${TIER_PURPOSE[t]}` })),
	...TIERS.map((t) => ({
		value: `${t}_fallbacks=`,
		label: `${t}_fallbacks=<model1,model2> — retry chain for quota/rate-limit failures`,
	})),
	{ value: "tools=", label: "tools=read,bash,grep,find,ls — tools granted to review subagents" },
	{ value: "show", label: "show — print the current tier config" },
];

/** Split respecting single/double quotes so `evidence`-style values with spaces survive. */
function splitConfigArgs(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === quote) quote = undefined;
			else token += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += ch;
	}
	if (token) tokens.push(token);
	return tokens;
}

function splitCommaList(value: string): string[] {
	return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function isFallbackKey(key: string): boolean {
	for (const tier of TIERS) {
		if (key === `${tier}_fallbacks` || key === `${tier}-fallbacks` || key === `${tier}.fallbacks`) {
			return true;
		}
	}
	return false;
}

interface ConfigPatch {
	tiers: Partial<Record<Tier, string | null>>;
	fallbacks: Partial<Record<Tier, string[] | null>>;
	tools?: string[];
}

function parseConfigArgs(args: string): { patch: ConfigPatch; hasChanges: boolean; errors: string[] } {
	const patch: ConfigPatch = { tiers: {}, fallbacks: {} };
	const errors: string[] = [];
	const tokens = splitConfigArgs(args).filter((t) => !["show", "get", "current"].includes(t.toLowerCase()));
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq < 0) {
			errors.push(`unrecognized argument "${token}" (use key=value, e.g. heavy=provider/model)`);
			continue;
		}
		const key = token.slice(0, eq).replace(/^--?/, "").toLowerCase();
		const value = token.slice(eq + 1);
		if ((TIERS as string[]).includes(key)) {
			patch.tiers[key as Tier] = value === "" || value === "unset" ? null : value;
		} else if (isFallbackKey(key)) {
			const tier = key.split(/[_\-.]/)[0] as Tier;
			patch.fallbacks[tier] = value === "" || value === "unset" || value === "none" ? null : splitCommaList(value);
		} else if (key === "tools") {
			patch.tools = splitCommaList(value);
		} else {
			errors.push(`unknown key "${key}" (expected light|medium|heavy|<tier>_fallbacks|tools)`);
		}
	}
	const hasChanges =
		Object.keys(patch.tiers).length > 0 || Object.keys(patch.fallbacks).length > 0 || patch.tools !== undefined;
	return { patch, hasChanges, errors };
}

function applyConfigPatch(base: PrReviewConfig, patch: ConfigPatch): PrReviewConfig {
	const next: PrReviewConfig = {
		tiers: { ...base.tiers },
		fallbacks: normalizeFallbacks(base.fallbacks),
		tools: [...base.tools],
	};
	for (const tier of TIERS) {
		if (tier in patch.tiers) {
			const value = patch.tiers[tier];
			if (value === null || value === undefined) delete next.tiers[tier];
			else next.tiers[tier] = value;
		}
		if (tier in patch.fallbacks) {
			const value = patch.fallbacks[tier];
			if (value === null || value === undefined || value.length === 0) delete next.fallbacks[tier];
			else next.fallbacks[tier] = [...new Set(value)];
		}
	}
	if (patch.tools) next.tools = patch.tools;
	return next;
}

function formatModelList(models: string[] | undefined): string {
	return models && models.length > 0 ? `\`${models.join(",")}\`` : "_none_";
}

function summarizeConfig(
	user: PrReviewConfig,
	effective: PrReviewConfig,
	ctx: ExtensionContext,
	changed: boolean,
): string {
	let projectPath: string | undefined;
	try {
		if (ctx.isProjectTrusted()) {
			const p = projectConfigPath(ctx.cwd);
			if (fs.existsSync(p)) projectPath = p;
		}
	} catch {
		/* ignore */
	}
	const lines = [
		`# PR review config${changed ? " updated" : ""}`,
		"",
		"| Tier | Your setting | Effective | Used for |",
		"|---|---|---|---|",
		...TIERS.map(
			(t) =>
				`| \`${t}\` | ${user.tiers[t] ? `\`${user.tiers[t]}\`` : "_unset_"} | ${effective.tiers[t] ? `\`${effective.tiers[t]}\`` : "_pi default_"} | ${TIER_PURPOSE[t]} |`,
		),
		`| \`tools\` | \`${user.tools.join(",")}\` | \`${effective.tools.join(",")}\` | tools granted to each review subagent |`,
		"",
		"| Tier | Your fallbacks | Effective fallbacks |",
		"|---|---|---|",
		...TIERS.map((t) => `| \`${t}\` | ${formatModelList(user.fallbacks[t])} | ${formatModelList(effective.fallbacks[t])} |`),
		"",
		`User config: \`${userConfigPath()}\``,
	];
	if (projectPath) lines.push(`Project overlay (trusted): \`${projectPath}\``);
	lines.push(
		"",
		"## Usage",
		"- Open the settings menu: `/pr-review-config`",
		"- Print this summary: `/pr-review-config show`",
		"- Set directly: `/pr-review-config light=provider/model heavy=provider/model:high`",
		"- Set fallback chain: `/pr-review-config heavy_fallbacks=provider/backup:high,provider/backup2`",
		"- Clear a tier: `/pr-review-config medium=unset`",
		"- Clear fallback chain: `/pr-review-config heavy_fallbacks=unset`",
		"- A `<model>` is any pi model pattern (`provider/model` or `provider/model:thinking`).",
	);
	return lines.join("\n");
}

/* --------------------------- interactive menu --------------------------- */

const MODEL_LIST_ROWS = 10;

/**
 * Model picker submenu with type-to-filter search.
 *
 * A raw SelectList only handles arrows/enter/esc, so we wrap it: an Input captures
 * keystrokes and we fuzzy-filter the options (matching the built-in SettingsList
 * search UX and fuzzyFilter's slash-token matching, so typing a model name substring
 * finds `provider/model`). The SelectList is rebuilt as the query changes.
 */
function buildModelSubmenu(
	available: string[],
	currentSpec: string | undefined,
	unsetDescription = "Fall back to the nearest configured tier, then the pi default.",
) {
	return (_currentValue: string, done: (selectedValue?: string) => void) => {
		const allItems: SelectItem[] = [
			{ value: "__unset__", label: UNSET, description: unsetDescription },
			...available.map((spec) => ({ value: spec, label: spec })),
		];
		const theme = getSelectListTheme();
		const search = new Input();

		const makeList = (items: SelectItem[], selectValue?: string): SelectList => {
			const list = new SelectList(items, MODEL_LIST_ROWS, theme);
			if (selectValue) {
				const idx = items.findIndex((i) => i.value === selectValue);
				if (idx >= 0) list.setSelectedIndex(idx);
			}
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done();
			return list;
		};

		let list = makeList(allItems, currentSpec ?? "__unset__");

		const applyQuery = (query: string) => {
			const filtered = query.trim() ? fuzzyFilter(allItems, query, (i) => i.label) : allItems;
			list = makeList(filtered);
		};

		const navKeys = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"];
		return {
			render(width: number): string[] {
				return [...search.render(width), ...list.render(width)];
			},
			invalidate(): void {
				search.invalidate?.();
				list.invalidate();
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (navKeys.some((k) => kb.matches(data, k))) {
					list.handleInput(data);
					return;
				}
				// Ignore other escape sequences (arrows/fn/etc.) so they never pollute the search box.
				if (data.startsWith("\x1b")) return;
				// Everything else is search typing (Input handles printable chars + backspace + editing keys).
				const sanitized = data.replace(/ /g, "");
				if (!sanitized) return;
				search.handleInput(sanitized);
				applyQuery(search.getValue());
			},
		};
	};
}

function configMenuItems(cfg: PrReviewConfig, available: string[]): SettingItem[] {
	const tierItems: SettingItem[] = TIERS.map((tier) => ({
		id: tier,
		label: `${tier} model`,
		description: `Used for: ${TIER_PURPOSE[tier]}. Press Enter to pick a model.`,
		currentValue: cfg.tiers[tier] ?? UNSET,
		submenu: buildModelSubmenu(available, cfg.tiers[tier]),
	}));
	const fallbackItems: SettingItem[] = TIERS.map((tier) => ({
		id: `${tier}_fallbacks`,
		label: `${tier} fallback model`,
		description:
			"Retry model for quota/rate-limit/capacity failures. Press Enter to set one fallback; use key=value for chains.",
		currentValue: cfg.fallbacks[tier]?.join(",") || "(none)",
		submenu: buildModelSubmenu(
			available,
			cfg.fallbacks[tier]?.[0],
			"Clear this tier's fallback chain. Use key=value form to set multiple fallbacks.",
		),
	}));
	const current = cfg.tools.join(",");
	const toolValues = [current, ...TOOLS_PRESETS.filter((p) => p !== current)];
	return [
		...tierItems,
		...fallbackItems,
		{
			id: "tools",
			label: "subagent tools",
			description: "Tools granted to each review subagent. Enter/Space cycles presets.",
			currentValue: current,
			values: toolValues,
		},
	];
}

async function showConfigMenu(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	available: string[],
): Promise<"closed" | "fallback"> {
	const draft = readUserConfig();
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("PR Review Config")), 1, 1));
			container.addChild(
				new Text(theme.fg("dim", "Select a value to apply it immediately. Esc closes the menu."), 1, 0),
			);

			let settingsList: SettingsList;
			const refresh = () => {
				for (const tier of TIERS) {
					settingsList.updateValue(tier, draft.tiers[tier] ?? UNSET);
					settingsList.updateValue(`${tier}_fallbacks`, draft.fallbacks[tier]?.join(",") || "(none)");
				}
				settingsList.updateValue("tools", draft.tools.join(","));
			};

			const persist = (id: string, newValue: string) => {
				if ((TIERS as string[]).includes(id)) {
					if (newValue === "__unset__") delete draft.tiers[id as Tier];
					else draft.tiers[id as Tier] = newValue;
				} else if (isFallbackKey(id)) {
					const tier = id.split(/[_\-.]/)[0] as Tier;
					if (newValue === "__unset__") delete draft.fallbacks[tier];
					else draft.fallbacks[tier] = [newValue];
				} else if (id === "tools") {
					draft.tools = splitCommaList(newValue);
				} else {
					return;
				}
				try {
					writeUserConfig(draft);
					refresh();
					const shown = id === "tools"
						? draft.tools.join(",")
						: isFallbackKey(id)
							? (draft.fallbacks[id.split(/[_\-.]/)[0] as Tier]?.join(",") ?? "(none)")
							: (draft.tiers[id as Tier] ?? UNSET);
					ctx.ui.notify(`PR review config: ${id} = ${shown}`, "info");
				} catch (e) {
					ctx.ui.notify(`pr-review-config failed: ${errMessage(e)}`, "error");
				}
				tui.requestRender();
			};

			settingsList = new SettingsList(
				configMenuItems(draft, available),
				10,
				getSettingsListTheme(),
				(id, newValue) => persist(id, newValue),
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	} catch (e) {
		ctx.ui.notify(`PR review config menu unavailable; showing text config instead. ${errMessage(e)}`, "warning");
		return "fallback";
	}
	return "closed";
}
