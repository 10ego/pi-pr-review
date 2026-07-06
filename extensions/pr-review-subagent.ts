/**
 * pr-review-subagent
 *
 * Adds configurable, tiered review subagents to the /pr-review workflow.
 *
 * - Config surface: `pr-review.json` (user: ~/.pi/agent, project: <repo>/.pi) maps
 *   the labels `light` / `medium` / `heavy` to whatever models you choose.
 *   No model names are hardcoded here — you configure them.
 * - Tool: `review_subagent` spawns an isolated `pi` subprocess on the model bound
 *   to the requested tier and returns its review report.
 * - Command: `/pr-review-config` shows or edits the tier→model mapping.
 *
 * The orchestrating /pr-review prompt dispatches passes by tier label:
 *   light  -> triage / skip decision / change summary
 *   medium -> convention-file (CLAUDE.md/AGENTS.md) compliance
 *   heavy  -> bug + security/logic review and finding validation
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Tier = "light" | "medium" | "heavy";
const TIERS: Tier[] = ["light", "medium", "heavy"];

const UNSET = "(unset — pi default)";
const TOOLS_PRESETS = ["read,bash,grep,find,ls", "read,grep,find,ls", "read"];
const TIER_PURPOSE: Record<Tier, string> = {
	light: "triage / skip decision / change summary",
	medium: "convention-file (CLAUDE.md/AGENTS.md) compliance",
	heavy: "bug + security/logic review and validation",
};

interface PrReviewConfig {
	/** Tier label -> model spec (e.g. "anthropic/model", "openai/model:high"). */
	tiers: Partial<Record<Tier, string>>;
	/** Tools granted to each review subagent process. */
	tools: string[];
}

const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"];
const CONFIG_FILENAME = "pr-review.json";

function userConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILENAME);
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

function readConfigFile(filePath: string): Partial<PrReviewConfig> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return typeof parsed === "object" && parsed ? (parsed as Partial<PrReviewConfig>) : {};
	} catch {
		return {};
	}
}

/** User config, overlaid by project config when the project is trusted. */
function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): PrReviewConfig {
	const user = readConfigFile(userConfigPath());
	let project: Partial<PrReviewConfig> = {};
	try {
		if (ctx.isProjectTrusted()) project = readConfigFile(projectConfigPath(ctx.cwd));
	} catch {
		/* trust check unavailable -> user config only */
	}
	return {
		tiers: { ...(user.tiers ?? {}), ...(project.tiers ?? {}) },
		tools: project.tools ?? user.tools ?? DEFAULT_TOOLS,
	};
}

/** User-level config only (the scope the config command edits), with defaults. */
function readUserConfig(): PrReviewConfig {
	const raw = readConfigFile(userConfigPath());
	return { tiers: { ...(raw.tiers ?? {}) }, tools: raw.tools ?? [...DEFAULT_TOOLS] };
}

function writeUserConfig(next: PrReviewConfig): string {
	const filePath = userConfigPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

/** Resolve the model spec for a tier, falling back to the nearest configured tier. */
function resolveModelSpec(config: PrReviewConfig, tier: Tier): { spec?: string; usedTier?: Tier } {
	if (config.tiers[tier]) return { spec: config.tiers[tier], usedTier: tier };
	// Preference order: search outward from the requested tier.
	const order: Record<Tier, Tier[]> = {
		light: ["light", "medium", "heavy"],
		medium: ["medium", "heavy", "light"],
		heavy: ["heavy", "medium", "light"],
	};
	for (const candidate of order[tier]) {
		if (config.tiers[candidate]) return { spec: config.tiers[candidate], usedTier: candidate };
	}
	return {};
}

// ---------------------------------------------------------------------------
// Subprocess plumbing (mirrors the official subagent example)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

const TIER_GUIDANCE: Record<Tier, string> = {
	light:
		"You are a fast overview/summary reviewer. Produce a concise overview of what the change does and how, list the change's genuine strengths, and note risk areas worth a closer look. Do not deep-dive into defects.",
	medium:
		"You are a convention-compliance reviewer. Audit changed lines against the in-scope repository convention files (CLAUDE.md / AGENTS.md and equivalents). Report clear rule violations (quote the rule) and also softer deviations from documented style as nits.",
	heavy:
		"You are a rigorous bug, security, logic, and maintainability reviewer. Hunt for defects at every severity in the changed code — from compile/parse failures and wrong results and security holes down to minor correctness smells, missing edge cases, and readability nits. Validate each candidate before reporting; drop only things that are actually correct or that you cannot substantiate.",
};

function buildSubagentSystemPrompt(tier: Tier): string {
	const lines = [
		"You are an isolated code-review subagent invoked by the /pr-review orchestrator.",
		TIER_GUIDANCE[tier],
		"",
		"Surface EVERY issue the author would want to know about — from trivial nits up to blocking defects. Do not discard minor issues; classify them by severity instead. Only leave out non-issues: things that are actually correct, unsubstantiated speculation, or subjective preferences with no concrete benefit.",
		"Stay strictly in scope: only report issues caused by or directly relevant to this PR's diff (the changed lines and the code they provably affect). Do NOT flag pre-existing issues in untouched code or audit the wider codebase; if a problem existed before this change, leave it out. Reading surrounding files/callers is for context and confirmation only.",
	];
	if (tier === "light") {
		lines.push(
			"Return concise Markdown with two sections:",
			"- 'Overview:' 1-3 short paragraphs on what the PR does and author intent.",
			"- 'Strengths:' a bullet list of genuine strengths (or 'none').",
		);
	} else {
		lines.push(
			"Return your findings as a concise Markdown list. For each finding include, on its own lines:",
			"- title: an imperative summary prefixed with a severity tag [P0]|[P1]|[P2]|[P3]|[nit]",
			"- severity: one of P0, P1, P2, P3, nit (P0/P1 are blocking)",
			"- why: the impact and the exact input/environment needed for it to bite",
			"- location: <repo-relative file path>:<start-end lines exactly as they appear in the diff> (or 'repo-wide')",
			"- side: RIGHT for added/context lines, LEFT for removed lines",
			"- in_diff: yes if those lines are inside the PR diff (so an inline comment can be posted), otherwise no",
			"- pr_related: yes only if this PR introduces or provably affects the issue (drop pre-existing/unrelated issues)",
			"- confidence: a float 0.0-1.0",
			"If there are genuinely no findings at any severity, reply exactly with: NO FINDINGS.",
		);
	}
	lines.push("Do not attempt to post GitHub comments or modify files. Reviewing only.");
	return lines.join("\n");
}

async function writeTempPrompt(tier: Tier, body: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pr-review-"));
	const filePath = path.join(dir, `system-${tier}.md`);
	await fs.promises.writeFile(filePath, body, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

interface RunResult {
	text: string;
	exitCode: number;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

function runReviewSubprocess(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onText: (text: string) => void,
): Promise<RunResult> {
	return new Promise<RunResult>((resolve) => {
		const messages: Message[] = [];
		const result: RunResult = { text: "", exitCode: 0, stderr: "" };
		let buffer = "";
		let aborted = false;

		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				messages.push(event.message);
				if (event.message.role === "assistant") {
					if (event.message.model) result.model = event.message.model;
					if (event.message.stopReason) result.stopReason = event.message.stopReason;
					if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
					const t = finalAssistantText(messages);
					if (t) onText(t);
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.text = finalAssistantText(messages);
			result.exitCode = code ?? 0;
			if (aborted) result.stopReason = "aborted";
			resolve(result);
		});
		proc.on("error", (err) => {
			result.exitCode = 1;
			result.errorMessage = err.message;
			resolve(result);
		});

		if (signal) {
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const ReviewSubagentParams = Type.Object({
	tier: StringEnum(["light", "medium", "heavy"] as const, {
		description:
			"Model tier / subagent label. light = triage & change summary; medium = convention (CLAUDE.md/AGENTS.md) compliance; heavy = bug + security/logic review and validation.",
	}),
	objective: Type.String({
		description: "Precise instruction for this subagent — what to review and what to return.",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"Shared context for the subagent, typically the PR title/description plus the unified diff to review.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "review_subagent",
		label: "Review Subagent",
		description: [
			"Delegate one PR-review pass to an isolated subagent running on a configured model tier.",
			"Pass tier (light|medium|heavy) plus an objective and the diff as context.",
			"Model per tier is configured via /pr-review-config (stored in pr-review.json).",
			"Returns the subagent's candidate findings; the orchestrator validates, filters, and emits the final JSON.",
		].join(" "),
		promptSnippet:
			"Run a tiered PR-review pass (light/medium/heavy) in an isolated subagent on the configured model",
		promptGuidelines: [
			"Use review_subagent to fan a /pr-review pass out to the configured light/medium/heavy model instead of reviewing every pass inline.",
			"When calling review_subagent, pass the unified diff and PR title/description in `context` so the subagent does not refetch it.",
		],
		parameters: ReviewSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig(ctx);
			const tier = params.tier as Tier;
			const { spec, usedTier } = resolveModelSpec(config, tier);

			const args = ["--mode", "json", "-p", "--no-session"];
			if (spec) args.push("--model", spec);
			if (config.tools.length > 0) args.push("--tools", config.tools.join(","));

			const tmp = await writeTempPrompt(tier, buildSubagentSystemPrompt(tier));
			args.push("--append-system-prompt", tmp.filePath);

			const task = params.context
				? `Objective: ${params.objective}\n\n--- PR context / diff ---\n${params.context}`
				: `Objective: ${params.objective}`;
			args.push(task);

			const invocation = getPiInvocation(args);
			const notice = spec
				? usedTier === tier
					? `tier=${tier} model=${spec}`
					: `tier=${tier} (not configured; using ${usedTier} model=${spec})`
				: `tier=${tier} (no tier configured; using pi default model — run /pr-review-config to set tiers)`;

			try {
				const result = await runReviewSubprocess(
					invocation.command,
					invocation.args,
					ctx.cwd,
					signal,
					(text) => onUpdate?.({ content: [{ type: "text", text }] }),
				);

				const failed =
					result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (failed) {
					const detail = result.errorMessage || result.stderr || result.text || "(no output)";
					return {
						content: [{ type: "text", text: `Review subagent failed [${notice}]: ${detail}` }],
						isError: true,
						details: { tier, usedTier, model: result.model ?? spec, exitCode: result.exitCode },
					};
				}

				return {
					content: [{ type: "text", text: `[${notice}]\n\n${result.text || "NO FINDINGS."}` }],
					details: { tier, usedTier, model: result.model ?? spec, exitCode: result.exitCode },
				};
			} finally {
				try {
					fs.rmSync(tmp.dir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		},
	});

	pi.registerCommand("pr-review-config", {
		description: "Open the review-tier settings menu, or show/set light/medium/heavy models for /pr-review",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const parsed = parseConfigArgs(raw);
			if (parsed.errors.length) {
				ctx.ui.notify(`Invalid pr-review config: ${parsed.errors.join("; ")}`, "error");
				return;
			}

			try {
				// Direct set: `/pr-review-config light=... heavy=...`
				if (parsed.hasChanges) {
					const next = applyConfigPatch(readUserConfig(), parsed.patch);
					writeUserConfig(next);
					post(ctx, pi, summarizeConfig(next, loadConfig(ctx), ctx, true), { config: next });
					return;
				}

				// Interactive menu: `/pr-review-config` in the TUI.
				if (shouldOpenConfigMenu(raw, ctx)) {
					let available: string[] = [];
					try {
						available = (await ctx.modelRegistry.getAvailable()).map((m) => `${m.provider}/${m.id}`).sort();
					} catch {
						/* fall back to text if models can't be listed */
					}
					if (available.length > 0) {
						const result = await showConfigMenu(pi, ctx, available);
						if (result === "closed") return;
					}
				}

				// Text summary: `/pr-review-config show`, non-TUI, or menu fallback.
				post(ctx, pi, summarizeConfig(readUserConfig(), loadConfig(ctx), ctx, false), {});
			} catch (e) {
				ctx.ui.notify(`pr-review-config failed: ${errMessage(e)}`, "error");
			}
		},
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.toLowerCase();
			const filtered = CONFIG_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(normalized));
			return filtered.length ? filtered : null;
		},
	});
}

/* ----------------------- config command helpers ------------------------- */

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function post(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	markdown: string,
	details: Record<string, unknown>,
): void {
	if (ctx.hasUI) {
		pi.sendMessage({ customType: "pr-review", content: markdown, display: true, details }, { triggerTurn: false });
	} else {
		ctx.ui.notify(markdown, "info");
	}
}

function shouldOpenConfigMenu(args: string, ctx: ExtensionContext): boolean {
	return args.length === 0 && ctx.mode === "tui" && typeof ctx.ui.custom === "function";
}

const CONFIG_COMPLETIONS: Array<{ value: string; label: string }> = [
	...TIERS.map((t) => ({ value: `${t}=`, label: `${t}=<model> — ${TIER_PURPOSE[t]}` })),
	{ value: "tools=", label: "tools=read,bash,grep,find,ls — tools granted to review subagents" },
	{ value: "show", label: "show — print the current tier config" },
];

/** Split respecting single/double quotes so `evidence`-style values with spaces survive. */
function splitConfigArgs(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === quote) quote = undefined;
			else token += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += ch;
	}
	if (token) tokens.push(token);
	return tokens;
}

interface ConfigPatch {
	tiers: Partial<Record<Tier, string | null>>;
	tools?: string[];
}

function parseConfigArgs(args: string): { patch: ConfigPatch; hasChanges: boolean; errors: string[] } {
	const patch: ConfigPatch = { tiers: {} };
	const errors: string[] = [];
	const tokens = splitConfigArgs(args).filter((t) => !["show", "get", "current"].includes(t.toLowerCase()));
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq < 0) {
			errors.push(`unrecognized argument "${token}" (use key=value, e.g. heavy=provider/model)`);
			continue;
		}
		const key = token.slice(0, eq).replace(/^--?/, "").toLowerCase();
		const value = token.slice(eq + 1);
		if ((TIERS as string[]).includes(key)) {
			patch.tiers[key as Tier] = value === "" || value === "unset" ? null : value;
		} else if (key === "tools") {
			patch.tools = value.split(",").map((s) => s.trim()).filter(Boolean);
		} else {
			errors.push(`unknown key "${key}" (expected light|medium|heavy|tools)`);
		}
	}
	const hasChanges = Object.keys(patch.tiers).length > 0 || patch.tools !== undefined;
	return { patch, hasChanges, errors };
}

function applyConfigPatch(base: PrReviewConfig, patch: ConfigPatch): PrReviewConfig {
	const next: PrReviewConfig = { tiers: { ...base.tiers }, tools: [...base.tools] };
	for (const tier of TIERS) {
		if (!(tier in patch.tiers)) continue;
		const value = patch.tiers[tier];
		if (value === null || value === undefined) delete next.tiers[tier];
		else next.tiers[tier] = value;
	}
	if (patch.tools) next.tools = patch.tools;
	return next;
}

function summarizeConfig(
	user: PrReviewConfig,
	effective: PrReviewConfig,
	ctx: ExtensionContext,
	changed: boolean,
): string {
	let projectPath: string | undefined;
	try {
		if (ctx.isProjectTrusted()) {
			const p = projectConfigPath(ctx.cwd);
			if (fs.existsSync(p)) projectPath = p;
		}
	} catch {
		/* ignore */
	}
	const lines = [
		`# PR review config${changed ? " updated" : ""}`,
		"",
		"| Tier | Your setting | Effective | Used for |",
		"|---|---|---|---|",
		...TIERS.map(
			(t) =>
				`| \`${t}\` | ${user.tiers[t] ? `\`${user.tiers[t]}\`` : "_unset_"} | ${effective.tiers[t] ? `\`${effective.tiers[t]}\`` : "_pi default_"} | ${TIER_PURPOSE[t]} |`,
		),
		`| \`tools\` | \`${user.tools.join(",")}\` | \`${effective.tools.join(",")}\` | tools granted to each review subagent |`,
		"",
		`User config: \`${userConfigPath()}\``,
	];
	if (projectPath) lines.push(`Project overlay (trusted): \`${projectPath}\``);
	lines.push(
		"",
		"## Usage",
		"- Open the settings menu: `/pr-review-config`",
		"- Print this summary: `/pr-review-config show`",
		"- Set directly: `/pr-review-config light=provider/model heavy=provider/model:high`",
		"- Clear a tier: `/pr-review-config medium=unset`",
		"- A `<model>` is any pi model pattern (`provider/model` or `provider/model:thinking`).",
	);
	return lines.join("\n");
}

/* --------------------------- interactive menu --------------------------- */

const MODEL_LIST_ROWS = 10;

/**
 * Model picker submenu with type-to-filter search.
 *
 * A raw SelectList only handles arrows/enter/esc, so we wrap it: an Input captures
 * keystrokes and we fuzzy-filter the options (matching the built-in SettingsList
 * search UX and fuzzyFilter's slash-token matching, so typing a model name substring
 * finds `provider/model`). The SelectList is rebuilt as the query changes.
 */
function buildModelSubmenu(available: string[], currentSpec: string | undefined) {
	return (_currentValue: string, done: (selectedValue?: string) => void) => {
		const allItems: SelectItem[] = [
			{ value: "__unset__", label: UNSET, description: "Fall back to the nearest configured tier, then the pi default." },
			...available.map((spec) => ({ value: spec, label: spec })),
		];
		const theme = getSelectListTheme();
		const search = new Input();

		const makeList = (items: SelectItem[], selectValue?: string): SelectList => {
			const list = new SelectList(items, MODEL_LIST_ROWS, theme);
			if (selectValue) {
				const idx = items.findIndex((i) => i.value === selectValue);
				if (idx >= 0) list.setSelectedIndex(idx);
			}
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done();
			return list;
		};

		let list = makeList(allItems, currentSpec ?? "__unset__");

		const applyQuery = (query: string) => {
			const filtered = query.trim() ? fuzzyFilter(allItems, query, (i) => i.label) : allItems;
			list = makeList(filtered);
		};

		const navKeys = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"];
		return {
			render(width: number): string[] {
				return [...search.render(width), ...list.render(width)];
			},
			invalidate(): void {
				search.invalidate?.();
				list.invalidate();
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (navKeys.some((k) => kb.matches(data, k))) {
					list.handleInput(data);
					return;
				}
				// Ignore other escape sequences (arrows/fn/etc.) so they never pollute the search box.
				if (data.startsWith("\x1b")) return;
				// Everything else is search typing (Input handles printable chars + backspace + editing keys).
				const sanitized = data.replace(/ /g, "");
				if (!sanitized) return;
				search.handleInput(sanitized);
				applyQuery(search.getValue());
			},
		};
	};
}

function configMenuItems(cfg: PrReviewConfig, available: string[]): SettingItem[] {
	const tierItems: SettingItem[] = TIERS.map((tier) => ({
		id: tier,
		label: `${tier} model`,
		description: `Used for: ${TIER_PURPOSE[tier]}. Press Enter to pick a model.`,
		currentValue: cfg.tiers[tier] ?? UNSET,
		submenu: buildModelSubmenu(available, cfg.tiers[tier]),
	}));
	const current = cfg.tools.join(",");
	const toolValues = [current, ...TOOLS_PRESETS.filter((p) => p !== current)];
	return [
		...tierItems,
		{
			id: "tools",
			label: "subagent tools",
			description: "Tools granted to each review subagent. Enter/Space cycles presets.",
			currentValue: current,
			values: toolValues,
		},
	];
}

async function showConfigMenu(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	available: string[],
): Promise<"closed" | "fallback"> {
	const draft = readUserConfig();
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("PR Review Config")), 1, 1));
			container.addChild(
				new Text(theme.fg("dim", "Select a value to apply it immediately. Esc closes the menu."), 1, 0),
			);

			let settingsList: SettingsList;
			const refresh = () => {
				for (const tier of TIERS) settingsList.updateValue(tier, draft.tiers[tier] ?? UNSET);
				settingsList.updateValue("tools", draft.tools.join(","));
			};

			const persist = (id: string, newValue: string) => {
				if ((TIERS as string[]).includes(id)) {
					if (newValue === "__unset__") delete draft.tiers[id as Tier];
					else draft.tiers[id as Tier] = newValue;
				} else if (id === "tools") {
					draft.tools = newValue.split(",").map((s) => s.trim()).filter(Boolean);
				} else {
					return;
				}
				try {
					writeUserConfig(draft);
					refresh();
					const shown = id === "tools" ? draft.tools.join(",") : (draft.tiers[id as Tier] ?? UNSET);
					ctx.ui.notify(`PR review config: ${id} = ${shown}`, "info");
				} catch (e) {
					ctx.ui.notify(`pr-review-config failed: ${errMessage(e)}`, "error");
				}
				tui.requestRender();
			};

			settingsList = new SettingsList(
				configMenuItems(draft, available),
				6,
				getSettingsListTheme(),
				(id, newValue) => persist(id, newValue),
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	} catch (e) {
		ctx.ui.notify(`PR review config menu unavailable; showing text config instead. ${errMessage(e)}`, "warning");
		return "fallback";
	}
	return "closed";
}
