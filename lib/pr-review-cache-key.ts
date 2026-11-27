import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded explicitly only by checkpoint processes. Pi gives each fork its own
// session ID; providers that already request cache affinity can share routing.
export default function reviewCacheKey(pi: ExtensionAPI) {
	pi.registerFlag("review-cache-key", { type: "string", description: "Cache affinity for this review batch" });
	pi.on("before_provider_request", ({ payload }) => {
		const key = pi.getFlag("review-cache-key");
		if (typeof key === "string" && payload && typeof payload === "object" &&
			"prompt_cache_key" in payload && typeof payload.prompt_cache_key === "string") {
			return { ...payload, prompt_cache_key: key };
		}
	});
}
