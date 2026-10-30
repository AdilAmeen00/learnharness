import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeCodeTransport } from "../../core/settings.ts";
import { inProcessMcpServer, mcpHttpEndpoint, type McpToolDef, type McpToolHost } from "./mcp.ts";
import { MCP_SERVER_NAME, TOOL_PREFIX, type ClaudeCodeEffort } from "./model.ts";
import type { AnthropicBlock } from "./session.ts";
import { claudeCodeEnv } from "./status.ts";

/**
 * One Claude Code process, launched either way the settings switch says
 * (owner, 2026-10-28): `claude -p` spawned directly with stream-json in and
 * out, or the Agent SDK's query(). Both yield the same stream-json messages
 * and take the same user-message input, so run.ts never knows which.
 *
 * Locked down either way: no built-in tools, no settings files (so no
 * CLAUDE.md, hooks, plugins or MCP servers of the user's), no slash
 * commands, permission mode dontAsk, tool search off (every app tool stays
 * visible), and only the app's MCP server. The environment carries no
 * ANTHROPIC_* variable, so the subscription login is the only way in.
 */

/** A stream-json message, loosely typed: run.ts reads the few it needs. */
export interface ClaudeCodeMessage {
	type: string;
	subtype?: string;
	[key: string]: unknown;
}

export interface LaunchSpec {
	transport: ClaudeCodeTransport;
	bin: string;
	cwd: string;
	model: string;
	effort: ClaudeCodeEffort | "off";
	systemPrompt: string;
	/** A session file to resume (the conversation so far). */
	resumeSessionId?: string;
	/** Resume the file's last turn as interrupted (it ends in tool results). */
	resumeInterrupted: boolean;
	tools: McpToolDef[];
	host: McpToolHost;
}

export interface ClaudeCodeProcess {
	/** The next message; undefined once the process has ended. */
	next(): Promise<ClaudeCodeMessage | undefined>;
	/** Whatever has arrived and not been read yet (non-blocking) — what
	 *  Claude Code did while nobody was asking. */
	drain(): ClaudeCodeMessage[];
	/** Queue a user message (folded in at Claude Code's next boundary).
	 *  Resolves once Claude Code has it — a tool result released after
	 *  this can never overtake it. */
	send(content: AnthropicBlock[]): Promise<void>;
	kill(): void;
	/** Settles once the process is gone (a killed Claude Code can still
	 *  write its transcript on the way out). */
	exited: Promise<void>;
	/** The last stderr lines, for an honest crash message. */
	stderrTail(): string;
}

/** A tiny async queue: push/close on one side, next() on the other.
 *  push() resolves when the item is taken (or the queue closes). */
class Queue<T> {
	private items: { item: T; taken: () => void }[] = [];
	private waiters: ((value: T | undefined) => void)[] = [];
	private closed = false;
	push(item: T): Promise<void> {
		if (this.closed) return Promise.resolve();
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(item);
			return Promise.resolve();
		}
		return new Promise((taken) => this.items.push({ item, taken }));
	}
	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
		for (const { taken } of this.items.splice(0)) taken();
	}
	drain(): T[] {
		const queued = this.items.splice(0);
		for (const { taken } of queued) taken();
		return queued.map(({ item }) => item);
	}
	next(): Promise<T | undefined> {
		const queued = this.items.shift();
		if (queued) {
			queued.taken();
			return Promise.resolve(queued.item);
		}
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		for (;;) {
			const item = await this.next();
			if (item === undefined) return;
			yield item;
		}
	}
}

const STDERR_TAIL = 4000;

function userMessage(content: AnthropicBlock[]) {
	return { type: "user", session_id: "", parent_tool_use_id: null, uuid: randomUUID(), priority: "next", message: { role: "user", content } };
}

/** The environment both transports run under. */
function launchEnv(spec: LaunchSpec): NodeJS.ProcessEnv {
	return claudeCodeEnv({
		ENABLE_TOOL_SEARCH: "false",
		// A tool call waits while the app's loop runs the tool — and, in a
		// kept session, while the learner thinks about a posed question.
		MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000),
		// Over HTTP (the `claude -p` route) Claude Code also aborts a call
		// after 5 silent minutes (verified against 2.1.314); 0 disables it.
		CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
		// Tool results reach the model whole, as with every other provider.
		MAX_MCP_OUTPUT_TOKENS: "1000000",
		DISABLE_AUTOUPDATER: "1",
		// No memory files, no memory instructions: the record is the memory.
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		CLAUDE_AGENT_SDK_CLIENT_APP: "learnharness",
		...(spec.resumeInterrupted ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" } : {}),
		...(spec.effort === "off" ? { MAX_THINKING_TOKENS: "0" } : {}),
	});
}

/** Thinking reaches the app as summaries (the thinking panel stays
 *  readable): print mode omits thinking text unless the display is named
 *  explicitly (verified against 2.1.312 — the settings key is not enough). */
const THINKING_DISPLAY = "summarized";

function allowedTools(spec: LaunchSpec): string[] {
	return spec.tools.map((t) => `${TOOL_PREFIX}${t.name}`);
}

// ─── `claude -p` ────────────────────────────────────────────────────────────

async function launchCli(spec: LaunchSpec): Promise<ClaudeCodeProcess> {
	const endpoint = await mcpHttpEndpoint(spec.host);
	const runDir = path.join(spec.cwd, "runs", randomUUID());
	mkdirSync(runDir, { recursive: true });
	const promptFile = path.join(runDir, "system-prompt.md");
	const mcpFile = path.join(runDir, "mcp.json");
	writeFileSync(promptFile, spec.systemPrompt, { mode: 0o600 });
	writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: endpoint.url } } }), { mode: 0o600 });
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", spec.model,
		"--tools", "",
		"--strict-mcp-config",
		"--mcp-config", mcpFile,
		"--allowedTools", allowedTools(spec).join(","),
		"--permission-mode", "dontAsk",
		"--system-prompt-file", promptFile,
		"--system-prompt-snapshot", "off",
		"--setting-sources", "",
		"--disable-slash-commands",
		"--no-session-persistence",
		...(spec.effort !== "off" ? ["--effort", spec.effort, "--thinking-display", THINKING_DISPLAY] : []),
		...(spec.resumeSessionId ? ["--resume", spec.resumeSessionId] : []),
	];
	const child = spawn(spec.bin, args, { cwd: spec.cwd, env: launchEnv(spec), stdio: ["pipe", "pipe", "pipe"] });
	const messages = new Queue<ClaudeCodeMessage>();
	let stderr = "";
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				messages.push(JSON.parse(line) as ClaudeCodeMessage);
			} catch {
				/* not a stream-json line (a stray log) */
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_TAIL);
	});
	child.stdin.on("error", () => {
		/* the process went away; next() reports it */
	});
	let ended = false;
	let markExited!: () => void;
	const exited = new Promise<void>((resolve) => (markExited = resolve));
	const cleanup = () => {
		endpoint.close();
		rmSync(runDir, { recursive: true, force: true });
		markExited();
	};
	child.on("error", (err) => {
		stderr = (stderr + String(err)).slice(-STDERR_TAIL);
		ended = true;
		messages.close();
		cleanup();
	});
	child.on("close", () => {
		ended = true;
		messages.close();
		cleanup();
	});
	return {
		exited,
		next: () => messages.next(),
		drain: () => messages.drain(),
		send(content) {
			if (ended || !child.stdin.writable) return Promise.resolve();
			return new Promise<void>((resolve) => {
				child.stdin.write(JSON.stringify(userMessage(content)) + "\n", () => resolve());
			});
		},
		kill() {
			if (ended) return;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!ended) child.kill("SIGKILL");
			}, 3000).unref();
		},
		stderrTail: () => stderr,
	};
}

// ─── Agent SDK ──────────────────────────────────────────────────────────────

async function launchSdk(spec: LaunchSpec): Promise<ClaudeCodeProcess> {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const input = new Queue<ReturnType<typeof userMessage>>();
	const messages = new Queue<ClaudeCodeMessage>();
	const abortController = new AbortController();
	let stderr = "";
	// The SDK stops a process gracefully (stdin EOF, then a ~2 s grace
	// before force) — spawning it ourselves is how we learn it has gone.
	let markExited!: () => void;
	const childExited = new Promise<void>((resolve) => (markExited = resolve));
	let spawned = false;
	const spawnClaudeCodeProcess = (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
		spawned = true;
		const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_TAIL);
		});
		child.on("close", () => markExited());
		child.on("error", () => markExited());
		return child;
	};
	let pumpDone!: () => void;
	const pumpEnded = new Promise<void>((resolve) => (pumpDone = resolve));
	const q = query({
		prompt: input as unknown as AsyncIterable<never>,
		options: {
			abortController,
			cwd: spec.cwd,
			env: launchEnv(spec),
			model: spec.model,
			pathToClaudeCodeExecutable: spec.bin,
			tools: [],
			strictMcpConfig: true,
			settingSources: [],
			persistSession: false,
			mcpServers: { [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: inProcessMcpServer(spec.host) as never } },
			allowedTools: allowedTools(spec),
			permissionMode: "dontAsk",
			systemPrompt: { type: "custom", prompt: spec.systemPrompt, snapshot: false },
			includePartialMessages: true,
			extraArgs: { "disable-slash-commands": null, ...(spec.effort !== "off" ? { "thinking-display": THINKING_DISPLAY } : {}) },
			...(spec.effort === "off" ? { thinking: { type: "disabled" } } : { effort: spec.effort }),
			...(spec.resumeSessionId ? { resume: spec.resumeSessionId } : {}),
			spawnClaudeCodeProcess,
		},
	});
	void (async () => {
		try {
			for await (const message of q) messages.push(message as unknown as ClaudeCodeMessage);
		} catch (err) {
			// The SDK throws after an error result it has already yielded;
			// anything else is a real failure worth surfacing.
			if (!abortController.signal.aborted) stderr = (stderr + (err instanceof Error ? err.message : String(err))).slice(-STDERR_TAIL);
		} finally {
			messages.close();
			input.close();
			pumpDone();
		}
	})();
	return {
		// Never spawned (an early failure): the pump's end is the end.
		exited: Promise.race([childExited, pumpEnded.then(() => (spawned ? childExited : undefined))]),
		next: () => messages.next(),
		drain: () => messages.drain(),
		async send(content) {
			// Taken by the SDK's input pump, then one macrotask for its write
			// to reach Claude Code's stdin ahead of anything sent after.
			await input.push(userMessage(content));
			await new Promise((resolve) => setImmediate(resolve));
		},
		kill() {
			input.close();
			abortController.abort();
			try {
				q.close();
			} catch {
				/* already closed */
			}
		},
		stderrTail: () => stderr,
	};
}

export function launchClaudeCode(spec: LaunchSpec): Promise<ClaudeCodeProcess> {
	return spec.transport === "sdk" ? launchSdk(spec) : launchCli(spec);
}
