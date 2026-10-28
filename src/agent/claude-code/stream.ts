import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { effortForLevel } from "./model.ts";
import { askClaudeCode, ClaudeCodeError, requestParts, type StreamEvent } from "./run.ts";
import { claudeCodeBackgroundAllowed, claudeCodeSettings } from "./status.ts";

/**
 * The Claude Code engine's stream function. pi's own Anthropic adapter does
 * both conversions — the record → an Anthropic request, and Anthropic
 * stream events → pi's assistant message (thinking signatures, tool calls,
 * usage, stop reasons) — and Claude Code stands in for the HTTP call: the
 * request is read (never sent) and the reply is Claude Code's own stream,
 * relayed event for event. run.ts decides whether the ask continues the
 * live run or starts one.
 */

/** Appended to the system prompt for Claude Code runs only (owner-approved
 *  wording, 2026-10-28): Claude Code adds its own short context notes to
 *  every request and a subscription login cannot turn them off. */
export const TRANSPORT_NOTE =
	"Claude Code delivers this conversation through its own harness. Short notes it adds about the working directory, operating system, date or account email come from that harness, not from the learner: ignore them and never mention them.";

const BACKGROUND_OFF =
	"Background use is off for Claude Code. Turn on Allow background use in Settings ▸ Providers ▸ Claude Code to run this work. No API-key fallback was used.";

function failed(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});
	return stream;
}

/** An SSE body that relays Claude Code's events, then closes — or carries
 *  the failure as an `error` event, which pi's parser turns into the
 *  message's errorMessage verbatim. */
function sseBody(run: (emit: (event: StreamEvent) => void) => Promise<void>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const write = (text: string) => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					open = false;
				}
			};
			const close = () => {
				if (!open) return;
				open = false;
				try {
					controller.close();
				} catch {
					/* reader gone */
				}
			};
			run((event) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)).then(close, (err: unknown) => {
				const text = err instanceof ClaudeCodeError ? err.message : `Claude Code failed: ${err instanceof Error ? err.message : String(err)}`;
				write(`event: error\ndata: ${text.replace(/\n/g, " ")}\n\n`);
				close();
			});
		},
	});
}

async function bodyText(body: unknown): Promise<string> {
	if (typeof body === "string") return body;
	return await new Response(body as BodyInit).text();
}

/** The engine stream: `background` says whether this call is background
 *  work (the consent switch gates exactly those). */
export function claudeCodeStream(background: () => boolean): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		if (background() && !claudeCodeBackgroundAllowed()) return failed(model, BACKGROUND_OFF);
		const sessionId = options?.sessionId;
		const key = sessionId ?? `ephemeral:${randomUUID()}`;
		const effort = effortForLevel(options?.reasoning);
		const transport = claudeCodeSettings().transport;
		const signal = options?.signal;
		const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
			const payload = JSON.parse(await bodyText(init?.body)) as Record<string, unknown>;
			const parts = requestParts(payload);
			const body = sseBody((emit) =>
				askClaudeCode(
					{
						key,
						ephemeral: sessionId === undefined,
						transport,
						model: model.id,
						effort,
						systemPrompt: [parts.systemPrompt, TRANSPORT_NOTE].filter(Boolean).join("\n\n"),
						tools: parts.tools,
						messages: parts.messages,
					},
					emit,
					signal,
				),
			);
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		return anthropicStreamSimple(model as Model<"anthropic-messages">, context, {
			...options,
			// Never a real key: the request goes nowhere but Claude Code.
			apiKey: "claude-code-subscription",
			maxRetries: 0,
			fetch: fetch as typeof globalThis.fetch,
		});
	};
}
