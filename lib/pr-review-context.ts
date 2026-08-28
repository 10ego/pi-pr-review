import * as fs from "node:fs/promises";
import * as path from "node:path";

// Large diffs are transported as read-only file-backed context rather than
// embedded or multiplied into reviewer shards. Keep a hard host memory bound.
export const MAX_REVIEW_CONTEXT_FILE_BYTES = 64 * 1024 * 1024;

export interface LoadedReviewContext {
	context?: string;
	contextFile?: string;
	/** Internal raw text used for deterministic sharding; never exposed in tool details. */
	contextFileText?: string;
	contextFileBytes: number;
}

/** Load a complete diff from disk without echoing it through the orchestrator's tool arguments. */
export async function loadReviewContext(
	cwd: string,
	inlineContext: string | undefined,
	contextFile: string | undefined,
	maxBytes = MAX_REVIEW_CONTEXT_FILE_BYTES,
): Promise<LoadedReviewContext> {
	const inline = inlineContext?.trim();
	if (!contextFile?.trim()) {
		return { context: inline || undefined, contextFileBytes: 0 };
	}

	const resolved = path.resolve(cwd, contextFile.trim());
	const stat = await fs.stat(resolved);
	if (!stat.isFile()) throw new Error(`review context_file is not a regular file: ${contextFile}`);
	if (stat.size <= 0) throw new Error(`review context_file is empty: ${contextFile}`);
	if (stat.size > maxBytes) {
		throw new Error(`review context_file exceeds ${maxBytes} bytes: ${contextFile}`);
	}
	const fileContext = (await fs.readFile(resolved, "utf8")).trim();
	if (!fileContext) throw new Error(`review context_file contains no text: ${contextFile}`);
	const context = inline
		? `${inline}\n\n--- Complete PR diff from context_file ---\n${fileContext}`
		: fileContext;
	return {
		context,
		contextFile: resolved,
		contextFileText: fileContext,
		contextFileBytes: stat.size,
	};
}
