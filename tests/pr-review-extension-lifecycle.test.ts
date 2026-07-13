import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}));

const reviewTable = (await import("../extensions/review-table.ts")).default;

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
	autoPost: resolveAutoPostSetting({ autoPostReviews: false }),
};

interface Harness {
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	branch: any[];
	notifications: string[];
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
	if (previousPath === undefined) previousPath = process.env.PATH;
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	return dir;
}

function createHarness(initialBranch: any[] = [], identity = session): Harness {
	let nextId = 1;
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const branch = [...initialBranch];
	const notifications: string[] = [];
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
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ type: "custom", id: `custom-${nextId++}`, customType, data });
		},
	};
	reviewTable(pi as any);
	return {
		handlers,
		commands,
		branch,
		notifications,
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

function persistedInlineReview(identity = session): any {
	const cache = new CompletedReviewCache();
	const record = cache.remember(review, invocation, repository);
	return cache.persist(record, identity);
}

describe("completed review extension lifecycle", () => {
	test("persists a reference before publishing after Pi stores exact assistant JSON", async () => {
		const harness = createHarness();
		await harness.emit("input", { text: "/pr-review 7 --comment" });
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
