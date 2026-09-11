import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-tool-gate-agent-"));
process.env.PI_PR_REVIEW_TEST_AGENT_DIR = testAgentDir;

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options: Record<string, unknown> = {}) => ({ enum: values, ...options }),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => process.env.PI_PR_REVIEW_TEST_AGENT_DIR ?? "/tmp/pi-pr-review-tool-gate-agent",
	getSelectListTheme: () => ({}),
	getSettingsListTheme: () => ({}),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class { addChild() {} },
	fuzzyFilter: (items: unknown[]) => items,
	getKeybindings: () => ({ matches: () => false }),
	Input: class {},
	SelectList: class {},
	SettingsList: class {},
	Text: class {},
	matchesKey: (data: string, key: string) => ({
		escape: "\x1b",
		"ctrl+c": "\x03",
		tab: "\t",
		"shift+tab": "\x1b[Z",
		right: "\x1b[C",
		left: "\x1b[D",
		up: "\x1b[A",
		down: "\x1b[B",
		pageUp: "\x1b[5~",
		pageDown: "\x1b[6~",
		home: "\x1b[H",
		end: "\x1b[F",
	} as Record<string, string>)[key] === data,
	truncateToWidth: (text: string, width: number, ellipsis = "…", pad = false) => {
		const truncated = text.length > width ? `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}` : text;
		return pad ? truncated.padEnd(width) : truncated;
	},
	wrapTextWithAnsi: (text: string, width: number) => text.split("\n").flatMap((line) => {
		if (!line) return [""];
		const chunks: string[] = [];
		for (let index = 0; index < line.length; index += width) chunks.push(line.slice(index, index + width));
		return chunks;
	}),
}));
mock.module("typebox", () => {
	const schema = (options: Record<string, unknown> = {}) => ({ ...options });
	return {
		Type: {
			Array: (items: Record<string, unknown>, options: Record<string, unknown> = {}) => ({ type: "array", items, ...options }),
			Boolean: schema,
			Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
			Literal: schema,
			Number: schema,
			Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
				type: "object",
				properties,
				...options,
			}),
			Optional: (value: Record<string, unknown>) => value,
			String: schema,
			Union: schema,
		},
	};
});

const prReviewSubagentModule = await import("../extensions/pr-review-subagent.ts");
const registerPrReviewSubagents = prReviewSubagentModule.default;
const { automaticStillOpenCarryForwards, cumulativeExpectedLanes, invalidStillOpenPriorTitles } = prReviewSubagentModule;
const { ReviewLoopCoordinator } = await import("../lib/pr-review-loop.ts");
const { parsePublishMode, resolveAutoPostSetting, resolveReviewSelection } = await import("../lib/pr-review-publish.ts");
const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
const { priorRevalidationRegistry } = await import("../lib/pr-review-prior.ts");
const { reviewCandidateDispositionRegistry } = await import("../lib/pr-review-candidates.ts");

function harness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	let activeTools = ["read", "review_subagent", "review_subagents", "pr_review_verify", "pr_review_prepare", "pr_review_prior", "pr_review_prior_status", "pr_review_candidate_disposition", "pr_review_incremental_gap", "self_review_subagent"];
	const pi = {
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: any) => commands.set(name, definition.handler),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
	};
	const coordinator = new ReviewLoopCoordinator(pi as any);
	registerPrReviewSubagents(pi as any, coordinator);
	const notifications: string[] = [];
	const ctx = {
		cwd: "/tmp/repo",
		hasUI: false,
		mode: "json",
		isProjectTrusted: () => false,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: {
			getSessionId: () => "session-1",
			getHeader: () => ({ id: "session-1", timestamp: "2026-07-13T00:00:00.000Z" }),
		},
	};
	return {
		tools,
		commands,
		coordinator,
		ctx,
		activeTools: () => [...activeTools],
	};
}

function quickPasses(overrides: Partial<Record<"correctness" | "correctness-contracts" | "security-performance", string>> = {}) {
	return ["correctness", "correctness-contracts", "security-performance"].map((id) => ({
		id,
		objective: overrides[id as keyof typeof overrides] ?? "review",
	}));
}

function balancedPasses() {
	return ["overview", "correctness", "correctness-contracts", "security-performance", "performance-resources"]
		.map((id) => ({ id, objective: "review" }));
}

describe("review tool execution gate", () => {
	test("requires exact canonical re-entry for every still-open prior finding", () => {
		expect(invalidStillOpenPriorTitles([
			{ status: "resolved", title: "Old resolved", severity: "P1" },
			{ status: "still open", title: "Restore tenant guard", severity: "P1" },
		], [{ title: "[P1] Restore tenant guard", severity: "P1" }])).toEqual([]);
		expect(invalidStillOpenPriorTitles([
			{ status: "still open", title: "Restore tenant guard", severity: "P1" },
		], [{ title: "[P1] Restore tenant guard", severity: "P2" }])).toEqual(["Restore tenant guard"]);
		expect(invalidStillOpenPriorTitles([
			{ status: "still open", title: "Restore tenant guard", severity: "P1" },
		], [{ title: "[P0] Restore tenant guard", severity: "P0" }])).toEqual([]);
		expect(invalidStillOpenPriorTitles([
			{ status: "still open", title: "Restore tenant guard", severity: "P1" },
		], [{ title: "[P1] restore tenant guard", severity: "P1" }])).toEqual(["Restore tenant guard"]);
		expect(invalidStillOpenPriorTitles([
			{ status: "still open", title: "Restore tenant guard", severity: "P1" },
		], [{ title: "[P1] Restore   tenant guard", severity: "P1" }])).toEqual(["Restore tenant guard"]);
	});

	test("automatically carries forward omitted still-open findings without masking a supplied downgrade", () => {
		const statuses = [{ findingId: "thread:1", status: "still open", title: "Restore tenant guard", severity: "P1", evidence: "The unconditional return remains at src/access.ts:2." }] as const;
		expect(automaticStillOpenCarryForwards(statuses, [])).toEqual([{
			title: "[P1] Restore tenant guard",
			severity: "P1",
			blocking: true,
			body: "This previously reported defect remains open after current-source revalidation. Evidence: The unconditional return remains at src/access.ts:2.",
			confidence_score: 0.9,
			code_location: null,
		}]);
		expect(automaticStillOpenCarryForwards(statuses, [], [{ findingId: "thread:1", path: "src/access.ts", line: 2, side: "RIGHT" }], true)[0]?.code_location).toEqual({ absolute_file_path: "src/access.ts", line_range: { start: 2, end: 2 }, side: "RIGHT", commentable: true });
		expect(automaticStillOpenCarryForwards(statuses, [], [{ findingId: "thread:1", path: "../outside", line: 2, side: "RIGHT" }], true)[0]?.code_location).toBeNull();
		expect(automaticStillOpenCarryForwards(statuses, [{ title: "[P2] Restore tenant guard", severity: "P2" }])).toEqual([]);
		expect(invalidStillOpenPriorTitles(statuses, [{ title: "[P2] Restore tenant guard", severity: "P2" }])).toEqual(["Restore tenant guard"]);
	});

	test("pre-registers the exact cumulative topology for each mode", () => {
		expect(cumulativeExpectedLanes("same_head", "balanced").map((lane) => lane.key)).toEqual(["incremental-gap", "incremental-security-performance"]);
		expect(cumulativeExpectedLanes("same_head", "deep").map((lane) => lane.key)).toEqual(["incremental-gap"]);
		expect(cumulativeExpectedLanes("incremental", "balanced").map((lane) => lane.key)).toEqual([
			"incremental-gap", "incremental-correctness", "incremental-contracts", "incremental-security-performance",
		]);
		expect(cumulativeExpectedLanes("incremental", "full").map((lane) => lane.key)).toEqual([
			"incremental-gap", "incremental-correctness", "incremental-contracts", "incremental-security-performance", "incremental-conventions",
		]);
		expect(cumulativeExpectedLanes("incremental", "deep").map((lane) => lane.key)).toEqual(["incremental-gap", "incremental-deep"]);
		expect(cumulativeExpectedLanes("incremental", "balanced", false).map((lane) => lane.key)).toEqual(["incremental-gap"]);
		expect(cumulativeExpectedLanes("none", "balanced")).toEqual([]);
	});
	test("registers self-review with an empty closed schema and hides it while idle", () => {
		const h = harness();
		const tool = h.tools.get("self_review_subagent");
		expect(tool.parameters).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(h.activeTools()).not.toContain("self_review_subagent");
	});

	test("self-review fails before host delta work when no top-level permit exists", async () => {
		const h = harness();
		const result = await h.tools.get("self_review_subagent").execute("call-self", {}, undefined, undefined, h.ctx);
		expect(result.isError).toBeTrue();
		expect(result.details).toEqual({ authorized: false });
		expect(result.content[0].text).toContain("no active one-shot permit");
	});

	test("all review tools fail before processing parameters outside /pr-review", async () => {
		const h = harness();
		for (const name of ["review_subagent", "review_subagents", "pr_review_verify", "pr_review_prepare", "pr_review_prior", "pr_review_prior_status", "pr_review_candidate_disposition", "pr_review_incremental_gap"]) {
			const result = await h.tools.get(name).execute("call-1", {}, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.details).toEqual({ authorized: false });
			expect(result.content[0].text).toContain("active user-initiated /pr-review loop");
		}
	});

	test("automatic selection blocks every review lane until preparation settles", async () => {
		const h = harness();
		h.coordinator.begin(
			{ ...parsePublishMode("/pr-review 7 --quick --incremental"), reviewSelection: "auto" },
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const batch = await h.tools.get("review_subagents").execute("batch", {
			passes: quickPasses(),
			context: "metadata",
			context_file: "/not-read-before-selection",
		}, undefined, undefined, h.ctx);
		expect(batch).toMatchObject({ isError: true, details: { reason: "preparation_required" } });
		const single = await h.tools.get("review_subagent").execute("single", {
			tier: "heavy",
			objective: "review",
			context: "metadata",
			context_file: "/not-read-before-selection",
		}, undefined, undefined, h.ctx);
		expect(single).toMatchObject({ isError: true, details: { reason: "preparation_required" } });
		expect(h.coordinator.setPriorRelationship(h.coordinator.acquire(h.ctx)!, "none", h.ctx)).toBeTrue();
		const settled = await h.tools.get("review_subagents").execute("batch-settled", {
			passes: quickPasses(),
			context: "metadata",
			context_file: "/now-context-validation-runs",
		}, undefined, undefined, h.ctx);
		expect(settled.details.reason).not.toBe("preparation_required");
	});

	test("prior discovery requires the --incremental flag on the active invocation", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const result = await h.tools.get("pr_review_prior").execute("prior-flag", { pr_number: 7 }, undefined, undefined, h.ctx);
		expect(result).toMatchObject({
			isError: true,
			details: { authorized: false, reason: "not_incremental" },
		});
		expect(result.content[0].text).toContain("requires a legacy incremental invocation");
	});

	test("automatic selection cannot bypass atomic preparation through the legacy prior tool", async () => {
		const h = harness();
		h.coordinator.begin(
			resolveReviewSelection(parsePublishMode("/pr-review 7")),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const result = await h.tools.get("pr_review_prior").execute("prior-auto", { pr_number: 7 }, undefined, undefined, h.ctx);
		expect(result).toMatchObject({ isError: true, details: { authorized: false, reason: "preparation_required" } });
		expect(h.coordinator.priorRelationship(h.ctx)).toBeUndefined();
	});

	test("prior discovery rejects a PR number that differs from the active invocation", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7 --incremental"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const tool = h.tools.get("pr_review_prior");
		const mismatch = await tool.execute("prior-1", { pr_number: 8 }, undefined, undefined, h.ctx);
		expect(mismatch).toMatchObject({
			isError: true,
			details: { authorized: false, reason: "pr_mismatch" },
		});
		expect(mismatch.content[0].text).toContain("does not match the active /pr-review invocation");
	});

	test("structured prior statuses require complete registered finding coverage", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7 --incremental"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const lease = h.coordinator.acquire(h.ctx)!;
		expect(h.coordinator.setPriorRelationship(lease, "same_head", h.ctx)).toBeTrue();
		priorRevalidationRegistry.markFindings("session-1", lease.generation, [{ findingId: "thread:9", threadId: 9, inReplyToId: null, path: "src/a.ts", line: 2, side: "RIGHT", severity: "P1", title: "Canonical title" }]);
		const tool = h.tools.get("pr_review_prior_status");
		const incomplete = await tool.execute("status-1", { statuses: [] }, undefined, undefined, h.ctx);
		expect(incomplete).toMatchObject({ isError: true, details: { authorized: true, reason: "invalid_statuses" } });
		const accepted = await tool.execute("status-2", { statuses: [{ finding_id: "thread:9", status: "rejected", severity: "P1", evidence: "Verified invariant [P0]." }] }, undefined, undefined, h.ctx);
		expect(accepted.isError).toBeUndefined();
		expect(accepted.details.statuses).toEqual([{ findingId: "thread:9", status: "rejected", severity: "P1", title: "Canonical title", evidence: "Verified invariant (P0)." }]);
		const repeated = await tool.execute("status-3", { statuses: [{ finding_id: "thread:9", status: "resolved", severity: "P1", evidence: "overwrite" }] }, undefined, undefined, h.ctx);
		expect(repeated).toMatchObject({ isError: true, details: { authorized: true, reason: "invalid_statuses" } });
	});

	test("structured candidate dispositions require exact one-shot coverage", async () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
		const lease = h.coordinator.acquire(h.ctx)!;
		expect(h.coordinator.setPriorRelationship(lease, "incremental", h.ctx)).toBeTrue();
		reviewCandidateDispositionRegistry.markCandidates("session-1", lease.generation, [
			{ id: "incremental-gap:1", laneKey: "incremental-gap", finding: { title: "[P1] Canonical", severity: "P1", body: "impact", code_location: null } },
			{ id: "incremental-contracts:1", laneKey: "incremental-contracts", finding: { title: "[P1] Duplicate", severity: "P1", body: "impact", code_location: null } },
		]);
		const tool = h.tools.get("pr_review_candidate_disposition");
		const incomplete = await tool.execute("candidates-1", { overview: "Overview", verification: "Verified", decisions: [], added_findings: [] }, undefined, undefined, h.ctx);
		expect(incomplete).toMatchObject({ isError: true, details: { reason: "invalid_dispositions" } });
		const accepted = await tool.execute("candidates-2", { overview: "Overview", verification: "Verified", decisions: [
			{ candidate_id: "incremental-gap:1", disposition: "accepted" },
			{ candidate_id: "incremental-contracts:1", disposition: "duplicate", duplicate_of: "incremental-gap:1" },
		], added_findings: [{ title: "Parent issue", severity: "P2", body: "Validated parent-only issue.", confidence: 0.9, path: "src/b.ts", start_line: 3, end_line: 3, side: "RIGHT", commentable: true }] }, undefined, undefined, h.ctx);
		expect(accepted.isError).toBeUndefined();
		expect(accepted.details.finalization.decisions).toHaveLength(2);
		expect(accepted.details.finalization.addedFindings[0].title).toBe("[P2] Parent issue");
	});

	test("host finalization carries an omitted source-revalidated still-open prior finding", async () => {
		const h = harness(); h.ctx.sessionManager.getSessionId = () => "automatic-carry-session";
		h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
		const lease = h.coordinator.acquire(h.ctx)!;
		expect(h.coordinator.setPriorRelationship(lease, "same_head", h.ctx)).toBeTrue();
		expect(h.coordinator.registerExpectedArtifacts(lease, [{ key: "incremental-gap", tier: "heavy", minorHygiene: false, expectedOutput: "nonempty" }], h.ctx)).toBeTrue();
		priorRevalidationRegistry.markFindings("automatic-carry-session", lease.generation, [{ findingId: "thread:1", threadId: 1, inReplyToId: null, path: "src/access.ts", line: 2, side: "RIGHT", severity: "P1", title: "Restore tenant guard" }]);
		const status = await h.tools.get("pr_review_prior_status").execute("carry-status", { statuses: [{ finding_id: "thread:1", status: "still open", severity: "P1", evidence: "The unconditional authorization remains." }] }, undefined, undefined, h.ctx);
		expect(status.isError).toBeUndefined();
		expect(reviewCandidateDispositionRegistry.replaceLaneCandidates("automatic-carry-session", lease.generation, "incremental-gap", [])).toBeTrue();
		const finalized = await h.tools.get("pr_review_candidate_disposition").execute("carry-finalize", { overview: "Review complete", verification: "Source inspected", decisions: [], added_findings: [{ title: "[P1] Restore tenant guard", severity: "P1", body: "Duplicate manual carry-forward without a safe current anchor.", confidence: 0.8, path: "src/access.ts" }] }, undefined, undefined, h.ctx);
		expect(finalized.isError).toBeUndefined();
		expect(finalized.details.automaticCarryForwards).toBe(1);
		expect(finalized.details.finalization.addedFindings).toEqual([expect.objectContaining({ title: "[P1] Restore tenant guard", severity: "P1", code_location: { absolute_file_path: "src/access.ts", line_range: { start: 2, end: 2 }, side: "RIGHT", commentable: true } })]);
	});

	test("recovers an omitted prepared gap after validation and requires one finalization resubmission", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-post-confirm-gap-"));
		const child = path.join(root, "child.mjs");
		writeFileSync(child, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Review status: COMPLETE\\nOverview: The complete PR was inspected.\\nStrengths: The change remains focused.\\nRisk areas: Authorization boundaries require attention.\\ntitle: [P1] Preserve tenant authorization\\nseverity: P1\\nwhy: Returning true permits cross-tenant document reads and removes the ownership boundary.\\nlocation: src/access.ts:2\\nside: RIGHT\\nin_diff: yes\\npr_related: yes\\nconfidence: 0.99" }] } })));`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root; h.ctx.sessionManager.getSessionId = () => "post-confirm-gap-session";
			h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			const lease = h.coordinator.acquire(h.ctx)!;
			expect(h.coordinator.setPriorRelationship(lease, "incremental", h.ctx)).toBeTrue();
			expect(h.coordinator.registerExpectedArtifacts(lease, [{ key: "incremental-gap", tier: "heavy", minorHygiene: false, expectedOutput: "nonempty" }], h.ctx)).toBeTrue();
			expect(h.coordinator.registerPreparedContext(lease, "incremental-gap", Buffer.from("diff --git a/src/access.ts b/src/access.ts\n"), h.ctx)).toBeTrue();
			process.argv[1] = child;
			const first = await h.tools.get("pr_review_candidate_disposition").execute("recover-gap", { overview: "Review complete", verification: "Source inspected", decisions: [], added_findings: [] }, undefined, undefined, h.ctx);
			expect(first).toMatchObject({ isError: true, details: { reason: "gap_recovered", status: "complete", candidates: ["incremental-gap:1"] } });
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((artifact: any) => [artifact.key, artifact.lifecycle])).toEqual([["incremental-gap", "complete"]]);
			const second = await h.tools.get("pr_review_candidate_disposition").execute("finalize-gap", { overview: "Review complete", verification: "Source inspected", decisions: [{ candidate_id: "incremental-gap:1", disposition: "accepted" }], added_findings: [] }, undefined, undefined, h.ctx);
			expect(second.isError).toBeUndefined();
			expect(second.details.finalization.decisions).toEqual([{ candidateId: "incremental-gap:1", disposition: "accepted" }]);
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("incremental gap hunting requires a host-established usable prior relationship", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7 --incremental"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const tool = h.tools.get("pr_review_incremental_gap");
		const denied = await tool.execute("gap-1", { context_file: "/tmp/diff" }, undefined, undefined, h.ctx);
		expect(denied).toMatchObject({
			isError: true,
			details: { authorized: false, reason: "prior_relationship" },
		});
		const lease = h.coordinator.acquire(h.ctx)!;
		expect(h.coordinator.setPriorRelationship(lease, "same_head", h.ctx)).toBeTrue();
		const contextFailure = await tool.execute("gap-2", { context_file: "/definitely/missing" }, undefined, undefined, h.ctx);
		expect(contextFailure).toMatchObject({
			isError: true,
			details: { authorized: true, reason: "context_failed" },
		});
		const sameHeadResource = await h.tools.get("review_subagent").execute("same-head-resource", {
			incremental_pass: "incremental-security-performance", tier: "heavy", objective: "ignored", context_file: "/definitely/missing",
		}, undefined, undefined, h.ctx);
		expect(sameHeadResource).toMatchObject({ isError: true, details: { tier: "heavy", contextFileBytes: 0 } });
		const sameHeadWrongPass = await h.tools.get("review_subagent").execute("same-head-wrong", {
			incremental_pass: "incremental-correctness", tier: "heavy", objective: "ignored", context_file: "/definitely/missing",
		}, undefined, undefined, h.ctx);
		expect(sameHeadWrongPass).toMatchObject({ isError: true, details: { authorized: false, reason: "incremental_pass" } });
		expect(h.coordinator.setPriorRelationship(lease, "incremental", h.ctx)).toBeTrue();
		const wrongTier = await h.tools.get("review_subagent").execute("delta-1", {
			incremental_pass: "incremental-correctness",
			tier: "light",
			objective: "ignored",
			context_file: "/definitely/missing",
		}, undefined, undefined, h.ctx);
		expect(wrongTier).toMatchObject({
			isError: true,
			details: { authorized: false, reason: "incremental_pass" },
		});
		const genericSingle = await h.tools.get("review_subagent").execute("generic-single", {
			tier: "light",
			objective: "generic cumulative pass",
			context_file: "/definitely/missing",
		}, undefined, undefined, h.ctx);
		expect(genericSingle).toMatchObject({ isError: true, details: { authorized: false, reason: "cumulative_lane_tool" } });
		const genericBatch = await h.tools.get("review_subagents").execute("generic-batch", {
			passes: balancedPasses(),
			context_file: "/definitely/missing",
		}, undefined, undefined, h.ctx);
		expect(genericBatch).toMatchObject({ isError: true, details: { authorized: false, reason: "cumulative_lane_tool" } });
	});

	test("routes a generic heavy pass over the exact prepared full diff into the mandatory gap lane", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-gap-alias-"));
		const child = path.join(root, "child.mjs"), diff = path.join(root, "full.diff"), counter = path.join(root, "attempt-count");
		const framing = "Review status: COMPLETE\nOverview: complete full-diff gap hunt.\nStrengths: bounded scope.\nRisk areas: low integration risk.\nNO FINDINGS.";
		writeFileSync(diff, "diff --git a/a.ts b/a.ts\n");
		const partialWithCandidate = "Review status: COMPLETE\nOverview: first attempt found a defect.\nStrengths: bounded scope.\nRisk areas: authorization regression.\ntitle: [P1] Preserve the first attempt finding\nseverity: P1\nwhy: The changed authorization path permits cross-tenant access.\nlocation: src/access.ts:2\nside: RIGHT\nin_diff: yes\npr_related: yes\nconfidence: 0.99\n\ntitle: [P1] truncated";
		writeFileSync(child, `import fs from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0; fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1)); const text = count === 0 ? ${JSON.stringify(partialWithCandidate)} : ${JSON.stringify(framing)}; process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } })); });`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root; h.ctx.sessionManager.getSessionId = () => "gap-alias-session";
			h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			const lease = h.coordinator.acquire(h.ctx)!;
			expect(h.coordinator.setPriorRelationship(lease, "incremental", h.ctx)).toBeTrue();
			expect(h.coordinator.registerExpectedArtifacts(lease, [{ key: "incremental-gap", tier: "heavy", minorHygiene: false, expectedOutput: "nonempty" }], h.ctx)).toBeTrue();
			expect(h.coordinator.registerPreparedContext(lease, "incremental-gap", readFileSync(diff), h.ctx)).toBeTrue();
			process.argv[1] = child;
			const result = await h.tools.get("review_subagent").execute("generic-heavy", { tier: "heavy", objective: "generic request", context_file: diff }, undefined, undefined, h.ctx);
			expect(result.isError).not.toBeTrue();
			expect(result.details).toMatchObject({ incrementalGapAlias: true, relationship: "incremental", status: "complete", fallbackUsed: false });
			expect(result.details.attempts).toHaveLength(2);
			expect(result.details.attempts.map((attempt: any) => [attempt.status, attempt.contractRetryable])).toEqual([["partial", true], ["complete", false]]);
			expect(result.content[0].text).toContain("Candidate IDs: none");
			expect(reviewCandidateDispositionRegistry.candidates("gap-alias-session", lease.generation)).toEqual([]);
			expect(h.coordinator.expectedArtifactDescriptors(h.ctx)?.map((entry: any) => entry.key)).toEqual(["incremental-gap"]);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((entry: any) => [entry.passId, entry.lifecycle])).toEqual([["incremental-gap", "complete"]]);
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not spend the synthetic contract slot after a provider failure", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-gap-provider-failure-"));
		const child = path.join(root, "child.mjs"), diff = path.join(root, "full.diff"), counter = path.join(root, "attempt-count");
		writeFileSync(diff, "diff --git a/a.ts b/a.ts\n");
		writeFileSync(child, `import fs from "node:fs"; const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0; fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1)); process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "Review status: COMPLETE\\nOverview: partial provider output before failure." }] } })); process.stderr.write("429 rate limited"); process.exit(1); });`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root; h.ctx.sessionManager.getSessionId = () => "gap-provider-failure-session";
			h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			const lease = h.coordinator.acquire(h.ctx)!;
			expect(h.coordinator.setPriorRelationship(lease, "incremental", h.ctx)).toBeTrue();
			expect(h.coordinator.registerExpectedArtifacts(lease, [{ key: "incremental-gap", tier: "heavy", minorHygiene: false, expectedOutput: "nonempty" }], h.ctx)).toBeTrue();
			expect(h.coordinator.registerPreparedContext(lease, "incremental-gap", readFileSync(diff), h.ctx)).toBeTrue();
			process.argv[1] = child;
			const result = await h.tools.get("review_subagent").execute("generic-heavy-failure", { tier: "heavy", objective: "generic request", context_file: diff }, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.details.attempts).toHaveLength(1);
			expect(result.details.attempts[0]).toMatchObject({ status: "partial", contractRetryable: false });
			expect(readFileSync(counter, "utf8")).toBe("1");
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("incremental gap hunting rejects a context file that differs by any byte from GitHub", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-gap-binding-"));
		const previousPath = process.env.PATH;
		try {
			const gh = path.join(root, "gh"), diff = path.join(root, "full.diff");
			writeFileSync(gh, "#!/bin/sh\nprintf 'different\\n'\n"); chmodSync(gh, 0o755);
			writeFileSync(diff, "expected\n"); process.env.PATH = `${root}:${previousPath ?? ""}`;
			const h = harness(); h.ctx.cwd = root;
			h.coordinator.begin(parsePublishMode("/pr-review 7 --incremental"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx, true, false, "off", { repository: "acme/widget", hostname: "github.com", prNumber: 7, prTitle: "PR", reviewedHeadSha: "a".repeat(40), state: "OPEN", draft: false });
			const lease = h.coordinator.acquire(h.ctx)!; expect(h.coordinator.setPriorRelationship(lease, "same_head", h.ctx)).toBeTrue();
			const result = await h.tools.get("pr_review_incremental_gap").execute("gap-bind", { context_file: diff }, undefined, undefined, h.ctx);
			expect(result).toMatchObject({ isError: true, details: { authorized: true, reason: "full_diff_mismatch" } });
		} finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); }
	});

	test("verification reports action-specific argument errors after flat-schema validation", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7 --quick"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const tool = h.tools.get("pr_review_verify");

		const missingRun = await tool.execute("verify-run", { action: "run" }, undefined, undefined, h.ctx);
		expect(missingRun).toMatchObject({
			isError: true,
			details: { authorized: true, reason: "missing_run_arguments" },
		});
		expect(missingRun.content[0].text).toContain("requires pr_number, head_sha, and baseline_name");

		const pollutedList = await tool.execute(
			"verify-list",
			{ action: "list", pr_number: 7 },
			undefined,
			undefined,
			h.ctx,
		);
		expect(pollutedList).toMatchObject({
			isError: true,
			details: { authorized: true, reason: "invalid_list_arguments" },
		});
		expect(pollutedList.content[0].text).toContain("accepts only the action field");
	});

	test("the config command revokes authority even though extension commands bypass input events", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7 --quick"),
			resolveAutoPostSetting({ autoPostReviews: false }),
			"interactive",
			h.ctx,
		);
		const lease = h.coordinator.acquire(h.ctx)!;
		expect(lease.signal.aborted).toBeFalse();
		await h.commands.get("pr-review-config")!("show", h.ctx);
		expect(lease.signal.aborted).toBeTrue();
		expect(h.activeTools()).toEqual(["read"]);
	});

	test("ordinary review_subagents retains multipart final output in content, details, and artifacts", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-ordinary-multipart-"));
		const child = path.join(root, "child.mjs");
		const laneText = [
			"- title: [P2] Preserve all lane evidence",
			"- severity: P2",
			"- why: multipart output must remain authoritative",
			"- location: extensions/pr-review-subagent.ts:1-2",
			"- side: RIGHT",
			"- in_diff: yes",
			"- pr_related: yes",
			"- confidence: 0.99",
		].join("\n");
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => {
				const text = ${JSON.stringify(laneText)};
				process.stdout.write(JSON.stringify({ type: "message_end", message: {
					role: "assistant", model: "provider/observed", stopReason: "stop",
					content: [
						{ type: "text", text: text.slice(0, 73) },
						{ type: "thinking", text: "ignored" },
						{ type: "text", text: text.slice(73) },
					],
				} }));
			});
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-multipart",
				{ passes: quickPasses() },
				undefined,
				undefined,
				h.ctx,
			);
			expect(result.isError).not.toBeTrue();
			expect(result.content[0].text).toContain(laneText);
			expect(result.details.results[0]).toMatchObject({ rawText: laneText, model: "provider/observed", status: "complete" });
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[0]).toMatchObject({
				rawText: laneText,
				observedModel: "provider/observed",
				lifecycle: "complete",
			});
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("public batch path accepts nonempty framing output under passes[].expected_output", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-public-nonempty-"));
		const child = path.join(root, "child.mjs");
		const framing = "Review status: COMPLETE\nOverview: the integrated review is complete.\nStrengths: focused scope and matching tests.\nRisk areas: low integration risk.\nNO FINDINGS.";
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => process.stdout.write(JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: ${JSON.stringify(framing)} }] },
			})));
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7 --deep"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-public-nonempty",
				{ passes: [{ id: "deep-review", objective: "review" }] },
				undefined,
				undefined,
				h.ctx,
			);
			expect(result.isError).not.toBeTrue();
			expect(result.details.results[0]).toMatchObject({ rawText: framing, status: "complete" });
			expect(h.coordinator.expectedArtifactDescriptors(h.ctx)).toEqual([{
				key: "batch-public-nonempty:0", tier: "heavy", minorHygiene: false, expectedOutput: "nonempty",
			}]);
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ordinary review_subagents accepts a punctuation-only NO FINDINGS variant", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-ordinary-no-findings-"));
		const child = path.join(root, "child.mjs");
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => process.stdout.write(JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO FINDINGS" }] },
			})));
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-no-findings",
				{ passes: quickPasses() },
				undefined, undefined, h.ctx,
			);
			expect(result.isError).not.toBeTrue();
			expect(result.details.results[0]).toMatchObject({ rawText: "NO FINDINGS", status: "complete" });
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[0]).toMatchObject({ rawText: "NO FINDINGS", lifecycle: "complete" });
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses fixed mode reviewer identities without caller scheduler controls", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-fixed-topology-"));
		const child = path.join(root, "child.mjs");
		writeFileSync(child, `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"NO FINDINGS."}]}})));`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root;
			h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute("batch-fixed", { passes: quickPasses() }, undefined, undefined, h.ctx);
			expect(result.isError).not.toBeTrue();
			expect(result.details).toMatchObject({ reviewMode: "quick", reviewerCount: 3, coverageStrategy: "embedded", passCount: 3 });
			expect(result.details).not.toHaveProperty("maxParallel");
			expect(result.details).not.toHaveProperty("shardCount");
			expect(result.details.results.map((lane: any) => lane.id)).toEqual(["correctness", "correctness-contracts", "security-performance"]);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((lane) => lane.passId)).toEqual(["correctness", "correctness-contracts", "security-performance"]);
			expect(result.content[0].text).toContain("Review mode: Quick. Reviewers completed: 3/3");
		} finally { process.argv[1] = originalScript; rmSync(root, { recursive: true, force: true }); }
	});

	test("rejects a batch that does not match the active fixed mode", async () => {
		const h = harness();
		h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
		const result = await h.tools.get("review_subagents").execute("wrong-topology", { passes: [{ id: "correctness", objective: "review" }] }, undefined, undefined, h.ctx);
		expect(result.isError).toBeTrue();
		expect(result.content[0].text).toContain("quick mode requires exactly these ordered reviewers");
		expect(h.coordinator.artifactSnapshot(h.ctx)).toEqual([]);
	});

	test("routes oversized complete diffs through the same file-backed reviewers", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-file-backed-")), child = path.join(root, "child.mjs"), diffFile = path.join(root, "diff.patch");
		const block = (name: string, marker: string) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1,1100 @@", `-${marker}`, ...Array.from({ length: 1_100 }, (_, index) => `+${marker}${index}:${"x".repeat(90)}`)].join("\n");
		const diffText = `${block("a.ts", "a")}\n${block("b.ts", "b")}`; writeFileSync(diffFile, diffText);
		writeFileSync(child, `let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{const i=process.argv.indexOf("--tools"),safe=i>=0&&process.argv[i+1]==="read,grep,find,ls"&&!process.argv.includes("bash");const ranges=[...input.matchAll(/^- offset (\\d+), limit (\\d+)$/gm)];for(const [_,offset,limit] of ranges){const id="read-"+offset;console.log(JSON.stringify({type:"tool_execution_start",toolCallId:id,toolName:"read",args:{path:${JSON.stringify(diffFile)},offset:Number(offset),limit:Number(limit)}}));console.log(JSON.stringify({type:"tool_execution_end",toolCallId:id,toolName:"read",isError:false}))}process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:Buffer.byteLength(input)<100000&&safe&&ranges.length>1?"NO FINDINGS.":"UNSAFE_OR_OVERSIZED"}]}}))});`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root;
			h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx); process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute("file-backed", { passes: quickPasses(), context: "PR metadata only.", context_file: diffFile }, undefined, undefined, h.ctx);
			expect(result.isError).not.toBeTrue();
			expect(result.details).toMatchObject({ reviewMode: "quick", reviewerCount: 3, coverageStrategy: "file-backed", changedFileCount: 2, fileBackedPassCount: 3, sharedContextBytes: Buffer.byteLength("PR metadata only.") });
			expect(result.details.results.map((lane: any) => lane.id)).toEqual(["correctness", "correctness-contracts", "security-performance"]);
			expect(result.details.results.every((lane: any) => lane.toolPolicy === "configured" && lane.rawText === "NO FINDINGS.")).toBeTrue();
			expect(result.details.diffBytes).toBeGreaterThanOrEqual(200_000);
		} finally { process.argv[1] = originalScript; rmSync(root, { recursive: true, force: true }); }
	});

	test("keeps a file-backed reviewer partial until it successfully accesses the complete diff", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-file-access-")), child = path.join(root, "child.mjs"), diff = path.join(root, "diff.patch");
		writeFileSync(diff, ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2200 @@", "-a", ...Array.from({ length: 2_200 }, (_, index) => `+${index}:${"x".repeat(90)}`)].join("\n"));
		writeFileSync(child, `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"NO FINDINGS."}]}})));`);
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root; h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx); process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute("no-file-access", { passes: quickPasses(), context_file: diff }, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.details.lifecycleCounts).toEqual({ complete: 0, partial: 3, timed_out: 0, failed: 0 });
			expect(result.details.results.every((lane: any) => lane.errorMessage === "File-backed complete diff was not fully read through every host-required range.")).toBeTrue();
			expect(h.coordinator.artifactSnapshot(h.ctx)?.every((lane) => lane.lifecycle === "partial")).toBeTrue();
		} finally { process.argv[1] = originalScript; rmSync(root, { recursive: true, force: true }); }
	});

	test("rejects oversized embedded metadata even when context_file is present", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-embedded-limit-")), diff = path.join(root, "diff.patch");
		writeFileSync(diff, "diff --git a/a b/a\n-old\n+new\n");
		try {
			for (const params of [
				{ passes: quickPasses(), context: `diff --git a/a b/a\n+${"x".repeat(200_000)}` },
				{ passes: quickPasses(), context_file: diff, context: "x".repeat(200_000) },
				{ passes: quickPasses().map((pass, index) => index === 1 ? { ...pass, context: "x".repeat(200_000) } : pass), context_file: diff },
				{ passes: quickPasses().map((pass, index) => index === 1 ? { ...pass, objective: "x".repeat(20_000) } : pass), context_file: diff },
				{ passes: quickPasses().map((pass) => ({ ...pass, context: "x".repeat(64 * 1024) })), context: "x".repeat(64 * 1024), context_file: diff },
			]) {
				const h = harness(); h.ctx.cwd = root; h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
				const result = await h.tools.get("review_subagents").execute("oversized-inline", params, undefined, undefined, h.ctx);
				expect(result.isError).toBeTrue();
				expect(result.content[0].text).toContain("aggregate metadata exceeds its deterministic UTF-8 byte bound");
				expect(h.coordinator.artifactSnapshot(h.ctx)).toEqual([]);
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("fails closed when non-sharded full coverage would require too many reads", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-read-plan-limit-")), diff = path.join(root, "large.patch");
		writeFileSync(diff, ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,8000 @@", "-a", ...Array.from({ length: 8_000 }, (_, index) => `+${index}:${"x".repeat(90)}`)].join("\n"));
		try {
			const h = harness(); h.ctx.cwd = root; h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			const result = await h.tools.get("review_subagents").execute("read-plan-limit", { passes: quickPasses(), context_file: diff }, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.content[0].text).toContain("full coverage requires more than 16 bounded reads");
			expect(h.coordinator.artifactSnapshot(h.ctx)).toEqual([]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("fails closed instead of truncating an unsafe complete-diff manifest", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-file-manifest-")), diff = path.join(root, "unsafe.patch"), longName = `${"a".repeat(2_100)}.ts`;
		writeFileSync(diff, [`diff --git a/${longName} b/${longName}`, `--- a/${longName}`, `+++ b/${longName}`, "@@ -1 +1 @@", "-a", `+${"x".repeat(200_000)}`].join("\n"));
		try {
			const h = harness(); h.ctx.cwd = root; h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			const result = await h.tools.get("review_subagents").execute("unsafe-manifest", { passes: quickPasses(), context_file: diff }, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue(); expect(result.content[0].text).toContain("diff manifest is unsafe or full coverage requires more than 16 bounded reads"); expect(h.coordinator.artifactSnapshot(h.ctx)).toEqual([]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("ordinary review_subagents retains canonical delta-only text when the child exits before message_end", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-ordinary-delta-"));
		const child = path.join(root, "child.mjs");
		const earlier = "earlier assistant turn";
		const partial = "partial focus-visible evidence";
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => {
				console.log(JSON.stringify({ type: "message_start", message: {
					role: "assistant", model: "provider/tool-turn", content: [],
				} }));
				console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: {
					type: "text_delta", delta: ${JSON.stringify(earlier)},
				} }));
				console.log(JSON.stringify({ type: "message_end", message: {
					role: "assistant", model: "provider/tool-turn", stopReason: "toolUse",
					content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
				} }));
				console.log(JSON.stringify({ type: "message_start", message: {
					role: "assistant", model: "provider/delta-only", content: [],
				} }));
				for (const delta of [${JSON.stringify(partial.slice(0, 13))}, ${JSON.stringify(partial.slice(13))}]) {
					console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: {
						type: "text_delta", delta,
					} }));
				}
			});
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-delta",
				{ passes: quickPasses() },
				undefined,
				undefined,
				h.ctx,
			);
			const focusPass = h.coordinator.focusSnapshot(h.ctx)?.passes[0];
			expect(result.isError).toBeTrue();
			expect(result.content[0].text).toContain(partial);
			expect(result.content[0].text).not.toContain(earlier);
			expect(result.details.results[0]).toMatchObject({ rawText: partial, model: "provider/delta-only", status: "partial" });
			expect(focusPass).toMatchObject({ assistantText: partial, model: "provider/delta-only", status: "partial" });
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[0]).toMatchObject({
				rawText: partial,
				observedModel: "provider/delta-only",
				lifecycle: "partial",
			});
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("completes a batch with one lane timed out while retaining its partial output", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-deadline-batch-"));
		const child = path.join(root, "child.mjs");
		const complete = [
			"- title: [P2] Complete bounded lane", "- severity: P2", "- why: The bounded lane found a concrete fixture issue.",
			"- location: file.ts:1-1", "- side: RIGHT", "- in_diff: yes",
			"- pr_related: yes", "- confidence: 0.9",
		].join("\n");
		writeFileSync(child, `
			let input = "";
			process.stdin.on("data", chunk => input += chunk);
			process.stdin.on("end", () => {
				if (input.includes("slow lane")) {
					console.log(JSON.stringify({ type: "message_start", message: { role: "assistant", model: "fixture/slow", content: [] } }));
					console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial slow evidence" } }));
					setInterval(() => {}, 1000);
				} else {
					console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fixture/fast", stopReason: "stop", content: [{ type: "text", text: ${JSON.stringify(complete)} }] } }));
				}
			});
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(
				parsePublishMode("/pr-review 7 --quick"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx,
				true, false, "off", undefined,
				{ source: "default", warnings: [], config: {
					attemptMs: { light: 2_000, medium: 2_000, heavy: 2_000 }, fallbackAttemptMs: 2_000,
					batchMs: 500, synthesisMs: 100, totalMs: 2_000, terminationGraceMs: 50,
					cleanupReserveMs: 50, minimumFallbackMs: 100,
				} },
			);
			process.argv[1] = child;
			// Parent preflight/orchestration may legitimately exceed batchMs before
			// reviewer dispatch. The batch window starts here, not at invocation input.
			await new Promise((resolve) => setTimeout(resolve, 600));
			const result = await h.tools.get("review_subagents").execute(
				"batch-deadline",
				{ passes: quickPasses({ "correctness-contracts": "slow lane" }) },
				undefined, undefined, h.ctx,
			);
			expect(result.isError).toBeTrue();
			expect(result.details.lifecycleCounts).toEqual({ complete: 2, partial: 0, timed_out: 1, failed: 0 });
			expect(result.details.results[0]).toMatchObject({ id: "correctness", status: "complete" });
			expect(result.details.results[1]).toMatchObject({ id: "correctness-contracts", status: "timed_out", rawText: "partial slow evidence" });
			expect(result.details.results[1].attempts[0]).toMatchObject({
				configuredDeadlineMs: 2_000,
			});
			expect(result.details.results[1].attempts[0].budgetElapsedBeforeAttemptMs).toBeGreaterThanOrEqual(500);
			expect(result.details.results[1].attempts[0].batchRemainingBeforeAttemptMs).toBeGreaterThan(0);
			expect(result.details.results[1].attempts[0].totalRemainingBeforeAttemptMs).toBeGreaterThan(0);
			expect(result.details.results[1].attempts[0].deadlineMs).toBeLessThanOrEqual(500);
			expect(result.details.results[1].attempts[0].deadlineMs).toBeGreaterThan(0);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((artifact: any) => artifact.lifecycle)).toEqual(["complete", "timed_out", "complete"]);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[1]?.attempts[0]).toMatchObject({
				configuredDeadlineMs: 2_000,
				budgetElapsedBeforeAttemptMs: expect.any(Number),
				batchRemainingBeforeAttemptMs: expect.any(Number),
				totalRemainingBeforeAttemptMs: expect.any(Number),
			});
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the config command replaces legacy max parallelism with a default review mode", async () => {
		const agentDir = getAgentDir();
		const configPath = `${agentDir}/pr-review.json`;
		rmSync(agentDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ maxParallel: 9, tiers: {} }));
		try {
			const h = harness();
			const command = h.commands.get("pr-review-config")!;
			await command("default_review_mode=full", h.ctx);
			const saved = JSON.parse(readFileSync(configPath, "utf8"));
			expect(saved.defaultReviewMode).toBe("full");
			expect(saved).not.toHaveProperty("maxParallel");
			await command("default_review_mode=deep", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).defaultReviewMode).toBe("deep");
			await command("default_review_mode=invalid", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).defaultReviewMode).toBe("deep");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("the config command persists approval gates and explicit stale-approval opt-in", async () => {
		const agentDir = getAgentDir();
		const configPath = `${agentDir}/pr-review.json`;
		rmSync(agentDir, { recursive: true, force: true });
		try {
			const h = harness();
			const command = h.commands.get("pr-review-config")!;
			await command("approve_max_priority_level=off", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).approveMaxPriorityLevel).toBe("off");
			await command("approve_max_priority_level=P2", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).approveMaxPriorityLevel).toBe("P2");
			await command("approve_max_priority_level=P3", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).approveMaxPriorityLevel).toBe("P3");
			await command("approve_max_priority_level=nit", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).approveMaxPriorityLevel).toBe("nit");
			await command("approve_max_priority_level=P0", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).approveMaxPriorityLevel).toBe("nit");
			await command("allow_stale_approvals=true", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).allowStaleApprovals).toBeTrue();
			await command("allow_stale_approvals=invalid", h.ctx);
			expect(JSON.parse(readFileSync(configPath, "utf8")).allowStaleApprovals).toBeTrue();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
