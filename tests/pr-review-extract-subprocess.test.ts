import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewBudget } from "../lib/pr-review-deadlines.ts";
import { buildExtractionInput, buildExtractionSystemPrompt } from "../lib/pr-review-extract.ts";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: () => ({}),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => join(tmpdir(), "pi-pr-review-extraction-subprocess"),
	getSelectListTheme: () => ({}),
	getSettingsListTheme: () => ({}),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class {},
	fuzzyFilter: (items: unknown[]) => items,
	getKeybindings: () => ({ matches: () => false }),
	Input: class {},
	matchesKey: () => false,
	SelectList: class {},
	SettingsList: class {},
	Text: class {},
}));
mock.module("typebox", () => {
	const schema = () => ({});
	return {
		Type: {
			Array: schema, Boolean: schema,
			Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
			Literal: schema, Number: schema,
			Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
				type: "object", properties, ...options,
			}),
			Optional: schema, String: schema, Union: schema,
		},
	};
});

const { runFindingExtraction, overridePiInvocation } = await import("../extensions/pr-review-subagent.ts");

/** Point the runner's subprocess discovery at the fake pi binary. */
function routeToFake(dir: string) {
	return overridePiInvocation(join(dir, "pi"));
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `pi` child on PATH: records argv + stdin, then replies from a file.
 * getPiInvocation() falls back to the bare `pi` binary (the test runner is a
 * generic runtime), so PATH precedence routes the spawn here, exercising the
 * real subprocess path: arg assembly, temp system prompt, task framing,
 * window computation, output bounding, and lease abort.
 */
function installFakePi(behavior: {
	reply?: string;
	exitCode?: number;
	delayMs?: number;
	ignoreTerm?: boolean;
}): { dir: string; callsPath: string; stdinPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-extraction-child-"));
	tempDirs.push(dir);
	const pi = join(dir, "pi");
	const replyFile = join(dir, "event.jsonl");
	// The child runs --mode json: stdout must be JSON event lines. Wrap the
	// reply in a terminal assistant message so the decoder surfaces it as text.
	const event = behavior.reply === undefined
		? ""
		: JSON.stringify({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: behavior.reply }] },
		});
	writeFileSync(replyFile, `${event}\n`);
	const lines = [
		"#!/usr/bin/env bash",
		`printf '%s\n' "$@" >> ${JSON.stringify(join(dir, "calls.log"))}`,
		`cat > ${JSON.stringify(join(dir, "stdin.txt"))}`,
		// Capture the system prompt at spawn time: the runner deletes its temp
		// directory in a finally block before the test can read it.
		'while [ $# -gt 0 ]; do if [ "$1" = "--append-system-prompt" ] && [ -f "$2" ]; then cp "$2" ' + JSON.stringify(join(dir, "system-prompt.md")) + '; fi; shift; done',
	];
	if (behavior.delayMs && behavior.ignoreTerm) {
		lines.push("trap '' TERM", `sleep ${(behavior.delayMs / 1000).toFixed(3)}`);
	} else if (behavior.delayMs) {
		lines.push(`sleep ${(behavior.delayMs / 1000).toFixed(3)}`);
	}
	if (behavior.reply !== undefined) {
		lines.push(`cat ${JSON.stringify(replyFile)}`);
	}
	lines.push(`exit ${behavior.exitCode ?? 0}`);
	writeFileSync(pi, `${lines.join("\n")}\n`);
	chmodSync(pi, 0o755);
	return { dir, callsPath: join(dir, "calls.log"), stdinPath: join(dir, "stdin.txt") };
}

describe("finding extraction subprocess", () => {
	const lane = (passId: string, rawText: string) => ({
		generation: 1, key: `${passId}:0`, passId, tier: "heavy", rawText, exitCode: 1,
		lifecycle: "timed_out" as const, attempts: [], fallbackUsed: false, elapsedMs: 1,
		toolElapsedMs: 0, toolCallCount: 0,
	});
	const input = () => buildExtractionInput("# PR Review\n\n## Findings\nNo findings.\n", [
		lane("correctness", "The reviewer states parseInput crashes on empty input."),
	]);

	test("spawns the no-tools light child with the framed task and returns its JSON", async () => {
		const reply = JSON.stringify({ findings: [] });
		const { dir, callsPath, stdinPath } = installFakePi({ reply });
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		tempDirs.push(dir);
		const previousOverride = routeToFake(dir);
		try {
			const controller = new AbortController();
			const result = await runFindingExtraction(
				{ cwd: dir },
				{ generation: 1, signal: controller.signal },
				input().text,
			);
			expect(result.exitCode).toBe(0);
			expect(result.text).toBe(reply);
			expect(result.effectiveModel).toBeDefined();
			// Argv contract: json print mode, no session, no tools, system prompt file.
			const argv = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).join("\n");
			expect(argv).toContain("--no-tools");
			expect(argv).toContain("--no-approve");
			expect(argv).toContain("--append-system-prompt");
			// The stdin task carries the host framing around the document.
			const stdin = readFileSync(stdinPath, "utf8");
			expect(stdin).toContain("Extract every concrete defect finding stated anywhere in this review document");
			expect(stdin).toContain("--- Review document ---");
			expect(stdin).toContain("parseInput crashes on empty input.");
			// The system prompt file matches the extraction contract.
			const promptText = readFileSync(join(dir, "system-prompt.md"), "utf8");
			expect(promptText).toBe(buildExtractionSystemPrompt());
		} finally {
			process.env.PATH = previousPath;
			overridePiInvocation(undefined);
		}
	});

	test("reports a child failure with exit code and message passthrough", async () => {
		const { dir } = installFakePi({ exitCode: 3 });
		routeToFake(dir);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		try {
			const controller = new AbortController();
			const result = await runFindingExtraction(
				{ cwd: dir },
				{ generation: 1, signal: controller.signal },
				"document",
			);
			expect(result.exitCode).not.toBe(0);
		} finally {
			process.env.PATH = previousPath;
			overridePiInvocation(undefined);
		}
	});

	test("aborts the child through the lease signal", async () => {
		const { dir } = installFakePi({ delayMs: 30_000, ignoreTerm: true });
		routeToFake(dir);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		try {
			const controller = new AbortController();
			// A tight-grace budget keeps the TERM→KILL escalation fast instead
			// of waiting out the 30s ignore-TERM child at default grace.
			const budget = createReviewBudget({
				source: "default",
				warnings: [],
				config: {
					attemptMs: { light: 180_000, medium: 360_000, heavy: 480_000 },
					fallbackAttemptMs: 180_000,
					batchMs: 840_000,
					synthesisMs: 120_000,
					totalMs: 900_000,
					terminationGraceMs: 500,
					cleanupReserveMs: 500,
					minimumFallbackMs: 30_000,
				},
			});
			const promise = runFindingExtraction(
				{ cwd: dir },
				{ generation: 1, signal: controller.signal, budget },
				"document",
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			controller.abort(new Error("review total deadline expired"));
			const result = await promise;
			// Lease revocation terminates the child through the typed-deadline
			// lifecycle: the result reports the abort, never a hang.
			expect(result.timedOut).toBeTrue();
			expect(result.errorMessage).toContain("deadline expired");
		} finally {
			process.env.PATH = previousPath;
			overridePiInvocation(undefined);
		}
	}, 15_000);

	test("rejects oversized child output before parsing", async () => {
		const { dir } = installFakePi({ reply: "x".repeat(600 * 1024) });
		routeToFake(dir);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		try {
			const controller = new AbortController();
			const result = await runFindingExtraction(
				{ cwd: dir },
				{ generation: 1, signal: controller.signal },
				"document",
			);
			expect(result.text).toBe("");
			expect(result.errorMessage).toContain("size cap");
		} finally {
			process.env.PATH = previousPath;
			overridePiInvocation(undefined);
		}
	});

	test("bounds the window by the synthesis budget", async () => {
		const { dir } = installFakePi({ reply: "{}" });
		routeToFake(dir);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		try {
			const controller = new AbortController();
			const budget = createReviewBudget({
				source: "default",
				warnings: [],
				config: {
					attemptMs: { light: 180_000, medium: 360_000, heavy: 480_000 },
					fallbackAttemptMs: 180_000,
					batchMs: 840_000,
					synthesisMs: 25_000,
					totalMs: 900_000,
					terminationGraceMs: 5_000,
					cleanupReserveMs: 5_000,
					minimumFallbackMs: 30_000,
				},
			});
			const result = await runFindingExtraction(
				{ cwd: dir },
				{ generation: 1, signal: controller.signal, budget },
				"document",
			);
			// With a 25s synthesis window the child completes well inside it.
			expect(result.exitCode).toBe(0);
		} finally {
			process.env.PATH = previousPath;
			overridePiInvocation(undefined);
		}
	});
});
