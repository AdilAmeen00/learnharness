import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmdirSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import type { ClaudeCodeTransport } from "../../core/settings.ts";
import type { McpCallResult, McpContent, McpToolDef, McpToolHost } from "./mcp.ts";
import type { ClaudeCodeEffort } from "./model.ts";
import { launchClaudeCode, type ClaudeCodeMessage, type ClaudeCodeProcess } from "./process.ts";
import {
	appToolName,
	comparable,
	normalizeMessages,
	planLaunch,
	projectDirFor,
	removeSessionFiles,
	sessionEntries,
	toolUseIds,
	writeSessionFile,
	type AnthropicBlock,
	type AnthropicMessage,
} from "./session.ts";
import { claudeCodeConnected, claudeCodeStatus, claudeConfigDir, recordPlanLimits, refreshClaudeCodeStatus } from "./status.ts";

/**
 * THE RUN (owner, 2026-10-28 — "Claude Code runs whole turns"): one Claude
 * Code process per agent run. The app's agent loop still drives every step
 * — it asks for the next assistant message, runs the tools, persists — but
 * each ask is answered by the SAME live Claude Code process:
 *
 *   1. the run's first model call starts Claude Code on the conversation so
 *      far (a temporary session file — the record stays the only real copy);
 *   2. Claude Code streams its next message; it reaches the app as an
 *      ordinary Anthropic stream (stream.ts);
 *   3. when that message calls tools, Claude Code calls them over MCP and
 *      WAITS; the app's loop runs them its usual way and asks for the next
 *      message, whose request now carries the results — they go back as the
 *      MCP answers (messages the learner sent meanwhile go in first, and
 *      Claude Code folds them in at that same boundary);
 *   4. the run ends when the app's loop ends it (releaseClaudeCodeRun) —
 *      a posed question, a finished job, an abort.
 *
 * Every ask is checked against what this process has already seen: if the
 * app's conversation is anything other than "the previous ask + Claude
 * Code's reply + the tool results / new input", the process is replaced by
 * a fresh one started from the app's conversation. Self-healing, never
 * divergent.
 */

export interface RunRequest {
	/** The run key — the agent's session id (one live process per key). */
	key: string;
	/** Single-call use (no session id): release right after the reply. */
	ephemeral: boolean;
	transport: ClaudeCodeTransport;
	model: string;
	effort: ClaudeCodeEffort | "off";
	systemPrompt: string;
	tools: McpToolDef[];
	messages: AnthropicMessage[];
}

/** One Anthropic stream event, as Claude Code relays it. */
export type StreamEvent = { type: string; [key: string]: unknown };

/** A failure with the exact text the learner should see. */
export class ClaudeCodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeCodeError";
	}
}

const NO_FALLBACK = "No API-key fallback was used.";
const IDLE_RELEASE_MS = 30 * 60_000;

type Phase = "streaming" | "tools" | "idle" | "dead";

interface Run {
	key: string;
	spec: string;
	proc: ClaudeCodeProcess;
	tools: McpToolDef[];
	/** The conversation as of the last ask. */
	expected: AnthropicMessage[];
	phase: Phase;
	/** The tool_use ids of the last streamed message (phase "tools"). */
	awaiting: string[];
	/** MCP calls waiting for the app's result. */
	waiting: Map<string, (result: McpCallResult) => void>;
	/** Results that arrived before their MCP call. */
	ready: Map<string, McpCallResult>;
	/** A finished turn still owes its `result` message. */
	owesResult: boolean;
	projectDir: string;
	sessionIds: Set<string>;
	idle?: ReturnType<typeof setTimeout>;
}

const KEY = Symbol.for("lh.claude-code.runs");
function runs(): Map<string, Run> {
	const g = globalThis as typeof globalThis & { [KEY]?: Map<string, Run> };
	return (g[KEY] ??= new Map());
}

/** How many runs are live (tests, diagnostics). */
export function liveClaudeCodeRuns(): number {
	return runs().size;
}

/** End a run: kill its process, answer its waiting tool calls, delete its
 *  session files. Idempotent; unknown keys are a no-op. */
export function releaseClaudeCodeRun(key: string | undefined): void {
	if (!key) return;
	const run = runs().get(key);
	if (!run) return;
	runs().delete(key);
	endRun(run);
}

function endRun(run: Run): void {
	run.phase = "dead";
	if (run.idle) clearTimeout(run.idle);
	for (const answer of run.waiting.values()) answer({ content: [{ type: "text", text: "The run ended." }], isError: true });
	run.waiting.clear();
	run.ready.clear();
	run.proc.kill();
	// The session files go now, and again once the process is gone: a
	// stopped Claude Code may write its transcript on the way out. The
	// app's project folder holds nothing between runs — removed once empty
	// (never forcibly: a run starting meanwhile owns its new file).
	const cleanup = () => {
		for (const id of run.sessionIds) removeSessionFiles(run.projectDir, id);
		try {
			rmdirSync(run.projectDir);
		} catch {
			/* not empty (another run) or already gone */
		}
	};
	cleanup();
	void run.proc.exited.then(cleanup);
}

function workDir(): string {
	const dir = path.join(PATHS.data, "claude-code");
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── tool results → MCP answers ─────────────────────────────────────────────

export function toMcpResult(block: AnthropicBlock): McpCallResult {
	const raw = block.content;
	const content: McpContent[] = [];
	if (typeof raw === "string") content.push({ type: "text", text: raw });
	else if (Array.isArray(raw)) {
		for (const item of raw as AnthropicBlock[]) {
			if (item.type === "text") content.push({ type: "text", text: String(item.text ?? "") });
			else if (item.type === "image") {
				const source = item.source as { type?: string; data?: string; media_type?: string } | undefined;
				if (source?.type === "base64" && source.data) content.push({ type: "image", data: source.data, mimeType: source.media_type ?? "image/png" });
			}
		}
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return block.is_error === true ? { content, isError: true } : { content };
}

// ─── the continuation check ─────────────────────────────────────────────────

export interface Continuation {
	/** Tool results for the calls Claude Code is waiting on. */
	results: AnthropicBlock[];
	/** New user content (learner steers, job results, a reply after a turn). */
	input: AnthropicBlock[];
}

/** Is `messages` exactly "what this run saw + its reply + the next input"?
 *  Pure — the heart of never letting Claude Code and the app diverge. */
export function continuationOf(
	expected: AnthropicMessage[],
	phase: Phase,
	awaiting: readonly string[],
	messages: AnthropicMessage[],
): Continuation | null {
	if (phase !== "tools" && phase !== "idle") return null;
	if (messages.length < expected.length + 2) return null;
	for (let i = 0; i < expected.length; i++) {
		if (comparable(expected[i]!) !== comparable(messages[i]!)) return null;
	}
	const reply = messages[expected.length]!;
	if (reply.role !== "assistant") return null;
	const calls = toolUseIds(reply);
	const tail = messages.slice(expected.length + 1);
	if (tail.some((m) => m.role !== "user")) return null;
	const blocks = tail.flatMap((m) => m.content);
	const results = blocks.filter((b) => b.type === "tool_result");
	const input = blocks.filter((b) => b.type !== "tool_result");
	const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
	if (phase === "tools") {
		if (!sameSet(calls, awaiting)) return null;
		if (!sameSet(results.map((r) => String(r.tool_use_id)), awaiting)) return null;
		return { results, input };
	}
	if (calls.length > 0 || results.length > 0 || input.length === 0) return null;
	return { results, input };
}

// ─── asking ─────────────────────────────────────────────────────────────────

function specOf(request: RunRequest): string {
	return JSON.stringify([request.transport, request.model, request.effort, request.systemPrompt, request.tools]);
}

async function startRun(request: RunRequest): Promise<Run> {
	const status = await refreshClaudeCodeStatus();
	if (!claudeCodeConnected() || !status.bin) {
		throw new ClaudeCodeError(
			!status.installed
				? `Claude Code isn't installed on this machine. Install it, sign in with your Claude subscription, then retry. ${NO_FALLBACK}`
				: `Claude Code isn't signed in with a Claude subscription. Run \`claude\` in a terminal, sign in, then retry. ${NO_FALLBACK}`,
		);
	}
	const plan = planLaunch(request.messages);
	const cwd = workDir();
	const projectDir = projectDirFor(claudeConfigDir(), cwd);
	const sessionIds = new Set<string>();
	let resumeSessionId: string | undefined;
	if (plan.history.length > 0) {
		resumeSessionId = randomUUID();
		writeSessionFile(
			projectDir,
			resumeSessionId,
			sessionEntries(plan.history, { sessionId: resumeSessionId, cwd: projectDirCwd(cwd), version: claudeCodeStatus()?.version ?? "0", model: request.model }),
		);
		sessionIds.add(resumeSessionId);
	}
	const run = {
		key: request.key,
		spec: specOf(request),
		tools: request.tools,
		expected: request.messages,
		phase: "streaming",
		awaiting: [],
		waiting: new Map(),
		ready: new Map(),
		owesResult: false,
		projectDir,
		sessionIds,
	} as unknown as Run;
	const host: McpToolHost = {
		tools: () => run.tools,
		call: (_name, _args, toolUseId) => awaitResult(run, toolUseId),
	};
	try {
		run.proc = await launchClaudeCode({
			transport: request.transport,
			bin: status.bin,
			cwd,
			model: request.model,
			effort: request.effort,
			systemPrompt: request.systemPrompt,
			resumeSessionId,
			resumeInterrupted: plan.resumeInterrupted,
			tools: request.tools,
			host,
		});
	} catch (err) {
		for (const id of sessionIds) removeSessionFiles(projectDir, id);
		throw new ClaudeCodeError(`Claude Code could not start: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (plan.input) void run.proc.send(plan.input);
	return run;
}

/** The working directory as Claude Code records it (its realpath). */
function projectDirCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}

function awaitResult(run: Run, toolUseId: string | undefined): Promise<McpCallResult> {
	if (!toolUseId) return Promise.resolve({ content: [{ type: "text", text: "Tool call without an id." }], isError: true });
	if (run.phase === "dead") return Promise.resolve({ content: [{ type: "text", text: "The run ended." }], isError: true });
	const ready = run.ready.get(toolUseId);
	if (ready) {
		run.ready.delete(toolUseId);
		return Promise.resolve(ready);
	}
	return new Promise((resolve) => run.waiting.set(toolUseId, resolve));
}

async function deliver(run: Run, step: Continuation): Promise<void> {
	// Input first, and wait until Claude Code has it: it folds a queued
	// message in at the boundary the tool results open (verified against
	// 2.1.312), matching where the app's loop placed it — but only if the
	// message gets there before the results do.
	if (step.input.length > 0) await run.proc.send(step.input);
	for (const block of step.results) {
		const id = String(block.tool_use_id);
		const result = toMcpResult(block);
		const answer = run.waiting.get(id);
		if (answer) {
			run.waiting.delete(id);
			answer(result);
		} else run.ready.set(id, result);
	}
}

/** Strip the MCP prefix (and Claude Code's own extras) from a relayed event. */
export function relayEvent(event: StreamEvent): StreamEvent {
	if (event.type !== "content_block_start") return event;
	const block = event.content_block as Record<string, unknown> | undefined;
	if (!block || block.type !== "tool_use") return event;
	const { caller: _caller, ...rest } = block;
	return { ...event, content_block: { ...rest, name: appToolName(String(rest.name)) } };
}

/** The text of a synthetic error reply (plan limit, auth, API failure). */
function replyText(message: ClaudeCodeMessage): string {
	const inner = message.message as { content?: { type?: string; text?: string }[] } | undefined;
	return (inner?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ").trim();
}

function failureText(kind: string | undefined, text: string): string {
	if (kind === "rate_limit" || /usage limit|hit your limit|rate.?limit/i.test(text)) {
		return `Your Claude plan's usage limit is reached${text ? ` (${text})` : ""}. ${NO_FALLBACK}`;
	}
	if (kind === "authentication_failed" || kind === "billing_error" || /log ?in|authenticat|oauth/i.test(text)) {
		return `Claude Code's sign-in failed${text ? ` (${text})` : ""}. Run \`claude\` in a terminal, sign in again, then retry. ${NO_FALLBACK}`;
	}
	return `Claude Code returned an error${text ? `: ${text}` : ""}. ${NO_FALLBACK}`;
}

/** Relay Claude Code's next top-level assistant message, event by event. */
async function streamReply(run: Run, emit: (event: StreamEvent) => void): Promise<void> {
	let started = false;
	let stopReason: string | undefined;
	const calls: string[] = [];
	for (;;) {
		const message = await run.proc.next();
		if (!message) {
			if (run.phase === "dead") throw new ClaudeCodeError("The Claude Code run was stopped.");
			const tail = run.proc.stderrTail().trim().split("\n").slice(-3).join(" ").slice(0, 400);
			throw new ClaudeCodeError(`Claude Code stopped ${started ? "mid-reply" : "before replying"}${tail ? `: ${tail}` : "."} ${NO_FALLBACK}`);
		}
		if (message.type === "system" && message.subtype === "init") {
			if (typeof message.session_id === "string") run.sessionIds.add(message.session_id);
			const source = message.apiKeySource;
			if (typeof source === "string" && source !== "none") {
				throw new ClaudeCodeError(`Claude Code on this machine is set to use an API key (${source}), so nothing was sent. Sign in with your Claude subscription instead. ${NO_FALLBACK}`);
			}
			continue;
		}
		if (message.type === "rate_limit_event") {
			recordPlanLimits(message.rate_limit_info as Parameters<typeof recordPlanLimits>[0]);
			continue;
		}
		if (message.type === "result") {
			if (run.owesResult) {
				run.owesResult = false;
				continue;
			}
			if (started) continue;
			const text = typeof message.result === "string" ? message.result : "";
			throw new ClaudeCodeError(
				message.is_error === true || message.subtype !== "success"
					? failureText(undefined, text || String(message.subtype ?? ""))
					: `Claude Code ended the turn without replying. ${NO_FALLBACK}`,
			);
		}
		if (message.type === "assistant") {
			if (!started && typeof message.error === "string" && !message.parent_tool_use_id) throw new ClaudeCodeError(failureText(message.error, replyText(message)));
			continue;
		}
		if (message.type !== "stream_event" || message.parent_tool_use_id) continue;
		const event = message.event as StreamEvent | undefined;
		if (!event?.type) continue;
		if (event.type === "message_start") started = true;
		if (!started) continue;
		if (event.type === "content_block_start") {
			const block = event.content_block as { type?: string; id?: string } | undefined;
			if (block?.type === "tool_use" && block.id) calls.push(block.id);
		}
		if (event.type === "message_delta") {
			const delta = event.delta as { stop_reason?: string } | undefined;
			if (delta?.stop_reason) stopReason = delta.stop_reason;
		}
		emit(relayEvent(event));
		if (event.type === "message_stop") break;
	}
	if (stopReason === "tool_use" && calls.length > 0) {
		run.phase = "tools";
		run.awaiting = calls;
	} else {
		run.phase = "idle";
		run.awaiting = [];
		run.owesResult = true;
	}
}

/**
 * Answer one model call: continue the key's live run when the conversation
 * is its continuation, otherwise (re)start one; then relay the next reply.
 * Rejects with ClaudeCodeError carrying the learner-facing text.
 */
export async function askClaudeCode(request: RunRequest, emit: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new ClaudeCodeError("The request was cancelled.");
	let run = runs().get(request.key);
	if (run?.idle) clearTimeout(run.idle);
	const step = run && run.phase !== "dead" && run.spec === specOf(request) ? continuationOf(run.expected, run.phase, run.awaiting, request.messages) : null;
	if (run && step) {
		run.expected = request.messages;
		run.phase = "streaming";
		await deliver(run, step);
	} else {
		if (run) releaseClaudeCodeRun(request.key);
		run = await startRun(request);
		runs().set(request.key, run);
	}
	const live = run;
	const onAbort = () => releaseClaudeCodeRun(request.key);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await streamReply(live, emit);
	} catch (err) {
		releaseClaudeCodeRun(request.key);
		throw err;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
	if (request.ephemeral) releaseClaudeCodeRun(request.key);
	else if (runs().get(request.key) === live) {
		// Safety net only: the app's loop releases the run when it ends.
		live.idle = setTimeout(() => {
			if (runs().get(request.key) === live) releaseClaudeCodeRun(request.key);
		}, IDLE_RELEASE_MS);
		live.idle.unref?.();
	}
}

/** pi's request body → the run's inputs (system prompt, tools, conversation). */
export function requestParts(payload: Record<string, unknown>): { systemPrompt: string; tools: McpToolDef[]; messages: AnthropicMessage[] } {
	const system = payload.system;
	const systemPrompt =
		typeof system === "string"
			? system
			: Array.isArray(system)
				? (system as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n\n")
				: "";
	const tools = (Array.isArray(payload.tools) ? payload.tools : [])
		.filter((t): t is { name: string; description?: string; input_schema?: Record<string, unknown> } => !!t && typeof (t as { name?: unknown }).name === "string")
		.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema ?? { type: "object", properties: {} } }));
	return { systemPrompt, tools, messages: normalizeMessages(payload.messages) };
}
