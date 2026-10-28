import { CONFIG_DIR, FAKE_BIN, LOG, SCENARIO } from "./claude-code-setup.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeContext, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { piEngineForSpec } from "../src/agent/models.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { CLAUDE_CODE_PROVIDER, claudeCodeModel, effortForLevel } from "../src/agent/claude-code/model.ts";
import { comparable, normalizeMessages, planLaunch, sessionEntries, type AnthropicMessage } from "../src/agent/claude-code/session.ts";
import { continuationOf, liveClaudeCodeRuns, relayEvent, releaseClaudeCodeRun, requestParts, toMcpResult } from "../src/agent/claude-code/run.ts";
import { handleMcpMessage, inProcessMcpServer, mcpHttpEndpoint } from "../src/agent/claude-code/mcp.ts";
import { claudeCodeEnv, claudeCodeModelById, claudeCodePlanLimits, setClaudeCodeStatusForTests } from "../src/agent/claude-code/status.ts";
import { TRANSPORT_NOTE } from "../src/agent/claude-code/stream.ts";
import { claudeCodeSettingsOf, sanitizeUserSettings } from "../src/core/settings.ts";
import { parseClaudeCodeSettingsBody } from "../src/server/settings-body.ts";
import { subscriptionLabel } from "../src/core/prices.ts";
import { stores } from "../src/server/stores.ts";

const settingsStore = stores.settingsStore;

// ─── the scripted fake ──────────────────────────────────────────────────────

type Block = Record<string, unknown>;
function scenario(replies: { content?: Block[]; failure?: { kind: string; text: string } }[], extra: Record<string, unknown> = {}) {
	writeFileSync(SCENARIO, JSON.stringify({ replies, ...extra }));
	rmSync(`${SCENARIO}.next`, { force: true });
	rmSync(LOG, { force: true });
}
function fakeLog(): Record<string, any>[] {
	if (!existsSync(LOG)) return [];
	return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	setClaudeCodeStatusForTests({ installed: true, bin: FAKE_BIN, version: "9.9.9", loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", checkedAt: Date.now() + 1e9 });
	settingsStore.writeSettings({ version: 1 });
});

function echoTool(gate?: Promise<void>): AgentTool<any> {
	return {
		name: "echo",
		label: "echo",
		description: "Echo the number back.",
		parameters: Type.Object({ x: Type.Number() }),
		execute: async (_id, input) => {
			await gate;
			return { content: [{ type: "text", text: `echo ${(input as { x: number }).x}` }], details: {} };
		},
	};
}

const engine = () => piEngineForSpec({ provider: CLAUDE_CODE_PROVIDER, id: "claude-haiku-5-5", thinkingLevel: "low" }, false);
const userText = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;
const conversation = (messages: AgentMessage[]) => messages.filter((m) => (m as { role?: string }).role !== "system");

// ─── pure pieces ────────────────────────────────────────────────────────────

test("effort mapping: the five efforts pass through, minimal rides low, no level is off", () => {
	assert.equal(effortForLevel("minimal"), "low");
	assert.equal(effortForLevel("low"), "low");
	assert.equal(effortForLevel("xhigh"), "xhigh");
	assert.equal(effortForLevel("max"), "max");
	assert.equal(effortForLevel(undefined), "off");
	assert.equal(effortForLevel("off"), "off");
});

test("a Claude Code model is the Anthropic entry re-homed: $0, plain requests", () => {
	const model = claudeCodeModelById("claude-opus-5-5")!;
	assert.equal(model.provider, CLAUDE_CODE_PROVIDER);
	assert.equal(model.api, "anthropic-messages");
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const compat = model.compat as Record<string, unknown>;
	assert.equal(compat.supportsMidConvoEffort, false);
	assert.equal(compat.supportsMidConvoToolChanges, false);
	assert.equal(claudeCodeModelById("gpt-5"), undefined);
	assert.equal(claudeCodeModel(model, "Custom").name, "Custom");
});

test("planLaunch: plain user input rides as input; tool results resume the whole conversation", () => {
	const user = (content: Block[]): AnthropicMessage => ({ role: "user", content: content as never });
	const asst: AnthropicMessage = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "quiz", input: {} }] };
	const plain = planLaunch([user([{ type: "text", text: "hi" }])]);
	assert.deepEqual(plain, { history: [], input: [{ type: "text", text: "hi" }], resumeInterrupted: false });
	const answer = [user([{ type: "text", text: "hi" }]), asst, user([{ type: "tool_result", tool_use_id: "t1", content: "B" }])];
	const resumed = planLaunch(answer);
	assert.equal(resumed.resumeInterrupted, true);
	assert.equal(resumed.history.length, 3);
	assert.equal(resumed.input, undefined);
	assert.throws(() => planLaunch([asst]));
});

test("session entries: a parent chain, Claude Code's tool names, stop reasons", () => {
	const history: AnthropicMessage[] = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "quiz", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "B" }] },
	];
	const entries = sessionEntries(history, { sessionId: "s", cwd: "/w", version: "2.1.312", model: "claude-opus-5-5" }) as any[];
	assert.equal(entries[0].parentUuid, null);
	assert.equal(entries[1].parentUuid, entries[0].uuid);
	assert.equal(entries[2].parentUuid, entries[1].uuid);
	assert.equal(entries[1].message.content[1].name, "mcp__lh__quiz");
	assert.equal(entries[1].message.stop_reason, "tool_use");
	assert.equal(entries[2].type, "user");
	assert.equal(history[1]!.content[1]!.name, "quiz", "the input is not mutated");
});

test("normalizeMessages drops cache markers; comparable ignores thinking", () => {
	const [m] = normalizeMessages([{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }]);
	assert.deepEqual(m, { role: "user", content: [{ type: "text", text: "a" }] });
	const withThinking: AnthropicMessage = { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "b" }] };
	const without: AnthropicMessage = { role: "assistant", content: [{ type: "text", text: "b" }] };
	assert.equal(comparable(withThinking), comparable(without));
});

test("continuationOf: tool results (plus new input) continue; anything else restarts", () => {
	const seen: AnthropicMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
	const reply: AnthropicMessage = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] };
	const results: AnthropicMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1" }] };
	const steer: AnthropicMessage = { role: "user", content: [{ type: "text", text: "also" }] };
	const ok = continuationOf(seen, "tools", ["t1"], [...seen, reply, results, steer]);
	assert.equal(ok?.results.length, 1);
	assert.deepEqual(ok?.input, [{ type: "text", text: "also" }]);
	assert.equal(continuationOf(seen, "tools", ["t2"], [...seen, reply, results]), null, "other tool calls");
	assert.equal(continuationOf(seen, "tools", ["t1"], [...seen, reply, steer]), null, "a missing result");
	const edited: AnthropicMessage[] = [{ role: "user", content: [{ type: "text", text: "edited" }] }];
	assert.equal(continuationOf(seen, "tools", ["t1"], [...edited, reply, results]), null, "a changed history");
	assert.equal(continuationOf(seen, "streaming", ["t1"], [...seen, reply, results]), null);
	const done: AnthropicMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };
	assert.deepEqual(continuationOf(seen, "idle", [], [...seen, done, steer])?.input, [{ type: "text", text: "also" }]);
	assert.equal(continuationOf(seen, "idle", [], [...seen, done]), null, "nothing new to say");
});

test("tool results become MCP answers: text, images, errors", () => {
	assert.deepEqual(toMcpResult({ type: "tool_result", content: "plain" }), { content: [{ type: "text", text: "plain" }] });
	assert.deepEqual(
		toMcpResult({ type: "tool_result", is_error: true, content: [{ type: "text", text: "bad" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }),
		{ content: [{ type: "text", text: "bad" }, { type: "image", data: "AAA", mimeType: "image/png" }], isError: true },
	);
});

test("relayEvent strips the MCP prefix and Claude Code's caller field", () => {
	const event = relayEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "mcp__lh__quiz", input: {}, caller: { type: "direct" } } });
	assert.deepEqual(event.content_block, { type: "tool_use", id: "t", name: "quiz", input: {} });
	const text = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } };
	assert.equal(relayEvent(text), text);
});

test("requestParts reads system text, tools and messages from pi's request", () => {
	const parts = requestParts({
		system: [{ type: "text", text: "A", cache_control: {} }, { type: "text", text: "B" }],
		tools: [{ name: "quiz", description: "Ask.", input_schema: { type: "object" }, cache_control: {} }],
		messages: [{ role: "user", content: "hi" }],
	});
	assert.equal(parts.systemPrompt, "A\n\nB");
	assert.deepEqual(parts.tools, [{ name: "quiz", description: "Ask.", inputSchema: { type: "object" } }]);
	assert.deepEqual(parts.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("MCP handler: initialize, list, calls carry Claude Code's tool_use id", async () => {
	const calls: unknown[] = [];
	const host = {
		tools: () => [{ name: "echo", description: "", inputSchema: { type: "object" } }],
		call: async (name: string, args: unknown, id: string | undefined) => {
			calls.push({ name, args, id });
			if (name === "boom") throw new Error("nope");
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	const init = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.equal((init!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
	assert.equal(await handleMcpMessage(host, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
	const list = await handleMcpMessage(host, { jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal((list!.result as { tools: unknown[] }).tools.length, 1);
	await handleMcpMessage(host, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 1 }, _meta: { "claudecode/toolUseId": "toolu_9" } } });
	assert.deepEqual(calls[0], { name: "echo", args: { x: 1 }, id: "toolu_9" });
	const boom = await handleMcpMessage(host, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } });
	assert.deepEqual(boom!.result, { content: [{ type: "text", text: "nope" }], isError: true });
	const unknown = await handleMcpMessage(host, { jsonrpc: "2.0", id: 5, method: "resources/list" });
	assert.equal(unknown!.error?.code, -32601);
});

test("the SDK instance answers over its transport; the loopback endpoint answers over HTTP", async () => {
	const host = { tools: () => [{ name: "echo", description: "", inputSchema: { type: "object" } }], call: async () => ({ content: [{ type: "text" as const, text: "ok" }] }) };
	const sent: unknown[] = [];
	const transport = { send: (m: unknown) => void sent.push(m), start: async () => {} } as { onmessage?: (m: object) => void; send(m: unknown): void; start(): Promise<void> };
	await inProcessMcpServer(host).connect(transport as never);
	transport.onmessage!({ jsonrpc: "2.0", id: 7, method: "tools/list" });
	await settle(10);
	assert.equal((sent[0] as { id: number }).id, 7);
	const endpoint = await mcpHttpEndpoint(host);
	try {
		assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/);
		const res = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }) });
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
		assert.match(await res.text(), /"text":"ok"/);
		const missing = await fetch(endpoint.url.replace(/[a-f0-9]{48}$/, "0".repeat(48)), { method: "POST", body: "{}" });
		assert.equal(missing.status, 404);
	} finally {
		endpoint.close();
	}
});

test("the child environment never carries an API key or a parent session", () => {
	const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
	process.env.CLAUDECODE = "1";
	process.env.CLAUDE_CODE_SESSION_ID = "parent";
	try {
		const env = claudeCodeEnv({ EXTRA: "1" });
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.CLAUDECODE, undefined);
		assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
		assert.equal(env.CLAUDE_CONFIG_DIR, CONFIG_DIR);
		assert.equal(env.EXTRA, "1");
	} finally {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

test("settings: the claudeCode section sanitizes, parses and defaults", () => {
	assert.deepEqual(claudeCodeSettingsOf(null), { transport: "cli", allowBackgroundUse: true });
	assert.deepEqual(sanitizeUserSettings({ version: 1, claudeCode: { transport: "sdk", allowBackgroundUse: false, junk: 1 } })?.claudeCode, { transport: "sdk", allowBackgroundUse: false });
	assert.deepEqual(sanitizeUserSettings({ version: 1, claudeCode: { transport: "pipe" } })?.claudeCode, {});
	assert.deepEqual(parseClaudeCodeSettingsBody({ transport: "sdk" }), { ok: true, settings: { transport: "sdk" } });
	assert.equal(parseClaudeCodeSettingsBody({ transport: "pipe" }).ok, false);
	assert.equal(parseClaudeCodeSettingsBody({ allowBackgroundUse: "yes" }).ok, false);
	assert.equal(subscriptionLabel("claude-code:claude-opus-5-5"), "Claude Code");
});

// ─── whole runs through the fake `claude -p` ───────────────────────────────

test("one process runs the whole run: tool call over MCP, the app runs the tool, Claude Code continues", async () => {
	scenario([
		{ content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_a1", name: "mcp__lh__echo", input: { x: 1 } }] },
		{ content: [{ type: "text", text: "done" }] },
	]);
	const agent = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-1", tools: { echo: echoTool() } });
	await agent.prompt(userText("hi"));
	const messages = conversation(agent.state.messages);
	assert.deepEqual(messages.map((m) => (m as { role: string }).role), ["user", "assistant", "toolResult", "assistant"]);
	const first = messages[1] as AssistantMessage;
	const call = first.content.find((c) => c.type === "toolCall") as { name: string; arguments: unknown };
	assert.equal(call.name, "echo", "the MCP prefix never reaches the app");
	assert.deepEqual(call.arguments, { x: 1 });
	assert.equal(first.provider, CLAUDE_CODE_PROVIDER);
	assert.equal(first.usage.input, 10);
	assert.equal(first.usage.cost.total, 0);
	assert.equal(((messages[2] as ToolResultMessage).content[0] as { text: string }).text, "echo 1");
	assert.equal(((messages[3] as AssistantMessage).content[0] as { text: string }).text, "done");

	await settle();
	const log = fakeLog();
	const starts = log.filter((e) => e.kind === "start");
	assert.equal(starts.length, 1, "both model calls used the same process");
	assert.equal(starts[0]!.effort, "low");
	assert.equal(starts[0]!.anthropicKey, false);
	assert.ok(starts[0]!.systemPrompt.endsWith(TRANSPORT_NOTE));
	assert.ok(starts[0]!.args.includes("--disable-slash-commands"));
	assert.deepEqual(log.find((e) => e.kind === "tools")!.names, ["echo"]);
	assert.equal(log.find((e) => e.kind === "tool-result")!.result.content[0].text, "echo 1");
	assert.equal(liveClaudeCodeRuns(), 1, "the session's process stays up for its next turn");
	releaseClaudeCodeRun("cc-chat-1");
	assert.equal(liveClaudeCodeRuns(), 0);
	assert.equal(claudeCodePlanLimits()?.sevenDay?.utilization, 0.5);
});

test("an answer turn resumes the whole conversation as an interrupted turn", async () => {
	scenario([
		{ content: [{ type: "tool_use", id: "toolu_b1", name: "mcp__lh__echo", input: { x: 2 } }] },
		{ content: [{ type: "text", text: "first" }] },
	]);
	const one = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-2", tools: { echo: echoTool() } });
	await one.prompt(userText("start"));
	const history = conversation(one.state.messages).slice(0, 3); // user, assistant(tool), toolResult
	scenario([{ content: [{ type: "text", text: "after the answer" }] }]);
	const two = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-2", tools: { echo: echoTool() }, messages: history });
	await two.continue();
	const reply = conversation(two.state.messages).at(-1) as AssistantMessage;
	assert.equal((reply.content[0] as { text: string }).text, "after the answer");
	const start = fakeLog().find((e) => e.kind === "start")!;
	assert.equal(start.interrupted, true);
	assert.ok(start.resume);
	assert.deepEqual(start.history.map((e: { type: string }) => e.type), ["user", "assistant", "user"]);
	assert.equal(start.history[1].content[0].name, "mcp__lh__echo");
	assert.equal(start.history[2].content[0].type, "tool_result");
	// The temporary session file is gone once the run ends.
	releaseClaudeCodeRun("cc-chat-2");
	await settle();
	const projects = path.join(CONFIG_DIR, "projects");
	const leftovers = existsSync(projects) ? readdirSync(projects).flatMap((d) => readdirSync(path.join(projects, d))).filter((f) => f.endsWith(".jsonl")) : [];
	assert.deepEqual(leftovers, []);
});

test("a message sent while a tool runs reaches Claude Code before the tool's result", async () => {
	scenario([
		{ content: [{ type: "tool_use", id: "toolu_c1", name: "mcp__lh__echo", input: { x: 3 } }] },
		{ content: [{ type: "text", text: "saw it" }] },
	]);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const agent = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-3", tools: { echo: echoTool(gate) } });
	const running = agent.prompt(userText("go"));
	for (let i = 0; i < 100 && !fakeLog().some((e) => e.kind === "tools"); i++) await settle(20);
	await settle(100);
	agent.steer(userText("also consider this") as never);
	release();
	await running;
	await settle();
	const log = fakeLog();
	const stdinAt = log.findIndex((e) => e.kind === "stdin" && JSON.stringify(e.content).includes("also consider this"));
	const resultAt = log.findIndex((e) => e.kind === "tool-result");
	assert.ok(stdinAt >= 0, "the steer reached Claude Code");
	assert.equal(log[stdinAt]!.duringTools, true);
	assert.ok(stdinAt < resultAt, "input goes in before the tool result is released");
	assert.equal(log.filter((e) => e.kind === "start").length, 1);
	releaseClaudeCodeRun("cc-chat-3");
});

/** A question tool for the scripted runs: the stopper ends the run on a
 *  clean ask_user_question, as it does in a real session. */
const askTool: AgentTool<any> = {
	name: "ask_user_question",
	label: "ask",
	description: "Ask the learner.",
	parameters: Type.Object({ question: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "Question posed." }], details: {}, terminate: true }),
};

test("the session's process outlives the turn: the answer to a posed question goes straight back to it", async () => {
	scenario([
		{ content: [{ type: "text", text: "First, a question." }, { type: "tool_use", id: "toolu_q1", name: "mcp__lh__ask_user_question", input: { question: "A or B?" } }] },
		{ content: [{ type: "text", text: "You said B." }] },
		{ content: [{ type: "text", text: "And now C." }] },
	]);
	const tools = { ask_user_question: askTool };
	const one = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-5", tools });
	await one.prompt(userText("teach me"));
	assert.equal(liveClaudeCodeRuns(), 1, "parked on the posed question");
	// The record as the app persists it: the question call, then the
	// learner's answer as its result (the in-memory placeholder never lands).
	const asked = conversation(one.state.messages).filter((m) => (m as { role: string }).role !== "toolResult");
	const answer = { role: "toolResult", toolCallId: "toolu_q1", toolName: "ask_user_question", content: [{ type: "text", text: "B" }], isError: false, timestamp: Date.now() } as AgentMessage;
	const two = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-5", tools, messages: [...asked, answer] });
	await two.continue();
	assert.equal(((conversation(two.state.messages).at(-1) as AssistantMessage).content[0] as { text: string }).text, "You said B.");
	// A plain follow-up after a plain reply rides the same process too.
	const three = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-5", tools, messages: [...conversation(two.state.messages), userText("go on")] });
	await three.continue();
	assert.equal(((conversation(three.state.messages).at(-1) as AssistantMessage).content[0] as { text: string }).text, "And now C.");
	await settle();
	const log = fakeLog();
	assert.equal(log.filter((e) => e.kind === "start").length, 1, "three turns, one process");
	assert.equal(log.find((e) => e.kind === "tool-result")!.result.content[0].text, "B", "the answer is the waiting call's result");
	assert.ok(log.some((e) => e.kind === "stdin" && JSON.stringify(e.content).includes("go on")));
	releaseClaudeCodeRun("cc-chat-5");
	assert.equal(liveClaudeCodeRuns(), 0);
});

test("a changed conversation (or a dead process) starts the next turn fresh", async () => {
	scenario([{ content: [{ type: "text", text: "one" }] }, { content: [{ type: "text", text: "two" }] }]);
	const one = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-6", tools: { echo: echoTool() } });
	await one.prompt(userText("hello"));
	const edited = [userText("hello, edited"), ...conversation(one.state.messages).slice(1), userText("next")];
	const two = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-6", tools: { echo: echoTool() }, messages: edited });
	await two.continue();
	await settle();
	assert.equal(fakeLog().filter((e) => e.kind === "start").length, 2, "the edit restarted it from the record");
	releaseClaudeCodeRun("cc-chat-6");
});

test("aborting mid-run ends the process", async () => {
	scenario([{ content: [{ type: "tool_use", id: "toolu_d1", name: "mcp__lh__echo", input: { x: 4 } }] }]);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const agent = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-4", tools: { echo: echoTool(gate) } });
	let toolRunning = false;
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") toolRunning = true;
	});
	const running = agent.prompt(userText("go"));
	for (let i = 0; i < 200 && !toolRunning; i++) await settle(20);
	assert.ok(toolRunning, "the abort lands while the tool runs");
	agent.abort();
	release();
	await running;
	assert.equal(liveClaudeCodeRuns(), 0);
	for (let i = 0; i < 100 && !fakeLog().some((e) => e.kind === "killed"); i++) await settle(30);
	assert.ok(fakeLog().some((e) => e.kind === "killed"), `the fake got SIGTERM: ${JSON.stringify(fakeLog().map((e) => [e.pid, e.kind]))}`);
});

test("a turn stopped while Claude Code is still starting leaves nothing running", async () => {
	scenario([{ content: [{ type: "text", text: "too late" }] }]);
	const agent = createTeacherAgent(undefined, { engine: engine(), chatId: "cc-chat-7", tools: { echo: echoTool() } });
	const running = agent.prompt(userText("go"));
	await settle(20); // the process is launching
	agent.abort();
	await running;
	for (let i = 0; i < 100 && fakeLog().some((e) => e.kind === "start") && !fakeLog().some((e) => e.kind === "killed"); i++) await settle(30);
	assert.equal(liveClaudeCodeRuns(), 0, "no run registered after the cancel");
	const log = fakeLog();
	if (log.some((e) => e.kind === "start")) assert.ok(log.some((e) => e.kind === "killed"), "the late-starting process was ended");
});

async function oneCall(background = false, thinkingLevel?: "off" | "low"): Promise<AssistantMessage> {
	const e = piEngineForSpec({ provider: CLAUDE_CODE_PROVIDER, id: "claude-haiku-5-5", ...(thinkingLevel ? { thinkingLevel } : {}) }, background);
	const stream = e.streamFn(e.model, normalizeContext({ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }), {});
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") return event.error;
	}
	throw new Error("no terminal event");
}

test("a single call (no session id) works and leaves nothing running; thinking off reaches Claude Code", async () => {
	scenario([{ content: [{ type: "text", text: "one shot" }] }]);
	const message = await oneCall(false, "off");
	assert.equal(message.stopReason, "stop");
	assert.equal((message.content[0] as { text: string }).text, "one shot");
	assert.equal(liveClaudeCodeRuns(), 0);
	assert.equal(fakeLog().find((e) => e.kind === "start")!.thinkingOff, true);
});

test("failures carry honest text: plan limit, API-key login, background off", async () => {
	scenario([{ failure: { kind: "rate_limit", text: "You've hit your limit · resets 5pm" } }]);
	const limited = await oneCall();
	assert.equal(limited.stopReason, "error");
	assert.match(limited.errorMessage ?? "", /^Your Claude plan's usage limit is reached \(You've hit your limit · resets 5pm\)\. No API-key fallback was used\.$/);

	scenario([{ content: [{ type: "text", text: "never" }] }], { apiKeySource: "ANTHROPIC_API_KEY" });
	const keyed = await oneCall();
	assert.match(keyed.errorMessage ?? "", /set to use an API key/);
	await settle(300); // the refused process's last log lines land first

	settingsStore.writeSettings({ version: 1, claudeCode: { allowBackgroundUse: false } });
	scenario([{ content: [{ type: "text", text: "never" }] }]);
	const background = await oneCall(true);
	assert.match(background.errorMessage ?? "", /^Background use is off for Claude Code/);
	assert.equal(fakeLog().filter((e) => e.kind === "start").length, 0, "nothing was launched");
	const foreground = await oneCall(false);
	assert.equal(foreground.stopReason, "stop", "the learner's own turns still run");
});

test("not signed in: refused before anything launches", async () => {
	setClaudeCodeStatusForTests({ installed: true, bin: FAKE_BIN, loggedIn: false, checkedAt: Date.now() + 1e9 });
	scenario([{ content: [{ type: "text", text: "never" }] }]);
	const message = await oneCall();
	assert.match(message.errorMessage ?? "", /isn't signed in/);
	assert.equal(fakeLog().filter((e) => e.kind === "start").length, 0);
});
