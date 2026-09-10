import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyPriorHead,
	commentExcerpt,
	discussionExcerpt,
	discoverPriorReview,
	PriorRevalidationRegistry,
	parseInlineFindingBody,
	parseOtherNotesFindings,
	parsePriorReviewMarker,
} from "../lib/pr-review-prior.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dirs: string[] = [];

function marker(head: string): string {
	return `<!-- pi-pr-review: {"schema":1,"headRefOid":"${head}"} -->`;
}

describe("prior review marker parsing", () => {
	test("extracts the latest schema-1 marker and ignores schema-2 markers", () => {
		const body = `review body\n${marker(HEAD_A)}\n<!-- pi-pr-review: {"schema":2,"headRefOid":"${HEAD_B}","publicationAttemptId":"x"} -->`;
		expect(parsePriorReviewMarker(body)).toBe(HEAD_A);
	});

	test("keeps the last marker when several schema-1 markers exist", () => {
		const body = `${marker(HEAD_A)} and ${marker(HEAD_B)}`;
		expect(parsePriorReviewMarker(body)).toBe(HEAD_B);
	});

	test("returns undefined without a marker and rejects malformed heads", () => {
		expect(parsePriorReviewMarker("plain review")).toBeUndefined();
		expect(parsePriorReviewMarker(null)).toBeUndefined();
		expect(parsePriorReviewMarker(`<!-- pi-pr-review: {"schema":1,"headRefOid":"zzz"} -->`)).toBeUndefined();
	});
});

describe("prior inline finding body parsing", () => {
	test("parses the published bold severity title", () => {
		expect(parseInlineFindingBody("**[P1] Guard against nil map before write**\n\nrationale")).toEqual({
			severity: "P1",
			title: "Guard against nil map before write",
		});
	});

	test("builds bounded rationale and discussion excerpts", () => {
		expect(commentExcerpt("**[P1] Title**\n\ntrigger: nil map\n\nimpact: panic")).toBe("trigger: nil map impact: panic");
		expect(commentExcerpt("**[P1] Title**")).toBeUndefined();
		expect(commentExcerpt(undefined)).toBeUndefined();
		expect(commentExcerpt(`**[P1] Title**\n\n${"x".repeat(900)}`)?.length).toBe(500);
		expect(discussionExcerpt("  Fixed in abc.\n\nPlease\u0000 re-check. ")).toBe("Fixed in abc. Please re-check.");
		expect(discussionExcerpt(" ")).toBeUndefined();
		expect(discussionExcerpt("x".repeat(900))?.length).toBe(500);
	});

	test("recovers titles with nested bold spans and empty tag-only titles", () => {
		expect(parseInlineFindingBody("**[P1] Fix **foo** handling**\n\nrationale")).toEqual({
			severity: "P1",
			title: "Fix **foo** handling",
		});
		expect(parseInlineFindingBody("**[P2]**")).toEqual({ severity: "P2" });
		expect(parseInlineFindingBody("**[P1] Guard against nil map before write**\n\nrationale")).toEqual({
			severity: "P1",
			title: "Guard against nil map before write",
		});
	});

	test("falls back to a plain first line and truncates oversized titles", () => {
		expect(parseInlineFindingBody("plain note")).toEqual({ title: "plain note" });
		const long = "x".repeat(500);
		const parsed = parseInlineFindingBody(`**[nit] ${long}**`);
		expect(parsed.severity).toBe("nit");
		expect((parsed.title ?? "").length).toBe(200);
	});

	test("returns nothing for empty bodies", () => {
		expect(parseInlineFindingBody("")).toEqual({});
		expect(parseInlineFindingBody(undefined)).toEqual({});
	});
});

describe("prior head classification", () => {
	test("classifies missing prior, same head, ancestor, and diverged heads", () => {
		expect(classifyPriorHead({ priorHead: undefined, currentHead: HEAD_C, commitShas: [HEAD_A, HEAD_B, HEAD_C] }).relationship).toBe("none");
		expect(classifyPriorHead({ priorHead: HEAD_C, currentHead: HEAD_C, commitShas: [HEAD_A, HEAD_B, HEAD_C] }).relationship).toBe("same_head");
		const incremental = classifyPriorHead({ priorHead: HEAD_A, currentHead: HEAD_C, commitShas: [HEAD_A, HEAD_B, HEAD_C] });
		expect(incremental.relationship).toBe("incremental");
		expect(incremental.incrementalRange).toEqual({ from: HEAD_A, to: HEAD_C, commitCount: 2 });
		const diverged = classifyPriorHead({ priorHead: HEAD_B, currentHead: HEAD_C, commitShas: [HEAD_A, HEAD_C] });
		expect(diverged.relationship).toBe("diverged");
		expect(diverged.incrementalRange).toBeUndefined();
	});

	test("classifies case-insensitively", () => {
		expect(
			classifyPriorHead({ priorHead: HEAD_A.toUpperCase(), currentHead: HEAD_B, commitShas: [HEAD_A, HEAD_B] }).relationship,
		).toBe("incremental");
	});
});

interface FakeGhOptions {
	pullJson?: string;
	reviewsJson?: string;
	commentsJson?: string;
	commitsJson?: string;
}

function installFakeGh(options: FakeGhOptions = {}): { cwd: string; repository: { repository: string; hostname: string } } {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-prior-"));
	dirs.push(dir);
	const pullPath = path.join(dir, "pull.json");
	const reviewsPath = path.join(dir, "reviews.json");
	const commentsPath = path.join(dir, "comments.json");
	const commitsPath = path.join(dir, "commits.json");
	writeFileSync(pullPath, options.pullJson ?? JSON.stringify({ state: "open", head: { sha: HEAD_C } }));
	writeFileSync(reviewsPath, options.reviewsJson ?? "[]");
	writeFileSync(commentsPath, options.commentsJson ?? "[]");
	writeFileSync(commitsPath, options.commitsJson ?? JSON.stringify([{ sha: HEAD_A }, { sha: HEAD_B }, { sha: HEAD_C }]));
	const gh = path.join(dir, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"repos/acme/widget/pulls/7/reviews?per_page="* ]]; then
  cat "$PRIOR_FAKE_REVIEWS"
elif [[ "$args" == *"repos/acme/widget/pulls/7/comments?per_page="* ]]; then
  cat "$PRIOR_FAKE_COMMENTS"
elif [[ "$args" == *"repos/acme/widget/pulls/7/commits?per_page="* ]]; then
  cat "$PRIOR_FAKE_COMMITS"
elif [[ "$args" == *"repos/acme/widget/pulls/7" ]]; then
  cat "$PRIOR_FAKE_PULL"
elif [[ "$args" == *"user --jq .login"* ]]; then
  echo 'reviewer'
else
  echo "unexpected gh args: $args" >&2
  exit 1
fi
`,
	);
	chmodSync(gh, 0o755);
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	process.env.PRIOR_FAKE_PULL = pullPath;
	process.env.PRIOR_FAKE_REVIEWS = reviewsPath;
	process.env.PRIOR_FAKE_COMMENTS = commentsPath;
	process.env.PRIOR_FAKE_COMMITS = commitsPath;
	return { cwd: dir, repository: { repository: "acme/widget", hostname: "github.example" } };
}

describe("other notes reconstruction", () => {
	test("recovers body-only findings with locations and rationale", () => {
		const body = [
			"**Verdict:** comment",
			"See the inline review comments for the primary findings.",
			"### Other Notes",
			"",
			"**[nit] Rename tmp to buf for clarity**",
			"",
			"**[P2] Guard unbounded retry loop** — `src/a.ts:40-44 RIGHT`",
			"",
			"The retry loop grows without bound when the queue stays full.",
			"**[P1] Caller contract drift** — `src/callers.ts:7 LEFT`",
			"",
			"The caller no longer accepts the returned shape.",
		].join("\n");
		expect(parseOtherNotesFindings(body)).toEqual([
			{
				threadId: -1,
				inReplyToId: null,
				path: "(summary-only)",
				line: 0,
				side: "RIGHT",
				severity: "nit",
				title: "Rename tmp to buf for clarity",
			},
			{
				threadId: -1,
				inReplyToId: null,
				path: "src/a.ts",
				startLine: 40,
				line: 44,
				side: "RIGHT",
				severity: "P2",
				title: "Guard unbounded retry loop",
				excerpt: "The retry loop grows without bound when the queue stays full.",
			},
			{
				threadId: -1,
				inReplyToId: null,
				path: "src/callers.ts",
				line: 7,
				side: "LEFT",
				severity: "P1",
				title: "Caller contract drift",
				excerpt: "The caller no longer accepts the returned shape.",
			},
		]);
	});

	test("does not truncate later entries at headings inside a prior finding body", () => {
		const body = [
			"**Verdict:** comment",
			"### Other Notes",
			"",
			"**[P2] Guard unbounded retry loop** — `src/a.ts:40-44 RIGHT`",
			"",
			"The loop grows unbounded. See ### design notes below for context.",
			"",
			"**[P1] Caller contract drift** — `src/callers.ts:7 LEFT`",
			"",
			"The caller no longer accepts the returned shape.",
		].join("\n");
		const findings = parseOtherNotesFindings(body);
		expect(findings.map((finding) => finding.title)).toEqual([
			"Guard unbounded retry loop",
			"Caller contract drift",
		]);
	});

	test("keeps entries whose location path contains backticks", () => {
		const body = [
			"### Other Notes",
			"",
			"**[P2] Odd path** — `src/`tick`.ts:3 RIGHT`",
			"",
			"Body text.",
		].join("\n");
		const findings = parseOtherNotesFindings(body);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.severity).toBe("P2");
		expect(findings[0]!.title).toBe("Odd path");
	});

	test("returns nothing without an Other Notes section", () => {
		expect(parseOtherNotesFindings("no structured body")).toEqual([]);
		expect(parseOtherNotesFindings(undefined)).toEqual([]);
	});
});

describe("prior revalidation registry", () => {
	test("records per-session disclosure titles and prunes to a bound", () => {
		const registry = new PriorRevalidationRegistry();
		expect(registry.isRequired("s1", 1)).toBeUndefined();
		registry.mark("s1", 1, ["a", "b"]);
		expect(registry.isRequired("s1", 1)).toEqual(["a", "b"]);
		// Session scoping: another coordinator's generation cannot collide.
		expect(registry.isRequired("s2", 1)).toBeUndefined();
		registry.mark("s2", 1, ["c"]);
		expect(registry.isRequired("s2", 1)).toEqual(["c"]);
		expect(registry.isRequired("s1", 2)).toBeUndefined();
		expect(registry.isRequired("s1", undefined)).toBeUndefined();
		registry.mark("s1", 1, []);
		expect(registry.isRequired("s1", 1)).toEqual([]);
		registry.mark("s1", 1, ["x"]);
		registry.mark("s1", 2, ["y"]);
		expect(registry.isRequired("s1", 1)).toEqual(["x"]);
		expect(registry.isRequired("s1", 2)).toEqual(["y"]);
		for (let generation = 10; generation < 30; generation++) registry.mark("s1", generation, ["g"]);
		// Pruning keeps the map bounded; recent entries survive.
		expect(registry.isRequired("s1", 29)).toEqual(["g"]);
		expect(registry.isRequired("s1", 1)).toBeUndefined();
	});

	test("records complete structured statuses with canonical host titles", () => {
		const registry = new PriorRevalidationRegistry();
		registry.markFindings("s", 1, [{ findingId: "thread:9", threadId: 9, inReplyToId: null, path: "src/a.ts", line: 2, side: "RIGHT", severity: "P1", title: "Canonical title" }]);
		expect(registry.recordStatuses("s", 1, [{ findingId: "thread:9", status: "still open", severity: "P2 Dix", evidence: "unsafe downgrade" } as never])).toEqual({ ok: false, error: "prior finding status is malformed" });
		expect(registry.recordStatuses("s", 1, [{ findingId: "thread:9", status: "still open", severity: "P2", evidence: "unsafe downgrade" }])).toEqual({ ok: false, error: "prior finding thread:9 cannot be downgraded below P1" });
		expect(registry.recordStatuses("s", 1, [{ findingId: "thread:9", status: "rejected", severity: "P1", evidence: "The invariant is verified." }])).toEqual({
			ok: true,
			statuses: [{ findingId: "thread:9", status: "rejected", severity: "P1", title: "Canonical title", evidence: "The invariant is verified." }],
		});
		expect(registry.statuses("s", 1)?.[0]?.title).toBe("Canonical title");
		expect(registry.recordStatuses("s", 1, [])).toEqual({ ok: false, error: "prior finding statuses were already recorded for this invocation" });
		registry.markFindings("s", 2, []);
		expect(registry.recordStatuses("s", 2, [])).toEqual({ ok: true, statuses: [] });
	});
});

describe("prior review discovery", () => {
	test("finds the latest marker review and its inline findings at an ancestor head", async () => {
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([
				{ id: 11, user: { login: "someone-else" }, body: marker(HEAD_A), state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
				{ id: 22, user: { login: "Reviewer" }, body: `first\n${marker(HEAD_A)}`, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" },
				{ id: 33, user: { login: "reviewer" }, body: `latest\n${marker(HEAD_B)}`, state: "CHANGES_REQUESTED", submitted_at: "2026-01-03T00:00:00Z" },
				{ id: 34, user: { login: "reviewer" }, state: "PENDING", body: marker(HEAD_C) },
			]),
			commentsJson: JSON.stringify([
				{
					id: 101,
					pull_request_review_id: 33,
					path: "src/a.ts",
					line: 12,
					start_line: 10,
					side: "RIGHT",
					body: "**[P1] Guard against nil map before write**\n\nrationale",
				},
				{ id: 102, pull_request_review_id: 22, path: "src/old.ts", line: 5, side: "RIGHT", body: "**[P2] stale**" },
				{
					id: 103,
					pull_request_review_id: 33,
					in_reply_to_id: 101,
					path: "src/a.ts",
					line: 12,
					side: "RIGHT",
					body: "Fixed in the latest commit — please mark resolved.",
					user: { login: "author" },
					author_association: "OWNER",
					created_at: "2026-01-04T00:00:00Z",
					commit_id: HEAD_C,
				},
				{
					id: 105,
					pull_request_review_id: 11,
					path: "src/other.ts",
					line: 8,
					side: "RIGHT",
					body: "**[P2] Another reviewer concern**",
					user: { login: "someone-else" },
					created_at: "2026-01-04T01:00:00Z",
				},
				{ id: 104, pull_request_review_id: 33, path: "src/removed.ts", line: null, side: "RIGHT", body: "**[P3] no line**" },
			]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.relationship).toBe("incremental");
		expect(snapshot.currentHead).toBe(HEAD_C);
		expect(snapshot.prior?.head).toBe(HEAD_B);
		expect(snapshot.prior?.reviewId).toBe(33);
		expect(snapshot.incrementalRange).toEqual({ from: HEAD_B, to: HEAD_C, commitCount: 1 });
		expect(snapshot.prior?.findings).toEqual([
			{
				findingId: "thread:101",
				threadId: 101,
				inReplyToId: null,
				path: "src/a.ts",
				startLine: 10,
				line: 12,
				side: "RIGHT",
				severity: "P1",
				title: "Guard against nil map before write",
				excerpt: "rationale",
				replies: [{
					id: 103,
					kind: "reply",
					inReplyToId: 101,
					author: "author",
					authorAssociation: "OWNER",
					createdAt: "2026-01-04T00:00:00Z",
					commitId: HEAD_C,
					excerpt: "Fixed in the latest commit — please mark resolved.",
				}],
			},
		]);
		expect(snapshot.conversation?.trust).toBe("untrusted_review_discussion");
		expect(snapshot.conversation?.reviews.map((review) => review.id)).toEqual([11, 22]);
		expect(snapshot.conversation?.rootComments).toEqual([{
			id: 102,
			kind: "root_comment",
			reviewId: 22,
			excerpt: "**[P2] stale**",
		}, {
			id: 105,
			kind: "root_comment",
			reviewId: 11,
			author: "someone-else",
			createdAt: "2026-01-04T01:00:00Z",
			excerpt: "**[P2] Another reviewer concern**",
		}]);
		expect(snapshot.conversation?.message).toContain("untrusted claims");
		expect(snapshot.message).toContain("review new commits");
		expect(snapshot.message).toContain("full-PR gap hunt");
		expect(snapshot.truncated).toBeFalse();
	});

	test("bounds replies per finding and marks conversation truncation without discarding prior state", async () => {
		const replies = Array.from({ length: 21 }, (_value, index) => ({
			id: 200 + index,
			pull_request_review_id: 22,
			in_reply_to_id: 101,
			body: `reply ${index}`,
			user: { login: "author" },
		}));
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([{ id: 22, user: { login: "reviewer" }, body: marker(HEAD_C), state: "COMMENTED" }]),
			commentsJson: JSON.stringify([{
				id: 101,
				pull_request_review_id: 22,
				path: "src/a.ts",
				line: 12,
				side: "RIGHT",
				body: "**[P1] Guard ownership**",
			}, ...replies]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.relationship).toBe("same_head");
		expect(snapshot.prior?.findings[0]?.replies).toHaveLength(20);
		expect(snapshot.prior?.findings[0]?.repliesTruncated).toBeTrue();
		expect(snapshot.conversation?.truncated).toBeTrue();
		expect(snapshot.truncated).toBeFalse();
	});

	test("reports same_head when the marker matches the current head", async () => {
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([{ id: 22, user: { login: "reviewer" }, body: marker(HEAD_C), state: "COMMENTED" }]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.relationship).toBe("same_head");
		expect(snapshot.prior?.head).toBe(HEAD_C);
		expect(snapshot.incrementalRange).toBeUndefined();
		expect(snapshot.message).toContain("revalidate");
	});

	test("reports diverged when the prior head left the commit history", async () => {
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([{ id: 22, user: { login: "reviewer" }, body: marker(HEAD_B), state: "COMMENTED" }]),
			commitsJson: JSON.stringify([{ sha: HEAD_A }, { sha: HEAD_C }]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.relationship).toBe("diverged");
		expect(snapshot.message).toContain("force-push");
	});

	test("reports none when no marker-bearing review by this identity exists", async () => {
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([
				{ id: 22, user: { login: "reviewer" }, body: "manual review without marker", state: "COMMENTED" },
				{ id: 23, user: { login: "other" }, body: marker(HEAD_A), state: "COMMENTED" },
			]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.relationship).toBe("none");
		expect(snapshot.prior).toBeUndefined();
		expect(snapshot.message).toContain("full review");
	});

	test("resolves the identity through the unquoted ghText login path", async () => {
		const fixture = installFakeGh({
			reviewsJson: JSON.stringify([{ id: 22, user: { login: "reviewer" }, body: marker(HEAD_C), state: "COMMENTED" }]),
		});
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { repository: fixture.repository });
		expect(snapshot.identity).toBe("reviewer");
		expect(snapshot.relationship).toBe("same_head");
	});

	test("fails open to a full review when discovery is truncated by pagination bounds", async () => {
		const many = Array.from({ length: 100 }, (_value, index) => ({
			id: 1000 + index,
			user: { login: "reviewer" },
			body: marker(index === 99 ? HEAD_B : HEAD_A),
			state: "COMMENTED",
		}));
		const fixture = installFakeGh({ reviewsJson: JSON.stringify(many) });
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.truncated).toBeTrue();
		expect(snapshot.relationship).toBe("none");
		expect(snapshot.incrementalRange).toBeUndefined();
		expect(snapshot.prior?.head).toBe(HEAD_B);
		expect(snapshot.message).toContain("Run a full review");
	});

	test("preserves the truncation diagnostic when no marker review was found at the cap", async () => {
		const many = Array.from({ length: 100 }, (_value, index) => ({
			id: 2000 + index,
			user: { login: "reviewer" },
			body: "manual review without marker",
			state: "COMMENTED",
		}));
		const fixture = installFakeGh({ reviewsJson: JSON.stringify(many) });
		const snapshot = await discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" });
		expect(snapshot.truncated).toBeTrue();
		expect(snapshot.relationship).toBe("none");
		expect(snapshot.prior).toBeUndefined();
		expect(snapshot.message).toContain("truncated by pagination bounds");
	});

	test("fails closed on malformed PR metadata", async () => {
		const fixture = installFakeGh({ pullJson: JSON.stringify({ state: "open" }) });
		await expect(discoverPriorReview(fixture.cwd, 7, { ...fixture, identity: "reviewer" })).rejects.toThrow("valid head SHA");
	});
});
