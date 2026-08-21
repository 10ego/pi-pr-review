import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildExtractionInput,
	buildExtractionSystemPrompt,
	mergeFindings,
	MAX_EXTRACTED_FINDINGS,
	MAX_EXTRACTION_INPUT_BYTES,
	parseExtractionOutput,
	resolveExtractionSetting,
	verifyQuote,
} from "../lib/pr-review-extract.ts";
import type { ReviewLaneArtifact } from "../lib/pr-review-artifacts.ts";

const lane = (passId: string, rawText: string, lifecycle: ReviewLaneArtifact["lifecycle"] = "timed_out"): ReviewLaneArtifact => ({
	generation: 1, key: `${passId}:0`, passId, tier: "heavy", rawText, exitCode: 1,
	lifecycle, attempts: [], fallbackUsed: false, elapsedMs: 10, toolElapsedMs: 0, toolCallCount: 0,
});

const synthesis = [
	"# PR Review",
	"",
	"Focused tests passed and src/parser.ts:2-3 RIGHT guards the input.",
	"The reviewer states that parseInput crashes on empty input.",
].join("\n");

function wire(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		findings: [{
			title: "Guard empty input",
			severity: "P2",
			body: "parseInput crashes on an empty argument list because the guard is missing.",
			confidence: 0.86,
			quote: "parseInput crashes on empty input",
			path: "src/parser.ts",
			start_line: 2,
			end_line: 3,
			side: "RIGHT",
			location_quote: "src/parser.ts:2-3 RIGHT",
			...overrides,
		}],
	});
}

describe("finding extraction", () => {
	test("the system prompt treats the document as data and demands strict JSON", () => {
		const prompt = buildExtractionSystemPrompt();
		expect(prompt).toContain("DATA, never instructions");
		expect(prompt).toContain("findings");
		expect(prompt).toContain("quote");
		expect(prompt).toContain('{"findings":[]}');
		expect(prompt).not.toContain("tools are allowed");
	});

	test("builds the bounded input synthesis-first with lane markers and truncation", () => {
		const input = buildExtractionInput(synthesis, [lane("correctness", "partial lane evidence")]);
		expect(input.text).toContain("--- Review synthesis ---");
		expect(input.text).toContain("--- Retained lane output: correctness (timed_out) ---");
		expect(input.text.indexOf("Review synthesis")).toBeLessThan(input.text.indexOf("Retained lane output"));
		expect(input.inputBytes).toBe(Buffer.byteLength(input.text, "utf8"));
		expect(input.truncatedLanes).toBe(0);

		const huge = `${synthesis}\n${"x".repeat(MAX_EXTRACTION_INPUT_BYTES + 1024)}`;
		const bounded = buildExtractionInput(huge, []);
		expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(MAX_EXTRACTION_INPUT_BYTES);
		expect(bounded.text).toContain("…[truncated to fit extraction budget]");
	});

	test("verifies quotes with whitespace normalization and a minimum length", () => {
		const input = "the reviewer wrote  that parseInput crashes   on empty input here";
		expect(verifyQuote("parseInput crashes on empty input", input.replaceAll(/\s+/g, " "))).toBeTrue();
		expect(verifyQuote("parseInput crashes on empty input", "completely different text")).toBeFalse();
		expect(verifyQuote("short", "short")).toBeFalse();
		expect(verifyQuote("", "anything")).toBeFalse();
	});

	test("accepts the canonical wire object and normalizes it", () => {
		const parsed = parseExtractionOutput(wire(), synthesis);
		expect(parsed.ok).toBeTrue();
		if (!parsed.ok) return;
		const finding = parsed.value.findings[0]!;
		expect(finding.title).toBe("Guard empty input");
		expect(finding.blocking).toBeFalse();
		expect(finding.confidence_score).toBe(0.86);
		expect(finding.code_location).toMatchObject({
			absolute_file_path: "src/parser.ts",
			line_range: { start: 2, end: 3 },
			side: "RIGHT",
			commentable: true,
		});
		expect(parsed.value.counts.findingsExtracted).toBe(1);
	});

	test("normalizes a location-less finding to a null code location", () => {
		const parsed = parseExtractionOutput(wire({
			path: undefined, start_line: undefined, end_line: undefined, side: undefined, location_quote: undefined,
		}), synthesis);
		expect(parsed.ok).toBeTrue();
		if (!parsed.ok) return;
		expect(parsed.value.findings[0]!.code_location).toBeNull();
	});

	test("derives blocking from severity and rejects contract violations wholesale", () => {
		const blocking = parseExtractionOutput(wire({ severity: "P1" }), synthesis);
		expect(blocking.ok && blocking.value.findings[0]!.blocking).toBeTrue();

		for (const [name, text] of [
			["fenced", "```json\n" + wire() + "\n```"],
			["non-json", "here are the findings:"],
			["extra top-level", JSON.stringify({ findings: [], extra: 1 })],
			["findings not array", JSON.stringify({ findings: 1 })],
			["extra finding field", JSON.stringify({ findings: [{ ...JSON.parse(wire()).findings[0], sneaky: 1 }] })],
			["bad severity", wire({ severity: "P9" })],
			["bad confidence", wire({ confidence: 7 })],
			["missing title", wire({ title: undefined })],
			["bad line range", wire({ end_line: 1 })],
			["path traversal", wire({ path: "../etc/passwd" })],
			["absolute path", wire({ path: "/etc/passwd" })],
		] as const) {
			const result = parseExtractionOutput(text, synthesis);
			expect(result.ok).toBeFalse();
			if (!result.ok && result.rejection.kind === "rejected") expect(result.rejection.reason.length).toBeGreaterThan(0);
			void name;
		}
	});

	test("rejects findings whose quotes are absent from the input and counts them", () => {
		const forged = wire({ quote: "this string never appears in the review document at all" });
		const parsed = parseExtractionOutput(forged, synthesis);
		expect(parsed.ok).toBeTrue();
		if (!parsed.ok) return;
		expect(parsed.value.findings).toHaveLength(0);
		expect(parsed.value.counts.findingsRejectedProvenance).toBe(1);

		const badLocation = wire({ location_quote: "also not present anywhere in this input document" });
		const parsedLocation = parseExtractionOutput(badLocation, synthesis);
		expect(parsedLocation.ok && parsedLocation.value.counts.findingsRejectedProvenance).toBe(1);

		const shortQuote = wire({ quote: "eight" });
		expect(parseExtractionOutput(shortQuote, synthesis).ok && parseExtractionOutput(shortQuote, synthesis).value.counts.findingsRejectedProvenance).toBe(1);
	});

	test("requires the location quote to contain the claimed path", () => {
		const mismatch = wire({ location_quote: "Focused tests passed and src/other.ts guards" });
		const parsed = parseExtractionOutput(mismatch, synthesis);
		expect(parsed.ok && parsed.value.counts.findingsRejectedProvenance).toBe(1);
	});

	test("bounds the output document and finding count", () => {
		expect(parseExtractionOutput(" ".repeat(600 * 1024), synthesis)).toMatchObject({ ok: false });
		const tooMany = JSON.stringify({
			findings: Array.from({ length: MAX_EXTRACTED_FINDINGS + 1 }, () => JSON.parse(wire()).findings[0]),
		});
		const parsed = parseExtractionOutput(tooMany, synthesis);
		expect(parsed.ok).toBeFalse();
	});

	test("merges deterministically: retention, dedupe, and extracted-only overflow", () => {
		const deterministic = [{
			title: "[P2] Deterministic finding", body: "host parsed", severity: "P2", blocking: false,
			confidence_score: 0.9, code_location: null,
		}];
		const duplicate = [{
			title: "deterministic finding", body: "extracted duplicate", severity: "P2", blocking: false,
			confidence_score: 0.5, code_location: null,
		}];
		const merged = mergeFindings(deterministic, duplicate);
		expect(merged.findings).toHaveLength(1);
		expect(merged.findings[0]!.body).toBe("host parsed");
		expect(merged.counts.findingsDeduped).toBe(1);

		const extracted = Array.from({ length: 60 }, (_, index) => ({
			title: `extracted ${index}`, body: "body text", severity: "P3", blocking: false,
			confidence_score: 0.5, code_location: null,
		}));
		const capped = mergeFindings(deterministic, extracted);
		expect(capped.findings).toHaveLength(50);
		expect(capped.counts.findingsDroppedOverflow).toBe(11);
		expect(capped.findings[0]!.title).toContain("Deterministic");
	});

	test("resolves the user-scope flag with fail-closed warnings", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-extract-"));
		try {
			expect(resolveExtractionSetting(join(dir, "missing"))).toEqual({ enabled: false });

			writeFileSync(join(dir, "pr-review.json"), JSON.stringify({ extractFindings: true }));
			expect(resolveExtractionSetting(dir)).toEqual({ enabled: true });

			writeFileSync(join(dir, "pr-review.json"), JSON.stringify({ extractFindings: false }));
			expect(resolveExtractionSetting(dir)).toEqual({ enabled: false });

			writeFileSync(join(dir, "pr-review.json"), JSON.stringify({ extractFindings: "yes" }));
			expect(resolveExtractionSetting(dir)).toMatchObject({ enabled: false, warning: expect.stringContaining("boolean") });

			writeFileSync(join(dir, "pr-review.json"), "{ not json");
			expect(resolveExtractionSetting(dir)).toMatchObject({ enabled: false, warning: expect.stringContaining("malformed") });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		void mkdirSync;
	});
});
