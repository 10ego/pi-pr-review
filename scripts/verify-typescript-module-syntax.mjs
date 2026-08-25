import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import { SourceTextModule } from "node:vm";

if (typeof SourceTextModule !== "function") {
	throw new Error("Node vm.SourceTextModule is unavailable; run with --experimental-vm-modules");
}

for (const filePath of process.argv.slice(2)) {
	const source = fs.readFileSync(filePath, "utf8");
	try {
		const javascript = stripTypeScriptTypes(source, { mode: "transform", sourceUrl: filePath });
		new SourceTextModule(javascript, { identifier: path.resolve(filePath) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${filePath}: ${message}`, { cause: error });
	}
}
