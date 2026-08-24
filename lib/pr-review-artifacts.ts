import type { ReviewDeadlineKind } from "./pr-review-deadlines.ts";

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
	/** Host total/synthesis deadline that ended this attempt, when it caused termination. */
	readonly deadlineExpired?: ReviewDeadlineKind;
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

export interface ExpectedReviewLane {
	readonly key: string;
	readonly tier: "light" | "medium" | "heavy";
	readonly minorHygiene: boolean;
	/** Completion contract captured at dispatch so cache-restore revalidates identically. */
	readonly expectedOutput?: "review_lane" | "nonempty";
}

export interface ReviewLaneArtifact {
	readonly generation: number;
	readonly key: string;
	readonly passId: string;
	/** Zero-based order assigned from the host's requested pass list. */
	readonly requestedPassOrdinal?: number;
	readonly tier: "light" | "medium" | "heavy";
	readonly minorHygiene?: boolean;
	readonly requestedModel?: string;
	readonly observedModel?: string;
	readonly rawText: string;
	readonly exitCode: number;
	readonly processSignal?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly lifecycle: ReviewLaneLifecycle;
	/** Host total/synthesis deadline that ended this lane, when it caused termination. */
	readonly deadlineExpired?: ReviewDeadlineKind;
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

/**
 * Review-output refusal signals are deliberately scoped to review access and
 * completion, rather than matching generic inability language. A finding such
 * as "the refresh path is unable to renew a token" is valid evidence and must
 * not downgrade an otherwise complete lane.
 */
const REVIEW_REFUSAL_SIGNALS = [
	/\b(?:i|we|the reviewer|the review agent|the review model)\s+(?:could not|couldn'?t|cannot|can'?t|am unable to|are unable to|was unable to|were unable to|failed to|am not able to|are not able to|wasn'?t able to|weren'?t able to)\s+(?:review|inspect|analy[sz]e|evaluate|examine|assess|conduct|complete)\b/i,
	/(?:^|[\n.!?:;,])\s*(?:could not|couldn'?t|cannot|can'?t|unable to|failed to|was unable to|were unable to|am unable to|are unable to|wasn'?t able to|weren'?t able to)\s+(?:review|inspect|analy[sz]e|evaluate|examine|assess|conduct|complete)\b/i,
	/\b(?:i|we|the reviewer|the review agent|the review model)\s+(?:could not|couldn'?t|cannot|can'?t|am unable to|are unable to|was unable to|were unable to|failed to|am not able to|are not able to|wasn'?t able to|weren'?t able to)\s+(?:access|read|inspect|examine|retrieve|obtain|load)\s+(?:the\s+)?(?:diff|patch|changes?|pull request|pr\b|repository|repo(?:sitory)?|changed files?|review context)\b/i,
	/\b(?:the|this)\s+(?:review|reviewer|review agent|review model)\s+(?:could not|couldn'?t|cannot|can'?t|am unable to|are unable to|was unable to|were unable to|failed to|am not able to|are not able to|wasn'?t able to|weren'?t able to)\s+(?:access|read|inspect|examine|retrieve|obtain|load|complete)\b/i,
	/(?:^|[\n.!?:;,])\s*(?:could not|couldn'?t|cannot|can'?t|unable to|failed to|was unable to|were unable to|am unable to|are unable to|wasn'?t able to|weren'?t able to)\s+(?:access|read|inspect|examine|retrieve|obtain|load)\s+(?:the\s+)?(?:diff|patch|changes?|pull request|pr\b|repository|repo(?:sitory)?|changed files?|review context)\b/i,
	/\b(?:no\s+(?:diff|patch|review context)\s+(?:(?:was|were)\s+)?(?:provided|available|accessible)|nothing\s+to\s+review)\b/i,
	/\b(?:diff|patch|review context)\s+(?:was|were)\s+(?:not\s+)?(?:provided|available|accessible)\b/i,
	/\bchanges?\s+(?:was|were)\s+not\s+provided\b/i,
	/\b(?:review|analysis|assessment)\s+(?:failed|was not possible|is unavailable|could not be completed)\b/i,
] as const;

function hasSubstantiveProse(text: string): boolean {
	const words = text.match(/[A-Za-z]{2,}/g) ?? [];
	return words.length >= 2 || words.some((word) => new Set(word.toLowerCase()).size > 1);
}

function hasReviewRefusalSignal(text: string): boolean {
	return REVIEW_REFUSAL_SIGNALS.some((signal) => signal.test(text));
}

function hasMeaningfulField(text: string, field: string): boolean {
	const match = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${field}[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im").exec(text);
	return !!match?.[1]?.trim();
}

function hasMeaningfulNonemptyField(text: string, field: string): boolean {
	const match = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${field}[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im").exec(text);
	return !!match?.[1]?.trim() && hasSubstantiveProse(match[1]!);
}

function expectedLaneSections(input: ReviewLaneCompletionInput): boolean {
	const text = input.rawText.trim();
	if (!text) return false;
	// The nonempty contract accepts framing prose around findings, but not
	// degenerate refusals: check refusal language anywhere first, then accept
	// candidate evidence or a substantive statement.
	if (input.expectedOutput === "nonempty") {
		if (hasReviewRefusalSignal(text)) return false;
		if (["title", "why", "overview"].some((field) => hasMeaningfulNonemptyField(text, field))) return true;
		// Do not let arbitrary bytes satisfy the contract: prose must contain
		// at least two words (or one varied word) in addition to minimum length.
		return text.length >= 16 && hasSubstantiveProse(text) && /\s/.test(text);
	}
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
	private readonly expectedLanes = new Map<string, ExpectedReviewLane>();

	open(generation: number): void {
		this.close();
		this.generation = generation;
	}

	expect(generation: number, lanes: readonly ExpectedReviewLane[]): boolean {
		if (
			this.generation !== generation || lanes.length === 0 ||
			lanes.some((lane) => !lane.key || !new Set(["light", "medium", "heavy"]).has(lane.tier) ||
				(lane.expectedOutput !== undefined && !new Set(["review_lane", "nonempty"]).has(lane.expectedOutput)))
		) return false;
		for (const lane of lanes) {
			const existing = this.expectedLanes.get(lane.key);
			if (existing && (
				existing.tier !== lane.tier ||
				existing.minorHygiene !== lane.minorHygiene ||
				(existing.expectedOutput ?? "review_lane") !== (lane.expectedOutput ?? "review_lane")
			)) return false;
			this.expectedLanes.set(lane.key, Object.freeze({ ...lane }));
		}
		return true;
	}

	expectedCount(generation: number): number | undefined {
		return this.generation === generation ? this.expectedLanes.size : undefined;
	}

	expected(generation: number): readonly ExpectedReviewLane[] | undefined {
		return this.generation === generation ? Object.freeze([...this.expectedLanes.values()]) : undefined;
	}

	retain(generation: number, artifact: ReviewLaneArtifact): boolean {
		if (
			this.generation !== generation || artifact.generation !== generation ||
			!this.expectedLanes.has(artifact.key)
		) return false;
		const expected = this.expectedLanes.get(artifact.key)!;
		if (artifact.tier !== expected.tier || !!artifact.minorHygiene !== expected.minorHygiene) return false;
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
		this.expectedLanes.clear();
		this.generation = undefined;
	}
}
