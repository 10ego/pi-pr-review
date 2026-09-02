import { Buffer } from "node:buffer";
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
	/** Invocation time already consumed before this attempt was scheduled. */
	readonly budgetElapsedBeforeAttemptMs?: number;
	/** Remaining reviewer-batch window at scheduling time; negative means dispatch was already late. */
	readonly batchRemainingBeforeAttemptMs?: number;
	/** Remaining total invocation window at scheduling time. */
	readonly totalRemainingBeforeAttemptMs?: number;
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
 * The `nonempty` lane is a small Markdown grammar, not a prose detector. Its
 * first nonblank line is the exact `Review status: COMPLETE` attestation;
 * `INCOMPLETE` and every other status are partial. The remaining productions
 * are documented in the public tool schema and both reviewer prompts: framing
 * labels may be plain (`Overview:`), bold (`**Overview:**`), or ATX headings
 * followed by one top-level value line; candidate fields may be plain/bold or
 * use the one exact top-level `- ` list marker. Blockquotes, code fences, JSON,
 * and other wrappers are not part of the contract. Nonblank contract lines do
 * not carry trailing horizontal whitespace, and a `why` continuation is exactly
 * two spaces plus a non-list line.
 */
const CANDIDATE_FIELDS = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"] as const;
const CANDIDATE_SEVERITIES = new Set(["P0", "P1", "P2", "P3", "nit"]);
const FRAMING_LABELS = ["Overview", "Strengths", "Risk areas"] as const;
const PLACEHOLDER_ONLY = /^(?:none|n\/?a|na|unavailable|unknown|skipped|error|review complete|no findings|nothing to review)(?:\s+(?:identified|found|available|present))?[.!]?$/i;
const NO_FINDINGS_SENTINEL = "NO FINDINGS.";
const MAX_CANDIDATE_TITLE_BYTES = 1_024;
const MAX_CANDIDATE_WHY_BYTES = 16 * 1_024;
const MAX_CANDIDATE_PATH_BYTES = 4_096;
const CODE_FENCE = /^ {0,3}(?:`{3,}|~{3,})/m;
const COMMONMARK_HTML_BLOCK_TAGS = [
	"address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
	"colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
	"footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr",
	"html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
	"optgroup", "option", "p", "param", "search", "section", "summary", "table", "tbody", "td", "tfoot",
	"th", "thead", "title", "tr", "track", "ul",
].join("|");
const COMMONMARK_BLANK_TERMINATED_HTML = new RegExp(
	`^ {0,3}</?(?:${COMMONMARK_HTML_BLOCK_TAGS})(?:[ \\t]+|/?>|$)`,
	"i",
);
// CommonMark type 7 accepts a complete open or closing tag for any tag name,
// including custom elements. Unlike types 1–6, it cannot interrupt a paragraph.
const COMMONMARK_COMPLETE_HTML_TAG = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ "'=<>`\u0000-\u0020]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
// These are CommonMark HTML block openers. The opener itself is sufficient:
// an assistant must not be able to hide later contract lines behind an
// unterminated comment, declaration, raw block tag, or other container.
function htmlBlockOpener(line: string): boolean {
	return /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t]+|>|$)/i.test(line) ||
		/^ {0,3}<!--/.test(line) ||
		/^ {0,3}<\?/.test(line) ||
		/^ {0,3}<![A-Z]/i.test(line) ||
		/^ {0,3}<!\[CDATA\[/i.test(line) ||
		COMMONMARK_BLANK_TERMINATED_HTML.test(line) ||
		COMMONMARK_COMPLETE_HTML_TAG.test(line);
}

function hasHtmlContainer(text: string): boolean {
	return text.split("\n").some((line) => htmlBlockOpener(line));
}

const CONTAINER_PREFIX = /^(?:[-*+>]|#{1,6})[ \t]+/;
const RESERVED_LABEL_PRODUCTION = /(?:^|[ \t])(?:\*\*|__)?(?:Overview|Strengths|Risk areas|title|severity|why|location|side|in_diff|pr_related|confidence)(?:\*\*|__)?[ \t]*:/i;
const SEVERITY_TAG_PRODUCTION = /\[(?:P[0-3]|nit)\]/gi;

interface MarkdownLabel {
	readonly field: string;
	readonly value: string;
	readonly kind: "inline" | "heading";
}

interface CandidateBlock {
	readonly start: number;
	readonly end: number;
	readonly fields: ReadonlyMap<string, string>;
}

export interface ValidatedReviewLaneCandidate {
	readonly title: string;
	readonly severity: "P0" | "P1" | "P2" | "P3" | "nit";
	readonly why: string;
	readonly location: string;
	readonly side: "RIGHT" | "LEFT";
	readonly inDiff: boolean;
	readonly prRelated: boolean;
	readonly confidence: number;
}

function normalizeReviewText(text: string): string {
	// Only CRLF is transport normalization. In particular, do not trim or
	// rewrite line-leading whitespace before applying the grammar.
	return text.replace(/\r\n/g, "\n");
}

function hasTrailingHorizontalWhitespace(text: string): boolean {
	// Spaces/tabs on a separator line are still a blank separator. Contract
	// productions remain exact: only a nonblank line with trailing horizontal
	// whitespace is rejected.
	return text.split("\n").some((line) => line.trim() && /[ \t]+$/.test(line));
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the exact framing forms; headings are accepted only for framing. */
function framingLabel(line: string): MarkdownLabel | undefined {
	if (/^[ \t]/.test(line)) return undefined;
	let match = /^\*\*(Overview|Strengths|Risk areas):\*\*[ \t]*(.*)$/.exec(line);
	if (match) return { field: match[1]!, value: match[2] ?? "", kind: "inline" };
	match = /^__(Overview|Strengths|Risk areas):__[ \t]*(.*)$/.exec(line);
	if (match) return { field: match[1]!, value: match[2] ?? "", kind: "inline" };
	match = /^(Overview|Strengths|Risk areas):[ \t]*(.*)$/.exec(line);
	if (match) return { field: match[1]!, value: match[2] ?? "", kind: "inline" };
	match = /^#{1,6}[ \t]+(?:(?:\*\*)(Overview|Strengths|Risk areas):(?:\*\*)|(?:__)(Overview|Strengths|Risk areas):(?:__)|(Overview|Strengths|Risk areas):?)[ \t]*$/.exec(line);
	if (match) return { field: (match[1] ?? match[2] ?? match[3])!, value: "", kind: "heading" };
	return undefined;
}

/** Candidate fields are top-level one-line values with optional bold syntax or one exact `- ` marker. */
function candidateLabel(line: string): MarkdownLabel | undefined {
	const names = CANDIDATE_FIELDS.map(escapePattern).join("|");
	const match = new RegExp(`^(?:- )?(?:(?:\\*\\*)(${names}):(?:\\*\\*)|(?:__)(${names}):(?:__)|(${names}):)[ \t]*(.*)$`).exec(line);
	if (!match) return undefined;
	return { field: (match[1] ?? match[2] ?? match[3])!, value: match[4] ?? "", kind: "inline" };
}

type CandidateBlockStyle = "top-level" | "list-undecided" | "repeated-list" | "yaml-list";

/** Parse top-level, repeated-list-marker, or conventional YAML-list fields. */
function candidateBlockLabel(line: string, style: CandidateBlockStyle): MarkdownLabel | undefined {
	if (style === "top-level") return line.startsWith("- ") ? undefined : candidateLabel(line);
	if (style === "repeated-list") return line.startsWith("- ") ? candidateLabel(line) : undefined;
	if (style === "list-undecided") return undefined;
	// In conventional YAML form the title owns the list marker and subsequent
	// fields use exactly two spaces with no nested marker. Broader indentation
	// remains unavailable to arbitrary Markdown containers.
	if (!/^ {2}\S/.test(line) || /^ {3}/.test(line)) return undefined;
	const unindented = line.slice(2);
	return unindented.startsWith("- ") ? undefined : candidateLabel(unindented);
}

function canonicalField(field: string): string {
	return field.toLowerCase();
}

const CJK_SCRIPT_CHARACTERS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const CJK_BOILERPLATE_ONLY = /^(?:无问题|没有(?:任何|发现)?问题|未发现问题|一切正常|测试测试|哈哈哈哈|审查完成|评审完成|没有风险|无风险|問題なし|特に問題なし|レビュー完了|検証完了|문제없음|검토완료)[。.!！!?？]*$/u;

function repeatedText(value: string): boolean {
	for (let width = 1; width <= Math.floor(value.length / 2); width++) {
		if (value.length % width === 0 && value.slice(0, width).repeat(value.length / width) === value) return true;
	}
	return false;
}

function meaningfulValue(value: string): boolean {
	const normalized = value.trim();
	const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
	const latinOrNumericWords = normalized.match(/[\p{Script=Latin}\p{N}]+/gu) ?? [];
	const cjkCharacters = normalized.match(CJK_SCRIPT_CHARACTERS) ?? [];
	const cjkText = cjkCharacters.join("");
	const cjkBoilerplate = CJK_BOILERPLATE_ONLY.test(normalized.replace(/\s+/gu, ""));
	const meaningfulCjk = cjkCharacters.length >= 4 && new Set(cjkCharacters).size >= 4 &&
		!repeatedText(cjkText) && !cjkBoilerplate;
	const wordEvidence = cjkCharacters.length > 0 ? latinOrNumericWords.length >= 2 : words.length >= 2;
	const meaningfulLanguage = !cjkBoilerplate && (wordEvidence || meaningfulCjk);
	const nonCjkProjection = normalized.replace(CJK_SCRIPT_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	const normalizedProjection = nonCjkProjection.replace(/[\s\-–—:;,/|]+$/gu, "").trim();
	const projectedPlaceholder = normalizedProjection.length > 0 && PLACEHOLDER_ONLY.test(normalizedProjection);
	return meaningfulLanguage && !PLACEHOLDER_ONLY.test(normalized) && !(projectedPlaceholder && !meaningfulCjk) &&
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized);
}

function confidenceValue(value: string): boolean {
	const normalized = value.trim();
	if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) return false;
	const number = Number(normalized);
	return Number.isFinite(number) && number >= 0 && number <= 1;
}

/** Validate the prompt's repo-relative/path:positive-line-range location syntax. */
function safeLocation(value: string): boolean {
	const normalized = value.trim();
	if (normalized === "repo-wide") return true;
	const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(normalized);
	if (!match) return false;
	const locationPath = match[1]!;
	const start = Number(match[2]);
	const end = match[3] === undefined ? start : Number(match[3]);
	if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return false;
	if (!locationPath || Buffer.byteLength(locationPath, "utf8") > MAX_CANDIDATE_PATH_BYTES ||
		locationPath.startsWith("/") || locationPath.startsWith("~") || /^[A-Za-z]:/.test(locationPath)) return false;
	if (/[\\\u0000-\u001f\u007f]/.test(locationPath)) return false;
	const segments = locationPath.split("/");
	return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment === segment.trim() && segment !== "." && segment !== ".." && !segment.includes(":"));
}

function hasReservedStatusProduction(line: string): boolean {
	return /^(?:[-*+>][ \t]+)?Review status\s*:/i.test(line.trim());
}

/**
 * Values are prose, but they may not contain a line-shaped contract
 * production. This is deliberately limited to the documented grammar (and
 * containers), rather than an English keyword denylist. Every line is
 * checked independently so a multiline `why` cannot hide a fence or an
 * unterminated HTML block opener in a continuation.
 */
function hasReservedContractProduction(value: string): boolean {
	if (!value) return false;
	if (value.includes(NO_FINDINGS_SENTINEL) || /Review status\s*:/i.test(value) || RESERVED_LABEL_PRODUCTION.test(value)) return true;
	if (hasHtmlContainer(value)) return true;
	return value.split("\n").some((line) => {
		const structural = line.trim();
		return CODE_FENCE.test(line) || htmlBlockOpener(line) ||
			structural === NO_FINDINGS_SENTINEL || hasReservedStatusProduction(structural) ||
			!!framingLabel(structural) || !!candidateLabel(structural) || CONTAINER_PREFIX.test(structural);
	});
}

function hasReservedCandidateProduction(field: string, value: string): boolean {
	if (hasReservedContractProduction(value)) return true;
	let allowedLeadingTitleTag = field === "title";
	for (const [lineIndex, line] of value.split("\n").entries()) {
		for (const match of line.matchAll(SEVERITY_TAG_PRODUCTION)) {
			if (allowedLeadingTitleTag && lineIndex === 0 && match.index === 0) {
				allowedLeadingTitleTag = false;
				continue;
			}
			return true;
		}
	}
	return false;
}

function validCandidateFields(fields: ReadonlyMap<string, string>): boolean {
	if (CANDIDATE_FIELDS.some((field) => !fields.has(field))) return false;
	if ([...fields.entries()].some(([field, value]) => hasReservedCandidateProduction(field, value))) return false;
	const title = fields.get("title")!.trim();
	const titleMatch = /^\[(P0|P1|P2|P3|nit)\][ \t]+(.+)$/.exec(title);
	const severity = fields.get("severity")!.trim();
	const why = fields.get("why")!;
	const location = fields.get("location")!;
	const side = fields.get("side")!.trim();
	const inDiff = fields.get("in_diff")!.trim();
	const prRelated = fields.get("pr_related")!.trim();
	return !!titleMatch && meaningfulValue(titleMatch[2]!) &&
		Buffer.byteLength(title, "utf8") <= MAX_CANDIDATE_TITLE_BYTES &&
		CANDIDATE_SEVERITIES.has(severity) && titleMatch[1] === severity &&
		meaningfulValue(why) && Buffer.byteLength(why, "utf8") <= MAX_CANDIDATE_WHY_BYTES && safeLocation(location) &&
		/^(?:RIGHT|LEFT)$/.test(side) &&
		/^(?:yes|no)$/.test(inDiff) &&
		/^(?:yes|no)$/.test(prRelated) &&
		confidenceValue(fields.get("confidence")!);
}

function framingValueHasReservedProduction(value: string): boolean {
	return hasReservedContractProduction(value);
}

function isReservedContractLine(line: string): boolean {
	return hasReservedContractProduction(line);
}

/** Only obvious, deterministic placeholders are defense-in-depth; COMPLETE is the primary contract. */
function topLevelFailure(text: string): boolean {
	return text.split("\n").some((line) => /^(?:internal server error|fatal error|access denied|review (?:failed|unavailable|skipped)|no (?:diff|patch|source context|review context)(?: was)? (?:provided|available|accessible))[.!]?$/i.test(line.trim()));
}

/**
 * Defense-in-depth only: COMPLETE remains the semantic protocol's primary
 * self-attestation. Keep this detector bounded to the three framing values so
 * legitimate candidate evidence can discuss inability, denied access, failed
 * review behavior, or server errors; it is intentionally not exhaustive.
 */
function contradictoryFraming(values: readonly string[]): boolean {
	const patterns = [
		/^(?:(?:unfortunately|regrettably|sorry|apologies?|sadly)[,:]?\s+)?(?:(?:but|however|though|yet)[,:]?\s+)?(?:i|we)\s+(?:could not|couldn't|cannot|can't|was unable to|were unable to)\s+(?:access|inspect|review|assess|evaluate|read|view)\b/i,
		/^(?:(?:unfortunately|regrettably|sorry|apologies?|sadly)[,:]?\s+)?(?:(?:but|however|though|yet)[,:]?\s+)?(?:i|we)\s+(?:do not|don't|does not|doesn't|did not|didn't)\s+(?:have\s+)?access\s+to\s+(?:the\s+)?(?:review|diff|patch|repository|repo|source|context)\b/i,
		/^(?:(?:unfortunately|regrettably|sorry|apologies?|sadly)[,:]?\s+)?(?:(?:but|however|though|yet)[,:]?\s+)?(?:i|we)\s+lacks?\s+access\s+to\s+(?:the\s+)?(?:review|diff|patch|repository|repo|source|context)\b/i,
		/^(?:(?:unfortunately|regrettably|sorry|apologies?|sadly)[,:]?\s+)?(?:(?:but|however|though|yet)[,:]?\s+)?(?:i|we)\s+(?:was|were)\s+denied\s+access\s+to\s+(?:the\s+)?(?:review|diff|patch|repository|repo|source|context)\b/i,
		/^(?:(?:unfortunately|regrettably|sorry|apologies?|sadly)[,:]?\s+)?(?:(?:but|however|though|yet)[,:]?\s+)?(?:i|we)\s+failed\s+to\s+(?:access|inspect|review|assess|evaluate|read|view)\b/i,
		/^(?:the\s+)?review\s+(?:did not|didn't|was not|wasn't)\s+run\b/i,
		/^(?:the\s+)?review\s+(?:(?:was\s+)?skipped)\b/i,
	];
	return values.some((value) => {
		const normalized = value.replace(/\s+/g, " ").trim();
		return patterns.some((pattern) => pattern.test(normalized));
	});
}

/**
 * Parse and validate the integrated deep-lane grammar statefully. COMPLETE is
 * an explicit reviewer attestation: every other status, a missing/later/
 * wrapped/duplicate status, or a malformed production is partial. Framing has
 * exactly one nonempty value line per field. Candidate `why` may have
 * indented continuation lines; reserved productions cannot be continuations.
 */
function parseCandidatePrefix(
	lines: readonly string[],
	startCursor: number,
): { candidates: CandidateBlock[]; consumedAll: boolean } {
	let cursor = startCursor;
	const candidates: CandidateBlock[] = [];
	while (cursor < lines.length) {
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		if (cursor >= lines.length) return { candidates, consumedAll: true };
		const start = cursor;
		const fields = new Map<string, string>();
		let style: CandidateBlockStyle = "top-level";
		for (const expected of CANDIDATE_FIELDS) {
			while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
			const fieldLine = lines[cursor] ?? "";
			if (fieldLine.trim() && /[ \t]+$/.test(fieldLine)) return { candidates, consumedAll: false };
			if (expected === "title" && fieldLine.startsWith("- ")) style = "list-undecided";
			if (expected === "severity" && style === "list-undecided") {
				style = fieldLine.startsWith("- ") ? "repeated-list" : "yaml-list";
			}
			const field = expected === "title"
				? candidateLabel(fieldLine)
				: candidateBlockLabel(fieldLine, style);
			if (!field || canonicalField(field.field) !== expected || fields.has(expected)) {
				return { candidates, consumedAll: false };
			}
			if (hasReservedCandidateProduction(expected, field.value)) return { candidates, consumedAll: false };
			fields.set(expected, field.value);
			cursor++;
			if (expected !== "why") continue;
			const whyLines = [field.value];
			while (cursor < lines.length) {
				const continuation = lines[cursor]!;
				if (!continuation.trim()) break;
				if (/[ \t]+$/.test(continuation)) return { candidates, consumedAll: false };
				const nextField = candidateBlockLabel(continuation, style);
				if (nextField && canonicalField(nextField.field) === "location") break;
				if (isReservedContractLine(continuation)) break;
				const continuationIndent = style === "yaml-list" ? 4 : 2;
				const prefix = " ".repeat(continuationIndent);
				if (!continuation.startsWith(prefix) || continuation.startsWith(`${prefix} `) ||
					new RegExp(`^ {${continuationIndent}}(?:[-*+>]|#{1,6})[ \\t]+`).test(continuation)) {
					return { candidates, consumedAll: false };
				}
				const continuationValue = continuation.slice(continuationIndent);
				if (continuationValue.startsWith("\t") || hasReservedCandidateProduction("why", continuationValue)) {
					return { candidates, consumedAll: false };
				}
				whyLines.push(continuationValue);
				cursor++;
			}
			fields.set("why", whyLines.join("\n"));
		}
		if (!validCandidateFields(fields)) return { candidates, consumedAll: false };
		candidates.push({ start, end: cursor, fields });
	}
	return { candidates, consumedAll: true };
}

function parseIntegratedCompletion(text: string): boolean {
	if (hasTrailingHorizontalWhitespace(text) || CODE_FENCE.test(text) || hasHtmlContainer(text)) return false;
	const lines = text.split("\n");
	let cursor = 0;
	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	if (cursor >= lines.length || lines[cursor] !== "Review status: COMPLETE") return false;
	const statusIndex = cursor;
	if (lines.some((line, index) => index !== statusIndex && hasReservedStatusProduction(line))) return false;
	cursor++;
	const framingValues: string[] = [];
	for (const expected of FRAMING_LABELS) {
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		const label = framingLabel(lines[cursor] ?? "");
		if (!label || canonicalField(label.field) !== expected.toLowerCase()) return false;
		cursor++;
		let value = label.value;
		if (label.kind === "heading") {
			const valueLine = lines[cursor] ?? "";
			if (!valueLine || !valueLine.trim() || /^[ \t]/.test(valueLine) || CONTAINER_PREFIX.test(valueLine) || isReservedContractLine(valueLine)) return false;
			value = valueLine;
			cursor++;
		}
		if (!meaningfulValue(value) || framingValueHasReservedProduction(value)) return false;
		framingValues.push(value);
	}
	// COMPLETE is still the documented trust boundary; this bounded framing-only
	// contradiction check is defense-in-depth and intentionally not exhaustive.
	if (topLevelFailure(framingValues.join("\n")) || contradictoryFraming(framingValues)) return false;

	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	if (cursor < lines.length && lines[cursor] === NO_FINDINGS_SENTINEL) {
		cursor++;
		while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
		return cursor === lines.length;
	}

	const parsed = parseCandidatePrefix(lines, cursor);
	return parsed.consumedAll && parsed.candidates.length > 0;
}

/**
 * Recover only complete, contract-valid candidate blocks from retained lane
 * output. A timed-out final block may be truncated; earlier complete blocks
 * remain usable, while arbitrary prose and unsafe containers recover nothing.
 */
export function isValidatedReviewLaneNoFindings(
	rawText: string,
	expectedOutput: "review_lane" | "nonempty" = "review_lane",
): boolean {
	const text = normalizeReviewText(rawText);
	if (expectedOutput === "review_lane") return /^NO FINDINGS\.?$/.test(text.trim());
	return parseIntegratedCompletion(text) && text.split("\n").some((line) => line === NO_FINDINGS_SENTINEL);
}

export function extractValidatedReviewLaneCandidates(
	rawText: string,
	expectedOutput: "review_lane" | "nonempty" = "review_lane",
): readonly ValidatedReviewLaneCandidate[] {
	const text = normalizeReviewText(rawText);
	if (
		!text.trim() || CODE_FENCE.test(text) ||
		hasHtmlContainer(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
		/<!--\s*pi-pr-review:/i.test(text)
	) return [];
	const lines = text.split("\n");
	let cursor = 0;
	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	if (expectedOutput === "nonempty") {
		if (lines[cursor] !== "Review status: COMPLETE") return [];
		const statusIndex = cursor++;
		if (lines.some((line, index) => index !== statusIndex && hasReservedStatusProduction(line))) return [];
		const framingValues: string[] = [];
		for (const expected of FRAMING_LABELS) {
			while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
			const framingLine = lines[cursor] ?? "";
			if (framingLine.trim() && /[ \t]+$/.test(framingLine)) return [];
			const label = framingLabel(framingLine);
			if (!label || canonicalField(label.field) !== expected.toLowerCase()) return [];
			cursor++;
			let value = label.value;
			if (label.kind === "heading") {
				const valueLine = lines[cursor] ?? "";
				if (!valueLine || !valueLine.trim() || /[ \t]+$/.test(valueLine) || /^[ \t]/.test(valueLine) || CONTAINER_PREFIX.test(valueLine) || isReservedContractLine(valueLine)) return [];
				value = valueLine;
				cursor++;
			}
			if (!meaningfulValue(value) || framingValueHasReservedProduction(value)) return [];
			framingValues.push(value);
		}
		if (topLevelFailure(framingValues.join("\n")) || contradictoryFraming(framingValues)) return [];
	} else if (lines.some((line) => hasReservedStatusProduction(line))) {
		return [];
	}
	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	if (lines.some((line) => line.trim() === NO_FINDINGS_SENTINEL || line.trim() === "NO FINDINGS")) return [];
	const parsed = parseCandidatePrefix(lines, cursor);
	return parsed.candidates.map((candidate) => {
		const fields = candidate.fields;
		return Object.freeze({
			title: fields.get("title")!.trim(),
			severity: fields.get("severity")!.trim() as ValidatedReviewLaneCandidate["severity"],
			why: fields.get("why")!.trim(),
			location: fields.get("location")!.trim(),
			side: fields.get("side")!.trim() as ValidatedReviewLaneCandidate["side"],
			inDiff: fields.get("in_diff")!.trim() === "yes",
			prRelated: fields.get("pr_related")!.trim() === "yes",
			confidence: Number(fields.get("confidence")!.trim()),
		});
	});
}

function hasMeaningfulField(text: string, field: string): boolean {
	const match = fieldPattern(field).exec(text);
	return !!match?.[1]?.trim();
}

function fieldPattern(field: string): RegExp {
	return new RegExp(`^[ \\t]*(?:[-*+][ \\t]*)?(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?${escapePattern(field)}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(.+?)[ \\t]*\\r?$`, "im");
}

function expectedLaneSections(input: ReviewLaneCompletionInput): boolean {
	const normalized = normalizeReviewText(input.rawText);
	if (!normalized.trim()) return false;
	if (input.expectedOutput === "nonempty") return parseIntegratedCompletion(normalized);
	const text = normalized.trim();
	if (input.tier === "light") {
		const fields = input.minorHygiene ? ["overview", "strengths", "minor candidates"] : ["overview", "strengths"];
		return fields.every((field) => hasMeaningfulLightSection(text, field, fields));
	}
	// Ordinary lanes use the sentinel only as an unambiguous clean result; a
	// missing final period carries no semantic uncertainty and must not amplify
	// into expensive replacement passes. Integrated/deep `nonempty` output keeps
	// its exact byte contract in parseIntegratedCompletion().
	if (/^NO FINDINGS\.?$/.test(text)) return true;
	return parseOrdinaryCandidateCompletion(normalized);
}

function parseOrdinaryCandidateCompletion(rawText: string): boolean {
	const text = normalizeReviewText(rawText);
	if (
		!text.trim() || hasTrailingHorizontalWhitespace(text) || CODE_FENCE.test(text) ||
		hasHtmlContainer(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
		/<!--\s*pi-pr-review:/i.test(text)
	) return false;
	const lines = text.split("\n");
	if (lines.some((line) => hasReservedStatusProduction(line) || line.trim() === NO_FINDINGS_SENTINEL || line.trim() === "NO FINDINGS")) {
		return false;
	}
	let cursor = 0;
	while (cursor < lines.length && !lines[cursor]!.trim()) cursor++;
	const parsed = parseCandidatePrefix(lines, cursor);
	return parsed.consumedAll && parsed.candidates.length > 0;
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

/**
 * Internal-only completion contract for the no-tools output-repair subprocess.
 * It deliberately accepts exactly one parseable, non-array JSON object after
 * trim; process success, terminal stop, and absence of an error are required.
 * The public review_subagents schema remains limited to review_lane/nonempty.
 */
export function classifyReviewJsonObject(input: ReviewLaneCompletionInput): ReviewLaneLifecycle {
	const reason = typeof input.stopReason === "string" ? input.stopReason.toLowerCase() : undefined;
	const error = typeof input.errorMessage === "string" ? input.errorMessage.trim() : undefined;
	if (reason?.includes("timeout") || error?.toLowerCase().includes("timed out") || error?.toLowerCase().includes("timeout")) return "timed_out";
	const hasText = input.rawText.length > 0;
	let isObject = false;
	if (hasText) {
		try {
			const parsed: unknown = JSON.parse(input.rawText.trim());
			isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
		} catch {
			isObject = false;
		}
	}
	if (input.exitCode === 0 && reason === "stop" && !error && isObject) return "complete";
	return hasText ? "partial" : "failed";
}

const LANE_LIFECYCLES = new Set<string>(["complete", "partial", "timed_out", "failed"]);
const LANE_TIERS = new Set<string>(["light", "medium", "heavy"]);
const LANE_ATTEMPT_KINDS = new Set<string>(["primary", "fallback", "nearest", "default"]);
const LANE_DEADLINE_KINDS = new Set<string>(["total", "synthesis"]);
const LANE_DEADLINE_SOURCES = new Set<string>(["default", "user", "project"]);

/** Optional fields may be absent (undefined), explicitly null, or the given type. */
const optional = (value: unknown, predicate: (value: unknown) => boolean): boolean =>
	value === undefined || value === null || predicate(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isEnum = (allowed: Set<string>) => (value: unknown): value is string => isString(value) && allowed.has(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Copy an already-read optional local into a snapshot (null preserved, undefined omitted). */
function withOptional(snapshot: Record<string, unknown>, key: string, local: unknown): void {
	if (local !== undefined) snapshot[key] = local;
}

/**
 * Boundary-safe lane artifact snapshot. Lane artifacts enter host state from
 * subprocess results and session-log restores; TypeScript types are not runtime
 * guarantees. Every field consumed downstream (degraded synthesis Markdown
 * interpolation, approval revalidation, extraction input assembly) is read
 * EXACTLY ONCE inside a single guarded access phase into local plain values;
 * validation and the stored frozen snapshot are built only from those locals,
 * so a stateful getter cannot pass validation with a good first value and then
 * return a hostile one (Symbol, throw, different value) while it is copied or
 * used. A malformed or throwing field drops the
 * entire lane; valid optional null/undefined values and real fallback attempt
 * shapes are preserved.
 */
function laneArtifactSnapshot(value: unknown): ReviewLaneArtifact | undefined {
	try {
		if (!value || typeof value !== "object") return undefined;
		const source = value as Record<string, unknown>;
		// --- One-read phase: every property is accessed exactly once. ---
		const generation = source.generation;
		const key = source.key;
		const passId = source.passId;
		const rawText = source.rawText;
		const exitCode = source.exitCode;
		const lifecycle = source.lifecycle;
		const tier = source.tier;
		const fallbackUsed = source.fallbackUsed;
		const elapsedMs = source.elapsedMs;
		const toolElapsedMs = source.toolElapsedMs;
		const toolCallCount = source.toolCallCount;
		const requestedPassOrdinal = source.requestedPassOrdinal;
		const minorHygiene = source.minorHygiene;
		const requestedModel = source.requestedModel;
		const observedModel = source.observedModel;
		const processSignal = source.processSignal;
		const stopReason = source.stopReason;
		const errorMessage = source.errorMessage;
		const deadlineExpired = source.deadlineExpired;
		const firstEventMs = source.firstEventMs;
		const firstAssistantMs = source.firstAssistantMs;
		const startOffsetMs = source.startOffsetMs;
		const endOffsetMs = source.endOffsetMs;
		const fallbackBudgetRejected = source.fallbackBudgetRejected;
		const deadlineSource = source.deadlineSource;
		const batchDeadlineMs = source.batchDeadlineMs;
		const totalDeadlineMs = source.totalDeadlineMs;
		const attemptsSource = source.attempts;
		// --- Validation phase: locals only, never rereading the hostile object. ---
		if (!isString(key) || !key) return undefined;
		if (!isInteger(generation)) return undefined;
		if (!isString(passId)) return undefined;
		if (!isString(rawText)) return undefined;
		if (!isInteger(exitCode)) return undefined;
		if (!isEnum(LANE_LIFECYCLES)(lifecycle)) return undefined;
		if (!isEnum(LANE_TIERS)(tier)) return undefined;
		if (!isBoolean(fallbackUsed)) return undefined;
		if (!isFiniteNumber(elapsedMs)) return undefined;
		if (!isFiniteNumber(toolElapsedMs)) return undefined;
		if (!isInteger(toolCallCount) || toolCallCount < 0) return undefined;
		if (requestedPassOrdinal !== undefined && !isInteger(requestedPassOrdinal)) return undefined;
		if (!optional(minorHygiene, isBoolean)) return undefined;
		if (!optional(requestedModel, isString)) return undefined;
		if (!optional(observedModel, isString)) return undefined;
		if (!optional(processSignal, isString)) return undefined;
		if (!optional(stopReason, isString)) return undefined;
		if (!optional(errorMessage, isString)) return undefined;
		if (!optional(deadlineExpired, isEnum(LANE_DEADLINE_KINDS))) return undefined;
		if (!optional(firstEventMs, isFiniteNumber)) return undefined;
		if (!optional(firstAssistantMs, isFiniteNumber)) return undefined;
		if (!optional(startOffsetMs, isFiniteNumber)) return undefined;
		if (!optional(endOffsetMs, isFiniteNumber)) return undefined;
		if (!optional(fallbackBudgetRejected, isBoolean)) return undefined;
		if (!optional(deadlineSource, isEnum(LANE_DEADLINE_SOURCES))) return undefined;
		if (!optional(batchDeadlineMs, isFiniteNumber)) return undefined;
		if (!optional(totalDeadlineMs, isFiniteNumber)) return undefined;
		if (!Array.isArray(attemptsSource)) return undefined;
		const attempts = [];
		for (const raw of attemptsSource) {
			const attempt = attemptArtifactSnapshot(raw);
			if (!attempt) return undefined;
			attempts.push(attempt);
		}
		// --- Snapshot phase: built only from the validated locals. ---
		const snapshot: Record<string, unknown> = {
			generation,
			key,
			passId,
			tier,
			rawText,
			exitCode,
			lifecycle,
			attempts: Object.freeze(attempts),
			fallbackUsed,
			elapsedMs,
			toolElapsedMs,
			toolCallCount,
		};
		withOptional(snapshot, "requestedPassOrdinal", requestedPassOrdinal);
		withOptional(snapshot, "minorHygiene", minorHygiene);
		withOptional(snapshot, "requestedModel", requestedModel);
		withOptional(snapshot, "observedModel", observedModel);
		withOptional(snapshot, "processSignal", processSignal);
		withOptional(snapshot, "stopReason", stopReason);
		withOptional(snapshot, "errorMessage", errorMessage);
		withOptional(snapshot, "deadlineExpired", deadlineExpired);
		withOptional(snapshot, "firstEventMs", firstEventMs);
		withOptional(snapshot, "firstAssistantMs", firstAssistantMs);
		withOptional(snapshot, "startOffsetMs", startOffsetMs);
		withOptional(snapshot, "endOffsetMs", endOffsetMs);
		withOptional(snapshot, "fallbackBudgetRejected", fallbackBudgetRejected);
		withOptional(snapshot, "deadlineSource", deadlineSource);
		withOptional(snapshot, "batchDeadlineMs", batchDeadlineMs);
		withOptional(snapshot, "totalDeadlineMs", totalDeadlineMs);
		return Object.freeze(snapshot) as ReviewLaneArtifact;
	} catch {
		// A throwing getter is a malformed artifact, never a crash at this boundary.
		return undefined;
	}
}

/**
 * Same one-read safe-snapshot contract for one retained lane attempt: every
 * property is read exactly once into locals, validated, and copied into a new
 * frozen plain snapshot; the hostile original is never reread.
 */
function attemptArtifactSnapshot(value: unknown): ReviewLaneAttemptArtifact | undefined {
	try {
		if (!value || typeof value !== "object") return undefined;
		const source = value as Record<string, unknown>;
		// --- One-read phase. ---
		const ordinal = source.ordinal;
		const rawText = source.rawText;
		const exitCode = source.exitCode;
		const lifecycle = source.lifecycle;
		const kind = source.kind;
		const requestedModel = source.requestedModel;
		const observedModel = source.observedModel;
		const usedTier = source.usedTier;
		const processSignal = source.processSignal;
		const stopReason = source.stopReason;
		const errorMessage = source.errorMessage;
		const deadlineExpired = source.deadlineExpired;
		const retryable = source.retryable;
		const elapsedMs = source.elapsedMs;
		const firstEventMs = source.firstEventMs;
		const firstAssistantMs = source.firstAssistantMs;
		const toolElapsedMs = source.toolElapsedMs;
		const toolCallCount = source.toolCallCount;
		const timedOut = source.timedOut;
		const terminationGraceMs = source.terminationGraceMs;
		const forcedTermination = source.forcedTermination;
		const deadlineMs = source.deadlineMs;
		const configuredDeadlineMs = source.configuredDeadlineMs;
		const budgetElapsedBeforeAttemptMs = source.budgetElapsedBeforeAttemptMs;
		const batchRemainingBeforeAttemptMs = source.batchRemainingBeforeAttemptMs;
		const totalRemainingBeforeAttemptMs = source.totalRemainingBeforeAttemptMs;
		// --- Validation phase (locals only). ---
		if (!isInteger(ordinal)) return undefined;
		if (!isString(rawText)) return undefined;
		if (!isInteger(exitCode)) return undefined;
		if (!isEnum(LANE_LIFECYCLES)(lifecycle)) return undefined;
		if (kind !== undefined && !isEnum(LANE_ATTEMPT_KINDS)(kind)) return undefined;
		if (!optional(requestedModel, isString)) return undefined;
		if (!optional(observedModel, isString)) return undefined;
		if (!optional(usedTier, isEnum(LANE_TIERS))) return undefined;
		if (!optional(processSignal, isString)) return undefined;
		if (!optional(stopReason, isString)) return undefined;
		if (!optional(errorMessage, isString)) return undefined;
		if (!optional(deadlineExpired, isEnum(LANE_DEADLINE_KINDS))) return undefined;
		if (!optional(retryable, isBoolean)) return undefined;
		if (!optional(elapsedMs, isFiniteNumber)) return undefined;
		if (!optional(firstEventMs, isFiniteNumber)) return undefined;
		if (!optional(firstAssistantMs, isFiniteNumber)) return undefined;
		if (!optional(toolElapsedMs, isFiniteNumber)) return undefined;
		if (!optional(toolCallCount, isInteger)) return undefined;
		if (!optional(timedOut, isBoolean)) return undefined;
		if (!optional(terminationGraceMs, isFiniteNumber)) return undefined;
		if (!optional(forcedTermination, isBoolean)) return undefined;
		if (!optional(deadlineMs, isFiniteNumber)) return undefined;
		if (!optional(configuredDeadlineMs, isFiniteNumber)) return undefined;
		if (!optional(budgetElapsedBeforeAttemptMs, isFiniteNumber)) return undefined;
		if (!optional(batchRemainingBeforeAttemptMs, isFiniteNumber)) return undefined;
		if (!optional(totalRemainingBeforeAttemptMs, isFiniteNumber)) return undefined;
		// --- Snapshot phase. ---
		const snapshot: Record<string, unknown> = {
			ordinal,
			rawText,
			exitCode,
			lifecycle,
		};
		withOptional(snapshot, "kind", kind);
		withOptional(snapshot, "requestedModel", requestedModel);
		withOptional(snapshot, "observedModel", observedModel);
		withOptional(snapshot, "usedTier", usedTier);
		withOptional(snapshot, "processSignal", processSignal);
		withOptional(snapshot, "stopReason", stopReason);
		withOptional(snapshot, "errorMessage", errorMessage);
		withOptional(snapshot, "deadlineExpired", deadlineExpired);
		withOptional(snapshot, "retryable", retryable);
		withOptional(snapshot, "elapsedMs", elapsedMs);
		withOptional(snapshot, "firstEventMs", firstEventMs);
		withOptional(snapshot, "firstAssistantMs", firstAssistantMs);
		withOptional(snapshot, "toolElapsedMs", toolElapsedMs);
		withOptional(snapshot, "toolCallCount", toolCallCount);
		withOptional(snapshot, "timedOut", timedOut);
		withOptional(snapshot, "terminationGraceMs", terminationGraceMs);
		withOptional(snapshot, "forcedTermination", forcedTermination);
		withOptional(snapshot, "deadlineMs", deadlineMs);
		withOptional(snapshot, "configuredDeadlineMs", configuredDeadlineMs);
		withOptional(snapshot, "budgetElapsedBeforeAttemptMs", budgetElapsedBeforeAttemptMs);
		withOptional(snapshot, "batchRemainingBeforeAttemptMs", batchRemainingBeforeAttemptMs);
		withOptional(snapshot, "totalRemainingBeforeAttemptMs", totalRemainingBeforeAttemptMs);
		return Object.freeze(snapshot) as ReviewLaneAttemptArtifact;
	} catch {
		// A throwing getter is a malformed attempt, never a crash at this boundary.
		return undefined;
	}
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
		try {
			// Read and validate every downstream-consumed field inside try/catch and
			// store the safe frozen snapshot, never the hostile original.
			const snapshot = laneArtifactSnapshot(artifact);
			if (
				!snapshot ||
				this.generation !== generation || snapshot.generation !== generation ||
				!this.expectedLanes.has(snapshot.key)
			) return false;
			const expected = this.expectedLanes.get(snapshot.key)!;
			if (snapshot.tier !== expected.tier || !!snapshot.minorHygiene !== expected.minorHygiene) return false;
			this.artifacts.set(snapshot.key, snapshot);
			return true;
		} catch {
			// Malformed artifacts (including throwing getters surfaced by the copy)
			// are rejected at this boundary; the deterministic degraded flow continues.
			return false;
		}
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
