import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
	assertPackageContents,
	assertPackageMetadata,
	EXPECTED_PACKAGE_FILES,
	resolveNpmPackInvocation,
	verifyPackageContents,
} from "../../scripts/verify-package-contents.mjs";

function clone(value) {
	return structuredClone(value);
}

describe("npm release package policy", () => {
	const current = verifyPackageContents(process.cwd());
	const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

	test("accepts the current lifecycle-script-disabled package", () => {
		assert.equal(current.package.name, "pi-pr-review");
		assert.equal(current.package.version, packageJson.version);
		assert.equal(current.paths.length, 25);
	});

	test("rejects unsafe, unexpected, executable, oversized, and duplicate paths", () => {
		const files = current.package.files;
		for (const invalid of [
			{ path: "../secret.md", size: 1, mode: 0o644 },
			{ path: ".github/workflows/release.yml", size: 1, mode: 0o644 },
			{ path: "tests/secret.test.ts", size: 1, mode: 0o644 },
			{ path: "lib/payload.sh", size: 1, mode: 0o644 },
			{ path: "lib/executable.ts", size: 1, mode: 0o755 },
			{ path: "lib/oversized.ts", size: 6 * 1024 * 1024, mode: 0o644 },
		]) {
			assert.throws(() => assertPackageContents([...files, invalid]), /Package invariant failed/);
		}
		assert.throws(() => assertPackageContents([...files, files[0]]), /duplicate paths/);
	});

	test("rejects missing required entry points", () => {
		const files = current.package.files.filter((file) => file.path !== "extensions/index.ts");
		assert.throws(() => assertPackageContents(files), /missing required path/);
	});

	test("invokes npm's CLI through Node on Windows and POSIX, then fails closed when it is unavailable", () => {
		const windows = resolveNpmPackInvocation({
			platform: "win32",
			execPath: "C:\\node\\node.exe",
			npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
			exists: (candidate) => candidate.endsWith("npm-cli.js"),
		});
		assert.equal(windows.command, "C:\\node\\node.exe");
		assert.deepEqual(windows.arguments, [
			"C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
			"pack",
			"--dry-run",
			"--ignore-scripts",
			"--json",
		]);

		const posix = resolveNpmPackInvocation({
			platform: "linux",
			execPath: "/opt/node/bin/node",
			npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
			exists: (candidate) => candidate === "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
		});
		assert.equal(posix.command, "/opt/node/bin/node");
		assert.equal(posix.arguments[0], "/opt/node/lib/node_modules/npm/bin/npm-cli.js");
		assert.throws(
			() => resolveNpmPackInvocation({ platform: "linux", execPath: "/opt/node/bin/node", npmExecPath: "", exists: () => false }),
			/could not resolve npm-cli\.js/,
		);
	});

	test("strictly parses every packaged TypeScript module through a real module parser", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-duplicate-source-"));
		try {
			for (const filePath of current.paths) {
				const destination = path.join(directory, filePath);
				fs.mkdirSync(path.dirname(destination), { recursive: true });
				fs.copyFileSync(path.join(process.cwd(), filePath), destination);
			}
			const probe = path.join(directory, "lib/pr-review-markdown.ts");
			fs.appendFileSync(probe, [
				"",
				"/* function commentedLoaderProbe<T>() {} */",
				"const loaderRegexProbe = /[`]/;",
				"const loaderTemplateProbe = `function templatedLoaderProbe<T>() {}`;",
				"function validLoaderProbe<T extends { value: string }>(value: T): Readonly<{ value: string }>;",
				"function validLoaderProbe<T extends { value: string }>(value: T): Readonly<{ value: string }> { return value; }",
				"",
			].join("\n"));
			assert.doesNotThrow(() => verifyPackageContents(directory));

			fs.appendFileSync(
				probe,
				"function duplicateLoaderProbe<T extends { value: string }>(): void {}\nfunction duplicateLoaderProbe<T extends { value: string }>(): void {}\n",
			);
			assert.throws(
				() => verifyPackageContents(directory),
				/lib[\\/]pr-review-markdown\.ts: Identifier 'duplicateLoaderProbe' has already been declared/,
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects unsafe package metadata and lifecycle scripts", () => {
		const data = clone(current.package);
		assert.doesNotThrow(() => assertPackageMetadata(data, packageJson, current.paths.length));
		assert.throws(
			() => assertPackageMetadata(data, { ...packageJson, files: [...EXPECTED_PACKAGE_FILES, "tests/"] }, current.paths.length),
			/files policy must remain exact/,
		);
		assert.throws(
			() => assertPackageMetadata(data, { ...packageJson, scripts: { ...packageJson.scripts, prepack: "node payload.js" } }, current.paths.length),
			/lifecycle script is forbidden/,
		);
		assert.throws(
			() => assertPackageMetadata(data, { ...packageJson, publishConfig: { ...packageJson.publishConfig, provenance: false } }, current.paths.length),
			/provenance must be enabled/,
		);
	});

	test("never runs package lifecycle scripts during inspection", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-review-package-policy-"));
		try {
			fs.writeFileSync(path.join(directory, "README.md"), "probe\n");
			fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
				name: "pi-pr-review",
				version: "1.0.0",
				files: ["README.md"],
				scripts: {
					prepack: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
				},
			}));
			assert.throws(() => verifyPackageContents(directory), /Package invariant failed/);
			assert.equal(fs.existsSync(path.join(directory, "lifecycle-ran")), false);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
