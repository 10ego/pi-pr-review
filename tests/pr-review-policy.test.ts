import { describe, expect, test } from "bun:test";
import {
	appendToolPolicyArgs,
	buildReviewBaseArgs,
	normalizeToolPolicy,
	resolveToolPolicy,
} from "../lib/pr-review-policy.ts";

describe("tool policy resolution", () => {
	test("request override wins over tier config", () => {
		expect(resolveToolPolicy("none", "configured")).toBe("none");
		expect(resolveToolPolicy("configured", "none")).toBe("configured");
	});

	test("tier config applies when request omits policy", () => {
		expect(resolveToolPolicy(undefined, "none")).toBe("none");
	});

	test("omission preserves legacy configured behavior", () => {
		expect(resolveToolPolicy(undefined, undefined)).toBe("configured");
	});

	test("normalization rejects unknown values", () => {
		expect(normalizeToolPolicy("none")).toBe("none");
		expect(normalizeToolPolicy("configured")).toBe("configured");
		expect(normalizeToolPolicy("auto")).toBeUndefined();
	});
});

describe("tool policy argv", () => {
	test("base args isolate explicit review context", () => {
		expect(buildReviewBaseArgs()).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-context-files",
		]);
	});

	test("none emits explicit --no-tools", () => {
		const args = ["--mode", "json"];
		expect(appendToolPolicyArgs(args, "none", ["read", "bash"])).toEqual([
			"--mode",
			"json",
			"--no-tools",
		]);
	});

	test("configured emits the configured allowlist", () => {
		const args = ["--mode", "json"];
		expect(appendToolPolicyArgs(args, "configured", ["read", "grep"])).toEqual([
			"--mode",
			"json",
			"--tools",
			"read,grep",
		]);
	});

	test("configured with an empty list preserves legacy omitted-flag behavior", () => {
		const args = ["--mode", "json"];
		expect(appendToolPolicyArgs(args, "configured", [])).toEqual(["--mode", "json"]);
	});

	test("one resolved policy can be reused across fallback attempts", () => {
		const policy = resolveToolPolicy("none", "configured");
		const first = appendToolPolicyArgs([], policy, ["read"]);
		const fallback = appendToolPolicyArgs([], policy, ["read"]);
		expect(first).toEqual(["--no-tools"]);
		expect(fallback).toEqual(["--no-tools"]);
	});
});
