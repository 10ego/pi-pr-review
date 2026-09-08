import {
	githubApiArgs,
	ghJson,
	ghText,
	resolveRepositoryBinding,
} from "./pr-review-publish.ts";

/** Prior-review discovery powers incremental re-reviews. The durable source of
 * truth is GitHub: reviews authored by the current identity whose body carries
 * the canonical schema-1 head marker, plus the inline comment threads attached
 * to that review. Everything here is read-only and bounded. */

export const PRIOR_REVIEW_MAX_PAGES = 5;
export const PRIOR_REVIEW_PER_PAGE = 100;
export const PRIOR_REVIEW_MAX_FINDINGS = 200;
export const PRIOR_COMMIT_MAX_PAGES = 3;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SCHEMA_ONE_MARKER = /<!-- pi-pr-review: \{"schema":1,"headRefOid":"([0-9a-f]{40}(?:[0-9a-f]{24})?)"\} -->/gi;
const INLINE_TITLE = /^\*\*\[(P0|P1|P2|P3|nit)\]\s*(.*?)\s*\*\*\s*$/;
const TITLE_MAX_CHARS = 200;

export type PriorReviewRelationship = "none" | "same_head" | "incremental" | "diverged";

export interface PriorReviewFinding {
	threadId: number;
	inReplyToId: number | null;
	path: string;
	startLine?: number;
	line: number;
	side: "LEFT" | "RIGHT";
	severity?: "P0" | "P1" | "P2" | "P3" | "nit";
	title: string;
	/** Bounded rationale excerpt from the original inline comment body. */
	excerpt?: string;
}

export interface PriorReviewSnapshot {
	action: "get";
	prNumber: number;
	repository: string;
	hostname: string;
	identity: string;
	currentHead: string;
	relationship: PriorReviewRelationship;
	prior?: {
		head: string;
		reviewId: number;
		submittedAt?: string;
		findings: PriorReviewFinding[];
	};
	incrementalRange?: { from: string; to: string; commitCount: number };
	truncated: boolean;
	message: string;
}

export interface PriorReviewDiscoveryOptions {
	signal?: AbortSignal;
	/** Test-only repository identity override; production resolves the binding from cwd. */
	repository?: { repository: string; hostname: string };
	/** Test-only identity override; production resolves the gh login. */
	identity?: string;
}

/** Extract the latest canonical schema-1 head marker from a review body. */
export function parsePriorReviewMarker(body: string | null | undefined): string | undefined {
	if (!body) return undefined;
	let found: string | undefined;
	for (const match of body.matchAll(SCHEMA_ONE_MARKER)) {
		const head = match[1]?.toLowerCase();
		if (head && FULL_SHA_PATTERN.test(head)) found = head;
	}
	return found;
}

/** Parse severity and title from a published inline finding body (`**[P1] Title**`). */
export function parseInlineFindingBody(body: string | null | undefined): {
	severity?: PriorReviewFinding["severity"];
	title?: string;
} {
	if (typeof body !== "string" || !body.trim()) return {};
	const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
	// Anchor to the outer closing delimiter so a title that itself contains
	// bold spans (`**[P1] Fix **foo** handling**`) is recovered whole.
	const match = INLINE_TITLE.exec(firstLine);
	if (match) {
		const severity = match[1] as PriorReviewFinding["severity"];
		const title = (match[2] ?? "").trim();
		return {
			severity,
			...(title ? { title: title.slice(0, TITLE_MAX_CHARS) } : {}),
		};
	}
	const title = firstLine.replace(/^\*\*(.*)\*\*$/, "$1").trim();
	return title ? { title: title.slice(0, TITLE_MAX_CHARS) } : {};
}

const EXCERPT_MAX_CHARS = 500;

/** Build a bounded rationale excerpt from an inline comment body. */
export function commentExcerpt(body: string | null | undefined): string | undefined {
	if (typeof body !== "string") return undefined;
	const rest = body.split(/\r?\n/).slice(1).join("\n").replace(/\s+/g, " ").trim();
	if (!rest) return undefined;
	return rest.slice(0, EXCERPT_MAX_CHARS);
}

/** Classify a prior/current head pairing against the PR commit history. */
export function classifyPriorHead(input: {
	priorHead: string | undefined;
	currentHead: string;
	commitShas: readonly string[];
}): { relationship: PriorReviewRelationship; incrementalRange?: PriorReviewSnapshot["incrementalRange"] } {
	const priorHead = input.priorHead?.toLowerCase();
	const currentHead = input.currentHead.toLowerCase();
	if (!priorHead) return { relationship: "none" };
	if (priorHead === currentHead) return { relationship: "same_head" };
	const shas = input.commitShas.map((sha) => sha.toLowerCase());
	const index = shas.lastIndexOf(priorHead);
	if (index === -1) return { relationship: "diverged" };
	const commitCount = shas.length - 1 - index;
	return { relationship: "incremental", incrementalRange: { from: priorHead, to: currentHead, commitCount } };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validSha(value: unknown): value is string {
	return typeof value === "string" && FULL_SHA_PATTERN.test(value);
}

/** Fetch one bounded paginated list endpoint. Returns parsed pages plus a truncation flag. */
async function fetchBoundedPages(
	cwd: string,
	hostname: string,
	firstArgs: string[],
	maxPages: number,
	options: PriorReviewDiscoveryOptions,
): Promise<{ entries: unknown[]; truncated: boolean }> {
	const entries: unknown[] = [];
	let truncated = false;
	for (let page = 1; page <= maxPages; page++) {
		const anchor = firstArgs[firstArgs.length - 1]!;
		const separator = anchor.includes("?") ? "&" : "?";
		const args = [...firstArgs.slice(0, -1), `${anchor}${separator}per_page=${PRIOR_REVIEW_PER_PAGE}&page=${page}`];
		const value = await ghJson<unknown>(githubApiArgs(hostname, ...args), cwd, undefined, { signal: options.signal });
		if (!Array.isArray(value)) throw new Error("GitHub returned a malformed paginated list");
		entries.push(...value);
		if (value.length < PRIOR_REVIEW_PER_PAGE) break;
		if (page === maxPages) truncated = true;
	}
	return { entries, truncated };
}

interface GhPullReview {
	id: number;
	user?: { login?: string | null } | null;
	body: string | null;
	state?: string | null;
	submitted_at?: string | null;
}

interface GhPullComment {
	id: number;
	pull_request_review_id?: number | null;
	in_reply_to_id?: number | null;
	path?: string | null;
	line?: number | null;
	original_line?: number | null;
	start_line?: number | null;
	original_start_line?: number | null;
	side?: string | null;
	body?: string | null;
}

interface GhPullCommit {
	sha?: string | null;
}

/** Discover the latest marker-bearing review by the current identity and its findings. */
export async function discoverPriorReview(
	cwd: string,
	prNumber: number,
	options: PriorReviewDiscoveryOptions = {},
): Promise<PriorReviewSnapshot> {
	if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("invalid PR number");

	const binding = options.repository ?? await resolveRepositoryBinding(cwd);
	// `gh api user --jq .login` emits a bare unquoted login, so this must go
	// through ghText; JSON.parse of the raw login would always throw.
	const identityLogin = options.identity ??
		(await ghText(githubApiArgs(binding.hostname, "user", "--jq", ".login"), cwd, undefined, {
			signal: options.signal,
		})).replace(/\s+/g, "");
	if (!identityLogin) throw new Error("GitHub identity lookup returned no login");

	const pullsPath = `repos/${binding.repository}/pulls/${prNumber}`;
	const pull = await ghJson<{ head?: { sha?: unknown }; state?: unknown }>(
		githubApiArgs(binding.hostname, pullsPath),
		cwd,
		undefined,
		{ signal: options.signal },
	);
	const currentHead = pull?.head?.sha;
	if (!validSha(currentHead)) throw new Error("GitHub PR metadata omitted a valid head SHA");

	const base: Omit<PriorReviewSnapshot, "relationship" | "prior" | "incrementalRange" | "message"> = {
		action: "get",
		prNumber,
		repository: binding.repository,
		hostname: binding.hostname,
		identity: identityLogin,
		currentHead: currentHead.toLowerCase(),
		truncated: false,
	};

	const reviewPages = await fetchBoundedPages(cwd, binding.hostname, [pullsPath + "/reviews"], PRIOR_REVIEW_MAX_PAGES, options);
	let prior: { head: string; reviewId: number; submittedAt?: string } | undefined;
	for (const entry of [...reviewPages.entries].reverse()) {
		if (!isObject(entry)) continue;
		const review = entry as unknown as GhPullReview;
		if (typeof review.id !== "number") continue;
		const login = review.user?.login;
		if (typeof login !== "string" || login.toLowerCase() !== identityLogin.toLowerCase()) continue;
		if (typeof review.state === "string" && review.state.toUpperCase() === "PENDING") continue;
		const head = parsePriorReviewMarker(review.body);
		if (!head) continue;
		prior = {
			head,
			reviewId: review.id,
			...(typeof review.submitted_at === "string" && review.submitted_at ? { submittedAt: review.submitted_at } : {}),
		};
		break;
	}

	if (!prior) {
		// A capped review search cannot prove no marker review exists beyond the
		// bound; preserve the truncation flag and its fail-open guidance instead
		// of claiming definitively that no prior review exists.
		return {
			...base,
			...(reviewPages.truncated ? { truncated: true } : {}),
			relationship: "none",
			message: reviewPages.truncated
				? "Review discovery was truncated by pagination bounds before any marker review was found; run a full review."
				: "No prior pi-pr-review review by the current identity on this PR; run a full review.",
		};
	}

	// Fetch sequentially: a failing read must never leave an unawaited sibling
	// paginated gh process running in the background past the tool call.
	const commentPages = await fetchBoundedPages(cwd, binding.hostname, [pullsPath + "/comments"], PRIOR_REVIEW_MAX_PAGES, options);
	const commitPages = await fetchBoundedPages(cwd, binding.hostname, [pullsPath + "/commits"], PRIOR_COMMIT_MAX_PAGES, options);

	const findings: PriorReviewFinding[] = [];
	let findingsTruncated = false;
	for (const entry of commentPages.entries) {
		if (!isObject(entry)) continue;
		const comment = entry as unknown as GhPullComment;
		if (comment.pull_request_review_id !== prior.reviewId) continue;
		if (typeof comment.path !== "string" || !comment.path) continue;
		const line = comment.line ?? comment.original_line;
		if (!Number.isInteger(line) || (line as number) < 1) continue;
		const rawSide = comment.side?.toUpperCase();
		const side = rawSide === "LEFT" ? "LEFT" : "RIGHT";
		const startLine = Number.isInteger(comment.start_line ?? comment.original_start_line)
			? (comment.start_line ?? comment.original_start_line) as number
			: undefined;
		const parsed = parseInlineFindingBody(comment.body);
		if (findings.length >= PRIOR_REVIEW_MAX_FINDINGS) {
			findingsTruncated = true;
			break;
		}
		const excerpt = commentExcerpt(comment.body);
		findings.push({
			threadId: comment.id,
			inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : null,
			path: comment.path,
			...(startLine !== undefined && startLine >= 1 && startLine < (line as number) ? { startLine } : {}),
			line: line as number,
			side,
			...(parsed.severity ? { severity: parsed.severity } : {}),
			title: parsed.title ?? "Untitled prior finding",
			...(excerpt ? { excerpt } : {}),
		});
	}

	const commitShas = commitPages.entries
		.filter((entry): entry is GhPullCommit => isObject(entry))
		.map((entry) => (typeof entry.sha === "string" ? entry.sha.toLowerCase() : ""))
		.filter((sha) => FULL_SHA_PATTERN.test(sha));
	const { relationship, incrementalRange } = classifyPriorHead({
		priorHead: prior.head,
		currentHead: base.currentHead,
		commitShas,
	});

	const truncated = findingsTruncated || reviewPages.truncated || commentPages.truncated || commitPages.truncated;
	// Truncated discovery cannot prove which review is latest or that every
	// prior finding was retained; fail open to a full review instead of letting
	// a capped read silently skip fresh hunting or prior blockers.
	const failOpenRelationship: PriorReviewRelationship = truncated ? "none" : relationship;
	const snapshot: PriorReviewSnapshot = {
		...base,
		truncated,
		relationship: failOpenRelationship,
		prior: {
			...prior,
			findings,
		},
		...(!truncated && incrementalRange ? { incrementalRange } : {}),
		message: truncated
			? "Discovery was truncated by pagination or finding bounds; prior state is retained for diagnostics only. Run a full review."
			: priorReviewMessage(relationship, truncated),
	};
	return snapshot;
}

function priorReviewMessage(relationship: PriorReviewRelationship, truncated: boolean): string {
	const suffix = truncated ? " Results were truncated by discovery bounds." : "";
	switch (relationship) {
		case "same_head":
			return "Prior review of this exact head found; revalidate prior findings without re-hunting." + suffix;
		case "incremental":
			return "Prior review found at an ancestor head; run an incremental re-review of the new commits." + suffix;
		case "diverged":
			return "Prior review head is no longer in the PR commit history (force-push or rebase); run a full review." + suffix;
		default:
			return "No prior review relationship established." + suffix;
	}
}