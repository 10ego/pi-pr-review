import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options: Record<string, unknown> = {}) => ({ enum: values, ...options }),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/tmp/pi-pr-review-subprocess-agent",
	getSelectListTheme: () => ({}),
	getSettingsListTheme: () => ({}),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class {},
	fuzzyFilter: (items: unknown[]) => items,
	getKeybindings: () => ({ matches: () => false }),
	Input: class {},
	SelectList: class {},
	SettingsList: class {},
	Text: class {},
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

const { runReviewSubprocess } = await import("../extensions/pr-review-subagent.ts");
const { combineAbortSignals, reviewDeadlineError } = await import("../lib/pr-review-loop.ts");
const { runSelfReviewRpcSubprocess } = await import("../lib/pr-self-review-rpc.ts");

const { readFileSync } = fs;

const extension = readFileSync(new URL("../extensions/pr-review-subagent.ts", import.meta.url), "utf8");
const selfReviewRpc = readFileSync(new URL("../lib/pr-self-review-rpc.ts", import.meta.url), "utf8");

function privateAgentDir(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.chmodSync(directory, 0o700);
	return directory;
}

function countPipedBytes(input: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const script = [
			"let bytes = 0;",
			'process.stdin.on("data", chunk => bytes += chunk.length);',
			'process.stdin.on("end", () => process.stdout.write(String(bytes)));',
		].join("");
		const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => stdout += chunk);
		child.stderr.on("data", chunk => stderr += chunk);
		child.stdin.on("error", reject);
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve(Number(stdout)) : reject(new Error(stderr || `exit ${code}`)));
		child.stdin.end(input, "utf8");
	});
}

describe("review subprocess policy and task transport", () => {
	test("applies major-only severity filtering without a heavy-tier gate", () => {
		expect(extension).toContain("pass.majorOnly === true");
		expect(extension).not.toContain('pass.majorOnly && pass.tier === "heavy"');
	});

	test("escalates aborted reviewer process groups based on observed settlement", () => {
		expect(extension).toContain("process.kill(-processGroupId, processSignal)");
		expect(extension).toContain('signalProcess("SIGTERM")');
		expect(extension).toContain('signalProcess("SIGKILL")');
		expect(extension).not.toContain("if (!proc.killed)");
	});

	test("kills reviewer tool descendants after the Pi leader exits on timeout", async () => {
		if (process.platform === "win32") return;
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-lane-group-"));
		const pidFile = path.join(directory, "descendant.pid");
		const marker = path.join(directory, "descendant-survived");
		const descendantScript = [
			'const fs = require("node:fs");',
			'process.on("SIGTERM", () => {});',
			`setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 600);`,
			"setInterval(() => {}, 1000);",
		].join("");
		const leaderScript = [
			'const { spawn } = require("node:child_process");',
			`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
			`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"child.unref();",
			'process.on("SIGTERM", () => process.exit(0));',
			"setInterval(() => {}, 1000);",
		].join("");
		try {
			const result = await runReviewSubprocess(
				process.execPath,
				["-e", leaderScript],
				process.cwd(),
				"review task",
				undefined,
				() => {},
				undefined,
				{ deadlineMs: performance.now() + 200, terminationGraceMs: 50, cleanupReserveMs: 200 },
			);
			expect(result.timedOut).toBeTrue();
			expect(result.forcedTermination).toBeTrue();
			await new Promise((resolve) => setTimeout(resolve, 650));
			expect(fs.existsSync(marker)).toBeFalse();
			const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
			expect(() => process.kill(descendantPid, 0)).toThrow();
		} finally {
			try {
				const pid = Number(fs.readFileSync(pidFile, "utf8"));
				if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
			} catch {}
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test("discloses the host deadline that ended a lane instead of its attempt deadline", async () => {
		if (process.platform === "win32") return;
		const controller = new AbortController();
		// The lane execution signal is combined from the loop lease signal.
		const executionSignal = combineAbortSignals(controller.signal, undefined);
		const script = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);';
		const resultPromise = runReviewSubprocess(
			process.execPath,
			["-e", script],
			process.cwd(),
			"review task",
			executionSignal,
			() => {},
			undefined,
			{ deadlineMs: performance.now() + 10_000, terminationGraceMs: 50, cleanupReserveMs: 200 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort(reviewDeadlineError("synthesis"));
		const result = await resultPromise;
		expect(result.timedOut).toBeTrue();
		expect(result.stopReason).toBe("timeout");
		expect(result.deadlineExpired).toBe("synthesis");
		expect(result.errorMessage).toBe("Review synthesis deadline expired while this lane was still running.");
	});

	test("an attempt timeout that already began termination is not relabeled by a later host abort", async () => {
		if (process.platform === "win32") return;
		const controller = new AbortController();
		// Trap TERM so the drain stays open long enough for the late abort to land.
		const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
		const resultPromise = runReviewSubprocess(
			process.execPath,
			["-e", script],
			process.cwd(),
			"review task",
			controller.signal,
			() => {},
			undefined,
			{ deadlineMs: performance.now() + 150, terminationGraceMs: 400, cleanupReserveMs: 400 },
		);
		// The attempt deadline terminates at ~150ms; abort mid-drain at ~300ms.
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort(reviewDeadlineError("synthesis"));
		const result = await resultPromise;
		expect(result.timedOut).toBeTrue();
		expect(result.stopReason).toBe("timeout");
		expect(result.deadlineExpired).toBeUndefined();
		expect(result.errorMessage).toBe("Review attempt exceeded its host deadline.");
	});

	test("keeps a plain user abort distinct from host deadline timeouts", async () => {
		if (process.platform === "win32") return;
		const controller = new AbortController();
		const script = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);';
		const resultPromise = runReviewSubprocess(
			process.execPath,
			["-e", script],
			process.cwd(),
			"review task",
			controller.signal,
			() => {},
			undefined,
			{ deadlineMs: performance.now() + 10_000, terminationGraceMs: 50, cleanupReserveMs: 200 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort(new Error("user cancelled"));
		const result = await resultPromise;
		expect(result.stopReason).toBe("aborted");
		expect(result.deadlineExpired).toBeUndefined();
		expect(result.timedOut).toBeUndefined();
	});

	test("does not ask a model to serialize a GitHub review payload", () => {
		expect(extension).not.toContain("prepareReviewOutputGhPayload");
		expect(extension).not.toContain("GH_FALLBACK_PAYLOAD_SYSTEM_PROMPT");
		expect(extension).not.toContain('{\\"commit_id\\":\\"<host-supplied reviewed head>\\"');
	});

	test("self-review has one fixed heavy no-tools RPC attempt with retry and compaction disabled first", () => {
		const start = extension.indexOf("async function runSelfReviewAttempt");
		const end = extension.indexOf("async function runSubagentPass", start);
		const selfAttempt = extension.slice(start, end);
		expect(selfAttempt).toContain("config.tiers.heavy");
		expect(selfAttempt).toContain('"--no-tools", "--no-approve"');
		expect(selfAttempt).toContain("buildReviewBaseArgs()");
		expect(selfAttempt).toContain('args[args.indexOf("json")] = "rpc"');
		expect(selfAttempt).toContain("runSelfReviewRpcSubprocess");
		expect(selfAttempt).not.toContain("resolveModelAttempts");
		expect(selfAttempt).not.toContain("runWithConcurrency");
		expect(selfAttempt).not.toContain("isRetryableModelFailure");
		expect(selfReviewRpc).toContain('type: "set_auto_compaction", enabled: false');
		expect(selfReviewRpc).toContain('type: "set_auto_retry", enabled: false');
		expect(selfReviewRpc).toContain('event.type === "auto_retry_start" || event.type === "compaction_start"');
		expect(extension).toContain("parseSelfReviewOutput(attempt.result.text, captured.anchors)");
		expect(selfReviewRpc).toContain("SELF_REVIEW_RPC_TOTAL_TIMEOUT_MS");
		expect(extension).toContain("attempts: 1");
		expect(extension).toContain("fallbackUsed: false");
		expect(extension).toContain("P0, P1, or P2 findings");
	});

	test("isolates child settings and preserves trusted config bytes and environment auth", async () => {
		const trustedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-trusted-agent-"));
		fs.chmodSync(trustedAgentDir, 0o700);
		const sourceSettings = '{\n  "theme": "dark",\n  "retry": { "enabled": true, "maxRetries": 9 },\n  "compaction": { "enabled": true, "reserveTokens": 1234 }\n}\n';
		fs.writeFileSync(path.join(trustedAgentDir, "settings.json"), sourceSettings, { mode: 0o600 });
		fs.writeFileSync(path.join(trustedAgentDir, "auth.json"), '{"test":{"key":"stored-secret"}}\n', { mode: 0o600 });
		fs.writeFileSync(path.join(trustedAgentDir, "models.json"), '{"providers":{}}\n', { mode: 0o600 });
		const previousEnvAuth = process.env.PI_PR_REVIEW_TEST_API_KEY;
		const previousNodeOptions = process.env.NODE_OPTIONS;
		const previousBunOptions = process.env.BUN_OPTIONS;
		process.env.PI_PR_REVIEW_TEST_API_KEY = "environment-secret";
		process.env.NODE_OPTIONS = "--no-warnings";
		process.env.BUN_OPTIONS = "--no-warnings";
		try {
			const childScript = String.raw`
				const fs = require("node:fs");
				const path = require("node:path");
				const readline = require("node:readline");
				const seen = [];
				const agentDir = process.env.PI_CODING_AGENT_DIR;
				const settingsPath = path.join(agentDir, "settings.json");
				const initialSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
				const out = value => process.stdout.write(JSON.stringify(value) + "\n");
				readline.createInterface({ input: process.stdin }).on("line", line => {
					const command = JSON.parse(line);
					seen.push(command.type);
					if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") {
						const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
						const key = command.type === "set_auto_compaction" ? "compaction" : "retry";
						current[key] = { ...(current[key] || {}), enabled: command.enabled };
						fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2));
						out({ id: command.id, type: "response", command: command.type, success: true });
					}
					if (command.type === "prompt") {
						out({ id: command.id, type: "response", command: command.type, success: true });
						out({ type: "agent_start" });
						out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [] }) }], stopReason: "stop" } });
						out({ type: "agent_end", messages: [], willRetry: false });
						process.stderr.write(JSON.stringify({
							agentDir,
							canonicalAgentDir: fs.realpathSync(agentDir),
							mode: fs.statSync(agentDir).mode & 0o777,
							initialSettings,
							authIsSymlink: fs.lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink(),
							modelsIsSymlink: fs.lstatSync(path.join(agentDir, "models.json")).isSymbolicLink(),
							storedAuth: JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).test.key,
							envAuth: process.env.PI_PR_REVIEW_TEST_API_KEY,
							cwd: process.cwd(),
							nodeOptionsPresent: Object.hasOwn(process.env, "NODE_OPTIONS"),
							bunOptionsPresent: Object.hasOwn(process.env, "BUN_OPTIONS"),
							seen,
						}));
						out({ type: "agent_settled" });
					}
				});
			`;
			const result = await runSelfReviewRpcSubprocess(
				process.execPath,
				["-e", childScript],
				process.cwd(),
				"review task",
				undefined,
				trustedAgentDir,
			);
			const observed = JSON.parse(result.stderr);
			expect(result.exitCode).toBe(0);
			expect(result.text).toBe('{"findings":[]}');
			expect(observed.agentDir).not.toBe(trustedAgentDir);
			expect(observed.mode).toBe(0o700);
			expect(observed.initialSettings.retry).toEqual({ enabled: false, maxRetries: 9 });
			expect(observed.initialSettings.compaction).toEqual({ enabled: false, reserveTokens: 1234 });
			expect(observed.authIsSymlink).toBe(true);
			expect(observed.modelsIsSymlink).toBe(true);
			expect(observed.storedAuth).toBe("stored-secret");
			expect(observed.envAuth).toBe("environment-secret");
			expect(observed.cwd).toBe(observed.canonicalAgentDir);
			expect(observed.nodeOptionsPresent).toBe(false);
			expect(observed.bunOptionsPresent).toBe(false);
			expect(observed.seen).toEqual(["set_auto_compaction", "set_auto_retry", "prompt"]);
			expect(fs.existsSync(observed.agentDir)).toBe(false);
			expect(fs.readFileSync(path.join(trustedAgentDir, "settings.json"), "utf8")).toBe(sourceSettings);
		} finally {
			if (previousEnvAuth === undefined) delete process.env.PI_PR_REVIEW_TEST_API_KEY;
			else process.env.PI_PR_REVIEW_TEST_API_KEY = previousEnvAuth;
			if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previousNodeOptions;
			if (previousBunOptions === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previousBunOptions;
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("fails closed on malformed or unsafe trusted configuration", async () => {
		const malformedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-malformed-agent-"));
		fs.chmodSync(malformedDir, 0o700);
		fs.writeFileSync(path.join(malformedDir, "settings.json"), '{"retry":', { mode: 0o600 });
		try {
			await expect(runSelfReviewRpcSubprocess(process.execPath, ["-e", ""], process.cwd(), "task", undefined, malformedDir))
				.rejects.toThrow("malformed JSON");
		} finally {
			fs.rmSync(malformedDir, { recursive: true, force: true });
		}

		const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-symlink-agent-"));
		fs.chmodSync(symlinkDir, 0o700);
		const externalSettings = path.join(symlinkDir, "external-settings.json");
		fs.writeFileSync(externalSettings, "{}", { mode: 0o600 });
		fs.symlinkSync(externalSettings, path.join(symlinkDir, "settings.json"));
		try {
			await expect(runSelfReviewRpcSubprocess(process.execPath, ["-e", ""], process.cwd(), "task", undefined, symlinkDir))
				.rejects.toThrow("must not be a symbolic link");
		} finally {
			fs.rmSync(symlinkDir, { recursive: true, force: true });
		}
	});

	test("fails closed on a forbidden child retry lifecycle event", async () => {
		const childScript = String.raw`
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
					process.stderr.write(process.env.PI_CODING_AGENT_DIR);
					out({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "retry" });
				}
			});
		`;
		const trustedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-retry-agent-"));
		fs.chmodSync(trustedAgentDir, 0o700);
		try {
			const result = await runSelfReviewRpcSubprocess(
				process.execPath,
				["-e", childScript],
				process.cwd(),
				"review task",
				undefined,
				trustedAgentDir,
				{ killGraceMs: 20, drainMs: 100 },
			);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("forbidden auto-retry");
			expect(fs.existsSync(result.stderr)).toBe(false);
		} finally {
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("bounds total RPC runtime after prompt startup with an injectable test timeout", async () => {
		const childScript = String.raw`
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
				}
			});
		`;
		const trustedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-timeout-agent-"));
		fs.chmodSync(trustedAgentDir, 0o700);
		try {
			const startedAt = Date.now();
			const result = await runSelfReviewRpcSubprocess(
				process.execPath,
				["-e", childScript],
				process.cwd(),
				"review task",
				undefined,
				trustedAgentDir,
				{ totalTimeoutMs: 50, killGraceMs: 20, drainMs: 100 },
			);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("total runtime exceeded 50ms");
			expect(Date.now() - startedAt).toBeLessThan(2000);
		} finally {
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("fails when a settled child exits by signal without host termination", async () => {
		const childScript = String.raw`
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
					out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\"findings\":[]}" }], stopReason: "stop" } });
					out({ type: "agent_settled" });
					process.stdout.write("", () => process.kill(process.pid, "SIGTERM"));
				}
			});
		`;
		const trustedAgentDir = privateAgentDir("pi-pr-review-signaled-agent-");
		try {
			const result = await runSelfReviewRpcSubprocess(process.execPath, ["-e", childScript], process.cwd(), "task", undefined, trustedAgentDir);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("SIGTERM");
		} finally {
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("uses monotonic grace timing when the process group disappears after a backward wall-clock jump", async () => {
		const childScript = String.raw`
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
				}
			});
		`;
		const trustedAgentDir = privateAgentDir("pi-pr-review-grace-agent-");
		const originalDateNow = Date.now;
		let wallClock = originalDateNow();
		Date.now = () => wallClock -= 60_000;
		try {
			const startedAt = process.hrtime.bigint();
			const result = await runSelfReviewRpcSubprocess(
				process.execPath,
				["-e", childScript],
				process.cwd(),
				"task",
				undefined,
				trustedAgentDir,
				{ totalTimeoutMs: 50, killGraceMs: 1000, drainMs: 100 },
			);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("total runtime exceeded 50ms");
			const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
			expect(elapsedMs).toBeLessThan(500);
		} finally {
			Date.now = originalDateNow;
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("reconstructs split JSON from every text part of the final assistant message", async () => {
		const childScript = String.raw`
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
					out({ type: "message_end", message: { role: "assistant", content: [
						{ type: "text", text: "{\"find" },
						{ type: "thinking", text: "ignored" },
						{ type: "text", text: "ings\":[]}" },
					], stopReason: "stop" } });
					out({ type: "agent_settled" });
				}
			});
		`;
		const trustedAgentDir = privateAgentDir("pi-pr-review-split-agent-");
		try {
			const result = await runSelfReviewRpcSubprocess(process.execPath, ["-e", childScript], process.cwd(), "task", undefined, trustedAgentDir);
			expect(result.exitCode).toBe(0);
			expect(result.text).toBe('{"findings":[]}');
		} finally {
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("fails closed incrementally on newline-free stdout and stderr overflow", async () => {
		for (const overflow of ["stdout", "stderr"] as const) {
			const childScript = overflow === "stdout"
				? `process.stdout.write("x".repeat(1024)); setInterval(() => {}, 1000);`
				: `process.stderr.write("x".repeat(1024)); setInterval(() => {}, 1000);`;
			const trustedAgentDir = privateAgentDir(`pi-pr-review-${overflow}-agent-`);
			try {
				const result = await runSelfReviewRpcSubprocess(
					process.execPath,
					["-e", childScript],
					process.cwd(),
					"task",
					undefined,
					trustedAgentDir,
					{ stdoutMaxBytes: 64, stderrMaxBytes: 64, killGraceMs: 20, drainMs: 100, totalTimeoutMs: 1000 },
				);
				expect(result.exitCode).toBe(1);
				expect(result.errorMessage).toContain(`${overflow} exceeded the 64-byte safety limit`);
			} finally {
				fs.rmSync(trustedAgentDir, { recursive: true, force: true });
			}
		}
	});

	test("kills a detached process group when a descendant retains inherited stdio", async () => {
		const trustedAgentDir = privateAgentDir("pi-pr-review-descendant-agent-");
		const marker = path.join(os.tmpdir(), `pi-pr-review-descendant-${process.pid}-${Date.now()}.pid`);
		const childScript = `
			const { spawn } = require("node:child_process");
			const readline = require("node:readline");
			const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				if (command.type === "set_auto_compaction" || command.type === "set_auto_retry") out({ id: command.id, type: "response", command: command.type, success: true });
				if (command.type === "prompt") {
					out({ id: command.id, type: "response", command: command.type, success: true });
					out({ type: "agent_start" });
					const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
						process.on("SIGTERM", () => {});
						setInterval(() => {}, 1000);
					`)}], { stdio: "inherit" });
					require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(descendant.pid));
					descendant.unref();
					out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\\\"findings\\\":[]}" }], stopReason: "stop" } });
					out({ type: "agent_settled" });
				}
			});
		`;
		try {
			const startedAt = Date.now();
			const result = await runSelfReviewRpcSubprocess(
				process.execPath,
				["-e", childScript],
				process.cwd(),
				"task",
				undefined,
				trustedAgentDir,
				{ totalTimeoutMs: 2000, killGraceMs: 20, drainMs: 200 },
			);
			expect(Date.now() - startedAt).toBeLessThan(1500);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("descendants retained its process group");
			const descendantPid = Number(fs.readFileSync(marker, "utf8"));
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try {
					process.kill(descendantPid, 0);
					await new Promise((resolve) => setTimeout(resolve, 5));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		} finally {
			try {
				const pid = Number(fs.readFileSync(marker, "utf8"));
				if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
			} catch {}
			fs.rmSync(marker, { force: true });
			fs.rmSync(trustedAgentDir, { recursive: true, force: true });
		}
	});

	test("pipes multi-megabyte review tasks instead of placing them on argv", async () => {
		const input = "x".repeat(2 * 1024 * 1024);
		expect(await countPipedBytes(input)).toBe(Buffer.byteLength(input));
		expect(extension).toContain('stdio: ["pipe", "pipe", "pipe"]');
		expect(extension).toContain('proc.stdin.end(input, "utf8")');
		expect(extension).not.toContain("args.push(buildPassTask(pass.objective, pass.context))");
	});
});
