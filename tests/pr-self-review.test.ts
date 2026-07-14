import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	buildSelfReviewDelta,
	parseSelfReviewOutput,
	SelfReviewPermitCoordinator,
	SELF_REVIEW_TOOL_NAME,
} from "../lib/pr-self-review.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
	const result = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-self-review-"));
	roots.push(root);
	git(root, "init", "-q");
	writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
	git(root, "add", "tracked.ts");
	git(root, "-c", "user.name=Self Review Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
	return root;
}

function repositoryWithSubmodule(): string {
	const child = repository();
	const root = repository();
	git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child");
	git(root, "-c", "user.name=Self Review Test", "-c", "user.email=test@example.invalid", "commit", "-qam", "add child");
	return root;
}

function harness(root: string) {
	let activeTools = ["read", SELF_REVIEW_TOOL_NAME];
	let reviewActive = false;
	const session = { id: "session-1", startedAt: "2026-07-13T00:00:00.000Z" };
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
	};
	const ctx = {
		cwd: root,
		sessionManager: {
			getSessionId: () => session.id,
			getHeader: () => ({ id: session.id, timestamp: session.startedAt }),
		},
	};
	const coordinator = new SelfReviewPermitCoordinator(pi as any, () => reviewActive);
	coordinator.hideTool();
	return {
		coordinator,
		ctx,
		session,
		setReviewActive: (active: boolean) => {
			reviewActive = active;
		},
		activeTools: () => [...activeTools],
	};
}

describe("one-shot self-review authority", () => {
	test("binds a clean direct task and atomically rejects concurrent and replayed consumes", async () => {
		const root = repository();
		const h = harness(root);
		expect(h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any)).toBeTrue();
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		expect(h.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);

		writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "new.ts"), "export const added = true;\n");
		const permits = await Promise.all([
			h.coordinator.consume(h.ctx as any),
			h.coordinator.consume(h.ctx as any),
		]);
		const winners = permits.filter(Boolean);
		expect(winners).toHaveLength(1);
		expect(h.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);
		expect(await h.coordinator.consume(h.ctx as any)).toBeUndefined();

		const permit = winners[0]!;
		const captured = await buildSelfReviewDelta(permit);
		expect(captured.fileCount).toBe(2);
		expect(captured.delta).toContain("tracked.ts");
		expect(captured.delta).toContain("new.ts");
		expect(captured.delta).toContain("export const value = 2;");
		expect(captured.delta).toContain("export const added = true;");
		h.coordinator.finish(permit);
	});

	test("rejects extension, queued, dirty-start, session-changed, and /pr-review-overlap authority", async () => {
		const root = repository();
		const h = harness(root);
		expect(h.coordinator.noteTopLevelInput("extension", undefined, h.ctx as any)).toBeFalse();
		expect(h.coordinator.noteTopLevelInput("rpc", "followUp", h.ctx as any)).toBeFalse();

		writeFileSync(join(root, "tracked.ts"), "dirty before task\n");
		expect(h.coordinator.noteTopLevelInput("rpc", undefined, h.ctx as any)).toBeTrue();
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeFalse();
		expect(h.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);

		git(root, "checkout", "--", "tracked.ts");
		h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any);
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		h.session.startedAt = "2026-07-14T00:00:00.000Z";
		expect(await h.coordinator.consume(h.ctx as any)).toBeUndefined();

		h.session.startedAt = "2026-07-13T00:00:00.000Z";
		h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any);
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		h.setReviewActive(true);
		expect(await h.coordinator.consume(h.ctx as any)).toBeUndefined();
		expect(h.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);
	});

	test("fails closed instead of reviewing an outer-only diff for a dirty submodule", async () => {
		const root = repositoryWithSubmodule();
		const h = harness(root);
		h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any);
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		writeFileSync(join(root, "child", "tracked.ts"), "export const value = 2;\n");
		const permit = (await h.coordinator.consume(h.ctx as any))!;
		await expect(buildSelfReviewDelta(permit)).rejects.toThrow("submodule commit or worktree is changed or dirty");
		h.coordinator.finish(permit);
	});

	test("consumes the permit but fails closed if HEAD moves or there is no delta", async () => {
		const root = repository();
		const h = harness(root);
		h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any);
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		const emptyPermit = (await h.coordinator.consume(h.ctx as any))!;
		await expect(buildSelfReviewDelta(emptyPermit)).rejects.toThrow("no Git-visible working-tree delta");
		expect(await h.coordinator.consume(h.ctx as any)).toBeUndefined();
		h.coordinator.finish(emptyPermit);

		h.coordinator.noteTopLevelInput("interactive", undefined, h.ctx as any);
		expect(await h.coordinator.beginTask(h.ctx as any)).toBeTrue();
		writeFileSync(join(root, "tracked.ts"), "export const value = 3;\n");
		git(root, "add", "tracked.ts");
		git(root, "-c", "user.name=Self Review Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "move head");
		const movedPermit = (await h.coordinator.consume(h.ctx as any))!;
		await expect(buildSelfReviewDelta(movedPermit)).rejects.toThrow("HEAD changed");
	});
});

const validFinding = {
	title: "[P2] Preserve the permit until settlement",
	severity: "P2",
	blocking: false,
	impact: "Queued continuation loses its one-shot review authority.",
	trigger: "Pi emits agent_end before an automatic continuation.",
	evidence: "The changed handler clears the coordinator at agent_end.",
	path: "extensions/review-table.ts",
	startLine: 574,
	endLine: 576,
	side: "RIGHT",
	inDiff: true,
	prRelated: true,
	confidence: 0.98,
};

describe("self-review output validation", () => {
	test("accepts only the exact empty or P0-P2 evidence schema", () => {
		expect(parseSelfReviewOutput('{"findings":[]}')).toEqual({ findings: [] });
		expect(parseSelfReviewOutput(JSON.stringify({ findings: [validFinding] }))).toEqual({ findings: [validFinding] });
	});

	test("rejects malformed JSON, prose wrappers, and extra or missing fields", () => {
		expect(() => parseSelfReviewOutput("NO FINDINGS.")).toThrow("strict JSON");
		expect(() => parseSelfReviewOutput('```json\n{"findings":[]}\n```')).toThrow("strict JSON");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [], summary: "none" }))).toThrow("exactly");
		const { evidence: _evidence, ...missingEvidence } = validFinding;
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [missingEvidence] }))).toThrow("exactly");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, suggestion: "nit" }] }))).toThrow("exactly");
	});

	test("rejects P3/nit leakage and inconsistent evidence metadata", () => {
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, title: "[P3] Rename this", severity: "P3" }] }))).toThrow("P0, P1, or P2");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, title: "[P1] Preserve authority" }] }))).toThrow("match its severity");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, blocking: true }] }))).toThrow("blocking");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, inDiff: false }] }))).toThrow("in-diff");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, path: "../outside.ts" }] }))).toThrow("repo-relative");
		expect(() => parseSelfReviewOutput(JSON.stringify({ findings: [{ ...validFinding, confidence: 1.1 }] }))).toThrow("between 0 and 1");
	});
});
