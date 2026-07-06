/**
 * review-table
 *
 * Renders the /pr-review final JSON response as a readable table in the TUI.
 *
 * The orchestrator prompt ends by emitting the gpt-review JSON object
 * ({ findings, overall_correctness, overall_explanation, overall_confidence_score }).
 * This extension parses that final assistant message and rewrites it as a Markdown
 * table (findings table + per-finding details + verdict) which pi's Markdown renderer
 * displays as a real table.
 *
 * Only rewrites in interactive TUI mode. In print / json / rpc modes the raw JSON is
 * left untouched so piping and automation keep a machine-readable payload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Finding {
	title?: string;
	body?: string;
	confidence_score?: number;
	priority?: number | null;
	code_location?: {
		absolute_file_path?: string;
		line_range?: { start?: number; end?: number };
	};
}

interface Review {
	findings: Finding[];
	overall_correctness: string;
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
			const parsed = JSON.parse(objStr) as unknown;
			if (
				parsed &&
				typeof parsed === "object" &&
				Array.isArray((parsed as Review).findings) &&
				typeof (parsed as Review).overall_correctness === "string"
			) {
				return parsed as Review;
			}
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

function priorityNum(f: Finding): number {
	if (typeof f.priority === "number" && f.priority >= 0 && f.priority <= 3) return f.priority;
	const m = (f.title ?? "").match(/\[?P([0-3])\]?/i);
	return m ? Number(m[1]) : 99;
}

function priorityLabel(f: Finding): string {
	const n = priorityNum(f);
	return n <= 3 ? `P${n}` : "—";
}

/** Strip a leading [Pn] / Pn tag from a title (priority is shown in its own column). */
function titleText(f: Finding): string {
	return (f.title ?? "(untitled)").replace(/^\s*\[?P[0-3]\]?\s*[-–:·]?\s*/i, "").trim() || "(untitled)";
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

function renderReviewMarkdown(r: Review): string {
	const incorrect = /incorrect/i.test(r.overall_correctness);
	const icon = incorrect ? "❌" : "✅";
	const out: string[] = [];

	out.push(`## Code review — ${icon} ${r.overall_correctness}`, "");
	out.push("| Field | Value |", "|---|---|");
	out.push(`| Verdict | ${icon} ${cell(r.overall_correctness)} |`);
	if (r.overall_confidence_score != null) out.push(`| Confidence | ${conf(r.overall_confidence_score)} |`);
	out.push(`| Findings | ${r.findings.length} |`);
	out.push("");
	if (r.overall_explanation) out.push(`> ${cell(r.overall_explanation)}`, "");

	if (r.findings.length === 0) {
		out.push("_No findings. Checked for bugs, logic, security, and convention-file compliance._");
		return out.join("\n");
	}

	const sorted = [...r.findings].sort((a, b) => priorityNum(a) - priorityNum(b));

	out.push("| # | Pri | Finding | Location | Conf |", "|---|:--:|---|---|:--:|");
	sorted.forEach((f, i) => {
		out.push(
			`| ${i + 1} | ${priorityLabel(f)} | ${cell(titleText(f))} | \`${cell(location(f))}\` | ${conf(f.confidence_score)} |`,
		);
	});
	out.push("");

	sorted.forEach((f, i) => {
		out.push(`### ${i + 1}. [${priorityLabel(f)}] ${cell(titleText(f))}`);
		out.push(`\`${location(f)}\` · confidence ${conf(f.confidence_score)}`, "");
		if (f.body?.trim()) out.push(f.body.trim(), "");
	});

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
