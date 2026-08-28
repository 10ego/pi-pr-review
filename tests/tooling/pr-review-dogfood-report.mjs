#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const LIFECYCLES = ["complete", "partial", "timed_out", "failed"];
function invariant(condition, message) { if (!condition) throw new Error(`Dogfood report invalid: ${message}`); }
function verdict(text) {
	if (typeof text !== "string") return null;
	const match = text.match(/^\*\*Verdict:\*\*\s*([^\n]+)/mi);
	return match?.[1]?.trim() ?? null;
}
function assistantText(message) {
	return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";
}
export function buildDogfoodReport(sessionFile) {
	const absolute = path.resolve(sessionFile), stat = fs.lstatSync(absolute); invariant(stat.isFile() && !stat.isSymbolicLink(), "session must be a regular non-symlink file"); invariant(stat.size > 0 && stat.size <= MAX_SESSION_BYTES, `session must be 1..${MAX_SESSION_BYTES} bytes`);
	const records = fs.readFileSync(absolute, "utf8").split("\n").filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Dogfood report invalid: malformed JSONL record ${index + 1}`); } });
	const completed = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-completed"), telemetry = records.filter((record) => record?.type === "custom" && record.customType === "pr-review-telemetry" && record.data?.completion === "terminal_response"), assistants = records.filter((record) => record?.type === "message" && record.message?.role === "assistant");
	invariant(completed.length === 1, "requires exactly one completed review"); invariant(telemetry.length === 1, "requires exactly one terminal telemetry record"); invariant(assistants.length > 0, "requires a terminal assistant message");
	const data = completed[0].data, timing = telemetry[0].data, lanes = Array.isArray(data?.laneArtifacts) ? data.laneArtifacts : [], terminalText = assistantText(assistants.at(-1).message), publicationText = typeof data?.publicationBody === "string" ? data.publicationBody : terminalText, rawText = typeof data?.rawText === "string" ? data.rawText : "";
	invariant(data?.invocation?.mode === "disabled", "dogfood run was not --no-comment"); invariant(Number.isFinite(timing.totalWallMs) && timing.totalWallMs >= 0, "invalid totalWallMs");
	const lifecycleCounts = Object.fromEntries(LIFECYCLES.map((state) => [state, lanes.filter((lane) => lane?.lifecycle === state).length])), contextLimitFailures = lanes.flatMap((lane) => Array.isArray(lane?.attempts) ? lane.attempts : []).filter((attempt) => /context window|input exceeds/i.test(String(attempt?.errorMessage ?? ""))).length;
	const hostVerdict = verdict(publicationText), visibleVerdict = verdict(terminalText), modelVerdict = verdict(rawText);
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
		verdicts: { model: modelVerdict, visible: visibleVerdict, host: hostVerdict, visibleMatchesHost: visibleVerdict === hostVerdict },
		timingMs: {
			total: timing.totalWallMs,
			reviewTools: timing?.phases?.reviewSubagentTools?.elapsedMs ?? null,
			parentOrchestration: timing?.phases?.aggregateOrchestration?.elapsedMs ?? null,
		},
	};
}
function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) { const key = argv[index], value = argv[index + 1]; invariant(["--session", "--output"].includes(key) && value && !options[key], `invalid argument near ${key ?? "end"}`); options[key] = value; }
	invariant(options["--session"], "missing --session"); return options;
}
async function main() { const options = parseArgs(process.argv.slice(2)), report = buildDogfoodReport(options["--session"]), body = `${JSON.stringify(report, null, 2)}\n`; if (options["--output"]) fs.writeFileSync(options["--output"], body, { flag: "wx", mode: 0o600 }); else process.stdout.write(body); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
