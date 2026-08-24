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
	/\b(?:i|we)\s+(?:could not|couldn'?t|cannot|can'?t|am unable to|are unable to|was unable to|were unable to|failed to|am not able to|are not able to|wasn'?t able to|weren'?t able to)\s+(?:perform|provide|review|inspect|analy[sz]e|evaluate|examine|assess|conduct|complete)\b/i,
	/\b(?:i|we)\s+(?:do not|don't)\s+have\s+access\s+to\s+(?:the\s+)?(?:diff|patch|repository|repo(?:sitory)?|review context|changed files?)\b/i,
	/\b(?:the|this)\s+(?:review|reviewer|review agent|review model)\s+(?:could not|couldn'?t|cannot|can'?t|was unable to|were unable to|failed to)\s+(?:access|read|inspect|examine|retrieve|obtain|load|complete)\b/i,
	/(?:^|[\n.!?:;,])\s*(?:could not|couldn'?t|cannot|can'?t|unable to|failed to|was unable to|were unable to)\s+(?:review|inspect|analy[sz]e|evaluate|examine|assess|conduct|complete)\b/i,
	/(?:^|[\n.!?:;,])\s*(?:could not|couldn'?t|cannot|can'?t|unable to|failed to|was unable to|were unable to)\s+(?:access|read|inspect|examine|retrieve|obtain|load)\s+(?:the\s+)?(?:diff|patch|changes?|pull request|pr\b|repository|repo(?:sitory)?|changed files?|review context)\b/i,
	/\b(?:no\s+(?:diff|patch|review context)\s+(?:(?:was|were)\s+)?(?:provided|available|accessible)|nothing\s+to\s+review)\b/i,
	/\b(?:diff|patch|review context)\s+(?:was|were)\s+(?:not\s+)?(?:provided|available|accessible)\b/i,
	/\bchanges?\s+(?:was|were)\s+not\s+provided\b/i,
	/\b(?:review|analysis|assessment)\s+(?:failed|was not possible|is unavailable|could not be completed|(?:was\s+)?skipped|(?:was\s+)?unavailable)\b/i,
	/(?:^|[\n])\s*(?:[A-Za-z][^:\n]{0,40}:\s*)?(?:internal|fatal)\s+(?:server|model|tool|review)?\s*error\b/im,
	/(?:^|[\n])\s*(?:error|failure)\s+(?:returned|from)\b/im,
	/\b(?:error returned by|failure returned by)\s+(?:the\s+)?(?:review|model|tool)\b/i,
] as const;

const CANDIDATE_FIELDS = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"] as const;
const FRAMING_LABELS = ["overview", "strengths?", "(?:high(?:est)?[- ]risk|risk)(?:[- ]areas?)?"] as const;

function normalizeReviewText(text: string): string {
	return text
		.replace(/[\u2018\u2019\u201B\u2032\u02BC]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\r\n?/g, "\n");
}

function hasSubstantiveProse(text: string): boolean {
	const words = text.match(/[A-Za-z]{2,}/g) ?? [];
	return words.length >= 2 || words.some((word) => new Set(word.toLowerCase()).size > 1);
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fieldPattern(field: string): RegExp {
	return new RegExp(`^[ \\t]*(?:[-*+][ \\t]*)?(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?${escapePattern(field)}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im");
}

function fieldValue(text: string, field: string): string | undefined {
	return fieldPattern(field).exec(text)?.[1]?.trim() || undefined;
}

function hasMeaningfulField(text: string, field: string): boolean {
	return !!fieldValue(text, field);
}

function candidateEvidenceBlocks(text: string): readonly string[] {
	const starts = [...text.matchAll(new RegExp(fieldPattern("title").source, "gim"))]
		.map((match) => match.index)
		.filter((index): index is number => index !== undefined);
	return starts.map((start, index) => {
		const nextStart = starts[index + 1] ?? text.length;
		const nextSection = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:${FRAMING_LABELS.join("|")}|findings?|no findings)[ \\t]*:?`, "im").exec(text.slice(start + 1));
		const end = nextSection?.index !== undefined ? start + 1 + nextSection.index : nextStart;
		return text.slice(start, Math.min(end, nextStart));
	});
}

function hasCompleteCandidateEvidence(text: string): boolean {
	return candidateEvidenceBlocks(text).some((block) =>
		CANDIDATE_FIELDS.every((field) => hasMeaningfulField(block, field)));
}

function framingSection(text: string, labels: readonly string[]): string | undefined {
	const labelPattern = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:${labels.join("|")})[ \\t]*:?[ \\t]*(.*)\\r?$`, "im");
	const match = labelPattern.exec(text);
	if (!match || match.index === undefined) return undefined;
	const bodyStart = match.index + match[0].length;
	const next = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:${FRAMING_LABELS.join("|")}|findings?|no findings)[ \\t]*:?`, "im").exec(text.slice(bodyStart));
	const body = next?.index !== undefined ? text.slice(bodyStart, bodyStart + next.index) : text.slice(bodyStart);
	return `${match[1] ?? ""}\n${body}`;
}

function hasMeaningfulIntegratedFraming(text: string): boolean {
	return FRAMING_LABELS.every((label) => {
		const section = framingSection(text, [label]);
		return !!section && (hasSubstantiveProse(section) || /^\s*(?:none|n\/a)\s*[.!]?\s*$/i.test(section));
	});
}

const NO_FINDINGS_SIGNALS = [
	/(?:^|[\n.!?:;,])\s*no (?:substantiated )?findings(?: at any severity| in (?:this|the) (?:review|PR))?\b/im,
	/(?:^|[\n.!?:;,])\s*no actionable (?:findings|issues|defects)(?:\s+(?:were|are|remain)\s+(?:identified|found|present))?\b/im,
	/(?:^|[\n.!?:;,])\s*(?:the integrated )?(?:review|assessment|analysis) found no (?:actionable )?(?:findings|issues|defects)\b/im,
	/(?:^|[\n.!?:;,])\s*(?:i|we) found no (?:actionable )?(?:findings|issues|defects)\b/im,
] as const;

function hasNoFindingsConclusion(text: string): boolean {
	return NO_FINDINGS_SIGNALS.some((signal) => signal.test(text));
}

function hasReviewRefusalSignal(text: string): boolean {
	return REVIEW_REFUSAL_SIGNALS.some((signal) => signal.test(normalizeReviewText(text)));
}

function expectedLaneSections(input: ReviewLaneCompletionInput): boolean {
	const text = normalizeReviewText(input.rawText.trim());
	if (!text) return false;
	// Candidate evidence is parsed first. Refusal language in a finding's why
	// field describes the defect and is not a refusal by the reviewer.
	if (input.expectedOutput === "nonempty") {
		if (hasCompleteCandidateEvidence(text)) return true;
		if (!hasMeaningfulIntegratedFraming(text) || !hasNoFindingsConclusion(text)) return false;
		// Refusal/error envelopes can imitate framing labels, so inspect only the
		// top-level integrated output after the positive grammar matched.
		return !hasReviewRefusalSignal(text);
	}
	if (input.tier === "light") {
		const fields = input.minorHygiene ? ["overview", "strengths", "minor candidates"] : ["overview", "strengths"];
		return fields.every((field) => hasMeaningfulLightSection(text, field, fields));
	}
	if (text === "NO FINDINGS.") return true;
	return CANDIDATE_FIELDS.every((field) => hasMeaningfulField(text, field));
}

/** Process exit is necessary but insufficient: only a terminal stop with valid lane output is complete. */
export function classifyReviewLane(input: ReviewLaneCompletionInput): ReviewLaneLifecycle {
	const reason = typeof input.stopReason === "string" ? input.stopReason.toLowerCase() : undefined;
	const error = typeof input.errorMessage === "string" ? input.errorMessage.toLowerCase() : undefined;
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
