import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const testsDirectory = path.join(root, "tests");
const files = fs.readdirSync(testsDirectory, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
	.map((entry) => `tests/${entry.name}`)
	.sort();

if (files.length === 0) {
	console.error("No top-level Bun test files found.");
	process.exit(1);
}

for (const file of files) {
	console.log(`\n=== bun test ${file} ===`);
	const result = spawnSync("bun", ["test", file], {
		cwd: root,
		stdio: "inherit",
		shell: false,
	});
	if (result.error) {
		console.error(`Could not run ${file}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nVerified ${files.length} isolated Bun test files.`);
