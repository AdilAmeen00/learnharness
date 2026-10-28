import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_PREFIX } from "./model.ts";

/**
 * The conversation hand-over. The app's record stays the only real copy of
 * a session: at the start of every Claude Code run the conversation so far
 * is written as a temporary Claude Code session file (its JSONL transcript
 * format) and resumed; the file is deleted when the run ends.
 *
 * Input is the Anthropic Messages conversation pi builds for the request
 * (pi's own, battle-tested conversion of the record — tool calls, results,
 * thinking signatures, images). Pure except the two file helpers at the end.
 */

export interface AnthropicBlock {
	type: string;
	[key: string]: unknown;
}

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicBlock[];
}

/** Deep copy without `cache_control` (pi's request-side markers). */
function stripCacheControl<T>(value: T): T {
	if (Array.isArray(value)) return value.map(stripCacheControl) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			if (key === "cache_control") continue;
			out[key] = stripCacheControl(inner);
		}
		return out as T;
	}
	return value;
}

/** pi's request messages → plain user/assistant block lists. */
export function normalizeMessages(raw: unknown): AnthropicMessage[] {
	if (!Array.isArray(raw)) return [];
	const out: AnthropicMessage[] = [];
	for (const message of raw as { role?: unknown; content?: unknown }[]) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: Array.isArray(message.content)
					? (stripCacheControl(message.content) as AnthropicBlock[])
					: [];
		out.push({ role: message.role, content });
	}
	return out;
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/** A message's identity for the continuation check: thinking blocks are
 *  left out (Claude Code holds its own), everything else must match. */
export function comparable(message: AnthropicMessage): string {
	return JSON.stringify({ role: message.role, content: message.content.filter((b) => !THINKING_TYPES.has(b.type)) });
}

export function hasToolResults(message: AnthropicMessage | undefined): boolean {
	return !!message?.content.some((b) => b.type === "tool_result");
}

export function toolUseIds(message: AnthropicMessage | undefined): string[] {
	return (message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => String(b.id));
}

/** The app's tool names as Claude Code knows them (`mcp__lh__quiz`). */
export function claudeCodeToolName(name: string): string {
	return name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`;
}

/** …and back. */
export function appToolName(name: string): string {
	return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

/** History as Claude Code's transcript holds it: tool calls carry the MCP
 *  prefix the model saw them under. */
export function toClaudeCodeHistory(messages: AnthropicMessage[]): AnthropicMessage[] {
	return messages.map((message) =>
		message.role !== "assistant"
			? message
			: { ...message, content: message.content.map((b) => (b.type === "tool_use" ? { ...b, name: claudeCodeToolName(String(b.name)) } : b)) },
	);
}

/**
 * How a fresh run starts from a conversation that ends with a user message:
 *
 * - ending in plain user content: the history before it goes in the session
 *   file and that last message is the run's first input;
 * - ending in tool results (a learner's answer is the quiz call's result):
 *   the WHOLE conversation goes in the file and Claude Code resumes it as an
 *   interrupted turn. Sending tool results as input instead makes Claude
 *   Code mark the open call interrupted and drop the real result
 *   (verified against Claude Code 2.1.312).
 */
export interface LaunchPlan {
	history: AnthropicMessage[];
	input?: AnthropicBlock[];
	resumeInterrupted: boolean;
}

export function planLaunch(messages: AnthropicMessage[]): LaunchPlan {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") throw new Error("Claude Code runs start from a user message");
	if (hasToolResults(last)) return { history: messages, resumeInterrupted: true };
	return { history: messages.slice(0, -1), input: last.content, resumeInterrupted: false };
}

/** The session file's lines (Claude Code's transcript entry shape). */
export function sessionEntries(
	history: AnthropicMessage[],
	opts: { sessionId: string; cwd: string; version: string; model: string; at?: string },
): Record<string, unknown>[] {
	const timestamp = opts.at ?? new Date().toISOString();
	let parentUuid: string | null = null;
	return toClaudeCodeHistory(history).map((message, index) => {
		const uuid = randomUUID();
		const entry = {
			parentUuid,
			isSidechain: false,
			type: message.role,
			message:
				message.role === "user"
					? { role: "user", content: message.content }
					: {
							id: `msg_lh_${index}`,
							type: "message",
							role: "assistant",
							model: opts.model,
							content: message.content,
							stop_reason: message.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
							stop_sequence: null,
							usage: { input_tokens: 0, output_tokens: 0 },
						},
			uuid,
			timestamp,
			userType: "external",
			cwd: opts.cwd,
			sessionId: opts.sessionId,
			version: opts.version,
		};
		parentUuid = uuid;
		return entry;
	});
}

// ─── files ──────────────────────────────────────────────────────────────────

/** Claude Code's per-project transcript folder for a working directory. */
export function projectDirFor(configDir: string, cwd: string): string {
	let real = cwd;
	try {
		real = realpathSync(cwd);
	} catch {
		/* not created yet — the caller creates it before launching */
	}
	return path.join(configDir, "projects", real.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function writeSessionFile(projectDir: string, sessionId: string, entries: Record<string, unknown>[]): string {
	mkdirSync(projectDir, { recursive: true });
	const file = path.join(projectDir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
	return file;
}

/** Remove a session's transcript and its side folder (best effort). */
export function removeSessionFiles(projectDir: string, sessionId: string): void {
	for (const target of [path.join(projectDir, `${sessionId}.jsonl`), path.join(projectDir, sessionId)]) {
		try {
			rmSync(target, { recursive: true, force: true });
		} catch {
			/* already gone */
		}
	}
}
