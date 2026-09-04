import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { verifyTestLockfileData } from "../../scripts/verify-test-lockfile.mjs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

test("test dependency lock pins every remote package with SHA-512 integrity", () => {
	assert.doesNotThrow(() => verifyTestLockfileData(lock, packageJson));
	const packagePath = Object.keys(lock.packages).find((key) => key !== "");
	assert.ok(packagePath);
	for (const mutation of [
		(entry) => { delete entry.integrity; },
		(entry) => { entry.integrity = "sha1-unsafe"; },
		(entry) => { entry.resolved = "https://example.com/package.tgz"; },
	]) {
		const malformed = structuredClone(lock);
		mutation(malformed.packages[packagePath]);
		assert.throws(() => verifyTestLockfileData(malformed, packageJson), /integrity|registry resolution/);
	}
});
