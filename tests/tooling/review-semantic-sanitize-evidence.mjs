#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function redactString(value, entryId, accountName) {
	return value
		.replaceAll(accountName, "reviewer")
		.replace(/(?:\/private)?\/var\/folders\/[^\s\\"'`]+/gu, `/private/tmp/host-path-redacted/${entryId}`);
}
function redact(value, entryId, accountName) {
	if (typeof value === "string") return redactString(value, entryId, accountName);
	if (Array.isArray(value)) return value.map((item) => redact(item, entryId, accountName));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, entryId, accountName)]));
	return value;
}
function sanitizeSession(bytes, entryId, accountName) {
	const text = bytes.toString("utf8"), lines = text.split("\n").filter(Boolean); try { return Buffer.from(lines.map((line) => JSON.stringify(redact(JSON.parse(line), entryId, accountName))).join("\n") + (lines.length > 0 ? "\n" : "")); } catch { return Buffer.from(redactString(text, entryId, accountName)); }
}
export function sanitizeBundle(bundle, accountName = os.userInfo().username) {
	if (typeof accountName !== "string" || accountName.length === 0) throw new Error("local account name is unavailable"); const runsDirectory = path.join(bundle, "runs"), names = fs.readdirSync(runsDirectory).filter((name) => name.endsWith(".json")).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	for (const name of names) {
		const file = path.join(runsDirectory, name), original = JSON.parse(fs.readFileSync(file, "utf8")), entryId = original.planEntryId, payloads = {};
		for (const reference of original.artifacts) {
			let payload = JSON.parse(Buffer.from(original.artifactPayloads[reference.path], "base64").toString("utf8"));
			if (reference.kind === "lane-artifacts" && payload.raw.session.contentBase64 !== null) {
				const session = Buffer.from(payload.raw.session.contentBase64, "base64"), sanitized = sanitizeSession(session, entryId, accountName);
				payload.raw.session = { ...payload.raw.session, sha256: sha256(sanitized), bytes: sanitized.length, recordCount: sanitized.toString("utf8").split("\n").filter(Boolean).length, contentBase64: sanitized.toString("base64") };
			}
			payload = redact(payload, entryId, accountName); const bytes = Buffer.from(canonicalJson(payload)); reference.sha256 = sha256(bytes); reference.bytes = bytes.length; payloads[reference.path] = bytes.toString("base64");
		}
		const run = redact({ ...original, artifactPayloads: payloads }, entryId, accountName); fs.writeFileSync(file, canonicalJson(run));
	}
	return names.length;
}

if (import.meta.url === new URL(`file://${path.resolve(process.argv[1] ?? "")}`).href) {
	const bundle = process.argv[2]; if (!bundle || !path.isAbsolute(bundle)) throw new Error("usage: review-semantic-sanitize-evidence.mjs /absolute/bundle"); console.log(`Sanitized ${sanitizeBundle(bundle)} semantic evidence rows.`);
}
