import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewLoopCoordinator, REVIEW_LOOP_TOOL_NAMES } from "../lib/pr-review-loop.ts";
import { SelfReviewPermitCoordinator, SELF_REVIEW_TOOL_NAME } from "../lib/pr-self-review.ts";
import {
	COMPLETED_REVIEW_BRANCH_ANCHOR_TYPE,
	COMPLETED_REVIEW_ENTRY_TYPE,
	CompletedReviewCache,
	resolveAutoPostSetting,
	type CompletedReviewSessionIdentity,
	type ReviewLike,
} from "../lib/pr-review-publish.ts";

mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => join(tmpdir(), "pi-pr-review-empty-agent-dir"),
	getSelectListTheme: () => ({}),
	getSettingsListTheme: () => ({}),
}));
mock.module("typebox", () => ({
	Type: {
		Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
		Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
			type: "object",
			properties,
			...options,
		}),
	},
}));

const reviewTable = (await import("../extensions/review-table.ts")).default;
const ownPromptPath = fileURLToPath(new URL("../prompts/pr-review.md", import.meta.url));
const BASE_ACTIVE_TOOLS = ["read", "bash"];

const review: ReviewLike = {
	pr: { number: 7, title: "Lifecycle review", head_sha: "a".repeat(40) },
	disposition: "reviewed",
	verification: "Not run.",
	overview: "Checks lifecycle persistence.",
	strengths: [],
	findings: [],
	notes: { correctness: "", security: "", performance: "" },
	verdict: "approve",
	overall_correctness: "patch is correct",
	overall_explanation: "No issues found.",
	overall_confidence_score: 0.9,
};

const session: CompletedReviewSessionIdentity = {
	id: "shared-explicit-id",
	startedAt: "2026-07-13T00:00:00.000Z",
};
const repository = { hostname: "github.com", repository: "owner/repo" };
const invocation = {
	mode: "disabled" as const,
	prNumber: 7,
	allowNonOpen: false,
	allowStalePublish: true,
	autoPost: resolveAutoPostSetting({ autoPostReviews: false }),
};

interface Harness {
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	tools: Map<string, any>;
	branch: any[];
	notifications: string[];
	sentMessages: Array<{ message: any; options: any }>;
	activeTools(): string[];
	abortCount(): number;
	selfReviewCoordinator: SelfReviewPermitCoordinator;
	setPromptPath(path: string): void;
	ctx: any;
	appendMessage(message: any, id?: string): any;
	emit(name: string, event: any): Promise<any[]>;
}

const tempDirs: string[] = [];
let previousPath: string | undefined;

afterEach(() => {
	if (previousPath !== undefined) process.env.PATH = previousPath;
	previousPath = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installFakeGh(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-lifecycle-"));
	tempDirs.push(dir);
	const gh = join(dir, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "repo view --json nameWithOwner,url" ]]; then
  echo '{"nameWithOwner":"owner/repo","url":"https://github.com/owner/repo"}'
else
  echo 'intentional lifecycle-test stop' >&2
  exit 1
fi
`,
	);
	chmodSync(gh, 0o755);
	for (const args of [
		["init", "-q"],
		["add", "gh"],
		["-c", "user.name=Lifecycle Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
	]) {
		const result = spawnSync("/usr/bin/git", args, { cwd: dir, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr || "fixture git setup failed");
	}
	if (previousPath === undefined) previousPath = process.env.PATH;
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	return dir;
}

function installFakePublishingGh(currentHead = "a".repeat(40), patchless = false): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-publish-tool-"));
	tempDirs.push(dir);
	const gh = join(dir, "gh");
	const payloadPath = join(dir, "payload.json");
	const changedFiles = patchless ? '[[{"filename":"src/parser.ts","status":"modified"}]]' : "[[]]";
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "repo view --json nameWithOwner,url" ]]; then
  echo '{"nameWithOwner":"owner/repo","url":"https://github.com/owner/repo"}'
elif [[ "$args" == *" user --jq .login"* ]]; then
  echo 'reviewer'
elif [[ "$args" == *"pulls/7/reviews?per_page=100"* || "$args" == *"issues/7/comments?per_page=100"* ]]; then
  echo '[[]]'
elif [[ "$args" == *"--method POST"* ]]; then
  cat > '${payloadPath}'
  echo '{"id":42,"html_url":"https://github.com/owner/repo/pull/7#pullrequestreview-42"}'
elif [[ "$args" == *"pulls/7/files?per_page=100"* ]]; then
  echo '${changedFiles}'
elif [[ "$args" == *"repos/owner/repo/pulls/7"* ]]; then
  printf '{"state":"open","draft":false,"merged_at":null,"head":{"sha":"%s"}}\n' '${currentHead}'
else
  echo "unexpected gh args: $args" >&2
  exit 1
fi
`,
	);
	chmodSync(gh, 0o755);
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	return payloadPath;
}

function createHarness(initialBranch: any[] = [], identity = session): Harness {
	let nextId = 1;
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const tools = new Map<string, any>();
	const branch = [...initialBranch];
	const notifications: string[] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	let activeTools = ["read", "bash", ...REVIEW_LOOP_TOOL_NAMES];
	let aborts = 0;
	let promptPath = ownPromptPath;
	const sessionManager = {
		getBranch: () => [...branch],
		getSessionId: () => identity.id,
		getHeader: () => ({ type: "session", id: identity.id, timestamp: identity.startedAt, cwd: "/tmp" }),
		getLeafEntry: () => branch.at(-1),
	};
	const ctx = {
		cwd: installFakeGh(),
		mode: "json",
		isProjectTrusted: () => false,
		abort: () => {
			aborts++;
		},
		sessionManager,
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => any) => {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, options.handler);
		},
		registerTool: (definition: any) => {
			tools.set(definition.name, definition);
			if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
		},
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ type: "custom", id: `custom-${nextId++}`, customType, data });
		},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
		getCommands: () => [{
			name: "pr-review",
			source: "prompt",
			sourceInfo: { path: promptPath },
		}],
	};
	const loopCoordinator = new ReviewLoopCoordinator(pi as any);
	const selfReviewCoordinator = new SelfReviewPermitCoordinator(pi as any, () => !!loopCoordinator.peek());
	reviewTable(pi as any, loopCoordinator, selfReviewCoordinator);
	return {
		handlers,
		commands,
		tools,
		branch,
		notifications,
		sentMessages,
		activeTools: () => [...activeTools],
		abortCount: () => aborts,
		selfReviewCoordinator,
		setPromptPath: (next: string) => {
			promptPath = next;
		},
		ctx,
		appendMessage(message: any, id = `message-${nextId++}`) {
			const entry = { type: "message", id, message };
			branch.push(entry);
			return entry;
		},
		async emit(name: string, event: any) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
			return results;
		},
	};
}

function persistedInlineReview(identity = session, allowStalePublish = true): any {
	const cache = new CompletedReviewCache();
	const record = cache.remember(
		review,
		{ ...invocation, allowStalePublish },
		repository,
	);
	return cache.persist(record, identity);
}

describe("completed review extension lifecycle", () => {
	test("automatically corrects invalid final JSON once and attempts publication", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment", source: "interactive" });
		const wrapped = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(review)}\n\`\`\`` }],
		};
		await harness.emit("message_end", { message: wrapped });
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message).toMatchObject({
			customType: "pr-review-output-repair",
			display: false,
		});
		expect(harness.sentMessages[0]?.message.content).toContain("exactly one JSON object");
		expect(harness.sentMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(harness.notifications.some((message) => message.includes("automatically correcting"))).toBeTrue();
		expect(harness.activeTools()).toEqual([]);

		harness.appendMessage(wrapped, "wrapped-review");
		await harness.emit("turn_end", { message: wrapped, toolResults: [] });
		expect(harness.notifications.some((message) => message.includes("was not posted"))).toBeFalse();

		const payloadPath = installFakePublishingGh();
		const corrected = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: JSON.stringify(review) }],
		};
		await harness.emit("message_end", { message: corrected });
		harness.appendMessage(corrected, "corrected-review");
		await harness.emit("turn_end", { message: corrected, toolResults: [] });

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.notifications.some((message) => message.includes("PR review posted"))).toBeTrue();
		expect(JSON.parse(readFileSync(payloadPath, "utf8")).body).toContain("Checks lifecycle persistence");
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
	});

	test("aborts and revokes repair authority when the correction attempts a tool call", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment", source: "interactive" });
		const invalid = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "not json" }],
		};
		await harness.emit("message_end", { message: invalid });
		expect(harness.activeTools()).toEqual([]);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "repair-bash", name: "bash", arguments: { command: "echo unsafe" } }],
			},
		});

		expect(harness.abortCount()).toBe(1);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.notifications.some((message) => message.includes("correction attempted to call tools"))).toBeTrue();
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
	});

	test("keeps tools suspended until a cancelled repair definitively settles", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment", source: "interactive" });
		const invalid = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "not json" }],
		};
		await harness.emit("message_end", { message: invalid });
		expect(harness.activeTools()).toEqual([]);

		const overlap = await harness.emit("input", {
			text: "do something unrelated",
			source: "interactive",
			streamingBehavior: "steer",
		});
		expect(overlap).toContainEqual({ action: "handled" });
		expect(harness.abortCount()).toBe(1);
		expect(harness.activeTools()).toEqual([]);
		expect(harness.notifications.some((message) => message.includes("was not queued"))).toBeTrue();

		const staleCorrection = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: JSON.stringify(review) }],
		};
		await harness.emit("message_end", { message: staleCorrection });
		harness.appendMessage(staleCorrection, "stale-correction");
		await harness.emit("turn_end", { message: staleCorrection, toolResults: [] });
		expect(harness.notifications.some((message) => message.includes("PR review posted"))).toBeFalse();
		expect(harness.activeTools()).toEqual([]);

		await harness.emit("agent_settled", {});
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
	});

	test("stops after one automatic correction attempt", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment", source: "interactive" });
		const invalid = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "not json" }],
		};
		await harness.emit("message_end", { message: invalid });
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.activeTools()).toEqual([]);
		await harness.emit("turn_end", { message: invalid, toolResults: [] });

		await harness.emit("message_end", { message: invalid });
		harness.appendMessage(invalid, "invalid-retry");
		await harness.emit("turn_end", { message: invalid, toolResults: [] });

		expect(harness.sentMessages).toHaveLength(1);
		expect(
			harness.notifications.some((message) =>
				message.includes("PR review was not posted: final response is not exactly one JSON object"),
			),
		).toBeTrue();
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
	});

	test("persists a reference before publishing after Pi stores exact assistant JSON", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment", source: "interactive" });
		const message = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: JSON.stringify(review) }],
		};
		await harness.emit("message_end", { message });
		const assistantEntry = harness.appendMessage(message, "assistant-review");
		await harness.emit("turn_end", { message, toolResults: [] });

		const persisted = harness.branch.findLast(
			(entry) => entry.type === "custom" && entry.customType === COMPLETED_REVIEW_ENTRY_TYPE,
		);
		expect(persisted?.data.reviewEntryId).toBe(assistantEntry.id);
		expect(persisted?.data.review).toBeUndefined();
		expect(harness.notifications.some((message) => message.includes("PR review publish failed"))).toBeTrue();
	});

	test("restores on session_start, clears on tree navigation, and scopes reused IDs by header", async () => {
		const persisted = persistedInlineReview();
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		await harness.commands.get("pr-review-publish")!("7 --allow-stale", harness.ctx);
		expect(harness.notifications.some((message) => message.includes("No completed review"))).toBeFalse();

		harness.branch.splice(0);
		harness.notifications.splice(0);
		await harness.emit("session_tree", { newLeafId: null, oldLeafId: "cache" });
		expect(harness.branch.at(-1)?.customType).toBe(COMPLETED_REVIEW_BRANCH_ANCHOR_TYPE);
		await harness.commands.get("pr-review-publish")!("7 --allow-stale", harness.ctx);
		expect(harness.notifications.some((message) => message.includes("No completed review"))).toBeTrue();

		const reusedId = createHarness([cacheEntry], { id: session.id, startedAt: "2026-07-14T00:00:00.000Z" });
		await reusedId.emit("session_start", { reason: "fork" });
		await reusedId.commands.get("pr-review-publish")!("7 --allow-stale", reusedId.ctx);
		expect(reusedId.notifications.some((message) => message.includes("No completed review"))).toBeTrue();
	});

	test("exposes self-review only for a direct clean top-level task and hides it for /pr-review", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("input", { text: "implement the requested change", source: "interactive" });
		expect(harness.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);
		await harness.emit("before_agent_start", { prompt: "implement the requested change" });
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);
		await harness.emit("agent_end", { messages: [] });
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);
		await harness.emit("agent_settled", {});
		expect(harness.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);

		await harness.emit("input", { text: "implement another change", source: "rpc" });
		await harness.emit("before_agent_start", { prompt: "implement another change" });
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);
		await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		expect(harness.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);
		expect(harness.activeTools()).toEqual([...BASE_ACTIVE_TOOLS, ...REVIEW_LOOP_TOOL_NAMES]);
	});

	test("binds self-review only from a sole tool call and preserves authority after denied dispatches", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "implement safely", source: "interactive" });
		await harness.emit("before_agent_start", { prompt: "implement safely" });

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "mixed-self", name: SELF_REVIEW_TOOL_NAME, arguments: {} },
					{ type: "toolCall", id: "mixed-edit", name: "edit", arguments: {} },
				],
			},
		});
		expect(await harness.selfReviewCoordinator.consume("mixed-self", harness.ctx)).toBeUndefined();
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "multiple-one", name: SELF_REVIEW_TOOL_NAME, arguments: {} },
					{ type: "toolCall", id: "multiple-two", name: SELF_REVIEW_TOOL_NAME, arguments: {} },
				],
			},
		});
		expect(await harness.selfReviewCoordinator.consume("multiple-one", harness.ctx)).toBeUndefined();
		expect(await harness.selfReviewCoordinator.consume("direct-unbound", harness.ctx)).toBeUndefined();
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "error",
				content: [{ type: "toolCall", id: "rejected-self", name: SELF_REVIEW_TOOL_NAME, arguments: {} }],
			},
		});
		expect(await harness.selfReviewCoordinator.consume("rejected-self", harness.ctx)).toBeUndefined();
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "sole-self", name: SELF_REVIEW_TOOL_NAME, arguments: {} }],
			},
		});
		expect(await harness.selfReviewCoordinator.consume("wrong-id", harness.ctx)).toBeUndefined();
		expect(harness.activeTools()).toContain(SELF_REVIEW_TOOL_NAME);
		expect(await harness.selfReviewCoordinator.consume("sole-self", harness.ctx)).toBeDefined();
		expect(harness.activeTools()).not.toContain(SELF_REVIEW_TOOL_NAME);
	});

	test("exposes review tools only for trusted command-loop phases", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);

		await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		expect(harness.activeTools()).toEqual([...BASE_ACTIVE_TOOLS, ...REVIEW_LOOP_TOOL_NAMES]);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "review_subagents" }],
			},
		});
		expect(harness.activeTools()).toEqual([...BASE_ACTIVE_TOOLS, ...REVIEW_LOOP_TOOL_NAMES]);

		await harness.emit("input", { text: "do something unrelated", source: "interactive", streamingBehavior: "steer" });
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);

		const denied = await harness.emit("input", { text: "/pr-review 8", source: "extension" });
		expect(denied).toContainEqual({ action: "handled" });
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
	});

	test("rejects queued and shadowed prompt invocations", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("input", { text: "/pr-review 6", source: "interactive" });
		const queued = await harness.emit("input", {
			text: "/pr-review 7",
			source: "interactive",
			streamingBehavior: "followUp",
		});
		expect(queued).toContainEqual({ action: "handled" });
		expect(harness.abortCount()).toBe(1);
		expect(harness.activeTools()).not.toContain("review_subagent");

		harness.setPromptPath("/tmp/other-package/prompts/pr-review.md");
		const shadowed = await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		expect(shadowed).toContainEqual({ action: "handled" });
		expect(harness.activeTools()).not.toContain("review_subagent");
	});

	test("publishes a direct comments request without an agent turn", async () => {
		const persisted = persistedInlineReview(session, false);
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		expect(harness.tools.has("pr_review_publish")).toBeFalse();
		const currentHead = "b".repeat(40);
		const payloadPath = installFakePublishingGh(currentHead);
		const handled = await harness.emit("input", {
			text: "post the comments",
			source: "interactive",
		});
		expect(handled).toContainEqual({ action: "handled" });
		expect(harness.notifications.some((message) => message.includes("posted"))).toBeTrue();
		const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
		expect(payload.comments).toBeUndefined();
		expect(payload.body).toContain("[!WARNING]");
		expect(payload.body).toContain("This review was generated for commit");
		expect(payload.body).toContain("a".repeat(40));
		expect(payload.body).toContain(currentHead);
	});

	test("surfaces patchless inline fallback in the posted notification", async () => {
		const patchlessReview: ReviewLike = {
			...review,
			findings: [
				{
					title: "[P2] Patchless finding",
					severity: "P2",
					blocking: false,
					body: "This finding must remain visible in the summary.",
					confidence_score: 0.9,
					code_location: {
						absolute_file_path: "src/parser.ts",
						line_range: { start: 2, end: 2 },
						side: "RIGHT",
						commentable: true,
					},
				},
			],
		};
		const cache = new CompletedReviewCache();
		const record = cache.remember(patchlessReview, invocation, repository);
		const persisted = cache.persist(record, session);
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		const payloadPath = installFakePublishingGh("a".repeat(40), true);

		await harness.commands.get("pr-review-publish")!("7", harness.ctx);

		expect(harness.notifications.some((message) => message.includes("1 inline finding kept in the summary"))).toBeTrue();
		const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
		expect(payload.comments).toBeUndefined();
		expect(payload.body).toContain("[P2] Patchless finding");
	});

	test("rejects extension-generated, queued, and steering publish requests", async () => {
		const persisted = persistedInlineReview();
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		const payloadPath = installFakePublishingGh();

		for (const event of [
			{ text: "post the inline review", source: "extension" },
			{ text: "post the inline review", source: "interactive", streamingBehavior: "followUp" },
			{ text: "post the inline review", source: "rpc", streamingBehavior: "steer" },
		]) {
			const results = await harness.emit("input", event);
			expect(results).not.toContainEqual({ action: "handled" });
		}
		expect(() => readFileSync(payloadPath, "utf8")).toThrow();
	});

	test("does not publish an older cache entry while a review is active", async () => {
		const persisted = persistedInlineReview();
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		const payloadPath = installFakePublishingGh();

		const handled = await harness.emit("input", { text: "post the inline review", source: "interactive" });
		expect(handled).toContainEqual({ action: "handled" });
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);
		expect(harness.notifications.some((message) => message.includes("will not post an older cached result"))).toBeTrue();
		expect(() => readFileSync(payloadPath, "utf8")).toThrow();
	});

	test("publish command follows captured stale config unless explicitly overridden", async () => {
		const persisted = persistedInlineReview(session, false);
		const cacheEntry = { type: "custom", id: "cache", customType: COMPLETED_REVIEW_ENTRY_TYPE, data: persisted };
		const harness = createHarness([cacheEntry]);
		await harness.emit("session_start", { reason: "reload" });
		const currentHead = "b".repeat(40);
		const payloadPath = installFakePublishingGh(currentHead);

		await harness.commands.get("pr-review-publish")!("7", harness.ctx);
		expect(harness.notifications.some((message) => message.includes("--allow-stale"))).toBeTrue();
		expect(() => readFileSync(payloadPath, "utf8")).toThrow();

		harness.notifications.splice(0);
		await harness.commands.get("pr-review-publish")!("7 --allow-stale", harness.ctx);
		expect(harness.notifications.some((message) => message.includes("posted"))).toBeTrue();
		const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
		expect(payload.comments).toBeUndefined();
		expect(payload.body).toContain("a".repeat(40));
		expect(payload.body).toContain(currentHead);
	});

	test("registered commands explicitly revoke an active review", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		expect(harness.activeTools()).toContain("review_subagent");
		await harness.commands.get("pr-review-publish")!("7", harness.ctx);
		expect(harness.activeTools()).not.toContain("review_subagent");
		expect(harness.notifications.some((message) => message.includes("review was cancelled"))).toBeTrue();
	});

	test("invalid publish commands revoke authority before argument parsing", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7", source: "interactive" });
		expect(harness.activeTools()).toContain("review_subagent");
		await harness.commands.get("pr-review-publish")!("not-a-pr", harness.ctx);
		expect(harness.activeTools()).not.toContain("review_subagent");
		expect(harness.notifications.some((message) => message.includes("Invalid /pr-review-publish"))).toBeTrue();
	});

	test("suspends review tools while awaiting non-open confirmation", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7", source: "rpc" });
		await harness.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{
					type: "text",
					text: `PR #7 is MERGED (head ${"a".repeat(40)}). Review it anyway? Reply yes, or rerun with --include-closed to proceed non-interactively.`,
				}],
			},
		});
		expect(harness.activeTools()).toEqual(BASE_ACTIVE_TOOLS);

		await harness.emit("input", { text: "yes", source: "rpc" });
		expect(harness.activeTools()).toEqual([...BASE_ACTIVE_TOOLS, ...REVIEW_LOOP_TOOL_NAMES]);
	});

	test("does not append a redundant anchor for summarized tree navigation", async () => {
		const harness = createHarness();
		await harness.emit("session_tree", {
			newLeafId: "summary",
			oldLeafId: "old",
			summaryEntry: { type: "branch_summary", id: "summary" },
		});
		expect(harness.branch.some((entry) => entry.customType === COMPLETED_REVIEW_BRANCH_ANCHOR_TYPE)).toBeFalse();
	});
});
