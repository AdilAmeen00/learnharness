/**
 * The reading surfaces (bold-contrast round, owner ruling 2026-10-26):
 * agent-authored text the learner READS carries .lh-reading — the softer
 * body grey over which the white bold scans — on its CONTAINER; muted
 * surfaces (context lines, option subtext, verdicts, "Why") keep their
 * own grey; the question text drops the old font-medium that swallowed
 * the bold phrases inside it. SSR pins, the render-suite discipline.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard, ProblemCard } from "../components/practice-cards.tsx";
import { ResearchBriefCard } from "../components/artifacts/job-card.tsx";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import type { ArtifactPartProps } from "../src/core";

const quizInput = {
	question: "You **double the thickness** — what happens to the deflection?",
	options: [{ label: "It halves" }, { label: "It becomes an eighth" }, { label: "It is unchanged" }],
	correctAnswer: "It becomes an eighth",
	explanation: "Bending stiffness goes as $t^3$.",
};

function quizQD(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

/** The nearest INK-CARRYING wrapper before `inner`: the last opening
 *  div/span/button whose class names a color/weight register — the
 *  markdown root and its <p> carry none, so this skips past them to the
 *  surface that decides the paint. */
const INK = /lh-reading|text-muted-foreground|text-foreground\/50|font-medium/;
function wrapperTagBefore(html: string, inner: string): string {
	const at = html.indexOf(inner);
	assert.ok(at >= 0, `renders: ${inner}`);
	const tags = [...html.slice(0, at).matchAll(/<(?:div|span|button)\b[^>]*>/g)];
	const inked = tags.filter((m) => INK.test(m[0]));
	assert.ok(inked.length > 0, `an ink wrapper precedes: ${inner}`);
	return inked[inked.length - 1]![0];
}

describe("the question dock — question text and options read at the body grey", () => {
	const html = renderToStaticMarkup(
		<QuestionDock toolName="probe" toolCallId="q1" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}} />,
	);

	it("the question text is regular weight on a .lh-reading wrapper (no font-medium)", () => {
		const tag = wrapperTagBefore(html, "double the thickness");
		assert.ok(tag.includes("lh-reading"), tag);
		assert.ok(!tag.includes("font-medium"), `the old medium weight is gone: ${tag}`);
	});

	it("the bold phrase inside the question renders as a real <strong> (the white ink's anchor)", () => {
		assert.ok(html.includes("<strong"), "bold renders");
		assert.ok(html.includes("double the thickness</strong>"));
	});

	it("every option label sits on a .lh-reading span", () => {
		for (const opt of quizInput.options) {
			const tag = wrapperTagBefore(html, opt.label);
			assert.ok(tag.includes("lh-reading"), `${opt.label}: ${tag}`);
		}
	});

	it("the 'I don't know' row stays muted — it is the deliberate non-answer, not reading", () => {
		const tag = wrapperTagBefore(html, "t know");
		assert.ok(!tag.includes("lh-reading"), tag);
	});
});

describe("the answered card — the same paint as the pending dock", () => {
	const answer = buildAnswer(quizQD(), { values: ["It halves"] });
	const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);

	it("the question text is regular weight on a .lh-reading wrapper", () => {
		const tag = wrapperTagBefore(html, "double the thickness");
		assert.ok(tag.includes("lh-reading"), tag);
		assert.ok(!tag.includes("font-medium"), tag);
	});

	it("the picked option reads at the body grey; the unpicked ones stay muted", () => {
		const picked = wrapperTagBefore(html, "It halves");
		assert.ok(picked.includes("lh-reading") && !picked.includes("text-muted-foreground"), picked);
		const other = wrapperTagBefore(html, "It is unchanged");
		assert.ok(other.includes("text-muted-foreground") && !other.includes("lh-reading"), other);
	});
});

describe("the practice surfaces", () => {
	it("the dock's statement and the transcript problem card carry .lh-reading", () => {
		const dock = renderToStaticMarkup(
			<PracticeDock problemCallId="call_p1" input={{ statement: "Show that the sum is even." }} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(wrapperTagBefore(dock, "Show that the sum").includes("lh-reading"));
		const part: ArtifactPartProps["part"] = {
			type: "tool-problem",
			state: "input-available",
			toolCallId: "call_p1",
			input: { statement: "Show that the sum is even." },
		};
		const card = renderToStaticMarkup(<ProblemCard part={part} />);
		assert.ok(wrapperTagBefore(card, "Show that the sum").includes("lh-reading"));
	});

	it("the conclude card: the model solution reads at the body grey, the verdict stays at its quiet 50%", () => {
		const part: ArtifactPartProps["part"] = {
			type: "tool-conclude",
			state: "output-available",
			toolCallId: "call_c1",
			input: { outcome: "solved", verdict: "Right move, right order." },
			// the view-seam join: the pose's committed modelSolution rides as part.reveal
			reveal: "The sum of two odds is even.",
		};
		const html = renderToStaticMarkup(<ConcludeCard part={part} />);
		assert.ok(wrapperTagBefore(html, "The sum of two odds").includes("lh-reading"));
		const verdict = wrapperTagBefore(html, "Right move");
		assert.ok(!verdict.includes("lh-reading") && verdict.includes("text-foreground/50"), verdict);
	});
});

describe("briefs and messages", () => {
	it("the research brief's body carries .lh-reading", () => {
		const html = renderToStaticMarkup(<ResearchBriefCard output={{ brief: "The **key** finding.", sources: [] }} />);
		assert.ok(wrapperTagBefore(html, "The <strong").includes("lh-reading"));
	});

	it("the assistant's message text wrapper carries .lh-reading (chat.tsx, pinned at the source)", () => {
		const src = fs.readFileSync("components/chat.tsx", "utf-8");
		assert.ok(src.includes('className="lh-source-passage lh-reading"'), "the text-part wrapper");
	});
});
