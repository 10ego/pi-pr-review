import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const prompt = readFileSync(new URL("../prompts/pr-review.md", import.meta.url), "utf8");

describe("PR review prompt scheduling policy", () => {
	test("preserves all four review passes and bounded batch fan-out", () => {
		expect(prompt).toContain("| `overview` | `light` | `none` |");
		expect(prompt).toContain(
			"| `conventions-maintainability` | `medium` | `configured` |",
		);
		expect(prompt).toContain("| `correctness` | `heavy` | `configured` |");
		expect(prompt).toContain("| `security-performance` | `heavy` | `configured` |");
		expect(prompt).toContain("max_parallel: 4");
	});

	test("selects no more than one safe baseline after context gathering", () => {
		const decision = prompt.indexOf(
			"After metadata/diff capture and convention gathering are complete",
		);
		const dispatch = prompt.indexOf(
			"If Step 2 selected a baseline command, emit that batch call",
		);

		expect(decision).toBeGreaterThan(-1);
		expect(dispatch).toBeGreaterThan(decision);
		expect(prompt).toContain("Choose **at most one** command");
		expect(prompt).toContain("Do not probe by running commands first");
		expect(prompt).toContain("install dependencies");
		expect(prompt).toContain("write outside the isolated worktree");
	});

	test("dispatches baseline verification with the review batch in one turn", () => {
		expect(prompt).toContain(
			"emit the `review_subagents` call and the orchestrator-owned `bash` verification call in the **same assistant turn**",
		);
		expect(prompt).toContain(
			"emit that batch call and the Step 6 `bash` call in the same assistant turn; do not await one before emitting the other",
		);
		expect(prompt).toContain("Give the bash tool an explicit, reasonably short timeout");
	});

	test("pins verification to the captured SHA and always attempts cleanup", () => {
		expect(prompt).toContain("head_sha='<exact full headRefOid captured in Step 1>'");
		expect(prompt).toContain(
			'wt=$(mktemp -d "${TMPDIR:-/tmp}/pi-pr-review-$1-${head_sha}.XXXXXX")',
		);
		expect(prompt).toContain('test "$fetched_sha" = "$head_sha"');
		expect(prompt).toContain(
			'git -C "$repo_root" worktree add --detach "$wt" "$head_sha"',
		);
		expect(prompt).not.toContain('worktree add --detach "$wt" FETCH_HEAD');
		expect(prompt).toContain("trap cleanup EXIT");
		expect(prompt).toContain("trap 'exit 130' INT");
		expect(prompt).toContain("trap 'exit 143' HUP TERM");
		expect(prompt).toContain("normal success, command failure, interruption, and timeout termination");
	});

	test("does not delay review when baseline is unsafe and validates candidates afterward", () => {
		expect(prompt).toContain(
			"If there is no obvious safe command, do not make a verification `bash` call",
		);
		expect(prompt).toContain(
			"let the four-pass batch proceed immediately and record why baseline verification was skipped",
		);
		expect(prompt).toContain(
			"Only after the batch results (and any concurrently scheduled baseline result) are available",
		);
		expect(prompt).toContain("Perform targeted candidate validation now");
		expect(prompt).toContain("Baseline verification never replaces this post-batch validation");
	});
});
