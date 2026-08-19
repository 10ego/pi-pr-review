export type ReviewLaneLifecycle = "complete" | "partial" | "timed_out" | "failed";

export interface ReviewLaneAttemptArtifact {
	readonly ordinal: number;
	readonly kind: "primary" | "fallback" | "nearest" | "default";
	readonly requestedModel?: string;
	readonly observedModel?: string;
	readonly usedTier?: "light" | "medium" | "heavy";
	readonly rawText: string;
	readonly exitCode: number;
	readonly processSignal?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly lifecycle: ReviewLaneLifecycle;
	readonly retryable: boolean;
	readonly elapsedMs: number;
	readonly firstEventMs?: number;
	readonly firstAssistantMs?: number;
	readonly toolElapsedMs: number;
	readonly toolCallCount: number;
	readonly timedOut?: boolean;
	readonly terminationGraceMs?: number;
	readonly forcedTermination?: boolean;
	/** Effective runtime allowance after batch/total truncation. */
	readonly deadlineMs?: number;
	/** Configured tier/fallback cap before batch/total truncation. */
	readonly configuredDeadlineMs?: number;
}

export interface ReviewLaneArtifact {
	readonly generation: number;
	readonly key: string;
	readonly passId: string;
	/** Zero-based order assigned from the host's requested pass list. */
	readonly requestedPassOrdinal?: number;
	readonly tier: "light" | "medium" | "heavy";
	readonly requestedModel?: string;
	readonly observedModel?: string;
	readonly rawText: string;
	readonly exitCode: number;
	readonly processSignal?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly lifecycle: ReviewLaneLifecycle;
	readonly attempts: readonly ReviewLaneAttemptArtifact[];
	readonly fallbackUsed: boolean;
	readonly elapsedMs: number;
	readonly firstEventMs?: number;
	readonly firstAssistantMs?: number;
	readonly toolElapsedMs: number;
	readonly toolCallCount: number;
	readonly startOffsetMs?: number;
	readonly endOffsetMs?: number;
	readonly fallbackBudgetRejected?: boolean;
	readonly deadlineSource?: "default" | "user" | "project";
	readonly batchDeadlineMs?: number;
	readonly totalDeadlineMs?: number;
}

/** Concatenate every text part from the authoritative final assistant message. */
export function finalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const assistant = message as { role?: unknown; content?: unknown };
		if (assistant.role !== "assistant") continue;
		if (!Array.isArray(assistant.content)) return "";
		return assistant.content
			.filter((part): part is { type: "text"; text: string } =>
				!!part && typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export interface ReviewLaneCompletionInput {
	readonly tier: "light" | "medium" | "heavy";
	readonly rawText: string;
	readonly exitCode: number;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly minorHygiene?: boolean;
	readonly expectedOutput?: "review_lane" | "nonempty";
}

function hasMeaningfulLightSection(text: string, field: string, fields: readonly string[]): boolean {
	const escapedFields = fields.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const heading = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?${field}[ \\t]*:?[ \\t]*(.*)\\r?$`, "im").exec(text);
	if (!heading || heading.index === undefined) return false;
	const inlineValue = heading[1] ?? "";
	const bodyStart = heading.index + heading[0].length;
	const nextHeading = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:${escapedFields})[ \\t]*:?[ \\t]*`, "im").exec(text.slice(bodyStart));
	const body = nextHeading ? text.slice(bodyStart, bodyStart + nextHeading.index) : text.slice(bodyStart);
	return `${inlineValue}\n${body}`
		.split("\n")
		.some((line) => line.replace(/^[ \\t]*(?:[-*>][ \\t]*)+/, "").trim().length > 0);
}

function hasMeaningfulField(text: string, field: string): boolean {
	const match = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${field}[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im").exec(text);
	return !!match?.[1]?.trim();
}

function expectedLaneSections(input: ReviewLaneCompletionInput): boolean {
	const text = input.rawText.trim();
	if (!text) return false;
	if (input.expectedOutput === "nonempty") return true;
	if (input.tier === "light") {
		const fields = input.minorHygiene ? ["overview", "strengths", "minor candidates"] : ["overview", "strengths"];
		return fields.every((field) => hasMeaningfulLightSection(text, field, fields));
	}
	if (text === "NO FINDINGS.") return true;
	return ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"]
		.every((field) => hasMeaningfulField(text, field));
}

/** Process exit is necessary but insufficient: only a terminal stop with valid lane output is complete. */
export function classifyReviewLane(input: ReviewLaneCompletionInput): ReviewLaneLifecycle {
	const reason = input.stopReason?.toLowerCase();
	const error = input.errorMessage?.toLowerCase();
	if (reason?.includes("timeout") || error?.includes("timed out") || error?.includes("timeout")) return "timed_out";
	const hasText = input.rawText.length > 0;
	if (input.exitCode === 0 && reason === "stop" && expectedLaneSections(input)) return "complete";
	return hasText ? "partial" : "failed";
}

/** Invocation-scoped, host-owned artifact storage. The review coordinator owns its lifetime. */
export class ReviewLaneArtifactRegistry {
	private generation?: number;
	private readonly artifacts = new Map<string, ReviewLaneArtifact>();
	private readonly expectedKeys = new Set<string>();

	open(generation: number): void {
		this.close();
		this.generation = generation;
	}

	expect(generation: number, keys: readonly string[]): boolean {
		if (this.generation !== generation || keys.length === 0 || keys.some((key) => !key)) return false;
		for (const key of keys) this.expectedKeys.add(key);
		return true;
	}

	expectedCount(generation: number): number | undefined {
		return this.generation === generation ? this.expectedKeys.size : undefined;
	}

	retain(generation: number, artifact: ReviewLaneArtifact): boolean {
		if (this.generation !== generation || artifact.generation !== generation) return false;
		this.artifacts.set(artifact.key, Object.freeze({
			...artifact,
			attempts: Object.freeze(artifact.attempts.map((attempt) => Object.freeze({ ...attempt }))),
		}));
		return true;
	}

	snapshot(generation: number): readonly ReviewLaneArtifact[] | undefined {
		if (this.generation !== generation) return undefined;
		return Object.freeze([...this.artifacts.values()].sort((left, right) => {
			const leftOrdinal = left.requestedPassOrdinal ?? Number.MAX_SAFE_INTEGER;
			const rightOrdinal = right.requestedPassOrdinal ?? Number.MAX_SAFE_INTEGER;
			return leftOrdinal - rightOrdinal || left.key.localeCompare(right.key, "en", { numeric: true });
		}));
	}

	close(generation?: number): void {
		if (generation !== undefined && this.generation !== generation) return;
		this.artifacts.clear();
		this.expectedKeys.clear();
		this.generation = undefined;
	}
}
