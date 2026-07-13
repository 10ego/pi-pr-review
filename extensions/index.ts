import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReviewLoopCoordinator } from "../lib/pr-review-loop.ts";
import { CachedPublishAuthorizationGate } from "../lib/pr-review-publish.ts";
import registerPrReviewSubagents from "./pr-review-subagent.ts";
import registerReviewTable from "./review-table.ts";

/** Register the package behind one shared, session-scoped review-loop authority. */
export default function registerPrReview(pi: ExtensionAPI) {
	const loopCoordinator = new ReviewLoopCoordinator(pi);
	const publishAuthorization = new CachedPublishAuthorizationGate();
	registerPrReviewSubagents(pi, loopCoordinator, () => publishAuthorization.clear());
	registerReviewTable(pi, loopCoordinator, publishAuthorization);
}
