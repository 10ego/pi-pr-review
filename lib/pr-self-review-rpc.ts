import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SELF_REVIEW_RPC_STARTUP_TIMEOUT_MS = 30_000;
export const SELF_REVIEW_RPC_TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_TRUSTED_CONFIG_BYTES = 4 * 1024 * 1024;
const CHILD_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SHARED_CHILD_CONFIG_FILES = ["auth.json", "models.json"] as const;

type JsonObject = Record<string, unknown>;

interface TrustedJsonFile {
	path: string;
	value: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertTrustedStat(stat: fs.Stats, label: string, requireDirectory: boolean): void {
	if (requireDirectory ? !stat.isDirectory() : !stat.isFile()) {
		throw new Error(`${label} must be a ${requireDirectory ? "directory" : "regular file"}.`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} must be owned by the current user.`);
	if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable.`);
}

function readTrustedJsonFile(agentDir: string, filename: string, required: boolean): TrustedJsonFile | undefined {
	const filePath = path.join(agentDir, filename);
	let initial: fs.Stats;
	try {
		initial = fs.lstatSync(filePath);
	} catch (error) {
		if (!required && isMissingFile(error)) return undefined;
		throw new Error(`Unable to inspect trusted ${filename}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (initial.isSymbolicLink()) throw new Error(`Trusted ${filename} must not be a symbolic link.`);
	assertTrustedStat(initial, `Trusted ${filename}`, false);
	if (initial.size > MAX_TRUSTED_CONFIG_BYTES) throw new Error(`Trusted ${filename} exceeds the safe size limit.`);

	let fd: number | undefined;
	try {
		const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const opened = fs.fstatSync(fd);
		assertTrustedStat(opened, `Trusted ${filename}`, false);
		if (opened.dev !== initial.dev || opened.ino !== initial.ino) {
			throw new Error(`Trusted ${filename} changed while it was being opened.`);
		}
		if (opened.size > MAX_TRUSTED_CONFIG_BYTES) throw new Error(`Trusted ${filename} exceeds the safe size limit.`);
		const raw = fs.readFileSync(fd, "utf8");
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error(`Trusted ${filename} contains malformed JSON.`);
		}
		if (!isJsonObject(value)) throw new Error(`Trusted ${filename} must contain a JSON object.`);
		const canonicalPath = fs.realpathSync(filePath);
		const canonical = fs.statSync(canonicalPath);
		if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
			throw new Error(`Trusted ${filename} changed while it was being validated.`);
		}
		return { path: canonicalPath, value };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function normalizeSettings(source: JsonObject): JsonObject {
	for (const key of ["retry", "compaction"] as const) {
		const current = source[key];
		if (current !== undefined && !isJsonObject(current)) {
			throw new Error(`Trusted settings.json has an invalid ${key} setting.`);
		}
		source[key] = { ...(current ?? {}), enabled: false };
	}
	return source;
}

function prepareIsolatedAgentDir(trustedAgentDir: string): string {
	if (!path.isAbsolute(trustedAgentDir)) throw new Error("Trusted Pi agent directory must be absolute.");
	const sourceDirStat = fs.lstatSync(trustedAgentDir);
	if (sourceDirStat.isSymbolicLink()) throw new Error("Trusted Pi agent directory must not be a symbolic link.");
	assertTrustedStat(sourceDirStat, "Trusted Pi agent directory", true);
	const sourceDir = fs.realpathSync(trustedAgentDir);
	const settings = readTrustedJsonFile(sourceDir, "settings.json", false);
	const sharedFiles = SHARED_CHILD_CONFIG_FILES.map((filename) => ({
		filename,
		file: readTrustedJsonFile(sourceDir, filename, false),
	}));

	const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-self-review-agent-"));
	try {
		fs.chmodSync(isolatedAgentDir, 0o700);
		const normalized = normalizeSettings(settings?.value ?? {});
		fs.writeFileSync(path.join(isolatedAgentDir, "settings.json"), `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		for (const { filename, file } of sharedFiles) {
			if (file) fs.symlinkSync(file.path, path.join(isolatedAgentDir, filename), "file");
		}
		return isolatedAgentDir;
	} catch (error) {
		fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
		throw error;
	}
}

interface RpcMessage {
	readonly role?: string;
	readonly content?: readonly { readonly type?: string; readonly text?: string }[];
	readonly model?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
}

export interface SelfReviewRpcResult {
	text: string;
	exitCode: number;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	toolElapsedMs: number;
}

export interface SelfReviewRpcOptions {
	/** Total child lifetime. Injectable only so lifecycle tests can fail quickly. */
	readonly totalTimeoutMs?: number;
}

function finalAssistantText(messages: readonly RpcMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
		}
	}
	return "";
}

function runSelfReviewRpcChild(
	command: string,
	args: string[],
	cwd: string,
	input: string,
	signal: AbortSignal | undefined,
	isolatedAgentDir: string,
	totalTimeoutMs: number,
): Promise<SelfReviewRpcResult> {
	return new Promise<SelfReviewRpcResult>((resolve) => {
		const messages: RpcMessage[] = [];
		const result: SelfReviewRpcResult = { text: "", exitCode: 0, stderr: "", toolElapsedMs: 0 };
		let buffer = "";
		let closed = false;
		let resolved = false;
		let aborted = false;
		let protocolFailed = false;
		let agentStarts = 0;
		let promptAccepted = false;
		let agentSettled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		let totalTimer: ReturnType<typeof setTimeout> | undefined;

		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, [CHILD_AGENT_DIR_ENV]: isolatedAgentDir },
		});
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			if (startupTimer) clearTimeout(startupTimer);
			if (totalTimer) clearTimeout(totalTimer);
			signal?.removeEventListener("abort", abort);
		};
		const finish = () => {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve(result);
		};
		const terminate = () => {
			if (closed) return;
			proc.kill("SIGTERM");
			killTimer ??= setTimeout(() => {
				if (!closed) proc.kill("SIGKILL");
			}, 5000);
		};
		const failClosed = (message: string) => {
			protocolFailed = true;
			result.exitCode = 1;
			result.errorMessage ??= message;
			terminate();
		};
		const abort = () => {
			aborted = true;
			result.stopReason = "aborted";
			terminate();
		};
		const send = (commandBody: Record<string, unknown>) => {
			if (closed || protocolFailed) return;
			proc.stdin.write(`${JSON.stringify(commandBody)}\n`, "utf8");
		};
		const processLine = (line: string) => {
			if (!line.trim() || protocolFailed) return;
			let event: {
				type?: string;
				id?: string;
				command?: string;
				success?: boolean;
				error?: string;
				message?: RpcMessage;
				willRetry?: boolean;
			};
			try {
				event = JSON.parse(line);
			} catch {
				failClosed("Self-review child emitted malformed RPC output.");
				return;
			}
			if (event.type === "response") {
				if (event.id === "self-compact-off") {
					if (!event.success || event.command !== "set_auto_compaction") {
						failClosed(event.error || "Self-review child did not disable auto-compaction.");
						return;
					}
					send({ id: "self-retry-off", type: "set_auto_retry", enabled: false });
					return;
				}
				if (event.id === "self-retry-off") {
					if (!event.success || event.command !== "set_auto_retry") {
						failClosed(event.error || "Self-review child did not disable auto-retry.");
						return;
					}
					send({ id: "self-prompt", type: "prompt", message: input });
					return;
				}
				if (event.id === "self-prompt") {
					if (!event.success || event.command !== "prompt") {
						failClosed(event.error || "Self-review child rejected its sole prompt.");
						return;
					}
					promptAccepted = true;
					if (startupTimer) clearTimeout(startupTimer);
					return;
				}
				failClosed("Self-review child emitted an unexpected RPC response.");
				return;
			}
			if (event.type === "auto_retry_start" || event.type === "compaction_start") {
				failClosed(`Self-review child attempted forbidden ${event.type === "auto_retry_start" ? "auto-retry" : "compaction"}.`);
				return;
			}
			if (event.type === "agent_start") {
				agentStarts++;
				if (agentStarts !== 1) failClosed("Self-review child started more than one logical model attempt.");
				return;
			}
			if (event.type === "agent_end" && event.willRetry === true) {
				failClosed("Self-review child announced a forbidden retry.");
				return;
			}
			if (event.type === "message_end" && event.message) {
				messages.push(event.message);
				if (event.message.role === "assistant") {
					if (event.message.model) result.model = event.message.model;
					if (event.message.stopReason) result.stopReason = event.message.stopReason;
					if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
				}
				return;
			}
			if (event.type === "agent_settled") {
				if (!promptAccepted || agentStarts !== 1) {
					failClosed("Self-review child settled without exactly one accepted model attempt.");
					return;
				}
				agentSettled = true;
				proc.stdin.end();
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
		proc.stdin.on("error", (error) => {
			if (!closed && !agentSettled) failClosed(`Self-review child RPC input failed: ${error.message}`);
		});
		proc.on("close", (code) => {
			closed = true;
			if (buffer.trim()) processLine(buffer);
			result.text = finalAssistantText(messages);
			if (!result.errorMessage && !agentSettled) result.errorMessage = "Self-review child exited before agent_settled.";
			if (!result.errorMessage && agentStarts !== 1) result.errorMessage = "Self-review child did not run exactly one model attempt.";
			result.exitCode = result.errorMessage || aborted ? 1 : (code ?? 0);
			finish();
		});
		proc.on("error", (error) => {
			closed = true;
			result.exitCode = 1;
			result.errorMessage = error.message;
			finish();
		});

		totalTimer = setTimeout(
			() => failClosed(`Self-review child RPC total runtime exceeded ${totalTimeoutMs}ms.`),
			totalTimeoutMs,
		);
		startupTimer = setTimeout(
			() => failClosed(`Self-review child RPC startup exceeded ${SELF_REVIEW_RPC_STARTUP_TIMEOUT_MS}ms.`),
			SELF_REVIEW_RPC_STARTUP_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
		if (!aborted) send({ id: "self-compact-off", type: "set_auto_compaction", enabled: false });
	});
}

/**
 * Run self-review through Pi's RPC mode with a private agent directory so the
 * retry/compaction controls cannot persist into the trusted user's settings.
 * Lifecycle checks remain a fail-closed defense against a future Pi regression.
 */
export async function runSelfReviewRpcSubprocess(
	command: string,
	args: string[],
	cwd: string,
	input: string,
	signal: AbortSignal | undefined,
	trustedAgentDir: string,
	options: SelfReviewRpcOptions = {},
): Promise<SelfReviewRpcResult> {
	const totalTimeoutMs = options.totalTimeoutMs ?? SELF_REVIEW_RPC_TOTAL_TIMEOUT_MS;
	if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1) {
		throw new Error("Self-review RPC total timeout must be a positive safe integer.");
	}
	const isolatedAgentDir = prepareIsolatedAgentDir(trustedAgentDir);
	try {
		return await runSelfReviewRpcChild(command, args, cwd, input, signal, isolatedAgentDir, totalTimeoutMs);
	} finally {
		fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
	}
}
