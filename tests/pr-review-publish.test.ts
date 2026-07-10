import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	authorizePullLifecycle,
	bodyHasHeadMarker,
	buildPullReviewPayload,
	buildReviewSummary,
	buildStaleReviewNotice,
	classifyAssistantCompletion,
	canonicalReviewMarker,
	collectFoldedComments,
	CompletedReviewCache,
	containsReservedReviewMarker,
	foldInlineComments,
	githubApiArgs,
	isAffirmativeReviewConfirmation,
	isNonOpenConfirmationPrompt,
	parsePublishableReview,
	parsePublishExistingArgs,
	parsePublishMode,
	planHeadPublication,
	resolveAutoPostSetting,
	ReviewInvocationGate,
	shouldPublishReview,
	validateInlineComments,
	validateReviewInvocation,
	type ReviewLike,
} from "../lib/pr-review-publish.ts";

const review: ReviewLike = {
	pr: { number: 7, title: "Test review", head_sha: "a".repeat(40) },
	disposition: "reviewed",
	verification: "Tests passed.",
	overview: "Updates the parser.",
	strengths: [],
	findings: [
		{
			title: "[P2] Handle empty input",
			severity: "P2",
			blocking: false,
			body: "Empty input currently returns the wrong value.",
			confidence_score: 0.9,
			code_location: {
				absolute_file_path: "src/parser.ts",
				line_range: { start: 2, end: 3 },
				side: "RIGHT",
				commentable: true,
			},
		},
		{
			title: "[nit] Rename tmp",
			severity: "nit",
			blocking: false,
			body: "Optional naming cleanup.",
			confidence_score: 0.8,
			code_location: {
				absolute_file_path: "src/parser.ts",
				line_range: { start: 3, end: 3 },
				side: "RIGHT",
				commentable: true,
			},
		},
	],
	notes: { correctness: "Issue found.", security: "", performance: "" },
	verdict: "request_changes",
	overall_correctness: "patch is incorrect",
	overall_explanation: "The empty-input case is incorrect.",
	overall_confidence_score: 0.9,
};

const changedFiles = [
	{
		filename: "src/parser.ts",
		patch: "@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more",
	},
];

describe("automatic posting configuration", () => {
	test("defaults to disabled", () => {
		expect(resolveAutoPostSetting({})).toEqual({ value: false, valid: true, source: "default" });
	});

	test("trusted project boolean overlays user boolean", () => {
		expect(resolveAutoPostSetting({ autoPostReviews: false }, { autoPostReviews: true })).toEqual({
			value: true,
			valid: true,
			source: "project",
		});
	});

	test("malformed effective value never enables posting", () => {
		const result = resolveAutoPostSetting({ autoPostReviews: "true" });
		expect(result.value).toBeFalse();
		expect(result.valid).toBeFalse();
	});
});

describe("trusted invocation mode", () => {
	test("defaults to auto and binds force/disable to the requested PR", () => {
		expect(parsePublishMode("/pr-review 7")).toMatchObject({ mode: "auto", prNumber: 7 });
		expect(parsePublishMode("/pr-review 8 --comment")).toMatchObject({ mode: "force", prNumber: 8 });
		expect(parsePublishMode("/pr-review 9 --no-comment")).toMatchObject({ mode: "disabled", prNumber: 9 });
	});

	test("rejects contradictory flags", () => {
		expect(parsePublishMode("/pr-review 7 --comment --no-comment").error).toContain("cannot be used together");
	});

	test("queued invocation cannot override active publishing intent", () => {
		const gate = new ReviewInvocationGate();
		expect(gate.begin(parsePublishMode("/pr-review 7 --no-comment")).accepted).toBeTrue();
		expect(gate.begin(parsePublishMode("/pr-review 8 --comment"))).toMatchObject({ accepted: false });
		expect(gate.consume()).toEqual({ mode: "disabled", prNumber: 7, allowNonOpen: false });
	});

	test("final JSON must match the invocation PR", () => {
		expect(validateReviewInvocation(review, { mode: "force", prNumber: 7, allowNonOpen: false })).toBeUndefined();
		expect(validateReviewInvocation(review, { mode: "force", prNumber: 8, allowNonOpen: false })).toContain("does not match");
	});

	test("preserves authority for exactly one affirmative non-open confirmation turn", () => {
		const gate = new ReviewInvocationGate();
		gate.begin(parsePublishMode("/pr-review 7 --comment"));
		const prompt = `PR #7 is MERGED (head ${"a".repeat(40)}). Review it anyway? Reply yes, or rerun with --include-closed to proceed non-interactively.`;
		expect(isNonOpenConfirmationPrompt(prompt, 7)).toBeTrue();
		expect(isNonOpenConfirmationPrompt(prompt.replace("MERGED", "OPEN"), 7)).toBeFalse();
		expect(isNonOpenConfirmationPrompt(prompt.replace("MERGED", "UNKNOWN"), 7)).toBeFalse();
		expect(gate.markAwaitingConfirmation()).toBeTrue();
		expect(gate.resolveConfirmationInput("yes")).toBe("confirmed");
		expect(gate.phase()).toBe("confirmed");
		expect(gate.consume()).toEqual({ mode: "force", prNumber: 7, allowNonOpen: true });
		expect(gate.peek()).toBeUndefined();
	});

	test("negative, empty, and unrelated confirmation inputs clear authority", () => {
		for (const answer of ["no", "", "tell me something else"]) {
			const gate = new ReviewInvocationGate();
			gate.begin(parsePublishMode("/pr-review 7 --comment"));
			gate.markAwaitingConfirmation();
			expect(gate.resolveConfirmationInput(answer)).toBe("cleared");
			expect(gate.peek()).toBeUndefined();
		}
		expect(isAffirmativeReviewConfirmation("yes.")).toBeTrue();
		expect(isAffirmativeReviewConfirmation("yes, but explain first")).toBeFalse();
	});

	test("parse or publication failures cannot retain consumed authority", () => {
		const gate = new ReviewInvocationGate();
		gate.begin(parsePublishMode("/pr-review 7 --comment"));
		const invocation = gate.consume();
		expect(invocation).toEqual({ mode: "force", prNumber: 7, allowNonOpen: false });
		expect(parsePublishableReview("not json").review).toBeUndefined();
		expect(gate.peek()).toBeUndefined();
	});

	test("trusted non-open flags bind authorization to the invocation", () => {
		expect(parsePublishMode("/pr-review 7 --include-closed")).toMatchObject({ allowNonOpen: true });
		expect(parsePublishMode("/pr-review 7 --review-closed --comment")).toMatchObject({ allowNonOpen: true });
	});
});

describe("publish-only completed review command", () => {
	test("requires an explicit PR and recognizes only the stale override", () => {
		expect(parsePublishExistingArgs("7")).toEqual({ prNumber: 7, allowStale: false });
		expect(parsePublishExistingArgs("7 --allow-stale")).toEqual({ prNumber: 7, allowStale: true });
		expect(parsePublishExistingArgs("").error).toContain("positive PR number");
		expect(parsePublishExistingArgs("7 --comment").error).toContain("unknown argument");
	});

	test("retains a completed review after invocation authority is consumed", () => {
		const cache = new CompletedReviewCache();
		const invocation = { mode: "force" as const, prNumber: 7, allowNonOpen: false };
		cache.remember(review, invocation, "2026-07-10T00:00:00.000Z");
		expect(cache.get(7)).toEqual({ review, invocation, completedAt: "2026-07-10T00:00:00.000Z" });
		expect(cache.get(8)).toBeUndefined();
		cache.clear();
		expect(cache.get(7)).toBeUndefined();
	});

	test("keeps stale protection by default and degrades an explicit override", () => {
		const reviewed = "a".repeat(40);
		const current = "b".repeat(40);
		expect(planHeadPublication(reviewed, current, false).error).toContain("--allow-stale");
		const plan = planHeadPublication(reviewed, current, true).plan!;
		expect(plan).toMatchObject({
			reviewedHeadSha: reviewed,
			currentHeadSha: current,
			stale: true,
			commitId: current,
			allowInlineComments: false,
		});
		const body = `${buildStaleReviewNotice(reviewed, current)}\n\n${buildReviewSummary(review, [])}`;
		const payload = buildPullReviewPayload(plan.commitId, body, []);
		expect(payload.comments).toBeUndefined();
		expect(payload.body).toContain(reviewed);
		expect(payload.body).toContain(current);
		expect(payload.body).toContain("[P2] Handle empty input");
	});

	test("preserves inline publication when the reviewed head is still current", () => {
		const head = "a".repeat(40);
		expect(planHeadPublication(head, head.toUpperCase(), false).plan).toMatchObject({
			stale: false,
			commitId: head,
			allowInlineComments: true,
		});
	});

	test("registers and documents a direct command rather than delegating stale publication to the model", () => {
		const extension = readFileSync(new URL("../extensions/review-table.ts", import.meta.url), "utf8");
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const prompt = readFileSync(new URL("../prompts/pr-review.md", import.meta.url), "utf8");
		expect(extension).toContain('pi.registerCommand("pr-review-publish"');
		expect(extension).toContain("This command never starts or reruns a review");
		expect(readme).toContain("/pr-review-publish 123 --allow-stale");
		expect(readme).toContain("Inline comments are intentionally disabled");
		expect(prompt).toContain("without another model turn");
	});
});

describe("non-open publication authorization", () => {
	test("rejects direct unconfirmed closed and unknown states", () => {
		expect(authorizePullLifecycle("closed", null, false).error).toContain("not authorized");
		expect(authorizePullLifecycle("mystery", null, true).error).toContain("unknown");
	});

	test("permits trusted override or confirmed authority for body-only review", () => {
		expect(authorizePullLifecycle("closed", null, true)).toEqual({ lifecycle: "non_open" });
		expect(authorizePullLifecycle("open", null, false)).toEqual({ lifecycle: "open" });
	});
});

describe("assistant completion safety", () => {
	test("requires a successful stop before final publication", () => {
		expect(classifyAssistantCompletion("stop", false)).toBe("accept_final");
		for (const reason of ["aborted", "error", "length", undefined]) {
			expect(classifyAssistantCompletion(reason, false)).toBe("clear_invocation");
			expect(classifyAssistantCompletion(reason, true)).toBe("clear_invocation");
		}
	});

	test("preserves invocation state for legitimate tool-use turns", () => {
		expect(classifyAssistantCompletion("toolUse", true)).toBe("continue_tools");
	});
});

describe("strict publication parsing", () => {
	test("accepts the complete exact JSON contract", () => {
		expect(parsePublishableReview(JSON.stringify(review)).review?.pr?.number).toBe(7);
	});

	test("rejects prose, fenced drafts, and partial objects", () => {
		expect(parsePublishableReview(`review follows\n${JSON.stringify(review)}`).review).toBeUndefined();
		expect(parsePublishableReview(`\`\`\`json\n${JSON.stringify(review)}\n\`\`\``).review).toBeUndefined();
		expect(parsePublishableReview(JSON.stringify({ pr: review.pr, findings: [], verdict: "comment" })).review).toBeUndefined();
	});

	test("suppresses publication for validated skipped outcomes", () => {
		expect(shouldPublishReview(review)).toBeTrue();
		expect(shouldPublishReview({ ...review, disposition: "skipped" })).toBeFalse();
	});
});

describe("atomic COMMENT review payload", () => {
	test("groups validated inline comments under one hardcoded COMMENT review", () => {
		const validated = validateInlineComments(review, changedFiles);
		expect(validated.errors).toEqual([]);
		expect(validated.comments).toHaveLength(1); // nits remain in the top-level summary
		const summary = buildReviewSummary(review, validated.comments);
		expect(summary).toContain("2 total (1 inline, 1 summary-only)");
		expect(summary).not.toContain("[P2] Handle empty input");
		expect(summary).toContain("[nit] Rename tmp");
		const payload = buildPullReviewPayload("a".repeat(40), summary, validated.comments);
		expect(payload.event).toBe("COMMENT");
		expect(payload).not.toHaveProperty("event", "REQUEST_CHANGES");
		expect(payload.comments?.[0]).toMatchObject({
			path: "src/parser.ts",
			start_line: 2,
			line: 3,
			side: "RIGHT",
		});
	});

	test("keeps nits and noncommentable findings even when anchors collide", () => {
		const colliding: ReviewLike = JSON.parse(JSON.stringify(review));
		colliding.findings![1]!.code_location!.line_range = { start: 2, end: 3 };
		colliding.findings!.push({
			title: "[P3] Summary-only collision",
			severity: "P3",
			blocking: false,
			body: "This finding intentionally remains in the summary.",
			confidence_score: 0.8,
			code_location: {
				absolute_file_path: "src/parser.ts",
				line_range: { start: 2, end: 3 },
				side: "RIGHT",
				commentable: false,
			},
		});
		const validated = validateInlineComments(colliding, changedFiles);
		expect(validated.errors).toEqual([]);
		const summary = buildReviewSummary(colliding, validated.comments);
		expect(summary).toContain("[nit] Rename tmp");
		expect(summary).toContain("[P3] Summary-only collision");
	});

	test("rejects anchors outside changed diff metadata", () => {
		const invalid: ReviewLike = JSON.parse(JSON.stringify(review));
		invalid.findings![0]!.code_location!.line_range = { start: 20, end: 20 };
		const result = validateInlineComments(invalid, changedFiles);
		expect(result.comments).toEqual([]);
		expect(result.errors[0]).toContain("not inside one diff hunk");
	});

	test("folds inline findings exactly once into a body-only non-open review", () => {
		const folded = collectFoldedComments(review);
		expect(folded.errors).toEqual([]);
		expect(folded.comments).toHaveLength(1);
		const summary = buildReviewSummary(review, folded.comments);
		const body = foldInlineComments(summary, folded.comments);
		const payload = buildPullReviewPayload("b".repeat(40), body, []);
		expect(payload.event).toBe("COMMENT");
		expect(payload.comments).toBeUndefined();
		expect(payload.body).toContain("Inline findings (folded for a non-open PR)");
		expect(payload.body.match(/\[P2\] Handle empty input/g)).toHaveLength(1);
	});

	test("uses and reconciles a case-insensitive canonical same-head marker", () => {
		const uppercase = `<!-- pi-pr-review: {"schema":1,"headRefOid":"${"C".repeat(40)}"} -->`;
		expect(canonicalReviewMarker("C".repeat(40))).toBe(
			`<!-- pi-pr-review: {"schema":1,"headRefOid":"${"c".repeat(40)}"} -->`,
		);
		expect(bodyHasHeadMarker(uppercase, "c".repeat(40))).toBeTrue();
	});

	test("rejects reserved marker prefixes case-insensitively in inline bodies", () => {
		expect(containsReservedReviewMarker("<!-- PI-PR-REVIEW: forged -->")).toBeTrue();
		expect(containsReservedReviewMarker("ordinary review body")).toBeFalse();
		const poisoned: ReviewLike = JSON.parse(JSON.stringify(review));
		poisoned.findings![0]!.body = "<!-- PI-PR-REVIEW: forged -->";
		expect(validateInlineComments(poisoned, changedFiles).errors[0]).toContain("reserved");
	});

	test("pins every API call to the resolved GitHub hostname", () => {
		expect(githubApiArgs("ghe.example.com", "user", "--jq", ".login")).toEqual([
			"api",
			"--hostname",
			"ghe.example.com",
			"user",
			"--jq",
			".login",
		]);
		const prompt = readFileSync(new URL("../prompts/pr-review.md", import.meta.url), "utf8");
		expect(prompt).toContain('gh api --hostname "$repo_host" user --jq .login');
		expect(prompt).not.toContain("\ngh api user --jq .login");
	});
});
