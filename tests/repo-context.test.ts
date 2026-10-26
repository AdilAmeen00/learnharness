/**
 * OPEN REPO: a teach session can carry a code repository the learner
 * picked — as a repo-context marker, a pointer (path + name) the agent
 * follows with its read-only file tools, never file contents. The marker
 * rides the session's creation (POST /api/chats `repo`, after any
 * graph-context marker) or the next text input mid-session (just before
 * the learner's message).
 *
 * Pins: the pure marker (model text, UI details, wire + view faces), the
 * text input's `repo` (parse + appends order), path resolution and the
 * recent list (src/server/repos.ts), and the two routes — under an
 * isolated LH_DATA_DIR and a temp HOME (`~` resolution).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seams, BEFORE any config-loading import ─────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-repo-context-"));
process.env.LH_DATA_DIR = TMP_DATA;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lh-repo-home-"));
process.env.HOME = TMP_HOME;
const REPO = path.join(TMP_HOME, "Code", "demo-repo");
fs.mkdirSync(REPO, { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, "notes.txt"), "not a folder");

const { newRepoContextMessage, nativeInputCause, toLlmMessages } = await import("../src/core/native-messages.ts");
import type { LhMessage } from "../src/core/native-messages.ts";
const { projectView } = await import("../src/core/view.ts");
const { inputAppends, parseChatInput, ChatInputError } = await import("../src/core/input-events.ts");
const { resolveRepo, rememberRepo, listRecentRepos, RepoPathError, RECENT_REPOS_MAX } = await import("../src/server/repos.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const reposRoute = await import("../app/api/repos/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const DEMO = { path: REPO, name: "demo-repo" };

const post = (url: string, body: unknown) =>
	new Request(`http://test${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

// ── the pure marker ─────────────────────────────────────────────────────────

describe("newRepoContextMessage", () => {
	it("points the model at the repo and its tools; details carry the ref", () => {
		const m = newRepoContextMessage(DEMO);
		assert.equal(m.customType, "repo-context");
		assert.match(m.content, /^\[Session context\] — the learner attached a code repository to study: demo-repo at /);
		assert.ok(m.content.includes(REPO));
		assert.match(m.content, /ls, find, grep, and read/);
		assert.deepEqual(m.details, DEMO);
	});

	it("toLlmMessages flattens it to a user message (the model's face)", () => {
		const wire = toLlmMessages([newRepoContextMessage(DEMO) as unknown as LhMessage] as never);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.ok(String((wire[0]!.content as { text?: string }[])[0]!.text).includes(REPO));
	});

	it("projectView: a user-side data part — never a text bubble", () => {
		const m = newRepoContextMessage(DEMO);
		const view = projectView([m as unknown as LhMessage] as never);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const part = view[0]!.parts[0] as { type: string; data: unknown };
		assert.equal(part.type, "data-repo-context");
		assert.deepEqual(part.data, DEMO);
	});

	it("is neutral scaffolding, not learner input", () => {
		assert.equal(nativeInputCause(newRepoContextMessage(DEMO) as never, []), "neutral");
	});
});

// ── the text input's repo ───────────────────────────────────────────────────

describe("text input — repo", () => {
	it("parses a repo ref; absent stays lean", () => {
		assert.deepEqual(parseChatInput({ type: "text", text: "hi", repo: DEMO }), { type: "text", text: "hi", repo: DEMO });
		assert.deepEqual(parseChatInput({ type: "text", text: "hi" }), { type: "text", text: "hi" });
	});

	it("a repo without a path is a 400-class error", () => {
		for (const repo of [null, "x", {}, { path: "" }, { path: 3 }]) {
			assert.throws(() => parseChatInput({ type: "text", text: "hi", repo }), ChatInputError);
		}
	});

	it("appends the marker just before the learner's message", () => {
		const appends = inputAppends({ messages: [] }, { type: "text", text: "how does routing work?", repo: DEMO });
		assert.equal(appends.length, 2);
		assert.equal((appends[0] as { customType?: string }).customType, "repo-context");
		assert.equal(appends[1]!.role, "user");
		assert.equal(inputAppends({ messages: [] }, { type: "text", text: "plain" }).length, 1);
	});
});

// ── resolution + the recent list ────────────────────────────────────────────

describe("resolveRepo", () => {
	it("anchors ~ and relative paths at HOME; absolute stays; trailing slash trims", () => {
		assert.deepEqual(resolveRepo("~/Code/demo-repo"), DEMO);
		assert.deepEqual(resolveRepo("Code/demo-repo"), DEMO);
		assert.deepEqual(resolveRepo(`${REPO}/`), DEMO);
		assert.deepEqual(resolveRepo(`  ${REPO}  `), DEMO);
	});

	it("refuses empty, missing, and non-folder paths", () => {
		assert.throws(() => resolveRepo("  "), RepoPathError);
		assert.throws(() => resolveRepo("~/Code/nope"), /No folder at/);
		assert.throws(() => resolveRepo("~/notes.txt"), /Not a folder/);
	});
});

describe("recent repos", () => {
	it("newest first, deduped, capped; folders gone since are skipped", () => {
		const extra = Array.from({ length: RECENT_REPOS_MAX + 1 }, (_, i) => {
			const p = path.join(TMP_HOME, "r", `repo-${i}`);
			fs.mkdirSync(p, { recursive: true });
			return resolveRepo(p);
		});
		for (const r of extra) rememberRepo(r);
		rememberRepo(DEMO);
		rememberRepo(extra.at(-1)!); // again — moves to the front, no duplicate
		let recent = listRecentRepos();
		assert.equal(recent.length, RECENT_REPOS_MAX);
		assert.equal(recent[0]!.path, extra.at(-1)!.path);
		assert.equal(recent[1]!.path, REPO);
		assert.equal(new Set(recent.map((r) => r.path)).size, recent.length);

		fs.rmSync(extra.at(-2)!.path, { recursive: true });
		recent = listRecentRepos();
		assert.ok(!recent.some((r) => r.path === extra.at(-2)!.path));
	});
});

// ── the routes ──────────────────────────────────────────────────────────────

describe("/api/repos", () => {
	it("POST resolves and remembers; GET lists it first", async () => {
		const res = await reposRoute.POST(post("/api/repos", { path: "~/Code/demo-repo" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { repo: DEMO });
		const list = (await (await reposRoute.GET()).json()) as { recent: { path: string }[] };
		assert.equal(list.recent[0]!.path, REPO);
	});

	it("POST refuses a bad path with the reason", async () => {
		const res = await reposRoute.POST(post("/api/repos", { path: "~/Code/nope" }));
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /No folder at/);
		assert.equal((await reposRoute.POST(post("/api/repos", {}))).status, 400);
	});
});

describe("POST /api/chats — repo rides the creation", () => {
	it("writes the repo marker as message[0]", async () => {
		const res = await chatsRoute.POST(post("/api/chats", { title: "teach me this codebase", repo: "~/Code/demo-repo" }));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(messages.length, 1);
		const m = messages[0] as { customType: string; details: unknown };
		assert.equal(m.customType, "repo-context");
		assert.deepEqual(m.details, DEMO);
	});

	it("follows a graph-context marker when both ride the creation", async () => {
		const res = await chatsRoute.POST(post("/api/chats", {
			title: "t",
			graphContext: { propositions: [{ id: "n_1", name: "A", statement: "S." }] },
			repo: REPO,
		}));
		const { id } = (await res.json()) as { id: string };
		const types = chatStore.getChat(id)!.messages.map((m) => (m as { customType?: string }).customType);
		assert.deepEqual(types, ["graph-context", "repo-context"]);
	});

	it("a bad repo refuses BEFORE the record exists — no orphan chat", async () => {
		const before = chatStore.listChats().length;
		const res = await chatsRoute.POST(post("/api/chats", { title: "t", repo: "~/Code/nope" }));
		assert.equal(res.status, 400);
		assert.equal(chatStore.listChats().length, before);
	});
});

describe("POST /api/chat — a mid-session repo the server can't resolve", () => {
	it("400s before any append", async () => {
		const chat = chatStore.createChat("t");
		const res = await handleChatRequest(post("/api/chat", {
			chatId: chat.id,
			input: { type: "text", text: "now this repo", repo: { path: "~/Code/nope", name: "nope" } },
		}));
		assert.equal(res.status, 400);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 0);
	});
});
