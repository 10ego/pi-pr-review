#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const LIFECYCLES = ["complete", "partial", "timed_out", "failed"];
function invariant(condition, message) { if (!condition) throw new Error(`Dogfood report invalid: ${message}`); }
function verdict(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim(), fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i), jsonText = fenced?.[1] ?? trimmed;
	try { const parsed = JSON.parse(jsonText); if (parsed && typeof parsed === "object" && typeof parsed.verdict === "string") return parsed.verdict; } catch {}
	const match = text.match(/^\*\*Verdict:\*\*\s*([^\n]+)/mi);
	return match?.[1]?.trim() ?? null;
}
function assistantText(message) {
	return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";
}
function readBoundedRegular(file, label) { const absolute = path.resolve(file), stat = fs.lstatSync(absolute); invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`); invariant(stat.size > 0 && stat.size <= MAX_SESSION_BYTES, `${label} must be 1..${MAX_SESSION_BYTES} bytes`); return fs.readFileSync(absolute, "utf8"); }
export function buildDogfoodReport(sessionFile, visibleOutputFile) {
	const sessionText = readBoundedRegular(sessionFile, "session");
	const records = sessionText.split("\n").filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Dogfood report invalid: malformed JSONL record ${index + 1}`); } });
	const completedIndexes = records.map((record, index) => record?.type === "custom" && record.customType === "pr-review-completed" ? index : -1).filter((index) => index >= 0), telemetry = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-telemetry" && record.data?.completion === "terminal_response");
	invariant(completedIndexes.length === 1, "requires exactly one completed review"); invariant(telemetry.length === 1, "requires exactly one terminal telemetry record");
	const completedIndex = completedIndexes[0], data = records[completedIndex].data, timing = telemetry[0].data, lanes = Array.isArray(data?.laneArtifacts) ? data.laneArtifacts : [], rawText = typeof data?.rawText === "string" ? data.rawText : "";
	const boundAssistants = records.slice(0, completedIndex).filter((record) => record?.type === "message" && record.message?.role === "assistant" && record.message?.stopReason === "stop" && assistantText(record.message) === rawText);
	invariant(rawText.length > 0 && boundAssistants.length === 1, "completed review is not uniquely bound to its terminal assistant message");
	const terminalText = assistantText(boundAssistants[0].message), publicationText = typeof data?.publicationBody === "string" ? data.publicationBody : terminalText;
	invariant(data?.invocation?.mode === "disabled", "dogfood run was not --no-comment"); invariant(Number.isFinite(timing.totalWallMs) && timing.totalWallMs >= 0, "invalid totalWallMs");
	const contextLimitPattern = /context(?:_| )[ -]?(?:length|window)(?:_| )?exceeded|context window|input exceeds|maximum context length|prompt is too long/i;
	const lifecycleCounts = Object.fromEntries(LIFECYCLES.map((state) => [state, lanes.filter((lane) => lane?.lifecycle === state).length])), contextLimitFailures = lanes.flatMap((lane) => Array.isArray(lane?.attempts) ? lane.attempts : []).filter((attempt) => contextLimitPattern.test(String(attempt?.errorMessage ?? ""))).length;
	// Pi persists the original assistant message, not the extension's rendered
	// print projection. Verdict parity is measurable only when the caller retains
	// and supplies stdout; never infer historical visible output from host state.
	const referencedReview = typeof data?.reviewEntryId === "string" ? records.find((record) => record?.type === "message" && record.id === data.reviewEntryId && record.message?.role === "assistant") : undefined;
	invariant(data?.reviewEntryId === undefined || referencedReview, "completed review references a missing assistant entry");
	const persistedHostVerdict = typeof data?.review?.verdict === "string" ? data.review.verdict : referencedReview ? verdict(assistantText(referencedReview.message)) : null;
	const hostVerdict = typeof data?.publicationBody === "string" ? verdict(publicationText) : persistedHostVerdict, visibleVerdict = visibleOutputFile ? verdict(readBoundedRegular(visibleOutputFile, "visible output")) : null, modelVerdict = verdict(rawText), sessionTerminalVerdict = verdict(terminalText);
	return {
		schemaVersion: 1,
		prNumber: data?.invocation?.prNumber ?? data?.review?.pr?.number ?? null,
		invocationMode: data.invocation.mode,
		completeness: data?.completeness ?? null,
		synthesisQuality: data?.synthesisQuality ?? null,
		expectedLaneCount: data?.expectedLaneCount ?? null,
		retainedLaneCount: lanes.length,
		lifecycleCounts,
		contextLimitFailures,
		verdicts: { model: modelVerdict, sessionTerminal: sessionTerminalVerdict, visible: visibleVerdict, host: hostVerdict, visibleMatchesHost: visibleVerdict === null ? null : visibleVerdict === hostVerdict },
		timingMs: {
			total: timing.totalWallMs,
			reviewTools: timing?.phases?.reviewSubagentTools?.elapsedMs ?? null,
			parentOrchestration: timing?.phases?.aggregateOrchestration?.elapsedMs ?? null,
		},
	};
}
function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) { const key = argv[index], value = argv[index + 1]; invariant(["--session", "--stdout", "--output"].includes(key) && value && !options[key], `invalid argument near ${key ?? "end"}`); options[key] = value; }
	invariant(options["--session"], "missing --session"); return options;
}
async function main() { const options = parseArgs(process.argv.slice(2)), report = buildDogfoodReport(options["--session"], options["--stdout"]), body = `${JSON.stringify(report, null, 2)}\n`; if (options["--output"]) fs.writeFileSync(options["--output"], body, { flag: "wx", mode: 0o600 }); else process.stdout.write(body); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
