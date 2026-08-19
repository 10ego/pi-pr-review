import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ReviewLaneArtifact } from "./pr-review-artifacts.ts";
import type { ReviewFindingLike, ReviewLike } from "./pr-review-publish.ts";

export type ReviewSynthesisQuality = "fully_parsed" | "partially_parsed" | "raw" | "lane_fallback";
export type ReviewSynthesisCompleteness = "complete" | "incomplete";

export interface ReviewSynthesisArtifact {
	readonly quality: ReviewSynthesisQuality;
	readonly rawText: string;
	readonly body: string;
	readonly review: ReviewLike;
	readonly laneArtifacts: readonly ReviewLaneArtifact[];
	readonly completeness: ReviewSynthesisCompleteness;
	readonly diagnostics: readonly string[];
}

function synthesisCompleteness(
	rawText: string,
	lanes: readonly ReviewLaneArtifact[],
	requiredDisclosurePresent = true,
): ReviewSynthesisCompleteness {
	return rawText.trim() && requiredDisclosurePresent && lanes.every((lane) => lane.lifecycle === "complete")
		? "complete"
		: "incomplete";
}

const MAX_SYNTHESIS_BODY_BYTES = 60_000;
const MAX_DISCLOSED_LANES = 64;
const MAX_DISCLOSED_PASS_ID_BYTES = 160;
const MAX_INLINE_BODY_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const RESERVED_MARKER = /<!--\s*pi-pr-review:/gi;
const FINDING_HEADING = /^(#{3,6})\s+(\[(?:P[0-3]|nit)\]\s+.+?)\s*$/gim;
const UNSAFE_TEXT_CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CANONICAL_SECTION_NAMES = new Set([
	"overview",
	"verification",
	"findings",
	"lane completeness",
	"strengths and notes",
]);

function containsReservedMarker(text: string): boolean {
	return /<!--\s*pi-pr-review:/i.test(text);
}

interface MarkdownHeading {
	readonly level: number;
	readonly name: string;
	readonly index: number;
	readonly length: number;
}

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

type HtmlBlock =
	| { readonly until: RegExp }
	| { readonly untilBlank: true; readonly cannotInterruptParagraph?: true };

function htmlBlockStart(line: string): HtmlBlock | undefined {
	const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:[ \t]+|>|$)/i.exec(line)?.[1];
	if (rawTag) return { until: new RegExp(`</${rawTag}[ \\t]*>`, "i") };
	if (/^ {0,3}<!--/.test(line)) return { until: /-->/ };
	if (/^ {0,3}<\?/.test(line)) return { until: /\?>/ };
	if (/^ {0,3}<![A-Z]/.test(line)) return { until: />/ };
	if (/^ {0,3}<!\[CDATA\[/.test(line)) return { until: /\]\]>/ };
	if (COMMONMARK_BLANK_TERMINATED_HTML.test(line)) return { untilBlank: true };
	if (COMMONMARK_COMPLETE_HTML_TAG.test(line)) return { untilBlank: true, cannotInterruptParagraph: true };
	return undefined;
}

function markdownHeadings(text: string): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	const lines = text.split("\n");
	let fence: { marker: "`" | "~"; length: number } | undefined;
	let htmlBlock: HtmlBlock | undefined;
	let paragraph: { index: number; lines: string[] } | undefined;
	let offset = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex]!;
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (
				fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length &&
				!fenceMatch[2]!.trim()
			) fence = undefined;
			offset += line.length + 1;
			continue;
		}
		if (htmlBlock) {
			if ("untilBlank" in htmlBlock ? !line.trim() : htmlBlock.until.test(line)) htmlBlock = undefined;
			offset += line.length + 1;
			continue;
		}
		const htmlStart = htmlBlockStart(line);
		if (htmlStart && !("cannotInterruptParagraph" in htmlStart && htmlStart.cannotInterruptParagraph && paragraph)) {
			paragraph = undefined;
			if ("untilBlank" in htmlStart || !htmlStart.until.test(line)) htmlBlock = htmlStart;
			offset += line.length + 1;
			continue;
		}
		if (fenceMatch && (fenceMatch[1]![0] === "~" || !fenceMatch[2]!.includes("`"))) {
			fence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
			paragraph = undefined;
			offset += line.length + 1;
			continue;
		}

		// CommonMark permits up to three leading spaces before an ATX heading.
		const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
		if (atx) {
			headings.push({
				level: atx[1]!.length,
				name: (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim(),
				index: offset,
				length: line.length,
			});
			paragraph = undefined;
			offset += line.length + 1;
			continue;
		}

		const paragraphLine = /^ {0,3}(\S(?:.*?\S)?)\s*$/.exec(line)?.[1];
		if (!paragraphLine) {
			paragraph = undefined;
			offset += line.length + 1;
			continue;
		}
		paragraph ??= { index: offset, lines: [] };
		paragraph.lines.push(paragraphLine.trim());

		// A setext underline applies to the complete preceding paragraph, whose
		// rendered heading text joins its source lines with spaces.
		const underline = /^ {0,3}(=+|-+)[ \t]*\r?$/.exec(lines[lineIndex + 1] ?? "");
		if (underline) {
			const underlineLine = lines[lineIndex + 1]!;
			headings.push({
				level: underline[1]![0] === "=" ? 1 : 2,
				name: paragraph.lines.join(" "),
				index: paragraph.index,
				length: offset + line.length + 1 + underlineLine.length - paragraph.index,
			});
			paragraph = undefined;
			offset += line.length + 1 + underlineLine.length + 1;
			lineIndex++;
			continue;
		}
		offset += line.length + 1;
	}
	return headings;
}

function hasUnambiguousCanonicalSections(text: string): boolean {
	const seen = new Set<string>();
	for (const heading of markdownHeadings(text)) {
		const name = heading.name.toLowerCase();
		const canonical = CANONICAL_SECTION_NAMES.has(name);
		if (heading.level === 2) {
			if (!canonical || seen.has(name)) return false;
			seen.add(name);
		} else if (canonical) {
			return false;
		}
	}
	return true;
}

interface MarkdownSection {
	readonly level: number;
	readonly body: string;
}

function markdownSection(text: string, name: string): MarkdownSection | undefined {
	const headings = markdownHeadings(text);
	const matchIndex = headings.findIndex(
		(heading) => heading.level >= 2 && heading.name.toLowerCase() === name.toLowerCase(),
	);
	if (matchIndex < 0) return undefined;
	const match = headings[matchIndex]!;
	const start = match.index + match.length;
	let end = text.length;
	for (const heading of headings.slice(matchIndex + 1)) {
		if (heading.level <= match.level) {
			end = heading.index;
			break;
		}
	}
	return { level: match.level, body: text.slice(start, end).trim() };
}

function section(text: string, name: string): string | undefined {
	return markdownSection(text, name)?.body;
}

function field(text: string, name: string): string | undefined {
	const match = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, "im").exec(text);
	return match?.[1]?.trim();
}

function fieldCount(text: string, name: string): number {
	return [...text.matchAll(new RegExp(`^\\*\\*${name}:\\*\\*`, "gim"))].length;
}

function publicationSafeText(value: string | undefined, maxBytes = MAX_SYNTHESIS_BODY_BYTES): boolean {
	return value !== undefined && !UNSAFE_TEXT_CONTROL.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function publicationSafeInlineText(title: string, body: string): boolean {
	const rendered = [title.trim() ? `**${title.trim()}**` : "", body.trim()].filter(Boolean).join("\n\n");
	return !!rendered && !UNSAFE_TEXT_CONTROL.test(rendered) &&
		Buffer.byteLength(rendered, "utf8") <= MAX_INLINE_BODY_BYTES;
}

function sanitize(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(new RegExp(UNSAFE_TEXT_CONTROL.source, "g"), "�")
		.replace(RESERVED_MARKER, "&lt;!-- pi-pr-review:")
		.trim();
}

function truncateUtf8(text: string, maxBytes = MAX_SYNTHESIS_BODY_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = "\n\n> Review content was truncated by the host to fit GitHub's payload limit.";
	const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
		else high = mid - 1;
	}
	return `${text.slice(0, low)}${suffix}`;
}

export function safeReviewBody(text: string): string {
	return truncateUtf8(sanitize(text));
}

type ParsedLocation =
	| { readonly status: "absent"; readonly location: null }
	| { readonly status: "valid"; readonly location: NonNullable<ReviewFindingLike["code_location"]> }
	| { readonly status: "unsafe"; readonly location: null };

function parseLocation(value: string | undefined): ParsedLocation {
	if (!value) return { status: "absent", location: null };
	const normalized = value.replace(/^`|`$/g, "").trim();
	const match = /^(.*?):(\d+)(?:-(\d+))?\s+(LEFT|RIGHT)$/i.exec(normalized);
	if (!match) return { status: "unsafe", location: null };
	const start = Number(match[2]);
	const end = Number(match[3] ?? match[2]);
	const path = match[1]!;
	if (
		!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start ||
		!path || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES || UNSAFE_TEXT_CONTROL.test(path) ||
		path.startsWith("/") || path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	) {
		return { status: "unsafe", location: null };
	}
	return {
		status: "valid",
		location: {
			absolute_file_path: path,
			line_range: { start, end },
			side: match[4]!.toUpperCase(),
			commentable: true,
		},
	};
}

function parseFindings(text: string): { findings: ReviewFindingLike[]; count: number; complete: boolean; unsafe: boolean } {
	const findingsSection = markdownSection(text, "Findings");
	if (!findingsSection) return { findings: [], count: 0, complete: false, unsafe: containsReservedMarker(text) };
	const content = findingsSection.body;
	const matches = [...content.matchAll(FINDING_HEADING)].filter(
		(match) => match[1]!.length > findingsSection.level,
	);
	const findings: ReviewFindingLike[] = [];
	const noFindings = /^\s*(?:[-*]\s*)?no findings[.!]?\s*$/i.test(content);
	let complete = noFindings || matches.length > 0;
	let unsafe = containsReservedMarker(text) || UNSAFE_TEXT_CONTROL.test(text) ||
		!hasUnambiguousCanonicalSections(text);

	// Every nested heading in the Findings section must be one of the canonical
	// severity-tagged headings. Otherwise deterministic extraction did not
	// consume the complete finding structure.
	const nestedHeadings = [...content.matchAll(/^(#{3,6})\s+.+$/gm)].filter(
		(match) => match[1]!.length > findingsSection.level,
	);
	if (nestedHeadings.length !== matches.length) complete = false;
	const prefix = content.slice(0, matches[0]?.index ?? content.length).trim();
	if (matches.length > 0 && prefix) complete = false;
	if (matches.length === 0 && !noFindings && content.trim()) complete = false;

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? content.length;
		const block = content.slice(start, end);
		const title = match[2]!.trim();
		const tagged = /^\[(P[0-3]|nit)\]/i.exec(title)?.[1];
		const explicitSeverity = field(block, "Severity");
		const severity = explicitSeverity?.toLowerCase() === "nit" ? "nit" : explicitSeverity?.toUpperCase();
		const normalizedTag = tagged?.toLowerCase() === "nit" ? "nit" : tagged?.toUpperCase();
		const rationale = field(block, "Rationale") ?? field(block, "Why");
		const location = parseLocation(field(block, "Location"));
		const recognizedFieldCount = fieldCount(block, "Severity") + fieldCount(block, "Rationale") +
			fieldCount(block, "Why") + fieldCount(block, "Location");
		const unconsumed = block.replace(/^\*\*(?:Severity|Rationale|Why|Location):\*\*.*$/gim, "").trim();
		if (
			!explicitSeverity || !rationale?.trim() || recognizedFieldCount < 2 || unconsumed ||
			fieldCount(block, "Severity") !== 1 || fieldCount(block, "Rationale") + fieldCount(block, "Why") !== 1 ||
			fieldCount(block, "Location") > 1
		) {
			complete = false;
			continue;
		}
		const invalidExtractedContent =
			!severity || !new Set(["P0", "P1", "P2", "P3", "nit"]).has(severity) ||
			severity !== normalizedTag || !publicationSafeInlineText(title, rationale) ||
			location.status === "unsafe";
		if (invalidExtractedContent) {
			unsafe = true;
			complete = false;
			continue;
		}
		findings.push({
			title,
			severity,
			blocking: severity === "P0" || severity === "P1",
			body: rationale,
			confidence_score: 1,
			code_location: location.location,
		});
	}
	if (findings.length !== matches.length) complete = false;
	return { findings, count: matches.length, complete, unsafe };
}

function publicationSafeStrictReview(review: ReviewLike): boolean {
	const strings = [
		review.verification, review.overview, review.overall_explanation,
		...(review.strengths ?? []),
		review.notes?.correctness, review.notes?.security, review.notes?.performance,
	];
	if (strings.some((value) => typeof value === "string" && !publicationSafeText(value))) return false;
	for (const finding of review.findings ?? []) {
		const title = finding.title ?? "";
		const body = finding.body ?? "";
		const path = finding.code_location?.absolute_file_path;
		if (
			!publicationSafeInlineText(title, body) ||
			(typeof path === "string" && (UNSAFE_TEXT_CONTROL.test(path) || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES))
		) return false;
	}
	return true;
}

function syntheticReview(prNumber: number, title: string, headSha: string, text: string, findings: ReviewFindingLike[] = []): ReviewLike {
	const overview = section(text, "Overview") ?? text;
	const verification = section(text, "Verification") ?? "Verification status was not structurally available.";
	// Markdown is intentionally not trusted to select a merge-relevant event.
	// Preserve its apparent verdict in the raw body, but make the canonical
	// Markdown-derived review COMMENT-only. Strict host-bound JSON bypasses this
	// synthetic representation and retains its otherwise-qualified approval.
	const verdict = "comment";
	return {
		pr: { number: prNumber, title, head_sha: headSha },
		disposition: "reviewed",
		verification,
		overview,
		strengths: [],
		findings,
		notes: { correctness: "", security: "", performance: "" },
		verdict,
		overall_correctness: verdict === "request_changes" ? "patch is incorrect" : "patch is correct",
		overall_explanation: overview.split(/\n\n|\n/)[0] ?? "Review completed.",
		overall_confidence_score: 1,
	};
}

function retainedLaneText(lane: ReviewLaneArtifact): string {
	if (lane.rawText.trim()) return lane.rawText.trim();
	// A retryable fallback can fail before emitting text. Do not let that empty
	// terminal attempt erase usable partial evidence retained earlier.
	for (let index = lane.attempts.length - 1; index >= 0; index--) {
		const text = lane.attempts[index]?.rawText.trim();
		if (text) return text;
	}
	return "";
}

function disclosedPassId(passId: string): string {
	const normalized = passId.replace(new RegExp(UNSAFE_TEXT_CONTROL.source, "g"), "_").replace(/[\r\n]/g, "_").trim();
	const sanitized = normalized.replace(/[^A-Za-z0-9._:@/-]+/g, "_") || "unnamed-pass";
	const needsDigest = sanitized !== normalized || Buffer.byteLength(sanitized, "utf8") > MAX_DISCLOSED_PASS_ID_BYTES;
	if (!needsDigest) return sanitized;
	const digest = createHash("sha256").update(passId).digest("hex").slice(0, 16);
	const suffix = `… [sha256:${digest}]`;
	const prefixBudget = MAX_DISCLOSED_PASS_ID_BYTES - Buffer.byteLength(suffix, "utf8");
	let low = 0;
	let high = sanitized.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(sanitized.slice(0, mid), "utf8") <= prefixBudget) low = mid;
		else high = mid - 1;
	}
	return `${sanitized.slice(0, low)}${suffix}`;
}

function incompleteLaneDisclosure(lanes: readonly ReviewLaneArtifact[]): string {
	const incomplete = lanes.filter((lane) => lane.lifecycle !== "complete");
	if (incomplete.length === 0) return "";
	const counts = (["partial", "timed_out", "failed"] as const)
		.map((lifecycle) => `${lifecycle}=${incomplete.filter((lane) => lane.lifecycle === lifecycle).length}`)
		.join("; ");
	const disclosed = incomplete.slice(0, MAX_DISCLOSED_LANES);
	return [
		"Host-verified incomplete requested lenses/shards:",
		`Exact incomplete lifecycle counts: ${counts}.`,
		...disclosed.map((lane) => `- ${JSON.stringify(disclosedPassId(lane.passId))} — \`${lane.lifecycle}\``),
		...(incomplete.length > disclosed.length
			? [`- ${incomplete.length - disclosed.length} additional incomplete lane identifier(s) omitted; exact lifecycle counts remain above.`]
			: []),
	].join("\n");
}

function bindIncompleteLaneDisclosure(raw: string, lanes: readonly ReviewLaneArtifact[]): string {
	const disclosure = incompleteLaneDisclosure(lanes);
	if (!disclosure) return raw;
	const text = raw.replace(/All requested lanes completed\.?/gi, "Host verification found incomplete requested lanes.");
	const headings = markdownHeadings(text);
	const matches = headings.filter((heading) => heading.level === 2 && heading.name.toLowerCase() === "lane completeness");
	if (matches.length !== 1) {
		return `${text.trim()}\n\n## Host-verified lane completeness\n${disclosure}`.trim();
	}
	const match = matches[0]!;
	const bodyStart = match.index + match.length;
	const next = headings.find((heading) => heading.index > match.index && heading.level <= match.level);
	const bodyEnd = next?.index ?? text.length;
	const assistantDisclosure = text.slice(bodyStart, bodyEnd).trim();
	return `${text.slice(0, bodyStart)}\n${assistantDisclosure}${assistantDisclosure ? "\n\n" : ""}${disclosure}\n\n${text.slice(bodyEnd)}`.trim();
}

function safeReviewBodyWithLaneDisclosure(raw: string, lanes: readonly ReviewLaneArtifact[]): string {
	const bound = bindIncompleteLaneDisclosure(raw, lanes);
	const body = safeReviewBody(bound);
	const disclosure = incompleteLaneDisclosure(lanes);
	if (!disclosure || body.includes(disclosure)) return body;
	const suffix = sanitize(`\n\n## Host-verified lane completeness\n${disclosure}`);
	const prefixBudget = MAX_SYNTHESIS_BODY_BYTES - Buffer.byteLength(suffix, "utf8") - 2;
	if (prefixBudget <= 0) return safeReviewBody(suffix);
	return `${truncateUtf8(sanitize(bound), prefixBudget)}\n\n${suffix}`;
}

function retainedLaneEvidence(lanes: readonly ReviewLaneArtifact[]): string {
	if (lanes.length === 0) return "";
	const lines = ["## Host-retained lane evidence", ""];
	for (const lane of lanes.slice(0, MAX_DISCLOSED_LANES)) {
		lines.push(`### ${disclosedPassId(lane.passId)} — ${lane.lifecycle}`, "");
		const text = retainedLaneText(lane);
		if (text) lines.push(text, "");
		else lines.push(`No substantive output was retained${lane.errorMessage ? `: ${lane.errorMessage}` : "."}`, "");
	}
	if (lanes.length > MAX_DISCLOSED_LANES) {
		lines.push(`### ${lanes.length - MAX_DISCLOSED_LANES} additional lane artifact(s) omitted`, "");
	}
	return lines.join("\n").trim();
}

function laneFallback(lanes: readonly ReviewLaneArtifact[]): string {
	const lines = ["# PR Review", "", "**Verdict:** comment", "", "## Lane completeness", ""];
	if (lanes.length === 0) {
		lines.push("- No synthesis or retained lane output was available.");
		return lines.join("\n");
	}
	lines.push(retainedLaneEvidence(lanes));
	return lines.join("\n").trim();
}

function synthesisWithRetainedLaneEvidence(raw: string, lanes: readonly ReviewLaneArtifact[]): string {
	const evidence = retainedLaneEvidence(lanes);
	return evidence ? `${raw.trim()}\n\n${evidence}`.trim() : raw;
}

/** Build the canonical semantic artifact while taking every authority field from the host binding. */
export function synthesizeReviewArtifact(input: {
	rawText: string;
	prNumber: number;
	prTitle: string;
	headSha: string;
	laneArtifacts?: readonly ReviewLaneArtifact[];
	strictJsonReview?: ReviewLike;
}): ReviewSynthesisArtifact {
	const lanes = Object.freeze([...(input.laneArtifacts ?? [])]);
	if (input.strictJsonReview) {
		const completeness = synthesisCompleteness(input.rawText, lanes);
		const safe = publicationSafeStrictReview(input.strictJsonReview);
		const bodyFallback = !safe || completeness === "incomplete";
		const body = bodyFallback
			? safeReviewBodyWithLaneDisclosure(synthesisWithRetainedLaneEvidence(input.rawText, lanes), lanes)
			: "";
		return Object.freeze({
			quality: bodyFallback ? "raw" as const : "fully_parsed" as const,
			rawText: input.rawText,
			body,
			// Strict JSON is a legacy semantic format, not publication authority.
			// Rebind every target field to the frozen host snapshot so an assistant
			// cannot substitute the final head and bypass stale-head handling.
			review: bodyFallback
				? syntheticReview(input.prNumber, input.prTitle, input.headSha, body)
				: {
						...input.strictJsonReview,
						pr: { number: input.prNumber, title: input.prTitle, head_sha: input.headSha },
					},
			laneArtifacts: lanes,
			completeness,
			diagnostics: Object.freeze(bodyFallback
				? [safe
					? "incomplete lane evidence forced sanitized body-only publication"
					: "publication-invalid extracted content forced sanitized body-only publication"]
				: []),
		});
	}
	const raw = input.rawText.trim();
	if (!raw) {
		const completeness = synthesisCompleteness(input.rawText, lanes);
		// The retained evidence itself can exceed the publication cap. Apply the
		// same host-owned disclosure reservation used for raw synthesis so an
		// early large lane cannot truncate away exact later incomplete shards.
		const body = safeReviewBodyWithLaneDisclosure(laneFallback(lanes), lanes);
		return Object.freeze({
			quality: "lane_fallback" as const,
			rawText: input.rawText,
			body,
			review: syntheticReview(input.prNumber, input.prTitle, input.headSha, body),
			laneArtifacts: lanes,
			completeness,
			diagnostics: Object.freeze(["terminal synthesis was absent; body assembled deterministically from retained lanes"]),
		});
	}
	const parsed = parseFindings(raw);
	const overview = section(raw, "Overview");
	const verification = section(raw, "Verification");
	const laneDisclosure = section(raw, "Lane completeness");
	const verdict = field(raw, "Verdict")?.toLowerCase().replace(/[ -]+/g, "_");
	const extractedControlsSafe = publicationSafeText(overview) && publicationSafeText(verification) &&
		publicationSafeText(laneDisclosure) && publicationSafeText(field(raw, "Verdict")) &&
		new Set(["approve", "request_changes", "comment"]).has(verdict ?? "") && fieldCount(raw, "Verdict") === 1;
	const canonicalParsed = parsed.unsafe ? parsed : { ...parsed, unsafe: !extractedControlsSafe };
	const completeness = synthesisCompleteness(raw, lanes, !!laneDisclosure?.trim());
	const hasStructure = !!overview && !!verification && !!laneDisclosure?.trim() && extractedControlsSafe;
	const quality: ReviewSynthesisQuality = canonicalParsed.unsafe
		? "raw"
		: hasStructure && canonicalParsed.complete && completeness === "complete"
			? "fully_parsed"
			: canonicalParsed.findings.length > 0 ? "partially_parsed" : "raw";
	// Markdown is the durable semantic product. Keep it in the body even when
	// deterministic extraction also makes safe inline placement available. Host
	// lane artifacts override contradictory assistant completion claims.
	const bodySource = quality === "fully_parsed" ? raw : synthesisWithRetainedLaneEvidence(raw, lanes);
	const body = safeReviewBodyWithLaneDisclosure(bodySource, lanes);
	const safeFindings = canonicalParsed.unsafe ? [] : canonicalParsed.findings;
	return Object.freeze({
		quality,
		rawText: input.rawText,
		body,
		review: syntheticReview(input.prNumber, input.prTitle, input.headSha, body, safeFindings),
		laneArtifacts: lanes,
		completeness,
		diagnostics: Object.freeze(canonicalParsed.unsafe
			? ["unsafe Markdown fields were preserved in the sanitized body and inline extraction was disabled"]
			: quality === "partially_parsed"
				? [completeness === "incomplete"
					? "incomplete lane disclosure or evidence forced sanitized body-only publication"
					: `${parsed.count - parsed.findings.length} finding section(s) could not be parsed and remain in the body`]
				: quality === "raw" ? ["terminal synthesis was not structurally parseable; preserved as body-only Markdown"] : []),
	});
}
