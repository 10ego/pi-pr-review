import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveReviewDeadlines, type DeadlineResolution } from "./pr-review-deadlines.ts";

const CONFIG_FILENAME = "pr-review.json";

function readDeadlineObject(filePath: string): { value?: unknown; malformed: boolean } {
	try {
		if (!fs.existsSync(filePath)) return { malformed: false };
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { malformed: true };
		return { value: (parsed as Record<string, unknown>).deadlines, malformed: false };
	} catch {
		return { malformed: true };
	}
}

/** Read the shared review deadline overlay without exposing model/tool configuration. */
export function resolveReviewDeadlinesForContext(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): DeadlineResolution {
	const user = readDeadlineObject(path.join(getAgentDir(), CONFIG_FILENAME));
	let project: ReturnType<typeof readDeadlineObject> = { malformed: false };
	try {
		if (ctx.isProjectTrusted()) project = readDeadlineObject(path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME));
	} catch {
		// User configuration remains authoritative when trust cannot be established.
	}
	const resolution = resolveReviewDeadlines(user.value, project.value);
	if (user.malformed) resolution.warnings.unshift("user pr-review.json was malformed; default deadlines were retained");
	if (project.malformed) resolution.warnings.push("project pr-review.json was malformed; its deadline overlay was ignored");
	return resolution;
}
