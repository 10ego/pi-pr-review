import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	extractValidatedReviewLaneCandidates,
	type ExpectedReviewLane,
	type ReviewLaneArtifact,
} from "./pr-review-artifacts.ts";
import type { ReviewFindingLike, ReviewLike } from "./pr-review-publish.ts";

export type ReviewSynthesisQuality = "fully_parsed" | "partially_parsed" | "raw" | "lane_fallback";
export type ReviewSynthesisCompleteness = "complete" | "incomplete";

export interface ReviewSynthesisArtifact {
	readonly quality: ReviewSynthesisQuality;
	readonly rawText: string;
	readonly body: string;
	readonly review: ReviewLike;
	readonly laneArtifacts: readonly ReviewLaneArtifact[];
	readonly expectedLaneDescriptors: readonly ExpectedReviewLane[];
	readonly expectedLaneCount: number;
	readonly completeness: ReviewSynthesisCompleteness;
	/** Whether this artifact may proceed to the host's remaining APPROVE gates. */
	readonly mergeApprovalEligible: boolean;
	readonly diagnostics: readonly string[];
}

function synthesisCompleteness(
	rawText: string,
	lanes: readonly ReviewLaneArtifact[],
	completeDisclosurePresent = true,
): ReviewSynthesisCompleteness {
	return rawText.trim() && completeDisclosurePresent && lanes.every((lane) => lane.lifecycle === "complete")
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

function markdownStructure(text: string): { headings: MarkdownHeading[]; visibleText: string } {
	const headings: MarkdownHeading[] = [];
	const lines = text.split("\n");
	const visibleLines = [...lines];
	const hide = (lineIndex: number): void => {
		visibleLines[lineIndex] = " ".repeat(lines[lineIndex]!.length);
	};
	let fence: { marker: "`" | "~"; length: number } | undefined;
	let htmlBlock: HtmlBlock | undefined;
	let paragraph: { index: number; lines: string[]; container: boolean } | undefined;
	let offset = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex]!;
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			hide(lineIndex);
			if (
				fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length &&
				!fenceMatch[2]!.trim()
			) fence = undefined;
			offset += line.length + 1;
			continue;
		}
		if (htmlBlock) {
			hide(lineIndex);
			if ("untilBlank" in htmlBlock ? !line.trim() : htmlBlock.until.test(line)) htmlBlock = undefined;
			offset += line.length + 1;
			continue;
		}
		const htmlStart = htmlBlockStart(line);
		const atxStart = /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line);
		const validFenceStart = !!fenceMatch && (fenceMatch[1]![0] === "~" || !fenceMatch[2]!.includes("`"));
		// CommonMark permits blockquote and list-item paragraphs to continue lazily
		// without a container marker. Such a line is still container content, so it cannot supply a
		// host control field such as Verdict. Block constructs that interrupt a
		// paragraph are processed normally below.
		const containerLine = /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.test(line);
		if (
			paragraph?.container && !containerLine && line.trim() &&
			!htmlStart && !atxStart && !validFenceStart
		) {
			hide(lineIndex);
			offset += line.length + 1;
			continue;
		}
		if (htmlStart && !("cannotInterruptParagraph" in htmlStart && htmlStart.cannotInterruptParagraph && paragraph)) {
			hide(lineIndex);
			paragraph = undefined;
			if ("untilBlank" in htmlStart || !htmlStart.until.test(line)) htmlBlock = htmlStart;
			offset += line.length + 1;
			continue;
		}
		if (validFenceStart) {
			hide(lineIndex);
			fence = { marker: fenceMatch![1]![0] as "`" | "~", length: fenceMatch![1]!.length };
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
		if (!paragraph || containerLine) {
			paragraph = { index: offset, lines: [], container: containerLine };
		}
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
	return { headings, visibleText: visibleLines.join("\n") };
}

function markdownHeadings(text: string): MarkdownHeading[] {
	return markdownStructure(text).headings;
}

function markdownVisibleText(text: string): string {
	return markdownStructure(text).visibleText;
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
	readonly bodyStart: number;
	readonly end: number;
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
	return { level: match.level, body: text.slice(start, end).trim(), bodyStart: start, end };
}

function section(text: string, name: string): string | undefined {
	return markdownSection(text, name)?.body;
}

function documentPreamble(text: string): string {
	const firstSection = markdownHeadings(text).find((heading) => heading.level === 2);
	return firstSection ? text.slice(0, firstSection.index) : text;
}

function field(text: string, name: string): string | undefined {
	const match = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, "im").exec(markdownVisibleText(text));
	return match?.[1]?.trim();
}

function fieldCount(text: string, name: string): number {
	return [...markdownVisibleText(text).matchAll(new RegExp(`^\\*\\*${name}:\\*\\*`, "gim"))].length;
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
	const visibleContent = markdownVisibleText(content);
	const matches = [...visibleContent.matchAll(FINDING_HEADING)].filter(
		(match) => match[1]!.length > findingsSection.level,
	);
	const findings: ReviewFindingLike[] = [];
	const noFindings = /^\s*(?:[-*]\s*)?no findings[.!]?\s*$/i.test(content);
	let complete = noFindings || matches.length > 0;
	let unsafe = containsReservedMarker(text) || UNSAFE_TEXT_CONTROL.test(text) ||
		!hasUnambiguousCanonicalSections(text);
	// A severity-tagged heading outside the canonical Findings section is
	// ambiguous review content. Never omit it from a concise approval-capable
	// artifact merely because it appeared under Overview or another section.
	const visibleText = markdownVisibleText(text);
	const severityHeadings = markdownHeadings(text).filter(
		(heading) => heading.level >= 3 && /^\[(?:P[0-3]|nit)\]\s+/i.test(heading.name),
	);
	if (severityHeadings.some((heading) =>
		heading.index < findingsSection.bodyStart || heading.index >= findingsSection.end
	)) complete = false;
	// Container-prefixed headings (for example `> ### [P1]`) are visible
	// CommonMark but are deliberately outside this small parser's extraction
	// grammar. A raw visible severity heading that the structural scanner did not
	// recognize therefore makes the artifact body-only rather than silently
	// dropping a possible blocker.
	const visibleSeverityHeadingLines = [
		...visibleText.matchAll(/^.*#{3,6}[ \t]+\[(?:P[0-3]|nit)\][ \t]+.+$/gim),
	].length;
	if (visibleSeverityHeadingLines !== severityHeadings.length) complete = false;

	// Every nested heading in the Findings section must be one of the canonical
	// severity-tagged headings. Otherwise deterministic extraction did not
	// consume the complete finding structure.
	const nestedHeadings = [...visibleContent.matchAll(/^(#{3,6})\s+.+$/gm)].filter(
		(match) => match[1]!.length > findingsSection.level,
	);
	if (nestedHeadings.length !== matches.length) complete = false;
	const prefix = visibleContent.slice(0, matches[0]?.index ?? visibleContent.length).trim();
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
		const confidenceText = field(block, "Confidence");
		const confidence = confidenceText === undefined ? undefined : Number(confidenceText.trim());
		const validConfidence = confidenceText !== undefined &&
			/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText.trim()) && Number.isFinite(confidence);
		const location = parseLocation(field(block, "Location"));
		const recognizedFieldCount = fieldCount(block, "Severity") + fieldCount(block, "Rationale") +
			fieldCount(block, "Why") + fieldCount(block, "Confidence") + fieldCount(block, "Location");
		const unconsumed = block.replace(/^\*\*(?:Severity|Rationale|Why|Confidence|Location):\*\*.*$/gim, "").trim();
		if (
			!explicitSeverity || !rationale?.trim() || recognizedFieldCount < 2 || unconsumed || !validConfidence ||
			fieldCount(block, "Severity") !== 1 || fieldCount(block, "Rationale") + fieldCount(block, "Why") !== 1 ||
			fieldCount(block, "Confidence") !== 1 || fieldCount(block, "Location") > 1
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
			confidence_score: confidence,
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

function syntheticReview(
	prNumber: number,
	title: string,
	headSha: string,
	text: string,
	findings: ReviewFindingLike[] = [],
	allowApparentVerdict = false,
	allowApprovalVerdict = false,
): ReviewLike {
	const overview = section(text, "Overview") ?? text;
	const verification = section(text, "Verification") ?? "Verification status was not structurally available.";
	// This is semantic review state, not a GitHub event. Publication may map a
	// fully parsed, complete `approve` through the same host-owned approval gates
	// as strict JSON. Degraded artifacts remain COMMENT-only at that boundary.
	const apparentVerdict = field(text, "Verdict")?.toLowerCase().replace(/[ -]+/g, "_");
	const apparentSemanticVerdict = allowApparentVerdict &&
		(apparentVerdict === "approve" || apparentVerdict === "request_changes" || apparentVerdict === "comment")
		? apparentVerdict === "approve" && !allowApprovalVerdict ? "comment" : apparentVerdict
		: "comment";
	const verdict = findings.some((finding) => finding.severity === "P0" || finding.severity === "P1")
		? "request_changes"
		: apparentSemanticVerdict;
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

function retainedLaneFindings(
	lanes: readonly ReviewLaneArtifact[],
	expected: readonly ExpectedReviewLane[],
): ReviewFindingLike[] {
	const findings: ReviewFindingLike[] = [];
	const seen = new Set<string>();
	for (const lane of lanes) {
		const contract = expected.find((descriptor) => descriptor.key === lane.key)?.expectedOutput ?? "review_lane";
		for (const candidate of extractValidatedReviewLaneCandidates(retainedLaneText(lane), contract)) {
			if (!candidate.prRelated) continue;
			const parsedLocation = candidate.location === "repo-wide"
				? { status: "absent" as const, location: null }
				: parseLocation(`${candidate.location} ${candidate.side}`);
			if (parsedLocation.status === "unsafe") continue;
			const codeLocation = parsedLocation.location
				? { ...parsedLocation.location, commentable: candidate.inDiff }
				: null;
			const key = JSON.stringify([
				candidate.severity,
				candidate.title,
				candidate.why,
				candidate.location,
				candidate.side,
			]);
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({
				title: candidate.title,
				severity: candidate.severity,
				blocking: candidate.severity === "P0" || candidate.severity === "P1",
				body: candidate.why,
				confidence_score: candidate.confidence,
				code_location: codeLocation,
			});
		}
	}
	return findings;
}

function mergeUniqueFindings(
	primary: readonly ReviewFindingLike[],
	additional: readonly ReviewFindingLike[],
): ReviewFindingLike[] {
	const merged = [...primary];
	const keys = new Set(merged.map((finding) => JSON.stringify([
		finding.severity,
		finding.title,
		finding.body,
		finding.code_location?.absolute_file_path,
		finding.code_location?.line_range?.start,
		finding.code_location?.line_range?.end,
		finding.code_location?.side,
	])));
	for (const finding of additional) {
		const key = JSON.stringify([
			finding.severity,
			finding.title,
			finding.body,
			finding.code_location?.absolute_file_path,
			finding.code_location?.line_range?.start,
			finding.code_location?.line_range?.end,
			finding.code_location?.side,
		]);
		if (keys.has(key)) continue;
		keys.add(key);
		merged.push(finding);
	}
	return merged;
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

/**
 * Shift ATX headings down (converting setext headings to ATX first) so
 * retained Markdown nests under host-owned sections. Text outside the heading
 * construct — including the heading's own label — is preserved byte-for-byte;
 * fenced-code and HTML-block content is never touched because markdownHeadings
 * only reports structural headings.
 */
export function demoteHeadings(text: string, levels = 1): string {
	const headings = markdownHeadings(text);
	if (headings.length === 0) return text;
	const shifted = "#".repeat(levels);
	let out = "";
	let cursor = 0;
	for (const heading of headings) {
		const construct = text.slice(heading.index, heading.index + heading.length);
		const atx = /^( {0,3})(#{1,6})([\s\S]*)$/.exec(construct);
		let replacement: string;
		if (atx) {
			// Indented ATX stays ATX; only the opening run grows (capped at six).
			const next = "#".repeat(Math.min(6, atx[2]!.length + levels));
			replacement = `${atx[1]!}${next}${atx[3]!}`;
		} else {
			// Setext: drop the underline and re-render the paragraph as one ATX line.
			const indent = /^[ \t]*/.exec(construct)![0];
			const next = "#".repeat(Math.min(6, heading.level + levels));
			replacement = `${indent}${next} ${heading.name}`;
		}
		out += `${text.slice(cursor, heading.index)}${replacement}`;
		cursor = heading.index + heading.length;
	}
	return out + text.slice(cursor);
}

function degradedFindingLocation(finding: ReviewFindingLike): string {
	const location = finding.code_location;
	const path = location?.absolute_file_path;
	if (!path) return "summary-only";
	const range = location?.line_range;
	const start = range?.start;
	const end = range?.end ?? start;
	const side = location?.side === "LEFT" ? "LEFT" : location?.side === "RIGHT" ? "RIGHT" : undefined;
	const linesPart = start !== undefined ? `:${start}${end !== undefined && end !== start ? `-${end}` : ""}` : "";
	return `${String(path)}${linesPart}${side ? ` ${side}` : ""}`;
}

/** Host-rendered finding blocks that match the canonical synthesis labels. */
function degradedFindingBlocks(findings: readonly ReviewFindingLike[]): string[] {
	if (findings.length === 0) return [];
	return findings.map((finding) => {
		const severity = String(finding.severity ?? "P2");
		const rawTitle = String(finding.title ?? "Finding").trim() || "Finding";
		// Parsed titles may already carry their severity tag; never double it.
		const title = rawTitle.replace(/^\[?(P0|P1|P2|P3|nit)\]\s*/i, "$1 ").replace(/^(P0|P1|P2|P3|nit)\s+/, "").trim() || rawTitle;
		const lines = [
			`### [${severity}] ${title}`,
			`**Severity:** ${severity}`,
		];
		if (finding.body?.trim()) lines.push(finding.body.trim());
		lines.push(`**Location:** \`${degradedFindingLocation(finding)}\``);
		return lines.join("\n");
	});
}

/**
 * Deterministic, readable body for degraded syntheses. The model's raw Markdown
 * and every retained lane artifact are preserved verbatim (only heading levels
 * shift) under explicit host-owned labels, parsed findings are rendered in the
 * canonical format, and coverage is disclosed instead of implied.
 */
function buildDegradedReviewBody(input: {
	rawText: string;
	lanes: readonly ReviewLaneArtifact[];
	findings: readonly ReviewFindingLike[];
	/** Findings allowed to influence the verdict line; defaults to `findings`. Extraction passes deterministic-only findings so model-claimed severity can never flip the verdict. */
	verdictFindings?: readonly ReviewFindingLike[];
	reason?: string;
	/** Host-registered dispatch count for exact-coverage disclosure. */
	expectedLaneCount?: number;
	/** Whether retained lanes cover every expected dispatch (host-computed). */
	exactCoverage?: boolean;
}): string {
	const blocking = (input.verdictFindings ?? input.findings).some((finding) => finding.severity === "P0" || finding.severity === "P1");
	const verdict = blocking ? "Request changes" : "Comment";
	const reason = input.reason?.trim();
	const lines: string[] = [
		"# PR Review",
		"",
		`**Verdict:** ${verdict}${reason ? ` — ${reason}` : ""}`,
		"",
		"## Coverage",
		"",
	];
	// The host's own voice may only claim completion when every retained lane
	// completed AND the retained artifacts cover every expected dispatch.
	const disclosure = incompleteLaneDisclosure(input.lanes);
	const expected = input.expectedLaneCount ?? 0;
	let coverage: string;
	if (input.lanes.length === 0 && expected === 0) {
		coverage = "No host lane evidence was retained for this review.";
	} else if (disclosure) {
		coverage = disclosure;
	} else if (expected === 0 || input.exactCoverage === true) {
		coverage = "All requested lanes completed.";
	} else {
		coverage = [
			"Host-verified incomplete requested lenses/shards:",
			"Exact incomplete lifecycle counts: partial=0; timed_out=0; failed=0.",
			`- retained lane artifacts do not cover every expected dispatch (${input.lanes.length} retained / ${expected} registered)`,
		].join("\n");
	}
	lines.push(coverage, "");
	const hasRetainedEvidence = input.rawText.trim().length > 0 || input.lanes.length > 0;
	lines.push("## Findings", "");
	if (input.findings.length === 0) {
		lines.push("No structurally parsed findings were extracted from this degraded synthesis.");
		if (hasRetainedEvidence) {
			lines.push("The retained reviewer output below is the authoritative record; it is not evidence of a clean review.");
		}
		lines.push("");
	} else {
		for (const block of degradedFindingBlocks(input.findings)) lines.push(block, "");
	}
	const synthesis = input.rawText.trim();
	if (synthesis) {
		// A retained synthesis may still carry a completion claim the host has
		// disproven; replace it so the published body never states both. With no
		// batch evidence the model's own claim stays authoritative.
		const claimComplete = coverage === "All requested lanes completed.";
		const batchEvidence = input.lanes.length > 0 || expected > 0;
		const reconciledCoverage = !claimComplete && batchEvidence
			? synthesis.replace(/All requested lanes completed\.?/gi, "Host verification found incomplete requested lanes.")
			: synthesis;
		// Retained model prose is evidence, not an authority surface. Neutralize
		// its top-level verdict label so automation and readers see exactly one
		// authoritative verdict: the host-owned preamble above.
		const reconciled = reconciledCoverage.replace(/^\s*\*\*Verdict:\*\*\s*/gmi, "**Model-reported verdict (non-authoritative):** ");
		// Two levels keep the synthesis's own document heading below the host
		// labels (its canonical "# PR Review" becomes a level-3 heading).
		lines.push("## Retained synthesis", "", demoteHeadings(reconciled, 2).trim(), "");
	}
	if (input.lanes.length > 0) {
		lines.push("## Retained lane output", "");
		for (const lane of input.lanes.slice(0, MAX_DISCLOSED_LANES)) {
			lines.push(`### ${disclosedPassId(lane.passId)} — ${lane.lifecycle}`, "");
			if (lane.deadlineExpired) {
				lines.push(`Host ${lane.deadlineExpired} deadline expired while this lane was still running.`, "");
			}
			const text = retainedLaneText(lane);
			if (text) lines.push(demoteHeadings(text, 2).trim(), "");
			else lines.push(`No substantive output was retained${lane.errorMessage ? `: ${lane.errorMessage}` : "."}`, "");
		}
		if (input.lanes.length > MAX_DISCLOSED_LANES) {
			lines.push(`### ${input.lanes.length - MAX_DISCLOSED_LANES} additional lane artifact(s) omitted`, "");
		}
	}
	return safeReviewBody(lines.join("\n").trim());
}

/** Build the canonical semantic artifact while taking every authority field from the host binding. */
export function synthesizeReviewArtifact(input: {
	rawText: string;
	prNumber: number;
	prTitle: string;
	headSha: string;
	laneArtifacts?: readonly ReviewLaneArtifact[];
	expectedLaneDescriptors?: readonly ExpectedReviewLane[];
	strictJsonReview?: ReviewLike;
}): ReviewSynthesisArtifact {
	const lanes = Object.freeze([...(input.laneArtifacts ?? [])]);
	const expectedLaneDescriptors = Object.freeze((input.expectedLaneDescriptors ?? [])
		.filter((lane) => !!lane && typeof lane.key === "string" && !!lane.key &&
			new Set(["light", "medium", "heavy"]).has(lane.tier) && typeof lane.minorHygiene === "boolean" &&
			(lane.expectedOutput === undefined || lane.expectedOutput === "review_lane" || lane.expectedOutput === "nonempty"))
		.map((lane) => Object.freeze({ ...lane })));
	const expectedLaneCount = expectedLaneDescriptors.length;
	const exactLaneCoverage = expectedLaneCount > 0 && lanes.length === expectedLaneCount &&
		new Set(lanes.map((lane) => lane.key)).size === expectedLaneCount &&
		new Set(expectedLaneDescriptors.map((lane) => lane.key)).size === expectedLaneCount &&
		lanes.every((lane) => expectedLaneDescriptors.some((expected) =>
			expected.key === lane.key && expected.tier === lane.tier &&
			expected.minorHygiene === !!lane.minorHygiene));
	const validatedLaneFindings = retainedLaneFindings(lanes, expectedLaneDescriptors);
	if (input.strictJsonReview) {
		// Strict JSON carries no assistant disclosure line; host lane evidence is
		// the only completeness authority whenever a batch ran.
		const batchEvidence = lanes.length > 0 || expectedLaneCount > 0;
		const completeness = synthesisCompleteness(
			input.rawText,
			lanes,
			batchEvidence ? lanes.every((lane) => lane.lifecycle === "complete") && (expectedLaneCount === 0 || exactLaneCoverage) : true,
		);
		const safe = publicationSafeStrictReview(input.strictJsonReview);
		const bodyFallback = !safe || completeness === "incomplete";
		const strictFindings = mergeUniqueFindings(
			safe ? (input.strictJsonReview.findings ?? []) : [],
			bodyFallback ? validatedLaneFindings : [],
		);
		const body = bodyFallback
			? buildDegradedReviewBody({
				rawText: input.rawText,
				lanes,
				findings: strictFindings,
				expectedLaneCount,
				exactCoverage: exactLaneCoverage || expectedLaneCount === 0,
				reason: safe
						? "incomplete lane evidence degraded this synthesis"
						: "publication-invalid extracted content degraded this synthesis",
			})
			: "";
		return Object.freeze({
			quality: bodyFallback ? "raw" as const : "fully_parsed" as const,
			rawText: input.rawText,
			body,
			// Strict JSON is a legacy semantic format, not publication authority.
			// Rebind every target field to the frozen host snapshot so an assistant
			// cannot substitute the final head and bypass stale-head handling.
			review: bodyFallback
				? syntheticReview(input.prNumber, input.prTitle, input.headSha, body, strictFindings)
				: {
						...input.strictJsonReview,
						pr: { number: input.prNumber, title: input.prTitle, head_sha: input.headSha },
					},
			laneArtifacts: lanes,
			expectedLaneDescriptors,
			expectedLaneCount,
			completeness,
			mergeApprovalEligible: !bodyFallback,
			diagnostics: Object.freeze(bodyFallback
				? [safe
					? "incomplete lane evidence degraded this synthesis"
					: "publication-invalid extracted content degraded this synthesis"]
				: []),
		});
	}
	const raw = input.rawText.trim().replace(/\r\n?/g, "\n");
	if (!raw) {
		const completeness = synthesisCompleteness(input.rawText, lanes);
		// Retained lane output is bounded by the host-owned body cap so an early
		// large lane cannot truncate away the coverage disclosure above it.
		const body = buildDegradedReviewBody({
			rawText: "",
			lanes,
			findings: validatedLaneFindings,
			expectedLaneCount,
			exactCoverage: exactLaneCoverage,
			reason: "terminal synthesis was absent",
		});
		return Object.freeze({
			quality: "lane_fallback" as const,
			rawText: input.rawText,
			body,
			review: syntheticReview(input.prNumber, input.prTitle, input.headSha, body, validatedLaneFindings),
			laneArtifacts: lanes,
			expectedLaneDescriptors,
			expectedLaneCount,
			completeness,
			mergeApprovalEligible: false,
			diagnostics: Object.freeze([
				"terminal synthesis was absent; body assembled deterministically from retained lanes",
				...(validatedLaneFindings.length > 0
					? [`recovered ${validatedLaneFindings.length} complete contract-valid finding(s) from retained lane output`]
					: []),
			]),
		});
	}
	const parsed = parseFindings(raw);
	const overview = section(raw, "Overview");
	const verification = section(raw, "Verification");
	const laneDisclosure = section(raw, "Lane completeness");
	const laneDisclosureClaimsComplete = /^all requested lanes completed\.?$/i.test(laneDisclosure?.trim() ?? "");
	// Host lane artifacts are authoritative whenever a batch ran: they already
	// stop a false complete claim from upgrading incomplete lanes, and they must
	// equally stop a paraphrased or omitted disclosure line from downgrading a
	// host-complete batch to body-only publication. Completeness additionally
	// requires the retained lanes to cover every expected dispatch, so an
	// expected-but-unretained artifact cannot make an incomplete batch look
	// complete through vacuous satisfaction.
	const batchEvidencePresent = lanes.length > 0 || expectedLaneCount > 0;
	const laneTruthClaimsComplete = batchEvidencePresent
		? lanes.every((lane) => lane.lifecycle === "complete") &&
			(expectedLaneCount === 0 || exactLaneCoverage)
		: laneDisclosureClaimsComplete;
	const preamble = documentPreamble(raw);
	const verdictField = field(preamble, "Verdict");
	const verdict = verdictField?.toLowerCase().replace(/[ -]+/g, "_");
	// A missing section is a structural gap handled by hasStructure and
	// diagnostics; only present-but-unsafe text disables inline extraction.
	const safeIfPresent = (value: string | undefined) => value === undefined || publicationSafeText(value);
	const extractedControlsSafe = safeIfPresent(overview) && safeIfPresent(verification) &&
		safeIfPresent(laneDisclosure) && safeIfPresent(verdictField) &&
		new Set(["approve", "request_changes", "comment"]).has(verdict ?? "") &&
		fieldCount(preamble, "Verdict") === 1 && fieldCount(raw, "Verdict") === 1;
	const canonicalParsed = parsed.unsafe ? parsed : { ...parsed, unsafe: !extractedControlsSafe };
	const completeness = synthesisCompleteness(raw, lanes, laneTruthClaimsComplete);
	const hasStructure = !!overview && !!verification && laneTruthClaimsComplete && extractedControlsSafe;
	const quality: ReviewSynthesisQuality = canonicalParsed.unsafe
		? "raw"
		: hasStructure && canonicalParsed.complete && completeness === "complete"
			? "fully_parsed"
			: canonicalParsed.findings.length > 0 ? "partially_parsed" : "raw";
	const parsedSynthesisFindings = canonicalParsed.unsafe ? [] : canonicalParsed.findings;
	const recoveredLaneFindings = quality === "fully_parsed" ? [] : validatedLaneFindings;
	const safeFindings = mergeUniqueFindings(parsedSynthesisFindings, recoveredLaneFindings);
	const degradationReasons = (() => {
		if (canonicalParsed.unsafe) {
			return ["unsafe Markdown fields were preserved in the sanitized body and inline extraction was disabled"];
		}
		if (quality === "fully_parsed") return [];
		const reasons: string[] = [];
		if (!overview) reasons.push("Overview section missing or empty");
		if (!verification) reasons.push("Verification section missing or empty");
		if (!laneTruthClaimsComplete) {
			if (lanes.length > 0 && !lanes.every((lane) => lane.lifecycle === "complete")) {
				reasons.push("host lane evidence contains incomplete lanes");
			} else if (expectedLaneCount > 0 && !exactLaneCoverage) {
				reasons.push("retained lane evidence does not cover every expected lane dispatch");
			} else {
				reasons.push("Lane completeness section absent or did not state the canonical completion line");
			}
		}
		if (verdictField !== undefined && !new Set(["approve", "request_changes", "comment"]).has(verdict ?? "")) {
			reasons.push("Verdict field outside the canonical set");
		}
		if (fieldCount(preamble, "Verdict") !== 1 || fieldCount(raw, "Verdict") !== 1) {
			reasons.push("Verdict field count is not exactly one");
		}
		if (parsed.count > parsed.findings.length) {
			reasons.push(`${parsed.count - parsed.findings.length} finding section(s) could not be parsed and remain in the body`);
		}
		if (recoveredLaneFindings.length > 0) {
			reasons.push(`recovered ${recoveredLaneFindings.length} complete contract-valid finding(s) from retained lane output`);
		}
		return reasons.length > 0 ? reasons : ["terminal synthesis was not structurally parseable; preserved as body-only Markdown"];
	})();
	// Markdown is the durable semantic product. Keep the complete deterministic
	// body for local rendering, cache diagnostics, and extraction. GitHub
	// publication independently renders a concise host summary for every quality.
	const body = quality === "fully_parsed"
		? safeReviewBody(raw)
		: buildDegradedReviewBody({
			rawText: raw,
			lanes,
			findings: safeFindings,
			expectedLaneCount,
			exactCoverage: exactLaneCoverage,
			reason: degradationReasons[0],
		});
	return Object.freeze({
		quality,
		rawText: input.rawText,
		body,
		review: syntheticReview(
			input.prNumber,
			input.prTitle,
			input.headSha,
			body,
			safeFindings,
			quality === "fully_parsed" && completeness === "complete",
			exactLaneCoverage,
		),
		laneArtifacts: lanes,
		expectedLaneDescriptors,
		expectedLaneCount,
		completeness,
		// Markdown approval requires exact host evidence for every registered
		// dispatch; a nonempty subset cannot establish requested coverage.
		mergeApprovalEligible: quality === "fully_parsed" && completeness === "complete" && exactLaneCoverage,
		diagnostics: Object.freeze(degradationReasons),
	});
}

/**
 * Merge host-validated extracted findings into a degraded artifact. The
 * deterministic verdict is preserved exactly: extracted severity never flips
 * the verdict line, eligibility stays false, and the rebuilt body keeps every
 * host label plus the retained evidence with the merged finding set rendered
 * through the same deterministic builder.
 */
export function mergeExtractedFindings(
	artifact: ReviewSynthesisArtifact,
	findings: readonly ReviewFindingLike[],
): ReviewSynthesisArtifact {
	if (findings.length === 0) return artifact;
	const merged = [...findings];
	// The verdict line is derived from deterministically parsed findings only.
	// Extracted (model-claimed) severity is display-only and can never flip it.
	const deterministicFindings = artifact.review.findings ?? [];
	const body = buildDegradedReviewBody({
		rawText: artifact.rawText,
		lanes: artifact.laneArtifacts,
		findings: merged,
		verdictFindings: deterministicFindings,
		expectedLaneCount: artifact.expectedLaneCount,
		exactCoverage: artifact.expectedLaneCount === 0 ||
			(artifact.laneArtifacts.length === artifact.expectedLaneCount &&
				new Set(artifact.laneArtifacts.map((lane) => lane.key)).size === artifact.expectedLaneCount &&
				new Set(artifact.expectedLaneDescriptors.map((lane) => lane.key)).size === artifact.expectedLaneCount &&
				artifact.laneArtifacts.every((lane) => artifact.expectedLaneDescriptors.some((expected) =>
					expected.key === lane.key && expected.tier === lane.tier &&
					expected.minorHygiene === !!lane.minorHygiene))),
		reason: artifact.diagnostics[0],
	});
	return Object.freeze({
		...artifact,
		body,
		// The deterministic verdict (already derived only from deterministically
		// parsed findings) is authoritative; only the findings set grows.
		review: { ...artifact.review, findings: merged },
		mergeApprovalEligible: false,
		diagnostics: Object.freeze([
			...artifact.diagnostics,
			...merged.some((finding) => finding.severity === "P0" || finding.severity === "P1")
				? ["extracted P0/P1 severity is model-claimed (unverified) and did not change the verdict"]
				: [],
		]),
	});
}
