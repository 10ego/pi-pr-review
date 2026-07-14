import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { runSelfReviewRpcSubprocess } from "../lib/pr-self-review-rpc.ts";

const { readFileSync } = fs;

const extension = readFileSync(new URL("../extensions/pr-review-subagent.ts", import.meta.url), "utf8");
const selfReviewRpc = readFileSync(new URL("../lib/pr-self-review-rpc.ts", import.meta.url), "utf8");

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

	test("escalates aborted reviewer children based on observed exit, not signal delivery", () => {
		expect(extension).toContain('proc.kill("SIGTERM")');
		expect(extension).toContain('if (!closed) proc.kill("SIGKILL")');
		expect(extension).not.toContain("if (!proc.killed)");
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
		expect(extension).toContain("parseSelfReviewOutput(attempt.result.text)");
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
		process.env.PI_PR_REVIEW_TEST_API_KEY = "environment-secret";
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
							mode: fs.statSync(agentDir).mode & 0o777,
							initialSettings,
							authIsSymlink: fs.lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink(),
							modelsIsSymlink: fs.lstatSync(path.join(agentDir, "models.json")).isSymbolicLink(),
							storedAuth: JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).test.key,
							envAuth: process.env.PI_PR_REVIEW_TEST_API_KEY,
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
			expect(observed.seen).toEqual(["set_auto_compaction", "set_auto_retry", "prompt"]);
			expect(fs.existsSync(observed.agentDir)).toBe(false);
			expect(fs.readFileSync(path.join(trustedAgentDir, "settings.json"), "utf8")).toBe(sourceSettings);
		} finally {
			if (previousEnvAuth === undefined) delete process.env.PI_PR_REVIEW_TEST_API_KEY;
			else process.env.PI_PR_REVIEW_TEST_API_KEY = previousEnvAuth;
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
			);
			expect(result.exitCode).toBe(1);
			expect(result.errorMessage).toContain("forbidden auto-retry");
			expect(fs.existsSync(result.stderr)).toBe(false);
		} finally {
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
