/**
 * review-table
 *
 * Renders the /pr-review final JSON response as a full, readable review in the TUI:
 * header, verification, overview, strengths, a findings table (nit → P0) with
 * per-finding details, correctness/security/performance notes, and the verdict.
 *
 * Only rewrites in interactive TUI mode. In print / json / rpc modes the raw JSON is
 * left untouched so piping and automation keep a machine-readable payload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Severity = "P0" | "P1" | "P2" | "P3" | "nit";

interface Finding {
	title?: string;
	body?: string;
	severity?: string;
	blocking?: boolean;
	confidence_score?: number;
	priority?: number | null;
	code_location?: {
		absolute_file_path?: string | null;
		line_range?: { start?: number; end?: number };
	} | null;
}

interface Review {
	pr?: { number?: number | null; title?: string | null } | null;
	verification?: string;
	overview?: string;
	strengths?: string[];
	findings: Finding[];
	notes?: { correctness?: string; security?: string; performance?: string } | null;
	verdict?: string;
	overall_correctness?: string;
	overall_explanation?: string;
	overall_confidence_score?: number;
}

type MessagePart = { type: string; text?: string };

function assistantText(message: { content?: MessagePart[] }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("");
}

function hasToolCall(message: { content?: MessagePart[] }): boolean {
	return Array.isArray(message.content) && message.content.some((p) => p.type === "toolCall");
}

/** Extract the first balanced {...} object from a string (string-literal aware). */
function sliceBalancedObject(s: string): string | null {
	const start = s.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

function parseReview(text: string): Review | null {
	const candidates: string[] = [];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence?.[1]) candidates.push(fence[1]);
	candidates.push(text);
	for (const candidate of candidates) {
		const objStr = sliceBalancedObject(candidate);
		if (!objStr) continue;
		try {
			const parsed = JSON.parse(objStr) as Review;
			if (
				parsed &&
				typeof parsed === "object" &&
				Array.isArray(parsed.findings) &&
				(typeof parsed.overall_correctness === "string" || typeof parsed.verdict === "string")
			) {
				return parsed;
			}
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

function severityOf(f: Finding): Severity | null {
	const raw = (f.severity ?? "").toString().trim().toLowerCase();
	if (raw === "nit") return "nit";
	if (/^p[0-3]$/.test(raw)) return raw.toUpperCase() as Severity;
	if (typeof f.priority === "number" && f.priority >= 0 && f.priority <= 3) return `P${f.priority}` as Severity;
	const m = (f.title ?? "").match(/\[?\s*(p[0-3]|nit)\s*\]?/i);
	if (m) return m[1].toLowerCase() === "nit" ? "nit" : (m[1].toUpperCase() as Severity);
	return null;
}

function severityLabel(f: Finding): string {
	return severityOf(f) ?? "—";
}

function severityRank(f: Finding): number {
	const s = severityOf(f);
	return s ? SEVERITY_RANK[s] : 5;
}

function isBlocking(f: Finding): boolean {
	if (typeof f.blocking === "boolean") return f.blocking;
	const s = severityOf(f);
	return s === "P0" || s === "P1";
}

/** Strip a leading [Pn]/[nit] tag from a title (severity is shown in its own column). */
function titleText(f: Finding): string {
	return (f.title ?? "(untitled)").replace(/^\s*\[?\s*(?:p[0-3]|nit)\s*\]?\s*[-–:·]?\s*/i, "").trim() || "(untitled)";
}

function location(f: Finding): string {
	const p = f.code_location?.absolute_file_path;
	if (!p) return "—";
	const lr = f.code_location?.line_range;
	if (lr && lr.start != null) {
		const end = lr.end != null && lr.end !== lr.start ? `-${lr.end}` : "";
		return `${p}:${lr.start}${end}`;
	}
	return p;
}

function conf(n: number | undefined): string {
	return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
}

/** Escape a value for use inside a Markdown table cell. */
function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function verdictLine(r: Review): string {
	const v = (r.verdict ?? "").toLowerCase();
	const incorrect = /incorrect/i.test(r.overall_correctness ?? "");
	let icon: string;
	let label: string;
	if (v === "approve" || (!v && !incorrect)) {
		icon = "✅";
		label = "Approve";
	} else if (v === "request_changes" || (!v && incorrect)) {
		icon = "❌";
		label = "Request changes";
	} else {
		icon = "💬";
		label = "Comment";
	}
	const parts = [`${icon} **${label}**`];
	if (r.overall_explanation) parts.push(`— ${r.overall_explanation.trim()}`);
	if (r.overall_confidence_score != null) parts.push(`_(confidence ${conf(r.overall_confidence_score)})_`);
	return parts.join(" ");
}

function renderReviewMarkdown(r: Review): string {
	const out: string[] = [];

	// Header
	const num = r.pr?.number;
	const title = (r.pr?.title ?? "").toString().replace(/\r?\n/g, " ").trim();
	if (num != null) out.push(`## Code Review — PR #${num}${title ? `: ${title}` : ""}`, "");
	else out.push("## Code Review", "");

	if (r.verification?.trim()) out.push(`**Verification:** ${r.verification.trim()}`, "");

	if (r.overview?.trim()) out.push("### Overview", "", r.overview.trim(), "");

	if (Array.isArray(r.strengths) && r.strengths.length > 0) {
		out.push("### Strengths", "");
		for (const s of r.strengths) out.push(`- ${String(s).replace(/^\s*-\s*/, "").trim()}`);
		out.push("");
	}

	// Findings
	const findings = [...r.findings].sort((a, b) => severityRank(a) - severityRank(b));
	const blocking = findings.filter(isBlocking).length;
	const nonBlocking = findings.length - blocking;
	out.push(`### Findings — ${findings.length} (${blocking} blocking, ${nonBlocking} non-blocking)`, "");

	if (findings.length === 0) {
		out.push("_No issues found — nit through P0._", "");
	} else {
		out.push("| # | Sev | Blk | Finding | Location | Conf |", "|---|:--:|:--:|---|---|:--:|");
		findings.forEach((f, i) => {
			out.push(
				`| ${i + 1} | ${severityLabel(f)} | ${isBlocking(f) ? "yes" : "—"} | ${cell(titleText(f))} | \`${cell(location(f))}\` | ${conf(f.confidence_score)} |`,
			);
		});
		out.push("");
		findings.forEach((f, i) => {
			out.push(`#### ${i + 1}. [${severityLabel(f)}] ${cell(titleText(f))}`);
			out.push(`\`${location(f)}\` · confidence ${conf(f.confidence_score)} · ${isBlocking(f) ? "blocking" : "non-blocking"}`, "");
			if (f.body?.trim()) out.push(f.body.trim(), "");
		});
	}

	// Correctness / Security / Performance
	const notes = r.notes;
	const noteRows: string[] = [];
	if (notes?.correctness?.trim()) noteRows.push(`- **Correctness:** ${notes.correctness.trim()}`);
	if (notes?.security?.trim()) noteRows.push(`- **Security:** ${notes.security.trim()}`);
	if (notes?.performance?.trim()) noteRows.push(`- **Performance:** ${notes.performance.trim()}`);
	if (noteRows.length > 0) out.push("### Correctness / Security / Performance", "", ...noteRows, "");

	// Verdict
	out.push("### Verdict", "", verdictLine(r));

	return out.join("\n").trimEnd();
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event, ctx) => {
		// Keep raw JSON for automation; only prettify for interactive terminals.
		if (ctx.mode !== "tui") return;
		if (event.message.role !== "assistant") return;
		if (hasToolCall(event.message)) return; // not the final text-only answer

		const text = assistantText(event.message);
		if (!text.trim()) return;

		const review = parseReview(text);
		if (!review) return; // not a /pr-review JSON payload — leave untouched

		const nonText = (event.message.content as MessagePart[]).filter((p) => p.type !== "text");
		return {
			message: {
				...event.message,
				content: [...nonText, { type: "text", text: renderReviewMarkdown(review) }],
			},
		};
	});
}
