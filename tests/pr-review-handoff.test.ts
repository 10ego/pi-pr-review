import { expect, test } from "bun:test";
import { parseReviewHandoff } from "../lib/pr-review-fork.ts";

const roles = [{ id: "life", scope: "state" }, { id: "contract", scope: "contract" }];
const assignments = roles.map(role => ({ id: role.id, entry: "src/engine.ts", question: role.scope, evidence: "caller" }));
test("binds one distinct question to every expected reviewer while allowing shared files", () => {
	const plan = { findings: ["src/engine.ts:10 persisted state loses required input"], assignments: [...assignments].reverse() };
	expect(parseReviewHandoff(JSON.stringify(plan), roles)).toEqual(plan);
	for (const invalid of [
		[assignments[0]], [assignments[0], assignments[0]],
		[assignments[0], { ...assignments[1], question: " STATE " }],
		[assignments[0], { ...assignments[1], id: "other" }],
		[assignments[0], { ...assignments[1], evidence: "" }],
	]) {
		expect(() => parseReviewHandoff(JSON.stringify({ findings: [], assignments: invalid }), roles)).toThrow();
	}
});
