import type { CaretRect, CaretUnit } from "@/src/core";
import { displayedRoot, displayRuns, type TextPoint } from "@/components/session-find-dom";

/**
 * The vim reading caret's DOM seam (owner, 2026-10-27): the session's
 * displayed text as a flat unit list for the pure motion rules
 * (src/core/reading-caret.ts), plus geometry, drawing and scrolling.
 *
 * The text walk is Find's (session-find-dom.ts displayRuns) with two
 * additions: a KaTeX formula is ONE unit, and chrome is skipped — diagrams
 * (svg), buttons other than the question's option rows, unselectable
 * chrome, and the mono-caps labels (the app's chrome register). The block
 * is a CSS Custom Highlight, the mechanism Find uses: it never touches the
 * user's selection.
 */

/** The reading areas: the transcript and the open question or problem. */
export const READING_ROOTS = "[data-session-find-root], [data-dock-scroll]";

const CARET_EXCLUDED = 'svg, button:not([data-kbdrow]), [role="button"], [data-reading-exclude]';

/** Interactive targets a click must keep for themselves (no caret move). */
export const CARET_CLICK_KEEP = 'a, button, input, textarea, select, label, summary, [role="button"], [role="radio"], [role="checkbox"], [data-kbdrow]';

function caretSkip(element: Element, style: CSSStyleDeclaration | null): boolean {
	if (element.matches(CARET_EXCLUDED)) return true;
	if (!style) return false;
	const userSelect = style.getPropertyValue("user-select") || style.getPropertyValue("-webkit-user-select");
	return userSelect === "none" || style.textTransform === "uppercase";
}

const isAtom = (element: Element) => element.classList.contains("katex");

export interface CaretPoint {
	start: TextPoint;
	end: TextPoint;
	atom?: Element;
}

export interface CaretModel {
	units: CaretUnit[];
	points: CaretPoint[];
	roots: HTMLElement[];
	/** Per unit: its index into `roots`. */
	rootOf: number[];
	/** First unit of the open question or problem; -1 when none is open. */
	dockStart: number;
	/** Units by their anchor node (a text node, or an atom element). */
	byNode: Map<Node, number[]>;
}

/** Walk the scope's reading areas, in document order (transcript first). */
export function buildCaretModel(scope: HTMLElement): CaretModel {
	const all = [
		...(scope.matches(READING_ROOTS) ? [scope] : []),
		...scope.querySelectorAll<HTMLElement>(READING_ROOTS),
	];
	const roots = all.filter((root) => !all.some((other) => other !== root && other.contains(root)) && displayedRoot(root));
	const model: CaretModel = { units: [], points: [], roots, rootOf: [], dockStart: -1, byNode: new Map() };
	let run = 0;
	let block = -1;
	let lastRow: Element | null = null;
	roots.forEach((root, r) => {
		if (model.dockStart < 0 && root.matches("[data-dock-scroll]")) model.dockStart = model.units.length;
		for (const displayRun of displayRuns(root, { skip: caretSkip, atom: isAtom })) {
			// A table row's cells are one {/} block; everything else is its run.
			const row = displayRun.block.closest("tr");
			if (!row || row !== lastRow) block++;
			lastRow = row;
			displayRun.characters.forEach((character, k) => {
				const ch = displayRun.text[k]!;
				const prev = model.units.length - 1;
				// A surrogate pair is one character: extend the high half.
				if (/[\uDC00-\uDFFF]/.test(ch) && prev >= 0 && model.units[prev]!.run === run && /[\uD800-\uDBFF]$/.test(model.units[prev]!.ch)) {
					model.units[prev]!.ch += ch;
					model.points[prev]!.end = character.end;
					return;
				}
				const anchor: Node = character.atom ?? character.start.node;
				const list = model.byNode.get(anchor);
				if (list) list.push(model.units.length);
				else model.byNode.set(anchor, [model.units.length]);
				model.units.push({ ch, run, block, atom: !!character.atom });
				model.points.push({ start: character.start, end: character.end, atom: character.atom });
				model.rootOf.push(r);
			});
			run++;
		}
	});
	return model;
}

export function caretRange(model: CaretModel, index: number): Range {
	const point = model.points[index]!;
	const range = document.createRange();
	range.setStart(point.start.node, point.start.offset);
	range.setEnd(point.end.node, point.end.offset);
	return range;
}

/** A unit's box, or null when it has none (collapsed, hidden, detached). */
export function unitRect(model: CaretModel, index: number): CaretRect | null {
	const point = model.points[index];
	if (!point) return null;
	if (point.atom) {
		const box = (point.atom.querySelector(".katex-html") ?? point.atom).getBoundingClientRect();
		return box.width > 0 && box.height > 0 ? box : null;
	}
	for (const box of caretRange(model, index).getClientRects()) {
		if (box.width > 0 && box.height > 0) return box;
	}
	return null;
}

/** Where a caret sits, in a form that survives a rebuild of the model. */
export interface CaretAnchor {
	node: Node;
	offset: number;
}

export function anchorOf(model: CaretModel, index: number): CaretAnchor {
	const point = model.points[index]!;
	return point.atom ? { node: point.atom, offset: -1 } : { node: point.start.node, offset: point.start.offset };
}

export function indexOfAnchor(model: CaretModel, anchor: CaretAnchor): number {
	for (const index of model.byNode.get(anchor.node) ?? []) {
		if (anchor.offset < 0 || model.points[index]!.start.offset === anchor.offset) return index;
	}
	return -1;
}

/** The unit under a click point, or -1. */
export function unitAtPoint(model: CaretModel, x: number, y: number): number {
	const doc = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	};
	let node: Node | null = null;
	let offset = 0;
	const position = doc.caretPositionFromPoint?.(x, y);
	if (position) {
		node = position.offsetNode;
		offset = position.offset;
	} else {
		const range = doc.caretRangeFromPoint?.(x, y);
		if (range) {
			node = range.startContainer;
			offset = range.startOffset;
		}
	}
	if (!node) return -1;
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	const atom = element?.closest(".katex");
	if (atom) return model.byNode.get(atom)?.[0] ?? -1;
	const candidates = (model.byNode.get(node) ?? []).filter((i) => {
		const start = model.points[i]!.start.offset;
		return start === offset || start === offset - 1;
	});
	// The offset sits between two characters: take the one under the pointer.
	for (const i of candidates) {
		const box = unitRect(model, i);
		if (box && x >= box.left && x <= box.right) return i;
	}
	return candidates[0] ?? -1;
}

// ─── drawing ─────────────────────────────────────────────────────────────────

export const READING_CARET_HIGHLIGHT = "lh-reading-caret";

/** ::highlight() rules live outside globals.css (the PostCSS pipeline
 *  rejects the pseudo-element — see injectFindStyles). The block inverts
 *  the ink: the strongest ink as the block, the page as the letter. */
const CARET_STYLE_ID = "lh-reading-caret-style";
export function injectCaretStyles(): void {
	if (document.getElementById(CARET_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = CARET_STYLE_ID;
	style.textContent = `
::highlight(${READING_CARET_HIGHLIGHT}) { background-color: var(--lh-ink-strong); color: var(--background); }`;
	document.head.appendChild(style);
}

export function drawCaret(range: Range | null): void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
	if (!range) {
		CSS.highlights.delete(READING_CARET_HIGHLIGHT);
		return;
	}
	const highlight = new Highlight(range);
	highlight.priority = 2; // above Find's matches
	CSS.highlights.set(READING_CARET_HIGHLIGHT, highlight);
}

// ─── viewing + scrolling ────────────────────────────────────────────────────

/** The bottom band (dock, stats row) covers the transcript's bottom; its
 *  gradient fade covers this much more above it. */
const OCCLUDER_FADE_PX = 24;

/** The vertical span where a root's text is actually visible. */
export function visibleSpan(
	root: HTMLElement,
	scroller: HTMLElement | null,
	occluder: HTMLElement | null,
): { top: number; bottom: number } {
	if (root.matches("[data-dock-scroll]")) {
		const box = root.getBoundingClientRect();
		return { top: box.top, bottom: box.bottom };
	}
	const box = (scroller ?? root).getBoundingClientRect();
	const cover = occluder?.getBoundingClientRect();
	return { top: box.top, bottom: cover ? Math.min(box.bottom, cover.top - OCCLUDER_FADE_PX) : box.bottom };
}

/** Context lines kept above and below the caret in the transcript. */
const CONTEXT_PX = 72;
const INNER_MARGIN_PX = 8;

function scrollable(element: Element, axis: "x" | "y"): boolean {
	const style = getComputedStyle(element);
	const overflow = axis === "x" ? style.overflowX : style.overflowY;
	if (!/(auto|scroll)/.test(overflow)) return false;
	return axis === "x" ? element.scrollWidth > element.clientWidth : element.scrollHeight > element.clientHeight;
}

/** Keep the caret in view: inner scrollers (wide code, a tall question)
 *  move the least they must; the transcript keeps a few lines of context
 *  AHEAD of the caret — below it moving down, above it moving up (so a
 *  j near the top never scrolls the page back) — and never lets it slide
 *  under the bottom band. */
export function revealCaret(
	model: CaretModel,
	index: number,
	view: { scroller: HTMLElement | null; occluder: HTMLElement | null; stopScroll: () => void },
	direction: -1 | 0 | 1,
): void {
	const root = model.roots[model.rootOf[index]!];
	const point = model.points[index];
	if (!root || !point) return;
	const start = point.atom ?? point.start.node.parentElement;
	for (let element = start; element && element !== root && root.contains(element); element = element.parentElement) {
		if (element === view.scroller) break;
		const box = unitRect(model, index);
		if (!box) return;
		const frame = element.getBoundingClientRect();
		if (scrollable(element, "x")) {
			if (box.left < frame.left + INNER_MARGIN_PX) element.scrollLeft -= frame.left + INNER_MARGIN_PX - box.left;
			else if (box.right > frame.right - INNER_MARGIN_PX) element.scrollLeft += box.right - (frame.right - INNER_MARGIN_PX);
		}
		if (scrollable(element, "y")) {
			if (box.top < frame.top + INNER_MARGIN_PX) element.scrollTop -= frame.top + INNER_MARGIN_PX - box.top;
			else if (box.bottom > frame.bottom - INNER_MARGIN_PX) element.scrollTop += box.bottom - (frame.bottom - INNER_MARGIN_PX);
		}
	}
	const box = unitRect(model, index);
	if (!box) return;
	if (root.matches("[data-dock-scroll]")) {
		const frame = root.getBoundingClientRect();
		if (box.top < frame.top + INNER_MARGIN_PX) root.scrollTop -= frame.top + INNER_MARGIN_PX - box.top;
		else if (box.bottom > frame.bottom - INNER_MARGIN_PX) root.scrollTop += box.bottom - (frame.bottom - INNER_MARGIN_PX);
		return;
	}
	const scroller = view.scroller;
	if (!scroller) return;
	const span = visibleSpan(root, scroller, view.occluder);
	const margin = Math.min(CONTEXT_PX, Math.max(0, (span.bottom - span.top) / 4));
	const above = direction < 0 ? margin : 0;
	const below = direction > 0 ? margin : 0;
	let delta = 0;
	if (box.top < span.top + above) delta = box.top - (span.top + above);
	else if (box.bottom > span.bottom - below) delta = box.bottom - (span.bottom - below);
	if (Math.abs(delta) < 1) return;
	view.stopScroll(); // release the sticky-bottom follow before moving
	scroller.scrollTop += delta;
}
