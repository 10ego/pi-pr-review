/**
 * review-table
 *
 * Renders the /pr-review final JSON response as a readable TUI review and owns
 * configured GitHub publication after valid final JSON. Publishing is bound to raw
 * invocation flags/config, validates current PR state and anchors, and can emit only
 * one formal COMMENT review with associated inline comments.
 *
 * Rendering only rewrites interactive TUI output. Print/json/rpc modes retain raw JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	classifyAssistantCompletion,
	COMPLETED_REVIEW_BRANCH_ANCHOR_TYPE,
	COMPLETED_REVIEW_ENTRY_TYPE,
	CompletedReviewCache,
	decideReviewPublication,
	isNonOpenConfirmationPrompt,
	parseDirectPublishRequest,
	parsePublishExistingArgs,
	parsePublishMode,
	parsePublishableReview,
	publishPullReview,
	publishPullReviewBody,
	resolveAllowStaleApprovalsSetting,
	resolveAllowStalePublishSetting,
	resolveAutoPostSetting,
	resolveApproveMaxPriorityLevelSetting,
	resolveRepositoryBinding,
	resolveReviewHostBinding,
	restoreCompletedReviewBranch,
	shouldPublishReview,
	validateReviewInvocation,
	type AutoPostResolution,
	type ApproveMaxPriorityLevelResolution,
	type CompletedReviewRecord,
	type CompletedReviewSessionIdentity,
	type ReviewInvocation,
} from "../lib/pr-review-publish.ts";
import { synthesizeReviewArtifact, type ReviewSynthesisArtifact } from "../lib/pr-review-markdown.ts";
import { resolveReviewDeadlinesForContext } from "../lib/pr-review-deadline-config.ts";
import { createReviewBudget } from "../lib/pr-review-deadlines.ts";
import {
	REVIEW_LOOP_TOOL_NAMES,
	ReviewLoopCoordinator,
	type ReviewLoopInputSource,
} from "../lib/pr-review-loop.ts";
import { SelfReviewPermitCoordinator } from "../lib/pr-self-review.ts";
import {
	ReviewTelemetryTracker,
	type ReviewPerformanceTelemetry,
} from "../lib/pr-review-telemetry.ts";

type Severity = "P0" | "P1" | "P2" | "P3" | "nit";

interface Finding {
	title?: string;
	body?: string;
	severity?: string;
	blocking?: boolean;
	confidence_score?: number;
	priority?: number | null;
	code_location?: {
		absolute_file_path?: string | null;
		line_range?: { start?: number; end?: number };
		side?: string | null;
		commentable?: boolean;
	} | null;
}

interface Review {
	pr?: { number?: number | null; title?: string | null; head_sha?: string | null } | null;
	disposition?: "reviewed" | "skipped";
	verification?: string;
	overview?: string;
	strengths?: string[];
	findings: Finding[];
	notes?: { correctness?: string; security?: string; performance?: string } | null;
	verdict?: string;
	overall_correctness?: string;
	overall_explanation?: string;
	overall_confidence_score?: number;
}

type MessagePart = { type: string; text?: string };

const OWN_REVIEW_PROMPT = fs.realpathSync(
	fileURLToPath(new URL("../prompts/pr-review.md", import.meta.url)),
);

function isOwnReviewPrompt(pi: Pick<ExtensionAPI, "getCommands">): boolean {
	try {
		return pi.getCommands().some((command) => {
			if (command.name !== "pr-review" || command.source !== "prompt") return false;
			try {
				return fs.realpathSync(command.sourceInfo.path) === OWN_REVIEW_PROMPT;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function assistantText(message: { content?: MessagePart[] }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("");
}

function hasToolCall(message: { content?: MessagePart[] }): boolean {
	return Array.isArray(message.content) && message.content.some((p) => p.type === "toolCall");
}

/** Extract the balanced {...} object starting at index `start` (string-literal aware). */
function sliceBalancedFrom(s: string, start: number): string | null {
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

function isReviewShape(v: unknown): v is Review {
	if (!v || typeof v !== "object") return false;
	const r = v as Review;
	return Array.isArray(r.findings) && (typeof r.overall_correctness === "string" || typeof r.verdict === "string");
}

/**
 * Find the review JSON even if the model wrapped it in fences or prepended prose
 * that itself contains braces. Scans every `{` in each source and returns the LAST
 * valid review-shaped object (the real payload is normally last).
 */
function parseReview(text: string): Review | null {
	const sources: string[] = [];
	const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (let m = fenceRe.exec(text); m; m = fenceRe.exec(text)) {
		if (m[1]) sources.push(m[1]);
	}
	sources.push(text);

	let best: Review | null = null;
	for (const src of sources) {
		for (let i = 0; i < src.length; i++) {
			if (src[i] !== "{") continue;
			const objStr = sliceBalancedFrom(src, i);
			if (!objStr) continue;
			try {
				const parsed = JSON.parse(objStr);
				if (isReviewShape(parsed)) best = parsed;
			} catch {
				/* not JSON starting here; keep scanning */
			}
		}
		if (best) return best; // prefer a match from an earlier (more specific) source
	}
	return best;
}


const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

function severityOf(f: Finding): Severity | null {
	const raw = (f.severity ?? "").toString().trim().toLowerCase();
	if (raw === "nit") return "nit";
	if (/^p[0-3]$/.test(raw)) return raw.toUpperCase() as Severity;
	if (typeof f.priority === "number" && f.priority >= 0 && f.priority <= 3) return `P${f.priority}` as Severity;
	const m = (f.title ?? "").match(/\[?\s*(p[0-3]|nit)\s*\]?/i);
	if (m) return m[1].toLowerCase() === "nit" ? "nit" : (m[1].toUpperCase() as Severity);
	return null;
}

function severityLabel(f: Finding): string {
	return severityOf(f) ?? "—";
}

function severityRank(f: Finding): number {
	const s = severityOf(f);
	return s ? SEVERITY_RANK[s] : 5;
}

function isBlocking(f: Finding): boolean {
	if (typeof f.blocking === "boolean") return f.blocking;
	const s = severityOf(f);
	return s === "P0" || s === "P1";
}

/** Strip a leading [Pn]/[nit] tag from a title (severity is shown in its own column). */
function titleText(f: Finding): string {
	return (f.title ?? "(untitled)").replace(/^\s*\[?\s*(?:p[0-3]|nit)\s*\]?\s*[-–:·]?\s*/i, "").trim() || "(untitled)";
}

function location(f: Finding): string {
	const p = f.code_location?.absolute_file_path;
	if (!p) return "—";
	const lr = f.code_location?.line_range;
	const side = (f.code_location?.side ?? "").toString().toUpperCase();
	const sideSuffix = side === "LEFT" ? " (LEFT)" : "";
	if (lr && lr.start != null) {
		const end = lr.end != null && lr.end !== lr.start ? `-${lr.end}` : "";
		return `${p}:${lr.start}${end}${sideSuffix}`;
	}
	return `${p}${sideSuffix}`;
}

/** Whether a finding carries enough diff-anchored data to post as an inline comment. */
function isCommentable(f: Finding): boolean {
	const cl = f.code_location;
	if (!cl || !cl.absolute_file_path) return false;
	if (cl.commentable === false) return false;
	return cl.line_range?.start != null;
}

function conf(n: number | undefined): string {
	return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
}

/** Escape a value for use inside a Markdown table cell. */
function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function verdictLine(r: Review): string {
	const v = (r.verdict ?? "").toLowerCase();
	const incorrect = /incorrect/i.test(r.overall_correctness ?? "");
	let icon: string;
	let label: string;
	if (v === "approve" || (!v && !incorrect)) {
		icon = "✅";
		label = "Approve";
	} else if (v === "request_changes" || (!v && incorrect)) {
		icon = "❌";
		label = "Request changes";
	} else {
		icon = "💬";
		label = "Comment";
	}
	const parts = [`${icon} **${label}**`];
	if (r.overall_explanation) parts.push(`— ${r.overall_explanation.trim()}`);
	if (r.overall_confidence_score != null) parts.push(`_(confidence ${conf(r.overall_confidence_score)})_`);
	return parts.join(" ");
}

function renderReviewMarkdown(r: Review): string {
	const out: string[] = [];

	// Header
	const num = r.pr?.number;
	const title = (r.pr?.title ?? "").toString().replace(/\r?\n/g, " ").trim();
	if (num != null) out.push(`## Code Review — PR #${num}${title ? `: ${title}` : ""}`, "");
	else out.push("## Code Review", "");

	if (r.verification?.trim()) out.push(`**Verification:** ${r.verification.trim()}`, "");

	if (r.overview?.trim()) out.push("### Overview", "", r.overview.trim(), "");

	if (Array.isArray(r.strengths) && r.strengths.length > 0) {
		out.push("### Strengths", "");
		for (const s of r.strengths) out.push(`- ${String(s).replace(/^\s*-\s*/, "").trim()}`);
		out.push("");
	}

	// Findings
	const findings = [...r.findings].sort((a, b) => severityRank(a) - severityRank(b));
	const blocking = findings.filter(isBlocking).length;
	const nonBlocking = findings.length - blocking;
	out.push(`### Findings — ${findings.length} (${blocking} blocking, ${nonBlocking} non-blocking)`, "");

	if (findings.length === 0) {
		out.push("_No issues found — nit through P0._", "");
	} else {
		const inlineCount = findings.filter(isCommentable).length;
		out.push("| # | Sev | Blk | Inline | Finding | Location | Conf |", "|---|:--:|:--:|:--:|---|---|:--:|");
		findings.forEach((f, i) => {
			out.push(
				`| ${i + 1} | ${severityLabel(f)} | ${isBlocking(f) ? "yes" : "—"} | ${isCommentable(f) ? "✎" : "—"} | ${cell(titleText(f))} | \`${cell(location(f))}\` | ${conf(f.confidence_score)} |`,
			);
		});
		out.push("", `_✎ = has diff-anchored location postable as an inline comment (${inlineCount}/${findings.length})._`, "");
		findings.forEach((f, i) => {
			out.push(`#### ${i + 1}. [${severityLabel(f)}] ${cell(titleText(f))}`);
			const anchor = isCommentable(f) ? "inline-ready" : "summary-only";
			out.push(`\`${location(f)}\` · confidence ${conf(f.confidence_score)} · ${isBlocking(f) ? "blocking" : "non-blocking"} · ${anchor}`, "");
			if (f.body?.trim()) out.push(f.body.trim(), "");
		});
	}

	// Correctness / Security / Performance
	const notes = r.notes;
	const noteRows: string[] = [];
	if (notes?.correctness?.trim()) noteRows.push(`- **Correctness:** ${notes.correctness.trim()}`);
	if (notes?.security?.trim()) noteRows.push(`- **Security:** ${notes.security.trim()}`);
	if (notes?.performance?.trim()) noteRows.push(`- **Performance:** ${notes.performance.trim()}`);
	if (noteRows.length > 0) out.push("### Correctness / Security / Performance", "", ...noteRows, "");

	// Verdict
	out.push("### Verdict", "", verdictLine(r));

	return out.join("\n").trimEnd();
}

interface ConfigReadResult {
	value: Record<string, unknown>;
	error?: string;
}

function readJsonObject(filePath: string): ConfigReadResult {
	try {
		if (!fs.existsSync(filePath)) return { value: {} };
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object"
			? { value: parsed as Record<string, unknown> }
			: { value: {}, error: `${filePath} must contain a JSON object` };
	} catch (error) {
		return { value: {}, error: `${filePath} is invalid JSON: ${String(error)}` };
	}
}

interface PublishingConfigResolution {
	autoPost: AutoPostResolution;
	allowStale: AutoPostResolution;
	allowStaleApprovals: AutoPostResolution;
	approveMaxPriority: ApproveMaxPriorityLevelResolution;
}

function invalidPublishingConfig(source: "user" | "project", error: string): PublishingConfigResolution {
	const invalid = { value: false, valid: false, source, error } as const;
	const invalidLevel = { value: "off" as const, valid: false, source, error } as const;
	return { autoPost: invalid, allowStale: invalid, allowStaleApprovals: invalid, approveMaxPriority: invalidLevel };
}

function resolvePublishingConfig(ctx: ExtensionContext): PublishingConfigResolution {
	const user = readJsonObject(path.join(getAgentDir(), "pr-review.json"));
	if (user.error) return invalidPublishingConfig("user", user.error);
	let project: ConfigReadResult | undefined;
	try {
		if (ctx.isProjectTrusted()) {
			project = readJsonObject(path.join(ctx.cwd, CONFIG_DIR_NAME, "pr-review.json"));
			if (project.error) return invalidPublishingConfig("project", project.error);
		}
	} catch {
		/* user config only */
	}
	return {
		autoPost: resolveAutoPostSetting(user.value, project?.value),
		allowStale: resolveAllowStalePublishSetting(user.value, project?.value),
		allowStaleApprovals: resolveAllowStaleApprovalsSetting(user.value, project?.value),
		approveMaxPriority: resolveApproveMaxPriorityLevelSetting(user.value, project?.value),
	};
}

function notifyPublishResult(
	result: Awaited<ReturnType<typeof publishPullReview>>,
	source: string,
	ctx: ExtensionContext,
): void {
	if (result.status === "posted") {
		const label = result.event === "APPROVE" ? "APPROVE" : "COMMENT";
		ctx.ui.notify(`PR review posted as ${label} (${source})${result.url ? `: ${result.url}` : ""}`, "info");
	} else if (result.status === "posted_degraded") {
		ctx.ui.notify(`PR review posted (${source}): ${result.message}${result.url ? ` ${result.url}` : ""}`, "warning");
	} else if (result.status === "skipped_duplicate") {
		ctx.ui.notify("PR review not reposted: this reviewed head was already posted by the current GitHub identity", "info");
	} else {
		ctx.ui.notify(`PR review publish ${result.status}: ${result.message}`, "error");
	}
}

type ReviewPublicationOrigin =
	| { readonly kind: "frozen-invocation" }
	| { readonly kind: "publish-command"; readonly stalePolicy: "frozen" | "allow-stale" }
	| { readonly kind: "direct-request" };

async function publishCompletedReview(
	record: CompletedReviewRecord,
	origin: ReviewPublicationOrigin,
	ctx: ExtensionContext,
): Promise<void> {
	const decision = origin.kind === "frozen-invocation"
		? decideReviewPublication(record.invocation)
		: undefined;
	if (decision?.error) {
		ctx.ui.notify(`PR review was not posted: ${decision.error}`, "error");
		return;
	}
	if (decision && !decision.publish) return;
	const explicitStale = origin.kind === "direct-request" ||
		(origin.kind === "publish-command" && origin.stalePolicy === "allow-stale");
	const allowStale = explicitStale || record.invocation.allowStalePublish;
	const source = decision?.source ?? (origin.kind === "frozen-invocation"
		? "frozen invocation"
		: origin.kind === "direct-request"
			? "direct user request"
			: origin.stalePolicy === "allow-stale" ? "publish-only --allow-stale" : "publish-only");

	const headSha = record.review.pr?.head_sha;
	if (typeof headSha !== "string") {
		ctx.ui.notify("PR review was not posted: cached final JSON is missing pr.head_sha", "error");
		return;
	}
	const result = await publishPullReview({
		cwd: ctx.cwd,
		prNumber: record.invocation.prNumber,
		headSha,
		allowNonOpen: record.invocation.allowNonOpen,
		allowStale,
		allowStaleApprovals: record.invocation.allowStaleApprovals,
		approveMaxPriorityLevel: record.invocation.approveMaxPriorityLevel,
		expectedRepository: record.repository,
		review: record.review,
		...(record.publicationBody ? { publicationBody: record.publicationBody } : {}),
		forceBodyOnly: record.synthesisQuality !== undefined &&
			(record.synthesisQuality !== "fully_parsed" || record.completeness === "incomplete"),
		// A publication body identifies Markdown-derived or degraded synthesis.
		// Enforce COMMENT again at the final publication boundary so restored
		// canonical artifacts created by an older parser cannot inherit APPROVE.
		forceComment: record.publicationBody !== undefined ||
			(record.synthesisQuality !== undefined &&
				(record.synthesisQuality !== "fully_parsed" || record.completeness === "incomplete")),
	});
	notifyPublishResult(result, source, ctx);
}

export default function registerReviewTable(
	pi: ExtensionAPI,
	loopCoordinator = new ReviewLoopCoordinator(pi),
	selfReviewCoordinator = new SelfReviewPermitCoordinator(pi, () => !!loopCoordinator.peek()),
) {
	const completedReviews = new CompletedReviewCache();
	const sessionIdentity = (ctx: ExtensionContext): CompletedReviewSessionIdentity | undefined => {
		const header = ctx.sessionManager.getHeader();
		const id = ctx.sessionManager.getSessionId();
		return header?.id === id && typeof header.timestamp === "string"
			? { id, startedAt: header.timestamp }
			: undefined;
	};
	const restoreCompletedReviews = (ctx: ExtensionContext) => {
		const session = sessionIdentity(ctx);
		if (!session) {
			completedReviews.clear();
			return;
		}
		restoreCompletedReviewBranch(completedReviews, ctx.sessionManager.getBranch(), session);
	};
	type PendingCompletion =
		| {
			readonly record: CompletedReviewRecord;
			readonly replacedRecord?: CompletedReviewRecord;
			readonly session?: CompletedReviewSessionIdentity;
		}
		| { readonly error: string };
	let pendingCompletion: PendingCompletion | undefined;
	const completionError = (invocation: ReviewInvocation, failure?: string): PendingCompletion | undefined => {
		const decision = decideReviewPublication(invocation);
		const error = decision.error ?? (decision.publish ? failure : undefined);
		return error ? { error } : undefined;
	};
	const resolveCompletion = (
		parsed: ReturnType<typeof parsePublishableReview>,
		invocation: ReviewInvocation,
		ctx: ExtensionContext,
		artifact?: ReviewSynthesisArtifact,
	): PendingCompletion | undefined => {
		if (!parsed.review) return completionError(invocation, parsed.error ?? "final review is invalid");
		const bindingError = validateReviewInvocation(parsed.review, invocation);
		if (bindingError) return completionError(invocation, bindingError);
		if (!shouldPublishReview(parsed.review)) return completionError(invocation);
		if (!invocation.reviewBinding) {
			return completionError(invocation, "the completed review has no frozen host repository binding; no publish-only cache is available");
		}
		const repository = {
			repository: invocation.reviewBinding.repository,
			hostname: invocation.reviewBinding.hostname,
		};
		// Cache the complete canonical artifact while the lane registry is still
		// live; Pi persists this record after it stores the assistant message.
		const replacement = completedReviews.replace(parsed.review, invocation, repository, artifact ? {
			synthesisQuality: artifact.quality,
			// Keep the complete original Markdown in rawText. Only degraded output
			// needs a body override; fully parsed output uses the concise renderer
			// and can pass the host-owned approval gates at publication time.
			...(artifact.body && (artifact.quality !== "fully_parsed" || artifact.completeness === "incomplete")
				? { publicationBody: artifact.body }
				: {}),
			rawText: artifact.rawText,
			laneArtifacts: artifact.laneArtifacts,
			completeness: artifact.completeness,
			diagnostics: artifact.diagnostics,
		} : undefined);
		const { record } = replacement;
		const session = sessionIdentity(ctx);
		if (!session) {
			ctx.ui.notify("Completed review cache will not survive reload: session identity is unavailable", "warning");
		}
		return session
			? { record, ...(replacement.previous ? { replacedRecord: replacement.previous } : {}), session }
			: { record, ...(replacement.previous ? { replacedRecord: replacement.previous } : {}) };
	};

	const telemetryTracker = new ReviewTelemetryTracker();
	const reviewToolNames = new Set<string>(REVIEW_LOOP_TOOL_NAMES);
	const activeToolGenerations = new Map<string, number>();
	const generationsWithReviewTools = new Set<number>();
	const generationsReadyForSynthesis = new Set<number>();
	let nextPreflightGeneration = 1;
	let activePreflight: { generation: number; controller: AbortController } | undefined;
	const revokePreflight = () => {
		if (!activePreflight) return;
		activePreflight?.controller.abort(new Error("review GitHub preflight revoked"));
		activePreflight = undefined;
		telemetryTracker.clear();
	};
	const ownsPreflight = (preflight: { generation: number; controller: AbortController }) =>
		activePreflight?.generation === preflight.generation && activePreflight.controller === preflight.controller;
	const persistTelemetry = (completion: ReviewPerformanceTelemetry["completion"]) => {
		const telemetry = telemetryTracker.finish(completion);
		if (!telemetry) return;
		try {
			pi.appendEntry("pr-review-telemetry", telemetry);
		} catch {
			// Telemetry persistence must never block rendering or publication safety checks.
		}
	};

	type CachedReviewResolution = { record: CompletedReviewRecord } | { error: string };
	const resolveCachedReview = async (
		requestedPrNumber: number | undefined,
		ctx: ExtensionContext,
	): Promise<CachedReviewResolution> => {
		try {
			const repository = await resolveRepositoryBinding(ctx.cwd);
			const record = requestedPrNumber === undefined
				? completedReviews.latest(repository)
				: completedReviews.get(requestedPrNumber, repository);
			if (record) return { record };
			const target = requestedPrNumber === undefined ? "the latest PR" : `PR #${requestedPrNumber}`;
			return {
				error: `No completed review for ${target} is cached for this repository in the current extension session. Publishing never starts or reruns a review.`,
			};
		} catch (error) {
			return { error: `Cannot resolve the current GitHub repository: ${String(error)}` };
		}
	};

	pi.registerCommand("pr-review-publish", {
		description: "Publish a completed review from this session without rerunning the model",
		handler: async (args, ctx) => {
			// Extension commands execute before input hooks, so every invocation —
			// including malformed arguments — must revoke active review authority.
			selfReviewCoordinator.clear();
			revokePreflight();
			const active = loopCoordinator.peek();
			if (active) {
				loopCoordinator.clear();
				persistTelemetry("cleared");
			}
			const parsed = parsePublishExistingArgs(args ?? "");
			if (parsed.error || !parsed.prNumber) {
				ctx.ui.notify(
					`Invalid /pr-review-publish command: ${parsed.error ?? "missing PR number"}. Usage: /pr-review-publish <PR-NUM> [--allow-stale]`,
					"error",
				);
				return;
			}
			if (active?.prNumber === parsed.prNumber) {
				ctx.ui.notify(
					`PR #${parsed.prNumber} review was cancelled. The publish-only command will not post an older cached result in its place.`,
					"error",
				);
				return;
			}
			const resolved = await resolveCachedReview(parsed.prNumber, ctx);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			await publishCompletedReview(resolved.record, {
				kind: "publish-command",
				stalePolicy: parsed.allowStale ? "allow-stale" : "frozen",
			}, ctx);
		},
	});

	const revokeActiveLoop = () => {
		revokePreflight();
		loopCoordinator.clear();
		selfReviewCoordinator.clear();
		pendingCompletion = undefined;
		telemetryTracker.clear();
	};

	pi.on("session_before_switch", revokeActiveLoop);
	pi.on("session_before_fork", revokeActiveLoop);
	pi.on("session_before_tree", revokeActiveLoop);
	pi.on("session_shutdown", revokeActiveLoop);

	pi.on("session_start", (_event, ctx) => {
		revokeActiveLoop();
		restoreCompletedReviews(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await selfReviewCoordinator.beginTask(ctx);
	});

	pi.on("agent_settled", () => {
		selfReviewCoordinator.clear();
	});

	pi.on("session_tree", (event, ctx) => {
		revokePreflight();
		loopCoordinator.clear();
		selfReviewCoordinator.clear();
		pendingCompletion = undefined;
		restoreCompletedReviews(ctx);
		telemetryTracker.clear();
		const session = sessionIdentity(ctx);
		if (event.summaryEntry || !session) return;
		try {
			// Pi otherwise resumes at the JSONL tail, not a no-summary /tree selection.
			pi.appendEntry(COMPLETED_REVIEW_BRANCH_ANCHOR_TYPE, { schemaVersion: 2, session });
		} catch (error) {
			ctx.ui.notify(`PR review cache branch selection will not survive session resume: ${String(error)}`, "warning");
		}
	});

	pi.on("input", async (event, ctx) => {
		// Any new input revokes the prior top-level task generation before it can
		// authorize a replay or a queued/steering continuation.
		revokePreflight();
		selfReviewCoordinator.clear();

		const source = event.source as ReviewLoopInputSource;
		const directPublish = parseDirectPublishRequest(event.text);
		if (
			(source === "interactive" || source === "rpc") &&
			event.streamingBehavior === undefined &&
			directPublish.matched
		) {
			const active = loopCoordinator.peek();
			if (active) {
				loopCoordinator.clear();
				persistTelemetry("cleared");
				ctx.ui.notify(
					`PR #${active.prNumber} review was cancelled. The direct publish request will not post an older cached result in its place.`,
					"error",
				);
				return { action: "handled" as const };
			}
			const resolved = await resolveCachedReview(directPublish.prNumber, ctx);
			if ("error" in resolved) ctx.ui.notify(resolved.error, "error");
			else await publishCompletedReview(resolved.record, { kind: "direct-request" }, ctx);
			return { action: "handled" as const };
		}
		if (loopCoordinator.phase() === "awaiting_confirmation") {
			const confirmation = loopCoordinator.resolveConfirmationInput(event.text, source, ctx);
			if (confirmation === "confirmed") {
				telemetryTracker.resumeAfterConfirmation();
				return;
			}
			// Finish while paused so negative/unrelated input cannot count human wait as active work.
			// A fresh /pr-review in this same input may safely bind a new tracker below.
			persistTelemetry("cleared");
		}

		const parsed = parsePublishMode(event.text);
		if (loopCoordinator.peek()) {
			// Any independent user/extension input revokes the current generation.
			// Only a fresh idle /pr-review command may begin the replacement.
			loopCoordinator.clear();
			persistTelemetry(parsed.matched && event.streamingBehavior === undefined ? "replaced" : "cleared");
			if (!parsed.matched) return;
		}
		if (!parsed.matched) {
			selfReviewCoordinator.noteTopLevelInput(source, event.streamingBehavior, ctx);
			return;
		}
		if (event.streamingBehavior !== undefined) {
			// Returning handled prevents queueing but does not stop the current parent
			// operation. Abort it so revoked review work cannot continue with built-ins.
			ctx.abort();
			ctx.ui.notify("Invalid /pr-review invocation: queued or steering input cannot start a review loop", "error");
			return { action: "handled" as const };
		}
		if (!isOwnReviewPrompt(pi)) {
			ctx.ui.notify("Invalid /pr-review invocation: the active prompt is not the pi-pr-review package prompt", "error");
			return { action: "handled" as const };
		}

		// Freeze trusted publication config and target binding before review tools or optional PR code can run.
		const publishingConfig = resolvePublishingConfig(ctx);
		const deadlineResolution = resolveReviewDeadlinesForContext(ctx);
		const budget = createReviewBudget(deadlineResolution);
		const preflight = {
			generation: nextPreflightGeneration++,
			controller: new AbortController(),
		};
		activePreflight = preflight;
		telemetryTracker.begin(parsed.prNumber!, {
			source: deadlineResolution.source,
			totalMs: deadlineResolution.config.totalMs,
			batchMs: deadlineResolution.config.batchMs,
			synthesisMs: deadlineResolution.config.synthesisMs,
			terminationGraceMs: deadlineResolution.config.terminationGraceMs,
			cleanupReserveMs: deadlineResolution.config.cleanupReserveMs,
		});
		let reviewBinding;
		try {
			reviewBinding = await resolveReviewHostBinding(ctx.cwd, parsed.prNumber!, {
				deadlineMs: budget.totalDeadlineMs - budget.config.terminationGraceMs - budget.config.cleanupReserveMs,
				signal: preflight.controller.signal,
				terminationGraceMs: budget.config.terminationGraceMs,
				cleanupReserveMs: budget.config.cleanupReserveMs,
			});
		} catch (error) {
			// A newer input owns telemetry and authority. The revoked generation must
			// neither notify nor clear the successor after its child has settled.
			if (!ownsPreflight(preflight) || preflight.controller.signal.aborted) {
				return { action: "handled" as const };
			}
			activePreflight = undefined;
			ctx.ui.notify(`Invalid /pr-review invocation: host review binding failed: ${String(error)}`, "error");
			persistTelemetry("cleared");
			return { action: "handled" as const };
		}
		if (!ownsPreflight(preflight) || preflight.controller.signal.aborted) {
			return { action: "handled" as const };
		}
		activePreflight = undefined;
		const gate = loopCoordinator.begin(
			parsed,
			publishingConfig.autoPost,
			source,
			ctx,
			publishingConfig.allowStale.valid && publishingConfig.allowStale.value,
			publishingConfig.allowStaleApprovals.valid && publishingConfig.allowStaleApprovals.value,
			publishingConfig.approveMaxPriority.valid ? publishingConfig.approveMaxPriority.value : "off",
			reviewBinding,
			deadlineResolution,
			() => ctx.abort(),
			budget,
		);
		if (!gate.accepted) {
			ctx.ui.notify(`Invalid /pr-review invocation: ${gate.error}`, "error");
			persistTelemetry("cleared");
			return { action: "handled" as const };
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!loopCoordinator.peek()) return;
		telemetryTracker.toolStarted(event.toolCallId, event.toolName, event.args);
		const lease = loopCoordinator.acquire(ctx);
		if (!lease) return;
		activeToolGenerations.set(event.toolCallId, lease.generation);
		if (reviewToolNames.has(event.toolName)) generationsWithReviewTools.add(lease.generation);
	});

	pi.on("tool_execution_end", (event) => {
		telemetryTracker.toolEnded(event.toolCallId);
		const generation = activeToolGenerations.get(event.toolCallId);
		activeToolGenerations.delete(event.toolCallId);
		if (generation === undefined || !generationsWithReviewTools.has(generation)) return;
		if ([...activeToolGenerations.values()].includes(generation)) return;
		generationsWithReviewTools.delete(generation);
		generationsReadyForSynthesis.add(generation);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// turn_end includes the complete tool-result set for the assistant turn.
		// Start the synthesis cap here rather than at the first tool end so
		// sequential or concurrently settling tool calls cannot consume it early.
		for (const generation of generationsReadyForSynthesis) {
			generationsReadyForSynthesis.delete(generation);
			loopCoordinator.beginSynthesis(generation, ctx);
		}
		const pending = pendingCompletion;
		pendingCompletion = undefined;
		if (!pending) return;
		if ("error" in pending) {
			ctx.ui.notify(`PR review was not posted: ${pending.error}`, "error");
			return;
		}
		if (pending.session) {
			const currentSession = sessionIdentity(ctx);
			if (!currentSession || currentSession.id !== pending.session.id || currentSession.startedAt !== pending.session.startedAt) {
				ctx.ui.notify("Completed review was not persisted or posted because the session identity changed", "warning");
				return;
			}
			const leaf = ctx.sessionManager.getLeafEntry();
			const leafReview = leaf?.type === "message" && leaf.message.role === "assistant"
				? parsePublishableReview(assistantText(leaf.message as { content?: MessagePart[] })).review
				: undefined;
			const reviewEntryId = leafReview ? leaf?.id : undefined;
			try {
				// Persist before any GitHub preflight so a failed post always remains retryable.
				pi.appendEntry(
					COMPLETED_REVIEW_ENTRY_TYPE,
					completedReviews.persist(pending.record, pending.session, reviewEntryId, leafReview),
				);
			} catch (error) {
				ctx.ui.notify(`Completed review cache will not survive an extension reload: ${String(error)}`, "warning");
			}
		}
		await publishCompletedReview(pending.record, { kind: "frozen-invocation" }, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const completion = classifyAssistantCompletion(event.message.stopReason, hasToolCall(event.message));
		if (completion === "continue_tools") {
			const toolCalls = Array.isArray(event.message.content)
				? event.message.content.filter((part) => part.type === "toolCall")
				: [];
			if (toolCalls.length === 1) {
				const call = toolCalls[0] as { id?: unknown; name?: unknown };
				if (call.name === "self_review_subagent" && typeof call.id === "string") {
					selfReviewCoordinator.bindToolCall(call.id, ctx);
				}
			}
			return;
		}
		if (completion === "clear_invocation" && !loopCoordinator.deadlineExpired()) {
			loopCoordinator.clear();
			persistTelemetry("cleared");
			return;
		}

		const text = assistantText(event.message);
		const active = loopCoordinator.peek();
		if (
			active &&
			loopCoordinator.phase() === "reviewing" &&
			isNonOpenConfirmationPrompt(text, active.prNumber)
		) {
			if (loopCoordinator.markAwaitingConfirmation()) telemetryTracker.pauseForConfirmation();
			return;
		}

		const strict = active ? parsePublishableReview(text) : undefined;
		const laneArtifacts = active ? loopCoordinator.artifactSnapshot(ctx) ?? [] : [];
		// Only a non-Markdown JSON envelope may enter the approval-capable strict
		// compatibility path. Fenced JSON remains Markdown with its raw body intact.
		const trustedStrictReview = active && strict?.source === "json" && strict.review &&
			!validateReviewInvocation(strict.review, active)
			? strict.review
			: undefined;
		const artifact = active?.reviewBinding
			? synthesizeReviewArtifact({
				rawText: text,
				prNumber: active.reviewBinding.prNumber,
				prTitle: active.reviewBinding.prTitle,
				headSha: active.reviewBinding.reviewedHeadSha,
				laneArtifacts,
				...(trustedStrictReview ? { strictJsonReview: trustedStrictReview } : {}),
			})
			: undefined;
		const publishable = artifact ? { review: artifact.review } : strict;

		// Cache the canonical artifact before consume() purges invocation-scoped
		// lanes, then revoke authority before rendering or publication begins.
		const completionInvocation = active && loopCoordinator.phase() === "confirmed"
			? { ...active, allowNonOpen: true }
			: active;
		const resolvedCompletion = completionInvocation
			? resolveCompletion(publishable!, completionInvocation, ctx, artifact)
			: undefined;
		// Persist timing before publication so network/write latency is never coupled to review wall time.
		const invocation = active ? loopCoordinator.consume() : undefined;
		if (invocation) {
			persistTelemetry("terminal_response");
			pendingCompletion = resolvedCompletion;
		}
		const review = publishable?.review
			? publishable.review as Review
			: active
				? null
				: text.trim()
					? parseReview(text)
					: null;
		if (!review) return; // not a renderable /pr-review JSON payload — leave untouched

		// Keep raw JSON for automation; only prettify for interactive terminals.
		if (ctx.mode !== "tui") return;
		const nonText = event.message.content.filter((part) => part.type !== "text");
		return {
			message: {
				...event.message,
				content: [...nonText, { type: "text", text: renderReviewMarkdown(review) }],
			},
		};
	});
}
