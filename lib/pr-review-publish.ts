import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export type PublishMode = "auto" | "force" | "disabled";
export type AutoPostSource = "default" | "user" | "project";
export type CompletionAction = "continue_tools" | "accept_final" | "clear_invocation";

export function classifyAssistantCompletion(
	stopReason: string | undefined,
	hasToolCall: boolean,
): CompletionAction {
	if (stopReason === "toolUse" && hasToolCall) return "continue_tools";
	if (stopReason === "stop" && !hasToolCall) return "accept_final";
	return "clear_invocation";
}

export interface AutoPostResolution {
	value: boolean;
	valid: boolean;
	source: AutoPostSource;
	error?: string;
}

function hasOwn(value: unknown, key: string): boolean {
	return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

/** Resolve a strict boolean with trusted project config overlaying user config. */
export function resolveAutoPostSetting(user: unknown, trustedProject?: unknown): AutoPostResolution {
	if (hasOwn(trustedProject, "autoPostReviews")) {
		const value = (trustedProject as { autoPostReviews?: unknown }).autoPostReviews;
		return typeof value === "boolean"
			? { value, valid: true, source: "project" }
			: {
					value: false,
					valid: false,
					source: "project",
					error: "project autoPostReviews must be a boolean",
				};
	}
	if (hasOwn(user, "autoPostReviews")) {
		const value = (user as { autoPostReviews?: unknown }).autoPostReviews;
		return typeof value === "boolean"
			? { value, valid: true, source: "user" }
			: {
					value: false,
					valid: false,
					source: "user",
					error: "user autoPostReviews must be a boolean",
				};
	}
	return { value: false, valid: true, source: "default" };
}

export interface PublishModeParseResult {
	matched: boolean;
	mode?: PublishMode;
	prNumber?: number;
	allowNonOpen?: boolean;
	error?: string;
}

/** Parse trusted raw prompt-template invocation flags before template expansion. */
export function parsePublishMode(input: string): PublishModeParseResult {
	const trimmed = input.trim();
	if (!/^\/(?:prompt:)?pr-review(?:\s|$)/.test(trimmed)) return { matched: false };
	const tokens = trimmed.split(/\s+/);
	const requested = Number(tokens[1]);
	if (!Number.isInteger(requested) || requested <= 0) {
		return { matched: true, error: "a positive PR number must be the first argument" };
	}
	const force = tokens.includes("--comment");
	const disabled = tokens.includes("--no-comment");
	if (force && disabled) {
		return { matched: true, error: "--comment and --no-comment cannot be used together" };
	}
	return {
		matched: true,
		mode: disabled ? "disabled" : force ? "force" : "auto",
		prNumber: requested,
		allowNonOpen: tokens.includes("--include-closed") || tokens.includes("--review-closed"),
	};
}

export interface ReviewInvocation {
	mode: PublishMode;
	prNumber: number;
	allowNonOpen: boolean;
}

export type ReviewInvocationPhase = "reviewing" | "awaiting_confirmation" | "confirmed";

export function isNonOpenConfirmationPrompt(text: string, prNumber: number): boolean {
	const escaped = String(prNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.trim().match(
		new RegExp(
			`^PR #${escaped} is ([A-Z_]+) \\(head [0-9a-f]{40}(?:[0-9a-f]{24})?\\)\\. Review it anyway\\? Reply yes, or rerun with --include-closed to proceed non-interactively\\.$`,
			"i",
		),
	);
	return !!match && ["CLOSED", "MERGED"].includes(match[1]?.toUpperCase() ?? "");
}

export function isAffirmativeReviewConfirmation(text: string): boolean {
	return /^(?:y|yes)[.!]?$/i.test(text.trim());
}

export function validateReviewInvocation(review: ReviewLike, invocation: ReviewInvocation): string | undefined {
	return review.pr?.number === invocation.prNumber
		? undefined
		: `final JSON PR #${review.pr?.number ?? "?"} does not match requested PR #${invocation.prNumber}`;
}

/** One active invocation per extension session; queued reviews cannot overwrite its write intent. */
export class ReviewInvocationGate {
	private active?: ReviewInvocation;
	private currentPhase?: ReviewInvocationPhase;

	begin(parsed: PublishModeParseResult): { accepted: boolean; error?: string } {
		if (!parsed.matched) return { accepted: false, error: "not a pr-review invocation" };
		if (this.active) {
			return { accepted: false, error: `PR #${this.active.prNumber} review is still active` };
		}
		if (parsed.error || !parsed.mode || !parsed.prNumber) {
			return { accepted: false, error: parsed.error ?? "missing PR number or publishing mode" };
		}
		this.active = {
			mode: parsed.mode,
			prNumber: parsed.prNumber,
			allowNonOpen: parsed.allowNonOpen === true,
		};
		this.currentPhase = "reviewing";
		return { accepted: true };
	}

	peek(): ReviewInvocation | undefined {
		return this.active;
	}

	phase(): ReviewInvocationPhase | undefined {
		return this.currentPhase;
	}

	markAwaitingConfirmation(): boolean {
		if (!this.active || this.currentPhase !== "reviewing") return false;
		this.currentPhase = "awaiting_confirmation";
		return true;
	}

	resolveConfirmationInput(text: string): "not_awaiting" | "confirmed" | "cleared" {
		if (!this.active || this.currentPhase !== "awaiting_confirmation") return "not_awaiting";
		if (isAffirmativeReviewConfirmation(text)) {
			this.currentPhase = "confirmed";
			return "confirmed";
		}
		this.clear();
		return "cleared";
	}

	consume(): ReviewInvocation | undefined {
		const value = this.active
			? {
					...this.active,
					allowNonOpen: this.active.allowNonOpen || this.currentPhase === "confirmed",
				}
			: undefined;
		this.clear();
		return value;
	}

	clear(): void {
		this.active = undefined;
		this.currentPhase = undefined;
	}
}

export function canonicalReviewMarker(headSha: string): string {
	return `<!-- pi-pr-review: {"schema":1,"headRefOid":"${headSha.toLowerCase()}"} -->`;
}

export function githubApiArgs(hostname: string, ...args: string[]): string[] {
	return ["api", "--hostname", hostname, ...args];
}

export const REVIEW_EVENT = "COMMENT" as const;
export const MAX_INLINE_COMMENTS = 50;
const MAX_BODY_BYTES = 65_536;
const MAX_PAYLOAD_BYTES = 900_000;
const RESERVED_MARKER_PREFIX = "<!-- pi-pr-review:";

export interface PublishComment {
	path: string;
	body: string;
	line: number;
	side: "LEFT" | "RIGHT";
	start_line?: number;
	start_side?: "LEFT" | "RIGHT";
}

export interface PullReviewPayload {
	commit_id: string;
	event: typeof REVIEW_EVENT;
	body: string;
	comments?: PublishComment[];
}

/** Build the only GitHub review payload this package can emit. */
export function buildPullReviewPayload(
	headSha: string,
	body: string,
	comments: PublishComment[],
): PullReviewPayload {
	return {
		commit_id: headSha,
		event: REVIEW_EVENT,
		body,
		...(comments.length > 0 ? { comments } : {}),
	};
}

export interface ReviewFindingLike {
	title?: string;
	body?: string;
	severity?: string;
	blocking?: boolean;
	confidence_score?: number;
	code_location?: {
		absolute_file_path?: string | null;
		line_range?: { start?: number; end?: number };
		side?: string | null;
		commentable?: boolean;
	} | null;
}

export interface ReviewLike {
	pr?: { number?: number | null; title?: string | null; head_sha?: string | null } | null;
	disposition?: "reviewed" | "skipped";
	verification?: string;
	overview?: string;
	strengths?: string[];
	findings?: ReviewFindingLike[];
	notes?: { correctness?: string; security?: string; performance?: string } | null;
	verdict?: string;
	overall_correctness?: string;
	overall_explanation?: string;
	overall_confidence_score?: number;
}

export interface PublishableReviewParseResult {
	review?: ReviewLike;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isConfidence(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Publication accepts only one complete JSON object, never fenced/prose-wrapped drafts. */
export function parsePublishableReview(text: string): PublishableReviewParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return { error: "final response is not exactly one JSON object" };
	}
	if (!isObject(value)) return { error: "final review must be a JSON object" };
	const pr = value.pr;
	if (!isObject(pr) || !Number.isInteger(pr.number) || Number(pr.number) <= 0 || typeof pr.title !== "string") {
		return { error: "pr.number and pr.title are required" };
	}
	if (typeof pr.head_sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(pr.head_sha)) {
		return { error: "pr.head_sha must be a full hexadecimal commit SHA" };
	}
	if (value.disposition !== "reviewed" && value.disposition !== "skipped") {
		return { error: "disposition must be reviewed or skipped" };
	}
	for (const key of ["verification", "overview", "overall_explanation"] as const) {
		if (typeof value[key] !== "string") return { error: `${key} must be a string` };
	}
	if (!Array.isArray(value.strengths) || !value.strengths.every((item) => typeof item === "string")) {
		return { error: "strengths must be an array of strings" };
	}
	if (!Array.isArray(value.findings)) return { error: "findings must be an array" };
	const severities = new Set(["P0", "P1", "P2", "P3", "nit"]);
	for (const [index, finding] of value.findings.entries()) {
		if (!isObject(finding)) return { error: `finding ${index + 1} must be an object` };
		if (typeof finding.title !== "string" || typeof finding.body !== "string") {
			return { error: `finding ${index + 1} title/body must be strings` };
		}
		if (typeof finding.severity !== "string" || !severities.has(finding.severity)) {
			return { error: `finding ${index + 1} has invalid severity` };
		}
		if (typeof finding.blocking !== "boolean" || finding.blocking !== ["P0", "P1"].includes(finding.severity)) {
			return { error: `finding ${index + 1} has inconsistent blocking value` };
		}
		if (!isConfidence(finding.confidence_score)) {
			return { error: `finding ${index + 1} has invalid confidence_score` };
		}
		if (finding.code_location !== null) {
			const location = finding.code_location;
			if (!isObject(location) || typeof location.commentable !== "boolean") {
				return { error: `finding ${index + 1} has invalid code_location` };
			}
			if (location.absolute_file_path !== null && typeof location.absolute_file_path !== "string") {
				return { error: `finding ${index + 1} has invalid absolute_file_path` };
			}
			if (location.side !== null && location.side !== "LEFT" && location.side !== "RIGHT") {
				return { error: `finding ${index + 1} has invalid side` };
			}
			if (!isObject(location.line_range) || !Number.isInteger(location.line_range.start) || !Number.isInteger(location.line_range.end)) {
				return { error: `finding ${index + 1} has invalid line_range` };
			}
		}
	}
	if (!isObject(value.notes)) return { error: "notes must be an object" };
	for (const key of ["correctness", "security", "performance"] as const) {
		if (typeof value.notes[key] !== "string") return { error: `notes.${key} must be a string` };
	}
	if (!new Set(["approve", "request_changes", "comment"]).has(String(value.verdict))) {
		return { error: "verdict is invalid" };
	}
	if (!new Set(["patch is correct", "patch is incorrect"]).has(String(value.overall_correctness))) {
		return { error: "overall_correctness is invalid" };
	}
	if (!isConfidence(value.overall_confidence_score)) {
		return { error: "overall_confidence_score is invalid" };
	}
	return { review: value as unknown as ReviewLike };
}

export function shouldPublishReview(review: ReviewLike): boolean {
	return review.disposition === "reviewed";
}

function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function findingLocation(finding: ReviewFindingLike): string {
	const location = finding.code_location;
	if (!location?.absolute_file_path) return "summary-only";
	const start = location.line_range?.start;
	const end = location.line_range?.end;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return location.absolute_file_path;
	return `${location.absolute_file_path}:${start}${end !== start ? `-${end}` : ""} ${(location.side ?? "RIGHT").toUpperCase()}`;
}

export function buildReviewSummary(review: ReviewLike): string {
	const lines: string[] = [];
	const number = review.pr?.number;
	const title = String(review.pr?.title ?? "").replace(/\r?\n/g, " ").trim();
	lines.push(`## Code Review${number != null ? ` — PR #${number}${title ? `: ${title}` : ""}` : ""}`, "");
	if (review.verification?.trim()) lines.push(`**Verification:** ${review.verification.trim()}`, "");
	if (review.overview?.trim()) lines.push("### Overview", "", review.overview.trim(), "");
	if (review.strengths?.length) {
		lines.push("### Strengths", "", ...review.strengths.map((strength) => `- ${String(strength).replace(/^\s*-\s*/, "").trim()}`), "");
	}
	const findings = Array.isArray(review.findings) ? review.findings : [];
	lines.push(`### Findings — ${findings.length}`, "");
	if (findings.length === 0) {
		lines.push("_No issues found._", "");
	} else {
		lines.push("| Severity | Finding | Location |", "|---|---|---|");
		for (const finding of findings) {
			lines.push(
				`| ${cell(String(finding.severity ?? "—"))} | ${cell(String(finding.title ?? "(untitled)"))} | \`${cell(findingLocation(finding))}\` |`,
			);
		}
		lines.push("");
		for (const finding of findings) {
			lines.push(`#### ${String(finding.title ?? "Finding")}`, `\`${findingLocation(finding)}\``, "");
			if (finding.body?.trim()) lines.push(finding.body.trim(), "");
		}
	}
	const notes = review.notes;
	if (notes?.correctness || notes?.security || notes?.performance) {
		lines.push("### Correctness / Security / Performance", "");
		if (notes.correctness) lines.push(`- **Correctness:** ${notes.correctness}`);
		if (notes.security) lines.push(`- **Security:** ${notes.security}`);
		if (notes.performance) lines.push(`- **Performance:** ${notes.performance}`);
		lines.push("");
	}
	lines.push("### Verdict", "", `**Suggested verdict:** ${review.verdict ?? "comment"}`);
	if (review.overall_explanation?.trim()) lines.push("", review.overall_explanation.trim());
	if (typeof review.overall_confidence_score === "number") {
		lines.push("", `_Confidence: ${review.overall_confidence_score.toFixed(2)}_`);
	}
	return lines.join("\n").trim();
}

interface DiffHunk {
	left: Set<number>;
	right: Set<number>;
}

function parsePatchHunks(patch: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | undefined;
	let left = 0;
	let right = 0;
	for (const line of patch.split("\n")) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (header) {
			left = Number(header[1]);
			right = Number(header[2]);
			current = { left: new Set<number>(), right: new Set<number>() };
			hunks.push(current);
			continue;
		}
		if (!current || line.startsWith("\\")) continue;
		if (line.startsWith("+")) {
			current.right.add(right++);
		} else if (line.startsWith("-")) {
			current.left.add(left++);
		} else if (line.startsWith(" ")) {
			current.left.add(left++);
			current.right.add(right++);
		}
	}
	return hunks;
}

export interface ChangedFileLike {
	filename?: string;
	patch?: string;
}

function safeRelativePath(value: string): boolean {
	if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isInlineSeverity(finding: ReviewFindingLike): boolean {
	const severity = String(finding.severity ?? "").toUpperCase();
	return ["P0", "P1", "P2", "P3"].includes(severity);
}

export interface CommentValidationResult {
	comments: PublishComment[];
	errors: string[];
}

export function validateInlineComments(
	review: ReviewLike,
	changedFiles: ChangedFileLike[],
): CommentValidationResult {
	const errors: string[] = [];
	const comments: PublishComment[] = [];
	const files = new Map<string, ChangedFileLike>();
	for (const file of changedFiles) {
		if (file.filename) files.set(file.filename, file);
	}
	const anchors = new Set<string>();
	for (const [index, finding] of (review.findings ?? []).entries()) {
		const location = finding.code_location;
		if (!location?.commentable || !isInlineSeverity(finding)) continue;
		const path = String(location.absolute_file_path ?? "");
		const side = String(location.side ?? "").toUpperCase();
		const start = location.line_range?.start;
		const end = location.line_range?.end;
		const label = `finding ${index + 1}`;
		if (!safeRelativePath(path)) {
			errors.push(`${label}: invalid repo-relative path`);
			continue;
		}
		if (side !== "LEFT" && side !== "RIGHT") {
			errors.push(`${label}: side must be LEFT or RIGHT`);
			continue;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) <= 0 || Number(end) < Number(start)) {
			errors.push(`${label}: invalid line range`);
			continue;
		}
		const file = files.get(path);
		if (!file) {
			errors.push(`${label}: path is not a changed file`);
			continue;
		}
		if (!file.patch) {
			errors.push(`${label}: diff patch is unavailable for anchor validation`);
			continue;
		}
		const sideKey = side === "LEFT" ? "left" : "right";
		const hunk = parsePatchHunks(file.patch).find(
			(candidate) => candidate[sideKey].has(Number(start)) && candidate[sideKey].has(Number(end)),
		);
		if (!hunk) {
			errors.push(`${label}: line range is not inside one diff hunk on ${side}`);
			continue;
		}
		const anchor = `${path}:${side}:${start}:${end}`;
		if (anchors.has(anchor)) {
			errors.push(`${label}: duplicate inline anchor`);
			continue;
		}
		anchors.add(anchor);
		const body = [`**${String(finding.title ?? "Review finding").trim()}**`, finding.body?.trim()]
			.filter(Boolean)
			.join("\n\n");
		if (!body || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
			errors.push(`${label}: comment body is empty or too large`);
			continue;
		}
		comments.push({
			path,
			body,
			line: Number(end),
			side,
			...(Number(start) < Number(end) ? { start_line: Number(start), start_side: side } : {}),
		});
	}
	if (comments.length > MAX_INLINE_COMMENTS) {
		errors.push(`too many inline comments (${comments.length}; max ${MAX_INLINE_COMMENTS})`);
	}
	return { comments, errors };
}

export function collectFoldedComments(review: ReviewLike): CommentValidationResult {
	const comments: PublishComment[] = [];
	const errors: string[] = [];
	for (const [index, finding] of (review.findings ?? []).entries()) {
		const location = finding.code_location;
		if (!location?.commentable || !isInlineSeverity(finding)) continue;
		const path = String(location.absolute_file_path ?? "");
		const side = String(location.side ?? "").toUpperCase();
		const start = location.line_range?.start;
		const end = location.line_range?.end;
		const label = `finding ${index + 1}`;
		if (!safeRelativePath(path) || (side !== "LEFT" && side !== "RIGHT")) {
			errors.push(`${label}: invalid folded inline location`);
			continue;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) <= 0 || Number(end) < Number(start)) {
			errors.push(`${label}: invalid folded line range`);
			continue;
		}
		const body = [`**${String(finding.title ?? "Review finding").trim()}**`, finding.body?.trim()]
			.filter(Boolean)
			.join("\n\n");
		if (!body || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
			errors.push(`${label}: folded comment body is empty or too large`);
			continue;
		}
		comments.push({
			path,
			body,
			line: Number(end),
			side,
			...(Number(start) < Number(end) ? { start_line: Number(start), start_side: side } : {}),
		});
	}
	return { comments, errors };
}

export function foldInlineComments(summary: string, comments: PublishComment[]): string {
	if (comments.length === 0) return summary;
	const lines = [summary, "", "### Inline findings (folded for a non-open PR)", ""];
	for (const comment of comments) {
		const range = comment.start_line ? `${comment.start_line}-${comment.line}` : String(comment.line);
		lines.push(`#### \`${comment.path}:${range} ${comment.side}\``, "", comment.body, "");
	}
	return lines.join("\n").trim();
}

export function containsReservedReviewMarker(body: string): boolean {
	return body.toLowerCase().includes(RESERVED_MARKER_PREFIX);
}

function validateReviewBody(body: string): string | undefined {
	if (!body.trim()) return "review body is empty";
	if (containsReservedReviewMarker(body)) return "review content contains a reserved pi-pr-review marker";
	if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return "review body exceeds 65536 UTF-8 bytes";
	return undefined;
}

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	errorMessage?: string;
}

function runGh(args: string[], cwd: string, input?: string, timeoutMs = 60_000): Promise<GhResult> {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: GhResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		const proc = spawn("gh", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		proc.stdout.on("data", (data) => (stdout += data.toString()));
		proc.stderr.on("data", (data) => (stderr += data.toString()));
		proc.stdin.on("error", (error) => {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			if (!settled && code !== "EPIPE") stderr += error.message;
		});
		proc.on("error", (error) =>
			finish({ stdout, stderr, exitCode: 1, timedOut: false, errorMessage: error.message }),
		);
		proc.on("close", (code) => finish({ stdout, stderr, exitCode: code ?? 1, timedOut: false }));
		if (input !== undefined) proc.stdin.end(input);
		else proc.stdin.end();
		timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 3000);
			finish({ stdout, stderr, exitCode: 1, timedOut: true, errorMessage: "gh command timed out" });
		}, timeoutMs);
	});
}

async function ghText(args: string[], cwd: string): Promise<string> {
	const result = await runGh(args, cwd);
	if (result.exitCode !== 0) throw new Error(result.errorMessage || result.stderr || "gh command failed");
	return result.stdout.trim();
}

async function ghJson<T>(args: string[], cwd: string): Promise<T> {
	const text = await ghText(args, cwd);
	return JSON.parse(text) as T;
}

function flattenPages<T>(value: unknown): T[] {
	if (!Array.isArray(value)) return [];
	if (value.every(Array.isArray)) return value.flat() as T[];
	return value as T[];
}

interface AuthoredBody {
	body?: string | null;
	user?: { login?: string | null } | null;
}

export function bodyHasHeadMarker(body: string | null | undefined, normalizedHeadSha: string): boolean {
	if (!body) return false;
	const marker = /<!-- pi-pr-review: \{"schema":1,"headRefOid":"([0-9a-f]{40}(?:[0-9a-f]{24})?)"\} -->/gi;
	for (const match of body.matchAll(marker)) {
		if (match[1]?.toLowerCase() === normalizedHeadSha) return true;
	}
	return false;
}

async function hasExistingMarker(
	cwd: string,
	hostname: string,
	repository: string,
	prNumber: number,
	identity: string,
	normalizedHeadSha: string,
): Promise<boolean> {
	const reviewPages = await ghJson<unknown>(
		githubApiArgs(hostname, "--paginate", "--slurp", `repos/${repository}/pulls/${prNumber}/reviews?per_page=100`),
		cwd,
	);
	const commentPages = await ghJson<unknown>(
		githubApiArgs(hostname, "--paginate", "--slurp", `repos/${repository}/issues/${prNumber}/comments?per_page=100`),
		cwd,
	);
	return [...flattenPages<AuthoredBody>(reviewPages), ...flattenPages<AuthoredBody>(commentPages)].some(
		(item) =>
			item.user?.login?.toLowerCase() === identity.toLowerCase() &&
			bodyHasHeadMarker(item.body, normalizedHeadSha),
	);
}

interface PullState {
	state?: string;
	draft?: boolean;
	merged_at?: string | null;
	head?: { sha?: string };
}

export type PullLifecycle = "open" | "non_open";

export function authorizePullLifecycle(
	state: string | undefined,
	mergedAt: string | null | undefined,
	allowNonOpen: boolean,
): { lifecycle?: PullLifecycle; error?: string } {
	const normalized = state?.toLowerCase();
	if (normalized === "open" && !mergedAt) return { lifecycle: "open" };
	if (normalized === "closed" || !!mergedAt) {
		return allowNonOpen
			? { lifecycle: "non_open" }
			: { error: "closed or merged PR publication was not authorized by the invocation" };
	}
	return { error: `unknown PR lifecycle state: ${state ?? "missing"}` };
}

export type PublishStatus =
	| "skipped_duplicate"
	| "posted"
	| "posted_degraded"
	| "failed"
	| "indeterminate";

export interface PublishResult {
	status: PublishStatus;
	message: string;
	reviewId?: number;
	url?: string;
	reconciled?: boolean;
}

const publishLocks = new Map<string, Promise<void>>();

async function withPublishLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = publishLocks.get(key) ?? Promise.resolve();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = previous.then(() => gate);
	publishLocks.set(key, chain);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (publishLocks.get(key) === chain) publishLocks.delete(key);
	}
}

export async function publishPullReview(input: {
	cwd: string;
	prNumber: number;
	headSha: string;
	allowNonOpen: boolean;
	review: ReviewLike;
}): Promise<PublishResult> {
	const { cwd, prNumber, headSha, allowNonOpen, review } = input;
	if (!Number.isInteger(prNumber) || prNumber <= 0) return { status: "failed", message: "invalid PR number" };
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(headSha)) return { status: "failed", message: "invalid head SHA" };
	const normalizedHeadSha = headSha.toLowerCase();

	let repository: string;
	let hostname: string;
	let identity: string;
	try {
		const repoInfo = await ghJson<{ nameWithOwner?: string; url?: string }>(
			["repo", "view", "--json", "nameWithOwner,url"],
			cwd,
		);
		repository = String(repoInfo.nameWithOwner ?? "");
		hostname = new URL(String(repoInfo.url ?? "")).hostname;
		identity = await ghText(githubApiArgs(hostname, "user", "--jq", ".login"), cwd);
	} catch (error) {
		return { status: "failed", message: `GitHub identity/repository lookup failed: ${String(error)}` };
	}
	if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !/^[a-z0-9.-]+$/i.test(hostname) || !identity) {
		return { status: "failed", message: "invalid GitHub repository, hostname, or identity" };
	}

	const marker = canonicalReviewMarker(normalizedHeadSha);
	const lockKey = `${hostname}:${repository}:${prNumber}:${normalizedHeadSha}:${identity.toLowerCase()}`;
	return withPublishLock(lockKey, async () => {
		let pull: PullState;
		try {
			pull = await ghJson<PullState>(githubApiArgs(hostname, `repos/${repository}/pulls/${prNumber}`), cwd);
			if (pull.head?.sha?.toLowerCase() !== normalizedHeadSha) {
				return { status: "failed", message: "PR head changed after review; refusing to publish stale results" };
			}
			if (pull.draft) return { status: "failed", message: "draft PR reviews are not automatically published" };
			const lifecycle = authorizePullLifecycle(pull.state, pull.merged_at, allowNonOpen);
			if (!lifecycle.lifecycle) return { status: "failed", message: lifecycle.error ?? "invalid PR lifecycle" };
			if (await hasExistingMarker(cwd, hostname, repository, prNumber, identity, normalizedHeadSha)) {
				return { status: "skipped_duplicate", message: "same head already reviewed by this GitHub identity" };
			}
		} catch (error) {
			return { status: "failed", message: `GitHub preflight failed: ${String(error)}` };
		}

		const summary = buildReviewSummary(review);
		const bodyError = validateReviewBody(summary);
		if (bodyError) return { status: "failed", message: bodyError };

		const lifecycle = authorizePullLifecycle(pull.state, pull.merged_at, allowNonOpen);
		if (!lifecycle.lifecycle) return { status: "failed", message: lifecycle.error ?? "invalid PR lifecycle" };
		const isOpen = lifecycle.lifecycle === "open";
		const candidates = collectFoldedComments(review);
		if (candidates.errors.length > 0) {
			return { status: "failed", message: `inline candidate validation failed: ${candidates.errors.join("; ")}` };
		}
		let comments: PublishComment[] = candidates.comments;
		if (isOpen && comments.length > 0) {
			let filePages: unknown;
			try {
				filePages = await ghJson<unknown>(
					githubApiArgs(hostname, "--paginate", "--slurp", `repos/${repository}/pulls/${prNumber}/files?per_page=100`),
					cwd,
				);
			} catch (error) {
				return { status: "failed", message: `changed-file lookup failed: ${String(error)}` };
			}
			const validated = validateInlineComments(review, flattenPages<ChangedFileLike>(filePages));
			if (validated.errors.length > 0) {
				return { status: "failed", message: `inline validation failed: ${validated.errors.join("; ")}` };
			}
			comments = validated.comments;
		}

		const reviewBody = `${isOpen ? summary : foldInlineComments(summary, comments)}\n\n${marker}`;
		if (Buffer.byteLength(reviewBody, "utf8") > MAX_BODY_BYTES) {
			return { status: "failed", message: "final review body exceeds 65536 UTF-8 bytes" };
		}
		const payload = buildPullReviewPayload(normalizedHeadSha, reviewBody, isOpen ? comments : []);
		if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
			return { status: "failed", message: "review payload is too large" };
		}

		try {
			const refreshed = await ghJson<PullState>(
				githubApiArgs(hostname, `repos/${repository}/pulls/${prNumber}`),
				cwd,
			);
			if (refreshed.head?.sha?.toLowerCase() !== normalizedHeadSha) {
				return { status: "failed", message: "PR head changed during publish preflight" };
			}
			if (refreshed.draft) return { status: "failed", message: "PR became a draft during publish preflight" };
			const refreshedLifecycle = authorizePullLifecycle(refreshed.state, refreshed.merged_at, allowNonOpen);
			if (!refreshedLifecycle.lifecycle) {
				return { status: "failed", message: refreshedLifecycle.error ?? "invalid refreshed PR lifecycle" };
			}
			if ((refreshedLifecycle.lifecycle === "open") !== isOpen) {
				return { status: "failed", message: "PR open/closed state changed during publish preflight" };
			}
		} catch (error) {
			return { status: "failed", message: `final head check failed: ${String(error)}` };
		}

		const post = await runGh(
			githubApiArgs(hostname, "--method", "POST", `repos/${repository}/pulls/${prNumber}/reviews`, "--input", "-"),
			cwd,
			JSON.stringify(payload),
		);
		if (post.exitCode === 0) {
			let response: { id?: number; html_url?: string } = {};
			try {
				response = JSON.parse(post.stdout);
			} catch {
				/* accepted response without parseable metadata */
			}
			return {
				status: isOpen ? "posted" : "posted_degraded",
				message: isOpen ? "GitHub COMMENT review posted" : "body-only COMMENT review posted for non-open PR",
				reviewId: response.id,
				url: response.html_url,
			};
		}

		try {
			if (await hasExistingMarker(cwd, hostname, repository, prNumber, identity, normalizedHeadSha)) {
				return {
					status: isOpen ? "posted" : "posted_degraded",
					message: "GitHub review found during failure reconciliation",
					reconciled: true,
				};
			}
		} catch {
			/* reconciliation failure is handled below */
		}
		const detail = post.errorMessage || post.stderr || "gh review request failed";
		if (/HTTP\s+4\d\d/i.test(detail) && !post.timedOut) {
			return { status: "failed", message: detail };
		}
		return { status: "indeterminate", message: `${detail}; no matching marker found after reconciliation` };
	});
}
