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
 * The `nonempty` lane is a small Markdown grammar, not a prose detector.  Its
 * accepted forms are deliberately limited and documented in the public tool
 * schema and both reviewer prompts: framing labels may be plain (`Overview:`),
 * bold (`**Overview:**`), or ATX headings (`## Overview`); candidate fields
 * may be plain/bold and optionally list-prefixed.  Blockquotes, code fences,
 * JSON, and other wrappers are not part of the contract.
 */
const CANDIDATE_FIELDS = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"] as const;
const CANDIDATE_SEVERITIES = new Set(["P0", "P1", "P2", "P3", "nit"]);
const FRAMING_LABELS = ["Overview", "Strengths", "Risk areas"] as const;
const PLACEHOLDER_ONLY = /^(?:none|n\/?a|na|unavailable|unknown|skipped|error|review complete|no findings|nothing to review)(?:\s+(?:identified|found|available|present))?[.!]?$/i;
const CODE_FENCE = /^\s*```/m;

interface MarkdownLabel {
	readonly field: string;
	readonly value: string;
}

interface CandidateBlock {
	readonly start: number;
	readonly end: number;
	readonly fields: ReadonlyMap<string, string>;
}

function normalizeReviewText(text: string): string {
	return text
		.replace(/[\u2018\u2019\u201B\u2032\u02BC]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\r\n?/g, "\n");
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the exact framing forms; headings are accepted only for framing. */
function framingLabel(line: string): MarkdownLabel | undefined {
	let match = /^[ \t]*(?:\*\*|__)(Overview|Strengths|Risk areas):(?:\*\*|__)[ \t]*(.*)$/i.exec(line);
	if (match) return { field: match[1]!, value: match[2] ?? "" };
	match = /^[ \t]*(Overview|Strengths|Risk areas):[ \t]*(.*)$/i.exec(line);
	if (match) return { field: match[1]!, value: match[2] ?? "" };
	match = /^[ \t]*#{1,6}[ \t]+(?:(?:\*\*|__)(Overview|Strengths|Risk areas):(?:\*\*|__)|(Overview|Strengths|Risk areas):?)[ \t]*(.*)$/i.exec(line);
	if (match) return { field: (match[1] ?? match[2])!, value: match[3] ?? "" };
	return undefined;
}

/** Candidate fields are one-line values, with optional Markdown list/bold syntax. */
function candidateLabel(line: string): MarkdownLabel | undefined {
	const names = CANDIDATE_FIELDS.map(escapePattern).join("|");
	const match = new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?(?:(?:\\*\\*|__)(${names}):(?:\\*\\*|__)|(${names}):)[ \\t]*(.*)$`, "i").exec(line);
	if (!match) return undefined;
	return { field: (match[1] ?? match[2])!, value: match[3] ?? "" };
}

function canonicalField(field: string): string {
	return field.toLowerCase();
}

function meaningfulValue(value: string): boolean {
	const normalized = value.trim().replace(/^[>*+\\-][ \t]+/, "").trim();
	return normalized.length >= 2 && !PLACEHOLDER_ONLY.test(normalized) && /[\p{L}\p{N}]/u.test(normalized);
}

function confidenceValue(value: string): boolean {
	const normalized = value.trim();
	if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) return false;
	const number = Number(normalized);
	return Number.isFinite(number) && number >= 0 && number <= 1;
}

function validCandidateFields(fields: ReadonlyMap<string, string>): boolean {
	if (CANDIDATE_FIELDS.some((field) => !fields.has(field))) return false;
	const title = fields.get("title")!;
	const titleText = title.trim().replace(/^\[(?:P[0-3]|nit)\][ \t]+/, "");
	const severity = fields.get("severity")!;
	const why = fields.get("why")!;
	const location = fields.get("location")!;
	const side = fields.get("side")!;
	const inDiff = fields.get("in_diff")!;
	const prRelated = fields.get("pr_related")!;
	return /^\[(?:P[0-3]|nit)\][ \t]+\S/.test(title.trim()) &&
		meaningfulValue(titleText) &&
		CANDIDATE_SEVERITIES.has(severity.trim()) &&
		meaningfulValue(why) &&
		/^(?:repo-wide|(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+:\d+(?:-\d+)?)$/.test(location.trim()) &&
		/^(?:RIGHT|LEFT)$/.test(side.trim()) &&
		/^(?:yes|no)$/.test(inDiff.trim()) &&
		/^(?:yes|no)$/.test(prRelated.trim()) &&
		confidenceValue(fields.get("confidence")!);
}

function nonemptyLines(lines: readonly string[]): readonly string[] {
	return lines
		.map((line) => line.replace(/^[ \t]*(?:[-*+][ \t]+|>[ \t]*)/, "").trim())
		.filter((line) => line.length > 0);
}

function framingValueIsMeaningful(valueLines: readonly string[]): boolean {
	const values = nonemptyLines(valueLines);
	return values.length > 0 && values.some((value) => meaningfulValue(value)) && !values.every((value) => PLACEHOLDER_ONLY.test(value));
}

/** Failure-state markers are checked only in top-level framing, never candidate fields. */
function topLevelFailure(text: string): boolean {
	const value = normalizeReviewText(text);
	return [
		/\b(?:internal|fatal|server|model|tool)\s+error\b/i,
		/\b(?:review|analysis|assessment)\s+(?:complete|completed|failed|skipped|unavailable)\b/i,
		/\b(?:model|server|tool|review)\s+(?:failed|failure|error|unavailable)\b/i,
		/\b(?:access|permission)\s+(?:denied|failed|unavailable)\b/i,
		/\b(?:repository|repo|diff|patch|source context|review context|changed files?)\b.{0,40}\b(?:access\s+)?(?:denied|missing|unavailable|not\s+(?:provided|available|accessible)|failed)\b/i,
		/\b(?:i|we)\s+(?:do not|don't)\s+have\s+access\s+to\b/i,
		/\b(?:i|we|the reviewer|the review agent|the review model)\s+(?:could not|couldn't|cannot|can't|am unable to|are unable to|was unable to|were unable to|failed to|refuse|refused to)\s+(?:perform|provide|review|inspect|analy[sz]e|evaluate|examine|assess|conduct|complete|access|read)\b/i,
		/\b(?:unable|cannot|can't|could not|couldn't)\s+(?:to\s+)?(?:review|inspect|analy[sz]e|evaluate|examine|assess|complete)\b/i,
		/\b(?:no|missing)\s+(?:diff|patch|source context|review context)\b/i,
		/\breview complete\b/i,
	].some((signal) => signal.test(value));
}

/**
 * Parse and validate the integrated deep-lane grammar. The line indexes make
 * the top-level failure check exclude only complete candidate spans, so a
 * candidate's `why` may accurately discuss repository/diff access failures.
 */
function parseIntegratedCompletion(text: string): boolean {
	if (CODE_FENCE.test(text)) return false;
	const lines = text.split("\n");
	let cursor = 0;
	const framingValues: string[] = [];
	for (const expected of FRAMING_LABELS) {
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		const label = framingLabel(lines[cursor] ?? "");
		if (!label || canonicalField(label.field) !== expected.toLowerCase()) return false;
		const values = [label.value];
		cursor++;
		while (cursor < lines.length) {
			const nextFraming = framingLabel(lines[cursor]!);
			if (nextFraming) break;
			if (expected === "Risk areas") {
				const line = lines[cursor]!.trim();
				if (line === "NO FINDINGS." || canonicalField(candidateLabel(lines[cursor] ?? "")?.field ?? "") === "title") break;
				if (/^#{1,6}[ \t]+/.test(line)) return false;
			}
			values.push(lines[cursor]!);
			cursor++;
		}
		if (!framingValueIsMeaningful(values)) return false;
		framingValues.push(...values);
	}

	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	const afterFraming = cursor;
	if (cursor < lines.length && lines[cursor]!.trim() === "NO FINDINGS.") {
		cursor++;
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		return cursor === lines.length && !topLevelFailure(framingValues.join("\n"));
	}

	const candidates: CandidateBlock[] = [];
	while (cursor < lines.length) {
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		if (cursor >= lines.length) break;
		const start = cursor;
		const first = candidateLabel(lines[cursor]!);
		if (!first || canonicalField(first.field) !== "title") return false;
		const fields = new Map<string, string>();
		for (const expected of CANDIDATE_FIELDS) {
			while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
			const field = candidateLabel(lines[cursor] ?? "");
			if (!field || canonicalField(field.field) !== expected || fields.has(expected)) return false;
			fields.set(expected, field.value);
			cursor++;
		}
		if (!validCandidateFields(fields)) return false;
		candidates.push({ start, end: cursor, fields });
	}
	if (candidates.length === 0) return false;
	const candidateLineIndexes = new Set(candidates.flatMap((candidate) =>
		Array.from({ length: candidate.end - candidate.start }, (_, offset) => candidate.start + offset)));
	const topLevel = lines
		.map((line, index) => index >= afterFraming && candidateLineIndexes.has(index) ? "" : line)
		.join("\n");
	return !topLevelFailure(topLevel);
}

function hasMeaningfulField(text: string, field: string): boolean {
	const match = fieldPattern(field).exec(text);
	return !!match?.[1]?.trim();
}

function fieldPattern(field: string): RegExp {
	return new RegExp(`^[ \\t]*(?:[-*+][ \\t]*)?(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?${escapePattern(field)}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im");
}

function hasMeaningfulLightSection(text: string, field: string, fields: readonly string[]): boolean {
	const escapedFields = fields.map((candidate) => escapePattern(candidate)).join("|");
	const heading = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?${escapePattern(field)}[ \\t]*:?[ \\t]*(.*)\\r?$`, "im").exec(text);
	if (!heading || heading.index === undefined) return false;
	const inlineValue = heading[1] ?? "";
	const bodyStart = heading.index + heading[0].length;
	const nextHeading = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:${escapedFields})[ \\t]*:?[ \\t]*`, "im").exec(text.slice(bodyStart));
	const body = nextHeading ? text.slice(bodyStart, bodyStart + nextHeading.index) : text.slice(bodyStart);
	return `${inlineValue}\n${body}`
		.split("\n")
		.some((line) => line.replace(/^[ \\t]*(?:[-*>][ \\t]*)+/, "").trim().length > 0);
}

function expectedLaneSections(input: ReviewLaneCompletionInput): boolean {
	const text = normalizeReviewText(input.rawText.trim());
	if (!text) return false;
	if (input.expectedOutput === "nonempty") return parseIntegratedCompletion(text);
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
