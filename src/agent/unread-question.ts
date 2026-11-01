import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL } from "../core/native-messages.ts";

/**
 * The empty-turn guard (owner, 2026-11-01). Claude's ordinary reply text can
 * be turned into a short "thinking" summary by the provider before it ever
 * reaches the app — the learner then sees a question with nothing before it
 * (the explanation went where they cannot read it). `send_to_user` is the
 * channel that always arrives; when a question is posed after thinking and
 * no readable text came first in the turn, the call is refused and the
 * model sends its words through the channel, then asks again.
 */

export const UNREAD_QUESTION_REASON =
	"Nothing readable reached the learner before this question: what you wrote went where they cannot see it (ordinary reply text can be turned into thinking). Send the complete explanation with send_to_user now, then ask the question again.";

/** One refusal per turn: a second miss goes through rather than looping. */
const REFUSALS_PER_TURN = 1;

interface Block {
	type?: string;
	text?: string;
	name?: string;
}

interface Message {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

const questionTools: readonly string[] = QUESTION_TOOLS;

function blocks(message: Message): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** Words the learner can read: a non-blank text block, or a send_to_user call. */
function readable(message: Message): boolean {
	return blocks(message).some((b) => (b.type === "text" && !!b.text?.trim()) || (b.type === "toolCall" && b.name === SEND_TO_USER_TOOL));
}

function refusedBefore(message: Message): boolean {
	return message.role === "toolResult" && message.isError === true && blocks(message).some((b) => b.type === "text" && !!b.text?.includes(UNREAD_QUESTION_REASON));
}

/**
 * The refusal text when this call is a question that would reach the learner
 * with nothing to read before it, else undefined. Only the symptom is
 * matched — the message holds thinking and no text — so a turn that never
 * thought (effort off, nothing was converted) is left alone.
 */
export function unreadQuestionReason({ assistantMessage, toolCall, context }: Pick<BeforeToolCallContext, "assistantMessage" | "toolCall" | "context">): string | undefined {
	if (!questionTools.includes(toolCall.name)) return undefined;
	const own = assistantMessage as Message;
	if (!blocks(own).some((b) => b.type === "thinking")) return undefined;
	if (readable(own)) return undefined;
	// Earlier in this turn — back to the learner's last input (a user message
	// or an answered question): text before a tool round counts too.
	let refusals = 0;
	const messages = context.messages as Message[];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message === own) continue;
		if (message.role === "user") break;
		if (message.role === "toolResult") {
			if (refusedBefore(message)) refusals++;
			else if (message.toolName && questionTools.includes(message.toolName) && !message.isError) break;
			continue;
		}
		if (message.role === "assistant" && readable(message)) return undefined;
	}
	return refusals >= REFUSALS_PER_TURN ? undefined : UNREAD_QUESTION_REASON;
}
