import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PACKAGE_FILES = Object.freeze([
	"README.md",
	"CHANGELOG.md",
	"extensions/",
	"lib/",
	"prompts/",
]);

export const EXPECTED_EXTENSIONS = Object.freeze(["./extensions/index.ts"]);
export const EXPECTED_PROMPTS = Object.freeze(["./prompts"]);

const REQUIRED_PACKAGE_PATHS = Object.freeze([
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"extensions/index.ts",
	"extensions/pr-review-focus.ts",
	"extensions/pr-review-subagent.ts",
	"extensions/review-table.ts",
	"lib/pr-review-concurrency.ts",
	"lib/pr-review-context.ts",
	"lib/pr-review-extract.ts",
	"lib/pr-review-focus.ts",
	"lib/pr-review-loop.ts",
	"lib/pr-review-markdown.ts",
	"lib/pr-review-policy.ts",
	"lib/pr-review-publish.ts",
	"lib/pr-review-telemetry.ts",
	"lib/pr-review-thinking.ts",
	"lib/pr-review-verify.ts",
	"lib/pr-self-review-rpc.ts",
	"lib/pr-self-review.ts",
	"lib/trusted-executable.ts",
	"prompts/pr-review.md",
]);

const EXPECTED_PEER_DEPENDENCIES = Object.freeze({
	"@earendil-works/pi-ai": "*",
	"@earendil-works/pi-coding-agent": ">=0.80.5",
	"@earendil-works/pi-tui": "*",
	typebox: "*",
});

const FORBIDDEN_SEGMENTS = new Set([
	".git",
	".github",
	".pi",
	".auto",
	"coverage",
	"dist",
	"node_modules",
	"scripts",
	"tests",
	"tmp",
]);

const FORBIDDEN_LIFECYCLE_SCRIPTS = Object.freeze([
	"preinstall",
	"install",
	"postinstall",
	"prepack",
	"prepare",
	"postpack",
	"prepublish",
	"prepublishOnly",
	"publish",
	"postpublish",
]);

const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".ts"]);

function invariant(condition, message) {
	if (!condition) throw new Error(`Package invariant failed: ${message}`);
}

function matchesFilesAllowlist(filePath) {
	if (filePath === "package.json") return true;
	return EXPECTED_PACKAGE_FILES.some((entry) => entry.endsWith("/")
		? filePath.startsWith(entry) && filePath.length > entry.length
		: filePath === entry);
}

export function assertPackageContents(files) {
	invariant(Array.isArray(files), "npm pack output must contain a files array");
	invariant(files.length > 0 && files.length <= 100, "package must contain between 1 and 100 files");

	const paths = files.map((file) => {
		invariant(file && typeof file.path === "string", "each npm pack file must have a string path");
		const normalized = file.path.replaceAll("\\", "/").replace(/^\.\//, "");
		const segments = normalized.split("/");
		invariant(
			normalized === file.path
				&& !normalized.startsWith("/")
				&& !/^[A-Za-z]:\//.test(normalized)
				&& segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
			`unsafe package path: ${file.path}`,
		);
		invariant(!segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)), `forbidden package path: ${normalized}`);
		invariant(matchesFilesAllowlist(normalized), `path is outside package.json files policy: ${normalized}`);
		invariant(ALLOWED_EXTENSIONS.has(path.extname(normalized)), `unsupported package file type: ${normalized}`);
		invariant(Number.isInteger(file.size) && file.size >= 0 && file.size <= 5 * 1024 * 1024, `invalid file size for ${normalized}`);
		invariant(file.mode === 0o644, `package files must be non-executable: ${normalized}`);
		return normalized;
	});

	invariant(new Set(paths).size === paths.length, "package must not contain duplicate paths");
	for (const requiredPath of REQUIRED_PACKAGE_PATHS) {
		invariant(paths.includes(requiredPath), `package is missing required path: ${requiredPath}`);
	}
	return paths;
}

export function assertPackageMetadata(packageData, packageJson, pathCount) {
	invariant(packageData && typeof packageData === "object", "npm pack must describe one package");
	invariant(packageJson && typeof packageJson === "object", "package.json must be readable");
	invariant(packageJson.name === "pi-pr-review", "package name must be pi-pr-review");
	invariant(packageData.name === packageJson.name, "packed name must match package.json");
	invariant(packageData.version === packageJson.version, "packed version must match package.json");
	invariant(packageData.id === `${packageJson.name}@${packageJson.version}`, "packed id must match name and version");
	invariant(packageData.filename === `${packageJson.name}-${packageJson.version}.tgz`, "tarball filename must match name and version");
	invariant(packageData.entryCount === pathCount, "npm entry count must match audited paths");
	invariant(Number.isInteger(packageData.size) && packageData.size > 0 && packageData.size <= 5 * 1024 * 1024, "tarball size must be between 1 byte and 5 MiB");
	invariant(Number.isInteger(packageData.unpackedSize) && packageData.unpackedSize > 0 && packageData.unpackedSize <= 15 * 1024 * 1024, "unpacked size must be between 1 byte and 15 MiB");
	invariant(typeof packageData.shasum === "string" && /^[0-9a-f]{40}$/.test(packageData.shasum), "npm pack must emit a SHA-1 shasum");
	invariant(typeof packageData.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packageData.integrity), "npm pack must emit SHA-512 integrity");
	invariant(Array.isArray(packageData.bundled) && packageData.bundled.length === 0, "package must not bundle dependencies");
	invariant(JSON.stringify(packageJson.files) === JSON.stringify(EXPECTED_PACKAGE_FILES), "package.json files policy must remain exact");
	invariant(JSON.stringify(packageJson.pi?.extensions) === JSON.stringify(EXPECTED_EXTENSIONS), "Pi extension entries must remain exact");
	invariant(JSON.stringify(packageJson.pi?.prompts) === JSON.stringify(EXPECTED_PROMPTS), "Pi prompt entries must remain exact");
	invariant(JSON.stringify(packageJson.peerDependencies) === JSON.stringify(EXPECTED_PEER_DEPENDENCIES), "peer dependencies must remain exact");
	invariant(packageJson.engines?.node === ">=20", "Node engine must remain >=20");
	invariant(packageJson.repository?.url === "git+https://github.com/10ego/pi-pr-review.git", "repository URL must be canonical");
	invariant(packageJson.homepage === "https://github.com/10ego/pi-pr-review#readme", "homepage must be canonical");
	invariant(packageJson.bugs?.url === "https://github.com/10ego/pi-pr-review/issues", "bug URL must be canonical");
	invariant(packageJson.publishConfig?.access === "public", "publish access must be public");
	invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org/", "publish registry must be npmjs");
	invariant(packageJson.publishConfig?.provenance === true, "publish provenance must be enabled");
	invariant(packageJson.private === undefined, "package must not be private");
	for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
		invariant(!Object.hasOwn(packageJson.scripts ?? {}, script), `package lifecycle script is forbidden: ${script}`);
	}
}

function maskCommentsAndLiterals(source) {
	let state = "code";
	let escaped = false;
	let masked = "";
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];
		if (state === "code") {
			if (char === "/" && next === "/") {
				masked += "  ";
				index++;
				state = "line-comment";
			} else if (char === "/" && next === "*") {
				masked += "  ";
				index++;
				state = "block-comment";
			} else if (char === "'" || char === '"' || char === "`") {
				masked += " ";
				state = char === "'" ? "single" : char === '"' ? "double" : "template";
				escaped = false;
			} else {
				masked += char;
			}
			continue;
		}
		if (char === "\n") {
			masked += "\n";
			if (state === "line-comment") state = "code";
			continue;
		}
		masked += " ";
		if (state === "block-comment" && char === "*" && next === "/") {
			masked += " ";
			index++;
			state = "code";
			continue;
		}
		if (state === "single" || state === "double" || state === "template") {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) state = "code";
		}
	}
	return masked;
}

function braceDepthAt(source, end) {
	let depth = 0;
	for (let index = 0; index < end; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}") depth = Math.max(0, depth - 1);
	}
	return depth;
}

function hasFunctionImplementation(source, parameterStart) {
	let parenDepth = 1;
	for (let index = parameterStart; index < source.length; index++) {
		const char = source[index];
		if (char === "(") parenDepth++;
		else if (char === ")" && --parenDepth === 0) {
			let sawReturnColon = false;
			let returnTypeStarted = false;
			for (let cursor = index + 1; cursor < source.length; cursor++) {
				const token = source[cursor];
				if (token === ";") return false;
				if (token === ":" && !sawReturnColon) {
					sawReturnColon = true;
					continue;
				}
				if (token !== "{") {
					if (sawReturnColon && !/\s/.test(token)) returnTypeStarted = true;
					continue;
				}
				if (!sawReturnColon || returnTypeStarted) return true;
				// A return type may begin with an object type. Skip that balanced
				// type literal; a later opening brace is the implementation body.
				let braceDepth = 1;
				for (cursor++; cursor < source.length && braceDepth > 0; cursor++) {
					if (source[cursor] === "{") braceDepth++;
					else if (source[cursor] === "}") braceDepth--;
				}
				cursor--;
				returnTypeStarted = true;
			}
			return false;
		}
	}
	return false;
}

export function assertNoDuplicateTopLevelFunctions(source, filePath = "source") {
	invariant(typeof source === "string", `${filePath} must contain text source`);
	const code = maskCommentsAndLiterals(source);
	const implementations = new Map();
	const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)(?:\s*<[^\n(){};]*>)?\s*\(/gm;
	for (const match of code.matchAll(pattern)) {
		if (braceDepthAt(code, match.index) !== 0 || !hasFunctionImplementation(code, match.index + match[0].length)) continue;
		const name = match[1];
		const line = code.slice(0, match.index).split("\n").length;
		const previous = implementations.get(name);
		invariant(previous === undefined, `${filePath} declares top-level function ${name} more than once (lines ${previous} and ${line})`);
		implementations.set(name, line);
	}
}

export function verifyPackageContents(rootDir = process.cwd()) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCommand, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: rootDir,
		encoding: "utf8",
		shell: false,
	});
	if (result.error) throw new Error(`Could not run npm pack: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
		throw new Error(`npm pack --dry-run failed: ${detail}`);
	}

	let payload;
	try {
		payload = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Could not parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	invariant(Array.isArray(payload) && payload.length === 1, "npm pack must describe exactly one package");
	const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
	const paths = assertPackageContents(payload[0].files);
	assertPackageMetadata(payload[0], packageJson, paths.length);
	for (const filePath of paths.filter((candidate) => candidate.endsWith(".ts"))) {
		assertNoDuplicateTopLevelFunctions(fs.readFileSync(path.join(rootDir, filePath), "utf8"), filePath);
	}
	return { package: payload[0], paths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const result = verifyPackageContents();
		console.log(`Verified ${result.paths.length} files in ${result.package.filename}.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
