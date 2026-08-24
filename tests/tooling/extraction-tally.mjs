#!/usr/bin/env node
/**
 * Development-only §9 extraction gate tally.
 *
 * Scans Pi session logs for `pr-review-extraction` entries and prints the
 * live Phase 2 scoreboard. NOT shipped to end users: this file lives under
 * tests/tooling/ (excluded from the npm package) and is invoked by
 * maintainers during development, never registered as a Pi command.
 *
 * Usage: node tests/tooling/extraction-tally.mjs [sessionDir]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sessionDir = process.argv[2] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
const GATE = { successRate: 0.95, provenanceRejectionRate: 0.05, overheadP50Ms: 20_000 };

/** Collect pr-review-extraction entries across every session log. */
export function collectExtractionEntries(dir = sessionDir) {
	const entries = [];
	let filesScanned = 0;
	if (!fs.existsSync(dir)) return { entries, filesScanned };
	for (const project of fs.readdirSync(dir)) {
		const projectDir = path.join(dir, project);
		if (!fs.statSync(projectDir).isDirectory()) continue;
		for (const file of fs.readdirSync(projectDir)) {
			if (!file.endsWith(".jsonl")) continue;
			filesScanned++;
			const filePath = path.join(projectDir, file);
			let text;
			try {
				text = fs.readFileSync(filePath, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line.includes('"pr-review-extraction"')) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed?.type === "custom" && parsed?.customType === "pr-review-extraction") {
						entries.push({ ...parsed.data, timestamp: parsed.timestamp, source: filePath });
					}
				} catch {
					/* skip malformed lines */
				}
			}
		}
	}
	return { entries, filesScanned };
}

/** Merge entries into one run each: the terminal outcome wins over intermediate ones. */
export function tallyRuns(entries) {
	const byRun = new Map();
	for (const entry of entries) {
		const key = entry.source;
		const mergedRuns = byRun.get(key) ?? [];
		// A "merged"/"published" entry completes a run; earlier outcomes for the
		// same source line up behind it. Keep insertion order per source.
		mergedRuns.push(entry);
		byRun.set(key, mergedRuns);
	}
	const runs = [];
	for (const runEntries of byRun.values()) {
		const terminal = runEntries.findLast((entry) => entry.outcome === "published")
			?? runEntries.findLast((entry) => entry.outcome === "merged")
			?? runEntries.at(-1);
		runs.push(terminal);
	}
	return runs;
}

/** Compute the §9 gate metrics from terminal per-run outcomes. */
export function computeGateMetrics(runs) {
	const total = runs.length;
	const succeeded = runs.filter((run) => run.outcome === "merged" || run.outcome === "published").length;
	const provenanceRejected = runs.reduce((total, run) => total + (run.counts?.findingsRejectedProvenance ?? 0), 0);
	const extractedTotal = runs.reduce((total, run) => total + (run.counts?.findingsExtracted ?? 0), 0);
	const mergedTotal = runs.reduce((total, run) => total + (run.counts?.findingsMerged ?? 0), 0);
	const elapsed = runs.map((run) => run.elapsedMs ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
	const p50 = elapsed.length > 0 ? elapsed[Math.floor((elapsed.length - 1) / 2)] : 0;
	return {
		total,
		succeeded,
		successRate: total > 0 ? succeeded / total : 0,
		provenanceRejectionRate: extractedTotal > 0 ? provenanceRejected / extractedTotal : 0,
		findingsExtracted: extractedTotal,
		findingsMerged: mergedTotal,
		p50ElapsedMs: p50,
	};
}

export function formatScoreboard(runs, metrics) {
	const pct = (value) => `${(value * 100).toFixed(0)}%`;
	const lines = [
		"Extraction §9 gate scoreboard",
		"============================",
		`Runs (terminal outcomes)      : ${metrics.total}`,
		`  merged/published            : ${metrics.succeeded}`,
		`  success rate                : ${pct(metrics.successRate)}  (gate ≥ ${pct(GATE.successRate)})`,
		`Provenance rejection rate     : ${pct(metrics.provenanceRejectionRate)}  (gate < ${pct(GATE.provenanceRejectionRate)})`,
		`Findings extracted / merged   : ${metrics.findingsExtracted} / ${metrics.findingsMerged}`,
		`Extraction elapsed p50        : ${(metrics.p50ElapsedMs / 1000).toFixed(1)}s  (gate ≤ ${GATE.overheadP50Ms / 1000}s)`,
		"",
	];
	if (metrics.total < 15) {
		lines.push(
			`Insufficient sample: ${metrics.total}/15 runs. Keep the flag on and let degraded`,
			"reviews accumulate before making the Phase 2 default-on decision.",
			"",
		);
	}
	const byOutcome = new Map();
	for (const run of runs) byOutcome.set(run.outcome, (byOutcome.get(run.outcome) ?? 0) + 1);
	lines.push("Outcomes:", ...[...byOutcome.entries()].sort().map(([outcome, count]) => `  ${outcome.padEnd(10)} ${count}`));
	return lines.join("\n");
}

// CLI entry point (development use only).
if (import.meta.url === `file://${process.argv[1]}`) {
	const { entries, filesScanned } = collectExtractionEntries();
	const runs = tallyRuns(entries);
	const metrics = computeGateMetrics(runs);
	console.log(`Scanned ${filesScanned} session logs in ${sessionDir}`);
	console.log(formatScoreboard(runs, metrics));
}
