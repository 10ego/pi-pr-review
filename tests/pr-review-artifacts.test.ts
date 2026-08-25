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
			"Unfortunately, I could not inspect the diff.",
			"Sorry, I cannot review the repository.",
			"Regrettably: we failed to assess the patch.",
			"I cannot review the repository.",
			"I can't inspect the diff.",
			"I was unable to review the change.",
			"I lack access to the repository.",
			"I was denied access to the review context.",
			"I failed to review the supplied diff.",
			"The review did not run.",
			"The review was skipped.",
		] as const;
		for (const overview of failures) {
			const rawText = `${integratedFraming("plain", { overview, strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." })}\nNO FINDINGS.`;
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), overview).toBe("partial");
		}
		const candidateEvidence = `${integratedFraming()}\n${integratedCandidate("The reviewer could not access the repository after the workspace changed, so this path drops a required result.")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: candidateEvidence, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		for (const framing of [
			integratedFraming("plain", { overview: "The review tool error handling preserves diagnostics.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }),
			integratedFraming("plain", { overview: "The review tool failed gracefully and preserved diagnostics.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }),
			integratedFraming("plain", { overview: "The change validates product failures.", strengths: "Focused tests cover the path.", riskAreas: "The server returned an error for invalid input." }),
			integratedFraming("plain", { overview: "This fixes a path where the review was skipped.", strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }),
		]) {
			expect(classifyReviewLane({ tier: "heavy", rawText: `${framing}\nNO FINDINGS.`, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		}
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
		})}\n${integratedCandidate("当输入为空时结果会丢失并导致后续请求失败").replace("[P2] Preserve review evidence", "[P2] 保留完整错误上下文信息")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: cjk, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("complete");
		const trivial = `${integratedFraming("plain", { overview: "好", strengths: "测试", riskAreas: "风险" })}\n${integratedCandidate("失败").replace("[P2] Preserve review evidence", "[P2] 修复").replace("src/a.ts:10-12", "repo-wide")}`;
		expect(classifyReviewLane({ tier: "heavy", rawText: trivial, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" })).toBe("partial");
		for (const boilerplate of ["no findings 测", "n/a 测", "review complete 测", "好 好", "测 试", "风险 风险", "哈哈哈哈", "测试测试", "一切正常", "没有任何问题", "没有发现问题", "没有 问题", "重复内容风险重复内容风险", "特に問題なし", "問題 なし", "レビュー完了", "문제없음", "문제 없음"]) {
			const rawText = integratedFraming("plain", { overview: boilerplate, strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.";
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), boilerplate).toBe("partial");
		}
		for (const substantive of ["错误处理", "入力検証を強化", "エラー処理改善", "오류처리개선", "Fix 用户 validation"]) {
			const rawText = integratedFraming("plain", { overview: substantive, strengths: "Focused tests cover the path.", riskAreas: "Integration boundaries remain the main risk." }) + "\nNO FINDINGS.";
			expect(classifyReviewLane({ tier: "heavy", rawText, exitCode: 0, stopReason: "stop", expectedOutput: "nonempty" }), substantive).toBe("complete");
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

	test("rejects malformed lane artifacts at the retention boundary instead of storing them", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		expect(registry.expect(7, [{ key: "call:0", tier: "heavy", minorHygiene: false }])).toBeTrue();
		const malformed = [
			null,
			undefined,
			"a string is not a lane",
			artifact({ rawText: 12345 as unknown as string }),
			artifact({ rawText: undefined as unknown as string }),
			artifact({ passId: undefined as unknown as string }),
			artifact({ key: undefined as unknown as string }),
			artifact({ lifecycle: "finished" as ReviewLaneArtifact["lifecycle"] }),
			artifact({ tier: "ultra" as unknown as ReviewLaneArtifact["tier"] }),
			artifact({ generation: 1.5 as unknown as number }),
			artifact({ exitCode: "0" as unknown as number }),
			artifact({ fallbackUsed: "yes" as unknown as boolean }),
			artifact({ elapsedMs: Infinity as unknown as number }),
			artifact({ toolElapsedMs: NaN as unknown as number }),
			artifact({ toolCallCount: -1 }),
			// Malformed optional fields: symbols, wrong types, invalid enums.
			artifact({ errorMessage: Symbol("kaboom") as unknown as string }),
			artifact({ stopReason: Symbol("kaboom") as unknown as string }),
			artifact({ processSignal: 42 as unknown as string }),
			artifact({ requestedModel: { model: "x" } as unknown as string }),
			artifact({ deadlineExpired: "whenever" as unknown as ReviewLaneArtifact["deadlineExpired"] }),
			artifact({ minorHygiene: 1 as unknown as boolean }),
			artifact({ firstEventMs: "soon" as unknown as number }),
			artifact({ deadlineSource: "vibes" as unknown as ReviewLaneArtifact["deadlineSource"] }),
			artifact({ attempts: "not an array" as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [null] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ ordinal: 1, rawText: 42 as unknown as string, exitCode: 0, lifecycle: "partial" }] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ rawText: "text but no ordinal", exitCode: 0, lifecycle: "partial" }] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ ordinal: 1, rawText: "text", exitCode: 0, lifecycle: "done" }] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ ordinal: 1, rawText: "text", exitCode: 0, lifecycle: "partial", kind: "retry" }] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ ordinal: 1, rawText: "text", exitCode: 0, lifecycle: "partial", usedTier: "ultra" }] as unknown as ReviewLaneArtifact["attempts"] }),
			artifact({ attempts: [{ ordinal: 1, rawText: "text", exitCode: 0, lifecycle: "partial", errorMessage: Symbol("kaboom") }] as unknown as ReviewLaneArtifact["attempts"] }),
			// Throwing getters must be rejected, never crash the publisher boundary.
			{ ...artifact(), get rawText() { throw new Error("boom"); } } as unknown as ReviewLaneArtifact,
			{ ...artifact(), get attempts() { throw new Error("boom"); } } as unknown as ReviewLaneArtifact,
			{ ...artifact(), get passId() { throw new Error("boom"); } } as unknown as ReviewLaneArtifact,
			{ ...artifact(), get lifecycle() { throw new Error("boom"); } } as unknown as ReviewLaneArtifact,
			{ ...artifact(), get errorMessage() { throw new Error("boom"); } } as unknown as ReviewLaneArtifact,
		];
		for (const lane of malformed) {
			expect(registry.retain(7, lane as ReviewLaneArtifact)).toBeFalse();
		}
		expect(registry.snapshot(7)).toEqual([]);
		// A valid artifact still retains normally afterwards.
		expect(registry.retain(7, artifact())).toBeTrue();
		expect(registry.snapshot(7)).toHaveLength(1);
	});

	test("stateful getters cannot pass validation and then turn hostile (one-read snapshot)", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		expect(registry.expect(7, Array.from({ length: 7 }, (_, index) => ({
			key: `call:${index}`, tier: "heavy" as const, minorHygiene: false,
		})))).toBeTrue();
		/** Install real getters on a plain artifact clone. */
		const withGetters = (key: string, fields: Record<string, () => unknown>) => {
			const lane: Record<string, unknown> = { ...artifact({ key }) };
			for (const [name, getter] of Object.entries(fields)) {
				Object.defineProperty(lane, name, { get: getter, enumerable: true, configurable: true });
			}
			return lane as unknown as ReviewLaneArtifact;
		};
		/** Stateful getter: a good first value, a hostile second value, counted reads. */
		const flips = (good: unknown, hostile: unknown, reads: Record<string, number>, name: string) => () => {
			reads[name] = (reads[name] ?? 0) + 1;
			return reads[name] === 1 ? good : hostile;
		};
		/** Stateful getter whose second read throws instead of returning a value. */
		const flipsThrow = (good: unknown, reads: Record<string, number>, name: string) => () => {
			reads[name] = (reads[name] ?? 0) + 1;
			if (reads[name] === 1) return good;
			throw new Error("second read boom");
		};
		const reads: Record<string, number> = {};
		// Good→Symbol flips: the first valid value is snapshotted safely.
		expect(registry.retain(7, withGetters("call:0", { rawText: flips("NO FINDINGS.", Symbol("hostile"), reads, "rawText") }))).toBeTrue();
		expect(registry.retain(7, withGetters("call:1", { errorMessage: flips("429 capacity", Symbol("hostile"), reads, "errorMessage") }))).toBeTrue();
		expect(registry.retain(7, withGetters("call:2", { requestedModel: flips("provider/primary", Symbol("hostile"), reads, "requestedModel") }))).toBeTrue();
		// Good→throw flip on passId: first read is valid, snapshot keeps it, the
		// hostile second read never happens.
		expect(registry.retain(7, withGetters("call:3", { passId: flipsThrow("correctness", reads, "passId") }))).toBeTrue();
		// A getter that is hostile on the FIRST read drops the whole lane.
		expect(registry.retain(7, withGetters("call:4", { lifecycle: flips(Symbol("bad-first"), "complete", reads, "lifecycleBad") }))).toBeFalse();
		expect(registry.retain(7, withGetters("call:5", { lifecycle: () => { throw new Error("first read boom"); } }))).toBeFalse();
		// Nested attempt fields flip good→Symbol/good→wrong-type: first values kept, one read each.
		const attemptReads: Record<string, number> = {};
		const attemptLane = { ...artifact({ key: "call:6" }) } as Record<string, unknown>;
		const attempt: Record<string, unknown> = {
			ordinal: 1,
			kind: "fallback",
			exitCode: 1,
			lifecycle: "partial",
			retryable: true,
			elapsedMs: 20,
			toolElapsedMs: 5,
			toolCallCount: 1,
		};
		Object.defineProperty(attempt, "rawText", { get: flips("partial evidence", Symbol("hostile"), attemptReads, "rawText"), enumerable: true, configurable: true });
		Object.defineProperty(attempt, "observedModel", { get: flips("provider/fallback", 42, attemptReads, "observedModel"), enumerable: true, configurable: true });
		attemptLane.attempts = [attempt as never];
		expect(registry.retain(7, attemptLane as unknown as ReviewLaneArtifact)).toBeTrue();
		// Exactly one read per property: validation never rereads the getters and
		// neither does the snapshot copy.
		expect(reads.rawText).toBe(1);
		expect(reads.errorMessage).toBe(1);
		expect(reads.requestedModel).toBe(1);
		expect(reads.passId).toBe(1);
		expect(reads.lifecycleBad).toBe(1);
		expect(attemptReads.rawText).toBe(1);
		expect(attemptReads.observedModel).toBe(1);
		// The stored snapshots hold the first valid values and are stable.
		const snapshot = registry.snapshot(7)!;
		expect(snapshot.find((lane) => lane.key === "call:0")?.rawText).toBe("NO FINDINGS.");
		expect(snapshot.find((lane) => lane.key === "call:1")?.errorMessage).toBe("429 capacity");
		expect(snapshot.find((lane) => lane.key === "call:2")?.requestedModel).toBe("provider/primary");
		expect(snapshot.find((lane) => lane.key === "call:3")?.passId).toBe("correctness");
		expect(snapshot.find((lane) => lane.key === "call:6")?.attempts[0]?.rawText).toBe("partial evidence");
		expect(snapshot.find((lane) => lane.key === "call:6")?.attempts[0]?.observedModel).toBe("provider/fallback");
		// Valid siblings of dropped lanes remain retained (call:4/call:5 dropped).
		expect(snapshot.map((lane) => lane.key).sort()).toEqual(["call:0", "call:1", "call:2", "call:3", "call:6"]);
	});

	test("retains a safe frozen snapshot, not the hostile original", () => {
		const registry = new ReviewLaneArtifactRegistry();
		registry.open(7);
		expect(registry.expect(7, [
			{ key: "call:0", tier: "heavy", minorHygiene: false },
			{ key: "call:1", tier: "heavy", minorHygiene: false },
		])).toBeTrue();
		// A full production artifact with real fallback attempt shapes retains.
		const full = artifact({
			fallbackUsed: true,
			deadlineExpired: "total",
			deadlineSource: "user",
			requestedPassOrdinal: 3,
			minorHygiene: undefined,
			batchDeadlineMs: 90_000,
			totalDeadlineMs: 180_000,
			firstEventMs: 12.5,
			startOffsetMs: 1.5,
			endOffsetMs: 2.5,
			fallbackBudgetRejected: true,
			attempts: [
				{
					ordinal: 1,
					kind: "fallback",
					requestedModel: "provider/primary",
					observedModel: "provider/fallback",
					usedTier: "light",
					rawText: "partial primary evidence",
					exitCode: 1,
					processSignal: "SIGKILL",
					stopReason: "error",
					errorMessage: "429 capacity",
					lifecycle: "partial",
					deadlineExpired: "synthesis",
					retryable: true,
					elapsedMs: 20,
					firstEventMs: 3,
					firstAssistantMs: 5,
					toolElapsedMs: 5,
					toolCallCount: 1,
					timedOut: true,
					terminationGraceMs: 100,
					forcedTermination: true,
					deadlineMs: 30_000,
					configuredDeadlineMs: 60_000,
				},
				{
					ordinal: 2,
					rawText: "NO FINDINGS.",
					exitCode: 0,
					stopReason: "stop",
					lifecycle: "complete",
					retryable: false,
					elapsedMs: 40,
					toolElapsedMs: 0,
					toolCallCount: 0,
				},
			],
		} as ReviewLaneArtifact);
		expect(registry.retain(7, full)).toBeTrue();
		const snapshot = registry.snapshot(7)![0]!;
		expect(snapshot.attempts).toHaveLength(2);
		expect(snapshot.attempts[0]?.kind).toBe("fallback");
		expect(snapshot.attempts[1]?.kind).toBeUndefined();
		expect(Object.isFrozen(snapshot)).toBeTrue();
		expect(Object.isFrozen(snapshot.attempts)).toBeTrue();
		expect(Object.isFrozen(snapshot.attempts[0])).toBeTrue();
		// The snapshot is a copy: later mutation of the original cannot poison it.
		(full as unknown as { rawText: string }).rawText = "poisoned";
		expect(snapshot.rawText).toBe("NO FINDINGS.");
		// Mixed valid and malformed siblings: the malformed lane drops, the valid one stays.
		expect(registry.retain(7, { ...artifact({ key: "call:1" }), errorMessage: Symbol("kaboom") } as unknown as ReviewLaneArtifact)).toBeFalse();
		expect(registry.retain(7, artifact({ key: "call:1", passId: "second" }))).toBeTrue();
		expect(registry.snapshot(7)!.map((lane) => lane.passId)).toEqual(["correctness-shard-2", "second"]);
	});
});
