#!/usr/bin/env node
// A scripted stand-in for `claude -p --input-format stream-json
// --output-format stream-json` (tests/claude-code.test.ts): it reads the
// resumed session file, speaks the app's MCP endpoint for tool calls, and
// streams replies from a scenario file — so the Claude Code engine runs end
// to end without touching anyone's subscription.
//
// LH_FAKE_CLAUDE_SCENARIO: JSON { replies: [{ content: [...] }], apiKeySource?, failure? }
//   replies are consumed in order across processes (a .next counter file).
// LH_FAKE_CLAUDE_LOG: JSON lines of what the fake saw.
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const scenarioFile = process.env.LH_FAKE_CLAUDE_SCENARIO;
const logFile = process.env.LH_FAKE_CLAUDE_LOG;
const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));
const log = (entry) => logFile && appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const resume = arg("--resume");
const mcpConfig = JSON.parse(readFileSync(arg("--mcp-config"), "utf8"));
const mcpUrl = mcpConfig.mcpServers.lh.url;
const systemPrompt = readFileSync(arg("--system-prompt-file"), "utf8");
const configDir = process.env.CLAUDE_CONFIG_DIR;
let history = [];
if (resume) {
	const projectDir = path.join(configDir, "projects", realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"));
	const file = path.join(projectDir, `${resume}.jsonl`);
	history = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : null;
}
log({
	kind: "start",
	args,
	model: arg("--model"),
	effort: arg("--effort") ?? null,
	resume: resume ?? null,
	interrupted: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === "1",
	thinkingOff: process.env.MAX_THINKING_TOKENS === "0",
	anthropicKey: Object.keys(process.env).some((k) => k.startsWith("ANTHROPIC_")),
	systemPrompt,
	history: history && history.map((e) => ({ type: e.type, content: e.message.content })),
});

const counterFile = `${scenarioFile}.next`;
function nextReply() {
	const index = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
	writeFileSync(counterFile, String(index + 1));
	return scenario.replies[index];
}

let rpcId = 0;
async function rpc(method, params) {
	const res = await fetch(mcpUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	const text = await res.text();
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		return JSON.parse(data.slice(6)).result;
	}
	return JSON.parse(text).result;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
const listed = await rpc("tools/list", {});
log({ kind: "tools", names: listed.tools.map((t) => t.name) });

const sessionId = "fake-session";
out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: scenario.apiKeySource ?? "none", tools: listed.tools.map((t) => `mcp__lh__${t.name}`) });

let waitingTools = false;
let busy = false;
const queued = [];
let inputDone = false;

function streamReply(reply, n) {
	const id = `msg_fake_${n}`;
	out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1793167800 }, seven_day: { utilization: 0.5, resetsAt: 1793253600 } } } });
	const ev = (event) => out({ type: "stream_event", parent_tool_use_id: null, session_id: sessionId, uuid: `u${Math.random()}`, event });
	ev({ type: "message_start", message: { id, type: "message", role: "assistant", model: arg("--model"), content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } });
	reply.content.forEach((block, index) => {
		if (block.type === "text") {
			ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else if (block.type === "tool_use") {
			ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {}, caller: { type: "direct" } } });
			ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		ev({ type: "content_block_stop", index });
	});
	const stop = reply.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
	ev({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } });
	ev({ type: "message_stop" });
	out({ type: "assistant", parent_tool_use_id: null, session_id: sessionId, message: { id, role: "assistant", content: reply.content } });
	return stop;
}

let replies = 0;
async function runTurn(input) {
	busy = true;
	if (input) log({ kind: "turn-input", content: input });
	for (;;) {
		const reply = nextReply();
		if (!reply) {
			out({ type: "result", subtype: "error_during_execution", is_error: true, result: "fake: no scripted reply left" });
			break;
		}
		if (reply.failure) {
			out({ type: "assistant", parent_tool_use_id: null, session_id: sessionId, error: reply.failure.kind, message: { role: "assistant", content: [{ type: "text", text: reply.failure.text }] } });
			out({ type: "result", subtype: "success", is_error: true, result: reply.failure.text });
			break;
		}
		const stop = streamReply(reply, ++replies);
		if (stop !== "tool_use") {
			out({ type: "result", subtype: "success", is_error: false, result: "ok" });
			break;
		}
		waitingTools = true;
		for (const block of reply.content.filter((b) => b.type === "tool_use")) {
			const result = await rpc("tools/call", { name: block.name.replace(/^mcp__lh__/, ""), arguments: block.input, _meta: { "claudecode/toolUseId": block.id } });
			log({ kind: "tool-result", id: block.id, result, queuedBefore: queued.length });
			out({ type: "user", parent_tool_use_id: null, session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError ?? false }] } });
		}
		waitingTools = false;
		// Fold messages queued during the tools in at this boundary.
		while (queued.length) log({ kind: "folded", content: queued.shift() });
	}
	busy = false;
	if (queued.length) {
		const next = queued.shift();
		return runTurn(next);
	}
	if (inputDone) process.exit(0);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	log({ kind: "stdin", content: message.message.content, duringTools: waitingTools });
	if (busy) queued.push(message.message.content);
	else void runTurn(message.message.content);
}).on("close", () => {
	inputDone = true;
	if (!busy) process.exit(0);
});

if (resume && process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === "1") void runTurn(null);
process.on("SIGTERM", () => {
	log({ kind: "killed" });
	process.exit(0);
});
