/**
 * The vim reading caret — pure motion rules over fake geometry (owner,
 * 2026-10-27). Each test lays text out on a 10px-per-character grid, 24px
 * per displayed line; the DOM seam (real rects) is browser-verified.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	caretCommandForKey,
	caretNavigator,
	CARET_MAX_MOVES_PER_TICK,
	DEFAULT_CARET_DELAY_MS,
	DEFAULT_CARET_SPEED,
	sameCaretLine,
	sanitizeCaretPrefs,
	snapCaretSpeed,
	startRepeatClock,
	stepCaretSpeed,
	tickRepeatClock,
	type CaretMotion,
	type CaretPosition,
	type CaretRect,
	type CaretUnit,
} from "../src/core/reading-caret.ts";

/** Runs of displayed lines. "§" = a formula atom, "¬" = a space with no
 *  box (collapsed at a wrap), "|" in a run's line list = same block as the
 *  previous run (a table row's next cell). */
function layout(runs: string[][], blocks?: number[]) {
	const units: CaretUnit[] = [];
	const rects: (CaretRect | null)[] = [];
	let y = 0;
	runs.forEach((lines, run) => {
		for (const line of lines) {
			[...line].forEach((ch, x) => {
				units.push({ ch: ch === "§" ? "￼" : ch === "¬" ? " " : ch, run, block: blocks?.[run] ?? run, atom: ch === "§" });
				rects.push(ch === "¬" ? null : { top: y, bottom: y + 20, left: x * 10, right: x * 10 + 10 });
			});
			y += 24;
		}
	});
	const nav = caretNavigator(units, (i) => rects[i] ?? null);
	const text = (i: number) => units[i]!.ch;
	/** Index of the n-th occurrence of ch (0-based). */
	const find = (ch: string, nth = 0) => {
		let seen = -1;
		return units.findIndex((u) => u.ch === ch && ++seen === nth);
	};
	const at = (index: number): CaretPosition => ({ index, goalX: rects[index]!.left });
	const run = (start: number, ...motions: CaretMotion[]) => {
		let pos = at(start);
		for (const m of motions) pos = nav.move(pos, m);
		return pos;
	};
	return { units, nav, text, find, at, run };
}

describe("h / l — one character, within the displayed line (vim: no wrap)", () => {
	it("moves one character each way and stops at the line ends", () => {
		const d = layout([["abc", "def"]]);
		assert.equal(d.text(d.run(0, "l").index), "b");
		assert.equal(d.text(d.run(0, "l", "l", "l").index), "c", "l stops at the line end");
		assert.equal(d.text(d.run(d.find("d"), "h").index), "d", "h stops at the line start");
	});

	it("never lands on a unit with no box", () => {
		const d = layout([["ab¬", "cd"]]);
		assert.equal(d.text(d.run(d.find("b"), "l").index), "b", "the wrap space is not a stop; c is the next line");
	});
});

describe("j / k — displayed lines, keeping the column", () => {
	it("keeps the x column, clamps on a short line, and gets it back on a long one", () => {
		const d = layout([["abcdef", "gh", "ijklmn"]]);
		const start = d.find("e"); // column 4
		const down = d.run(start, "j");
		assert.equal(d.text(down.index), "h", "the short line clamps to its last character");
		assert.equal(d.text(d.nav.move(down, "j").index), "m", "the goal column survives the short line");
		assert.equal(d.text(d.run(d.find("m"), "k", "k").index), "e");
	});

	it("crosses block boundaries in reading order", () => {
		const d = layout([["one"], ["two"]]);
		assert.equal(d.text(d.run(d.find("n"), "j").index), "w");
		assert.equal(d.text(d.run(d.find("w"), "k").index), "n");
	});

	it("$ makes the column sticky at the line end", () => {
		const d = layout([["abcdef", "gh", "ijklmn"]]);
		assert.equal(d.text(d.run(0, "$", "j", "j").index), "n");
	});

	it("stays put at the first and last lines", () => {
		const d = layout([["abc", "def"]]);
		assert.equal(d.run(1, "k").index, 1);
		assert.equal(d.run(d.find("e"), "j").index, d.find("e"));
	});
});

describe("0 / $ — the displayed line's ends", () => {
	it("goes to the first and last character of the current line only", () => {
		const d = layout([["abc", "def"]]);
		assert.equal(d.text(d.run(d.find("e"), "0").index), "d");
		assert.equal(d.text(d.run(d.find("e"), "$").index), "f");
	});
});

describe("w / b / e — vim's word rules", () => {
	it("word characters and punctuation are separate words", () => {
		const d = layout([["foo bar.baz"]]);
		assert.equal(d.text(d.run(0, "w").index), "b");
		assert.equal(d.run(0, "w", "w").index, d.find("."));
		assert.equal(d.run(0, "w", "w", "w").index, d.find("b", 1));
		assert.equal(d.run(0, "e").index, d.find("o", 1), "e: end of foo");
		assert.equal(d.run(0, "e", "e").index, d.find("r"), "e: end of bar");
		assert.equal(d.run(d.find("z"), "b").index, d.find("b", 1));
		assert.equal(d.run(d.find("z"), "b", "b").index, d.find("."));
	});

	it("crosses lines and blocks — a block boundary is a word break", () => {
		const d = layout([["end"], ["next"]]);
		assert.equal(d.text(d.run(0, "w").index), "n");
		assert.equal(d.run(d.find("n", 1), "b").index, 0, "b goes back to the previous block's last word");
		assert.equal(d.run(d.find("d"), "e").index, d.find("t"), "e from a word end reaches the next word's end");
	});

	it("a formula is one word, even glued to letters", () => {
		const d = layout([["a §b"]]);
		assert.equal(d.text(d.run(0, "w").index), "￼");
		assert.equal(d.text(d.run(0, "w", "w").index), "b");
		assert.equal(d.text(d.run(d.find("b"), "b").index), "￼");
	});

	it("stays put when there is no next or previous word", () => {
		const d = layout([["only"]]);
		assert.equal(d.run(d.find("y"), "w").index, d.find("y"));
		assert.equal(d.run(0, "b").index, 0);
	});
});

describe("{ / } — blocks", () => {
	it("} goes to the next block's start; { to the current block's start, then the previous one", () => {
		const d = layout([["first para"], ["second"], ["third"]]);
		assert.equal(d.text(d.run(d.find("p"), "}").index), "s");
		assert.equal(d.text(d.run(d.find("p"), "}", "}").index), "t");
		assert.equal(d.text(d.run(d.find("c"), "{").index), "s", "inside a block: its own start first");
		assert.equal(d.text(d.run(d.find("s", 1), "{").index), "f", "at a block start: the previous block");
	});

	it("a table row's cells are one block", () => {
		const d = layout([["cellA"], ["cellB"], ["after"]], [0, 0, 1]);
		assert.equal(d.text(d.run(0, "}").index), "a", "jumps over the whole row");
	});
});

describe("gg / G", () => {
	it("gg goes to the first character; G to the open question, else the last line's start", () => {
		const d = layout([["first", "line"], ["last", "words"], ["Q?"]]);
		const dockStart = d.find("Q");
		assert.equal(d.nav.move(d.at(d.find("w")), "gg").index, 0);
		assert.equal(d.nav.move(d.at(0), "G", dockStart).index, dockStart);
		assert.equal(d.text(d.nav.move(d.at(0), "G").index), "Q", "no question: the start of the last line");
		const noQuestion = layout([["first"], ["last", "words"]]);
		assert.equal(noQuestion.text(noQuestion.nav.move(noQuestion.at(0), "G").index), "w");
	});
});

describe("sameCaretLine", () => {
	it("a tall inline formula shares the line; a wrapped line does not", () => {
		const char = { top: 0, bottom: 20, left: 0, right: 10 };
		assert.ok(sameCaretLine(char, { top: -6, bottom: 26, left: 10, right: 40 }), "taller atom on the same line");
		assert.ok(!sameCaretLine(char, { top: 24, bottom: 44, left: 0, right: 10 }), "the next line down");
		assert.ok(!sameCaretLine({ ...char, left: 300, right: 310 }, { top: 8, bottom: 28, left: 0, right: 10 }), "wrapped back left");
	});
});

describe("caretCommandForKey", () => {
	it("owns exactly the approved keys, case-sensitive", () => {
		for (const k of ["h", "j", "k", "l", "w", "b", "e", "0", "$", "{", "}", "g", "G", "-", "="]) {
			assert.equal(caretCommandForKey(k), k);
		}
		for (const k of ["J", "x", "?", " ", "Enter", "ArrowDown", "i"]) assert.equal(caretCommandForKey(k), null, k);
	});
});

describe("hold speed — the ladder and the stored prefs", () => {
	it("- / = step the ladder and clamp at its ends", () => {
		assert.equal(stepCaretSpeed(40, 1), 60);
		assert.equal(stepCaretSpeed(40, -1), 30);
		assert.equal(stepCaretSpeed(5, -1), 5);
		assert.equal(stepCaretSpeed(120, 1), 120);
		assert.equal(snapCaretSpeed(33), 30);
	});

	it("corrupt or partial prefs fall back to the defaults; the delay clamps", () => {
		assert.deepEqual(sanitizeCaretPrefs(null), { speed: DEFAULT_CARET_SPEED, delayMs: DEFAULT_CARET_DELAY_MS });
		assert.deepEqual(sanitizeCaretPrefs({ speed: "fast" }), { speed: DEFAULT_CARET_SPEED, delayMs: DEFAULT_CARET_DELAY_MS });
		assert.deepEqual(sanitizeCaretPrefs({ speed: 77, delayMs: 9000 }), { speed: 80, delayMs: 500 });
		assert.deepEqual(sanitizeCaretPrefs({ speed: 5, delayMs: -3 }), { speed: 5, delayMs: 0 });
	});
});

describe("the repeat clock", () => {
	it("nothing before the delay, one move AT the delay, then speed per second", () => {
		let clock = startRepeatClock(0);
		let r = tickRepeatClock(clock, 100, 150, 40);
		assert.equal(r.moves, 0);
		r = tickRepeatClock(r.clock, 150, 150, 40);
		assert.equal(r.moves, 1, "the first repeat lands at the delay");
		let total = 0;
		clock = r.clock;
		for (let t = 166; t <= 1150; t += 16) {
			r = tickRepeatClock(clock, t, 150, 40);
			clock = r.clock;
			total += r.moves;
		}
		assert.ok(total >= 38 && total <= 40, `≈40 moves in the next second, got ${total}`);
	});

	it("a stalled frame never dumps a backlog", () => {
		const r = tickRepeatClock(startRepeatClock(0), 5000, 0, 120);
		assert.equal(r.moves, CARET_MAX_MOVES_PER_TICK);
	});

	it("a live speed change applies from the next frame, without a burst", () => {
		let { clock } = tickRepeatClock(startRepeatClock(0), 0, 0, 10);
		const slow = tickRepeatClock(clock, 100, 0, 10); // 1 move per 100ms
		clock = slow.clock;
		const fast = tickRepeatClock(clock, 116, 0, 120); // 16ms at 120/s ≈ 1.9
		assert.ok(fast.moves <= 2, `no burst on the switch, got ${fast.moves}`);
	});
});
