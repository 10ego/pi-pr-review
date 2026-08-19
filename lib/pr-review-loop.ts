import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ReviewInvocationGate,
	type ApproveMaxPriorityLevel,
	type AutoPostResolution,
	type PublishModeParseResult,
	type ReviewInvocation,
	type ReviewInvocationPhase,
	type ReviewHostBinding,
} from "./pr-review-publish.ts";
import {
	ReviewFocusRegistry,
	type ReviewFocusPassDescriptor,
	type ReviewFocusPassEvent,
	type ReviewFocusSnapshot,
	type ReviewFocusSubscriber,
} from "./pr-review-focus.ts";
import {
	ReviewLaneArtifactRegistry,
	type ReviewLaneArtifact,
} from "./pr-review-artifacts.ts";
import { createReviewBudget, type DeadlineResolution, type ReviewBudget } from "./pr-review-deadlines.ts";
import { monotonicNow } from "./pr-review-telemetry.ts";

export const REVIEW_LOOP_TOOL_NAMES = [
	"review_subagent",
	"review_subagents",
	"pr_review_verify",
] as const;

const REVIEW_LOOP_TOOL_SET = new Set<string>(REVIEW_LOOP_TOOL_NAMES);

export type ReviewLoopInputSource = "interactive" | "rpc" | "extension";

interface ReviewLoopBinding {
	readonly generation: number;
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionStartedAt?: string;
	readonly controller: AbortController;
	readonly budget?: ReviewBudget;
	readonly onDeadline?: () => void;
	totalTimer?: ReturnType<typeof setTimeout>;
	synthesisTimer?: ReturnType<typeof setTimeout>;
	synthesisStarted: boolean;
	deadlineKind?: "total" | "synthesis";
}

export interface ReviewLoopLease {
	readonly generation: number;
	readonly signal: AbortSignal;
	readonly budget?: ReviewBudget;
}

export interface ReviewFocusPublisher {
	publish(event: ReviewFocusPassEvent): boolean;
}

export interface ReviewArtifactPublisher {
	retain(artifact: ReviewLaneArtifact): boolean;
}

function sessionBinding(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): {
	cwd: string;
	sessionId: string;
	sessionStartedAt?: string;
} {
	const sessionId = ctx.sessionManager.getSessionId();
	const header = ctx.sessionManager.getHeader();
	return {
		cwd: path.resolve(ctx.cwd),
		sessionId,
		...(header?.id === sessionId && typeof header.timestamp === "string"
			? { sessionStartedAt: header.timestamp }
			: {}),
	};
}

function sameBinding(
	binding: ReviewLoopBinding,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): boolean {
	const current = sessionBinding(ctx);
	return binding.cwd === current.cwd &&
		binding.sessionId === current.sessionId &&
		binding.sessionStartedAt === current.sessionStartedAt;
}

/**
 * Host-owned authority for one /pr-review loop. No capability is exposed to the
 * model: tools acquire a generation-bound lease directly from this coordinator.
 */
export class ReviewLoopCoordinator {
	private readonly invocationGate = new ReviewInvocationGate();
	private readonly focusRegistry = new ReviewFocusRegistry();
	private readonly artifactRegistry = new ReviewLaneArtifactRegistry();
	private binding?: ReviewLoopBinding;
	private suspendedTools?: string[];
	private nextGeneration = 1;

	constructor(private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {}

	private setToolsEnabled(enabled: boolean): void {
		if (this.suspendedTools !== undefined) return;
		try {
			const current = this.pi.getActiveTools();
			const next = enabled
				? [...current, ...REVIEW_LOOP_TOOL_NAMES.filter((name) => !current.includes(name))]
				: current.filter((name) => !REVIEW_LOOP_TOOL_SET.has(name));
			if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
				this.pi.setActiveTools(next);
			}
		} catch {
			// Execute-time authorization remains authoritative if visibility cannot
			// be updated during startup, shutdown, or a stale extension lifecycle.
		}
	}

	begin(
		parsed: PublishModeParseResult,
		autoPost: AutoPostResolution,
		source: ReviewLoopInputSource,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
		allowStalePublish = true,
		allowStaleApprovals = false,
		approveMaxPriorityLevel: ApproveMaxPriorityLevel = "off",
		reviewBinding?: ReviewHostBinding,
		deadlineResolution?: DeadlineResolution,
		onTotalDeadline?: () => void,
		budgetOverride?: ReviewBudget,
	): { accepted: boolean; error?: string } {
		if (source !== "interactive" && source !== "rpc") {
			return { accepted: false, error: "/pr-review must be initiated directly by an interactive or RPC user" };
		}
		const current = sessionBinding(ctx);
		const generation = this.nextGeneration;
		const invocationBinding = reviewBinding ? {
			...reviewBinding,
			invocationGeneration: generation,
			sessionId: current.sessionId,
			...(current.sessionStartedAt ? { sessionStartedAt: current.sessionStartedAt } : {}),
		} : undefined;
		const started = this.invocationGate.begin(
			parsed,
			autoPost,
			allowStalePublish,
			allowStaleApprovals,
			approveMaxPriorityLevel,
			invocationBinding,
		);
		if (!started.accepted) return started;
		this.nextGeneration++;
		const budget = budgetOverride ?? (deadlineResolution ? createReviewBudget(deadlineResolution) : undefined);
		this.binding = {
			generation,
			...current,
			controller: new AbortController(),
			budget,
			onDeadline: onTotalDeadline,
			synthesisStarted: false,
		};
		if (budget) {
			const binding = this.binding;
			const activeAllowanceMs = Math.max(
				1,
				budget.totalDeadlineMs - budget.config.terminationGraceMs - budget.config.cleanupReserveMs - monotonicNow(),
			);
			binding.totalTimer = setTimeout(() => {
				if (this.binding !== binding || binding.deadlineKind) return;
				binding.deadlineKind = "total";
				if (binding.synthesisTimer) clearTimeout(binding.synthesisTimer);
				binding.controller.abort(new Error("review total deadline expired"));
				this.setToolsEnabled(false);
				try { binding.onDeadline?.(); } catch { /* lifecycle callback is best-effort */ }
			}, activeAllowanceMs);
		}
		this.focusRegistry.open(this.binding.generation);
		this.artifactRegistry.open(this.binding.generation);
		this.setToolsEnabled(true);
		return { accepted: true };
	}

	peek(): ReviewInvocation | undefined {
		return this.invocationGate.peek();
	}

	phase(): ReviewInvocationPhase | undefined {
		return this.invocationGate.phase();
	}

	markAwaitingConfirmation(): boolean {
		const changed = this.invocationGate.markAwaitingConfirmation();
		if (changed) this.setToolsEnabled(false);
		return changed;
	}

	resolveConfirmationInput(
		text: string,
		source: ReviewLoopInputSource,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): "not_awaiting" | "confirmed" | "cleared" {
		if (this.invocationGate.phase() !== "awaiting_confirmation") return "not_awaiting";
		if ((source !== "interactive" && source !== "rpc") || !this.binding || !sameBinding(this.binding, ctx)) {
			this.clear();
			return "cleared";
		}
		const result = this.invocationGate.resolveConfirmationInput(text);
		if (result === "confirmed") this.setToolsEnabled(true);
		else if (result === "cleared") this.revokeBinding();
		return result;
	}

	acquire(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): ReviewLoopLease | undefined {
		const phase = this.invocationGate.phase();
		if (this.suspendedTools !== undefined || (phase !== "reviewing" && phase !== "confirmed") || !this.binding) {
			return undefined;
		}
		if (!sameBinding(this.binding, ctx) || this.binding.controller.signal.aborted) {
			this.clear();
			return undefined;
		}
		return Object.freeze({
			generation: this.binding.generation,
			signal: this.binding.controller.signal,
			budget: this.binding.budget,
		});
	}

	beginSynthesis(
		generation: number,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): boolean {
		const binding = this.binding;
		if (!binding || binding.generation !== generation || !sameBinding(binding, ctx) || binding.controller.signal.aborted) {
			return false;
		}
		if (binding.synthesisStarted) return true;
		binding.synthesisStarted = true;
		if (!binding.budget) return true;
		const activeTotalDeadline = binding.budget.totalDeadlineMs -
			binding.budget.config.terminationGraceMs - binding.budget.config.cleanupReserveMs;
		const synthesisDeadline = Math.min(
			monotonicNow() + binding.budget.config.synthesisMs,
			activeTotalDeadline,
		);
		const expire = () => {
			if (this.binding !== binding || binding.deadlineKind) return;
			binding.deadlineKind = "synthesis";
			if (binding.totalTimer) clearTimeout(binding.totalTimer);
			binding.controller.abort(new Error("review synthesis deadline expired"));
			this.setToolsEnabled(false);
			try { binding.onDeadline?.(); } catch { /* lifecycle callback is best-effort */ }
		};
		const remaining = synthesisDeadline - monotonicNow();
		if (remaining <= 0) queueMicrotask(expire);
		else binding.synthesisTimer = setTimeout(expire, remaining);
		return true;
	}

	isLeaseActive(
		lease: ReviewLoopLease,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): boolean {
		if (this.suspendedTools !== undefined) return false;
		const active = !!this.binding &&
			this.binding.generation === lease.generation &&
			!lease.signal.aborted &&
			(this.phase() === "reviewing" || this.phase() === "confirmed") &&
			sameBinding(this.binding, ctx);
		if (!active && this.binding?.generation === lease.generation && !this.binding.deadlineKind) this.clear();
		return active;
	}

	createFocusPublisher(
		lease: ReviewLoopLease,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
		descriptor: ReviewFocusPassDescriptor,
	): ReviewFocusPublisher | undefined {
		if (!this.isLeaseActive(lease, ctx)) return undefined;
		if (!this.focusRegistry.register(lease.generation, descriptor)) return undefined;
		return Object.freeze({
			publish: (event: ReviewFocusPassEvent) => {
				if (!this.isLeaseActive(lease, ctx)) return false;
				return this.focusRegistry.publish(lease.generation, descriptor.key, event);
			},
		});
	}

	createArtifactPublisher(
		lease: ReviewLoopLease,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): ReviewArtifactPublisher | undefined {
		if (!this.isLeaseActive(lease, ctx)) return undefined;
		return Object.freeze({
			retain: (artifact: ReviewLaneArtifact) => {
				const active = this.isLeaseActive(lease, ctx);
				const binding = this.binding;
				const withinTerminationWindow = !active && !!binding?.deadlineKind &&
					binding.generation === lease.generation && !!binding.budget &&
					sameBinding(binding, ctx) && monotonicNow() <= binding.budget.totalDeadlineMs;
				if (!active && !withinTerminationWindow) return false;
				return this.artifactRegistry.retain(lease.generation, artifact);
			},
		});
	}

	artifactSnapshot(
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): readonly ReviewLaneArtifact[] | undefined {
		if (this.binding?.deadlineKind && sameBinding(this.binding, ctx)) {
			return this.artifactRegistry.snapshot(this.binding.generation);
		}
		const lease = this.acquire(ctx);
		return lease ? this.artifactRegistry.snapshot(lease.generation) : undefined;
	}

	deadlineExpired(): boolean {
		return this.binding?.deadlineKind !== undefined;
	}

	totalDeadlineExpired(): boolean {
		return this.binding?.deadlineKind === "total";
	}

	synthesisDeadlineExpired(): boolean {
		return this.binding?.deadlineKind === "synthesis";
	}

	focusSnapshot(
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): ReviewFocusSnapshot | undefined {
		const lease = this.acquire(ctx);
		return lease ? this.focusRegistry.snapshot(lease.generation) : undefined;
	}

	subscribeFocus(
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
		subscriber: ReviewFocusSubscriber,
	): (() => void) | undefined {
		const lease = this.acquire(ctx);
		return lease ? this.focusRegistry.subscribe(lease.generation, subscriber) : undefined;
	}

	consume(): ReviewInvocation | undefined {
		const invocation = this.invocationGate.consume();
		this.revokeBinding();
		return invocation;
	}

	clear(): void {
		this.invocationGate.clear();
		this.revokeBinding();
	}

	hideTools(): void {
		this.setToolsEnabled(false);
	}

	/** Return the current loop's abortable lease while its tools are suspended for output repair. */
	repairLease(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): ReviewLoopLease | undefined {
		const phase = this.invocationGate.phase();
		if (!this.binding || this.suspendedTools === undefined || (phase !== "reviewing" && phase !== "confirmed")) return undefined;
		if (!sameBinding(this.binding, ctx) || this.binding.controller.signal.aborted) {
			this.clear();
			return undefined;
		}
		return Object.freeze({ generation: this.binding.generation, signal: this.binding.controller.signal });
	}

	/** Check a repair lease without re-enabling the review tools. */
	isRepairLeaseActive(lease: ReviewLoopLease, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): boolean {
		return !!this.binding && this.suspendedTools !== undefined &&
			this.binding.generation === lease.generation && !lease.signal.aborted &&
			(this.phase() === "reviewing" || this.phase() === "confirmed") && sameBinding(this.binding, ctx);
	}

	/** Hide every tool for a format-only repair turn while retaining invocation authority. */
	suspendToolsForRepair(): boolean {
		const phase = this.invocationGate.phase();
		if (
			this.suspendedTools !== undefined ||
			!this.binding ||
			(phase !== "reviewing" && phase !== "confirmed")
		) {
			return false;
		}
		let baseTools: string[] = [];
		try {
			baseTools = this.pi.getActiveTools().filter((name) => !REVIEW_LOOP_TOOL_SET.has(name));
			this.suspendedTools = baseTools;
			this.pi.setActiveTools([]);
			return true;
		} catch {
			this.suspendedTools = undefined;
			try {
				this.pi.setActiveTools(baseTools);
			} catch {
				// Failure to restore remains fail-closed with no repair turn started.
			}
			return false;
		}
	}

	private revokeBinding(): void {
		if (this.binding?.totalTimer) clearTimeout(this.binding.totalTimer);
		if (this.binding?.synthesisTimer) clearTimeout(this.binding.synthesisTimer);
		const generation = this.binding?.generation;
		if (generation !== undefined) {
			this.focusRegistry.close(generation);
			this.artifactRegistry.close(generation);
		}
		this.binding?.controller.abort();
		this.binding = undefined;
		const suspendedTools = this.suspendedTools;
		this.suspendedTools = undefined;
		if (suspendedTools !== undefined) {
			try {
				this.pi.setActiveTools(suspendedTools);
			} catch {
				// Keep tools fail-closed if the extension runtime is shutting down.
			}
			return;
		}
		this.setToolsEnabled(false);
	}
}

export function combineAbortSignals(
	first: AbortSignal | undefined,
	second: AbortSignal | undefined,
): AbortSignal | undefined {
	if (!first) return second;
	if (!second || first === second) return first;
	return AbortSignal.any([first, second]);
}

export function reviewLoopDeniedResult(toolName: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: `${toolName} is available only inside an active user-initiated /pr-review loop.`,
			},
		],
		isError: true,
		details: { authorized: false },
	};
}
