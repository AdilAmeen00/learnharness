/**
 * The vim reading caret — the pure core (owner, 2026-10-27). The DOM seam
 * (components/reading-caret-dom.ts) turns the session's displayed text into
 * a flat list of units — one per displayed character, a whole formula as
 * one — and supplies their geometry through `rectOf`; everything here is
 * motion rules over that list, so it runs under node with fake rects.
 *
 * Owner-approved plan: h/l move one character within the displayed line,
 * j/k one displayed line keeping the column (vim's goal column; $ makes it
 * sticky at the line end), w/b/e follow vim's word rules, 0/$ the line ends,
 * {/} block starts, gg the session start, G the open question (or the last
 * line). A unit with no box (a collapsed space at a wrap, a hidden glyph) is
 * never a stop. Hold speed is the app's own repeat: a ladder stepped live
 * by -/=, plus a repeat delay, both stored on this device (lh:caret).
 */

/** One caret stop candidate: a displayed character, or a whole formula. */
export interface CaretUnit {
	/** The displayed character (" " for collapsed whitespace, U+FFFC for an atom). */
	ch: string;
	/** The text run (one block's text). A run change is a line and word break. */
	run: number;
	/** The {/} group: a run, or a whole table row (its cells merge). */
	block: number;
	/** A formula walked as one step and one word. */
	atom: boolean;
}

/** Viewport-relative box of one unit (DOMRect's fields, no DOM type needed). */
export interface CaretRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/** The geometry seam: null = the unit has no box (never a stop). */
export type CaretRectOf = (index: number) => CaretRect | null;

export type CaretMotion = "h" | "l" | "j" | "k" | "w" | "b" | "e" | "0" | "$" | "{" | "}" | "gg" | "G";

export interface CaretPosition {
	index: number;
	/** The column j/k aim for, as an x coordinate. Infinity after $ (sticky end). */
	goalX: number;
}

/** Motions that repeat while their key is held (the rest are jumps). */
export const REPEATING_MOTIONS: ReadonlySet<CaretMotion> = new Set(["h", "l", "j", "k", "w", "b", "e", "{", "}"]);

/** A key the reading caret owns: a motion, the g prefix, or a speed step. */
export type CaretCommand = Exclude<CaretMotion, "gg"> | "g" | "-" | "=";

const COMMAND_KEYS = new Set<string>(["h", "l", "j", "k", "w", "b", "e", "0", "$", "{", "}", "g", "G", "-", "="]);

/** Which caret command a KeyboardEvent.key is, if any (case matters: G ≠ g). */
export function caretCommandForKey(key: string): CaretCommand | null {
	return COMMAND_KEYS.has(key) ? (key as CaretCommand) : null;
}

// ─── navigation over units + geometry ────────────────────────────────────────

/** vim's character classes for w/b/e (plain consts — no enums in core). */
const Cls = { Blank: 0, Word: 1, Punct: 2, Atom: 3 } as const;
type Cls = (typeof Cls)[keyof typeof Cls];

function classOf(unit: CaretUnit): Cls {
	if (unit.atom) return Cls.Atom;
	if (/\s/.test(unit.ch)) return Cls.Blank;
	return /[\p{L}\p{N}_]/u.test(unit.ch) ? Cls.Word : Cls.Punct;
}

/** Two boxes sit on one displayed line: they overlap vertically by at least
 *  half the shorter one, and the second didn't wrap back to the left. */
export function sameCaretLine(a: CaretRect, b: CaretRect): boolean {
	const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	const shorter = Math.min(a.bottom - a.top, b.bottom - b.top);
	return overlap >= shorter / 2 && b.left >= a.left - 1;
}

/** The navigation kit for one model snapshot. Rects are memoized for the
 *  kit's lifetime — build a fresh kit per keypress (scrolling moves them). */
export function caretNavigator(units: readonly CaretUnit[], rectOf: CaretRectOf) {
	const memo = new Map<number, CaretRect | null>();
	const rect = (i: number): CaretRect | null => {
		if (!memo.has(i)) memo.set(i, rectOf(i));
		return memo.get(i)!;
	};
	const isStop = (i: number): boolean => {
		const r = rect(i);
		return !!r && r.right - r.left > 0;
	};
	const stopAtOrAfter = (from: number, end = units.length): number => {
		for (let i = Math.max(0, from); i < end; i++) if (isStop(i)) return i;
		return -1;
	};
	const stopAtOrBefore = (from: number, start = 0): number => {
		for (let i = Math.min(from, units.length - 1); i >= start; i--) if (isStop(i)) return i;
		return -1;
	};
	const lineMate = (a: number, b: number): boolean =>
		units[a]!.run === units[b]!.run && sameCaretLine(rect(a)!, rect(b)!);
	/** First stop of the displayed line holding stop i. */
	const lineStart = (i: number): number => {
		let k = i;
		for (let p = stopAtOrBefore(k - 1); p >= 0 && lineMate(p, k); p = stopAtOrBefore(k - 1)) k = p;
		return k;
	};
	/** Last stop of the displayed line holding stop i. */
	const lineEnd = (i: number): number => {
		let k = i;
		for (let n = stopAtOrAfter(k + 1); n >= 0 && lineMate(k, n); n = stopAtOrAfter(k + 1)) k = n;
		return k;
	};
	/** On the line starting at stop s: the last stop whose left edge is at or
	 *  before goalX (the column), else the line's first stop. */
	const pickOnLine = (s: number, goalX: number): number => {
		let best = s;
		for (let k = s; ; ) {
			if (rect(k)!.left <= goalX + 0.5) best = k;
			const n = stopAtOrAfter(k + 1);
			if (n < 0 || !lineMate(k, n)) return best;
			k = n;
		}
	};

	const wordForward = (i: number): number => {
		const n = units.length;
		let k = i;
		const c = classOf(units[i]!);
		if (c !== Cls.Blank) {
			if (c !== Cls.Atom) {
				while (k + 1 < n && units[k + 1]!.run === units[k]!.run && classOf(units[k + 1]!) === c) k++;
			}
			k++;
		}
		while (k < n && classOf(units[k]!) === Cls.Blank) k++;
		return k < n ? k : -1;
	};
	const wordEnd = (i: number): number => {
		const n = units.length;
		let k = i + 1;
		while (k < n && classOf(units[k]!) === Cls.Blank) k++;
		if (k >= n) return -1;
		const c = classOf(units[k]!);
		if (c !== Cls.Atom) {
			while (k + 1 < n && units[k + 1]!.run === units[k]!.run && classOf(units[k + 1]!) === c) k++;
		}
		return k;
	};
	const wordBackward = (i: number): number => {
		let k = i - 1;
		while (k >= 0 && classOf(units[k]!) === Cls.Blank) k--;
		if (k < 0) return -1;
		const c = classOf(units[k]!);
		if (c !== Cls.Atom) {
			while (k - 1 >= 0 && units[k - 1]!.run === units[k]!.run && classOf(units[k - 1]!) === c) k--;
		}
		return k;
	};
	const blockStart = (i: number): number => {
		let k = i;
		while (k > 0 && units[k - 1]!.block === units[i]!.block) k--;
		return k;
	};

	/** Apply one motion. A motion with nowhere to go leaves the caret put.
	 *  `dockStart` = index of the open question's first unit (-1: none). */
	const move = (pos: CaretPosition, motion: CaretMotion, dockStart = -1): CaretPosition => {
		const i = pos.index;
		const at = (index: number, goalX?: number): CaretPosition =>
			index < 0 || !isStop(index) ? pos : { index, goalX: goalX ?? rect(index)!.left };
		switch (motion) {
			case "h": {
				const p = stopAtOrBefore(i - 1);
				return p >= 0 && lineMate(p, i) ? at(p) : pos;
			}
			case "l": {
				const n = stopAtOrAfter(i + 1);
				return n >= 0 && lineMate(i, n) ? at(n) : pos;
			}
			case "j": {
				const s = stopAtOrAfter(lineEnd(i) + 1);
				return s < 0 ? pos : { index: pickOnLine(s, pos.goalX), goalX: pos.goalX };
			}
			case "k": {
				const p = stopAtOrBefore(lineStart(i) - 1);
				return p < 0 ? pos : { index: pickOnLine(lineStart(p), pos.goalX), goalX: pos.goalX };
			}
			case "w": {
				const k = wordForward(i);
				return k < 0 ? pos : at(isStop(k) ? k : stopAtOrAfter(k));
			}
			case "e": {
				const k = wordEnd(i);
				return k < 0 ? pos : at(isStop(k) ? k : stopAtOrBefore(k, i + 1));
			}
			case "b": {
				const k = wordBackward(i);
				return k < 0 ? pos : at(isStop(k) ? k : stopAtOrAfter(k, i));
			}
			case "0":
				return at(lineStart(i));
			case "$":
				return at(lineEnd(i), Infinity);
			case "}": {
				let k = i;
				while (k < units.length && units[k]!.block === units[i]!.block) k++;
				return at(stopAtOrAfter(k));
			}
			case "{": {
				// The current block's start first (when the caret is past it),
				// else the nearest earlier block that has a stop.
				for (let end = i, start = blockStart(i); ; end = start, start = blockStart(start - 1)) {
					const first = stopAtOrAfter(start, end);
					if (first >= 0) return at(first);
					if (start === 0) return pos;
				}
			}
			case "gg":
				return at(stopAtOrAfter(0));
			case "G": {
				if (dockStart >= 0) {
					const q = stopAtOrAfter(dockStart);
					if (q >= 0) return at(q);
				}
				const last = stopAtOrBefore(units.length - 1);
				return last < 0 ? pos : at(lineStart(last));
			}
		}
	};

	return { rect, isStop, stopAtOrAfter, stopAtOrBefore, lineStart, lineEnd, move };
}

// ─── hold speed (the app's own repeat) ───────────────────────────────────────

/** The live -/= ladder, in moves per second (owner-approved plan). */
export const CARET_SPEED_STEPS = [5, 10, 15, 20, 30, 40, 60, 80, 120] as const;
export const DEFAULT_CARET_SPEED = 40;
export const DEFAULT_CARET_DELAY_MS = 150;
export const CARET_DELAY_MAX_MS = 500;
/** A frame that stalls never dumps a backlog of moves on the reader. */
export const CARET_MAX_MOVES_PER_TICK = 12;

export interface CaretPrefs {
	/** Moves per second while a key is held — always a CARET_SPEED_STEPS value. */
	speed: number;
	/** Wait after the first step before the repeat starts. */
	delayMs: number;
}

/** Snap any number to the nearest ladder step. */
export function snapCaretSpeed(speed: number): number {
	let best: number = CARET_SPEED_STEPS[0];
	for (const step of CARET_SPEED_STEPS) if (Math.abs(step - speed) < Math.abs(best - speed)) best = step;
	return best;
}

/** One rung up (=) or down (-) the ladder, clamped at its ends. */
export function stepCaretSpeed(speed: number, direction: 1 | -1): number {
	const at = CARET_SPEED_STEPS.indexOf(snapCaretSpeed(speed) as (typeof CARET_SPEED_STEPS)[number]);
	return CARET_SPEED_STEPS[Math.min(CARET_SPEED_STEPS.length - 1, Math.max(0, at + direction))]!;
}

/** Whatever the store held → valid prefs (corrupt or partial = defaults). */
export function sanitizeCaretPrefs(raw: unknown): CaretPrefs {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const speed = typeof r.speed === "number" && Number.isFinite(r.speed) ? snapCaretSpeed(r.speed) : DEFAULT_CARET_SPEED;
	const delayMs =
		typeof r.delayMs === "number" && Number.isFinite(r.delayMs)
			? Math.min(CARET_DELAY_MAX_MS, Math.max(0, Math.round(r.delayMs)))
			: DEFAULT_CARET_DELAY_MS;
	return { speed, delayMs };
}

const CARET_STORAGE_KEY = "lh:caret";

/** This device's caret prefs (localStorage, like the keymap). SSR-safe. */
export function loadCaretPrefs(): CaretPrefs {
	if (typeof window === "undefined") return sanitizeCaretPrefs(null);
	try {
		const raw = window.localStorage.getItem(CARET_STORAGE_KEY);
		return sanitizeCaretPrefs(raw ? JSON.parse(raw) : null);
	} catch {
		return sanitizeCaretPrefs(null);
	}
}

export function saveCaretPrefs(prefs: CaretPrefs): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(CARET_STORAGE_KEY, JSON.stringify(sanitizeCaretPrefs(prefs)));
	} catch {
		/* storage unavailable = the speed holds for this page only */
	}
}

/** The hold clock: the first step happens on press (outside the clock);
 *  the first REPEAT lands at pressedAt + delay, then `speed` per second.
 *  Fractional moves carry between frames, so a live speed change takes
 *  effect from the next frame without a burst. */
export interface RepeatClock {
	pressedAt: number;
	last: number;
	acc: number;
	started: boolean;
}

export function startRepeatClock(now: number): RepeatClock {
	return { pressedAt: now, last: now, acc: 0, started: false };
}

export function tickRepeatClock(
	clock: RepeatClock,
	now: number,
	delayMs: number,
	speed: number,
): { clock: RepeatClock; moves: number } {
	const begin = clock.pressedAt + delayMs;
	if (now < begin) return { clock: { ...clock, last: now }, moves: 0 };
	let acc = clock.acc;
	if (!clock.started) acc += 1; // the first repeat lands AT the delay
	acc += ((now - (clock.started ? clock.last : begin)) * speed) / 1000;
	const whole = Math.floor(acc);
	return {
		clock: { pressedAt: clock.pressedAt, last: now, acc: acc - whole, started: true },
		moves: Math.min(whole, CARET_MAX_MOVES_PER_TICK),
	};
}
