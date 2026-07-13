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
	parsePublishExistingArgs,
	parsePublishMode,
	parsePublishableReview,
	publishPullReview,
	resolveAutoPostSetting,
	resolveRepositoryBinding,
	restoreCompletedReviewBranch,
	shouldPublishReview,
	validateReviewInvocation,
	type AutoPostResolution,
	type CompletedReviewRecord,
	type CompletedReviewSessionIdentity,
	type RepositoryBinding,
	type ReviewInvocation,
	type ReviewLike,
} from "../lib/pr-review-publish.ts";
import {
	ReviewLoopCoordinator,
	type ReviewLoopInputSource,
} from "../lib/pr-review-loop.ts";
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

function resolvePublishingConfig(ctx: ExtensionContext): AutoPostResolution {
	const user = readJsonObject(path.join(getAgentDir(), "pr-review.json"));
	if (user.error) return { value: false, valid: false, source: "user", error: user.error };
	let project: ConfigReadResult | undefined;
	try {
		if (ctx.isProjectTrusted()) {
			project = readJsonObject(path.join(ctx.cwd, CONFIG_DIR_NAME, "pr-review.json"));
			if (project.error) return { value: false, valid: false, source: "project", error: project.error };
		}
	} catch {
		/* user config only */
	}
	return resolveAutoPostSetting(user.value, project?.value);
}

function notifyPublishResult(
	result: Awaited<ReturnType<typeof publishPullReview>>,
	source: string,
	ctx: ExtensionContext,
): void {
	if (result.status === "posted") {
		ctx.ui.notify(`PR review posted as COMMENT (${source})${result.url ? `: ${result.url}` : ""}`, "info");
	} else if (result.status === "posted_degraded") {
		ctx.ui.notify(`PR review posted (${source}): ${result.message}${result.url ? ` ${result.url}` : ""}`, "warning");
	} else if (result.status === "skipped_duplicate") {
		ctx.ui.notify("PR review not reposted: this reviewed head was already posted by the current GitHub identity", "info");
	} else {
		ctx.ui.notify(`PR review publish ${result.status}: ${result.message}`, "error");
	}
}

async function maybePublishReview(
	text: string,
	invocation: ReviewInvocation,
	ctx: ExtensionContext,
	expectedRepository?: RepositoryBinding,
): Promise<void> {
	const authority = decideReviewPublication(invocation);
	if (authority.error) {
		ctx.ui.notify(`PR review was not posted: ${authority.error}`, "error");
		return;
	}
	if (!authority.publish) return;
	const parsed = parsePublishableReview(text);
	if (!parsed.review) {
		ctx.ui.notify(`PR review was not posted: ${parsed.error}`, "error");
		return;
	}
	const bindingError = validateReviewInvocation(parsed.review, invocation);
	if (bindingError) {
		ctx.ui.notify(`PR review was not posted: ${bindingError}`, "error");
		return;
	}
	if (!shouldPublishReview(parsed.review)) return;
	const headSha = parsed.review.pr?.head_sha;
	if (typeof headSha !== "string") {
		ctx.ui.notify("PR review was not posted: final JSON is missing pr.head_sha", "error");
		return;
	}
	if (!expectedRepository) {
		ctx.ui.notify(
			"PR review was not posted because its repository identity could not be established before caching; no publish-only cache is available. Rerun /pr-review when GitHub repository lookup is working.",
			"error",
		);
		return;
	}
	const result = await publishPullReview({
		cwd: ctx.cwd,
		prNumber: invocation.prNumber,
		headSha,
		allowNonOpen: invocation.allowNonOpen,
		expectedRepository,
		review: parsed.review as ReviewLike,
	});
	notifyPublishResult(result, authority.source ?? "frozen invocation", ctx);
}

export default function registerReviewTable(
	pi: ExtensionAPI,
	loopCoordinator = new ReviewLoopCoordinator(pi),
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
	let pendingCompletion:
		| {
				text: string;
				invocation: ReviewInvocation;
				repository?: RepositoryBinding;
				record?: CompletedReviewRecord;
				session?: CompletedReviewSessionIdentity;
		  }
		| undefined;
	const telemetryTracker = new ReviewTelemetryTracker();
	const persistTelemetry = (completion: ReviewPerformanceTelemetry["completion"]) => {
		const telemetry = telemetryTracker.finish(completion);
		if (!telemetry) return;
		try {
			pi.appendEntry("pr-review-telemetry", telemetry);
		} catch {
			// Telemetry persistence must never block rendering or publication safety checks.
		}
	};

	pi.registerCommand("pr-review-publish", {
		description: "Publish a completed review from this session without rerunning the model",
		handler: async (args, ctx) => {
			const parsed = parsePublishExistingArgs(args ?? "");
			if (parsed.error || !parsed.prNumber) {
				ctx.ui.notify(
					`Invalid /pr-review-publish command: ${parsed.error ?? "missing PR number"}. Usage: /pr-review-publish <PR-NUM> [--allow-stale]`,
					"error",
				);
				return;
			}
			const active = loopCoordinator.peek();
			if (active) {
				loopCoordinator.clear();
				persistTelemetry("cleared");
			}
			if (active?.prNumber === parsed.prNumber) {
				ctx.ui.notify(
					`PR #${parsed.prNumber} review was cancelled. The publish-only command will not post an older cached result in its place.`,
					"error",
				);
				return;
			}
			let repository: RepositoryBinding;
			try {
				repository = await resolveRepositoryBinding(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`Cannot resolve the current GitHub repository: ${String(error)}`, "error");
				return;
			}
			const completed = completedReviews.get(parsed.prNumber, repository);
			if (!completed) {
				ctx.ui.notify(
					`No completed review for PR #${parsed.prNumber} is cached for this repository in the current extension session. This command never starts or reruns a review.`,
					"error",
				);
				return;
			}
			const headSha = completed.review.pr?.head_sha;
			if (typeof headSha !== "string") {
				ctx.ui.notify("Cached PR review is missing pr.head_sha", "error");
				return;
			}
			const result = await publishPullReview({
				cwd: ctx.cwd,
				prNumber: parsed.prNumber,
				headSha,
				allowNonOpen: completed.invocation.allowNonOpen,
				allowStale: parsed.allowStale,
				expectedRepository: completed.repository,
				review: completed.review,
			});
			notifyPublishResult(
				result,
				parsed.allowStale ? "publish-only --allow-stale" : "publish-only",
				ctx,
			);
		},
	});

	const revokeActiveLoop = () => {
		loopCoordinator.clear();
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

	pi.on("session_tree", (event, ctx) => {
		loopCoordinator.clear();
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

	pi.on("input", (event, ctx) => {
		const source = event.source as ReviewLoopInputSource;
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
		if (!parsed.matched) return;
		if (event.streamingBehavior !== undefined) {
			ctx.ui.notify("Invalid /pr-review invocation: queued or steering input cannot start a review loop", "error");
			return { action: "handled" as const };
		}
		if (!isOwnReviewPrompt(pi)) {
			ctx.ui.notify("Invalid /pr-review invocation: the active prompt is not the pi-pr-review package prompt", "error");
			return { action: "handled" as const };
		}

		// Freeze trusted publication config before review tools or optional PR code can run.
		const gate = loopCoordinator.begin(parsed, resolvePublishingConfig(ctx), source, ctx);
		if (!gate.accepted) {
			ctx.ui.notify(`Invalid /pr-review invocation: ${gate.error}`, "error");
			return { action: "handled" as const };
		}
		telemetryTracker.begin(parsed.prNumber!);
	});

	pi.on("tool_execution_start", (event) => {
		if (!loopCoordinator.peek()) return;
		telemetryTracker.toolStarted(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", (event) => {
		telemetryTracker.toolEnded(event.toolCallId);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const pending = pendingCompletion;
		pendingCompletion = undefined;
		if (!pending) return;
		if (pending.record && pending.session) {
			const currentSession = sessionIdentity(ctx);
			if (
				!currentSession ||
				currentSession.id !== pending.session.id ||
				currentSession.startedAt !== pending.session.startedAt
			) {
				ctx.ui.notify("Completed review was not persisted or posted because the session identity changed", "warning");
				return;
			}
			const leaf = ctx.sessionManager.getLeafEntry();
			const leafText = leaf?.type === "message" && leaf.message.role === "assistant"
				? assistantText(leaf.message as { content?: MessagePart[] })
				: "";
			const leafReview = parsePublishableReview(leafText).review;
			const reviewEntryId = leaf?.type === "message" && leaf.message.role === "assistant" && leafReview
				? leaf.id
				: undefined;
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
		await maybePublishReview(pending.text, pending.invocation, ctx, pending.repository);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const completion = classifyAssistantCompletion(event.message.stopReason, hasToolCall(event.message));
		if (completion === "continue_tools") return;
		if (completion === "clear_invocation") {
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

		// Every other terminal response consumes authority, whether valid, empty, or unrelated.
		// Persist timing before publication so network/write latency is never coupled to review wall time.
		const invocation = active ? loopCoordinator.consume() : undefined;
		if (invocation) persistTelemetry("terminal_response");
		if (!text.trim()) return;
		const review = parseReview(text);
		if (!review) return; // not a /pr-review JSON payload — leave untouched
		if (invocation) {
			const publishable = parsePublishableReview(text);
			let repository: RepositoryBinding | undefined;
			let record: CompletedReviewRecord | undefined;
			let session: CompletedReviewSessionIdentity | undefined;
			if (
				publishable.review &&
				!validateReviewInvocation(publishable.review, invocation) &&
				shouldPublishReview(publishable.review)
			) {
				try {
					repository = await resolveRepositoryBinding(ctx.cwd);
					// Cache before publication preflight; persist after Pi stores the assistant message.
					record = completedReviews.remember(publishable.review, invocation, repository);
					session = sessionIdentity(ctx);
					if (!session) {
						ctx.ui.notify("Completed review cache will not survive reload: session identity is unavailable", "warning");
					}
				} catch (error) {
					ctx.ui.notify(`Completed review is not available to publish-only: ${String(error)}`, "warning");
				}
			}
			pendingCompletion = { text, invocation, repository, record, session };
		}

		// Keep raw JSON for automation; only prettify for interactive terminals.
		if (ctx.mode !== "tui") return;
		const nonText = (event.message.content as MessagePart[]).filter((p) => p.type !== "text");
		return {
			message: {
				...event.message,
				content: [...nonText, { type: "text", text: renderReviewMarkdown(review) }],
			},
		};
	});
}
