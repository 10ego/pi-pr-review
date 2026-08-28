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
const OPAQUE_BINDING_KEYS = new Set(["artifactPayloads", "contentBase64", "sha256"]);
function redact(value, entryId, accountName, key = "") {
	if (OPAQUE_BINDING_KEYS.has(key)) return value;
	if (typeof value === "string") return redactString(value, entryId, accountName);
	if (Array.isArray(value)) return value.map((item) => redact(item, entryId, accountName));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redact(item, entryId, accountName, childKey)]));
	return value;
}
function sanitizeSession(bytes, entryId, accountName) {
	const text = bytes.toString("utf8"), lines = text.split("\n").filter(Boolean); try { return Buffer.from(lines.map((line) => JSON.stringify(redact(JSON.parse(line), entryId, accountName))).join("\n") + (lines.length > 0 ? "\n" : "")); } catch { return Buffer.from(redactString(text, entryId, accountName)); }
}
function sanitizedSessionRecord(record, entryId, accountName) {
	if (!record || typeof record !== "object" || typeof record.contentBase64 !== "string") return record;
	const sanitized = sanitizeSession(Buffer.from(record.contentBase64, "base64"), entryId, accountName);
	return { ...record, sha256: sha256(sanitized), bytes: sanitized.length, recordCount: sanitized.toString("utf8").split("\n").filter(Boolean).length, contentBase64: sanitized.toString("base64") };
}
function replaceAtomic(file, bytes) {
	const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
	let descriptor;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
		fs.renameSync(temporary, file);
		// The rename is atomic without a directory fsync. Sync the directory when
		// the platform supports it, but do not report a failed sanitization after
		// replacement merely because Windows or the backing filesystem rejects
		// directory descriptors/fsync.
		let directory;
		try { directory = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(directory); }
		catch (error) { if (!["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) throw error; }
		finally { if (directory !== undefined) fs.closeSync(directory); }
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
}
export function sanitizeBundle(bundle, accountName = os.userInfo().username) {
	if (typeof accountName !== "string" || accountName.length === 0) throw new Error("local account name is unavailable"); const runsDirectory = path.join(bundle, "runs"), names = fs.readdirSync(runsDirectory).filter((name) => name.endsWith(".json")).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	for (const name of names) {
		const file = path.join(runsDirectory, name), original = JSON.parse(fs.readFileSync(file, "utf8")), entryId = original.planEntryId, payloads = {}, references = original.artifacts.map((reference) => ({ ...reference }));
		for (const reference of references) {
			let payload = JSON.parse(Buffer.from(original.artifactPayloads[reference.path], "base64").toString("utf8"));
			if (reference.kind === "lane-artifacts" && payload?.raw?.session) {
				const session = payload.raw.session;
				payload.raw.session = {
					...session,
					...(session.contentBase64 !== null ? sanitizedSessionRecord(session, entryId, accountName) : {}),
					...(Array.isArray(session.files) ? { files: session.files.map((item) => sanitizedSessionRecord(item, entryId, accountName)) } : {}),
				};
			}
			payload = redact(payload, entryId, accountName); const bytes = Buffer.from(canonicalJson(payload)); reference.sha256 = sha256(bytes); reference.bytes = bytes.length; payloads[reference.path] = bytes.toString("base64");
		}
		const run = redact({ ...original, artifacts: references }, entryId, accountName); run.artifactPayloads = payloads; replaceAtomic(file, canonicalJson(run));
	}
	return names.length;
}

if (import.meta.url === new URL(`file://${path.resolve(process.argv[1] ?? "")}`).href) {
	const bundle = process.argv[2]; if (!bundle || !path.isAbsolute(bundle)) throw new Error("usage: review-semantic-sanitize-evidence.mjs /absolute/bundle"); console.log(`Sanitized ${sanitizeBundle(bundle)} semantic evidence rows.`);
}
