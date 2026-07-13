import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: () => ({}),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/tmp/pi-pr-review-tool-gate-agent",
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
	const schema = () => ({});
	return {
		Type: {
			Array: schema,
			Boolean: schema,
			Integer: schema,
			Literal: schema,
			Number: schema,
			Object: schema,
			Optional: schema,
			String: schema,
			Union: schema,
		},
	};
});

const registerPrReviewSubagents = (await import("../extensions/pr-review-subagent.ts")).default;

function harness() {
	const tools = new Map<string, any>();
	let activeTools = ["read", "review_subagent", "review_subagents", "pr_review_verify"];
	const pi = {
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
	};
	registerPrReviewSubagents(pi as any);
	const ctx = {
		cwd: "/tmp/repo",
		sessionManager: {
			getSessionId: () => "session-1",
			getHeader: () => ({ id: "session-1", timestamp: "2026-07-13T00:00:00.000Z" }),
		},
	};
	return { tools, ctx };
}

describe("review tool execution gate", () => {
	test("all review tools fail before processing parameters outside /pr-review", async () => {
		const h = harness();
		for (const name of ["review_subagent", "review_subagents", "pr_review_verify"]) {
			const result = await h.tools.get(name).execute("call-1", {}, undefined, undefined, h.ctx);
			expect(result.isError).toBeTrue();
			expect(result.details).toEqual({ authorized: false });
			expect(result.content[0].text).toContain("active user-initiated /pr-review loop");
		}
	});
});
