import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDogfoodReport } from "./pr-review-dogfood-report.mjs";

function session(records) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-dogfood-report-")), file = path.join(root, "session.jsonl"); fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`); return file; }
const raw = "# PR Review\n\n**Verdict:** approve", canonical = "# PR Review\n\n**Verdict:** Comment — incomplete lanes";
const records = [
	{ type: "session", version: 3 },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: raw }], stopReason: "stop" } },
	{ type: "custom", customType: "pr-review-telemetry", data: { completion: "terminal_response", totalWallMs: 100, phases: { reviewSubagentTools: { elapsedMs: 60 }, aggregateOrchestration: { elapsedMs: 40 } } } },
	{ type: "custom", customType: "pr-review-completed", data: { invocation: { mode: "disabled", prNumber: 7 }, completeness: "incomplete", synthesisQuality: "partially_parsed", expectedLaneCount: 2, rawText: raw, publicationBody: canonical, laneArtifacts: [{ lifecycle: "complete", attempts: [] }, { lifecycle: "failed", attempts: [{ errorMessage: "context_length_exceeded" }, { errorMessage: "maximum context length reached" }, { errorMessage: "prompt is too long" }] }] } },
];

test("dogfood report binds no-comment completion, verdict parity, lanes, and timing", () => {
	const file = session(records), stdout = path.join(path.dirname(file), "stdout.log"); fs.writeFileSync(stdout, canonical);
	assert.deepEqual(buildDogfoodReport(file, stdout), { schemaVersion: 1, prNumber: 7, invocationMode: "disabled", completeness: "incomplete", synthesisQuality: "partially_parsed", expectedLaneCount: 2, retainedLaneCount: 2, lifecycleCounts: { complete: 1, partial: 0, timed_out: 0, failed: 1 }, contextLimitFailures: 3, verdicts: { model: "approve", sessionTerminal: "approve", visible: "Comment — incomplete lanes", host: "Comment — incomplete lanes", visibleMatchesHost: true }, timingMs: { total: 100, reviewTools: 60, parentOrchestration: 40 } });
	assert.deepEqual(buildDogfoodReport(file).verdicts, { model: "approve", sessionTerminal: "approve", visible: null, host: "Comment — incomplete lanes", visibleMatchesHost: null });
	const later = structuredClone(records); later.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "**Verdict:** unrelated" }], stopReason: "stop" } }); assert.equal(buildDogfoodReport(session(later), stdout).verdicts.sessionTerminal, "approve");
	const referenced = structuredClone(records), referencedJson = JSON.stringify({ pr: { number: 7 }, findings: [], verdict: "approve" }); referenced[1].id = "review-entry"; referenced[1].message.content[0].text = referencedJson; delete referenced[3].data.publicationBody; referenced[3].data.rawText = referencedJson; referenced[3].data.reviewEntryId = "review-entry"; const referencedFile = session(referenced), referencedStdout = path.join(path.dirname(referencedFile), "stdout.log"); fs.writeFileSync(referencedStdout, referencedJson); assert.deepEqual(buildDogfoodReport(referencedFile, referencedStdout).verdicts, { model: "approve", sessionTerminal: "approve", visible: "approve", host: "approve", visibleMatchesHost: true });
});

test("dogfood report rejects publish-enabled and ambiguous sessions", () => {
	const enabled = structuredClone(records); enabled[3].data.invocation.mode = "force"; assert.throws(() => buildDogfoodReport(session(enabled)), /not --no-comment/);
	assert.throws(() => buildDogfoodReport(session(records.filter((record) => record.customType !== "pr-review-telemetry"))), /terminal telemetry/);
});
