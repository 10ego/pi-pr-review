import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const prompt = readFileSync(new URL("../prompts/pr-review.md", import.meta.url), "utf8");
const extension = readFileSync(new URL("../extensions/pr-review-subagent.ts", import.meta.url), "utf8");

describe("PR review prompt scheduling policy", () => {
	test("preserves all four review passes and bounded batch fan-out", () => {
		expect(prompt).toContain("| `overview` | `light` | `none` |");
		expect(prompt).toContain("| `conventions-maintainability` | `medium` | `configured` |");
		expect(prompt).toContain("| `correctness` | `heavy` | `configured` |");
		expect(prompt).toContain("| `security-performance` | `heavy` | `configured` |");
		expect(prompt).toContain("max_parallel: 4");
	});

	test("discovers user-level names after context gathering and skips when none apply", () => {
		const decision = prompt.indexOf("After metadata/diff capture and convention gathering are complete");
		const dispatch = prompt.indexOf("If Step 2 selected a discovered baseline name");
		expect(decision).toBeGreaterThan(-1);
		expect(dispatch).toBeGreaterThan(decision);
		expect(prompt).toContain('`pr_review_verify` with exactly `{ "action": "list" }`');
		expect(prompt).toContain("project-local definitions are ignored");
		expect(prompt).toContain("missing config disables verification");
		expect(prompt).toContain("Select **at most one** applicable name");
	});

	test("dispatches named verification with the review batch and no model overrides", () => {
		expect(prompt).toContain('one `pr_review_verify` `action: "run"` call in the **same assistant turn**');
		expect(prompt).toContain("`baseline_name`: the exact applicable name returned by `action: \"list\"`");
		expect(prompt).toContain("Never send legacy `command` or `timeout_ms` fields");
		expect(prompt).toContain("never replace an unavailable `pr_review_verify` with a prompt-owned `bash` worktree lifecycle");
	});

	test("exposes strict list/run schemas and rejects legacy run overrides", () => {
		const start = extension.indexOf("const PrReviewVerifyParams");
		const end = extension.indexOf("const ReviewSubagentParams");
		const schema = extension.slice(start, end);
		expect(schema).toContain('Type.Literal("list"');
		expect(schema).toContain('Type.Literal("run")');
		expect(schema).toContain("baseline_name: Type.String");
		expect(schema.match(/additionalProperties: false/g)).toHaveLength(2);
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

	test("does not delay review without a profile and validates candidates afterward", () => {
		expect(prompt).toContain("If no profile is configured/applicable");
		expect(prompt).toContain("let the four-pass batch proceed immediately");
		expect(prompt).toContain("Only after the batch results (and any concurrently scheduled baseline result) are available");
		expect(prompt).toContain("Perform targeted candidate validation now");
		expect(prompt).toContain("Baseline verification never replaces this post-batch validation");
	});
});
