import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_DEV_DEPENDENCIES = Object.freeze({
	"@earendil-works/pi-ai": "0.84.4",
	"@earendil-works/pi-coding-agent": "0.84.4",
	"@earendil-works/pi-tui": "0.84.4",
	typebox: "1.3.7",
});

function invariant(condition, message) {
	if (!condition) throw new Error(`Test lockfile invariant failed: ${message}`);
}

export function verifyTestLockfileData(lock, packageJson) {
	invariant(lock && typeof lock === "object" && !Array.isArray(lock), "lockfile must be an object");
	invariant(lock.lockfileVersion === 3, "lockfileVersion must be 3");
	invariant(lock.name === packageJson.name && lock.version === packageJson.version, "root identity must match package.json");
	invariant(lock.requires === true, "lockfile must require dependency resolution");
	invariant(lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages), "packages map is required");
	const root = lock.packages[""];
	invariant(root && typeof root === "object", "root package entry is required");
	invariant(JSON.stringify(root.devDependencies) === JSON.stringify(EXPECTED_DEV_DEPENDENCIES), "root development dependencies must remain exact");
	invariant(JSON.stringify(packageJson.devDependencies) === JSON.stringify(EXPECTED_DEV_DEPENDENCIES), "package development dependencies must remain exact");

	for (const [packagePath, entry] of Object.entries(lock.packages)) {
		if (packagePath === "") continue;
		invariant(packagePath.startsWith("node_modules/") && !packagePath.includes("\\") && !packagePath.split("/").includes(".."), `unsafe package path: ${packagePath}`);
		invariant(entry && typeof entry === "object" && !Array.isArray(entry), `invalid package entry: ${packagePath}`);
		invariant(typeof entry.version === "string" && entry.version.length > 0, `missing version: ${packagePath}`);
		invariant(typeof entry.resolved === "string" && /^https:\/\/registry\.npmjs\.org\//.test(entry.resolved), `non-registry resolution: ${packagePath}`);
		invariant(typeof entry.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity), `missing SHA-512 integrity: ${packagePath}`);
	}
	return { packageCount: Object.keys(lock.packages).length - 1 };
}

export function verifyTestLockfile(root = process.cwd()) {
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	return verifyTestLockfileData(lock, packageJson);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const result = verifyTestLockfile();
		console.log(`Verified ${result.packageCount} integrity-locked test packages.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
