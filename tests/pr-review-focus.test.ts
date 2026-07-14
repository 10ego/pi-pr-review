import { describe, expect, test } from "bun:test";
import {
	normalizeReviewFocusJsonEvent,
	ReviewFocusRegistry,
	sanitizeReviewFocusText,
} from "../lib/pr-review-focus.ts";

const descriptor = {
	key: "run-1:pass-1",
	label: "correctness",
	tier: "heavy" as const,
};

describe("review focus event normalization", () => {
	test("accepts only assistant text and synthesized tool lifecycle metadata", () => {
		expect(normalizeReviewFocusJsonEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
			assistantMessageEvent: { type: "text_delta", delta: "ial" },
		})).toEqual([{ type: "assistant_snapshot", text: "partial" }]);
		expect(normalizeReviewFocusJsonEvent({
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", delta: "fallback" },
		})).toEqual([{ type: "assistant_delta", text: "fallback" }]);
		expect(normalizeReviewFocusJsonEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		})).toEqual([{ type: "assistant_snapshot", text: "done" }]);
		expect(normalizeReviewFocusJsonEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "SECRET_DIFF" },
		})).toEqual([{ type: "tool_started", toolCallId: "call-1", toolName: "read" }]);
		expect(normalizeReviewFocusJsonEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: "SECRET_DIFF" },
			isError: false,
		})).toEqual([{ type: "tool_ended", toolCallId: "call-1", toolName: "read", isError: false }]);
	});

	test("never retains user prompts, raw args, results, or malformed events", () => {
		const sentinel = "SENTINEL_COMPLETE_DIFF";
		for (const raw of [
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: sentinel }] } },
			{ type: "tool_execution_update", args: { context: sentinel }, partialResult: sentinel },
			{ type: "session", cwd: sentinel },
			{ type: "message_update", message: null },
			null,
			"not an event",
		]) {
			expect(JSON.stringify(normalizeReviewFocusJsonEvent(raw))).not.toContain(sentinel);
			expect(normalizeReviewFocusJsonEvent(raw)).toEqual([]);
		}
	});

	test("removes terminal controls while preserving readable layout", () => {
		expect(sanitizeReviewFocusText("a\u001b[31mred\u001b[0m\rnext\u0000end"))
			.toBe("ared\nnext�end");
	});
});

describe("review focus registry", () => {
	test("publishes immutable snapshots and reconciles streamed assistant text", () => {
		const registry = new ReviewFocusRegistry();
		registry.open(7);
		expect(registry.register(7, descriptor)).toBeTrue();
		expect(registry.publish(7, descriptor.key, { type: "attempt_started", attempt: 1, model: "provider/model" })).toBeTrue();
		registry.publish(7, descriptor.key, { type: "assistant_delta", text: "hel" });
		registry.publish(7, descriptor.key, { type: "assistant_snapshot", text: "hello" });
		registry.publish(7, descriptor.key, { type: "assistant_delta", text: " world" });
		registry.publish(7, descriptor.key, { type: "tool_started", toolCallId: "1", toolName: "read" });
		registry.publish(7, descriptor.key, { type: "tool_ended", toolCallId: "1", toolName: "read", isError: false });
		registry.publish(7, descriptor.key, { type: "completed" });

		expect(registry.snapshot(7)?.passes[0]).toMatchObject({
			label: "correctness",
			status: "completed",
			attempt: 1,
			model: "provider/model",
			assistantText: "hello world",
			tools: [{ name: "read", status: "completed" }],
		});
		expect(registry.publish(7, descriptor.key, { type: "assistant_delta", text: "late" })).toBeFalse();
		expect(registry.snapshot(7)?.passes[0]?.assistantText).toBe("hello world");
	});

	test("clears text and tool activity for deterministic fallback attempts", () => {
		const registry = new ReviewFocusRegistry();
		registry.open(1);
		registry.register(1, descriptor);
		registry.publish(1, descriptor.key, { type: "attempt_started", attempt: 1, model: "first" });
		registry.publish(1, descriptor.key, { type: "assistant_snapshot", text: "first output" });
		registry.publish(1, descriptor.key, { type: "tool_started", toolCallId: "1", toolName: "grep" });
		registry.publish(1, descriptor.key, { type: "retrying" });
		registry.publish(1, descriptor.key, { type: "attempt_started", attempt: 2, model: "fallback" });
		expect(registry.snapshot(1)?.passes[0]).toMatchObject({
			status: "running",
			attempt: 2,
			model: "fallback",
			assistantText: "",
			tools: [],
		});
	});

	test("bounds assistant text by UTF-8 bytes and records eviction", () => {
		const registry = new ReviewFocusRegistry();
		registry.open(1);
		registry.register(1, descriptor);
		registry.publish(1, descriptor.key, { type: "attempt_started", attempt: 1 });
		registry.publish(1, descriptor.key, { type: "assistant_snapshot", text: `prefix-${"🙂".repeat(20_000)}-tail` });
		const pass = registry.snapshot(1)!.passes[0]!;
		expect(Buffer.byteLength(pass.assistantText, "utf8")).toBeLessThanOrEqual(48 * 1024);
		expect(pass.assistantText.endsWith("-tail")).toBeTrue();
		expect(pass.assistantText).not.toContain("prefix-");
		expect(pass.evictedBytes).toBeGreaterThan(0);
	});

	test("notifies subscribers and rejects stale generations synchronously", () => {
		const registry = new ReviewFocusRegistry();
		registry.open(1);
		const seen: Array<number | undefined> = [];
		registry.subscribe(1, (snapshot) => seen.push(snapshot?.sequence));
		registry.register(1, descriptor);
		registry.close(1);
		expect(seen).toEqual([0, 1, undefined]);
		expect(registry.snapshot(1)).toBeUndefined();
		expect(registry.register(1, { ...descriptor, key: "late" })).toBeFalse();

		registry.open(2);
		expect(registry.register(1, descriptor)).toBeFalse();
		expect(registry.snapshot(1)).toBeUndefined();
	});
});
