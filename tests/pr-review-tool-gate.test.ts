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
			Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
			Literal: schema,
			Number: schema,
			Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
				type: "object",
				properties,
				...options,
			}),
			Optional: schema,
			String: schema,
			Union: schema,
		},
	};
});

const registerPrReviewSubagents = (await import("../extensions/pr-review-subagent.ts")).default;
const { ReviewLoopCoordinator } = await import("../lib/pr-review-loop.ts");
const { parsePublishMode, resolveAutoPostSetting } = await import("../lib/pr-review-publish.ts");

function harness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	let activeTools = ["read", "review_subagent", "review_subagents", "pr_review_verify"];
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
	return { tools, commands, coordinator, ctx, activeTools: () => [...activeTools] };
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
});
