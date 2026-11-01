/** The empty-turn guard: a teaching question that arrives after thinking with
 *  nothing readable before it is sent back to be delivered through
 *  send_to_user. Closed-network synthetic fixtures only. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-unread-question-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { unreadQuestionReason, UNREAD_QUESTION_REASON } = await import("../src/agent/unread-question.ts");
const { createTeacherAgent, createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { SEND_TO_USER_TOOL, asAgentMessages, newUserMessage } = await import("../src/core/native-messages.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

const quiz = {
	type: "check", nodeId: "synthetic", question: "What is two plus two?",
	options: [{ label: "Four", value: "4" }, { label: "Five", value: "5" }],
	correctAnswer: "4", explanation: "Add two pairs.",
};
const sendCall = (message: string, id = "send-1") => ({ type: "toolCall" as const, id, name: SEND_TO_USER_TOOL, arguments: { message } });

function scripted(id: string, steps: FauxResponseStep[]) {
	const faux = createFauxCore({ provider: "anthropic", models: [{ id }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}

async function turn(agent: { prompt(m: unknown): Promise<void>; state: { messages: unknown[] } }) {
	await agent.prompt(newUserMessage("Explain it."));
	return agent.state.messages as { role: string; content: { type: string; name?: string; text?: string }[]; toolName?: string; isError?: boolean }[];
}

describe("unreadQuestionReason", () => {
	const ctx = (messages: unknown[], own: unknown, name = "quiz") => ({
		assistantMessage: own as never,
		toolCall: { type: "toolCall", id: "q", name, arguments: {} } as never,
		context: { messages } as never,
	});
	const a = (content: unknown[]) => fauxAssistantMessage(content as never);

	it("refuses a question that follows thinking alone", () => {
		const own = a([fauxThinking("drafted here"), fauxToolCall("quiz", quiz)]);
		assert.equal(unreadQuestionReason(ctx([own], own)), UNREAD_QUESTION_REASON);
		assert.equal(unreadQuestionReason(ctx([own], own, "ask_user_question")), UNREAD_QUESTION_REASON);
	});

	it("lets readable words through: text or send_to_user in the message, or earlier in the turn", () => {
		const withText = a([fauxThinking("t"), fauxText("Words."), fauxToolCall("quiz", quiz)]);
		const withChannel = a([fauxThinking("t"), sendCall("Words."), fauxToolCall("quiz", quiz)]);
		const first = a([fauxText("Earlier words."), fauxToolCall("read", { path: "x" })]);
		const second = a([fauxThinking("t"), fauxToolCall("quiz", quiz)]);
		const result = { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file" }] };
		assert.equal(unreadQuestionReason(ctx([withText], withText)), undefined);
		assert.equal(unreadQuestionReason(ctx([withChannel], withChannel)), undefined);
		assert.equal(unreadQuestionReason(ctx([first, result, second], second)), undefined);
		assert.equal(unreadQuestionReason(ctx([a([fauxText("   "), fauxThinking("t")]), second], second)), UNREAD_QUESTION_REASON, "blank text is not readable");
	});

	it("leaves alone what is not the symptom", () => {
		const noThinking = a([fauxToolCall("quiz", quiz)]);
		const other = a([fauxThinking("t"), fauxToolCall("read", { path: "x" })]);
		assert.equal(unreadQuestionReason(ctx([noThinking], noThinking)), undefined, "no thinking → nothing was converted");
		assert.equal(unreadQuestionReason(ctx([other], other, "read")), undefined, "not a question tool");
	});

	it("words from before the learner's last answer do not count, and a second miss goes through", () => {
		const earlier = a([fauxText("Words for the previous question."), fauxToolCall("quiz", quiz, { id: "q0" })]);
		const answered = { role: "toolResult", toolName: "quiz", isError: false, content: [{ type: "text", text: "{}" }] };
		const own = a([fauxThinking("t"), fauxToolCall("quiz", quiz)]);
		assert.equal(unreadQuestionReason(ctx([earlier, answered, own], own)), UNREAD_QUESTION_REASON);
		const refused = { role: "toolResult", toolName: "quiz", isError: true, content: [{ type: "text", text: UNREAD_QUESTION_REASON }] };
		const retry = a([fauxThinking("t"), fauxToolCall("quiz", quiz, { id: "q2" })]);
		assert.equal(unreadQuestionReason(ctx([earlier, answered, own, refused, retry], retry)), undefined);
	});
});

describe("the guard in a teaching turn", () => {
	it("sends an unreadable question back, then poses it once the words went through send_to_user", async () => {
		const { engine, faux } = scripted("claude-opus-5-5", [
			fauxAssistantMessage([fauxThinking("Drafted the whole lesson here."), fauxToolCall("quiz", quiz, { id: "quiz-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([sendCall("**The lesson.**"), fauxToolCall("quiz", quiz, { id: "quiz-2" })], { stopReason: "toolUse" }),
		]);
		const agent = createTeacherAgent(undefined, { engine, messages: asAgentMessages([]) });
		const messages = await turn(agent as never);
		assert.equal(faux.state.callCount, 2);
		const refused = messages.find((m) => m.role === "toolResult" && m.toolName === "quiz" && m.isError);
		assert.ok(refused, "the first question came back as an error");
		assert.ok(refused!.content[0]!.text!.includes("send_to_user"));
		const last = messages.filter((m) => m.role === "assistant").at(-1)!;
		assert.deepEqual(last.content.map((c) => c.name ?? c.type), [SEND_TO_USER_TOOL, "quiz"]);
	});

	it("does nothing for a question that already has words, or for the prober", async () => {
		const withText = scripted("claude-opus-5-5", [fauxAssistantMessage([fauxThinking("t"), fauxText("Words."), fauxToolCall("quiz", quiz, { id: "quiz-1" })], { stopReason: "toolUse" })]);
		await turn(createTeacherAgent(undefined, { engine: withText.engine, messages: asAgentMessages([]) }) as never);
		assert.equal(withText.faux.state.callCount, 1);
		const prober = scripted("claude-opus-5-5", [fauxAssistantMessage([fauxThinking("t"), fauxToolCall("ask_user_question", { question: "Q?", options: [{ label: "A" }, { label: "B" }] }, { id: "q-1" })], { stopReason: "toolUse" })]);
		const probe = createProberAgent({ chatId: chatStore.createChat("Synthetic probe").id, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { engine: prober.engine });
		await turn(probe as never);
		assert.equal(prober.faux.state.callCount, 1, "the prober is not guarded");
	});

	it("is not installed where send_to_user does not exist", async () => {
		const { engine, faux } = scripted("gpt-4o-mini", [fauxAssistantMessage([fauxThinking("t"), fauxToolCall("quiz", quiz, { id: "quiz-1" })], { stopReason: "toolUse" })]);
		await turn(createTeacherAgent(undefined, { engine, messages: asAgentMessages([]) }) as never);
		assert.equal(faux.state.callCount, 1);
	});
});
