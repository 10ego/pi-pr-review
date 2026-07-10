export type ToolPolicy = "none" | "configured";

/** Isolated review subprocesses receive all review context explicitly. */
export function buildReviewBaseArgs(): string[] {
	return ["--mode", "json", "-p", "--no-session", "--no-context-files"];
}

export function normalizeToolPolicy(value: unknown): ToolPolicy | undefined {
	return value === "none" || value === "configured" ? value : undefined;
}

/** Request override wins, then explicit tier config, then legacy configured behavior. */
export function resolveToolPolicy(
	requested: ToolPolicy | undefined,
	configured: ToolPolicy | undefined,
): ToolPolicy {
	return requested ?? configured ?? "configured";
}

/** Preserve legacy configured behavior; only `none` explicitly disables every tool. */
export function appendToolPolicyArgs(
	args: string[],
	policy: ToolPolicy,
	configuredTools: string[],
): string[] {
	if (policy === "none") {
		args.push("--no-tools");
	} else if (configuredTools.length > 0) {
		args.push("--tools", configuredTools.join(","));
	}
	return args;
}
