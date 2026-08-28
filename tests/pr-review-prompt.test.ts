import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const prompt = readFileSync(new URL("../prompts/pr-review.md", import.meta.url), "utf8");
const extension = readFileSync(new URL("../extensions/pr-review-subagent.ts", import.meta.url), "utf8");
const focusExtension = readFileSync(new URL("../extensions/pr-review-focus.ts", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("PR review prompt scheduling policy", () => {
	test("registers review tools and publication behind one shared loop coordinator", () => {
		expect(packageJson.pi.extensions).toEqual(["./extensions/index.ts"]);
		expect(packageJson.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.80.5");
		expect(entrypoint).toContain("const loopCoordinator = new ReviewLoopCoordinator(pi)");
		expect(entrypoint).toContain("const selfReviewCoordinator = new SelfReviewPermitCoordinator");
		expect(entrypoint).toContain("registerPrReviewSubagents(pi, loopCoordinator, selfReviewCoordinator)");
		expect(entrypoint).toContain("registerReviewFocus(pi, loopCoordinator)");
		expect(entrypoint).toContain("registerReviewTable(pi, loopCoordinator, selfReviewCoordinator)");
		expect(focusExtension).toContain('pi.registerCommand("pr-review-focus"');
		expect(focusExtension).toContain('pi.registerShortcut(SHORTCUT');
		expect(focusExtension).not.toContain('"(waiting for assistant output…) "');
		expect(entrypoint).not.toContain("CachedPublishAuthorizationGate");
		expect(extension).toContain("allow_stale_publish");
		expect(extension).toContain("allowStalePublish: allowStale.valid ? allowStale.value : false");
	});

	test("documents the read-only live focus viewer", () => {
		expect(readme).toContain("/pr-review-focus");
		expect(readme).toContain("Ctrl+Alt+R");
		expect(readme).toContain("Return to the main thread without cancelling the review");
		expect(readme).toContain("never stores the pass objective, input context, captured diff");
		expect(readme).toContain("cannot send prompts, steering, or follow-ups");
	});

	test("uses host-fixed balanced coverage by default", () => {
		expect(prompt).toContain("**Balanced (default or `--balanced`):** exactly five concurrent reviewers");
		expect(prompt).toContain("`overview`, `correctness`, `correctness-contracts`, `security-performance`, and `performance-resources`");
		expect(extension).toContain("FIXED_REVIEW_TOPOLOGIES");
		expect(extension).toContain('reviewMode = loopCoordinator.peek()?.reviewMode ?? "balanced"');
		expect(extension).toContain("const reviewerConcurrency = passes.length");
		expect(extension).not.toContain("max_parallel: Type.Optional");
		expect(extension).not.toContain("shard_count: Type.Optional");
	});

	test("preserves the comprehensive six-reviewer full mode", () => {
		expect(prompt).toContain("**Full (`--full`):** exactly six concurrent reviewers");
		expect(prompt).toContain("the balanced five plus `conventions-maintainability`");
		expect(prompt).toContain("mode-0600 temporary file is the exact base↔head `context_file`");
		expect(prompt).toContain('gh pr diff $1 > "$diff_file" || { status=$?; rm -f -- "$diff_file"');
		expect(prompt).toContain("remove it before every early return, skipped review, confirmation pause");
		expect(prompt).toContain("Do not dump or embed the complete diff into the parent conversation");
		expect(extension.match(/context_file: Type.Optional/g)).toHaveLength(2);
		expect(extension).toContain("loadReviewContext(ctx.cwd, params.context, params.context_file)");
		expect(extension).toContain('stdio: ["pipe", "pipe", "pipe"]');
		expect(extension).toContain('proc.stdin.end(input, "utf8")');
		expect(prompt).toContain("Inspect the complete diff so cross-file flows remain visible");
		expect(prompt).toContain("Inspect the complete diff so cross-file contracts remain visible");
	});

	test("defines a host-fixed deep single-reviewer mode", () => {
		expect(prompt).toContain("**Deep (`--deep`):** exactly one integrated heavy reviewer, `deep-review`");
		expect(prompt).toContain("the first nonblank line is `Review status: COMPLETE`");
		expect(prompt).toContain("In deep mode dispatch only `deep-review`");
		expect(prompt).toContain("`--deep` selects one integrated heavy reviewer");
		expect(extension).toContain('{ id: "deep-review", tier: "heavy", toolPolicy: "configured", expectedOutput: "nonempty" }');
	});

	test("offers quick mode and retains major-only as its compatibility alias", () => {
		expect(prompt).toContain('argument-hint: "<PR-NUM> [--comment|--no-comment] [--quick|--balanced|--full|--deep]"');
		expect(prompt).toContain("**Quick (`--quick`, with `--major-only` retained as a compatibility alias):** exactly three concurrent heavy reviewers");
		expect(prompt).toContain("`correctness`, `correctness-contracts`, and `security-performance`");
		expect(prompt).toContain("security/performance reviewer also owns performance, resource, cleanup, and scalability risks");
		expect(prompt).toContain("discard P3/nit candidates before parent validation and finalization");
		expect(extension).toContain('const majorOnly = reviewMode === "quick" || reviewMode === "balanced"');
		expect(extension).toContain("pass.majorOnly === true");
		expect(extension).toContain("report only substantiated P0, P1, or P2 defects");
	});

	test("keeps bounded minor coverage in balanced mode", () => {
		expect(prompt).toContain("at most three direct-diff P3/nit candidates");
		expect(prompt).toContain("validate every retained candidate independently");
		expect(extension).toContain('const minorHygiene = reviewMode === "balanced"');
		expect(extension).toContain('minorHygiene && fixed.id === "overview"');
		expect(extension).toContain("This is a bounded minor-hygiene scan");
	});

	test("uses file-backed complete diffs without multiplying reviewers", () => {
		expect(prompt).toContain("At 200,000 bytes and above");
		expect(prompt).toContain("it never creates shard reviewers");
		expect(extension).toContain("MAX_EMBEDDED_REVIEW_CONTEXT_BYTES = 200_000");
		expect(extension).toContain("complete file-backed diff manifest");
		expect(extension).toContain('toolNames: ["read", "grep", "find", "ls"]');
		expect(extension).toContain("fileBackedPassCount");
		expect(extension).not.toContain("shardUnifiedDiff");
		expect(extension).not.toContain("automaticShardCount");
		expect(extension).not.toContain("MAX_BATCH_PARALLEL");
		expect(extension).toContain("dispatchResults.sort((a, b) => a.originalIndex - b.originalIndex)");
		expect(extension).toContain("firstAssistantMs");
		expect(extension).toContain("toolElapsedMs");
		expect(prompt).toContain("Never redispatch a complete lane, launch a generic whole-review follow-up");
	});
	test("balances correctness work without dropping error or resource coverage", () => {
		expect(prompt).toContain("API/data/error-contract violations");
		expect(prompt).toContain("error propagation/handling defects");
		expect(prompt).toContain("resource ownership/cleanup leaks");
		expect(prompt).toContain("Treat definite resource leaks as correctness findings");
	});

	test("discovers user-level names concurrently with independent initial context", () => {
		const decision = prompt.indexOf("Use the result of the single `pr_review_verify` call emitted concurrently");
		const dispatch = prompt.indexOf("If Step 2 selected a discovered baseline name");
		expect(decision).toBeGreaterThan(-1);
		expect(dispatch).toBeGreaterThan(decision);
		expect(prompt).toContain('`pr_review_verify` `{ "action": "list" }` discovery calls together');
		expect(prompt).toContain("Applicability discovery depends only on the current repository");
		expect(prompt).toContain("repository-wide convention-path listing (paths only)");
		expect(prompt).toContain("project-local definitions are ignored");
		expect(prompt).toContain("missing config disables verification");
		expect(prompt).toContain("Select **at most one** applicable name");
	});

	test("dispatches named verification with the review batch and no model overrides", () => {
		expect(prompt).toContain('emit the batch and `pr_review_verify` `action: "run"` in the same assistant turn');
		expect(prompt).toContain("`baseline_name`: the exact applicable name returned by `action: \"list\"`");
		expect(prompt).toContain("Never send legacy `command` or `timeout_ms` fields");
		expect(prompt).toContain("Never replace an unavailable `pr_review_verify` with a prompt-owned `bash` worktree lifecycle");
	});

	test("exposes a flat strict list/run schema and rejects legacy run overrides", () => {
		const start = extension.indexOf("const PrReviewVerifyParams");
		const end = extension.indexOf("const ReviewSubagentParams");
		const schema = extension.slice(start, end);
		expect(schema).toContain("const PrReviewVerifyParams = Type.Object");
		expect(schema).toContain('StringEnum(["list", "run"]');
		expect(schema).toContain("baseline_name: Type.Optional");
		expect(schema.match(/additionalProperties: false/g)).toHaveLength(1);
		expect(schema).not.toContain("Type.Union");
		expect(schema).not.toContain("command: Type.String");
		expect(schema).not.toContain("timeout_ms:");
	});

	test("documents strict applicability, containment, output, cleanup, and unsandboxed risk", () => {
		expect(prompt).toContain("matching repository host/owner/repo");
		expect(prompt).toContain("canonical absolute executable and fixed argv");
		expect(prompt).toContain("fails closed on Windows");
		expect(prompt).toContain("`--no-write-fetch-head`");
		expect(prompt).toContain("minimal secret-scrubbed environment and temporary HOME/cache");
		expect(prompt).toContain("canonical `git` and `gh` executables from the trusted extension-startup PATH");
		expect(prompt).toContain("rejects a fork unless the trusted profile has `allowForks: true`");
		expect(prompt).toContain("freshly initialized extension-owned bare staging repository");
		expect(prompt).toContain("without system/global/local Git config or installed hooks");
		expect(prompt).toContain("temporary askpass helper/environment");
		expect(prompt).toContain("imports that already-fetched ref into the original repository over a local path");
		expect(prompt).toContain("`FETCH_HEAD` is preserved");
		expect(prompt).toContain("all captured fetch stdout and stderr is zeroed and suppressed");
		expect(prompt).toContain("every observed byte is accounted as dropped");
		expect(prompt).toContain("generic trusted context rather than raw fetch diagnostics");
		expect(prompt).toContain("unauthenticated public fetch remains permitted with bounded diagnostics");
		expect(prompt).toContain("fixed 2-second emergency cleanup allowance");
		expect(prompt).toContain("unconditionally available to bounded cleanup");
		expect(prompt).toContain("Verification is disabled by default");
		expect(prompt).toContain("acknowledgeUnsandboxedPrCodeRisk=true");
		expect(prompt).toContain("without a filesystem or network sandbox");
		expect(prompt).toContain("only the original POSIX process group");
		expect(prompt).toContain("deliberately call `setsid`");
		expect(prompt).toContain("external sandbox or container wrapper for untrusted pull requests");
		expect(prompt).toContain("unconditional KILL after grace");
		expect(prompt).toContain("shared raw-output accounting");
		expect(prompt).toContain("`primaryOutcome`, `terminationOutcome`, and `cleanupOutcome`");
	});

	test("does not delay review and batches independent candidate validation", () => {
		expect(prompt).toContain("If no profile is configured/applicable");
		expect(prompt).toContain("let the selected fixed reviewer batch proceed immediately");
		expect(prompt).toContain("Only after the batch results (and any concurrently scheduled baseline result) are available");
		expect(prompt).toContain("make an internal confirm/reject/evidence-needed decision");
		expect(prompt).toContain("navigational evidence index");
		expect(prompt).toContain("never as a trusted conclusion");
		expect(prompt).toContain("do **not** launch a tool call merely to rediscover");
		expect(prompt).toContain("one parallel tool-call turn");
		expect(prompt).toContain("Use at most one additional validation turn");
		expect(prompt).toContain("not permission to skip evidence");
		expect(prompt).toContain("independent source-grounded confirmation");
		expect(prompt).toContain("resolve every candidate as confirmed or rejected");
		expect(prompt).toContain("baseline verification never replaces this post-batch validation");
	});

	test("batches specialist evidence gathering without weakening substantiation", () => {
		expect(extension).toContain("Use repository tools only to substantiate a concrete candidate caused by that diff");
		expect(extension).toContain("Issue independent reads/searches/checks together");
		expect(extension).toContain("Use at most one follow-up tool turn");
		expect(extension).toContain("never permits skipping evidence needed to substantiate a finding");
	});
});
