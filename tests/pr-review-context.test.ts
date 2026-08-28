import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadReviewContext, MAX_REVIEW_CONTEXT_FILE_BYTES } from "../lib/pr-review-context.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-context-test-"));
	roots.push(root);
	return root;
}

describe("review context files", () => {
	test("keeps a bounded 64 MiB complete-diff file contract", () => {
		expect(MAX_REVIEW_CONTEXT_FILE_BYTES).toBe(64 * 1024 * 1024);
	});

	test("appends a relative complete diff to compact inline metadata", async () => {
		const root = fixture();
		fs.writeFileSync(path.join(root, "pr.diff"), "diff --git a/a.ts b/a.ts\n+added\n");
		const loaded = await loadReviewContext(root, "PR #7 metadata", "pr.diff");
		expect(loaded.context).toContain("PR #7 metadata");
		expect(loaded.context).toContain("--- Complete PR diff from context_file ---");
		expect(loaded.context).toContain("diff --git a/a.ts b/a.ts");
		expect(loaded.contextFile).toBe(path.join(root, "pr.diff"));
		expect(loaded.contextFileText).toContain("diff --git a/a.ts b/a.ts");
		expect(loaded.contextFileBytes).toBeGreaterThan(0);
	});

	test("preserves inline-only compatibility", async () => {
		expect(await loadReviewContext("/tmp", "  inline diff  ", undefined)).toEqual({
			context: "inline diff",
			contextFileBytes: 0,
		});
	});

	test("rejects empty, non-file, and oversized inputs before dispatch", async () => {
		const root = fixture();
		fs.writeFileSync(path.join(root, "empty.diff"), "");
		fs.writeFileSync(path.join(root, "large.diff"), "12345");
		await expect(loadReviewContext(root, undefined, "empty.diff")).rejects.toThrow("is empty");
		await expect(loadReviewContext(root, undefined, ".")).rejects.toThrow("not a regular file");
		await expect(loadReviewContext(root, undefined, "large.diff", 4)).rejects.toThrow("exceeds 4 bytes");
	});
});
