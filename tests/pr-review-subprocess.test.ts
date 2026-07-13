import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const extension = readFileSync(new URL("../extensions/pr-review-subagent.ts", import.meta.url), "utf8");

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

	test("pipes multi-megabyte review tasks instead of placing them on argv", async () => {
		const input = "x".repeat(2 * 1024 * 1024);
		expect(await countPipedBytes(input)).toBe(Buffer.byteLength(input));
		expect(extension).toContain('stdio: ["pipe", "pipe", "pipe"]');
		expect(extension).toContain('proc.stdin.end(input, "utf8")');
		expect(extension).not.toContain("args.push(buildPassTask(pass.objective, pass.context))");
	});
});
