import { describe, expect, test } from "bun:test";
import {
	classifyReviewJsonObject,
	classifyReviewLane,
	finalAssistantText,
	ReviewLaneArtifactRegistry,
	type ReviewLaneArtifact,
} from "../lib/pr-review-artifacts.ts";

function integratedFraming(forms: "plain" | "bold" | "heading" = "plain", values = {
	overview: "The change integrates the review.",
	strengths: "Focused tests cover the path.",
	riskAreas: "Integration boundaries remain the main risk.",
}): string {
	if (forms === "bold") return `Review status: COMPLETE\n**Overview:** ${values.overview}\n**Strengths:** ${values.strengths}\n**Risk areas:** ${values.riskAreas}`;
	if (forms === "heading") return `Review status: COMPLETE\n## Overview\n${values.overview}\n## Strengths\n${values.strengths}\n## Risk areas\n${values.riskAreas}`;
	return `Review status: COMPLETE\nOverview: ${values.overview}\nStrengths: ${values.strengths}\nRisk areas: ${values.riskAreas}`;
}

function integratedCandidate(why = "The changed path drops a required result.", labels: "plain" | "bold" = "plain"): string {
	const prefix = labels === "bold" ? "- **" : "";
	const suffix = labels === "bold" ? ":**" : ":";
	return [
		`${prefix}title${suffix} [P2] Preserve review evidence`,
		`${prefix}severity${suffix} P2`,
		`${prefix}why${suffix} ${why}`,
		`${prefix}location${suffix} src/a.ts:10-12`,
		`${prefix}side${suffix} RIGHT`,
		`${prefix}in_diff${suffix} yes`,
		`${prefix}pr_related${suffix} yes`,
		`${prefix}confidence${suffix} 0.9`,
	].join("\n");
}

function artifact(overrides: Partial<ReviewLaneArtifact> = {}): ReviewLaneArtifact {
	return {
		generation: 7,
		key: "call:0",
		passId: "correctness-shard-2",
		tier: "heavy",
		requestedModel: "provider/primary",
		observedModel: "provider/fallback",
		rawText: "NO FINDINGS.",
		exitCode: 0,
		stopReason: "stop",
		lifecycle: "complete",
		attempts: [
			{
				ordinal: 1,
				kind: "primary",
				requestedModel: "provider/primary",
				observedModel: "provider/primary",
				rawText: "partial primary evidence",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "429 capacity",
				lifecycle: "partial",
				retryable: true,
				elapsedMs: 20,
				toolElapsedMs: 5,
				toolCallCount: 1,
			},
			{
				ordinal: 2,
				kind: "fallback",
				requestedModel: "provider/fallback",
				observedModel: "provider/fallback",
				rawText: "NO FINDINGS.",
				exitCode: 0,
				stopReason: "stop",
				lifecycle: "complete",
				retryable: false,
				elapsedMs: 30,
				toolElapsedMs: 0,
				toolCallCount: 0,
			},
		],
		fallbackUsed: true,
		elapsedMs: 50,
		toolElapsedMs: 0,
		toolCallCount: 0,
		...overrides,
	};
}

describe("ordinary review-lane reconstruction", () => {
	test("concatenates every text part from the authoritative final assistant message", () => {
		expect(finalAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "stale" }] },
			{ role: "toolResult", content: [] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first\n" },
					{ type: "thinking", text: "ignored" },
					{ type: "text", text: "second" },
					{ type: "text", text: "" },
				],
			},
		])).toBe("first\nsecond");
	});

	test("does not fall back to stale text when the final assistant message is empty", () => {
		expect(finalAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "stale" }] },
			{ role: "assistant", content: [{ type: "thinking", text: "no final output" }] },
		])).toBe("");
	});
});

describe("semantic lane completion", () => {
	test("characterizes the strict JSON-object repair contract independently of Markdown", () => {
		const base = { tier: "light" as const, exitCode: 0, stopReason: "stop" };
		for (const rawText of ["{}", " {\n  \"findings\": []\n} \t"]) {
			expect(classifyReviewJsonObject({ ...base, rawText }), rawText).toBe("complete");
		}
		for (const rawText of ["", "[]", "null", "42", "\"text\"", "prefix {}", "```json\n{}\n```"]) {
			expect(classifyReviewJsonObject({ ...base, rawText }), rawText).toBe(rawText ? "partial" : "failed");
		}
		for (const input of [
			{ ...base, rawText: "{}", exitCode: 1 },
			{ ...base, rawText: "{}", stopReason: "length" },
			{ ...base, rawText: "{}", errorMessage: "model error" },
		]) {
			expect(classifyReviewJsonObject(input)).toBe("partial");
		}
	});

	test("rejects contradictory COMPLETE framing while preserving candidate evidence", () => {
		const failures = [
			"I could not access the supplied diff.",
			"I cannot review the repository.",
			"I can't inspect the diff.",
			"I was unable to review the change.",
			"I lack access to the repository.",
			"Access denied while loading the review context.",
			"The review did not run.",
			"The review was skipped.",
			"The review tool failed with a server error.",
			"The model encountered an error while reading the diff.",
			"The review server returned an error.",
		] as const;
		for (const overview of failures) {
			const rawText = `${integratedFraming("plain", { overview, strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." })}\nNO FINDINGS.`;
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), overview).toBe("partial");
		}
		const candidateEvidence = `${integratedFraming()}\n${integratedCandidate("The reviewer could not access the repository after the workspace changed, so this path drops a required result.")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: candidateEvidence, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
	});

	test("characterizes reserved nit tags, blank separators, and Unicode prose", () => {
		const nit = `${integratedFraming()}\n${integratedCandidate("The changed path drops a required result.").replace("[P2] Preserve review evidence", "[nit] Preserve review evidence").replace("severity: P2", "severity: nit")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: nit, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		const hiddenNit = nit.replace("why: The changed path drops a required result.", "why: The changed path drops a required [nit] result.");
		expect(classifyReviewLane({ tier: "heavy", rawText: hiddenNit, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("partial");

		const withBlankSeparators = `${integratedFraming()}\r\n \t\r\n${integratedCandidate()}\r\n\t\r\n`;
		expect(classifyReviewLane({ tier: "heavy", rawText: withBlankSeparators, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		const nonblankTrailing = `${integratedFraming()} \r\nNO FINDINGS.`;
		expect(classifyReviewLane({ tier: "heavy", rawText: nonblankTrailing, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("partial");

		const cjk = `${integratedFraming("plain", {
			overview: "这个变更处理用户输入并保留错误上下文",
			strengths: "测试覆盖成功和失败路径",
			riskAreas: "跨服务边界仍需要关注",
		})}\n${integratedCandidate("当输入为空时结果会丢失并导致后续请求失败").replace("[P2] Preserve review evidence", "[P2] 保留错误上下文")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: cjk, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		const trivial = `${integratedFraming("plain", { overview: "好", strengths: "测试", riskAreas: "风险" })}\n${integratedCandidate("失败").replace("[P2] Preserve review evidence", "[P2] 修复").replace("src/a.ts:10-12", "repo-wide")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: trivial, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("partial");
		for (const boilerplate of ["没有发现问题", "レビュー完了", "문제없음"]) {
			const rawText = integratedFraming("plain", { overview: boilerplate, strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.";
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), boilerplate).toBe("partial");
		}
	});

	test("requires the exact integrated Markdown contract under a successful terminal stop", () => {
		const clean = `${integratedFraming()}\nNO FINDINGS.`;
		expect(classifyReviewLane({ tier: "heavy", rawText: clean, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming("bold")}\nNO FINDINGS.`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming("heading")}\nNO FINDINGS.`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${integratedFraming()}\n${integratedCandidate()}`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${integratedFraming()}\n${integratedCandidate("The review agent cannot access the repository after chdir, so the new feature fails", "bold")}\n\n${integratedCandidate("The diff was not provided to the downstream worker, so reviews silently ignore new code")}`,
			exitCode: 0, stopReason: "stop", expectedOutput: "nonempty",
		})).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("failed");

		for (const arbitrary of ["1234567890123456", "looks okay", "all good", "Overview: a\nStrengths: b\nRisk areas: c\nNo findings at any severity."]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: arbitrary, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), arbitrary).toBe("partial");
		}
		for (const reason of [
			"I cannot review because repository access is denied.",
			"The source context was not provided to the model.",
			"The review tool failed while reading the diff.",
			"An internal model error prevented inspection.",
			"I was unable to complete the analysis.",
			"The available evidence was insufficient to assess the change.",
		]) {
			const incomplete = `Review status: INCOMPLETE\n${reason}`;
			expect(classifyReviewLane({ tier: "heavy", rawText: incomplete, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), reason).toBe("partial");
		}
		for (const malformed of [
			`${integratedFraming()}\nReview status: COMPLETE\nNO FINDINGS.`,
			`review status: COMPLETE\n${integratedFraming().replace("Review status: COMPLETE\n", "")}\nNO FINDINGS.`,
			`> Review status: COMPLETE\n${integratedFraming().replace("Review status: COMPLETE\n", "")}\nNO FINDINGS.`,
			`- Review status: COMPLETE\n${integratedFraming().replace("Review status: COMPLETE\n", "")}\nNO FINDINGS.`,
			`Review status: COMPLETE\n- Overview: first\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nNO FINDINGS.\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nStrengths: focused tests\nRisk areas: integration boundary\nReview status: COMPLETE\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nStrengths: focused tests\nRisk areas: integration boundary\n
declared prose\nNO FINDINGS.`,
			`<div>\n${integratedFraming()}\nNO FINDINGS.\n</div>`,
			"```markdown\n" + integratedFraming() + "\nNO FINDINGS.\n```",
			`Review status: COMPLETE\nOverview: first\n- title: [P2] absorbed\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: title: embedded\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nRisk areas: out of order\nStrengths: focused tests\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: none\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: Internal server error\nStrengths: focused tests\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nStrengths: unavailable\nRisk areas: integration boundary\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nStrengths: focused tests\nRisk areas: review complete\nNO FINDINGS.`,
			`Review status: COMPLETE\nOverview: first\nStrengths: focused tests\nRisk areas: integration boundary\nNo findings.`,
		]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: malformed, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), malformed).toBe("partial");
		}

		for (const malformed of [
			`${integratedFraming()}\n${integratedCandidate().replace("severity: P2", "severity: P9")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("severity: P2", "Severity: P2")}`,
			`${integratedFraming("heading").replace("## Overview\n", "## Overview: inline\n")}\nNO FINDINGS.`,
			`${integratedFraming()}\n${integratedCandidate().replace("title: [P2] Preserve review evidence", "title: [P1] Preserve review evidence").replace("severity: P2", "severity: P2")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("side: RIGHT", "side: MIDDLE")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("in_diff: yes", "in_diff: true")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("pr_related: yes", "pr_related: true")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("confidence: 0.9", "confidence: 1.1")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("why: The changed path drops a required result.", "why: none")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("title: [P2] Preserve review evidence", "title: template")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: ../src/a.ts:10-12")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: /src/a.ts:10-12")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: src/./a.ts:10-12")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: src//a.ts:10-12")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: src\\\\a.ts:10-12")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: src/a.ts:0-2")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("location: src/a.ts:10-12", "location: src/a.ts:12-10")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("confidence: 0.9", "confidence: nope")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("severity: P2", "severity: p2")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("side: RIGHT", "side: right")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("confidence: 0.9", "confidence: 2")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("confidence: 0.9", "confidence: 0.9\nconfidence: 0.8")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("pr_related: yes", "confidence: 0.9\npr_related: yes")}`,
			`${integratedFraming()}\n${integratedCandidate().replace("why: The changed path drops a required result.\nlocation", "location")}`,
			`${integratedFraming()}\n${integratedCandidate()}\n  borrowed continuation\n${integratedCandidate()}`,
			`${integratedFraming()}\n${integratedCandidate()}\nNO FINDINGS.`,
			`${integratedFraming()}\n${integratedCandidate().replace("title: [P2] Preserve review evidence", "title: [P2]")}`,
			`${integratedFraming()}\n## Findings\n${integratedCandidate()}`,
		]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: malformed, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), malformed).toBe("partial");
		}
		for (const location of ["src/a.ts:1", "src/a.ts:1-1", "src/nested/file-name.ts:2-20", "repo-wide"]) {
			const valid = `${integratedFraming()}\n${integratedCandidate().replace("src/a.ts:10-12", location)}`;
			expect(classifyReviewLane({ tier: "heavy", rawText: valid, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), location).toBe("complete");
		}
		const multilineWhy = `${integratedFraming()}\n${integratedCandidate("The changed path drops a required result.\n  The second line explains the concrete trigger and impact.")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: multilineWhy, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		expect(classifyReviewLane({ tier: "light", rawText: "Overview: change\nStrengths: clear", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "light", rawText: "Overview:\nStrengths:", exitCode: 0, stopReason: "stop" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "NO FINDINGS.", exitCode: 0, stopReason: "stop" })).toBe("complete");
		expect(classifyReviewLane({ tier: "heavy", rawText: "title:\nseverity:\nwhy:\nlocation:\nside:\nin_diff:\npr_related:\nconfidence:", exitCode: 0, stopReason: "stop" })).toBe("partial");
	});

	test("rejects indented deep-contract productions", () => {
		const framing = integratedFraming();
		const candidate = integratedCandidate();
		const probes = [
			`    Review status: COMPLETE\n${framing.slice(framing.indexOf("\n") + 1)}\nNO FINDINGS.`,
			`${framing}\n    NO FINDINGS.`,
			`${framing}\n${candidate.split("\n").map((line) => `    ${line}`).join("\n")}`,
			`${framing.split("\n").map((line, index) => index === 0 ? line : `    ${line}`).join("\n")}\nNO FINDINGS.`,
		];
		for (const rawText of probes) {
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), rawText).toBe("partial");
		}
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${framing}\n${candidate}`,
			exitCode: 0,
			stopReason: "stop",
			expectedOutput: "nonempty",
		})).toBe("complete");
	});

	test("rejects reserved productions hidden in candidate values and continuations", () => {
		const framing = integratedFraming();
		const candidate = integratedCandidate();
		for (const hidden of [
			"Review status: COMPLETE",
			"NO FINDINGS.",
			"severity: P2",
			"The impact is severity: P2",
			"```markdown",
			"<div>hidden</div>",
			"> quoted contract",
			"- list-wrapped contract",
		]) {
			const rawText = `${framing}\n${candidate.replace("why: The changed path drops a required result.", `why: ${hidden}`)}`;
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), hidden).toBe("partial");
		}
		for (const hidden of [
			"  Review status: COMPLETE",
			"  NO FINDINGS.",
			"  severity: P2",
			"  ```markdown",
			"  <div>hidden</div>",
			"  > quoted contract",
			"  - severity: P2",
		]) {
			const rawText = `${framing}\n${candidate.replace("why: The changed path drops a required result.", `why: a valid first line\n${hidden}`)}`;
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), hidden).toBe("partial");
		}
		const titleHidden = candidate.replace("title: [P2] Preserve review evidence", "title: [P2] Preserve severity: P2");
		expect(classifyReviewLane({ tier: "heavy", rawText: `${framing}\n${titleHidden}`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("partial");
		const valid = `${framing}\n${candidate.replace(
			"why: The changed path drops a required result.",
			"why: The reviewer could not access the repository after the workspace changed.\n  The second line records the concrete impact without borrowing contract syntax.",
		)}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: valid, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
	});

	test.each([
		["backtick fence", "```"],
		["spaced backtick fence", "  ```"],
		["tilde fence", "~~~"],
		["spaced tilde fence", "   ~~~"],
		["unterminated HTML comment", "<!--"],
		["unterminated processing instruction", "<?"],
		["unterminated declaration", "<!DOCTYPE"],
		["unterminated CDATA opener", "<![CDATA["],
		["unterminated script opener", "<script"],
		["unterminated pre opener", "<pre"],
		["unterminated style opener", "<style"],
		["unterminated textarea opener", "<textarea"],
		["embedded severity tag", "[P1] Hidden blocker"],
	] as const)("rejects candidate %s without requiring a closing container", (_label, why) => {
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${integratedFraming()}\n${integratedCandidate(why)}`,
			exitCode: 0,
			stopReason: "stop",
			expectedOutput: "nonempty",
		})).toBe("partial");
	});

	test("rejects reserved productions on multiline candidate continuation lines", () => {
		for (const why of ["A valid first line.\n  ```", "A valid first line.\n  ~~~", "A valid first line.\n  [P1] Hidden blocker", "A valid first line.\n  <!--"]) {
			expect(classifyReviewLane({
				tier: "heavy",
				rawText: `${integratedFraming()}\n${integratedCandidate(why)}`,
				exitCode: 0,
				stopReason: "stop",
				expectedOutput: "nonempty",
			}), why).toBe("partial");
		}
	});

	test.each([
		["scalar title generic", integratedCandidate().replace("title: [P2] Preserve review evidence", "title: [P2] Result<T>")],
		["scalar title map type", integratedCandidate().replace("title: [P2] Preserve review evidence", "title: [P2] Map<string, number>")],
		["scalar why generic", integratedCandidate("The returned Result<T> preserves the caller's type.")],
		["scalar why map type", integratedCandidate("The lookup returns Map<string, number> for the caller.")],
		["scalar why comparison", integratedCandidate("The operator compares x < y before applying the update.")],
		["continuation generic", integratedCandidate("The returned value preserves its declared type.\n  Result<T> carries the successful branch.")],
		["continuation map type", integratedCandidate("The lookup retains its key and value types.\n  Map<string, number> carries the result.")],
		["continuation comparison", integratedCandidate("The guard evaluates the operands before the write.\n  x < y selects the expected branch.")],
	] as const)("accepts %s as ordinary candidate prose", (_label, candidate) => {
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${integratedFraming()}\n${candidate}`,
			exitCode: 0,
			stopReason: "stop",
			expectedOutput: "nonempty",
		})).toBe("complete");
	});

	test.each([
		["unterminated HTML comment", "<!--"],
		["complete HTML comment", "<!-- hidden -->"],
		["unterminated processing instruction", "<?"],
		["complete processing instruction", "<?xml version=\"1.0\"?>"],
		["unterminated declaration", "<!DOCTYPE"],
		["complete declaration", "<!DOCTYPE html>"],
		["unterminated CDATA opener", "<![CDATA["],
		["complete CDATA block", "<![CDATA[hidden]]>"],
		["unterminated raw block tag", "<div"],
		["complete raw block tag", "<div>hidden</div>"],
		["complete custom block tag", "<x-review data-kind=example>"],
		["closing custom block tag", "</x-review>"],
	] as const)("rejects an actual %s at the candidate value's structural start", (_label, html) => {
		expect(classifyReviewLane({
			tier: "heavy",
			rawText: `${integratedFraming()}\n${integratedCandidate(html)}`,
			exitCode: 0,
			stopReason: "stop",
			expectedOutput: "nonempty",
		})).toBe("partial");
	});

	test("does not let an empty light section consume the next populated section", () => {
		const fields = ["Overview", "Strengths", "Minor Candidates"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered
				.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`)
				.join("\n");
			expect(classifyReviewLane({ tier: "light", rawText, exitCode: 0, stopReason: "stop", minorHygiene: true }), emptyField).toBe("partial");
		}
		expect(classifyReviewLane({ tier: "light", rawText: fields.map((field) => `${field}: ${field} value`).join("\n"), exitCode: 0, stopReason: "stop", minorHygiene: true })).toBe("complete");
	});

	test("does not let an empty heavy field consume the next populated field", () => {
		const fields = ["title", "severity", "why", "location", "side", "in_diff", "pr_related", "confidence"];
		for (const [index, emptyField] of fields.entries()) {
			const ordered = [...fields.slice(index), ...fields.slice(0, index)];
			const rawText = ordered.map((field) => `${field}:${field === emptyField ? "" : ` ${field} value`}`).join("\n");
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop" }), emptyField).toBe("partial");
		}
		expect(classifyReviewLane({ tier: "heavy", rawText: fields.map((field) => `${field}: ${field} value`).join("\n"), exitCode: 0, stopReason: "stop" })).toBe("complete");
	});

	test("classifies token limits, timeout, and process failure without erasing raw text", () => {
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 0, stopReason: "length" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, stopReason: "error" })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, errorMessage: "request timed out" })).toBe("timed_out");
		expect(classifyReviewLane({ tier: "heavy", rawText: "partial evidence", exitCode: 1, errorMessage: 7 as never })).toBe("partial");
		expect(classifyReviewLane({ tier: "heavy", rawText: "", exitCode: 1, stopReason: "error" })).toBe("failed");
	});
});

describe("invocation lane artifact retention", () => {
	test("preserves fallback attempt history and purges it with the generation", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		const retained = artifact();
		expect(registry.expect(7, [{ key: retained.key, tier: retained.tier, minorHygiene: false, expectedOutput: "nonempty" }])).toBeTrue();
		expect(registry.expect(7, [{ key: retained.key, tier: retained.tier, minorHygiene: false, expectedOutput: "review_lane" }])).toBeFalse();
		expect(registry.retain(7, retained)).toBeTrue();
		const snapshot = registry.snapshot(7)!;
		expect(snapshot[0]?.rawText).toBe("NO FINDINGS.");
		expect(snapshot[0]?.attempts.map((attempt) => ({ lifecycle: attempt.lifecycle, rawText: attempt.rawText }))).toEqual([
			{ lifecycle: "partial", rawText: "partial primary evidence" },
			{ lifecycle: "complete", rawText: "NO FINDINGS." },
		]);
		expect(() => (snapshot as ReviewLaneArtifact[]).push(retained)).toThrow();
		registry.close(7);
		expect(registry.snapshot(7)).toBeUndefined();
		expect(registry.retain(7, retained)).toBeFalse();
	});

	test("snapshots concurrent completions in requested-pass order", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		expect(registry.expect(7, [
			{ key: "call:0", tier: "heavy", minorHygiene: false },
			{ key: "call:1", tier: "heavy", minorHygiene: false },
		])).toBeTrue();
		expect(registry.retain(7, artifact({ key: "unexpected", passId: "unexpected" }))).toBeFalse();
		expect(registry.retain(7, artifact({ key: "call:0", tier: "light" }))).toBeFalse();
		registry.retain(7, artifact({ key: "call:1", passId: "second", requestedPassOrdinal: 1 }));
		registry.retain(7, artifact({ key: "call:0", passId: "first", requestedPassOrdinal: 0 }));
		expect(registry.snapshot(7)?.map((lane) => lane.passId)).toEqual(["first", "second"]);
	});

	test("rejects stale artifacts after replacement", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		registry.open(8);
		expect(registry.retain(7, artifact())).toBeFalse();
		expect(registry.snapshot(8)).toEqual([]);
	});
});
