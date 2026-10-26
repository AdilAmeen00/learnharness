import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RepoContextCard, RepoPickerControl, resolveRepoPath } from "../components/repo-picker.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";

/**
 * Open repo's visible surface: the composer pill (empty → "Open repo";
 * picked → the repo's name + Clear), the transcript card, and the draft's
 * create call carrying the picked path (teach only).
 */

const DEMO = { path: "/home/me/Code/demo-repo", name: "demo-repo" };
const noop = () => {};

describe("RepoPickerControl", () => {
	it("empty: the dashed Open repo pill, no Clear", () => {
		const html = renderToStaticMarkup(<RepoPickerControl repo={null} onPick={noop} onClear={noop} />);
		assert.ok(html.includes('data-testid="repo-picker"'));
		assert.match(html, /Open repo/);
		assert.ok(!html.includes("repo-picker-clear"));
	});

	it("picked: the repo's name + Clear; the full path rides the title", () => {
		const html = renderToStaticMarkup(<RepoPickerControl repo={DEMO} onPick={noop} onClear={noop} />);
		assert.match(html, />demo-repo</);
		assert.ok(html.includes('data-testid="repo-picker-clear"'));
		assert.ok(html.includes(`title="${DEMO.path}"`));
	});

	it("a refused send's error shows beside the pill", () => {
		const html = renderToStaticMarkup(<RepoPickerControl repo={DEMO} onPick={noop} onClear={noop} error="No folder at /x" />);
		assert.match(html, /No folder at \/x/);
	});
});

describe("RepoContextCard", () => {
	it("one quiet line: name + path", () => {
		const html = renderToStaticMarkup(<RepoContextCard data={DEMO} />);
		assert.ok(html.includes('data-testid="repo-context-card"'));
		assert.match(html, /demo-repo/);
		assert.ok(html.includes(DEMO.path));
	});
});

describe("resolveRepoPath", () => {
	it("returns the server's resolved ref", async () => {
		const f = (async () => new Response(JSON.stringify({ repo: DEMO }), { status: 200 })) as unknown as typeof fetch;
		assert.deepEqual(await resolveRepoPath("~/Code/demo-repo", f), DEMO);
	});

	it("throws the server's reason on refusal", async () => {
		const f = (async () => new Response(JSON.stringify({ error: "No folder at /x" }), { status: 400 })) as unknown as typeof fetch;
		await assert.rejects(resolveRepoPath("/x", f), /No folder at \/x/);
	});
});

describe("the draft — Open repo", () => {
	it("teach drafts show the pill; practice drafts don't", () => {
		const teach = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={noop} onSend={noop} mode="teach" onPickRepo={noop} onClearRepo={noop} />,
		);
		assert.ok(teach.includes('data-testid="repo-picker"'));
		const practice = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={noop} onSend={noop} mode="practice" onPickRepo={noop} onClearRepo={noop} />,
		);
		assert.ok(!practice.includes('data-testid="repo-picker"'));
	});

	it("startDraftSession carries the picked path on a teach create", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c1" }), { status: 200 });
		}) as unknown as typeof fetch;
		await startDraftSession("teach me this codebase", f, undefined, undefined, DEMO);
		assert.deepEqual(body, { title: "teach me this codebase", repo: DEMO.path });
	});

	it("a refused create throws the server's reason (the draft keeps its text)", async () => {
		const f = (async () => new Response(JSON.stringify({ error: "No folder at /x" }), { status: 400 })) as unknown as typeof fetch;
		await assert.rejects(startDraftSession("t", f, undefined, undefined, DEMO), /No folder at \/x/);
	});
});
