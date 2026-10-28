import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The app's tools as an MCP server, one per Claude Code run. Nothing here
 * runs a tool: a call waits on the run (run.ts), which hands it to the
 * app's own agent loop and answers with that loop's result — so every tool
 * keeps its argument repair, validation and live events.
 *
 * Two transports over one JSON-RPC handler:
 *   - Agent SDK: in process (the SDK connects any object with
 *     connect(transport); exact JSON Schemas, no network port);
 *   - `claude -p`: a loopback HTTP endpoint (127.0.0.1, random port, one
 *     unguessable path per run). Tool calls answer as an SSE stream so a
 *     long tool never trips a client's header timeout.
 */

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface McpCallResult {
	content: McpContent[];
	isError?: boolean;
}

export interface McpToolHost {
	tools(): McpToolDef[];
	/** `toolUseId` is Claude Code's tool_use id (`_meta["claudecode/toolUseId"]`). */
	call(name: string, args: unknown, toolUseId: string | undefined): Promise<McpCallResult>;
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string };
}

const PROTOCOL_FALLBACK = "2025-06-18";

/** One JSON-RPC message → its response (null for a notification). */
export async function handleMcpMessage(host: McpToolHost, msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
	if (msg.id === undefined || msg.id === null) return null;
	const id = msg.id;
	const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
	const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
	switch (msg.method) {
		case "initialize":
			return ok({
				protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_FALLBACK,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "learnharness", version: "1" },
			});
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: host.tools() });
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string") return fail(-32602, "tools/call needs a tool name");
			const meta = msg.params?._meta as Record<string, unknown> | undefined;
			const toolUseId = typeof meta?.["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : undefined;
			try {
				return ok(await host.call(name, msg.params?.arguments ?? {}, toolUseId));
			} catch (err) {
				return ok({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
			}
		}
		default:
			return fail(-32601, `Method not found: ${msg.method}`);
	}
}

// ─── in process (Agent SDK) ─────────────────────────────────────────────────

interface SdkTransport {
	onmessage?: (message: JsonRpcMessage) => void;
	send(message: JsonRpcResponse): Promise<void> | void;
	start?(): Promise<void>;
}

/** The SDK's `instance`: it calls connect() with its in-process transport. */
export function inProcessMcpServer(host: McpToolHost): { connect(transport: SdkTransport): Promise<void> } {
	return {
		async connect(transport) {
			transport.onmessage = (message) => {
				// Calls answer independently — a waiting tool never blocks a ping.
				// A call answered after its run ended (the run's end answers every
				// waiting call) meets a closed transport: nobody is listening, and
				// the throw must not escape — unhandled, it would take the server down.
				void handleMcpMessage(host, message)
					.then((response) => (response ? transport.send(response) : undefined))
					.catch(() => {});
			};
			await transport.start?.();
		},
	};
}

// ─── loopback HTTP (`claude -p`) ────────────────────────────────────────────

interface HttpState {
	server?: Server;
	port?: Promise<number>;
	hosts: Map<string, McpToolHost>;
}

const KEY = Symbol.for("lh.claude-code.mcp-http");
function httpState(): HttpState {
	const g = globalThis as typeof globalThis & { [KEY]?: HttpState };
	return (g[KEY] ??= { hosts: new Map() });
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const match = /^\/mcp\/([a-f0-9]{48})$/.exec(req.url ?? "");
	const host = match ? httpState().hosts.get(match[1]!) : undefined;
	if (!host) {
		res.writeHead(404).end();
		return;
	}
	if (req.method === "DELETE") {
		res.writeHead(200).end();
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405, { Allow: "POST, DELETE" }).end();
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readBody(req));
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
		return;
	}
	const batch = Array.isArray(parsed);
	const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[];
	const requests = messages.filter((m) => m.id !== undefined && m.id !== null);
	if (requests.length === 0) {
		res.writeHead(202).end();
		return;
	}
	if (!requests.some((m) => m.method === "tools/call")) {
		const responses = (await Promise.all(requests.map((m) => handleMcpMessage(host, m)))).filter(Boolean);
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(batch ? responses : responses[0]));
		return;
	}
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	keepAlive.unref();
	try {
		await Promise.all(
			requests.map(async (m) => {
				const response = await handleMcpMessage(host, m);
				if (response) res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
			}),
		);
	} finally {
		clearInterval(keepAlive);
		res.end();
	}
}

function ensureServer(): Promise<number> {
	const s = httpState();
	if (s.port) return s.port;
	s.port = new Promise<number>((resolve, reject) => {
		const server = createServer((req, res) => {
			serve(req, res).catch(() => {
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
		});
		server.on("error", (err) => {
			s.port = undefined;
			reject(err);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("MCP endpoint has no port"));
		});
		// The endpoint never holds the process open on its own.
		server.unref();
		s.server = server;
	});
	return s.port;
}

/** Serve one host over loopback HTTP until close(). */
export async function mcpHttpEndpoint(host: McpToolHost): Promise<{ url: string; close(): void }> {
	const port = await ensureServer();
	const token = randomBytes(24).toString("hex");
	httpState().hosts.set(token, host);
	return {
		url: `http://127.0.0.1:${port}/mcp/${token}`,
		close: () => {
			httpState().hosts.delete(token);
		},
	};
}
