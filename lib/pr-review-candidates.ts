export type ReviewCandidateDisposition = "accepted" | "rejected" | "duplicate";

export interface ReviewCandidateRecord {
	id: string;
	laneKey: string;
	title: string;
	severity: string;
	location: string;
}

export interface ReviewCandidateDecision {
	candidateId: string;
	disposition: ReviewCandidateDisposition;
	duplicateOf?: string;
}

interface CandidateEntry {
	candidates: Map<string, ReviewCandidateRecord>;
	decisions?: readonly ReviewCandidateDecision[];
}

/** Invocation-scoped candidate identities and one-shot parent dispositions. */
export class ReviewCandidateDispositionRegistry {
	private readonly entries = new Map<string, CandidateEntry>();

	markCandidates(sessionId: string, generation: number, candidates: readonly ReviewCandidateRecord[]): boolean {
		const key = `${sessionId}:${generation}`;
		const entry = this.entries.get(key) ?? { candidates: new Map<string, ReviewCandidateRecord>() };
		if (entry.decisions) return false;
		for (const candidate of candidates) {
			const existing = entry.candidates.get(candidate.id);
			if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) return false;
			entry.candidates.set(candidate.id, Object.freeze({ ...candidate }));
		}
		this.entries.set(key, entry);
		return true;
	}

	candidates(sessionId: string, generation: number): readonly ReviewCandidateRecord[] | undefined {
		const entry = this.entries.get(`${sessionId}:${generation}`);
		return entry ? Object.freeze([...entry.candidates.values()]) : undefined;
	}

	recordDecisions(sessionId: string, generation: number, decisions: readonly ReviewCandidateDecision[]):
		{ ok: true; decisions: readonly ReviewCandidateDecision[] } | { ok: false; error: string } {
		const entry = this.entries.get(`${sessionId}:${generation}`);
		if (!entry) return { ok: false, error: "no incremental lane candidates are registered for this invocation" };
		if (entry.decisions) return { ok: false, error: "candidate dispositions were already recorded for this invocation" };
		if (decisions.length !== entry.candidates.size || new Set(decisions.map((decision) => decision.candidateId)).size !== decisions.length ||
			decisions.some((decision) => !entry.candidates.has(decision.candidateId))) {
			return { ok: false, error: "decisions must cover every registered candidate exactly once" };
		}
		for (const decision of decisions) {
			if (decision.disposition === "duplicate" && (!decision.duplicateOf || decision.duplicateOf === decision.candidateId || !entry.candidates.has(decision.duplicateOf))) {
				return { ok: false, error: "duplicate decisions must reference another registered candidate" };
			}
			if (decision.disposition !== "duplicate" && decision.duplicateOf) {
				return { ok: false, error: "only duplicate decisions may include duplicate_of" };
			}
		}
		const frozen = Object.freeze(decisions.map((decision) => Object.freeze({ ...decision })));
		entry.decisions = frozen;
		return { ok: true, decisions: frozen };
	}

	decisions(sessionId: string, generation: number): readonly ReviewCandidateDecision[] | undefined {
		return this.entries.get(`${sessionId}:${generation}`)?.decisions;
	}
}

export const reviewCandidateDispositionRegistry = new ReviewCandidateDispositionRegistry();
