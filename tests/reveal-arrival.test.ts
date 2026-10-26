import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeArrivalExpanded, revealArrival } from "../components/chat.tsx";

/**
 * Teach-question arrival states (owner ruling, scroll-honesty round
 * 2026-09-25). Applied DURING RENDER before the first paint — the bug was
 * the stale expanded=true left by the previous question painting one
 * frame of the open question: the dock measured itself tall, reserved that
 * height permanently (fold immunity refused the give-back), and the
 * transcript scrolled as if the collapsed question had opened.
 */
describe("revealArrival — how a teach question lands", () => {
	it("fresh arrival after the composer: collapsed behind the reveal button", () => {
		assert.deepEqual(revealArrival(false), { expanded: false, revealed: false });
	});

	it("queued behind another question: open — the reading already happened", () => {
		assert.deepEqual(revealArrival(true), { expanded: true, revealed: true });
	});
});

/**
 * Probe-question arrival state (flicker round, 2026-09-26): open iff the
 * learner is following at the bottom; scrolled up in history → arrive as
 * the collapsed bar, decided DURING RENDER (the old after-paint effect
 * painted one stale-open frame first).
 */
describe("probeArrivalExpanded — how a probe question lands", () => {
	it("at the bottom following along: open", () => {
		assert.equal(probeArrivalExpanded(true), true);
	});

	it("scrolled up in history: arrive already-collapsed (owner ruling)", () => {
		assert.equal(probeArrivalExpanded(false), false);
	});
});