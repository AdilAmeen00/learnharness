"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
	caretCommandForKey,
	caretNavigator,
	isTypingSurface,
	loadCaretPrefs,
	REPEATING_MOTIONS,
	saveCaretPrefs,
	startRepeatClock,
	stepCaretSpeed,
	tickRepeatClock,
	type CaretMotion,
	type CaretPosition,
	type RepeatClock,
} from "@/src/core";
import {
	anchorOf,
	buildCaretModel,
	CARET_CLICK_KEEP,
	caretRange,
	drawCaret,
	indexOfAnchor,
	injectCaretStyles,
	READING_ROOTS,
	revealCaret,
	unitAtPoint,
	unitRect,
	visibleSpan,
	type CaretAnchor,
	type CaretModel,
} from "@/components/reading-caret-dom";
import { sessionFindHasForegroundLayer } from "@/components/session-find";
import type { SessionScrollContext } from "@/components/session-navigation";

/** gg: the second g must follow within this window. */
const G_PREFIX_MS = 800;
/** How long the speed label stays after - / =. */
const READOUT_MS = 1000;
/** Streamed text re-measures at most this often while a caret is shown. */
const REFRESH_MS = 150;

type Navigator = ReturnType<typeof caretNavigator>;

/** The first stop whose top is inside the visible span, between from and to
 *  (binary search: reading order runs down the page). -1 when none. */
function firstVisibleStop(nav: Navigator, from: number, to: number, top: number, bottom: number): number {
	let lo = from;
	let hi = to;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const stop = nav.stopAtOrAfter(mid, to);
		if (stop < 0 || nav.rect(stop)!.top >= top - 1) hi = mid;
		else lo = stop + 1;
	}
	const stop = nav.stopAtOrAfter(lo, to);
	return stop >= 0 && nav.rect(stop)!.top < bottom ? stop : -1;
}

function typingFocused(): boolean {
	const active = document.activeElement as HTMLElement | null;
	if (!active) return false;
	if (active.tagName === "INPUT") return (active as HTMLInputElement).type !== "range";
	return active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable;
}

/**
 * The vim reading caret (owner, 2026-10-27) — mounted once per Chat, beside
 * SessionFind, over the same scope. Reading mode is simply "no text field
 * has focus"; in a field every key types. Owner-approved plan: the first
 * motion key shows the caret at the top visible line (gg/G also jump); a
 * caret scrolled out of view comes back to where the reader is looking;
 * a click on text moves it; holding a key repeats at the -/= speed after
 * the repeat delay — the app's own clock, not the OS key repeat.
 */
export function ReadingCaret({
	scopeRef,
	scrollContextRef,
}: {
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
}) {
	const [readout, setReadout] = useState<string | null>(null);
	const readoutTimer = useRef<number | null>(null);
	const showReadout = useRef((text: string) => {
		setReadout(text);
		if (readoutTimer.current !== null) window.clearTimeout(readoutTimer.current);
		readoutTimer.current = window.setTimeout(() => setReadout(null), READOUT_MS);
	});

	useEffect(injectCaretStyles, []);
	useEffect(() => () => {
		if (readoutTimer.current !== null) window.clearTimeout(readoutTimer.current);
	}, []);

	useEffect(() => {
		const scope = scopeRef.current;
		if (!scope) return;
		let model: CaretModel | null = null;
		let dirty = true;
		let caret: { anchor: CaretAnchor; index: number; goalX: number } | null = null;
		let prefs = loadCaretPrefs();
		let gPressedAt = 0;
		let hold: { code: string; motion: CaretMotion; clock: RepeatClock; frame: number } | null = null;
		let refreshTimer: number | null = null;

		const scroller = () => scrollContextRef.current?.scrollRef.current ?? null;
		const occluder = () => scope.querySelector<HTMLElement>("[data-reading-occluder]");

		const currentModel = (): CaretModel => {
			if (model && !dirty) return model;
			model = buildCaretModel(scope);
			dirty = false;
			if (caret) {
				// Same node + offset, or (a streamed re-render replaced the
				// nodes) the same position in reading order.
				const found = indexOfAnchor(model, caret.anchor);
				const index = found >= 0 ? found : caret.index < model.units.length ? caret.index : -1;
				caret = index >= 0 ? { ...caret, index, anchor: anchorOf(model, index) } : null;
			}
			return model;
		};

		const draw = () => {
			if (!caret || !model || typingFocused()) drawCaret(null);
			else drawCaret(caretRange(model, caret.index));
		};

		const setCaret = (m: CaretModel, pos: CaretPosition) => {
			caret = { anchor: anchorOf(m, pos.index), index: pos.index, goalX: pos.goalX };
		};

		const onScreen = (m: CaretModel, nav: Navigator, index: number): boolean => {
			const box = nav.rect(index);
			if (!box) return false;
			const span = visibleSpan(m.roots[m.rootOf[index]!]!, scroller(), occluder());
			return box.bottom > span.top && box.top < span.bottom;
		};

		const placeAtTop = (m: CaretModel, nav: Navigator): CaretPosition | null => {
			const end = m.dockStart >= 0 ? m.dockStart : m.units.length;
			let stop = -1;
			if (end > 0) {
				const span = visibleSpan(m.roots[0]!, scroller(), occluder());
				stop = firstVisibleStop(nav, 0, end, span.top, span.bottom);
			}
			if (stop < 0 && m.dockStart >= 0) stop = nav.stopAtOrAfter(m.dockStart);
			if (stop < 0) return null;
			const start = nav.lineStart(stop);
			return { index: start, goalX: nav.rect(start)!.left };
		};

		/** One motion. `fresh` = a new keypress: a missing or out-of-view
		 *  caret is placed at the top visible line first ("placed" — shown
		 *  where it already is, nothing scrolls; gg/G then still jump).
		 *  Repeats never re-place: the scroll that follows a batch of moves
		 *  runs after them. Returns whether the caret moved. */
		const step = (motion: CaretMotion, fresh: boolean): "placed" | "moved" | null => {
			const m = currentModel();
			if (!m.units.length) return null;
			const nav = caretNavigator(m.units, (i) => unitRect(m, i));
			if (fresh && (!caret || !nav.isStop(caret.index) || !onScreen(m, nav, caret.index))) {
				const placed = placeAtTop(m, nav);
				if (!placed) return null;
				setCaret(m, placed);
				if (motion !== "gg" && motion !== "G") return "placed";
			}
			if (!caret || !nav.isStop(caret.index)) return null;
			const next = nav.move({ index: caret.index, goalX: caret.goalX }, motion, m.dockStart);
			if (next.index === caret.index && next.goalX === caret.goalX) return null;
			setCaret(m, next);
			return "moved";
		};

		/** Draw, after scrolling the caret into view (context kept on the
		 *  side it moved toward: down = +1, up = -1). */
		const show = (direction: -1 | 0 | 1) => {
			if (!caret || !model) return;
			revealCaret(
				model,
				caret.index,
				{ scroller: scroller(), occluder: occluder(), stopScroll: () => scrollContextRef.current?.stopScroll() },
				direction,
			);
			draw();
		};
		const directionFrom = (before: number): -1 | 0 | 1 =>
			!caret || caret.index === before ? 0 : caret.index > before ? 1 : -1;

		const stopHold = () => {
			if (hold) window.cancelAnimationFrame(hold.frame);
			hold = null;
		};

		const tick = (now: number) => {
			if (!hold) return;
			const { clock, moves } = tickRepeatClock(hold.clock, now, prefs.delayMs, prefs.speed);
			hold.clock = clock;
			const before = caret?.index ?? -1;
			let moved = false;
			for (let n = 0; n < moves; n++) moved = step(hold.motion, false) === "moved" || moved;
			if (moved) show(directionFrom(before));
			hold.frame = window.requestAnimationFrame(tick);
		};

		const run = (motion: CaretMotion, code: string) => {
			stopHold();
			prefs = loadCaretPrefs(); // Settings may have changed it
			const before = caret?.index ?? -1;
			const result = step(motion, true);
			if (result === "placed") draw();
			else if (result === "moved") {
				// gg/G from no caret: measure the jump from where it was placed.
				show(before < 0 ? (motion === "gg" ? -1 : 1) : directionFrom(before));
			}
			if (!REPEATING_MOTIONS.has(motion)) return;
			hold = { code, motion, clock: startRepeatClock(performance.now()), frame: 0 };
			hold.frame = window.requestAnimationFrame(tick);
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
			// Caps Lock on: a plain letter press still means the lowercase key.
			const key =
				e.key.length === 1 && !e.shiftKey && e.getModifierState?.("CapsLock") ? e.key.toLowerCase() : e.key;
			const command = caretCommandForKey(key);
			if (!command) {
				gPressedAt = 0;
				return;
			}
			if (isTypingSurface(e) || sessionFindHasForegroundLayer(document)) return;
			e.preventDefault();
			if (e.repeat) return; // the hold clock repeats, not the OS
			if (command === "-" || command === "=") {
				gPressedAt = 0;
				const stored = loadCaretPrefs();
				prefs = { ...stored, speed: stepCaretSpeed(stored.speed, command === "=" ? 1 : -1) };
				saveCaretPrefs(prefs);
				showReadout.current(`caret · ${prefs.speed}/s`);
				return;
			}
			if (command === "g") {
				const now = performance.now();
				if (gPressedAt && now - gPressedAt < G_PREFIX_MS) {
					gPressedAt = 0;
					run("gg", e.code);
				} else gPressedAt = now;
				return;
			}
			gPressedAt = 0;
			run(command, e.code);
		};

		const onKeyUp = (e: KeyboardEvent) => {
			if (hold && e.code === hold.code) stopHold();
		};

		const onClick = (e: MouseEvent) => {
			if (e.button !== 0 || e.detail > 1 || e.defaultPrevented) return;
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) return; // a drag-select stays a selection
			const target = e.target as Element | null;
			if (!target || !scope.contains(target) || !target.closest(READING_ROOTS) || target.closest(CARET_CLICK_KEEP)) return;
			const m = currentModel();
			const index = unitAtPoint(m, e.clientX, e.clientY);
			const box = index >= 0 ? unitRect(m, index) : null;
			if (!box) return;
			setCaret(m, { index, goalX: box.left });
			draw();
		};

		const onFocusChange = () => {
			if (typingFocused()) stopHold();
			window.requestAnimationFrame(draw);
		};

		const onHidden = () => {
			if (document.visibilityState === "hidden") stopHold();
		};

		const observer = new MutationObserver(() => {
			dirty = true;
			if (!caret || refreshTimer !== null) return;
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				if (!caret) return;
				currentModel();
				draw();
			}, REFRESH_MS);
		});
		observer.observe(scope, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state", "aria-expanded"],
		});

		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("keyup", onKeyUp);
		document.addEventListener("click", onClick);
		document.addEventListener("focusin", onFocusChange);
		document.addEventListener("focusout", onFocusChange);
		document.addEventListener("visibilitychange", onHidden);
		window.addEventListener("blur", stopHold);
		return () => {
			stopHold();
			observer.disconnect();
			if (refreshTimer !== null) window.clearTimeout(refreshTimer);
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("click", onClick);
			document.removeEventListener("focusin", onFocusChange);
			document.removeEventListener("focusout", onFocusChange);
			document.removeEventListener("visibilitychange", onHidden);
			window.removeEventListener("blur", stopHold);
			drawCaret(null);
		};
	}, [scopeRef, scrollContextRef]);

	if (!readout) return null;
	return (
		<div
			data-testid="caret-speed-readout"
			className="pointer-events-none fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 font-ui text-xs text-muted-foreground shadow-sm"
		>
			{readout}
		</div>
	);
}
