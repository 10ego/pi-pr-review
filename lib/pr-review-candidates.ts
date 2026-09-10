import type { ReviewFindingLike } from "./pr-review-publish.ts";

export type ReviewCandidateDisposition = "accepted" | "rejected" | "duplicate";

export interface ReviewCandidateRecord {
	id: string;
	laneKey: string;
	finding: ReviewFindingLike;
}

export interface ReviewCandidateDecision {
	candidateId: string;
	disposition: ReviewCandidateDisposition;
	duplicateOf?: string;
}

export interface ReviewCandidateFinalization {
	decisions: readonly ReviewCandidateDecision[];
	addedFindings: readonly ReviewFindingLike[];
	overview: string;
	verification: string;
}

interface CandidateEntry {
	candidates: Map<string, ReviewCandidateRecord>;
	finalization?: ReviewCandidateFinalization;
}

/** Invocation-scoped candidate identities and one-shot host-owned finalization. */
export class ReviewCandidateDispositionRegistry {
	private readonly entries = new Map<string, CandidateEntry>();

	markCandidates(sessionId: string, generation: number, candidates: readonly ReviewCandidateRecord[]): boolean {
		const key = `${sessionId}:${generation}`;
		const entry = this.entries.get(key) ?? { candidates: new Map<string, ReviewCandidateRecord>() };
		if (entry.finalization) return false;
		for (const candidate of candidates) {
			const existing = entry.candidates.get(candidate.id);
			if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) return false;
			entry.candidates.set(candidate.id, Object.freeze({ ...candidate, finding: Object.freeze({ ...candidate.finding }) }));
		}
		this.entries.set(key, entry);
		return true;
	}

	replaceLaneCandidates(
		sessionId: string,
		generation: number,
		laneKey: string,
		candidates: readonly ReviewCandidateRecord[],
	): boolean {
		const key = `${sessionId}:${generation}`;
		const entry = this.entries.get(key) ?? { candidates: new Map<string, ReviewCandidateRecord>() };
		if (entry.finalization || !laneKey) return false;
		const candidateIds = new Set<string>();
		for (const candidate of candidates) {
			if (!candidate.id || candidate.laneKey !== laneKey || candidateIds.has(candidate.id)) return false;
			const existing = entry.candidates.get(candidate.id);
			if (existing && existing.laneKey !== laneKey) return false;
			candidateIds.add(candidate.id);
		}
		// Validate the complete replacement before mutating the retained lane set.
		for (const [id, candidate] of entry.candidates) if (candidate.laneKey === laneKey) entry.candidates.delete(id);
		for (const candidate of candidates) entry.candidates.set(candidate.id, Object.freeze({ ...candidate, finding: Object.freeze({ ...candidate.finding }) }));
		this.entries.set(key, entry);
		return true;
	}

	candidates(sessionId: string, generation: number): readonly ReviewCandidateRecord[] | undefined {
		const entry = this.entries.get(`${sessionId}:${generation}`);
		return entry ? Object.freeze([...entry.candidates.values()]) : undefined;
	}

	recordFinalization(
		sessionId: string,
		generation: number,
		decisions: readonly ReviewCandidateDecision[],
		addedFindings: readonly ReviewFindingLike[],
		overview: string,
		verification: string,
	): { ok: true; finalization: ReviewCandidateFinalization } | { ok: false; error: string } {
		const entry = this.entries.get(`${sessionId}:${generation}`);
		if (!entry) return { ok: false, error: "no incremental lane candidates are registered for this invocation" };
		if (entry.finalization) return { ok: false, error: "candidate finalization was already recorded for this invocation" };
		if (decisions.length !== entry.candidates.size || new Set(decisions.map((decision) => decision.candidateId)).size !== decisions.length ||
			decisions.some((decision) => !entry.candidates.has(decision.candidateId))) {
			return { ok: false, error: "decisions must cover every registered candidate exactly once" };
		}
		const acceptedIds = new Set(decisions.filter((decision) => decision.disposition === "accepted").map((decision) => decision.candidateId));
		for (const decision of decisions) {
			if (decision.disposition === "duplicate" && (!decision.duplicateOf || decision.duplicateOf === decision.candidateId || !acceptedIds.has(decision.duplicateOf))) {
				return { ok: false, error: "duplicate decisions must reference another accepted candidate" };
			}
			if (decision.disposition !== "duplicate" && decision.duplicateOf) return { ok: false, error: "only duplicate decisions may include duplicate_of" };
		}
		if (!overview.trim() || !verification.trim()) return { ok: false, error: "overview and verification are required" };
		const finalization = Object.freeze({
			decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
			addedFindings: Object.freeze(addedFindings.map((finding) => Object.freeze({ ...finding }))),
			overview: overview.trim(), verification: verification.trim(),
		});
		entry.finalization = finalization;
		return { ok: true, finalization };
	}

	finalization(sessionId: string, generation: number): ReviewCandidateFinalization | undefined {
		return this.entries.get(`${sessionId}:${generation}`)?.finalization;
	}

	clear(sessionId: string, generation: number): void {
		this.entries.delete(`${sessionId}:${generation}`);
	}

	acceptedFindings(sessionId: string, generation: number): readonly ReviewFindingLike[] | undefined {
		const entry = this.entries.get(`${sessionId}:${generation}`), finalization = entry?.finalization;
		if (!entry || !finalization) return undefined;
		const accepted = finalization.decisions
			.filter((decision) => decision.disposition === "accepted")
			.map((decision) => entry.candidates.get(decision.candidateId)!.finding);
		return Object.freeze([...accepted, ...finalization.addedFindings]);
	}
}

export const reviewCandidateDispositionRegistry = new ReviewCandidateDispositionRegistry();
