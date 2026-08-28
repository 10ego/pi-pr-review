import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const registerPrReviewSubagents = (await import("../extensions/pr-review-subagent.ts")).default;
const { ReviewLoopCoordinator } = await import("../lib/pr-review-loop.ts");
const { parsePublishMode, resolveAutoPostSetting } = await import("../lib/pr-review-publish.ts");
const { getAgentDir } = await import("@earendil-works/pi-coding-agent");

function harness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	let activeTools = ["read", "review_subagent", "review_subagents", "pr_review_verify", "self_review_subagent"];
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

describe("review tool execution gate", () => {
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
		for (const name of ["review_subagent", "review_subagents", "pr_review_verify"]) {
			const result = await h.tools.get(name).execute("call-1", {}, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.details).toEqual({ authorized: false });
			expect(result.content[0].text).toContain("active user-initiated /pr-review loop");
		}
	});

	test("verification reports action-specific argument errors after flat-schema validation", async () => {
		const h = harness();
		h.coordinator.begin(
			parsePublishMode("/pr-review 7"),
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
			parsePublishMode("/pr-review 7"),
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
			h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-multipart",
				{ passes: [{ id: "correctness", tier: "heavy", objective: "review" }], max_parallel: 1 },
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
			h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-public-nonempty",
				{ passes: [{ id: "deep-review", tier: "heavy", objective: "review", expected_output: "nonempty" }], max_parallel: 1 },
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

	test("ordinary review_subagents accepts an exit-zero unterminated NO FINDINGS event", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-ordinary-no-findings-"));
		const child = path.join(root, "child.mjs");
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => process.stdout.write(JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO FINDINGS." }] },
			})));
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-no-findings",
				{ passes: [{ id: "security", tier: "heavy", objective: "review" }], max_parallel: 1 },
				undefined, undefined, h.ctx,
			);
			expect(result.isError).not.toBeTrue();
			expect(result.details.results[0]).toMatchObject({ rawText: "NO FINDINGS.", status: "complete" });
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[0]).toMatchObject({ rawText: "NO FINDINGS.", lifecycle: "complete" });
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("assigns and preserves explicit identities for every shard while keeping unsharded IDs compatible", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-explicit-shards-"));
		const child = path.join(root, "child.mjs");
		const diff = path.join(root, "repo", "diff.patch");
		writeFileSync(child, `
			process.stdin.resume();
			process.stdin.on("end", () => process.stdout.write(JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO FINDINGS." }] },
			})));
		`);
		const originalScript = process.argv[1];
		try {
			mkdirSync(path.join(root, "repo"));
			writeFileSync(diff, [
				"diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+aa",
				"diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1 +1 @@", "-b", "+bb",
			].join("\n"));
			const h = harness();
			h.ctx.cwd = path.join(root, "repo");
			h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-shards",
				{ passes: [{ id: "correctness", tier: "heavy", objective: "review" }], context_file: diff, shard_count: 2 },
				undefined, undefined, h.ctx,
			);
			expect(result.details.results.map((lane: any) => lane.id)).toEqual(["correctness-shard-1", "correctness-shard-2"]);
			expect(result.details.scheduling.intervals.map((lane: any) => lane.id)).toEqual(["correctness-shard-1", "correctness-shard-2"]);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((lane) => lane.passId)).toEqual(["correctness-shard-1", "correctness-shard-2"]);
			expect(result.content[0].text).toContain("## Pass: correctness-shard-1");
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("automatically shards oversized inline diffs before model dispatch", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-auto-shards-")), child = path.join(root, "child.mjs");
		writeFileSync(child, `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"NO FINDINGS."}]}})));`);
		const block = (name: string, marker: string) => [
			`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1 @@", `-${marker}`, `+${marker}${"x".repeat(105_000)}`,
		].join("\n"), context = `PR metadata only.\n\n${block("a.ts", "a")}\n${block("b.ts", "b")}`;
		const originalScript = process.argv[1];
		try {
			const h = harness(); h.ctx.cwd = root; h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx); process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute("auto-shards", { passes: [{ id: "correctness", tier: "heavy", objective: "review" }], context, max_parallel: 1 }, undefined, undefined, h.ctx);
			expect(result.isError).not.toBeTrue(); expect(result.details).toMatchObject({ shardCount: 2, requestedShardCount: 1, shardingSource: "automatic-size-preflight", changedFileCount: 2, maxParallel: 2 }); expect(result.details.diffBytes).toBeGreaterThanOrEqual(200_000); expect(result.details.results.map((lane: any) => lane.id)).toEqual(["correctness-shard-1", "correctness-shard-2"]); expect(h.coordinator.artifactSnapshot(h.ctx)?.map((lane) => lane.passId)).toEqual(["correctness-shard-1", "correctness-shard-2"]);
		} finally { process.argv[1] = originalScript; rmSync(root, { recursive: true, force: true }); }
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
			h.coordinator.begin(parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-delta",
				{ passes: [{ id: "correctness", tier: "heavy", objective: "review" }], max_parallel: 1 },
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
			"- title: [P2] Complete bounded lane", "- severity: P2", "- why: fixture",
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
				parsePublishMode("/pr-review 7"), resolveAutoPostSetting({ autoPostReviews: false }), "interactive", h.ctx,
				true, false, "off", undefined,
				{ source: "default", warnings: [], config: {
					attemptMs: { light: 2_000, medium: 2_000, heavy: 2_000 }, fallbackAttemptMs: 2_000,
					batchMs: 1_000, synthesisMs: 100, totalMs: 1_300, terminationGraceMs: 50,
					cleanupReserveMs: 50, minimumFallbackMs: 100,
				} },
			);
			process.argv[1] = child;
			const result = await h.tools.get("review_subagents").execute(
				"batch-deadline",
				{ passes: [
					{ id: "fast", tier: "heavy", objective: "fast lane" },
					{ id: "slow", tier: "heavy", objective: "slow lane" },
				], max_parallel: 2 },
				undefined, undefined, h.ctx,
			);
			expect(result.isError).toBeTrue();
			expect(result.details.lifecycleCounts).toEqual({ complete: 1, partial: 0, timed_out: 1, failed: 0 });
			expect(result.details.results[0]).toMatchObject({ id: "fast", status: "complete" });
			expect(result.details.results[1]).toMatchObject({ id: "slow", status: "timed_out", rawText: "partial slow evidence" });
			expect(result.details.results[1].attempts[0]).toMatchObject({
				configuredDeadlineMs: 2_000,
			});
			expect(result.details.results[1].attempts[0].deadlineMs).toBeLessThanOrEqual(1_000);
			expect(result.details.results[1].attempts[0].deadlineMs).toBeGreaterThan(0);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.map((artifact: any) => artifact.lifecycle)).toEqual(["complete", "timed_out"]);
			expect(h.coordinator.artifactSnapshot(h.ctx)?.[1]?.attempts[0]).toMatchObject({
				configuredDeadlineMs: 2_000,
			});
		} finally {
			process.argv[1] = originalScript;
			rmSync(root, { recursive: true, force: true });
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
